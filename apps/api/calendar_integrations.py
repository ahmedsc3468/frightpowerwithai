from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Literal, Optional
from urllib.parse import urlencode, urlparse
from datetime import datetime, timedelta, timezone
import base64
import hashlib
import hmac
import json
import re
import secrets
import time

import httpx

from .auth import get_current_user
from .database import db, log_action
from .settings import settings


router = APIRouter(prefix="/calendar", tags=["Calendar"])

Provider = Literal["google", "outlook"]


class CalendarEvent(BaseModel):
    internal_id: str = Field(..., description="Stable FreightPower event id used for idempotent sync")
    title: str

    # Either all-day date (YYYY-MM-DD) or date-time ISO string.
    all_day: bool = True
    start: str
    end: str

    description: Optional[str] = None
    location: Optional[str] = None


class CalendarSyncRequest(BaseModel):
    provider: Provider
    events: List[CalendarEvent] = Field(default_factory=list)
    reminders_enabled: bool = True


class CalendarDisconnectRequest(BaseModel):
    provider: Provider


class InternalCalendarEventCreate(BaseModel):
    title: str
    all_day: bool = True
    # YYYY-MM-DD (all-day). Stored as start inclusive, end exclusive.
    start: str
    end: str
    description: Optional[str] = None
    location: Optional[str] = None
    reminders: List[int] = Field(default_factory=list)


class InternalCalendarEventAssign(BaseModel):
    carrier_uids: List[str] = Field(default_factory=list)
    sync_external: bool = True


_YMD_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _parse_ymd(value: Optional[str]) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text or not _YMD_RE.match(text):
        return None
    try:
        y, m, d = text.split("-")
        return datetime(int(y), int(m), int(d), tzinfo=timezone.utc)
    except Exception:
        return None


def _normalize_uid_list(values: Any, *, max_items: int = 100) -> List[str]:
    raw = values if isinstance(values, list) else []
    uniq: List[str] = []
    seen = set()
    for v in raw:
        s = str(v or "").strip()
        if not s or s in seen:
            continue
        seen.add(s)
        uniq.append(s)
        if len(uniq) >= max_items:
            break
    return uniq


def _internal_events_col():
    return db.collection("calendar_internal_events")


def _now_ts() -> float:
    return float(time.time())


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * ((4 - (len(s) % 4)) % 4)
    return base64.urlsafe_b64decode((s or "") + pad)


def _state_secret() -> str:
    # This secret is used to sign OAuth state. If not provided, fall back to an
    # ephemeral per-process secret (dev-only; callbacks will break after restart).
    secret = str(getattr(settings, "CALENDAR_OAUTH_STATE_SECRET", "") or "").strip()
    if secret:
        return secret

    # Stable-ish fallback: do NOT rely on this for production security.
    fallback = str(getattr(settings, "ADMIN_BOOTSTRAP_TOKEN", "") or "").strip()
    if fallback:
        return fallback

    # Last resort (dev). This is intentionally not persisted.
    if not hasattr(_state_secret, "_ephemeral"):
        setattr(_state_secret, "_ephemeral", secrets.token_urlsafe(32))
    return getattr(_state_secret, "_ephemeral")


def _encode_state(payload: Dict[str, Any]) -> str:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    sig = hmac.new(_state_secret().encode("utf-8"), body, hashlib.sha256).digest()
    return f"{_b64url(body)}.{_b64url(sig)}"


