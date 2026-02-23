from __future__ import annotations

import re
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from firebase_admin import firestore

from .auth import get_current_user
from .database import db, log_action
from .rag import retrieve


router = APIRouter(prefix="/help-center", tags=["help-center"])


def _now_ts() -> float:
    return float(time.time())


def _get_store(request: Request):
    store = getattr(request.app.state, "store", None)
    if store is None:
        raise HTTPException(status_code=500, detail="Help Center store not initialized")
    return store


def _parse_keywords(text: str) -> List[str]:
    if not text:
        return []
    for line in text.splitlines()[:30]:
        m = re.match(r"^\s*keywords\s*:\s*(.+)\s*$", line, flags=re.I)
        if m:
            raw = m.group(1)
            parts = [p.strip().lower() for p in raw.split(",")]
            return [p for p in parts if p]
    return []


def _tokenize(q: str) -> List[str]:
    q = (q or "").strip().lower()
    if not q:
        return []
    q = re.sub(r"[^a-z0-9\s]+", " ", q)
    toks = [t for t in q.split() if len(t) > 1]
    # de-dupe while preserving order
    seen = set()
    out = []
    for t in toks:
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def _lexical_score(tokens: List[str], title: str, keywords: List[str], body: str) -> float:
    if not tokens:
        return 0.0
    title_l = (title or "").lower()
    body_l = (body or "").lower()
    kw_set = set([k.lower() for k in (keywords or [])])

    score = 0.0
    for t in tokens:
        if t in title_l:
            score += 3.0
        if t in kw_set:
            score += 2.0
        if t in body_l:
            score += 1.0
    # normalize to ~[0,1] range
    return min(1.0, score / (len(tokens) * 3.0))


def _safe_excerpt(text: str, max_chars: int = 180) -> str:
    s = (text or "").strip().replace("\n", " ")
    s = re.sub(r"\s+", " ", s)
    if len(s) <= max_chars:
        return s
    return s[: max_chars - 1].rstrip() + "…"


def _doc_kind(doc_type: str) -> str:
    dt = (doc_type or "").strip().upper()
    if dt == "FAQ":
        return "faq"
    if dt == "HELP":
        return "article"
    return "kb"


def _split_faq_items(markdown: str) -> List[Dict[str, str]]:
    """Parse a simple FAQ markdown document into items.

    Expected format:
    # Title
    ## Question
    Answer...
    ## Question
    Answer...
    """
    text = (markdown or "").strip()
    if not text:
        return []

    # Split on H2 sections.
    parts = re.split(r"\n(?=##\s+)", text)
    items: List[Dict[str, str]] = []
    for p in parts:
        p = p.strip()
        if not p.startswith("## "):
            continue
        lines = p.splitlines()
        question = lines[0][3:].strip()
        answer = "\n".join(lines[1:]).strip()
        if not question:
            continue
        items.append({"question": question, "answer": answer})
    return items


class HelpCenterSearchResult(BaseModel):
    id: str
    title: str
    kind: str = Field(description="article|faq")
    score: float
    excerpt: str


class HelpCenterSearchResponse(BaseModel):
    query: str
    results: List[HelpCenterSearchResult]


class HelpCenterInteractionIn(BaseModel):
    type: str = Field(description="search|view_content|search_click|ai_qa|ticket_submit")
    query: Optional[str] = None
    content_id: Optional[str] = None
    content_title: Optional[str] = None
    content_kind: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class HelpCenterTicket(BaseModel):
    id: str
    subject: str
    message: str
    status: str
    created_at: float


class HelpCenterAskIn(BaseModel):
    message: str
    max_context_chars: int = 2200


class HelpCenterAskOut(BaseModel):
    answer: str
    sources: List[Dict[str, Any]] = Field(default_factory=list)