def _decode_state(state: str) -> Dict[str, Any]:
    try:
        body_b64, sig_b64 = (state or "").split(".", 1)
        body = _b64url_decode(body_b64)
        sig = _b64url_decode(sig_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid state")

    expected = hmac.new(_state_secret().encode("utf-8"), body, hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=400, detail="Invalid state signature")

    try:
        payload = json.loads(body.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("state payload not dict")
        return payload
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid state payload")


def _safe_return_to(value: Optional[str]) -> str:
    # Prevent open redirects. Only allow relative paths like /driver-dashboard?... .
    v = (value or "/driver-dashboard?nav=settings").strip()
    if not v.startswith("/"):
        return "/driver-dashboard?nav=settings"
    parsed = urlparse(v)
    if parsed.scheme or parsed.netloc:
        return "/driver-dashboard?nav=settings"
    return v


def _provider_config(provider: Provider) -> Dict[str, str]:
    if provider == "google":
        return {
            "client_id": str(getattr(settings, "GOOGLE_CALENDAR_CLIENT_ID", "") or "").strip(),
            "client_secret": str(getattr(settings, "GOOGLE_CALENDAR_CLIENT_SECRET", "") or "").strip(),
            "redirect_uri": str(getattr(settings, "GOOGLE_CALENDAR_REDIRECT_URI", "") or "").strip(),
        }
    return {
        "client_id": str(getattr(settings, "MICROSOFT_CLIENT_ID", "") or "").strip(),
        "client_secret": str(getattr(settings, "MICROSOFT_CLIENT_SECRET", "") or "").strip(),
        "redirect_uri": str(getattr(settings, "MICROSOFT_REDIRECT_URI", "") or "").strip(),
        "tenant": str(getattr(settings, "MICROSOFT_TENANT", "common") or "common").strip() or "common",
    }


def _assert_provider_configured(provider: Provider) -> None:
    cfg = _provider_config(provider)
    if not cfg.get("client_id") or not cfg.get("client_secret") or not cfg.get("redirect_uri"):
        raise HTTPException(
            status_code=501,
            detail=(
                f"{provider} calendar OAuth is not configured yet. "
                f"Set the {provider.upper()} OAuth env vars on the backend."
            ),
        )


def _integration_doc(uid: str):
    return db.collection("users").document(uid).collection("integrations").document("calendar")


def _event_link_doc(uid: str, provider: Provider, internal_id: str):
    digest = hashlib.sha256(f"{provider}:{internal_id}".encode("utf-8")).hexdigest()[:32]
    doc_id = f"{provider}__{digest}"
    return db.collection("users").document(uid).collection("calendar_event_links").document(doc_id)


async def _get_provider_tokens(uid: str, provider: Provider) -> Dict[str, Any]:
    snap = _integration_doc(uid).get()
    if not snap.exists:
        return {}
    d = snap.to_dict() or {}
    providers = d.get("providers") or {}
    p = providers.get(provider) or {}
    return p if isinstance(p, dict) else {}


async def _set_provider_tokens(uid: str, provider: Provider, tokens: Dict[str, Any]) -> None:
    now = _now_ts()
    _integration_doc(uid).set(
        {
            "providers": {provider: {**tokens, "updated_at": now}},
            "updated_at": now,
        },
        merge=True,
    )


async def _refresh_google_access_token(uid: str) -> str:
    tokens = await _get_provider_tokens(uid, "google")
    refresh_token = str(tokens.get("refresh_token") or "").strip()
    if not refresh_token:
        raise HTTPException(status_code=401, detail="Google Calendar is not connected")

    expires_at = float(tokens.get("expires_at") or 0)
    access_token = str(tokens.get("access_token") or "").strip()
    if access_token and expires_at > (_now_ts() + 60):
        return access_token

    cfg = _provider_config("google")
    _assert_provider_configured("google")

    data = {
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }

    async with httpx.AsyncClient(timeout=25.0) as client:
        res = await client.post("https://oauth2.googleapis.com/token", data=data)
        body = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
        if res.status_code >= 400:
            raise HTTPException(status_code=401, detail=body.get("error_description") or "Failed to refresh Google token")

    new_access = str(body.get("access_token") or "").strip()
    expires_in = float(body.get("expires_in") or 3600)
    if not new_access:
        raise HTTPException(status_code=401, detail="Failed to refresh Google token")

    await _set_provider_tokens(
        uid,
        "google",
        {
            **tokens,
            "access_token": new_access,
            "expires_at": _now_ts() + expires_in,
            "token_type": body.get("token_type") or tokens.get("token_type") or "Bearer",
        },
    )
    return new_access


async def _refresh_outlook_access_token(uid: str) -> str:
    tokens = await _get_provider_tokens(uid, "outlook")
    refresh_token = str(tokens.get("refresh_token") or "").strip()
    if not refresh_token:
        raise HTTPException(status_code=401, detail="Outlook calendar is not connected")

    expires_at = float(tokens.get("expires_at") or 0)
    access_token = str(tokens.get("access_token") or "").strip()
    if access_token and expires_at > (_now_ts() + 60):
        return access_token

    cfg = _provider_config("outlook")
    _assert_provider_configured("outlook")
    tenant = cfg.get("tenant") or "common"

    data = {
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "refresh_token": refresh_token,
        "redirect_uri": cfg["redirect_uri"],
        "grant_type": "refresh_token",
        "scope": "offline_access https://graph.microsoft.com/Calendars.ReadWrite",
    }

    async with httpx.AsyncClient(timeout=25.0) as client:
        res = await client.post(f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token", data=data)
        body = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
        if res.status_code >= 400:
            msg = body.get("error_description") or body.get("error") or "Failed to refresh Outlook token"
            raise HTTPException(status_code=401, detail=msg)

    new_access = str(body.get("access_token") or "").strip()
    expires_in = float(body.get("expires_in") or 3600)
    new_refresh = str(body.get("refresh_token") or "").strip() or refresh_token
    if not new_access:
        raise HTTPException(status_code=401, detail="Failed to refresh Outlook token")

    await _set_provider_tokens(
        uid,
        "outlook",
        {
            **tokens,
            "access_token": new_access,
            "refresh_token": new_refresh,
            "expires_at": _now_ts() + expires_in,
            "token_type": body.get("token_type") or tokens.get("token_type") or "Bearer",
        },
    )
    return new_access


def _google_event_payload(e: CalendarEvent, reminders_enabled: bool) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "summary": e.title,
    }
    if e.description:
        payload["description"] = e.description
    if e.location:
        payload["location"] = e.location

    if e.all_day:
        payload["start"] = {"date": e.start}
        payload["end"] = {"date": e.end}
    else:
        payload["start"] = {"dateTime": e.start}
        payload["end"] = {"dateTime": e.end}

    if reminders_enabled:
        payload["reminders"] = {
            "useDefault": False,
            "overrides": [{"method": "popup", "minutes": 60}],
        }
    else:
        payload["reminders"] = {"useDefault": False, "overrides": []}

    return payload


def _outlook_event_payload(e: CalendarEvent, reminders_enabled: bool) -> Dict[str, Any]:
    # Graph wants dateTime+timeZone.
    def _dt(s: str) -> Dict[str, str]:
        return {"dateTime": s, "timeZone": "UTC"}

    payload: Dict[str, Any] = {
        "subject": e.title,
        "isReminderOn": bool(reminders_enabled),
        "reminderMinutesBeforeStart": 60,
    }
    if e.description:
        payload["body"] = {"contentType": "Text", "content": e.description}
    if e.location:
        payload["location"] = {"displayName": e.location}

    if e.all_day:
        payload["isAllDay"] = True
        payload["start"] = _dt(f"{e.start}T00:00:00")
        payload["end"] = _dt(f"{e.end}T00:00:00")
    else:
        payload["isAllDay"] = False
        payload["start"] = _dt(e.start)
        payload["end"] = _dt(e.end)

    return payload


@router.get("/oauth/{provider}/start")
async def oauth_start(
    provider: Provider,
    return_to: Optional[str] = Query(default=None),
    user: Dict[str, Any] = Depends(get_current_user),
):
    uid = user.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")

    _assert_provider_configured(provider)
    cfg = _provider_config(provider)

    safe_return = _safe_return_to(return_to)
    state = _encode_state(
        {
            "v": 1,
            "uid": uid,
            "provider": provider,
            "nonce": secrets.token_urlsafe(16),
            "iat": int(_now_ts()),
            "return_to": safe_return,
        }
    )

    if provider == "google":
        params = {
            "client_id": cfg["client_id"],
            "redirect_uri": cfg["redirect_uri"],
            "response_type": "code",
            "scope": "https://www.googleapis.com/auth/calendar.events",
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
            "state": state,
        }
        auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params)
    else:
        tenant = cfg.get("tenant") or "common"
        params = {
            "client_id": cfg["client_id"],
            "redirect_uri": cfg["redirect_uri"],
            "response_type": "code",
            "response_mode": "query",
            "scope": "offline_access https://graph.microsoft.com/Calendars.ReadWrite",
            "state": state,
        }
        auth_url = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize?" + urlencode(params)

    return {"auth_url": auth_url}


@router.get("/oauth/{provider}/callback")
async def oauth_callback(provider: Provider, code: str, state: str):
    payload = _decode_state(state)
    if payload.get("provider") != provider:
        raise HTTPException(status_code=400, detail="State/provider mismatch")
    uid = str(payload.get("uid") or "").strip()
    if not uid:
        raise HTTPException(status_code=400, detail="Invalid state")

    iat = int(payload.get("iat") or 0)
    if iat <= 0 or (int(_now_ts()) - iat) > (10 * 60):
        raise HTTPException(status_code=400, detail="OAuth state expired")

    _assert_provider_configured(provider)
    cfg = _provider_config(provider)
    now = _now_ts()

    if provider == "google":
        data = {
            "client_id": cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "redirect_uri": cfg["redirect_uri"],
            "code": code,
            "grant_type": "authorization_code",
        }
        token_url = "https://oauth2.googleapis.com/token"
    else:
        tenant = cfg.get("tenant") or "common"
        data = {
            "client_id": cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "redirect_uri": cfg["redirect_uri"],
            "code": code,
            "grant_type": "authorization_code",
            "scope": "offline_access https://graph.microsoft.com/Calendars.ReadWrite",
        }
        token_url = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"

    async with httpx.AsyncClient(timeout=25.0) as client:
        res = await client.post(token_url, data=data)
        body = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
        if res.status_code >= 400:
            msg = body.get("error_description") or body.get("error") or "OAuth token exchange failed"
            raise HTTPException(status_code=400, detail=msg)

    access_token = str(body.get("access_token") or "").strip()
    refresh_token = str(body.get("refresh_token") or "").strip()
    expires_in = float(body.get("expires_in") or 3600)
    scope = body.get("scope")

    existing = await _get_provider_tokens(uid, provider)
    merged_refresh = refresh_token or str(existing.get("refresh_token") or "").strip()

    await _set_provider_tokens(
        uid,
        provider,
        {
            "connected": True,
            "connected_at": existing.get("connected_at") or now,
            "access_token": access_token,
            "refresh_token": merged_refresh,
            "expires_at": now + expires_in,
            "scope": scope,
            "token_type": body.get("token_type") or existing.get("token_type") or "Bearer",
        },
    )
    try:
        log_action(uid, "CALENDAR_CONNECTED", f"Connected {provider} calendar")
    except Exception:
        pass

    return_to = _safe_return_to(str(payload.get("return_to") or ""))
    # Ensure nav=settings and trigger a one-time sync on the client.
    connector = "&" if ("?" in return_to) else "?"
    redirect_path = f"{return_to}{connector}calendar_provider={provider}&calendar_connected=1&calendar_auto_sync=1"
    redirect_url = str(getattr(settings, "FRONTEND_BASE_URL", "http://localhost:5173")).rstrip("/") + redirect_path
    return RedirectResponse(url=redirect_url)


@router.get("/status")
async def calendar_status(user: Dict[str, Any] = Depends(get_current_user)):
    uid = user.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")

    snap = _integration_doc(uid).get()
    data = snap.to_dict() if snap.exists else {}
    providers = data.get("providers") if isinstance(data, dict) else {}
    providers = providers if isinstance(providers, dict) else {}

    def _connected(p: dict) -> bool:
        if not isinstance(p, dict):
            return False
        if p.get("connected") is not True:
            return False
        # refresh token is the reliable indicator for ongoing access.
        return bool(str(p.get("refresh_token") or "").strip())

    return {
        "google": {"connected": _connected(providers.get("google") or {}), "updated_at": (providers.get("google") or {}).get("updated_at")},
        "outlook": {"connected": _connected(providers.get("outlook") or {}), "updated_at": (providers.get("outlook") or {}).get("updated_at")},
        "last_synced_at": data.get("last_synced_at") if isinstance(data, dict) else None,
    }


@router.post("/disconnect")
async def calendar_disconnect(payload: CalendarDisconnectRequest, user: Dict[str, Any] = Depends(get_current_user)):
    uid = user.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")

    provider = payload.provider
    existing = await _get_provider_tokens(uid, provider)
    # Best-effort revoke for Google.
    if provider == "google":
        token = str(existing.get("refresh_token") or existing.get("access_token") or "").strip()
        if token:
            try:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    await client.post("https://oauth2.googleapis.com/revoke", params={"token": token})
            except Exception:
                pass

    _integration_doc(uid).set(
        {
            "providers": {
                provider: {
                    "connected": False,
                    "disconnected_at": _now_ts(),
                    "access_token": None,
                    "refresh_token": None,
                    "expires_at": None,
                    "scope": None,
                    "updated_at": _now_ts(),
                }
            },
            "updated_at": _now_ts(),
        },
        merge=True,
    )

    try:
        log_action(uid, "CALENDAR_DISCONNECTED", f"Disconnected {provider} calendar")
    except Exception:
        pass

    return {"ok": True}


@router.post("/sync")
async def calendar_sync(payload: CalendarSyncRequest, user: Dict[str, Any] = Depends(get_current_user)):
    uid = user.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")

    provider = payload.provider
    events = payload.events or []
    if not events:
        return {"ok": True, "synced": 0}

    now_dt = datetime.now(timezone.utc)
    # Defensive: keep sync bounded.
    events = events[:250]

    if provider == "google":
        access_token = await _refresh_google_access_token(uid)
        headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
        base = "https://www.googleapis.com/calendar/v3"
        async with httpx.AsyncClient(timeout=25.0) as client:
            synced = 0
            for e in events:
                # Skip past events best-effort.
                try:
                    if e.all_day:
                        start_dt = datetime.fromisoformat(e.start).replace(tzinfo=timezone.utc)
                    else:
                        start_dt = datetime.fromisoformat(e.start.replace("Z", "+00:00"))
                    if start_dt < (now_dt - timedelta(days=1)):
                        continue
                except Exception:
                    pass

                link_ref = _event_link_doc(uid, provider, e.internal_id)
                link = link_ref.get().to_dict() if link_ref.get().exists else {}
                external_id = str((link or {}).get("external_id") or "").strip()

                body = _google_event_payload(e, payload.reminders_enabled)
                if external_id:
                    url = f"{base}/calendars/primary/events/{external_id}"
                    res = await client.patch(url, headers=headers, json=body)
                    if res.status_code == 404:
                        external_id = ""
                    elif res.status_code >= 400:
                        raise HTTPException(status_code=400, detail=f"Google sync failed: {res.text}")

                if not external_id:
                    url = f"{base}/calendars/primary/events"
                    res = await client.post(url, headers=headers, json=body)
                    if res.status_code >= 400:
                        raise HTTPException(status_code=400, detail=f"Google sync failed: {res.text}")
                    created = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
                    external_id = str(created.get("id") or "").strip()
                    if external_id:
                        link_ref.set(
                            {
                                "provider": provider,
                                "internal_id": e.internal_id,
                                "external_id": external_id,
                                "created_at": _now_ts(),
                                "updated_at": _now_ts(),
                            },
                            merge=True,
                        )
                synced += 1

    else:
        access_token = await _refresh_outlook_access_token(uid)
        headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
        base = "https://graph.microsoft.com/v1.0"
        async with httpx.AsyncClient(timeout=25.0) as client:
            synced = 0
            for e in events:
                link_ref = _event_link_doc(uid, provider, e.internal_id)
                snap = link_ref.get()
                link = snap.to_dict() if snap.exists else {}
                external_id = str((link or {}).get("external_id") or "").strip()
                body = _outlook_event_payload(e, payload.reminders_enabled)
                if external_id:
                    res = await client.patch(f"{base}/me/events/{external_id}", headers=headers, json=body)
                    if res.status_code == 404:
                        external_id = ""
                    elif res.status_code >= 400:
                        raise HTTPException(status_code=400, detail=f"Outlook sync failed: {res.text}")
                if not external_id:
                    res = await client.post(f"{base}/me/events", headers=headers, json=body)
                    if res.status_code >= 400:
                        raise HTTPException(status_code=400, detail=f"Outlook sync failed: {res.text}")
                    created = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
                    external_id = str(created.get("id") or "").strip()
                    if external_id:
                        link_ref.set(
                            {
                                "provider": provider,
                                "internal_id": e.internal_id,
                                "external_id": external_id,
                                "created_at": _now_ts(),
                                "updated_at": _now_ts(),
                            },
                            merge=True,
                        )
                synced += 1

    _integration_doc(uid).set({"last_synced_at": _now_ts(), "updated_at": _now_ts()}, merge=True)
    try:
        log_action(uid, "CALENDAR_SYNC", f"Synced {synced} events to {provider}")
    except Exception:
        pass
    return {"ok": True, "synced": int(synced)}


@router.get("/internal/events")
async def list_internal_events(
    start: Optional[str] = Query(default=None, description="YYYY-MM-DD"),
    end: Optional[str] = Query(default=None, description="YYYY-MM-DD"),
    limit: int = Query(default=500, ge=1, le=1000),
    user: Dict[str, Any] = Depends(get_current_user),
):
    uid = user.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")

    start_dt = _parse_ymd(start)
    end_dt = _parse_ymd(end)
    start_ts = start_dt.timestamp() if start_dt else None
    end_excl_ts = (end_dt + timedelta(days=1)).timestamp() if end_dt else None

    def _in_range(ev: Dict[str, Any]) -> bool:
        if start_ts is None and end_excl_ts is None:
            return True
        s = ev.get("start_ts")
        try:
            s_ts = float(s)
        except Exception:
            return False
        if start_ts is not None and s_ts < start_ts:
            return False
        if end_excl_ts is not None and s_ts >= end_excl_ts:
            return False
        return True

    # Avoid composite indexes by doing simple equality/array queries and filtering in-app.
    owner_q = _internal_events_col().where("owner_uid", "==", uid).limit(int(limit))
    assigned_q = _internal_events_col().where("assigned_carrier_uids", "array_contains", uid).limit(int(limit))

    results: Dict[str, Dict[str, Any]] = {}
    try:
        for snap in owner_q.stream():
            if not snap.exists:
                continue
            d = snap.to_dict() or {}
            d["id"] = snap.id
            if _in_range(d):
                results[snap.id] = d
        for snap in assigned_q.stream():
            if not snap.exists:
                continue
            d = snap.to_dict() or {}
            d["id"] = snap.id
            if _in_range(d):
                results[snap.id] = d
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list internal events: {str(e)}")

    events = list(results.values())
    events.sort(key=lambda x: float(x.get("start_ts") or 0))
    return {"events": events}


@router.post("/internal/events")
async def create_internal_event(payload: InternalCalendarEventCreate, user: Dict[str, Any] = Depends(get_current_user)):
    uid = user.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")

    title = str(payload.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is required")

    start_dt = _parse_ymd(payload.start)
    end_dt = _parse_ymd(payload.end)
    if not start_dt or not end_dt:
        raise HTTPException(status_code=400, detail="Start and end must be valid dates (YYYY-MM-DD)")
    if end_dt < start_dt:
        raise HTTPException(status_code=400, detail="End must be on/after start")

    now = _now_ts()
    doc_ref = _internal_events_col().document()
    doc_id = doc_ref.id

    doc = {
        "owner_uid": uid,
        "title": title,
        "all_day": bool(payload.all_day is not False),
        "start": str(payload.start).strip(),
        "end": str(payload.end).strip(),
        "start_ts": float(start_dt.timestamp()),
        "end_ts": float(end_dt.timestamp()),
        "description": str(payload.description or "").strip() or None,
        "location": str(payload.location or "").strip() or None,
        "reminders": [int(x) for x in (payload.reminders or []) if isinstance(x, (int, float))],
        "assigned_carrier_uids": [],
        "created_at": now,
        "updated_at": now,
    }

    try:
        doc_ref.set(doc)
        try:
            log_action(uid, "CALENDAR_INTERNAL_EVENT_CREATED", f"Created internal calendar event {doc_id}")
        except Exception:
            pass
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create internal event: {str(e)}")

    return {"ok": True, "event": {"id": doc_id, **doc}}


@router.post("/internal/events/{event_id}/assign")
async def assign_internal_event(
    event_id: str,
    payload: InternalCalendarEventAssign,
    user: Dict[str, Any] = Depends(get_current_user),
):
    uid = user.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")

    ev_id = str(event_id or "").strip()
    if not ev_id:
        raise HTTPException(status_code=400, detail="Invalid event id")

    carrier_uids = _normalize_uid_list(payload.carrier_uids, max_items=250)
    if not carrier_uids:
        return {"ok": True, "assigned": 0}

    ref = _internal_events_col().document(ev_id)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Event not found")
    data = snap.to_dict() or {}
    if str(data.get("owner_uid") or "").strip() != uid:
        raise HTTPException(status_code=403, detail="Not allowed")

    existing = data.get("assigned_carrier_uids") if isinstance(data.get("assigned_carrier_uids"), list) else []
    merged = []
    seen = set()
    for x in existing + carrier_uids:
        s = str(x or "").strip()
        if not s or s in seen:
            continue
        seen.add(s)
        merged.append(s)

    try:
        ref.set({"assigned_carrier_uids": merged, "updated_at": _now_ts()}, merge=True)
        try:
            log_action(uid, "CALENDAR_INTERNAL_EVENT_ASSIGNED", f"Assigned event {ev_id} to {len(carrier_uids)} carriers")
        except Exception:
            pass
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to assign event: {str(e)}")

    return {"ok": True, "assigned": len(carrier_uids)}