@router.get("/search", response_model=HelpCenterSearchResponse)
async def search_help_center(
    request: Request,
    q: str = Query(default="", max_length=240),
    k: int = Query(default=10, ge=1, le=20),
    kind: str = Query(default="all", description="all|article|faq"),
    user: Dict[str, Any] = Depends(get_current_user),
):
    store = _get_store(request)
    query = (q or "").strip()
    tokens = _tokenize(query)

    # Log the search interaction (per-user history)
    try:
        uid = user.get("uid")
        if uid and query:
            db.collection("users").document(uid).collection("help_center_interactions").add({
                "type": "search",
                "query": query,
                "kind": kind,
                "timestamp": firestore.SERVER_TIMESTAMP,
                "created_at": _now_ts(),
            })
    except Exception:
        pass

    allowed_types = {"HELP", "FAQ"}
    if kind.strip().lower() == "article":
        allowed_types = {"HELP"}
    elif kind.strip().lower() == "faq":
        allowed_types = {"FAQ"}

    all_docs = store.list_documents()
    # Filter to help-center docs
    doc_map: Dict[str, Dict[str, Any]] = {}
    for d in all_docs:
        dt = (d.get("doc_type") or "").upper()
        if dt not in allowed_types:
            continue
        doc_map[d.get("id")] = d

    chunks = [
        c for c in store.get_all_chunks()
        if (c.get("metadata") or {}).get("doc_type") in allowed_types
        and (c.get("document_id") in doc_map)
    ]

    if not query:
        # No query: return empty results; UI should call /popular for defaults.
        return HelpCenterSearchResponse(query="", results=[])

    scored = retrieve(chunks, query, k=max(25, k * 4))

    # Group chunk scores per document.
    by_doc: Dict[str, Dict[str, Any]] = {}
    for score, ch in scored:
        doc_id = ch.get("document_id")
        if not doc_id or doc_id not in doc_map:
            continue
        prev = by_doc.get(doc_id)
        if prev is None or float(score) > float(prev["score"]):
            by_doc[doc_id] = {"score": float(score), "chunk": ch}

    results: List[HelpCenterSearchResult] = []
    for doc_id, entry in by_doc.items():
        d = doc_map.get(doc_id) or {}
        title = ((d.get("metadata") or {}).get("title") or doc_id)
        body = (((d.get("extraction") or {}).get("text")) or "")
        keywords = _parse_keywords(body)
        lex = _lexical_score(tokens, title, keywords, body)
        sem = float(entry.get("score") or 0.0)
        combined = 0.70 * sem + 0.30 * lex

        excerpt = _safe_excerpt((entry.get("chunk") or {}).get("content") or body)

        results.append(HelpCenterSearchResult(
            id=str(doc_id),
            title=str(title),
            kind=_doc_kind(d.get("doc_type")),
            score=float(round(combined, 6)),
            excerpt=excerpt,
        ))

    results.sort(key=lambda r: r.score, reverse=True)
    return HelpCenterSearchResponse(query=query, results=results[:k])


@router.get("/content/{doc_id}")
async def get_help_content(
    request: Request,
    doc_id: str,
    user: Dict[str, Any] = Depends(get_current_user),
):
    store = _get_store(request)
    doc = store.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Help content not found")
    dt = (doc.get("doc_type") or "").upper()
    if dt not in {"HELP", "FAQ"}:
        raise HTTPException(status_code=404, detail="Help content not found")

    text = ((doc.get("extraction") or {}).get("text") or "").strip()
    title = ((doc.get("metadata") or {}).get("title") or doc_id)

    # Best-effort audit
    try:
        uid = user.get("uid")
        if uid:
            log_action(uid, "HELP_CENTER_VIEW", f"Viewed {doc_id}")
    except Exception:
        pass

    return {
        "id": doc_id,
        "title": title,
        "kind": _doc_kind(dt),
        "content": text,
    }


@router.get("/faqs")
async def list_faqs(
    request: Request,
    user: Dict[str, Any] = Depends(get_current_user),
):
    store = _get_store(request)
    out: List[Dict[str, Any]] = []
    for d in store.list_documents():
        if (d.get("doc_type") or "").upper() != "FAQ":
            continue
        doc_id = d.get("id")
        body = (((d.get("extraction") or {}).get("text")) or "")
        title = ((d.get("metadata") or {}).get("title") or doc_id)
        items = _split_faq_items(body)
        for idx, it in enumerate(items):
            out.append({
                "id": f"{doc_id}::q{idx+1}",
                "doc_id": doc_id,
                "doc_title": title,
                "question": it.get("question"),
                "answer": it.get("answer"),
            })
    return {"items": out}


@router.get("/popular")
async def popular_content(
    type: str = Query(default="article", description="article|faq"),
    limit: int = Query(default=6, ge=1, le=12),
    user: Dict[str, Any] = Depends(get_current_user),
):
    coll = "help_center_articles" if type.strip().lower() == "article" else "help_center_faqs"
    items: List[Dict[str, Any]] = []
    try:
        snaps = db.collection(coll).order_by("click_count", direction=firestore.Query.DESCENDING).limit(limit).stream()
        for s in snaps:
            d = s.to_dict() or {}
            items.append({
                "id": d.get("id") or s.id,
                "title": d.get("title") or "",
                "kind": d.get("kind") or ("article" if coll == "help_center_articles" else "faq"),
                "click_count": int(d.get("click_count") or 0),
                "view_count": int(d.get("view_count") or 0),
            })
    except Exception:
        items = []
    return {"items": items}


@router.post("/interactions")
async def record_interaction(
    body: HelpCenterInteractionIn,
    user: Dict[str, Any] = Depends(get_current_user),
):
    uid = user.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="Not signed in")

    payload = body.model_dump()
    payload["uid"] = uid
    payload["created_at"] = _now_ts()
    payload["timestamp"] = firestore.SERVER_TIMESTAMP

    # Store per-user history.
    try:
        db.collection("users").document(uid).collection("help_center_interactions").add(payload)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to record interaction: {e}")

    # Update popularity counters (best-effort).
    try:
        content_id = (body.content_id or "").strip()
        title = (body.content_title or "").strip()
        kind = (body.content_kind or "").strip().lower()
        itype = (body.type or "").strip().lower()

        if content_id and kind in {"article", "faq"}:
            coll = "help_center_articles" if kind == "article" else "help_center_faqs"
            ref = db.collection(coll).document(content_id)
            updates: Dict[str, Any] = {
                "id": content_id,
                "title": title,
                "kind": kind,
                "updated_at": _now_ts(),
            }
            if itype in {"view_content", "view", "open"}:
                updates["view_count"] = firestore.Increment(1)
            if itype in {"search_click", "click"}:
                updates["click_count"] = firestore.Increment(1)
            ref.set(updates, merge=True)
    except Exception:
        pass

    return {"success": True}


@router.get("/history")
async def get_history(
    q: str = Query(default="", max_length=240),
    limit: int = Query(default=50, ge=1, le=100),
    user: Dict[str, Any] = Depends(get_current_user),
):
    uid = user.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="Not signed in")

    query = (q or "").strip().lower()
    items: List[Dict[str, Any]] = []
    try:
        # Fetch recent interactions; sort client-side to avoid indexes.
        snaps = db.collection("users").document(uid).collection("help_center_interactions").stream()
        for s in snaps:
            d = s.to_dict() or {}
            d["id"] = s.id
            items.append(d)
    except Exception:
        items = []

    items.sort(key=lambda d: float(d.get("created_at") or 0.0), reverse=True)

    if query:
        def _matches(d: Dict[str, Any]) -> bool:
            hay = " ".join([
                str(d.get("type") or ""),
                str(d.get("query") or ""),
                str(d.get("content_title") or ""),
                str(d.get("content_id") or ""),
            ]).lower()
            return query in hay

        items = [d for d in items if _matches(d)]

    return {"items": items[:limit]}


@router.get("/tickets", response_model=List[HelpCenterTicket])
async def list_my_tickets(
    limit: int = Query(default=50, ge=1, le=100),
    user: Dict[str, Any] = Depends(get_current_user),
):
    uid = user.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="Not signed in")

    tickets: List[HelpCenterTicket] = []
    try:
        snaps = db.collection("support_requests").where("user_id", "==", uid).stream()
        for s in snaps:
            d = s.to_dict() or {}
            tickets.append(HelpCenterTicket(
                id=s.id,
                subject=str(d.get("subject") or ""),
                message=str(d.get("message") or ""),
                status=str(d.get("status") or "pending"),
                created_at=float(d.get("created_at") or d.get("timestamp") or 0.0),
            ))
    except Exception:
        tickets = []

    tickets.sort(key=lambda t: float(t.created_at or 0.0), reverse=True)
    return tickets[:limit]


@router.post("/ai", response_model=HelpCenterAskOut)
async def ask_help_center_ai(
    request: Request,
    body: HelpCenterAskIn,
    user: Dict[str, Any] = Depends(get_current_user),
):
    store = _get_store(request)
    uid = user.get("uid")
    msg = (body.message or "").strip()
    if not msg:
        raise HTTPException(status_code=400, detail="Missing message")

    # Retrieve context from help-center chunks only.
    chunks = [
        c for c in store.get_all_chunks()
        if (c.get("metadata") or {}).get("doc_type") in {"HELP", "FAQ"}
    ]
    topk = retrieve(chunks, msg, k=5)

    sources: List[Dict[str, Any]] = []
    parts: List[str] = []
    for score, ch in topk:
        parts.append(ch.get("content") or "")
        sources.append({
            "document_id": ch.get("document_id"),
            "chunk_index": ch.get("chunk_index"),
            "score": round(float(score), 4),
        })

    context = "\n\n---\n\n".join([p for p in parts if p]).strip()[: int(body.max_context_chars or 2200)]

    answer = ""
    try:
        # Try the LLM-backed answer first.
        from .vision import chat_answer  # local import to avoid hard failure at import time
        answer = chat_answer(msg, context or "No context available.")
    except Exception:
        # Deterministic fallback: return relevant sources.
        if sources:
            answer = "I couldn’t reach the AI model right now. Here are the most relevant Help Center items:\n" + "\n".join(
                [f"- {s.get('document_id')}" for s in sources[:5]]
            )
        else:
            answer = "I couldn’t reach the AI model right now, and I don’t have enough Help Center context yet. Try searching for an article by keyword." 

    # Persist interaction (best-effort)
    try:
        if uid:
            db.collection("users").document(uid).collection("help_center_interactions").add({
                "type": "ai_qa",
                "query": msg,
                "answer": answer,
                "sources": sources,
                "created_at": _now_ts(),
                "timestamp": firestore.SERVER_TIMESTAMP,
            })
    except Exception:
        pass

    return HelpCenterAskOut(answer=answer, sources=sources)
