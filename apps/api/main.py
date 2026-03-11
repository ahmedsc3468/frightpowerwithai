from __future__ import annotations

# File: apps/api/main.py
from fastapi import FastAPI, UploadFile, File, HTTPException, Header, Depends, Form, Request, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, FileResponse, StreamingResponse
from pydantic import BaseModel, root_validator, Field
from typing import Dict, Any, List, Optional, Tuple
from datetime import datetime, timezone, timedelta
import uuid
import json
import time
import os
import io
import logging
import zipfile
import urllib.request
from pathlib import Path

import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from firebase_admin import auth as firebase_auth
from firebase_admin import firestore

# --- Local Imports ---
from .settings import settings
from .banlist import record_bans
from .storage import ResponseStore
from .pdf_utils import pdf_to_images, pdf_to_text
from .vision import detect_document_type, extract_document
from .rag import build_document_chunks, retrieve
from .scoring import score_onboarding
from .classification import resolve_document_type
from .validation import validate_document
from .enrichment import enrich_extraction
from .knowledge import bootstrap_knowledge_base
from .fmcsa import FmcsaClient, profile_to_dict
from .preextract import preextract_fields
from .coach import compute_coach_plan
from .match import match_load
from .alerts import create_alert, list_alerts, summarize_alerts, digest_alerts

# Auth/DB + Routers
from .database import db, log_action, bucket
from .auth import (
    router as auth_router,
    get_current_user,
    require_admin,
    require_super_admin,
)
from .biometric import router as biometric_router
from .onboarding import router as onboarding_router
from .messaging import (
    router as messaging_router,
    process_pending_message_email_notifications_job,
)
from .scheduler import SchedulerWrapper
from .finance import router as finance_router, init_finance_scheduler
from .load_documents import router as load_documents_router, create_load_document_from_url, ensure_rate_confirmation_document
from .load_workflow import router as load_workflow_router
from .load_ownership import normalized_fields_for_new_load, normalized_ownership_patch_for_load
from .load_workflow_utils import is_rate_con_carrier_signed, notify_previous_carriers_new_load, sanitize_load_for_viewer
from .consents import router as consents_router
from .calendar_integrations import router as calendar_router
from .help_center import router as help_center_router
from .role_chat import router as role_chat_router

# Shared API models used by response_model=... and request bodies in this module.
from .models import (
    ChatResponse,
    DistanceCalculationRequest,
    DistanceCalculationResponse,
    DriverStatusUpdateRequest,
    GeocodeRequest,
    GenerateInstructionsResponse,
    GenerateInstructionsRequest,
    LoadActionResponse,
    LoadComplete,
    LoadCostCalculationRequest,
    LoadCostCalculationResponse,
    LoadListResponse,
    LoadResponse,
    LoadStatus,
    LoadStep1Create,
    LoadStep1Response,
    LoadStep2Update,
    LoadStep3Update,
    MatrixRequest,
    MatrixResponse,
    OfferResponse,
    OffersListResponse,
    ReverseGeocodeRequest,
    RouteRequest,
    RouteResponse,
    SnapshotRequest,
    SnapshotResponse,
    TenderOfferRequest,
    AcceptCarrierRequest,
    RejectOfferRequest,
)

from .utils import generate_load_id, generate_load_number
from .chat_flow import process_onboarding_chat
from .forms import autofill_driver_registration, autofill_clearinghouse_consent, autofill_mvr_release
from .here_maps import get_here_client
from .ai_utils import calculate_load_cost
from .notify import send_webhook

logger = logging.getLogger(__name__)


def _parse_time_range(*, time_range: str, start_date: Optional[str] = None, end_date: Optional[str] = None) -> Tuple[float, float, str]:
    """Return (start_ts, end_ts, normalized_label) in UTC epoch seconds."""
    label = str(time_range or "").strip() or "Last 30 Days"
    now_dt = datetime.now(timezone.utc)
    end_ts = float(now_dt.timestamp())

    normalized = label
    if label.lower() in {"last 7 days", "7d", "last7"}:
        start_ts = float((now_dt - timedelta(days=7)).timestamp())
        normalized = "Last 7 Days"
    elif label.lower() in {"last 30 days", "30d", "last30"}:
        start_ts = float((now_dt - timedelta(days=30)).timestamp())
        normalized = "Last 30 Days"
    elif label.lower() in {"last 90 days", "90d", "last90"}:
        start_ts = float((now_dt - timedelta(days=90)).timestamp())
        normalized = "Last 90 Days"
    elif label.lower() in {"this year", "ytd", "year to date"}:
        start_dt = datetime(now_dt.year, 1, 1, tzinfo=timezone.utc)
        start_ts = float(start_dt.timestamp())
        normalized = "This Year"
    elif label.lower() in {"custom range", "custom"}:
        # Best-effort: accept ISO dates for custom range; otherwise fall back to last 30.
        start_ts = float((now_dt - timedelta(days=30)).timestamp())
        normalized = "Custom Range"
        if start_date:
            try:
                sdt = datetime.fromisoformat(str(start_date).strip()).replace(tzinfo=timezone.utc)
                start_ts = float(sdt.timestamp())
            except Exception:
                pass
        if end_date:
            try:
                edt = datetime.fromisoformat(str(end_date).strip()).replace(tzinfo=timezone.utc)
                end_ts = float(edt.timestamp())
            except Exception:
                pass
    else:
        start_ts = float((now_dt - timedelta(days=30)).timestamp())
        normalized = "Last 30 Days"

    # Ensure ordering.
    if start_ts > end_ts:
        start_ts, end_ts = end_ts, start_ts
    return (start_ts, end_ts, normalized)


def _extract_state(value: Any) -> str:
    if isinstance(value, dict):
        state = str(value.get("state") or "").strip()
        if state:
            return state.upper()
        label = str(value.get("label") or value.get("name") or "").strip()
        value = label
    if not isinstance(value, str):
        return "Unknown"
    s = value.strip()
    if not s:
        return "Unknown"
    # Common pattern: "City, ST".
    if "," in s:
        tail = s.split(",")[-1].strip()
        if len(tail) in {2, 3}:
            return tail.upper()
    # Try last token.
    parts = [p for p in s.replace("/", " ").split() if p]
    if parts:
        tail = parts[-1].strip()
        if len(tail) == 2 and tail.isalpha():
            return tail.upper()
    return "Unknown"


def _load_total_rate(load: Dict[str, Any]) -> Optional[float]:
    # Prefer explicit totals.
    for key in ("amount_total", "total_rate", "total", "rate"):
        try:
            v = load.get(key)
            if v is not None:
                f = float(v)
                if f > 0:
                    return f
        except Exception:
            continue

    # Reconstruct best-effort from linehaul + fuel + advanced charges.
    try:
        linehaul = float(load.get("linehaul_rate") or 0.0)
        fuel = float(load.get("fuel_surcharge") or 0.0)
        adv = load.get("advanced_charges")
        adv_total = 0.0
        if isinstance(adv, list):
            for item in adv:
                if isinstance(item, dict):
                    adv_total += float(item.get("amount") or 0.0)
        total = linehaul + fuel + adv_total
        return total if total > 0 else None
    except Exception:
        return None


def _format_pct(value: Optional[float]) -> str:
    try:
        if value is None:
            return "0.0%"
        return f"{float(value):.1f}%"
    except Exception:
        return "0.0%"


 


def _normalize_role_filter(role: str) -> str:
    r = (role or 'all').strip().lower()
    if r in {'all', 'any', '*'}:
        return 'all'
    if r in {'shippers', 'shipper'}:
        return 'shipper'
    if r in {'brokers', 'broker'}:
        return 'broker'
    if r in {'shippers/brokers', 'shippers_brokers', 'shipper_broker', 'shipper-broker', 'shippers-brokers'}:
        return 'shipper_broker'
    if r in {'carriers', 'carrier'}:
        return 'carrier'
    if r in {'drivers', 'driver'}:
        return 'driver'
    if r in {'service_providers', 'service-provider', 'service-providers', 'service_provider', 'provider', 'providers'}:
        return 'service_provider'
    if r in {'admin', 'super_admin', 'superadmin'}:
        return 'super_admin' if r in {'superadmin'} else r
    return r


def _user_display_name(d: dict) -> str:
    return (
        d.get('name')
        or d.get('full_name')
        or d.get('company_name')
        or d.get('email')
        or d.get('uid')
        or ''
    )

def _to_epoch_seconds(value: Any) -> Optional[float]:
    if value is None:
        return None
    # Avoid bool being treated as int.
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        try:
            return float(s)
        except Exception:
            try:
                dt = datetime.fromisoformat(s.replace('Z', '+00:00'))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return float(dt.timestamp())
            except Exception:
                return None
    # Firestore returns DatetimeWithNanoseconds which subclasses datetime.
    if isinstance(value, datetime):
        dt = value
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return float(dt.timestamp())

    # Some Firestore timestamp types expose to_datetime().
    to_dt = getattr(value, 'to_datetime', None)
    if callable(to_dt):
        try:
            dt = to_dt()
            if isinstance(dt, datetime):
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return float(dt.timestamp())
        except Exception:
            pass

    # Some timestamp objects expose seconds/nanoseconds.
    seconds = getattr(value, 'seconds', None)
    nanos = getattr(value, 'nanoseconds', None)
    if isinstance(seconds, int):
        try:
            return float(seconds) + (float(nanos or 0) / 1e9)
        except Exception:
            return float(seconds)

    return None


def _format_digest_number(n: Any) -> str:
    try:
        return f"{int(n):,}"
    except Exception:
        return str(n)


def _admin_digest_snapshot(max_per_role_scan: int = 5000) -> dict:
    """Compute a lightweight system snapshot for admin email digests.

    This intentionally avoids composite indexes by using role== queries and in-Python aggregation.
    """

    def _agg_for_role(role_value: str) -> dict:
        total = 0
        active = 0
        pending = 0
        flagged = 0
        scanned = 0

        try:
            stream_iter = db.collection('users').where('role', '==', role_value).stream()
        except Exception:
            stream_iter = []

        for snap in stream_iter:
            scanned += 1
            if scanned > max_per_role_scan:
                break
            d = snap.to_dict() or {}
            total += 1
            is_locked = bool(d.get('is_locked', False))
            is_active = d.get('is_active', True) is not False
            is_verified = bool(d.get('is_verified', False))
            onboarding_completed = bool(d.get('onboarding_completed', False))

            if is_active and not is_locked:
                active += 1
            if (not onboarding_completed) or (not is_verified):
                pending += 1
            if (not is_active) or is_locked:
                flagged += 1

        return {
            'role': role_value,
            'total': int(total),
            'active': int(active),
            'pending': int(pending),
            'flagged': int(flagged),
            'scanned': int(scanned),
        }

    roles = ['driver', 'carrier', 'shipper', 'broker']
    by_role = {r: _agg_for_role(r) for r in roles}
    return {
        'generated_at': time.time(),
        'max_per_role_scan': int(max_per_role_scan),
        'roles': by_role,
        'totals': {
            'total': sum(by_role[r]['total'] for r in roles),
            'active': sum(by_role[r]['active'] for r in roles),
            'pending': sum(by_role[r]['pending'] for r in roles),
            'flagged': sum(by_role[r]['flagged'] for r in roles),
        },
    }


def _render_admin_digest_html(snapshot: dict, recipient_label: str) -> str:
    roles = snapshot.get('roles') or {}
    totals = snapshot.get('totals') or {}
    gen_ts = snapshot.get('generated_at')
    try:
        gen_str = datetime.fromtimestamp(float(gen_ts), tz=timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    except Exception:
        gen_str = 'Unknown'

    def row(role_key: str, label: str) -> str:
        d = roles.get(role_key) or {}
        return (
            f"<tr>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #e5e7eb'><strong>{label}</strong></td>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right'>{_format_digest_number(d.get('total', 0))}</td>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right'>{_format_digest_number(d.get('active', 0))}</td>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right'>{_format_digest_number(d.get('pending', 0))}</td>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right'>{_format_digest_number(d.get('flagged', 0))}</td>"
            f"</tr>"
        )

    return f"""
    <html>
      <body style="font-family: Arial, Helvetica, sans-serif; background:#f6f7fb; padding: 18px;">
        <div style="max-width: 760px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 14px; overflow:hidden;">
          <div style="padding: 16px 18px; background:#111827; color:#fff;">
            <div style="font-size: 16px; font-weight: 800;">FreightPower Admin Digest</div>
            <div style="font-size: 12px; opacity: 0.85; margin-top: 4px;">Generated: {gen_str}</div>
          </div>

          <div style="padding: 18px;">
            <p style="margin:0 0 12px 0; color:#111827;">Hi {recipient_label}, here’s your account digest summary.</p>

            <div style="display:flex; gap:12px; flex-wrap:wrap; margin: 10px 0 16px 0;">
              <div style="flex:1 1 160px; border:1px solid #e5e7eb; border-radius: 12px; padding: 12px;">
                <div style="font-size:12px;color:#6b7280;">Total Users</div>
                <div style="font-size:20px;font-weight:900;color:#111827;">{_format_digest_number(totals.get('total', 0))}</div>
              </div>
              <div style="flex:1 1 160px; border:1px solid #e5e7eb; border-radius: 12px; padding: 12px;">
                <div style="font-size:12px;color:#6b7280;">Active</div>
                <div style="font-size:20px;font-weight:900;color:#111827;">{_format_digest_number(totals.get('active', 0))}</div>
              </div>
              <div style="flex:1 1 160px; border:1px solid #e5e7eb; border-radius: 12px; padding: 12px;">
                <div style="font-size:12px;color:#6b7280;">Pending</div>
                <div style="font-size:20px;font-weight:900;color:#111827;">{_format_digest_number(totals.get('pending', 0))}</div>
              </div>
              <div style="flex:1 1 160px; border:1px solid #e5e7eb; border-radius: 12px; padding: 12px;">
                <div style="font-size:12px;color:#6b7280;">Flagged / Locked</div>
                <div style="font-size:20px;font-weight:900;color:#111827;">{_format_digest_number(totals.get('flagged', 0))}</div>
              </div>
            </div>

            <table style="width:100%; border-collapse: collapse; border:1px solid #e5e7eb; border-radius:12px; overflow:hidden;">
              <thead>
                <tr style="background:#f9fafb;">
                  <th style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:left;">Role</th>
                  <th style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">Total</th>
                  <th style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">Active</th>
                  <th style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">Pending</th>
                  <th style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">Flagged</th>
                </tr>
              </thead>
              <tbody>
                {row('driver','Drivers')}
                {row('carrier','Carriers')}
                {row('shipper','Shippers')}
                {row('broker','Brokers')}
              </tbody>
            </table>

            <p style="margin: 14px 0 0 0; font-size: 12px; color: #6b7280;">You can disable these emails in Admin → System Settings.</p>
          </div>
        </div>
      </body>
    </html>
    """


def _send_email_digest_to_user(user_doc_id: str, user_data: dict, snapshot: dict, reason: str) -> Tuple[bool, str]:
    email = (user_data.get('email') or '').strip()
    if not email:
        return False, 'Missing email'
    if user_data.get('email_digest_enabled', True) is False:
        return False, 'Email digest disabled'

    now = time.time()
    last_sent = _to_epoch_seconds(user_data.get('last_email_digest_sent_at'))
    # Throttle to roughly once per day.
    if last_sent and (now - float(last_sent) < 23.0 * 3600.0) and reason != 'manual_test':
        return False, 'Recently sent'

    name = user_data.get('name') or user_data.get('display_name') or email.split('@')[0]
    smtp_configured = bool(getattr(settings, 'SMTP_USERNAME', '') and getattr(settings, 'SMTP_PASSWORD', ''))
    subject = f"FreightPower Admin Digest • {datetime.fromtimestamp(now, tz=timezone.utc).strftime('%Y-%m-%d')}"
    html = _render_admin_digest_html(snapshot, recipient_label=str(name))
    ok = send_email(to_email=email, subject=subject, body=html, is_html=True)
    if ok:
        status_value = 'sent' if smtp_configured else 'logged'
        try:
            db.collection('users').document(user_doc_id).set({
                'last_email_digest_sent_at': now,
                'last_email_digest_status': status_value,
                'last_email_digest_error': None,
            }, merge=True)
        except Exception:
            pass
        try:
            log_action(user_doc_id, 'EMAIL_DIGEST_SENT', f"Email digest sent ({reason})")
        except Exception:
            pass
        return True, status_value
    else:
        try:
            db.collection('users').document(user_doc_id).set({
                'last_email_digest_status': 'failed',
                'last_email_digest_error': 'send_email returned False',
            }, merge=True)
        except Exception:
            pass
        return False, 'send_failed'


def _send_admin_email_digest_job():
    """Scheduled job: sends digest emails to admins who enabled them."""
    try:
        snapshot = _admin_digest_snapshot(max_per_role_scan=5000)
    except Exception as e:
        print(f"[EmailDigest] Failed to compute snapshot: {e}")
        return

    # Avoid composite indexes: query admins and super_admins separately.
    candidates: List[Tuple[str, dict]] = []
    try:
        for role_value in ['admin', 'super_admin']:
            for snap in db.collection('users').where('role', '==', role_value).stream():
                d = snap.to_dict() or {}
                if d.get('email_digest_enabled', True) is False:
                    continue
                candidates.append((snap.id, d))
    except Exception as e:
        print(f"[EmailDigest] Failed to list admin users: {e}")
        return

    sent = 0
    skipped = 0
    for uid, d in candidates:
        ok, reason = _send_email_digest_to_user(uid, d, snapshot, reason='scheduled')
        if ok:
            sent += 1
        else:
            skipped += 1
    print(f"[EmailDigest] Scheduled run complete sent={sent} skipped={skipped}")


def _project_user(doc_id: str, d: dict) -> dict:
    # Return only safe, UI-relevant fields.
    return {
        'id': doc_id,
        'uid': d.get('uid') or doc_id,
        'name': d.get('name') or d.get('full_name') or None,
        'display_name': _user_display_name(d) or doc_id,
        'email': d.get('email'),
        'role': d.get('role'),
        'company_name': d.get('company_name'),
        'mc_number': d.get('mc_number'),
        'dot_number': d.get('dot_number'),
        'cdl_number': d.get('cdl_number'),
        'license_number': d.get('license_number'),
        'phone': d.get('phone'),
        'photo_url': d.get('photo_url'),
        'is_active': d.get('is_active', True) is not False,
        'is_locked': bool(d.get('is_locked', False)),
        'is_verified': bool(d.get('is_verified', False)),
        'onboarding_completed': bool(d.get('onboarding_completed', False)),
        'last_login_at': _to_epoch_seconds(d.get('last_login_at')),
        'updated_at': _to_epoch_seconds(d.get('updated_at')),
        'created_at': _to_epoch_seconds(d.get('created_at')),
        'gps_lat': d.get('gps_lat'),
        'gps_lng': d.get('gps_lng'),
    }


# ResponseStore is used by RAG, onboarding chatbot, and several helper flows.
store = ResponseStore(base_dir=str(Path(__file__).resolve().parents[2] / "data"))

# FMCSA client is lazily created in _get_fmcsa_client().
fmcsa_client: "FmcsaClient | None" = None


# --- FastAPI App ---

app = FastAPI(title="FreightPower API")

# Make the ResponseStore available to routers via request.app.state.store
app.state.store = store

app.add_middleware(
    CORSMiddleware,
    # Explicit origins are required when using credentials (Authorization cookies/headers).
    # FRONTEND_BASE_URL is configurable via apps/.env.
    allow_origins=list({
        str(getattr(settings, 'FRONTEND_BASE_URL', '') or '').rstrip('/'),
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
    } - {''}),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Scheduler is started/stopped via app events near the end of the file.
scheduler = SchedulerWrapper()


# --- Admin dashboard metrics cache (best-effort, process-local) ---
_ADMIN_METRICS_CACHE: Dict[str, Any] = {"expires_at": 0.0, "value": None}


def _iso_week_key(ts: float) -> str:
    dt = datetime.fromtimestamp(float(ts), tz=timezone.utc)
    iso_year, iso_week, _ = dt.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def _prev_week_key(ts: float) -> str:
    # ISO weeks are stable if we subtract 7 days and recompute.
    return _iso_week_key(float(ts) - 7.0 * 86400.0)

class LoadRequest(BaseModel):
    id: str
    origin: Optional[str] = None
    origin_state: Optional[str] = None
    destination: Optional[str] = None
    destination_state: Optional[str] = None
    equipment: Optional[str] = None
    weight: Optional[float] = None
    metadata: Dict[str, Any] = {}

class CarrierRequest(BaseModel):
    id: str
    name: Optional[str] = None
    equipment: Optional[List[str]] = None
    equipment_types: Optional[List[str]] = None
    lanes: Optional[List[Dict[str, Any]]] = None
    compliance_score: Optional[float] = None
    fmcsa_verification: Optional[Dict[str, Any]] = None
    metadata: Dict[str, Any] = {}

class MatchRequest(BaseModel):
    load: LoadRequest
    carriers: List[CarrierRequest]
    top_n: int = 5
    min_compliance: Optional[float] = None
    require_fmcsa: bool = False

class LoadCreateRequest(LoadRequest):
    pass

class CarrierCreateRequest(CarrierRequest):
    pass

class AssignmentRequest(BaseModel):
    load_id: str
    carrier_id: str
    reason: Optional[str] = None

class AlertRequest(BaseModel):
    type: str
    message: str
    priority: Optional[str] = "routine"
    entity_id: Optional[str] = None

class ReportFraudRequest(BaseModel):
    subject: Optional[str] = None
    message: str
    user_email: Optional[str] = None
    user_name: Optional[str] = None

class SuggestEditRequest(BaseModel):
    subject: Optional[str] = None
    message: str
    user_email: Optional[str] = None
    user_name: Optional[str] = None


# --- Chat & FMCSA Request Models (used by endpoints below) ---

class ChatRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=4000)
    max_context_chars: int = Field(default=6000, ge=500, le=20000)


class InteractiveChatRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=120)
    message: str = Field(..., min_length=1, max_length=4000)
    attached_document_id: Optional[str] = None


class FmcsaVerifyRequest(BaseModel):
    usdot: Optional[str] = None
    mc_number: Optional[str] = None


# --- Admin User Actions Models ---

class AdminUserRemovalRequest(BaseModel):
    reason: str = Field(..., min_length=3, max_length=400)
    grace_days: int = Field(default=0, ge=0, le=365)
    message_to_user: str = Field(default='', max_length=2000)


class AdminUserWarningRequest(BaseModel):
    warning: str = Field(..., min_length=3, max_length=2000)
    subject: Optional[str] = Field(default=None, max_length=120)


class SuperAdminDecisionRequest(BaseModel):
    decision_note: Optional[str] = Field(default=None, max_length=800)


# --- Core Endpoints ---

@app.get("/health")
def health():
    return {"status": "ok"}


# --- Friendly redirects to SPA routes ---
# Dashboards are frontend routes. These redirects help when someone hits the API
# server URL directly (e.g., http://localhost:8000/super-admin/dashboard).
@app.get("/admin/dashboard")
def redirect_admin_dashboard():
    return RedirectResponse(url=f"{settings.FRONTEND_BASE_URL}/admin/dashboard", status_code=302)


@app.get("/super-admin/dashboard")
def redirect_super_admin_dashboard():
    return RedirectResponse(url=f"{settings.FRONTEND_BASE_URL}/super-admin/dashboard", status_code=302)


@app.get("/admin/login")
def redirect_admin_login():
    return RedirectResponse(url=f"{settings.FRONTEND_BASE_URL}/admin/login", status_code=302)


@app.get("/super-admin/login")
def redirect_super_admin_login():
    return RedirectResponse(url=f"{settings.FRONTEND_BASE_URL}/super-admin/login", status_code=302)


@app.get("/admin/dashboard/metrics")
async def admin_dashboard_metrics(user: dict = Depends(require_admin)):
    """Admin-only: lightweight dashboard metrics.

    Notes:
    - Uses a short process-local cache to avoid repeated scans in dev.
    - Compliance is currently defined as `onboarding_completed == True` for non-admin users.
    - WoW delta uses a per-ISO-week Firestore doc (no composite index required).
    """

    now = time.time()
    cached = _ADMIN_METRICS_CACHE.get("value")
    if cached and float(_ADMIN_METRICS_CACHE.get("expires_at") or 0.0) > now:
        return cached

    # Core counts (best-effort; avoid heavy scans in large datasets).
    active_carriers = 0
    active_drivers = 0
    pending_onboardings = 0
    pending_documents = 0

    total_non_admin_users = 0
    compliant_users = 0

    # Keep the scan bounded to prevent accidental timeouts on very large datasets.
    max_users_to_scan = 2500
    scanned = 0

    # Import here to avoid circular import issues.
    from .onboarding import calculate_document_status

    try:
        for snap in db.collection("users").stream():
            scanned += 1
            if scanned > max_users_to_scan:
                break

            u = snap.to_dict() or {}
            role = str(u.get("role") or "").lower()
            if role in {"admin", "super_admin"}:
                continue

            is_active = u.get("is_active", True) is not False

            if role == "carrier" and is_active:
                active_carriers += 1
            if role == "driver" and is_active:
                active_drivers += 1

            total_non_admin_users += 1
            if bool(u.get("onboarding_completed", False)):
                compliant_users += 1
            else:
                # Pending onboarding: only count common marketplace roles.
                if is_active and role in {"carrier", "driver", "shipper", "broker"}:
                    pending_onboardings += 1

            # Pending documents: parse onboarding_data JSON (best-effort).
            onboarding_data_str = u.get("onboarding_data")
            if onboarding_data_str:
                try:
                    onboarding_data = (
                        json.loads(onboarding_data_str)
                        if isinstance(onboarding_data_str, str)
                        else onboarding_data_str
                    )
                    raw_docs = onboarding_data.get("documents", []) if isinstance(onboarding_data, dict) else []
                    for doc in raw_docs:
                        expiry_date = (doc.get("extracted_fields") or {}).get("expiry_date")
                        status = calculate_document_status(expiry_date) if expiry_date else "Unknown"
                        if status != "Valid":
                            pending_documents += 1
                except Exception:
                    # Ignore malformed onboarding_data.
                    pass
    except Exception as e:
        print(f"[AdminMetrics] Failed to scan users: {e}")

    compliance_rate_percent = (
        (float(compliant_users) / float(total_non_admin_users) * 100.0)
        if total_non_admin_users
        else 0.0
    )

    # Support tickets: pending support requests.
    support_tickets = 0
    try:
        for _ in db.collection("support_requests").where("status", "==", "pending").stream():
            support_tickets += 1
            if support_tickets >= 10000:
                break
    except Exception:
        support_tickets = 0

    # Week-over-week compliance delta using a simple per-week doc.
    week_key = _iso_week_key(now)
    prev_week_key = _prev_week_key(now)
    prev_rate: Optional[float] = None
    try:
        coll = db.collection("admin_dashboard_weekly_metrics")
        coll.document(week_key).set(
            {
                "week_key": week_key,
                "computed_at": now,
                "compliance_rate_percent": compliance_rate_percent,
            },
            merge=True,
        )
        prev = coll.document(prev_week_key).get()
        if prev.exists:
            prev_rate = float((prev.to_dict() or {}).get("compliance_rate_percent") or 0.0)
    except Exception as e:
        print(f"[AdminMetrics] Weekly metrics read/write failed: {e}")

    compliance_delta_percent = float(compliance_rate_percent - (prev_rate or 0.0)) if prev_rate is not None else 0.0

    payload = {
        "computed_at": now,
        "pending_documents": int(pending_documents),
        "active_carriers": int(active_carriers),
        "active_drivers": int(active_drivers),
        "pending_onboardings": int(pending_onboardings),
        "support_tickets": int(support_tickets),
        "compliance_rate_percent": float(compliance_rate_percent),
        "compliance_delta_percent": float(compliance_delta_percent),
    }

    _ADMIN_METRICS_CACHE["value"] = payload
    _ADMIN_METRICS_CACHE["expires_at"] = now + 20.0
    return payload


def _pct_clamped(value: float) -> int:
    try:
        return max(0, min(100, int(round(float(value)))))
    except Exception:
        return 0


def _relative_label_from_epoch(ts_value: Any) -> str:
    try:
        ts = float(ts_value or 0.0)
    except Exception:
        ts = 0.0
    if ts <= 0:
        return "not yet"
    delta = max(0.0, time.time() - ts)
    if delta < 60:
        return "just now"
    mins = int(delta // 60)
    if mins < 60:
        return f"{mins}m ago"
    hrs = int(mins // 60)
    if hrs < 24:
        return f"{hrs}h ago"
    days = int(hrs // 24)
    return f"{days}d ago"


def _admin_ai_insights_payload(metrics: Dict[str, Any]) -> Dict[str, Any]:
    pending_documents = int(metrics.get("pending_documents") or 0)
    pending_onboardings = int(metrics.get("pending_onboardings") or 0)
    support_tickets = int(metrics.get("support_tickets") or 0)
    compliance_rate = float(metrics.get("compliance_rate_percent") or 0.0)
    compliance_delta = float(metrics.get("compliance_delta_percent") or 0.0)
    active_carriers = int(metrics.get("active_carriers") or 0)
    active_drivers = int(metrics.get("active_drivers") or 0)

    issue_penalty = min(35.0, pending_documents * 0.4 + support_tickets * 0.8 + pending_onboardings * 0.2)
    trend_boost = max(-5.0, min(5.0, compliance_delta))
    overall_efficiency = _pct_clamped(compliance_rate - issue_penalty + trend_boost)

    summary = (
        f"System efficiency is {overall_efficiency}%. "
        f"Active carriers: {active_carriers}, active drivers: {active_drivers}, "
        f"pending documents: {pending_documents}, support tickets: {support_tickets}."
    )

    insights: List[Dict[str, Any]] = []
    if pending_documents > 0:
        insights.append(
            {
                "id": "admin_docs_backlog",
                "title": "Document Backlog",
                "detail": f"{pending_documents} document(s) need review or renewal.",
                "priority": "high" if pending_documents >= 10 else "medium",
                "action_label": "Open Compliance Queue",
                "action_target": "compliance",
            }
        )
    if pending_onboardings > 0:
        insights.append(
            {
                "id": "admin_onboarding_backlog",
                "title": "Onboarding Queue",
                "detail": f"{pending_onboardings} onboarding profile(s) remain incomplete.",
                "priority": "medium",
                "action_label": "Open User Management",
                "action_target": "management",
            }
        )
    if support_tickets > 0:
        insights.append(
            {
                "id": "admin_support_attention",
                "title": "Support Attention",
                "detail": f"{support_tickets} pending support ticket(s) are waiting for resolution.",
                "priority": "medium" if support_tickets < 8 else "high",
                "action_label": "Open Support",
                "action_target": "support",
            }
        )
    if not insights:
        insights.append(
            {
                "id": "admin_stable",
                "title": "Stable Operations",
                "detail": "No major AI or compliance escalations detected in the current window.",
                "priority": "low",
                "action_label": "Open Tracking",
                "action_target": "tracking",
            }
        )

    return {
        "overall_efficiency_percent": overall_efficiency,
        "summary": summary,
        "ai_insights": insights[:3],
        "compliance_rate_percent": compliance_rate,
        "compliance_delta_percent": compliance_delta,
    }


@app.get("/admin/dashboard/ai-insights")
async def admin_dashboard_ai_insights(user: Dict[str, Any] = Depends(require_admin)):
    metrics = await admin_dashboard_metrics(user)
    built = _admin_ai_insights_payload(metrics if isinstance(metrics, dict) else {})
    return {
        "generated_at": time.time(),
        "source": "rules",
        "summary": built.get("summary"),
        "overall_efficiency_percent": built.get("overall_efficiency_percent"),
        "compliance_rate_percent": built.get("compliance_rate_percent"),
        "compliance_delta_percent": built.get("compliance_delta_percent"),
        "ai_insights": built.get("ai_insights") or [],
        "metrics": metrics,
    }


@app.get("/super-admin/ai-hub/telemetry")
async def super_admin_ai_hub_telemetry(user: Dict[str, Any] = Depends(require_super_admin)):
    metrics = await admin_dashboard_metrics(user)
    metrics = metrics if isinstance(metrics, dict) else {}

    ai_rules_count = int(_DRIVER_INSIGHTS_METRICS.get("rules_count") or 0)
    ai_llm_count = int(_DRIVER_INSIGHTS_METRICS.get("llm_count") or 0)
    ai_errors_count = int(_DRIVER_INSIGHTS_METRICS.get("errors_count") or 0)
    ai_last_generated = _DRIVER_INSIGHTS_METRICS.get("last_generated_at")
    ai_last_label = _relative_label_from_epoch(ai_last_generated)

    llm_configured = bool(getattr(settings, "GROQ_API_KEY", ""))
    fmcsa_configured = bool(getattr(settings, "FMCSA_WEB_KEY", "")) and bool(getattr(settings, "FMCSA_BASE_URL", ""))
    maps_configured = bool(getattr(settings, "HERE_API_KEY_BACKEND", ""))
    smtp_configured = bool(getattr(settings, "SMTP_USERNAME", "")) and bool(getattr(settings, "SMTP_PASSWORD", ""))
    calendar_configured = bool(getattr(settings, "GOOGLE_CALENDAR_CLIENT_ID", "")) or bool(
        getattr(settings, "MICROSOFT_CLIENT_ID", "")
    )
    alert_webhook_configured = bool(getattr(settings, "ALERT_WEBHOOK_URL", ""))

    integrations: List[Dict[str, Any]] = [
        {
            "name": "Groq LLM",
            "type": "AI",
            "module": "Role Assistant",
            "status": "Active" if llm_configured else "Warning",
            "last": ai_last_label,
        },
        {
            "name": "FMCSA API",
            "type": "Compliance",
            "module": "Carrier Verification",
            "status": "Active" if fmcsa_configured else "Warning",
            "last": "configured" if fmcsa_configured else "not configured",
        },
        {
            "name": "HERE Maps",
            "type": "Tracking",
            "module": "Fleet Visibility",
            "status": "Active" if maps_configured else "Warning",
            "last": "configured" if maps_configured else "not configured",
        },
        {
            "name": "SMTP Email",
            "type": "Messaging",
            "module": "Notifications",
            "status": "Active" if smtp_configured else "Offline",
            "last": "configured" if smtp_configured else "not configured",
        },
        {
            "name": "Calendar OAuth",
            "type": "Scheduling",
            "module": "Calendar Sync",
            "status": "Active" if calendar_configured else "Warning",
            "last": "configured" if calendar_configured else "not configured",
        },
        {
            "name": "Alert Webhook",
            "type": "Ops",
            "module": "System Alerts",
            "status": "Active" if alert_webhook_configured else "Warning",
            "last": "configured" if alert_webhook_configured else "not configured",
        },
    ]

    active_integrations = len([x for x in integrations if str(x.get("status")) == "Active"])
    warnings = len([x for x in integrations if str(x.get("status")) == "Warning"])
    offline = len([x for x in integrations if str(x.get("status")) == "Offline"])

    agents: List[Dict[str, Any]] = [
        {
            "name": "Role Assistant",
            "module": "Seller & Shipper Chat",
            "status": "Active" if llm_configured else "Warning",
            "updated": ai_last_label,
        },
        {
            "name": "Driver Insights Engine",
            "module": "Driver Dashboard",
            "status": "Active",
            "updated": ai_last_label,
        },
        {
            "name": "Shipper Insights Engine",
            "module": "Shipper Dashboard",
            "status": "Active",
            "updated": ai_last_label,
        },
        {
            "name": "Admin Insight Engine",
            "module": "Analytics",
            "status": "Active",
            "updated": _relative_label_from_epoch(time.time()),
        },
    ]

    ai_chats = ai_rules_count + ai_llm_count
    automations_today = int(metrics.get("pending_documents") or 0) + int(metrics.get("pending_onboardings") or 0)
    issues_detected = ai_errors_count + warnings + offline

    error_percent = _pct_clamped((float(ai_errors_count) / float(max(1, ai_chats + ai_errors_count))) * 100.0)
    lag_percent = _pct_clamped(min(35.0, float(metrics.get("pending_onboardings") or 0) * 1.2))
    live_percent = _pct_clamped(100.0 - error_percent - (lag_percent * 0.6))

    alerts: List[str] = []
    if ai_errors_count > 0:
        alerts.append(f"{ai_errors_count} AI generation error(s) observed in recent dashboard runs.")
    if warnings > 0:
        alerts.append(f"{warnings} integration warning(s) need verification.")
    if offline > 0:
        alerts.append(f"{offline} integration(s) are offline and need reconnection.")
    support_tickets = int(metrics.get("support_tickets") or 0)
    if support_tickets > 0:
        alerts.append(f"{support_tickets} pending support ticket(s) are waiting for admin action.")
    if not alerts:
        alerts.append("No critical AI telemetry alerts right now.")

    assistant_summary = (
        f"{issues_detected} issue signal(s) detected. "
        f"AI chats processed: {ai_chats}. "
        f"Compliance rate: {float(metrics.get('compliance_rate_percent') or 0.0):.1f}%."
    )

    return {
        "generated_at": time.time(),
        "source": "rules",
        "stats": {
            "active_ai_agents": len([a for a in agents if str(a.get("status")) == "Active"]),
            "automations_today": automations_today,
            "ai_chats": ai_chats,
            "issues_detected": issues_detected,
            "connected_integrations": active_integrations,
            "total_integrations": len(integrations),
            "warnings": warnings,
            "offline": offline,
            "expiring_keys": 0,
        },
        "agents": agents,
        "integrations": integrations,
        "assistant": {
            "summary": assistant_summary,
            "action_label": "Run Health Check",
            "action_target": "integrations",
        },
        "health": {
            "live_percent": live_percent,
            "lag_percent": lag_percent,
            "error_percent": error_percent,
        },
        "alerts": alerts[:4],
    }


@app.get('/admin/management/users')
async def admin_management_users(
    role: str = 'all',
    limit: int = 250,
    user: dict = Depends(require_admin),
):
    """Admin-only: list users for dashboard Management tabs.

    This endpoint exists because Firestore client rules often deny cross-tenant reads.
    It uses the Firebase Admin SDK (server-side) and returns a bounded, UI-friendly list.
    """

    role_norm = _normalize_role_filter(role)
    max_limit = max(1, min(int(limit or 250), 2000))

    # Scan bounded set; avoid requiring composite indexes.
    items: list[dict] = []
    scanned = 0
    max_scan = max_limit * 20

    def _matches(d: dict) -> bool:
        r = str(d.get('role') or '').lower()
        if role_norm == 'all':
            return True
        if role_norm == 'shipper_broker':
            return r in {'shipper', 'broker'}
        return r == role_norm

    try:
        # Fast path for single-role queries.
        base = db.collection('users')
        stream_iter = None
        if role_norm not in {'all', 'shipper_broker'}:
            stream_iter = base.where('role', '==', role_norm).stream()
        else:
            # Attempt Firestore 'in' query first for shipper/broker.
            if role_norm == 'shipper_broker':
                try:
                    stream_iter = base.where('role', 'in', ['shipper', 'broker']).stream()
                except Exception:
                    stream_iter = None
            if stream_iter is None:
                stream_iter = base.stream()

        for snap in stream_iter:
            scanned += 1
            if scanned > max_scan:
                break
            d = snap.to_dict() or {}
            if not _matches(d):
                continue
            items.append(_project_user(snap.id, d))
            if len(items) >= max_limit:
                break

    except Exception as e:
        print(f"[AdminManagement] Failed to list users: {e}")
        raise HTTPException(status_code=500, detail='Failed to load users')

    def _sort_key(it: dict) -> float:
        return float(
            _to_epoch_seconds(it.get('updated_at'))
            or _to_epoch_seconds(it.get('last_login_at'))
            or _to_epoch_seconds(it.get('created_at'))
            or 0.0
        )

    items.sort(key=_sort_key, reverse=True)

    active = sum(1 for u in items if u.get('is_active') and not u.get('is_locked'))
    pending = sum(1 for u in items if not u.get('onboarding_completed') or not u.get('is_verified'))
    flagged = sum(1 for u in items if (not u.get('is_active')) or u.get('is_locked'))

    return {
        'items': items,
        'count': len(items),
        'scanned': scanned,
        'role': role_norm,
        'metrics': {
            'active': int(active),
            'pending': int(pending),
            'flagged': int(flagged),
            'total': int(len(items)),
        },
        'computed_at': time.time(),
    }


@app.get('/admin/email-digest/preview')
async def admin_email_digest_preview(
    user: dict = Depends(require_admin),
):
    """Admin-only: preview the current digest snapshot."""
    return {
        'smtp_configured': bool(getattr(settings, 'SMTP_USERNAME', '')),
        'snapshot': _admin_digest_snapshot(max_per_role_scan=5000),
    }


@app.post('/admin/email-digest/send-test')
async def admin_email_digest_send_test(
    user: dict = Depends(require_admin),
):
    """Admin-only: send a test digest email to the signed-in admin."""
    if user.get('email_digest_enabled', True) is False:
        raise HTTPException(status_code=400, detail='Enable Email Digest Summary in System Settings first')
    snapshot = _admin_digest_snapshot(max_per_role_scan=5000)
    uid = user.get('uid') or user.get('id') or ''
    ok, reason = _send_email_digest_to_user(uid, user, snapshot, reason='manual_test')
    if not ok:
        raise HTTPException(status_code=500, detail=f'Failed to send digest: {reason}')
    msg = 'Digest email sent' if reason == 'sent' else 'SMTP not configured; digest was logged in server console'
    return {'success': True, 'message': msg, 'generated_at': snapshot.get('generated_at')}


@app.get("/admin/tracking/locations")
async def admin_tracking_locations(
    role: str = "all",
    limit: int = 1000,
    user: dict = Depends(require_admin),
):
    """Admin-only: fetch GPS locations for users.

    Uses `users.gps_lat` and `users.gps_lng` when available.
    """

    def _role_set(r: str) -> set[str]:
        rr = (r or "all").strip().lower()
        if rr in {"all", "any"}:
            return {"carrier", "driver", "shipper", "broker"}
        if rr in {"carrier", "carriers"}:
            return {"carrier"}
        if rr in {"driver", "drivers"}:
            return {"driver"}
        if rr in {"shipper", "shippers", "broker", "brokers", "shipper_broker", "shippers_brokers"}:
            return {"shipper", "broker"}
        return set()

    roles = _role_set(role)
    if not roles and (role or "").strip().lower() not in {"providers", "service_providers"}:
        raise HTTPException(status_code=400, detail="Invalid role filter")

    max_limit = max(1, min(int(limit or 1000), 5000))
    items: list[dict] = []
    scanned = 0
    skipped_no_gps = 0

    try:
        # Prefer role query when we have a single role (fast path).
        base = db.collection("users")
        if len(roles) == 1:
            (only_role,) = tuple(roles)
            stream_iter = base.where("role", "==", only_role).stream()
        else:
            stream_iter = base.stream()

        for snap in stream_iter:
            scanned += 1
            if len(items) >= max_limit:
                break

            d = snap.to_dict() or {}
            urole = str(d.get("role") or "").lower()
            if urole in {"admin", "super_admin"}:
                continue
            if roles and urole not in roles:
                continue
            if d.get("is_active", True) is False:
                continue

            lat = d.get("gps_lat")
            lng = d.get("gps_lng")
            try:
                lat_f = float(lat) if lat is not None else None
                lng_f = float(lng) if lng is not None else None
            except Exception:
                lat_f = None
                lng_f = None

            if lat_f is None or lng_f is None:
                skipped_no_gps += 1
                continue

            items.append(
                {
                    "uid": snap.id,
                    "role": urole,
                    "name": d.get("name") or d.get("full_name") or d.get("company_name") or d.get("email"),
                    "email": d.get("email"),
                    "company_name": d.get("company_name"),
                    "gps_lat": lat_f,
                    "gps_lng": lng_f,
                    "updated_at": d.get("updated_at"),
                }
            )
    except Exception as e:
        print(f"[AdminTracking] Failed to fetch locations: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch tracking locations")

    return {
        "items": items,
        "count": len(items),
        "scanned": scanned,
        "skipped_no_gps": skipped_no_gps,
    }


@app.get("/tracking/loads/locations")
async def tracking_load_locations(
    active_only: bool = True,
    limit: int = 200,
    load_id: Optional[str] = None,
    user: Dict[str, Any] = Depends(get_current_user),
):
    """Shipper/Broker tracking: GPS locations for the signed-in user's loads.

    Data source:
    - Loads are read from Firestore (same ownership rule as GET /loads for shippers): created_by == uid
    - Location is read from the assigned driver's user profile: users.gps_lat / users.gps_lng

    Notes:
    - This endpoint is intentionally scoped: shippers/brokers can only see their own loads.
    - Returns only loads that have an assigned driver AND valid GPS coordinates.
    """

    uid = user.get("uid")
    role = str(user.get("role") or "").strip().lower()
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")
    if role not in {"shipper", "broker", "admin", "super_admin"}:
        raise HTTPException(status_code=403, detail="Forbidden")

    max_limit = max(1, min(int(limit or 200), 1000))
    requested_load_id = str(load_id or "").strip()
    # Shipper tracking map is intentionally limited to IN_TRANSIT loads.
    active_statuses = {LoadStatus.IN_TRANSIT.value}

    def _pick_name(d: Dict[str, Any] | None) -> Optional[str]:
        d = d or {}
        for key in (
            "company_name",
            "business_name",
            "legal_name",
            "carrier_name",
            "display_name",
            "name",
            "full_name",
            "email",
        ):
            val = d.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        return None

    def _carrier_name_from_load(load_dict: Dict[str, Any], carrier_uid: Optional[str]) -> Optional[str]:
        name = load_dict.get("assigned_carrier_name") or load_dict.get("carrier_name")
        if isinstance(name, str) and name.strip():
            return name.strip()

        offers = load_dict.get("offers")
        if isinstance(offers, list):
            for offer in offers:
                if not isinstance(offer, dict):
                    continue
                if str(offer.get("status") or "").strip().lower() == "accepted":
                    oname = offer.get("carrier_name")
                    if isinstance(oname, str) and oname.strip():
                        return oname.strip()
            if carrier_uid:
                for offer in offers:
                    if not isinstance(offer, dict):
                        continue
                    if str(offer.get("carrier_id") or "").strip() == str(carrier_uid).strip():
                        oname = offer.get("carrier_name")
                        if isinstance(oname, str) and oname.strip():
                            return oname.strip()

        return None

    # Phase 1: gather candidate loads + driver uids
    load_candidates: list[dict] = []
    driver_uids: set[str] = set()
    carrier_uids: set[str] = set()
    scanned = 0
    skipped_no_driver = 0
    try:
        loads_ref = db.collection("loads")

        def _consider_load_snap(snap: Any) -> None:
            nonlocal skipped_no_driver
            d = snap.to_dict() or {}
            lid = str(snap.id or "").strip()
            if not lid:
                return

            # Shippers/brokers are scoped to their own loads.
            if role in {"shipper", "broker"} and str(d.get("created_by") or "").strip() != uid:
                return

            status = str(d.get("status") or "").strip().lower()
            if active_only and status not in active_statuses:
                return

            driver_uid = d.get("assigned_driver") or d.get("assigned_driver_id")
            if not driver_uid:
                skipped_no_driver += 1
                return
            driver_uid = str(driver_uid).strip()
            if not driver_uid:
                skipped_no_driver += 1
                return

            driver_uids.add(driver_uid)

            carrier_uid = d.get("assigned_carrier") or d.get("assigned_carrier_id") or d.get("carrier_id")
            carrier_uid = str(carrier_uid).strip() if carrier_uid is not None else None
            if carrier_uid:
                carrier_uids.add(carrier_uid)

            load_candidates.append(
                {
                    "load_id": lid,
                    "status": status,
                    "driver_uid": driver_uid,
                    "driver_name": d.get("assigned_driver_name") or d.get("driver_name"),
                    "carrier_uid": carrier_uid,
                    "carrier_name": _carrier_name_from_load(d, carrier_uid),
                    "updated_at": d.get("updated_at"),
                }
            )

        # Fast path: when the UI is focused on a single load, avoid scanning the whole collection.
        if requested_load_id:
            snap = loads_ref.document(requested_load_id).get()
            scanned += 1
            if snap and getattr(snap, "exists", False):
                _consider_load_snap(snap)
        else:
            query = loads_ref
            # Shippers/brokers: strict ownership, consistent with GET /loads
            if role in {"shipper", "broker"}:
                query = query.where("created_by", "==", uid)

            # Keep scans bounded and predictable to prevent expensive fan-out in polling loops.
            scan_limit = min(max_limit * 3, 900)
            query = query.limit(scan_limit)

            for snap in query.stream():
                scanned += 1
                if len(load_candidates) >= scan_limit:
                    break
                _consider_load_snap(snap)
    except Exception as e:
        print(f"[TrackingLoadLocations] Failed to fetch loads: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch load locations")

    # Phase 2: batch fetch driver GPS profiles
    gps_by_driver: dict[str, dict] = {}
    driver_name_by_uid: dict[str, str] = {}
    if driver_uids:
        try:
            refs = [db.collection("users").document(did) for did in sorted(driver_uids)]
            for snap in db.get_all(refs):
                if not snap or not getattr(snap, "exists", False):
                    continue
                u = snap.to_dict() or {}
                dname = _pick_name(u)
                if dname:
                    driver_name_by_uid[snap.id] = dname
                lat = u.get("gps_lat")
                lng = u.get("gps_lng")
                try:
                    lat_f = float(lat) if lat is not None else None
                    lng_f = float(lng) if lng is not None else None
                except Exception:
                    lat_f = None
                    lng_f = None
                if lat_f is None or lng_f is None:
                    continue
                gps_by_driver[snap.id] = {
                    "gps_lat": lat_f,
                    "gps_lng": lng_f,
                    "gps_updated_at": u.get("updated_at"),
                }
        except Exception as e:
            print(f"[TrackingLoadLocations] Failed to fetch driver GPS: {e}")

    # Phase 2b: batch fetch carrier profiles (prefer carriers collection, fallback to users)
    carrier_name_by_uid: dict[str, str] = {}
    if carrier_uids:
        try:
            carrier_refs = [db.collection("carriers").document(cid) for cid in sorted(carrier_uids)]
            for snap in db.get_all(carrier_refs):
                if not snap or not getattr(snap, "exists", False):
                    continue
                c = snap.to_dict() or {}
                cname = _pick_name(c)
                if cname:
                    carrier_name_by_uid[snap.id] = cname
        except Exception as e:
            print(f"[TrackingLoadLocations] Failed to fetch carrier profiles: {e}")

        missing = [cid for cid in carrier_uids if cid not in carrier_name_by_uid]
        if missing:
            try:
                user_refs = [db.collection("users").document(cid) for cid in sorted(missing)]
                for snap in db.get_all(user_refs):
                    if not snap or not getattr(snap, "exists", False):
                        continue
                    u = snap.to_dict() or {}
                    cname = _pick_name(u)
                    if cname:
                        carrier_name_by_uid[snap.id] = cname
            except Exception as e:
                print(f"[TrackingLoadLocations] Failed to fetch carrier user profiles: {e}")

    # Phase 3: join + emit
    items: list[dict] = []
    skipped_no_gps = 0
    for c in load_candidates:
        gps = gps_by_driver.get(str(c.get("driver_uid") or ""))
        if not gps:
            skipped_no_gps += 1
            continue
        payload = dict(c)
        if not payload.get("driver_name"):
            payload["driver_name"] = driver_name_by_uid.get(str(payload.get("driver_uid") or ""))
        if not payload.get("carrier_name"):
            payload["carrier_name"] = carrier_name_by_uid.get(str(payload.get("carrier_uid") or ""))
        payload.update(gps)
        items.append(payload)
        if len(items) >= max_limit:
            break

    return {
        "items": items,
        "count": len(items),
        "scanned": scanned,
        "skipped_no_driver": skipped_no_driver,
        "skipped_no_gps": skipped_no_gps,
        "active_only": bool(active_only),
        "load_id": requested_load_id or None,
    }


@app.get("/admin/tracking/metrics")
async def admin_tracking_metrics(user: dict = Depends(require_admin)):
    """Admin-only: metrics used by Tracking & Visibility stat cards."""

    now = time.time()

    # Active loads (best-effort scan)
    active_loads = 0
    max_loads_to_scan = 5000
    scanned_loads = 0
    active_statuses = {
        LoadStatus.COVERED.value,
        LoadStatus.IN_TRANSIT.value,
        LoadStatus.ACCEPTED.value,
        LoadStatus.TENDERED.value,
    }
    try:
        for snap in db.collection("loads").stream():
            scanned_loads += 1
            if scanned_loads > max_loads_to_scan:
                break
            d = snap.to_dict() or {}
            if str(d.get("status") or "").lower() in active_statuses:
                active_loads += 1
    except Exception as e:
        print(f"[AdminTracking] Failed to scan loads: {e}")
        active_loads = 0

    # Fallback: if Firestore has no loads (common in dev), use the local JSON store.
    if active_loads == 0:
        try:
            local_loads = store.list_loads() if hasattr(store, "list_loads") else []
            for l in (local_loads or []):
                if str(l.get("status") or "").lower() in active_statuses:
                    active_loads += 1
        except Exception as e:
            print(f"[AdminTracking] Failed to read local loads store: {e}")

    # Missing documents (reuse same logic as dashboard metrics)
    missing_documents = 0
    max_users_to_scan = 2500
    scanned_users = 0
    try:
        from .onboarding import calculate_document_status

        for snap in db.collection("users").stream():
            scanned_users += 1
            if scanned_users > max_users_to_scan:
                break

            u = snap.to_dict() or {}
            role = str(u.get("role") or "").lower()
            if role in {"admin", "super_admin"}:
                continue

            onboarding_data_str = u.get("onboarding_data")
            if not onboarding_data_str:
                continue

            try:
                onboarding_data = (
                    json.loads(onboarding_data_str)
                    if isinstance(onboarding_data_str, str)
                    else onboarding_data_str
                )
                raw_docs = onboarding_data.get("documents", []) if isinstance(onboarding_data, dict) else []
                for doc in raw_docs:
                    expiry_date = (doc.get("extracted_fields") or {}).get("expiry_date")
                    status = calculate_document_status(expiry_date) if expiry_date else "Unknown"
                    if status != "Valid":
                        missing_documents += 1
            except Exception:
                continue
    except Exception as e:
        print(f"[AdminTracking] Failed to scan user documents: {e}")
        missing_documents = 0

    # Drivers offline (based on drivers.is_available)
    drivers_offline = 0
    max_drivers_to_scan = 5000
    try:
        driver_uids: set[str] = set()
        scanned_driver_users = 0
        for snap in db.collection("users").where("role", "==", "driver").stream():
            scanned_driver_users += 1
            if scanned_driver_users > max_drivers_to_scan:
                break
            u = snap.to_dict() or {}
            if u.get("is_active", True) is False:
                continue
            driver_uids.add(snap.id)

        scanned_driver_profiles = 0
        for snap in db.collection("drivers").stream():
            scanned_driver_profiles += 1
            if scanned_driver_profiles > max_drivers_to_scan:
                break
            if snap.id not in driver_uids:
                continue
            d = snap.to_dict() or {}
            if not bool(d.get("is_available", False)):
                drivers_offline += 1
    except Exception as e:
        print(f"[AdminTracking] Failed to compute drivers offline: {e}")
        drivers_offline = 0

    return {
        "computed_at": now,
        "active_loads": int(active_loads),
        "missing_documents": int(missing_documents),
        "drivers_offline": int(drivers_offline),
    }


@app.get("/admin/users/search")
async def admin_user_search(
    q: str,
    limit: int = 10,
    user: dict = Depends(require_admin),
):
    """Admin-only user search.

    Supports:
    - Prefix match on users.name and users.email (case-sensitive in Firestore)
    - Exact match on identifiers like dot_number/mc_number/cdl_number/license_number
    - Exact match on uid (document id)

    Returns a lightweight list suitable for header autocomplete.
    """

    def _norm_ident(v: str) -> str:
        return "".join(ch for ch in (v or "") if ch.isalnum()).upper()

    query = (q or "").strip()
    if not query:
        return {"items": []}

    max_limit = 25
    limit = int(limit) if limit is not None else 10
    limit = max(1, min(limit, max_limit))

    query_lower = query.lower()
    ident = _norm_ident(query)

    results_by_uid: Dict[str, Dict[str, Any]] = {}

    def _add_user_doc(uid: str, d: Dict[str, Any]):
        if not uid:
            return
        results_by_uid.setdefault(
            uid,
            {
                "uid": uid,
                "name": d.get("name") or d.get("full_name") or (d.get("email", "").split("@")[0] if d.get("email") else ""),
                "email": d.get("email"),
                "role": d.get("role"),
                "profile_picture_url": d.get("profile_picture_url") or d.get("photo_url") or d.get("avatar_url"),
                "dot_number": d.get("dot_number"),
                "mc_number": d.get("mc_number"),
                "cdl_number": d.get("cdl_number"),
                "license_number": d.get("license_number"),
                "is_verified": d.get("is_verified"),
                "is_active": d.get("is_active"),
            },
        )

    # 1) Direct lookup by UID (document id)
    try:
        direct = db.collection("users").document(query).get()
        if direct.exists:
            _add_user_doc(direct.id, direct.to_dict() or {})
    except Exception:
        pass

    # Best-effort: attach shipper display name/company for carrier/driver viewers.
    # Some legacy loads may not have shipper_company_name populated on the load.
    try:
        role_l = str(user_role or "").strip().lower()
        uid_s = str(uid or "").strip()

        shipper_present = bool(str(sanitized.get("shipper_company_name") or sanitized.get("shipper_name") or "").strip())
        if not shipper_present and role_l in {"carrier", "driver"}:
            shipper_uid = str(load.get("created_by") or load.get("payer_uid") or load.get("createdBy") or "").strip()

            # Avoid revealing shipper identity to carriers in marketplace browsing.
            if role_l == "carrier":
                assigned_carrier = str(load.get("assigned_carrier") or load.get("assigned_carrier_id") or "").strip()
                if assigned_carrier and assigned_carrier != uid_s:
                    shipper_uid = ""

            # Drivers only see shipper info when they are assigned.
            if role_l == "driver":
                assigned_driver = str(load.get("assigned_driver") or load.get("assigned_driver_id") or "").strip()
                if assigned_driver and assigned_driver != uid_s:
                    shipper_uid = ""

            if shipper_uid:
                snap = db.collection("users").document(shipper_uid).get()
                if getattr(snap, "exists", False):
                    prof = snap.to_dict() or {}
                    prof_role = str(prof.get("role") or "").strip().lower()
                    if prof_role in {"shipper", "broker"}:
                        name = (
                            prof.get("company_name")
                            or prof.get("name")
                            or prof.get("display_name")
                            or prof.get("full_name")
                            or (prof.get("email", "").split("@")[0] if prof.get("email") else "")
                        )
                        name = str(name or "").strip()
                        if name:
                            sanitized.setdefault("shipper_company_name", name)
                            sanitized.setdefault("shipper_name", name)
    except Exception:
        pass

    # 1b) Exact match on email (fast path; avoids expensive prefix scans)
    # Firestore string matching is case-sensitive, so try both raw and lower.
    if "@" in query and "." in query:
        try:
            snaps = db.collection("users").where("email", "==", query).limit(limit).stream()
            for s in snaps:
                _add_user_doc(s.id, s.to_dict() or {})
        except Exception:
            pass
        if query_lower != query:
            try:
                snaps = db.collection("users").where("email", "==", query_lower).limit(limit).stream()
                for s in snaps:
                    _add_user_doc(s.id, s.to_dict() or {})
            except Exception:
                pass

        # If we got an exact email match, return quickly.
        if results_by_uid:
            items = list(results_by_uid.values())
            return {"items": items[:limit]}

    # 2) Prefix match on name/email (best-effort)
    # Avoid prefix scans for long / email-like inputs; exact matching handles those.
    should_prefix_scan = 2 <= len(query) <= 32 and ("@" not in query)
    if should_prefix_scan:
        prefix_fields = ["name", "email"]
        for field in prefix_fields:
            try:
                snaps = (
                    db.collection("users")
                    .order_by(field)
                    .start_at([query])
                    .end_at([query + "\uf8ff"])
                    .limit(limit)
                    .stream()
                )
                for s in snaps:
                    _add_user_doc(s.id, s.to_dict() or {})
                    if len(results_by_uid) >= limit:
                        break
            except Exception:
                # Missing index / invalid ordering should not break the dashboard.
                continue

    # 3) Exact identifier matches (DOT/MC/CDL/etc) on users collection
    exact_fields = ["dot_number", "mc_number", "cdl_number", "license_number"]
    for field in exact_fields:
        if not ident:
            continue
        try:
            snaps = db.collection("users").where(field, "==", ident).limit(limit).stream()
            for s in snaps:
                _add_user_doc(s.id, s.to_dict() or {})
                if len(results_by_uid) >= limit:
                    break
        except Exception:
            continue

    # 4) Also search role-specific collections (carriers/drivers) for common identifiers
    try:
        # carriers: dot_number / mc_number
        for field in ["dot_number", "mc_number"]:
            if len(results_by_uid) >= limit:
                break
            snaps = db.collection("carriers").where(field, "==", ident).limit(limit).stream()
            carrier_ids = [s.id for s in snaps]
            if carrier_ids:
                user_refs = [db.collection("users").document(cid) for cid in carrier_ids]
                for doc_snap in db.get_all(user_refs):
                    if doc_snap.exists:
                        _add_user_doc(doc_snap.id, doc_snap.to_dict() or {})

        # drivers: cdl_number
        if len(results_by_uid) < limit:
            snaps = db.collection("drivers").where("cdl_number", "==", ident).limit(limit).stream()
            driver_ids = [s.id for s in snaps]
            if driver_ids:
                user_refs = [db.collection("users").document(did) for did in driver_ids]
                for doc_snap in db.get_all(user_refs):
                    if doc_snap.exists:
                        _add_user_doc(doc_snap.id, doc_snap.to_dict() or {})
    except Exception:
        pass

    items = list(results_by_uid.values())
    # Light sorting: verified/active first, then name.
    def _sort_key(item: Dict[str, Any]):
        return (
            0 if item.get("is_active", True) else 1,
            0 if item.get("is_verified", False) else 1,
            str(item.get("name") or "").lower(),
        )

    items.sort(key=_sort_key)
    return {"items": items[:limit]}


@app.get("/admin/users/{target_uid}")
async def admin_get_user_details(
    target_uid: str,
    user: dict = Depends(require_admin),
):
    """Admin-only: return detailed user data for the user-details modal."""
    uid = str(target_uid or '').strip()
    if not uid:
        raise HTTPException(status_code=400, detail="Missing user id")

    snap = db.collection("users").document(uid).get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="User not found")
    u = snap.to_dict() or {}

    role = str(u.get("role") or "").lower()
    role_profile: Dict[str, Any] | None = None
    try:
        if role == "carrier":
            s2 = db.collection("carriers").document(uid).get()
            role_profile = s2.to_dict() if s2.exists else None
        elif role == "driver":
            s2 = db.collection("drivers").document(uid).get()
            role_profile = s2.to_dict() if s2.exists else None
        elif role in {"shipper", "broker"}:
            s2 = db.collection("shippers").document(uid).get()
            role_profile = s2.to_dict() if s2.exists else None
        elif role == "service_provider":
            s2 = db.collection("service_providers").document(uid).get()
            role_profile = s2.to_dict() if s2.exists else None
    except Exception:
        role_profile = None

    def _pick_name(d: Dict[str, Any]) -> str:
        return (
            d.get("name")
            or d.get("full_name")
            or d.get("display_name")
            or (d.get("email", "").split("@")[0] if d.get("email") else "")
            or "User"
        )

    details = {
        "uid": uid,
        "name": _pick_name(u),
        "email": u.get("email"),
        "phone": u.get("phone"),
        "role": u.get("role"),
        "department": u.get("department"),
        "is_verified": u.get("is_verified", False),
        "is_active": u.get("is_active", True),
        "is_locked": u.get("is_locked", False),
        "created_at": u.get("created_at"),
        "updated_at": u.get("updated_at"),
        "last_login_at": u.get("last_login_at"),
        "dot_number": u.get("dot_number"),
        "mc_number": u.get("mc_number"),
        "cdl_number": u.get("cdl_number"),
        "license_number": u.get("license_number"),
        "profile_picture_url": u.get("profile_picture_url") or u.get("photo_url") or u.get("avatar_url"),
        "address": u.get("address"),
        "location": u.get("location"),
        "fmcsa_verified": u.get("fmcsa_verified"),
        "fmcsa_verification": u.get("fmcsa_verification"),
        "role_profile": role_profile,
    }
    return {"user": details}


def _parse_super_admin_emails() -> List[str]:
    raw = getattr(settings, "SUPER_ADMIN_EMAILS", "") or ""
    emails = [e.strip() for e in raw.split(",") if e.strip()]
    # Fallback so we at least notify someone in dev.
    if not emails:
        admin_email = getattr(settings, "ADMIN_EMAIL", "") or ""
        if admin_email:
            emails = [admin_email]
    return emails


def _format_dt(ts: float) -> str:
    try:
        return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(float(ts or 0.0)))
    except Exception:
        return ""


def _delete_collection(coll_ref, batch_size: int = 100) -> int:
    """Best-effort delete for a collection reference (non-recursive)."""
    deleted = 0
    while True:
        snaps = list(coll_ref.limit(batch_size).stream())
        if not snaps:
            break
        batch = db.batch()
        for s in snaps:
            batch.delete(s.reference)
            deleted += 1
        batch.commit()
    return deleted


def _delete_document_recursive(doc_ref) -> None:
    """Best-effort recursive delete of a document and its subcollections."""
    try:
        for sub in doc_ref.collections():
            _delete_collection(sub)
    except Exception:
        # If listing subcollections fails, still delete the document.
        pass
    try:
        doc_ref.delete()
    except Exception:
        pass


def _delete_user_from_db_everywhere(target_uid: str) -> Dict[str, Any]:
    """Best-effort purge of user data across Firestore + Firebase Auth."""
    uid = str(target_uid or '').strip()
    if not uid:
        return {"ok": False, "detail": "Missing uid"}

    out: Dict[str, Any] = {"uid": uid}

    # 1) Delete conversations where user is a member (and messages subcollection).
    deleted_threads = 0
    deleted_messages = 0
    try:
        snaps = list(
            db.collection("conversations")
            .where("member_uids", "array_contains", uid)
            .limit(200)
            .stream()
        )
        for s in snaps:
            try:
                deleted_messages += _delete_collection(
                    db.collection("conversations").document(s.id).collection("messages"),
                    batch_size=200,
                )
            except Exception:
                pass
            try:
                db.collection("conversations").document(s.id).delete()
                deleted_threads += 1
            except Exception:
                pass
    except Exception:
        pass
    out["deleted_conversations"] = deleted_threads
    out["deleted_conversation_messages"] = deleted_messages

    # 2) Delete role/profile docs.
    for coll in ["carriers", "drivers", "shippers", "service_providers", "admins", "super_admins"]:
        try:
            db.collection(coll).document(uid).delete()
        except Exception:
            pass

    # 3) Delete users/{uid} recursively (warnings/removal_requests/etc).
    try:
        _delete_document_recursive(db.collection("users").document(uid))
        out["deleted_user_doc"] = True
    except Exception:
        out["deleted_user_doc"] = False

    # 4) Delete Firebase Auth record.
    try:
        firebase_auth.delete_user(uid)
        out["deleted_auth_user"] = True
    except Exception as e:
        out["deleted_auth_user"] = False
        out["auth_delete_error"] = str(e)

    return out


@app.post("/admin/users/{target_uid}/removal-requests")
async def admin_request_user_removal(
    target_uid: str,
    payload: AdminUserRemovalRequest,
    user: dict = Depends(require_admin),
):
    """Admin-only: create a removal request that requires super-admin approval."""
    uid = str(target_uid or '').strip()
    if not uid:
        raise HTTPException(status_code=400, detail="Missing user id")

    target_snap = db.collection("users").document(uid).get()
    if not target_snap.exists:
        raise HTTPException(status_code=404, detail="User not found")

    target = target_snap.to_dict() or {}
    target_email = target.get("email")
    if not target_email:
        raise HTTPException(status_code=400, detail="Target user is missing email")

    now = time.time()
    req_id = str(uuid.uuid4())
    grace_days = int(payload.grace_days or 0)
    deactivate_at = now + (grace_days * 86400)

    doc = {
        "id": req_id,
        "kind": "user_removal",
        "status": "pending",
        "created_at": now,
        "updated_at": now,
        "requested_by_uid": user.get("uid"),
        "requested_by_email": user.get("email"),
        "requested_by_name": user.get("name") or user.get("display_name") or user.get("email"),
        "requested_by_role": user.get("role"),
        "target_uid": uid,
        "target_email": target_email,
        "target_name": target.get("name") or target.get("full_name") or target_email.split("@")[0],
        "target_role": target.get("role"),
        "target_created_at": target.get("created_at"),
        "reason": payload.reason,
        "grace_days": grace_days,
        "deactivate_at": deactivate_at,
        "message_to_user": payload.message_to_user or "",
    }

    db.collection("user_removal_requests").document(req_id).set(doc)
    # Keep per-user history for audit.
    db.collection("users").document(uid).collection("removal_requests").document(req_id).set(doc)

    # Notify super admins
    sa_emails = _parse_super_admin_emails()
    if sa_emails:
        html = f"""
        <html><body>
          <h2>User Removal Request (Pending Approval)</h2>
          <p><strong>Target:</strong> {doc['target_name']} ({doc['target_email']})</p>
          <p><strong>Target UID:</strong> {doc['target_uid']}</p>
          <p><strong>Requested by:</strong> {doc.get('requested_by_email') or doc.get('requested_by_uid')}</p>
          <p><strong>Reason:</strong> {doc['reason']}</p>
          <p><strong>Grace days:</strong> {doc['grace_days']}</p>
          <p><strong>Message to user:</strong><br>{(doc['message_to_user'] or '').replace(chr(10), '<br>')}</p>
          <hr>
          <p>Open Super Admin dashboard to approve/reject.</p>
        </body></html>
        """
        for e in sa_emails:
            send_email(e, "FreightPower-AI: User removal approval required", html, is_html=True)

        # Notify the admin who initiated the request (confirmation)
        if doc.get("requested_by_email"):
                admin_html = f"""
                <html><body>
                    <h2>User Removal Request Created</h2>
                    <p>Your request was created and is pending Super Admin action.</p>
                    <p><strong>Target:</strong> {doc['target_name']} ({doc['target_email']})</p>
                    <p><strong>Reason:</strong> {doc['reason']}</p>
                    <p><strong>Grace days:</strong> {doc['grace_days']}</p>
                    <p><strong>Initiated at:</strong> {_format_dt(now)}</p>
                    <hr>
                    <p><em>Generated by FreightPower-AI.</em></p>
                </body></html>
                """
                send_email(doc["requested_by_email"], "FreightPower-AI: removal request created", admin_html, is_html=True)

    # Inform user that a request was opened (pending approval)
    user_html = f"""
    <html><body>
      <h2>Account Removal Request Initiated</h2>
      <p>Your account has been flagged for removal review by an admin.</p>
      <p><strong>Reason:</strong> {doc['reason']}</p>
      <p><strong>Grace period:</strong> {doc['grace_days']} day(s)</p>
      <p><strong>Message:</strong><br>{(doc['message_to_user'] or '').replace(chr(10), '<br>')}</p>
      <hr>
      <p><em>This request is pending platform approval.</em></p>
      <p><em>Generated by FreightPower-AI.</em></p>
    </body></html>
    """
    send_email(target_email, "FreightPower-AI: removal request initiated", user_html, is_html=True)

    log_action(user.get("uid"), "USER_REMOVAL_REQUEST_CREATED", f"Created removal request {req_id} for {uid}")
    return {"id": req_id, "status": "pending"}


@app.post("/admin/users/{target_uid}/warnings")
async def admin_send_warning(
    target_uid: str,
    payload: AdminUserWarningRequest,
    user: dict = Depends(require_admin),
):
    """Admin-only: persist a warning and email it to the user."""
    uid = str(target_uid or '').strip()
    if not uid:
        raise HTTPException(status_code=400, detail="Missing user id")

    target_snap = db.collection("users").document(uid).get()
    if not target_snap.exists:
        raise HTTPException(status_code=404, detail="User not found")
    target = target_snap.to_dict() or {}
    target_email = target.get("email")
    if not target_email:
        raise HTTPException(status_code=400, detail="Target user is missing email")

    now = time.time()
    warn_id = str(uuid.uuid4())
    subject = payload.subject or "FreightPower-AI: Important warning"

    doc = {
        "id": warn_id,
        "kind": "warning",
        "created_at": now,
        "created_by_uid": user.get("uid"),
        "created_by_email": user.get("email"),
        "target_uid": uid,
        "target_email": target_email,
        "warning": payload.warning,
        "subject": subject,
    }
    db.collection("user_warnings").document(warn_id).set(doc)
    db.collection("users").document(uid).collection("warnings").document(warn_id).set(doc)

    html = f"""
    <html><body>
      <h2>Warning Notice</h2>
      <p>{payload.warning.replace(chr(10), '<br>')}</p>
      <hr>
      <p><em>Generated by FreightPower-AI.</em></p>
    </body></html>
    """
    ok = send_email(target_email, subject, html, is_html=True)
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to send warning email")

    log_action(user.get("uid"), "USER_WARNING_SENT", f"Sent warning {warn_id} to {uid}")
    return {"id": warn_id, "status": "sent"}


@app.get("/super-admin/removal-requests")
async def super_admin_list_removal_requests(
    status: str = "pending",
    limit: int = 50,
    user: dict = Depends(require_super_admin),
):
    st = (status or "pending").strip().lower()
    if st not in {"pending", "approved", "rejected", "executed", "deleted", "banned"}:
        raise HTTPException(status_code=400, detail="Invalid status")
    limit = max(1, min(int(limit or 50), 200))
    try:
        # NOTE: Firestore commonly requires a composite index for (status == X) + order_by(created_at).
        # To keep local/dev setups working without manual index creation, we fetch by status and
        # sort client-side.
        snaps = (
            db.collection("user_removal_requests")
            .where("status", "==", st)
            .limit(limit)
            .stream()
        )
        items = []
        now = time.time()
        for s in snaps:
            d = s.to_dict() or {}
            d["id"] = s.id

            # Enrich with current user data (best-effort)
            tuid = d.get("target_uid")
            if tuid:
                try:
                    us = db.collection("users").document(tuid).get()
                    if us.exists:
                        ud = us.to_dict() or {}
                        d.setdefault("target_name", ud.get("name") or ud.get("full_name") or ud.get("email"))
                        d.setdefault("target_email", ud.get("email"))
                        d.setdefault("target_role", ud.get("role"))
                        d.setdefault("target_created_at", ud.get("created_at"))
                        if ud.get("created_at"):
                            d["target_total_time_seconds"] = max(0.0, now - float(ud.get("created_at") or 0.0))
                except Exception:
                    pass

            ruid = d.get("requested_by_uid")
            if ruid and not d.get("requested_by_name"):
                try:
                    rs = db.collection("users").document(ruid).get()
                    if rs.exists:
                        rd = rs.to_dict() or {}
                        d["requested_by_name"] = rd.get("name") or rd.get("full_name") or rd.get("email")
                except Exception:
                    pass

            items.append(d)

        def _created_at_key(v: Dict[str, Any]) -> float:
            try:
                return float(v.get("created_at") or 0.0)
            except Exception:
                return 0.0

        items.sort(key=_created_at_key, reverse=True)
        return {"requests": items[:limit]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load removal requests: {str(e)}")


@app.post("/super-admin/removal-requests/{request_id}/approve-delete")
async def super_admin_approve_and_delete_user(
    request_id: str,
    payload: SuperAdminDecisionRequest,
    user: dict = Depends(require_super_admin),
):
    rid = str(request_id or '').strip()
    if not rid:
        raise HTTPException(status_code=400, detail="Missing request id")

    ref = db.collection("user_removal_requests").document(rid)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Request not found")
    d = snap.to_dict() or {}
    if d.get("status") != "pending":
        raise HTTPException(status_code=400, detail="Request is not pending")

    now = time.time()
    target_uid = d.get("target_uid")
    target_email = d.get("target_email")

    # Notify user before deletion (best-effort)
    if target_email:
        html = f"""
        <html><body>
          <h2>Account Removal Approved</h2>
          <p>Your account removal request has been approved by the platform.</p>
          <p><strong>Reason:</strong> {d.get('reason','')}</p>
          <p><strong>Initiated at:</strong> {_format_dt(float(d.get('created_at') or now))}</p>
          <p><strong>Message:</strong><br>{(d.get('message_to_user') or '').replace(chr(10), '<br>')}</p>
          <hr>
          <p><em>Generated by FreightPower-AI.</em></p>
        </body></html>
        """
        send_email(target_email, "FreightPower-AI: account removal approved", html, is_html=True)

    # Notify initiating admin (best-effort)
    if d.get("requested_by_email"):
        admin_html = f"""
        <html><body>
          <h2>User Removal Approved</h2>
          <p>The Super Admin approved the removal request.</p>
          <p><strong>Target:</strong> {d.get('target_name') or d.get('target_email') or ''}</p>
          <p><strong>Decision note:</strong> {(payload.decision_note or '').replace(chr(10), '<br>')}</p>
          <p><strong>Approved at:</strong> {_format_dt(now)}</p>
          <hr>
          <p><em>Generated by FreightPower-AI.</em></p>
        </body></html>
        """
        send_email(d.get("requested_by_email"), "FreightPower-AI: user removal approved", admin_html, is_html=True)

    # Delete user from DB + Auth
    deletion = _delete_user_from_db_everywhere(str(target_uid or '').strip()) if target_uid else {"ok": False}

    update = {
        "status": "deleted",
        "deleted_at": now,
        "deleted_by_uid": user.get("uid"),
        "deleted_by_email": user.get("email"),
        "decision_note": payload.decision_note or None,
        "updated_at": now,
        "deletion": deletion,
    }
    ref.set(update, merge=True)

    log_action(user.get("uid"), "USER_REMOVAL_REQUEST_DELETED", f"Deleted user for request {rid}")
    return {"ok": True, "status": "deleted", "deletion": deletion}


@app.post("/super-admin/removal-requests/{request_id}/ban")
async def super_admin_ban_user_from_removal_request(
    request_id: str,
    payload: SuperAdminDecisionRequest,
    user: dict = Depends(require_super_admin),
):
    rid = str(request_id or '').strip()
    if not rid:
        raise HTTPException(status_code=400, detail="Missing request id")

    ref = db.collection("user_removal_requests").document(rid)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Request not found")
    d = snap.to_dict() or {}
    if d.get("status") != "pending":
        raise HTTPException(status_code=400, detail="Request is not pending")

    now = time.time()
    target_uid = str(d.get("target_uid") or '').strip()
    if not target_uid:
        raise HTTPException(status_code=400, detail="Request missing target uid")

    # Collect unique identifiers (best-effort)
    email = d.get("target_email")
    phone = None
    dot_number = None
    cdl_number = None
    try:
        udoc_snap = db.collection("users").document(target_uid).get()
        if udoc_snap.exists:
            udoc = udoc_snap.to_dict() or {}
            email = email or udoc.get("email")
            phone = udoc.get("phone")
            dot_number = udoc.get("dot_number")
            cdl_number = udoc.get("cdl_number")
    except Exception:
        pass
    try:
        ddoc_snap = db.collection("drivers").document(target_uid).get()
        if ddoc_snap.exists:
            ddoc = ddoc_snap.to_dict() or {}
            cdl_number = cdl_number or ddoc.get("cdl_number")
            phone = phone or ddoc.get("phone")
            email = email or ddoc.get("email")
    except Exception:
        pass
    try:
        cdoc_snap = db.collection("carriers").document(target_uid).get()
        if cdoc_snap.exists:
            cdoc = cdoc_snap.to_dict() or {}
            dot_number = dot_number or cdoc.get("dot_number")
            phone = phone or cdoc.get("phone")
            email = email or cdoc.get("email")
    except Exception:
        pass

    ban_reason = payload.decision_note or d.get("reason") or "Banned via removal request"
    ban_result = record_bans(
        target_uid=target_uid,
        banned_by_uid=user.get("uid"),
        banned_by_email=user.get("email"),
        request_id=rid,
        reason=ban_reason,
        email=email,
        phone=phone,
        dot_number=dot_number,
        cdl_number=cdl_number,
    )

    # Notify initiating admin (best-effort)
    if d.get("requested_by_email"):
        admin_html = f"""
        <html><body>
          <h2>User Banned</h2>
          <p>The Super Admin banned the user from your removal request.</p>
          <p><strong>Target:</strong> {d.get('target_name') or d.get('target_email') or ''}</p>
          <p><strong>Ban reason:</strong> {ban_reason}</p>
          <p><strong>Banned at:</strong> {_format_dt(now)}</p>
          <hr>
          <p><em>Generated by FreightPower-AI.</em></p>
        </body></html>
        """
        send_email(d.get("requested_by_email"), "FreightPower-AI: user banned", admin_html, is_html=True)

    # Delete user from DB + Auth
    deletion = _delete_user_from_db_everywhere(target_uid)

    update = {
        "status": "banned",
        "banned_at": now,
        "banned_by_uid": user.get("uid"),
        "banned_by_email": user.get("email"),
        "decision_note": payload.decision_note or None,
        "updated_at": now,
        "ban": ban_result,
        "deletion": deletion,
    }
    ref.set(update, merge=True)

    log_action(user.get("uid"), "USER_REMOVAL_REQUEST_BANNED", f"Banned user for request {rid}")
    return {"ok": True, "status": "banned", "ban": ban_result, "deletion": deletion}


@app.post("/super-admin/removal-requests/{request_id}/approve")
async def super_admin_approve_removal_request(
    request_id: str,
    payload: SuperAdminDecisionRequest,
    user: dict = Depends(require_super_admin),
):
    rid = str(request_id or '').strip()
    if not rid:
        raise HTTPException(status_code=400, detail="Missing request id")

    ref = db.collection("user_removal_requests").document(rid)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Request not found")
    d = snap.to_dict() or {}
    if d.get("status") != "pending":
        raise HTTPException(status_code=400, detail="Request is not pending")

    now = time.time()
    update = {
        "status": "approved",
        "approved_at": now,
        "approved_by_uid": user.get("uid"),
        "approved_by_email": user.get("email"),
        "decision_note": payload.decision_note or None,
        "updated_at": now,
    }
    ref.set(update, merge=True)
    # mirror to per-user
    tuid = d.get("target_uid")
    if tuid:
        db.collection("users").document(tuid).collection("removal_requests").document(rid).set(update, merge=True)

    # Notify user that it was approved.
    target_email = d.get("target_email")
    if target_email:
        deactivate_at = float(d.get("deactivate_at") or now)
        dt = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(deactivate_at))
        html = f"""
        <html><body>
          <h2>Account Removal Approved</h2>
          <p>Your account removal request has been approved by the platform.</p>
          <p><strong>Reason:</strong> {d.get('reason','')}</p>
          <p><strong>Grace period:</strong> {d.get('grace_days',0)} day(s)</p>
          <p><strong>Scheduled deactivation:</strong> {dt}</p>
          <p><strong>Message:</strong><br>{(d.get('message_to_user') or '').replace(chr(10), '<br>')}</p>
          <hr>
          <p><em>Generated by FreightPower-AI.</em></p>
        </body></html>
        """
        send_email(target_email, "FreightPower-AI: account removal approved", html, is_html=True)

    log_action(user.get("uid"), "USER_REMOVAL_REQUEST_APPROVED", f"Approved removal request {rid}")
    return {"ok": True}


@app.post("/super-admin/removal-requests/{request_id}/reject")
async def super_admin_reject_removal_request(
    request_id: str,
    payload: SuperAdminDecisionRequest,
    user: dict = Depends(require_super_admin),
):
    rid = str(request_id or '').strip()
    if not rid:
        raise HTTPException(status_code=400, detail="Missing request id")

    ref = db.collection("user_removal_requests").document(rid)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Request not found")
    d = snap.to_dict() or {}
    if d.get("status") != "pending":
        raise HTTPException(status_code=400, detail="Request is not pending")

    now = time.time()
    update = {
        "status": "rejected",
        "rejected_at": now,
        "rejected_by_uid": user.get("uid"),
        "rejected_by_email": user.get("email"),
        "decision_note": payload.decision_note or None,
        "updated_at": now,
    }
    ref.set(update, merge=True)
    tuid = d.get("target_uid")
    if tuid:
        db.collection("users").document(tuid).collection("removal_requests").document(rid).set(update, merge=True)

    log_action(user.get("uid"), "USER_REMOVAL_REQUEST_REJECTED", f"Rejected removal request {rid}")
    return {"ok": True}


def _process_due_user_removals() -> None:
    """Deactivate users for approved removal requests that reached deactivate_at."""
    now = time.time()
    try:
        # Prefer the newer Firestore API (`filter=`) to avoid warnings.
        # Also avoid requiring a composite index in environments where it isn't created yet.
        try:
            from google.cloud.firestore_v1 import FieldFilter  # type: ignore

            composite_query = (
                db.collection("user_removal_requests")
                .where(filter=FieldFilter("status", "==", "approved"))
                .where(filter=FieldFilter("deactivate_at", "<=", now))
                .limit(50)
            )
            candidate_snaps = composite_query.stream()
        except Exception as e:
            print(f"[RemovalJob] Falling back to non-indexed query: {e}")
            # Fallback: query only by deactivate_at and filter status in-memory.
            # This avoids composite index requirements.
            try:
                from google.cloud.firestore_v1 import FieldFilter  # type: ignore

                candidate_snaps = (
                    db.collection("user_removal_requests")
                    .where(filter=FieldFilter("deactivate_at", "<=", now))
                    .limit(250)
                    .stream()
                )
            except Exception:
                candidate_snaps = (
                    db.collection("user_removal_requests")
                    .where("deactivate_at", "<=", now)
                    .limit(250)
                    .stream()
                )

        processed = 0
        for s in candidate_snaps:
            d = s.to_dict() or {}
            if d.get("status") != "approved":
                continue
            rid = s.id
            tuid = d.get("target_uid")
            if not tuid:
                continue

            # Disable Firebase Auth user (best-effort)
            try:
                firebase_auth.update_user(tuid, disabled=True)
            except Exception as e:
                print(f"[RemovalJob] Failed to disable auth user {tuid}: {e}")

            # Mark Firestore user as inactive
            try:
                db.collection("users").document(tuid).set(
                    {
                        "is_active": False,
                        "disabled_at": now,
                        "disabled_reason": d.get("reason"),
                        "updated_at": now,
                    },
                    merge=True,
                )
            except Exception as e:
                print(f"[RemovalJob] Failed to update users/{tuid}: {e}")

            # Mark request executed
            try:
                db.collection("user_removal_requests").document(rid).set(
                    {"status": "executed", "executed_at": now, "updated_at": now},
                    merge=True,
                )
                db.collection("users").document(tuid).collection("removal_requests").document(rid).set(
                    {"status": "executed", "executed_at": now, "updated_at": now},
                    merge=True,
                )
            except Exception as e:
                print(f"[RemovalJob] Failed to mark executed {rid}: {e}")

            processed += 1
            if processed >= 50:
                break
    except Exception as e:
        print(f"[RemovalJob] Failed to process due removals: {e}")

# --- List Documents Endpoint (for Dashboard) ---
@app.get("/documents")
async def list_documents(user: dict = Depends(get_current_user)):
    """
    Returns the list of documents from user's onboarding with status.
    """
    from .onboarding import calculate_document_status
    
    uid = user['uid']
    documents = []
    onboarding_data_str = user.get("onboarding_data")
    
    try:
        # Handle None/null values from Firebase
        if not onboarding_data_str:
            onboarding_data = {}
        else:
            onboarding_data = json.loads(onboarding_data_str)
        
        if isinstance(onboarding_data, dict):
            raw_docs = onboarding_data.get("documents", [])
            for doc in raw_docs:
                status = "Unknown"
                expiry_date = doc.get("extracted_fields", {}).get("expiry_date")
                
                if expiry_date:
                    status = calculate_document_status(expiry_date)
                
                doc_type = doc.get("extracted_fields", {}).get("document_type", "Unknown")
                
                documents.append({
                    "id": doc.get("doc_id", ""),
                    "filename": doc.get("filename", ""),
                    "type": doc_type,
                    "score": doc.get("score", 0),
                    "status": status,
                    "expiry_date": expiry_date,
                    "uploaded_at": doc.get("uploaded_at", ""),
                    "download_url": doc.get("download_url", ""),
                    "extracted_fields": doc.get("extracted_fields", {}),
                    "missing_fields": doc.get("missing", []),
                    "warnings": []
                })
    except Exception as e:
        print(f"Error parsing onboarding data: {e}")
    
    return {
        "documents": documents,
        "total_count": len(documents),
        "valid_count": sum(1 for d in documents if d["status"] == "Valid"),
        "expiring_soon_count": sum(1 for d in documents if d["status"] == "Expiring Soon"),
        "expired_count": sum(1 for d in documents if d["status"] == "Expired")
    }


@app.get("/documents/package.zip")
async def download_documents_package(user: Dict[str, Any] = Depends(get_current_user)):
    """Download all current user's documents as a single ZIP."""

    def _safe_name(name: str) -> str:
        name = (name or "document").strip() or "document"
        name = name.replace("\\", "_").replace("/", "_").replace(":", "_")
        return name

    uid = user.get("uid")
    user_ref = db.collection("users").document(uid)
    user_doc = user_ref.get()
    docs_array: List[Dict[str, Any]] = []

    if user_doc.exists:
        user_data = user_doc.to_dict() or {}
        onboarding_data_str = user_data.get("onboarding_data")
        try:
            onboarding_data = json.loads(onboarding_data_str) if isinstance(onboarding_data_str, str) else (onboarding_data_str or {})
        except Exception:
            onboarding_data = {}
        if isinstance(onboarding_data, dict):
            docs_array = onboarding_data.get("documents", []) or []

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        used_names: Dict[str, int] = {}
        for doc in docs_array:
            filename = (
                doc.get("filename")
                or doc.get("file_name")
                or doc.get("name")
                or f"{doc.get('doc_id', 'document')}.pdf"
            )
            filename = _safe_name(str(filename))

            base, ext = os.path.splitext(filename)
            if not ext:
                ext = ".pdf"
            base = base or "document"
            outname = f"{base}{ext}"
            if outname in used_names:
                used_names[outname] += 1
                outname = f"{base}_{used_names[outname]}{ext}"
            else:
                used_names[outname] = 0

            data = None
            storage_path = doc.get("storage_path")
            if storage_path:
                try:
                    data = bucket.blob(storage_path).download_as_bytes()
                except Exception as e:
                    print(f"[documents/package.zip] failed download {storage_path}: {e}")

            if data is None:
                url = doc.get("download_url") or doc.get("file_url")
                if url:
                    try:
                        with urllib.request.urlopen(url, timeout=20) as resp:
                            data = resp.read()
                    except Exception as e:
                        print(f"[documents/package.zip] failed fetch url: {e}")

            if data is None:
                continue

            zf.writestr(outname, data)

    buf.seek(0)
    headers = {
        "Content-Disposition": 'attachment; filename="documents.zip"'
    }
    return StreamingResponse(buf, media_type="application/zip", headers=headers)


# --- Trip Documents (Driver Vault) ---
@app.get("/trip-documents")
async def list_trip_documents(user: Dict[str, Any] = Depends(get_current_user)):
    """List driver-uploaded trip documents.

    These are generic files (any type) and are NOT run through AI extraction.
    Stored on the Firebase user doc under `trip_documents`.
    """
    uid = user.get("uid")
    try:
        user_ref = db.collection("users").document(uid)
        snap = user_ref.get()
        if not snap.exists:
            return {"documents": [], "total": 0}
        data = snap.to_dict() or {}
        docs = data.get("trip_documents") or []
        if not isinstance(docs, list):
            docs = []
        # newest first
        try:
            docs.sort(key=lambda d: float((d or {}).get("uploaded_at") or 0), reverse=True)
        except Exception:
            pass
        return {"documents": docs, "total": len(docs)}
    except Exception as e:
        print(f"Error fetching trip documents: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch trip documents: {str(e)}")


@app.post("/trip-documents")
async def upload_trip_document(
    file: UploadFile = File(...),
    user: Dict[str, Any] = Depends(get_current_user),
):
    """Upload a generic trip document (any file type).

    Intended for PostHire drivers to save delivery reports, receipts, photos, etc.
    """
    uid = user.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")

    # Basic limits
    data = await file.read()
    if data is None:
        raise HTTPException(status_code=400, detail="Empty upload")
    if len(data) > 50 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File size must be less than 50MB")

    doc_id = str(uuid.uuid4())
    filename = file.filename or f"trip_document_{doc_id}"
    content_type = file.content_type or "application/octet-stream"
    storage_path = f"trip_documents/{uid}/{doc_id}_{filename}"

    download_url = None
    try:
        blob = bucket.blob(storage_path)
        blob.upload_from_string(data, content_type=content_type)
        blob.make_public()
        download_url = blob.public_url
        print(f"✅ Trip doc uploaded to Firebase Storage: {storage_path}")
    except Exception as e:
        print(f"❌ Error uploading trip doc to Firebase Storage: {e}")

    record = {
        "id": doc_id,
        "filename": filename,
        "content_type": content_type,
        "size_bytes": len(data),
        "storage_path": storage_path,
        "download_url": download_url,
        "uploaded_at": time.time(),
    }

    # Persist metadata on user doc
    try:
        user_ref = db.collection("users").document(uid)
        snap = user_ref.get()
        existing = snap.to_dict() or {} if snap.exists else {}
        docs = existing.get("trip_documents") or []
        if not isinstance(docs, list):
            docs = []
        docs.append(record)
        user_ref.set({"trip_documents": docs, "updated_at": time.time()}, merge=True)
        log_action(uid, "TRIP_DOCUMENT_UPLOAD", f"Trip document uploaded: {filename}")
    except Exception as e:
        print(f"Warning: Could not save trip document metadata to Firebase: {e}")

    return {"document": record}

@app.get("/compliance/tasks")
async def get_compliance_tasks(user: dict = Depends(get_current_user)):
    """
    Get compliance tasks and reminders for the user's dashboard.
    """
    uid = user['uid']
    tasks = []
    
    # Check if onboarding is complete
    if not user.get("onboarding_completed", False):
        tasks.append({
            "id": "task-onboarding",
            "type": "warning",
            "title": "Complete Onboarding",
            "description": "Upload required documents to improve your compliance score",
            "priority": "high",
            "actions": ["Go to Onboarding"],
            "icon": "fa-clipboard-list"
        })
    
    # Check if DOT number exists
    if not user.get("dot_number"):
        tasks.append({
            "id": "task-dot",
            "type": "info",
            "title": "Add DOT Number",
            "description": "Upload your DOT certificate to verify your company",
            "priority": "medium",
            "actions": ["Upload Document"],
            "icon": "fa-file"
        })
    
    # Check onboarding data for expiring documents
    onboarding_data_str = user.get("onboarding_data")
    if onboarding_data_str:
        try:
            from .onboarding import calculate_document_status
            onboarding_data = json.loads(onboarding_data_str)
            if isinstance(onboarding_data, dict):
                raw_docs = onboarding_data.get("documents", [])
                expiring_docs = []
                for doc in raw_docs:
                    expiry_date = doc.get("extracted_fields", {}).get("expiry_date")
                    if expiry_date and calculate_document_status(expiry_date) == "Expiring Soon":
                        expiring_docs.append(doc.get("filename", "Document"))
                
                if expiring_docs:
                    tasks.append({
                        "id": "task-expiring",
                        "type": "warning",
                        "title": "Documents Expiring Soon",
                        "description": f"{len(expiring_docs)} of your documents are expiring within 30 days",
                        "priority": "high",
                        "actions": ["View Documents"],
                        "icon": "fa-exclamation-triangle"
                    })
        except Exception as e:
            print(f"Error checking expiring documents: {e}")
    
    return tasks


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return int(default)
        return int(value)
    except Exception:
        return int(default)


_DRIVER_INSIGHTS_METRICS: Dict[str, Any] = {
    "rules_count": 0,
    "llm_count": 0,
    "errors_count": 0,
    "last_generated_at": 0.0,
    "last_source": None,
}


def _driver_doc_status_counts(required_items: List[Dict[str, Any]]) -> Dict[str, int]:
    counts = {"missing": 0, "expired": 0, "expiring_soon": 0, "valid_or_complete": 0}
    for it in required_items:
        status = str((it or {}).get("status") or "").strip().lower()
        kind = str((it or {}).get("kind") or "").strip().lower()
        if kind != "document":
            continue
        if status == "missing":
            counts["missing"] += 1
        elif status == "expired":
            counts["expired"] += 1
        elif status == "expiring soon":
            counts["expiring_soon"] += 1
        elif status in {"valid", "complete"}:
            counts["valid_or_complete"] += 1
    return counts


def _driver_collect_assigned_loads(uid: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    seen: set[str] = set()
    loads_ref = db.collection("loads")

    def _add_stream(stream) -> None:
        for snap in stream:
            d = snap.to_dict() or {}
            load_id = str(d.get("load_id") or snap.id or "").strip()
            if not load_id or load_id in seen:
                continue
            assigned_driver = str(
                d.get("assigned_driver") or d.get("assigned_driver_id") or d.get("driver_id") or ""
            ).strip()
            if assigned_driver != uid:
                continue
            d["load_id"] = load_id
            seen.add(load_id)
            rows.append(d)

    for field in ["assigned_driver", "assigned_driver_id", "driver_id"]:
        try:
            _add_stream(loads_ref.where(field, "==", uid).stream())
        except Exception:
            continue

    if not rows:
        try:
            _add_stream(loads_ref.stream())
        except Exception:
            pass

    def _sort_key(load: Dict[str, Any]) -> float:
        return _to_epoch_seconds(load.get("updated_at")) or _to_epoch_seconds(load.get("created_at")) or 0.0

    rows.sort(key=_sort_key, reverse=True)
    return rows


def _driver_provider_category(provider: Dict[str, Any]) -> str:
    raw = str(
        provider.get("category")
        or provider.get("service_type")
        or provider.get("type")
        or provider.get("tags")
        or ""
    ).lower()
    if any(x in raw for x in ["legal", "attorney", "law"]):
        return "legal"
    if any(x in raw for x in ["roadside", "repair", "tow", "wrench", "mechanic"]):
        return "roadside"
    if any(x in raw for x in ["parking", "lot"]):
        return "parking"
    if any(x in raw for x in ["fuel", "gas", "petrol", "diesel"]):
        return "fuel"
    return "other"


def _driver_dashboard_provider_cards(limit: int = 4) -> List[Dict[str, Any]]:
    wanted = ["legal", "roadside", "parking", "fuel"]
    best_by_cat: Dict[str, Dict[str, Any]] = {}
    fallback_names = {
        "legal": "Legal Help",
        "roadside": "Roadside",
        "parking": "Parking",
        "fuel": "Fuel",
    }

    try:
        snaps = list(db.collection("service_providers").stream())
    except Exception:
        snaps = []

    for snap in snaps:
        d = snap.to_dict() or {}
        category = _driver_provider_category(d)
        if category not in wanted:
            continue
        rating = float(d.get("rating") or 0.0)
        featured = bool(d.get("featured") is True)
        score = (1.0 if featured else 0.0) * 100.0 + rating
        current = best_by_cat.get(category)
        current_score = -1.0
        if current:
            current_score = float(current.get("_score") or -1.0)
        if score > current_score:
            best_by_cat[category] = {
                "id": str(d.get("id") or snap.id),
                "category": category,
                "name": str(d.get("name") or d.get("company_name") or fallback_names[category]),
                "rating": rating,
                "featured": featured,
                "action_label": "View Provider",
                "action_type": "nav",
                "action_target": "marketplace",
                "_score": score,
            }

    cards: List[Dict[str, Any]] = []
    for category in wanted:
        if category in best_by_cat:
            payload = dict(best_by_cat[category])
            payload.pop("_score", None)
            cards.append(payload)
        else:
            cards.append(
                {
                    "id": f"fallback_{category}",
                    "category": category,
                    "name": fallback_names[category],
                    "rating": 0.0,
                    "featured": False,
                    "action_label": "Browse Marketplace",
                    "action_type": "nav",
                    "action_target": "marketplace",
                }
            )
        if len(cards) >= max(1, int(limit or 4)):
            break
    return cards


def _priority_rank(priority: str) -> int:
    p = str(priority or "").strip().lower()
    if p == "high":
        return 0
    if p == "medium":
        return 1
    return 2


def _driver_humanize_status(raw_status: str, default: str = "Unknown") -> str:
    status = str(raw_status or "").strip().replace("_", " ").replace("-", " ")
    if not status:
        return default
    words = [w for w in status.split(" ") if w]
    if not words:
        return default
    return " ".join(w.capitalize() for w in words)


def _driver_location_label(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        city = str(value.get("city") or "").strip()
        state = str(value.get("state") or "").strip()
        if city or state:
            return ", ".join([x for x in [city, state] if x])
        name = str(value.get("name") or value.get("label") or "").strip()
        if name:
            return name
        address = str(value.get("address") or "").strip()
        if address:
            return address
    return ""


def _driver_pick_primary_load(loads: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not loads:
        return None
    status_rank = {
        "in_transit": 0,
        "in-transit": 0,
        "in transit": 0,
        "covered": 1,
        "assigned": 1,
        "accepted": 2,
        "booked": 2,
        "delivered": 3,
    }

    def _rank(load: Dict[str, Any]) -> tuple[int, float]:
        status = str(load.get("status") or "").strip().lower()
        rank = status_rank.get(status, 4)
        ts = _to_epoch_seconds(load.get("updated_at")) or _to_epoch_seconds(load.get("created_at")) or 0.0
        return (rank, -ts)

    return sorted(loads, key=_rank)[0]


def _driver_active_trip_payload(
    *,
    loads: List[Dict[str, Any]],
    in_transit_count: int,
    doc_counts: Dict[str, int],
    views_count: int,
    availability_on: bool,
) -> Dict[str, Any]:
    load = _driver_pick_primary_load(loads)
    if load:
        load_id = str(load.get("load_id") or load.get("id") or "").strip()
        status_raw = str(load.get("status") or "").strip().lower()
        status_label = _driver_humanize_status(status_raw, default="Assigned")
        origin = _driver_location_label(load.get("origin") or load.get("pickup_location"))
        destination = _driver_location_label(load.get("destination") or load.get("delivery_location"))
        route = " -> ".join([x for x in [origin, destination] if x]).strip()
        if not route:
            route = "Route pending"
        eta_raw = (
            load.get("eta")
            or load.get("delivery_datetime")
            or load.get("delivery_date")
            or load.get("pickup_datetime")
            or load.get("pickup_date")
        )
        eta = str(eta_raw).strip() if eta_raw is not None else ""
    else:
        load_id = ""
        status_raw = "idle"
        status_label = "No Active Load"
        route = "No active route assigned"
        eta = ""

    missing_docs = int(doc_counts.get("missing") or 0)
    expired_docs = int(doc_counts.get("expired") or 0)
    expiring_docs = int(doc_counts.get("expiring_soon") or 0)
    docs_attention = missing_docs + expired_docs + expiring_docs

    trip_stats: List[Dict[str, Any]] = []
    if in_transit_count > 0:
        trip_stats.append(
            {
                "id": "in_transit",
                "icon": "fa-solid fa-truck",
                "text": f"{in_transit_count} load(s) currently in transit",
            }
        )
    if docs_attention > 0:
        trip_stats.append(
            {
                "id": "docs_attention",
                "icon": "fa-solid fa-file-circle-exclamation",
                "text": f"{docs_attention} document item(s) need attention",
            }
        )
    if availability_on and views_count > 0:
        trip_stats.append(
            {
                "id": "marketplace_views",
                "icon": "fa-solid fa-eye",
                "text": f"{views_count} carrier profile view(s) this week",
            }
        )
    elif availability_on:
        trip_stats.append(
            {
                "id": "availability_on",
                "icon": "fa-solid fa-toggle-on",
                "text": "Availability is on and profile is discoverable",
            }
        )
    else:
        trip_stats.append(
            {
                "id": "availability_off",
                "icon": "fa-solid fa-toggle-off",
                "text": "Availability is off; carriers cannot discover your profile",
            }
        )

    return {
        "load_id": load_id,
        "status": status_raw or "idle",
        "status_label": status_label,
        "route": route,
        "eta": eta,
        "trip_stats": trip_stats[:3],
    }


def _driver_smart_alerts_payload(
    *,
    doc_counts: Dict[str, int],
    consent_eligible: bool,
    availability_on: bool,
    compliance_tasks_count: int,
) -> List[Dict[str, Any]]:
    missing_docs = int(doc_counts.get("missing") or 0)
    expired_docs = int(doc_counts.get("expired") or 0)
    expiring_docs = int(doc_counts.get("expiring_soon") or 0)

    alerts: List[Dict[str, Any]] = []

    def _add(
        *,
        aid: str,
        severity: str,
        title: str,
        detail: str,
        icon: str,
        action_type: str,
        action_target: str,
    ) -> None:
        alerts.append(
            {
                "id": aid,
                "severity": severity,
                "title": title,
                "detail": detail,
                "icon": icon,
                "action_type": action_type,
                "action_target": action_target,
            }
        )

    if expired_docs > 0:
        _add(
            aid="alert_docs_expired",
            severity="high",
            title="Expired Documents",
            detail=f"{expired_docs} required document(s) are expired.",
            icon="fa-solid fa-triangle-exclamation",
            action_type="nav",
            action_target="hiring",
        )
    if expiring_docs > 0:
        _add(
            aid="alert_docs_expiring",
            severity="medium",
            title="Documents Expiring Soon",
            detail=f"{expiring_docs} document(s) are expiring soon.",
            icon="fa-solid fa-hourglass-half",
            action_type="nav",
            action_target="hiring",
        )
    if missing_docs > 0:
        _add(
            aid="alert_docs_missing",
            severity="high",
            title="Missing Required Documents",
            detail=f"{missing_docs} required document(s) still missing.",
            icon="fa-solid fa-file-circle-xmark",
            action_type="nav",
            action_target="hiring",
        )
    if not consent_eligible:
        _add(
            aid="alert_consent_required",
            severity="high",
            title="Consent Required",
            detail="E-sign consent is required for full marketplace usage.",
            icon="fa-solid fa-pen",
            action_type="nav",
            action_target="esign",
        )
    if compliance_tasks_count > 0:
        _add(
            aid="alert_compliance_tasks",
            severity="medium",
            title="Compliance Tasks Pending",
            detail=f"{compliance_tasks_count} compliance task(s) need review.",
            icon="fa-solid fa-shield-halved",
            action_type="nav",
            action_target="compliance",
        )
    if not availability_on:
        _add(
            aid="alert_availability_off",
            severity="low",
            title="Marketplace Visibility Off",
            detail="Turn on availability to be visible to carriers.",
            icon="fa-solid fa-toggle-off",
            action_type="toggle_availability",
            action_target="availability",
        )
    if not alerts:
        _add(
            aid="alert_ready",
            severity="low",
            title="All Core Checks Healthy",
            detail="No urgent alerts right now. Keep profile and docs updated.",
            icon="fa-solid fa-circle-check",
            action_type="nav",
            action_target="settings",
        )

    return alerts[:4]


def _driver_daily_insights_payload(
    *,
    in_transit_count: int,
    doc_counts: Dict[str, int],
    compliance_tasks_count: int,
    availability_on: bool,
    views_count: int,
) -> List[Dict[str, Any]]:
    missing_docs = int(doc_counts.get("missing") or 0)
    expired_docs = int(doc_counts.get("expired") or 0)
    expiring_docs = int(doc_counts.get("expiring_soon") or 0)
    docs_attention = missing_docs + expired_docs + expiring_docs

    if in_transit_count > 0:
        tip_title = "Trip Focus"
        tip_text = f"Track ETA and stop windows for {in_transit_count} in-transit load(s)."
        tip_action_type = "nav"
        tip_action_target = "loads"
    elif availability_on and views_count <= 0:
        tip_title = "Visibility Tip"
        tip_text = "Availability is on but views are low. Refresh profile highlights."
        tip_action_type = "nav"
        tip_action_target = "settings"
    elif not availability_on:
        tip_title = "Marketplace Tip"
        tip_text = "Enable availability to appear in carrier discovery results."
        tip_action_type = "toggle_availability"
        tip_action_target = "availability"
    else:
        tip_title = "Profile Tip"
        tip_text = "Keep your profile and document set complete to improve match quality."
        tip_action_type = "nav"
        tip_action_target = "settings"

    if docs_attention > 0:
        recap_title = "Document Recap"
        recap_text = f"{docs_attention} document item(s) need review in onboarding."
        recap_action_type = "nav"
        recap_action_target = "hiring"
    elif compliance_tasks_count > 0:
        recap_title = "Compliance Recap"
        recap_text = f"{compliance_tasks_count} compliance task(s) are pending review."
        recap_action_type = "nav"
        recap_action_target = "compliance"
    else:
        recap_title = "Training Recap"
        recap_text = "Core compliance checks look healthy. Continue routine checks."
        recap_action_type = "nav"
        recap_action_target = "compliance"

    return [
        {
            "id": "insight_tip",
            "title": tip_title,
            "text": tip_text,
            "icon": "fa-solid fa-lightbulb",
            "variant": "tip",
            "action_type": tip_action_type,
            "action_target": tip_action_target,
        },
        {
            "id": "insight_recap",
            "title": recap_title,
            "text": recap_text,
            "icon": "fa-solid fa-graduation-cap",
            "variant": "recap",
            "action_type": recap_action_type,
            "action_target": recap_action_target,
        },
    ]


def _normalize_load_status(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "_")


def _collect_loads_with_filters(uid: str, fields: List[str]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    seen: set[str] = set()
    loads_ref = db.collection("loads")

    def _add_stream(stream, field_name: str) -> None:
        for snap in stream:
            d = snap.to_dict() or {}
            load_id = str(d.get("load_id") or snap.id or "").strip()
            if not load_id or load_id in seen:
                continue
            if field_name:
                owner = str(d.get(field_name) or "").strip()
                if owner != uid:
                    continue
            d["load_id"] = load_id
            seen.add(load_id)
            rows.append(d)

    for field in fields:
        try:
            _add_stream(loads_ref.where(field, "==", uid).stream(), field)
        except Exception:
            continue

    if rows:
        rows.sort(
            key=lambda load: _to_epoch_seconds(load.get("updated_at"))
            or _to_epoch_seconds(load.get("created_at"))
            or 0.0,
            reverse=True,
        )
    return rows


def _collect_shipper_loads(uid: str) -> List[Dict[str, Any]]:
    rows = _collect_loads_with_filters(uid, ["created_by", "shipper_id", "owner_uid"])
    if rows:
        return rows

    # Fallback for local/dev data store.
    try:
        fallback = store.list_loads({"created_by": uid})
        if isinstance(fallback, list):
            return [dict(x) for x in fallback if isinstance(x, dict)]
    except Exception:
        pass
    return []


def _collect_carrier_loads(uid: str) -> List[Dict[str, Any]]:
    rows = _collect_loads_with_filters(
        uid,
        ["assigned_carrier", "assigned_carrier_id", "carrier_id", "created_by"],
    )
    if rows:
        return rows

    # Fallback for local/dev data store.
    merged: Dict[str, Dict[str, Any]] = {}
    try:
        for item in store.list_loads({"assigned_carrier": uid}) or []:
            if isinstance(item, dict):
                lid = str(item.get("load_id") or item.get("id") or uuid.uuid4().hex)
                merged[lid] = dict(item)
        for item in store.list_loads({"created_by": uid}) or []:
            if isinstance(item, dict):
                lid = str(item.get("load_id") or item.get("id") or uuid.uuid4().hex)
                merged[lid] = dict(item)
    except Exception:
        pass
    return list(merged.values())


def _count_pending_offers(loads: List[Dict[str, Any]]) -> int:
    total = 0
    pending_states = {"pending", "offered", "submitted", "new"}
    for load in loads:
        offers = load.get("offers")
        if not isinstance(offers, list):
            continue
        for offer in offers:
            if not isinstance(offer, dict):
                continue
            status = _normalize_load_status(offer.get("status"))
            if status in pending_states:
                total += 1
    return total


def _load_route_pair(load: Dict[str, Any]) -> Tuple[str, str]:
    origin = _driver_location_label(load.get("origin") or load.get("pickup_location") or load.get("load_origin"))
    destination = _driver_location_label(
        load.get("destination") or load.get("delivery_location") or load.get("load_destination")
    )
    return (origin or "Unknown Origin", destination or "Unknown Destination")


def _top_lane(loads: List[Dict[str, Any]]) -> Tuple[str, int]:
    counts: Dict[str, int] = {}
    for load in loads:
        origin, destination = _load_route_pair(load)
        lane = f"{origin} -> {destination}"
        counts[lane] = int(counts.get(lane) or 0) + 1
    if not counts:
        return ("", 0)
    lane = sorted(counts.items(), key=lambda it: (-it[1], it[0]))[0]
    return (lane[0], int(lane[1]))


def _money_str(value: Any) -> str:
    try:
        amount = float(value or 0)
        return f"${amount:,.0f}"
    except Exception:
        return "$0"


def _carrier_rule_suggestions(
    *,
    active_count: int,
    in_transit_count: int,
    delivered_count: int,
    pending_dispatch_count: int,
    expiring_docs_count: int,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []

    def _add(
        sid: str,
        title: str,
        detail: str,
        action_label: str,
        action_target: str,
        priority: str = "medium",
        reason_codes: Optional[List[str]] = None,
    ) -> None:
        rows.append(
            {
                "id": sid,
                "title": title,
                "detail": detail,
                "priority": priority,
                "action_label": action_label,
                "action_type": "nav",
                "action_target": action_target,
                "reason_codes": reason_codes or [],
            }
        )

    if expiring_docs_count > 0:
        _add(
            "carrier_docs_expiring",
            "Compliance Renewal Needed",
            f"{expiring_docs_count} document(s) are expiring soon. Renew to avoid dispatch or billing blockers.",
            "Open Compliance",
            "compliance",
            priority="high",
            reason_codes=["DOC_EXPIRING"],
        )
    if pending_dispatch_count > 0:
        _add(
            "carrier_dispatch_followup",
            "Dispatch Follow-Up",
            f"{pending_dispatch_count} load(s) are waiting on assignment or acceptance updates.",
            "Open My Loads",
            "my-loads",
            priority="high",
            reason_codes=["PENDING_DISPATCH"],
        )
    if in_transit_count > 0:
        _add(
            "carrier_in_transit_watch",
            "In-Transit Monitoring",
            f"{in_transit_count} load(s) are currently in transit and need active tracking.",
            "Open My Loads",
            "my-loads",
            priority="medium",
            reason_codes=["LOAD_IN_TRANSIT"],
        )
    if delivered_count > 0:
        _add(
            "carrier_invoice_actions",
            "Invoice Follow-Up",
            f"{delivered_count} delivered load(s) can move into invoice or factoring workflows.",
            "Open Factoring",
            "factoring",
            priority="medium",
            reason_codes=["DELIVERED_READY_TO_INVOICE"],
        )
    if active_count == 0:
        _add(
            "carrier_no_active",
            "No Active Loads",
            "No active load operations detected. Review marketplace opportunities or dispatch plans.",
            "Open Marketplace",
            "marketplace",
            priority="low",
            reason_codes=["NO_ACTIVE_LOADS"],
        )
    if not rows:
        _add(
            "carrier_profile_tip",
            "Operations Healthy",
            "Core operations look stable. Keep compliance and dispatch workflows current.",
            "Open Dashboard",
            "home",
            priority="low",
            reason_codes=["HEALTHY_STATE"],
        )

    rows.sort(key=lambda s: (_priority_rank(str(s.get("priority"))), str(s.get("id") or "")))
    return rows[:5]


def _shipper_rule_suggestions(
    *,
    active_count: int,
    posted_count: int,
    in_transit_count: int,
    delivered_count: int,
    pending_offers_count: int,
    lane_label: str,
    lane_count: int,
    compliance_warning_count: int,
) -> Dict[str, Any]:
    rows: List[Dict[str, Any]] = []

    def _add(
        sid: str,
        title: str,
        detail: str,
        action_label: str,
        action_target: str,
        priority: str = "medium",
        reason_codes: Optional[List[str]] = None,
    ) -> None:
        rows.append(
            {
                "id": sid,
                "title": title,
                "detail": detail,
                "priority": priority,
                "action_label": action_label,
                "action_type": "nav",
                "action_target": action_target,
                "reason_codes": reason_codes or [],
            }
        )

    if pending_offers_count > 0:
        _add(
            "shipper_pending_offers",
            "Offer Review Needed",
            f"{pending_offers_count} carrier offer(s) are pending review.",
            "Open Carrier Bids",
            "carrier-bids",
            priority="high",
            reason_codes=["PENDING_OFFERS"],
        )
    if in_transit_count > 0:
        _add(
            "shipper_tracking_focus",
            "Tracking Focus",
            f"{in_transit_count} load(s) are in transit and should be monitored for exceptions.",
            "Open Tracking",
            "tracking",
            priority="medium",
            reason_codes=["IN_TRANSIT"],
        )
    if posted_count > 0 and pending_offers_count == 0:
        _add(
            "shipper_posted_no_offers",
            "Posted Loads Need Coverage",
            f"{posted_count} posted load(s) are waiting for carrier responses.",
            "Open Marketplace",
            "marketplace",
            priority="medium",
            reason_codes=["POSTED_NO_OFFERS"],
        )
    if compliance_warning_count > 0:
        _add(
            "shipper_compliance_alert",
            "Compliance Attention",
            f"{compliance_warning_count} compliance warning(s) require review.",
            "Open Compliance",
            "compliance",
            priority="medium",
            reason_codes=["COMPLIANCE_WARNINGS"],
        )
    if delivered_count > 0:
        _add(
            "shipper_billing_followup",
            "Billing Follow-Up",
            f"{delivered_count} delivered load(s) are ready for invoice workflow checks.",
            "Open Bills",
            "bills",
            priority="low",
            reason_codes=["DELIVERED_BILLING"],
        )
    if active_count == 0:
        _add(
            "shipper_no_active_loads",
            "No Active Loads",
            "Post or dispatch a new load to start marketplace and tracking workflows.",
            "Open My Loads",
            "my-loads",
            priority="low",
            reason_codes=["NO_ACTIVE_LOADS"],
        )
    if not rows:
        _add(
            "shipper_healthy",
            "Operations Healthy",
            "Load operations look stable. Continue monitoring bids, tracking, and compliance.",
            "Open Dashboard",
            "home",
            priority="low",
            reason_codes=["HEALTHY_STATE"],
        )

    rows.sort(key=lambda s: (_priority_rank(str(s.get("priority"))), str(s.get("id") or "")))
    rows = rows[:5]

    if lane_label and lane_count > 0:
        headline = f"Top lane demand: {lane_label} appears in {lane_count} load(s)."
    elif active_count > 0:
        headline = f"{active_count} active load(s) in your network right now."
    else:
        headline = "No active load lanes right now. Post new loads to increase carrier activity."

    bullets = [str(x.get("detail") or "").strip() for x in rows[:3] if str(x.get("detail") or "").strip()]
    return {
        "headline": headline,
        "bullets": bullets[:3],
        "ai_suggestions": rows,
    }


def _driver_build_rule_suggestions(
    *,
    missing_docs_count: int,
    expiring_docs_count: int,
    expired_docs_count: int,
    consent_eligible: bool,
    availability_on: bool,
    views_count: int,
    active_loads_count: int,
    in_transit_count: int,
    compliance_tasks_count: int,
) -> List[Dict[str, Any]]:
    suggestions: List[Dict[str, Any]] = []
    seen_ids: set[str] = set()

    def _add(
        sid: str,
        title: str,
        detail: str,
        priority: str,
        action_label: str,
        action_type: str,
        action_target: str,
        reason_codes: List[str],
    ) -> None:
        if sid in seen_ids:
            return
        seen_ids.add(sid)
        suggestions.append(
            {
                "id": sid,
                "title": title,
                "detail": detail,
                "priority": priority,
                "action_label": action_label,
                "action_type": action_type,
                "action_target": action_target,
                "reason_codes": reason_codes,
            }
        )

    if expired_docs_count > 0:
        _add(
            "expired_docs",
            "Urgent Document Renewal",
            f"{expired_docs_count} required document(s) are expired and may block opportunities.",
            "high",
            "Upload Documents",
            "nav",
            "hiring",
            ["DOC_EXPIRED"],
        )
    if expiring_docs_count > 0:
        _add(
            "expiring_docs",
            "Documents Expiring Soon",
            f"{expiring_docs_count} document(s) are expiring soon. Renew now to stay compliant.",
            "high",
            "Review Documents",
            "nav",
            "hiring",
            ["DOC_EXPIRING_SOON"],
        )
    if missing_docs_count > 0:
        _add(
            "missing_docs",
            "Complete Missing Documents",
            f"{missing_docs_count} required document(s) are missing.",
            "high",
            "Complete Onboarding",
            "nav",
            "hiring",
            ["DOC_MISSING"],
        )
    if not consent_eligible:
        _add(
            "consent_pending",
            "Consent Required",
            "Sign the required consent form to unlock marketplace actions.",
            "high",
            "Complete Consent",
            "nav",
            "esign",
            ["CONSENT_REQUIRED"],
        )
    if not availability_on:
        _add(
            "availability_off",
            "Turn On Availability",
            "Your profile is hidden from carriers while availability is off.",
            "medium",
            "Enable Availability",
            "toggle_availability",
            "availability",
            ["AVAILABILITY_OFF"],
        )
    if views_count <= 0:
        _add(
            "low_visibility",
            "Improve Marketplace Visibility",
            "No carrier profile views this week. Update profile and availability.",
            "medium",
            "Browse Marketplace",
            "nav",
            "marketplace",
            ["LOW_VIEWS"],
        )
    if in_transit_count > 0:
        _add(
            "active_trip_focus",
            "Active Trip Focus",
            f"You have {in_transit_count} load(s) currently in transit.",
            "medium",
            "Open My Loads",
            "nav",
            "loads",
            ["LOAD_IN_TRANSIT"],
        )
    if compliance_tasks_count > 0:
        _add(
            "compliance_tasks",
            "Compliance Tasks Pending",
            f"You have {compliance_tasks_count} compliance task(s) to review.",
            "medium",
            "Open Compliance",
            "nav",
            "compliance",
            ["COMPLIANCE_TASKS"],
        )
    if active_loads_count == 0 and availability_on and missing_docs_count == 0 and consent_eligible:
        _add(
            "marketplace_ready",
            "Marketplace Ready",
            "Your profile looks ready. Stay available to attract more carrier opportunities.",
            "low",
            "Browse Marketplace",
            "nav",
            "marketplace",
            ["READY_STATE"],
        )

    suggestions.sort(key=lambda s: (_priority_rank(str(s.get("priority"))), str(s.get("id") or "")))
    if len(suggestions) < 3:
        _add(
            "profile_tip",
            "Profile Tip",
            "Keep your profile, availability, and documents up to date for better matching.",
            "low",
            "Go to Profile",
            "nav",
            "settings",
            ["PROFILE_OPTIMIZATION"],
        )
        suggestions.sort(key=lambda s: (_priority_rank(str(s.get("priority"))), str(s.get("id") or "")))
    return suggestions[:5]


def _driver_try_llm_rewrite_suggestions(
    suggestions: List[Dict[str, Any]],
    context: Dict[str, Any],
) -> tuple[str, List[Dict[str, Any]]]:
    if not suggestions:
        return ("rules", suggestions)
    if not getattr(settings, "GROQ_API_KEY", ""):
        return ("rules", suggestions)

    try:
        import re
        from groq import Groq

        client = Groq(api_key=settings.GROQ_API_KEY)
        payload = {
            "instructions": [
                "Rewrite each suggestion title and detail in concise operational language for truck drivers.",
                "Preserve intent, urgency, and facts from the input context.",
                "Do not invent numbers, dates, or policy details.",
                "Return JSON only.",
            ],
            "schema": {
                "suggestions": [
                    {"id": "string", "title": "string", "detail": "string"}
                ]
            },
            "context": context,
            "suggestions": [
                {
                    "id": s.get("id"),
                    "title": s.get("title"),
                    "detail": s.get("detail"),
                    "priority": s.get("priority"),
                }
                for s in suggestions
            ],
        }

        resp = client.chat.completions.create(
            model=settings.GROQ_TEXT_MODEL,
            messages=[
                {"role": "system", "content": "You rewrite dashboard suggestions for clarity. Output JSON only."},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
            temperature=0.2,
            max_tokens=600,
        )
        text = (resp.choices[0].message.content or "").strip()
        if text.startswith("```"):
            text = text.strip("`").strip()
        match = re.search(r"\{[\s\S]*\}", text)
        raw = match.group(0) if match else text
        parsed = json.loads(raw)
        rows = parsed.get("suggestions") if isinstance(parsed, dict) else None
        if not isinstance(rows, list):
            return ("rules", suggestions)

        by_id = {str(s.get("id")): dict(s) for s in suggestions}
        for row in rows:
            if not isinstance(row, dict):
                continue
            sid = str(row.get("id") or "").strip()
            if not sid or sid not in by_id:
                continue
            title = str(row.get("title") or "").strip()
            detail = str(row.get("detail") or "").strip()
            if title:
                by_id[sid]["title"] = title[:120]
            if detail:
                by_id[sid]["detail"] = detail[:220]

        merged = [by_id[str(s.get("id"))] for s in suggestions if str(s.get("id")) in by_id]
        return ("llm", merged)
    except Exception:
        return ("rules", suggestions)


@app.get("/driver/dashboard/insights")
async def get_driver_dashboard_insights(user: Dict[str, Any] = Depends(get_current_user)):
    role = str(user.get("role") or "").strip().lower()
    if role != "driver":
        raise HTTPException(status_code=403, detail="Only drivers can access dashboard insights")

    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")

    now = time.time()
    driver_doc: Dict[str, Any] = {}
    try:
        snap = db.collection("drivers").document(uid).get()
        if snap.exists:
            driver_doc = snap.to_dict() or {}
    except Exception:
        driver_doc = {}

    availability_on = bool(driver_doc.get("is_available", user.get("is_available", False)))
    views_count = _safe_int(
        driver_doc.get("marketplace_views_count", user.get("marketplace_views_count", 0)),
        default=0,
    )

    required_items: List[Dict[str, Any]] = []
    consent_eligible = False
    doc_counts = {"missing": 0, "expired": 0, "expiring_soon": 0, "valid_or_complete": 0}
    try:
        from .onboarding import get_driver_required_docs

        docs_payload = await get_driver_required_docs(user=user)
        required_items = docs_payload.get("required") if isinstance(docs_payload.get("required"), list) else []
        consent_eligible = bool(((docs_payload.get("consent") or {}).get("eligible")))
        doc_counts = _driver_doc_status_counts(required_items)
    except Exception as e:
        print(f"[DriverInsights] Failed to read required docs: {e}")
        _DRIVER_INSIGHTS_METRICS["errors_count"] = int(_DRIVER_INSIGHTS_METRICS.get("errors_count") or 0) + 1

    loads = _driver_collect_assigned_loads(uid)
    active_loads_count = len(loads)
    in_transit_count = len(
        [
            l
            for l in loads
            if str(l.get("status") or "").strip().lower() in {"in_transit", "in-transit", "in transit"}
        ]
    )

    try:
        tasks = await get_compliance_tasks(user)
        compliance_tasks_count = len(tasks) if isinstance(tasks, list) else 0
    except Exception:
        compliance_tasks_count = 0
        _DRIVER_INSIGHTS_METRICS["errors_count"] = int(_DRIVER_INSIGHTS_METRICS.get("errors_count") or 0) + 1

    rule_suggestions = _driver_build_rule_suggestions(
        missing_docs_count=int(doc_counts.get("missing") or 0),
        expiring_docs_count=int(doc_counts.get("expiring_soon") or 0),
        expired_docs_count=int(doc_counts.get("expired") or 0),
        consent_eligible=consent_eligible,
        availability_on=availability_on,
        views_count=views_count,
        active_loads_count=active_loads_count,
        in_transit_count=in_transit_count,
        compliance_tasks_count=compliance_tasks_count,
    )
    source, ai_suggestions = _driver_try_llm_rewrite_suggestions(
        rule_suggestions,
        context={
            "views_count": views_count,
            "availability_on": availability_on,
            "missing_docs_count": int(doc_counts.get("missing") or 0),
            "expiring_docs_count": int(doc_counts.get("expiring_soon") or 0),
            "expired_docs_count": int(doc_counts.get("expired") or 0),
            "active_loads_count": active_loads_count,
            "in_transit_count": in_transit_count,
            "consent_eligible": consent_eligible,
            "compliance_tasks_count": compliance_tasks_count,
        },
    )
    if source == "llm":
        _DRIVER_INSIGHTS_METRICS["llm_count"] = int(_DRIVER_INSIGHTS_METRICS.get("llm_count") or 0) + 1
    else:
        _DRIVER_INSIGHTS_METRICS["rules_count"] = int(_DRIVER_INSIGHTS_METRICS.get("rules_count") or 0) + 1
    _DRIVER_INSIGHTS_METRICS["last_generated_at"] = now
    _DRIVER_INSIGHTS_METRICS["last_source"] = source

    providers = _driver_dashboard_provider_cards(limit=4)

    quick_actions: List[Dict[str, Any]] = []
    quick_ids: set[str] = set()

    def _add_action(
        *,
        aid: str,
        label: str,
        icon: str,
        action_type: str,
        action_target: str,
        priority: str = "medium",
    ) -> None:
        if aid in quick_ids:
            return
        quick_ids.add(aid)
        quick_actions.append(
            {
                "id": aid,
                "label": label,
                "icon": icon,
                "action_type": action_type,
                "action_target": action_target,
                "priority": priority,
            }
        )

    if int(doc_counts.get("missing") or 0) > 0 or int(doc_counts.get("expired") or 0) > 0:
        _add_action(
            aid="upload_missing_docs",
            label="Upload Missing Documents",
            icon="fa-solid fa-upload",
            action_type="nav",
            action_target="hiring",
            priority="high",
        )
    if not consent_eligible:
        _add_action(
            aid="complete_consent",
            label="Complete Consent",
            icon="fa-solid fa-pen",
            action_type="nav",
            action_target="esign",
            priority="high",
        )
    if not availability_on:
        _add_action(
            aid="enable_availability",
            label="Enable Availability",
            icon="fa-solid fa-toggle-on",
            action_type="toggle_availability",
            action_target="availability",
            priority="high",
        )
    if active_loads_count > 0:
        _add_action(
            aid="view_active_loads",
            label="View Active Loads",
            icon="fa-solid fa-truck",
            action_type="nav",
            action_target="loads",
            priority="medium",
        )
    _add_action(
        aid="browse_marketplace",
        label="Browse Marketplace",
        icon="fa-solid fa-store",
        action_type="nav",
        action_target="marketplace",
        priority="medium",
    )
    _add_action(
        aid="get_support",
        label="Get Support",
        icon="fa-solid fa-headset",
        action_type="open_support",
        action_target="support",
        priority="low",
    )
    quick_actions = quick_actions[:4]

    if views_count > 0:
        marketplace_summary = f"{views_count} carrier profile view(s) this week."
    elif availability_on:
        marketplace_summary = "Availability is ON. Keep profile and documents updated to improve discoverability."
    else:
        marketplace_summary = "No profile views this week. Turn on availability to be discovered by carriers."

    active_trip = _driver_active_trip_payload(
        loads=loads,
        in_transit_count=in_transit_count,
        doc_counts=doc_counts,
        views_count=views_count,
        availability_on=availability_on,
    )
    smart_alerts = _driver_smart_alerts_payload(
        doc_counts=doc_counts,
        consent_eligible=consent_eligible,
        availability_on=availability_on,
        compliance_tasks_count=compliance_tasks_count,
    )
    daily_insights = _driver_daily_insights_payload(
        in_transit_count=in_transit_count,
        doc_counts=doc_counts,
        compliance_tasks_count=compliance_tasks_count,
        availability_on=availability_on,
        views_count=views_count,
    )

    logger.info(
        "[DriverInsights] uid=%s source=%s suggestions=%s views=%s active_loads=%s in_transit=%s missing_docs=%s expiring_docs=%s expired_docs=%s smart_alerts=%s",
        uid,
        source,
        len(ai_suggestions or []),
        views_count,
        active_loads_count,
        in_transit_count,
        int(doc_counts.get("missing") or 0),
        int(doc_counts.get("expiring_soon") or 0),
        int(doc_counts.get("expired") or 0),
        len(smart_alerts or []),
    )

    return {
        "generated_at": now,
        "source": source,
        "ai_suggestions": ai_suggestions,
        "active_trip": active_trip,
        "smart_alerts": smart_alerts,
        "daily_insights": daily_insights,
        "marketplace_activity": {
            "views_count": views_count,
            "availability_on": availability_on,
            "active_loads_count": active_loads_count,
            "in_transit_loads_count": in_transit_count,
            "missing_docs_count": int(doc_counts.get("missing") or 0),
            "expiring_docs_count": int(doc_counts.get("expiring_soon") or 0),
            "expired_docs_count": int(doc_counts.get("expired") or 0),
            "summary": marketplace_summary,
        },
        "service_providers": providers,
        "quick_actions": quick_actions,
        "emergency_action": {
            "id": "emergency_assist",
            "label": "Emergency Assist",
            "action_type": "open_support",
            "action_target": "support",
        },
    }


@app.get("/admin/driver-dashboard/insights-metrics")
async def get_driver_dashboard_insights_metrics(user: Dict[str, Any] = Depends(require_admin)):
    _ = user
    return {
        "metrics": {
            "rules_count": int(_DRIVER_INSIGHTS_METRICS.get("rules_count") or 0),
            "llm_count": int(_DRIVER_INSIGHTS_METRICS.get("llm_count") or 0),
            "errors_count": int(_DRIVER_INSIGHTS_METRICS.get("errors_count") or 0),
            "last_generated_at": float(_DRIVER_INSIGHTS_METRICS.get("last_generated_at") or 0.0),
            "last_source": _DRIVER_INSIGHTS_METRICS.get("last_source"),
        }
    }


@app.get("/carrier/analytics")
async def get_carrier_analytics(
    time_range: str = "Last 30 Days",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    user: Dict[str, Any] = Depends(get_current_user),
):
    role = str(user.get("role") or "").strip().lower()
    if role != "carrier":
        raise HTTPException(status_code=403, detail="Only carriers can access carrier analytics")

    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")

    start_ts, end_ts, normalized_range = _parse_time_range(
        time_range=time_range,
        start_date=start_date,
        end_date=end_date,
    )

    loads = _collect_carrier_loads(uid)

    def _load_activity_ts(load: Dict[str, Any]) -> Optional[float]:
        """Best-effort timestamp to decide whether a load belongs in the requested range.

        Prefer business-relevant dates (delivery/pickup) over metadata timestamps.
        """

        # If delivered, use the actual delivery time.
        delivered_ts = _to_epoch_seconds(load.get("delivered_at"))
        if delivered_ts is None:
            delivered_ts = _to_epoch_seconds(load.get("completed_at"))
        if delivered_ts is not None:
            return float(delivered_ts)

        # Otherwise use scheduled dates.
        for key in (
            "delivery_datetime",
            "delivery_date",
            "pickup_datetime",
            "pickup_date",
        ):
            ts = _to_epoch_seconds(load.get(key))
            if ts is not None:
                return float(ts)

        # Fall back to metadata timestamps.
        ts = _to_epoch_seconds(load.get("updated_at")) or _to_epoch_seconds(load.get("created_at"))
        return float(ts) if ts is not None else None

    def in_range(ts: Optional[float]) -> bool:
        if ts is None:
            return False
        return float(start_ts) <= float(ts) <= float(end_ts)

    scoped: List[Dict[str, Any]] = []
    for load in loads:
        ts = _load_activity_ts(load)
        if in_range(ts):
            scoped.append(load)

    tendered_count = 0
    accepted_count = 0
    delivered_count = 0
    on_time_total = 0
    on_time_yes = 0
    rpm_rate_total = 0.0
    rpm_miles_total = 0.0
    rpu_values: List[float] = []

    accepted_states = {
        LoadStatus.ACCEPTED.value,
        LoadStatus.COVERED.value,
        LoadStatus.IN_TRANSIT.value,
        LoadStatus.DELIVERED.value,
        LoadStatus.COMPLETED.value,
    }
    accepted_states.add("settled")
    delivered_states = {LoadStatus.DELIVERED.value, LoadStatus.COMPLETED.value, "settled"}

    ot_buckets: Dict[str, Dict[str, int]] = {}
    region_counts: Dict[str, int] = {}
    status_counts: Dict[str, int] = {}

    for load in scoped:
        status = str(load.get("status") or "").strip().lower() or "unknown"
        if status != LoadStatus.DRAFT.value:
            tendered_count += 1

        if status in accepted_states:
            accepted_count += 1

        if status in delivered_states:
            delivered_count += 1

        status_counts[status] = int(status_counts.get(status) or 0) + 1

        dest_state = _extract_state(
            load.get("destination") or load.get("delivery_location") or load.get("load_destination")
        )
        region_counts[dest_state] = int(region_counts.get(dest_state) or 0) + 1

        delivered_at = _to_epoch_seconds(load.get("delivered_at"))
        if delivered_at is None:
            delivered_at = _to_epoch_seconds(load.get("completed_at"))

        if delivered_at is not None and in_range(delivered_at):
            eta_raw = load.get("delivery_date") or load.get("delivery_datetime") or load.get("eta")
            eta_ts = _to_epoch_seconds(eta_raw)
            if eta_ts is not None:
                try:
                    if isinstance(eta_raw, str) and len(eta_raw.strip()) <= 10:
                        eta_dt = datetime.fromisoformat(eta_raw.strip()).replace(tzinfo=timezone.utc)
                        eta_ts = float((eta_dt + timedelta(days=1, seconds=-1)).timestamp())
                except Exception:
                    pass

                on_time_total += 1
                is_on_time = float(delivered_at) <= float(eta_ts)
                if is_on_time:
                    on_time_yes += 1

                day = datetime.fromtimestamp(float(delivered_at), tz=timezone.utc).date().isoformat()
                bucket = ot_buckets.setdefault(day, {"delivered": 0, "on_time": 0})
                bucket["delivered"] += 1
                if is_on_time:
                    bucket["on_time"] += 1

        if status in delivered_states:
            total_rate = _load_total_rate(load)
            miles = None
            try:
                miles = float(
                    load.get("estimated_distance")
                    or load.get("distance_miles")
                    or load.get("miles")
                    or load.get("distance")
                    or 0.0
                )
            except Exception:
                miles = None
            if total_rate is not None:
                rpu_values.append(float(total_rate))
                if miles and miles > 0:
                    rpm_rate_total += float(total_rate)
                    rpm_miles_total += float(miles)

    on_time_pct = (float(on_time_yes) / float(on_time_total) * 100.0) if on_time_total > 0 else 0.0
    avg_rpm = (float(rpm_rate_total) / float(rpm_miles_total)) if rpm_miles_total > 0 else 0.0
    avg_rpu = (sum(rpu_values) / len(rpu_values)) if rpu_values else 0.0

    on_time_series: List[Dict[str, Any]] = []
    for day in sorted(ot_buckets.keys()):
        d = ot_buckets[day]
        delivered = int(d.get("delivered") or 0)
        on_time = int(d.get("on_time") or 0)
        pct = (float(on_time) / float(delivered) * 100.0) if delivered > 0 else 0.0
        on_time_series.append({"date": day, "on_time_pct": round(pct, 2), "delivered": delivered})

    region_rows = sorted(region_counts.items(), key=lambda it: (-int(it[1] or 0), it[0]))
    top = region_rows[:8]
    other_total = sum(int(v or 0) for _, v in region_rows[8:])
    loads_by_region = [{"region": k, "loads": int(v)} for k, v in top]
    if other_total > 0:
        loads_by_region.append({"region": "Other", "loads": int(other_total)})

    load_distribution = [
        {"status": k, "loads": int(v)}
        for k, v in sorted(status_counts.items(), key=lambda it: (-int(it[1] or 0), it[0]))
    ]

    return {
        "time_range": normalized_range,
        "start_ts": float(start_ts),
        "end_ts": float(end_ts),
        "stats": {
            "loads_tendered": int(tendered_count),
            "accepted": int(accepted_count),
            "delivered": int(delivered_count),
            "on_time_percent": float(round(on_time_pct, 2)),
            "on_time_percent_label": _format_pct(on_time_pct),
            "avg_rpm": float(round(avg_rpm, 4)),
            "avg_rpm_label": f"${avg_rpm:,.2f}",
            "avg_rpu": float(round(avg_rpu, 2)),
            "avg_rpu_label": f"${avg_rpu:,.0f}",
            "loads_in_range": int(len(scoped)),
        },
        "charts": {
            "on_time_series": on_time_series,
            "loads_by_region": loads_by_region,
            "load_distribution": load_distribution,
        },
    }


@app.get("/carrier/dashboard/insights")
async def get_carrier_dashboard_insights(user: Dict[str, Any] = Depends(get_current_user)):
    role = str(user.get("role") or "").strip().lower()
    if role != "carrier":
        raise HTTPException(status_code=403, detail="Only carriers can access carrier dashboard insights")

    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")

    now = time.time()
    loads = _collect_carrier_loads(uid)

    active_states = {"posted", "tendered", "covered", "accepted", "assigned", "dispatched", "in_transit"}
    in_transit_states = {"in_transit"}
    delivered_states = {"delivered", "completed", "settled"}
    pending_dispatch_states = {"posted", "tendered", "covered", "assigned"}

    active_count = 0
    in_transit_count = 0
    delivered_count = 0
    pending_dispatch_count = 0
    total_open_value = 0.0

    for load in loads:
        status = _normalize_load_status(load.get("status"))
        if status in active_states:
            active_count += 1
            total_open_value += float(load.get("total_rate") or load.get("linehaul_rate") or load.get("rate") or 0.0)
        if status in in_transit_states:
            in_transit_count += 1
        if status in delivered_states:
            delivered_count += 1
        if status in pending_dispatch_states:
            pending_dispatch_count += 1

    expiring_docs_count = 0
    try:
        compliance = await get_compliance_status_dashboard(user)
        documents = compliance.get("documents") if isinstance(compliance.get("documents"), list) else []
        expiring_docs_count = len(
            [d for d in documents if str(d.get("status") or "").strip().lower() in {"expired", "expiring soon"}]
        )
    except Exception as e:
        logger.warning("[CarrierInsights] compliance read failed uid=%s err=%s", uid, e)

    suggestions = _carrier_rule_suggestions(
        active_count=active_count,
        in_transit_count=in_transit_count,
        delivered_count=delivered_count,
        pending_dispatch_count=pending_dispatch_count,
        expiring_docs_count=expiring_docs_count,
    )

    logger.info(
        "[CarrierInsights] uid=%s suggestions=%s active=%s in_transit=%s delivered=%s pending_dispatch=%s expiring_docs=%s",
        uid,
        len(suggestions or []),
        active_count,
        in_transit_count,
        delivered_count,
        pending_dispatch_count,
        expiring_docs_count,
    )

    return {
        "generated_at": now,
        "source": "rules",
        "ai_suggestions": suggestions,
        "summary": {
            "active_loads": active_count,
            "in_transit_loads": in_transit_count,
            "delivered_loads": delivered_count,
            "pending_dispatch_loads": pending_dispatch_count,
            "expiring_documents_count": expiring_docs_count,
            "open_loads_value": total_open_value,
            "open_loads_value_label": _money_str(total_open_value),
        },
    }


@app.get("/shipper/dashboard/insights")
async def get_shipper_dashboard_insights(user: Dict[str, Any] = Depends(get_current_user)):
    role = str(user.get("role") or "").strip().lower()
    if role not in {"shipper", "broker"}:
        raise HTTPException(status_code=403, detail="Only shippers can access shipper dashboard insights")

    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")

    now = time.time()
    loads = _collect_shipper_loads(uid)

    active_states = {"posted", "tendered", "covered", "accepted", "awarded", "dispatched", "in_transit"}
    posted_states = {"posted", "tendered"}
    in_transit_states = {"in_transit"}
    delivered_states = {"delivered", "completed", "settled"}

    active_rows = [l for l in loads if _normalize_load_status(l.get("status")) in active_states]
    active_count = len(active_rows)
    posted_count = len([l for l in loads if _normalize_load_status(l.get("status")) in posted_states])
    in_transit_count = len([l for l in loads if _normalize_load_status(l.get("status")) in in_transit_states])
    delivered_count = len([l for l in loads if _normalize_load_status(l.get("status")) in delivered_states])
    pending_offers_count = _count_pending_offers(loads)
    lane_label, lane_count = _top_lane(active_rows if active_rows else loads)

    compliance_warning_count = 0
    try:
        compliance = await get_compliance_status_dashboard(user)
        warnings = compliance.get("warnings") if isinstance(compliance.get("warnings"), list) else []
        compliance_warning_count = len(warnings)
    except Exception as e:
        logger.warning("[ShipperInsights] compliance read failed uid=%s err=%s", uid, e)

    built = _shipper_rule_suggestions(
        active_count=active_count,
        posted_count=posted_count,
        in_transit_count=in_transit_count,
        delivered_count=delivered_count,
        pending_offers_count=pending_offers_count,
        lane_label=lane_label,
        lane_count=lane_count,
        compliance_warning_count=compliance_warning_count,
    )

    market_insights: List[Dict[str, Any]] = []
    if lane_label and lane_count > 0:
        market_insights.append(
            {
                "id": "shipper_top_lane",
                "title": "Top Lane",
                "detail": f"{lane_label} currently appears in {lane_count} load(s).",
                "action_type": "nav",
                "action_target": "marketplace",
            }
        )
    if pending_offers_count > 0:
        market_insights.append(
            {
                "id": "shipper_pending_offers",
                "title": "Pending Offers",
                "detail": f"{pending_offers_count} offer(s) waiting for review.",
                "action_type": "nav",
                "action_target": "carrier-bids",
            }
        )
    if delivered_count > 0:
        market_insights.append(
            {
                "id": "shipper_delivered_followup",
                "title": "Delivered Follow-Up",
                "detail": f"{delivered_count} delivered load(s) are ready for post-delivery billing checks.",
                "action_type": "nav",
                "action_target": "bills",
            }
        )

    logger.info(
        "[ShipperInsights] uid=%s suggestions=%s active=%s posted=%s in_transit=%s delivered=%s pending_offers=%s lane=%s lane_count=%s",
        uid,
        len(built.get("ai_suggestions") or []),
        active_count,
        posted_count,
        in_transit_count,
        delivered_count,
        pending_offers_count,
        lane_label or "",
        lane_count,
    )

    return {
        "generated_at": now,
        "source": "rules",
        "ai_insights": {
            "headline": built.get("headline"),
            "bullets": built.get("bullets") or [],
        },
        "ai_suggestions": built.get("ai_suggestions") or [],
        "market_insights": market_insights[:3],
        "summary": {
            "active_loads": active_count,
            "posted_loads": posted_count,
            "in_transit_loads": in_transit_count,
            "delivered_loads": delivered_count,
            "pending_offers": pending_offers_count,
            "top_lane": lane_label,
            "top_lane_count": lane_count,
            "compliance_warning_count": compliance_warning_count,
        },
    }


@app.post("/compliance/ai-analyze")
async def compliance_ai_analyze(
    payload: Dict[str, Any] = Body(default={}),
    user: dict = Depends(get_current_user),
):
    """Run an AI-assisted compliance & safety analysis for the current user.

    The Driver dashboard expects JSON shaped like:
      {"analysis": {"risk_level": "low|medium|high", "summary": "..."}}

    Uses Groq text model if configured; otherwise returns a deterministic rules-based summary.
    """

    # Reuse existing endpoints for a single source of truth.
    status = await get_compliance_status_dashboard(user)
    tasks = await get_compliance_tasks(user)

    score = int(status.get("compliance_score") or 0)
    warnings = status.get("warnings") or []
    issues = status.get("issues") or []
    role_data = status.get("role_data") or {}

    # Rules-based baseline (always available)
    risk_level = "low"
    if score < 50:
        risk_level = "high"
    elif score < 80:
        risk_level = "medium"

    # Escalate risk if there are expired docs.
    if any(isinstance(w, str) and "expired" in w.lower() for w in warnings):
        risk_level = "high"

    # Provide a concise baseline summary.
    missing_bits: List[str] = []
    if not (role_data.get("cdl_number") or "").strip():
        missing_bits.append("CDL")
    if not (role_data.get("medical_card_expiry") or "").strip():
        missing_bits.append("Medical card")
    if (role_data.get("mvr_status") or "pending") != "passed":
        missing_bits.append("MVR")
    if (role_data.get("clearinghouse_status") or "pending") != "passed":
        missing_bits.append("Clearinghouse consent")

    baseline_summary_parts: List[str] = [
        f"Compliance score is {score}%. Risk level: {risk_level}.",
    ]
    if missing_bits:
        baseline_summary_parts.append("Missing/incomplete: " + ", ".join(missing_bits) + ".")
    if warnings:
        baseline_summary_parts.append("Warnings: " + "; ".join(str(w) for w in warnings[:3]) + ("…" if len(warnings) > 3 else ""))
    if tasks:
        baseline_summary_parts.append(f"Open tasks: {len(tasks)}.")
    baseline_summary = " ".join(baseline_summary_parts)

    baseline_findings: List[str] = []
    # Prefer explicit issues/warnings first
    for it in list(issues)[:3]:
        if isinstance(it, str) and it.strip():
            baseline_findings.append(it.strip())
    for it in list(warnings)[:3]:
        if isinstance(it, str) and it.strip() and it.strip() not in baseline_findings:
            baseline_findings.append(it.strip())
    if not baseline_findings:
        baseline_findings = ["No critical issues detected from current documents."]

    baseline_next_actions: List[str] = []
    if not (role_data.get("cdl_number") or "").strip():
        baseline_next_actions.append("Upload your CDL document")
    if not (role_data.get("medical_card_expiry") or "").strip():
        baseline_next_actions.append("Upload your DOT Medical Certificate")
    if (role_data.get("mvr_status") or "pending") != "passed":
        baseline_next_actions.append("Upload your MVR (Motor Vehicle Record)")
    if (role_data.get("clearinghouse_status") or "pending") != "passed":
        baseline_next_actions.append("Upload your Clearinghouse consent form")
    if not baseline_next_actions and tasks:
        # Convert tasks into action-oriented items
        for t in tasks[:3]:
            title = (t or {}).get("title") if isinstance(t, dict) else None
            if title:
                baseline_next_actions.append(str(title))
    if not baseline_next_actions:
        baseline_next_actions = ["No immediate actions required. Keep documents up to date."]

    # If Groq isn't configured, return baseline.
    try:
        from .settings import settings

        if not getattr(settings, "GROQ_API_KEY", ""):
            return {
                "analysis": {
                    "risk_level": risk_level,
                    "summary": baseline_summary,
                    "top_findings": baseline_findings,
                    "next_actions": baseline_next_actions,
                    "action_items": tasks,
                    "generated_by": "rules",
                }
            }
    except Exception:
        return {
            "analysis": {
                "risk_level": risk_level,
                "summary": baseline_summary,
                "top_findings": baseline_findings,
                "next_actions": baseline_next_actions,
                "action_items": tasks,
                "generated_by": "rules",
            }
        }

    # Groq-backed summary
    try:
        import re
        from groq import Groq
        from .settings import settings

        def _parse_json(text: str) -> Dict[str, Any]:
            cleaned = (text or "").strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.strip("`").strip()
            match = re.search(r"\{[\s\S]*\}", cleaned)
            raw = match.group(0) if match else cleaned
            return json.loads(raw)

        # Provide a minimized context (avoid echoing full IDs/PII).
        safe_role = {
            "cdl_state": role_data.get("cdl_state"),
            "cdl_class": role_data.get("cdl_class"),
            "cdl_expiry": role_data.get("cdl_expiry"),
            "medical_card_expiry": role_data.get("medical_card_expiry"),
            "drug_test_status": role_data.get("drug_test_status"),
            "mvr_status": role_data.get("mvr_status"),
            "clearinghouse_status": role_data.get("clearinghouse_status"),
        }

        system = (
            "You are a compliance & safety assistant for a trucking platform. "
            "You review compliance status and produce concise, actionable guidance. "
            "Return ONLY valid JSON."
        )
        user_msg = {
            "schema": {
                "analysis": {
                    "risk_level": "low|medium|high",
                    "summary": "string (2-5 sentences)",
                    "top_findings": ["string"],
                    "next_actions": ["string"],
                }
            },
            "input": {
                "compliance_score": score,
                "status_color": status.get("status_color"),
                "issues": issues,
                "warnings": warnings,
                "documents": [
                    {
                        "document_type": d.get("document_type"),
                        "status": d.get("status"),
                        "expiry_date": d.get("expiry_date"),
                        "missing_fields": bool(d.get("missing_fields")),
                    }
                    for d in (status.get("documents") or [])
                ],
                "driver": safe_role,
                "tasks": tasks,
            },
            "rules": [
                "Be conservative: if documents are expired or expiring soon, elevate risk.",
                "Do not include any personal identifiers or license numbers.",
                "If info is missing, say what to upload/complete next.",
            ],
        }

        client = Groq(api_key=settings.GROQ_API_KEY)
        resp = client.chat.completions.create(
            model=settings.GROQ_TEXT_MODEL,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(user_msg, ensure_ascii=False)},
            ],
            temperature=0.2,
            max_tokens=512,
        )
        text = resp.choices[0].message.content or ""
        out = _parse_json(text)
        analysis = out.get("analysis") if isinstance(out, dict) else None
        if not isinstance(analysis, dict):
            raise ValueError("Groq response missing analysis JSON")

        # Enforce UI-required keys
        analysis.setdefault("risk_level", risk_level)
        analysis.setdefault("summary", baseline_summary)
        analysis.setdefault("top_findings", baseline_findings)
        analysis.setdefault("next_actions", baseline_next_actions)
        return {"analysis": {**analysis, "generated_by": "groq"}}
    except Exception as e:
        print(f"[compliance/ai-analyze] Falling back to rules-based analysis: {e}")
        return {
            "analysis": {
                "risk_level": risk_level,
                "summary": baseline_summary,
                "top_findings": baseline_findings,
                "next_actions": baseline_next_actions,
                "action_items": tasks,
                "generated_by": "rules",
            }
        }

@app.post("/documents")
async def upload_document(
    file: UploadFile = File(...),
    document_type: str = Form(None),
    user: Dict[str, Any] = Depends(get_current_user)
):
    """Upload and classify a document, save to user's Firebase profile and Storage."""
    allowed_extensions = ['.pdf', '.jpg', '.jpeg', '.png']
    file_ext = os.path.splitext(file.filename)[1].lower() if file.filename else ''
    
    if not file_ext or file_ext not in allowed_extensions:
        raise HTTPException(status_code=400, detail="Only PDF, JPG, JPEG, and PNG files are supported")

    data = await file.read()
    
    # Determine content type
    content_type_map = {
        '.pdf': 'application/pdf',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png'
    }
    content_type = content_type_map.get(file_ext, 'application/octet-stream')
    
    # Upload to Firebase Storage
    uid = user['uid']
    doc_id = str(uuid.uuid4())
    storage_path = f"documents/{uid}/{doc_id}_{file.filename}"
    download_url = None
    
    try:
        blob = bucket.blob(storage_path)
        blob.upload_from_string(data, content_type=content_type)
        blob.make_public()
        download_url = blob.public_url
        print(f"✅ File uploaded to Firebase Storage: {storage_path}")
    except Exception as e:
        error_msg = str(e)
        print(f"❌ Error uploading to Firebase Storage: {error_msg}")
        # Continue processing even if storage fails - will store metadata without URL
        print(f"⚠️ Continuing without Firebase Storage URL...")
        download_url = None
    
    # Process document - handle PDFs and images differently
    try:
        if file_ext == '.pdf':
            images = pdf_to_images(data)
            if not images:
                raise ValueError("No pages rendered from PDF")
            plain_text = pdf_to_text(data)
        else:
            # For image files, use the image directly
            images = [data]
            plain_text = ""  # No text extraction for images
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Document processing failed: {e}")

    pre_data = preextract_fields(plain_text or "")
    
    try:
        detection = detect_document_type(images, (plain_text or "")[:2000], pre_data.get("signals", {}))
        raw_detection = dict(detection)
        detected_type = detection.get("document_type", "OTHER")
        extraction = extract_document(images, detected_type, plain_text or "", pre_data.get("prefill", {}))
        raw_extraction = dict(extraction)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Vision extraction failed: {e}")

    if not extraction.get("text"):
        extraction["text"] = plain_text or ""

    extraction = enrich_extraction(extraction, plain_text)
    classification = resolve_document_type(detection, extraction, plain_text, pre_data.get("signals"))
    doc_type_upper = classification.get("document_type", detected_type or "OTHER").upper()
    extraction["document_type"] = doc_type_upper
    validation = validate_document(extraction, doc_type_upper, store=store)
    score_snapshot = score_onboarding(extraction, validation)

    usdot, mc_number = _extract_identifiers(extraction)
    fmcsa_summary = None
    if usdot or mc_number:
        fmcsa_summary = _attempt_fmcsa_verify(usdot, mc_number)

    coach = compute_coach_plan(
        document=extraction,
        validation=validation,
        verification=fmcsa_summary,
    )
    
    # Logic: If no user (guest), create a temp guest ID
    if user:
        owner_id = user['uid']
    else:
        owner_id = f"guest_{uuid.uuid4().hex[:8]}"

    record = {
        "id": doc_id,
        "owner_id": owner_id,
        "filename": file.filename,
        "doc_type": doc_type_upper,
        "storage_path": storage_path,  # Add Firebase Storage path
        "download_url": download_url,  # Add public download URL
        "detection": detection,
        "extraction": extraction,
        "classification": classification,
        "validation": validation,
        "score": score_snapshot,
        "fmcsa_verification": fmcsa_summary,
        "coach_plan": coach,
        "_debug": {
            "detection_raw": raw_detection,
            "extraction_raw": raw_extraction,
            "preextract": pre_data,
        },
    }

    try:
        chunks = build_document_chunks(doc_id, extraction.get("text") or "", record["doc_type"])
        store.upsert_document_chunks(doc_id, chunks)
        record["chunk_count"] = len(chunks)
    except Exception:
        record["chunk_count"] = 0

    # Save to local storage
    store.save_document(record)
    
    # Save to Firebase user document - add to documents array
    try:
        uid = user['uid']
        user_ref = db.collection("users").document(uid)
        
        # Fetch existing onboarding data to preserve documents array
        existing_user = user_ref.get().to_dict() if user_ref.get().exists else {}
        existing_onboarding_data = existing_user.get("onboarding_data")
        
        # Parse existing onboarding data if it exists
        if existing_onboarding_data and isinstance(existing_onboarding_data, str):
            try:
                existing_data = json.loads(existing_onboarding_data)
            except:
                existing_data = {}
        else:
            existing_data = {}
        
        # Extract the expiry date from extraction for status calculation
        expiry_date = extraction.get("expiry_date") or extraction.get("extracted_fields", {}).get("expiry_date")
        
        # Get all extracted fields from the extraction result
        all_extracted_fields = {}
        for key, value in extraction.items():
            # Skip metadata fields and keep only actual extracted data
            if key not in ['text', 'document_type'] and value is not None:
                all_extracted_fields[key] = value
        
        # Create document record for the documents array
        doc_record = {
            "doc_id": doc_id,
            "filename": file.filename,
            "storage_path": storage_path,
            "download_url": download_url,
            "submitted_type": (document_type or "").strip().lower() or None,
            "uploaded_at": time.time(),
            "extracted_fields": {
                "document_type": doc_type_upper,
                "expiry_date": expiry_date,
                **all_extracted_fields  # Include all other extracted fields
            },
            "score": score_snapshot,
            "validation_status": validation.get("status"),
            "missing": validation.get("issues", [])
        }
        
        # Append to documents array
        docs_array = existing_data.get("documents", [])
        docs_array.append(doc_record)
        existing_data["documents"] = docs_array
        
        # Calculate overall onboarding score from all documents
        total_score = 0
        valid_docs = 0
        for doc in docs_array:
            doc_score = doc.get("score", 0)
            if isinstance(doc_score, dict):
                doc_score = (
                    doc_score.get("total_score")
                    or doc_score.get("total")
                    or doc_score.get("score")
                    or doc_score.get("value")
                    or 0
                )
            if doc_score > 0:
                total_score += doc_score
                valid_docs += 1
        
        overall_score = int(total_score / valid_docs) if valid_docs > 0 else 0
        
        # Update user document with new documents array and updated score
        user_ref.update({
            "onboarding_data": json.dumps(existing_data),
            "onboarding_score": overall_score,
            "updated_at": time.time()
        })
        
        print(f"📊 Updated onboarding score: {overall_score}% (from {valid_docs} documents)")
        
        log_action(uid, "DOCUMENT_UPLOAD", f"Document uploaded: {file.filename} (Type: {doc_type_upper})")
    except Exception as e:
        print(f"Warning: Could not save document to Firebase: {e}")
        # Don't fail the upload, continue with local storage
    
    return {
        "document_id": doc_id,
        "doc_type": record["doc_type"],
        "filename": file.filename,
        "download_url": download_url,
        "storage_path": storage_path,
        "confidence": classification.get("confidence"),
        "chunks_indexed": record.get("chunk_count", 0),
        "validation": {
            "status": validation.get("status"),
            "issues": validation.get("issues"),
        },
        "score": score_snapshot,
        "fmcsa_verification": fmcsa_summary,
        "coach": coach,
        "extraction": extraction 
    }


@app.get("/documents/{document_id}")
def get_document(document_id: str, user: dict = Depends(get_current_user)):
    doc = store.get_document(document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


@app.get("/documents")
async def list_user_documents(user: Dict[str, Any] = Depends(get_current_user)):
    """Get all documents for the current user from Firebase."""
    try:
        uid = user['uid']
        user_ref = db.collection("users").document(uid)
        user_doc = user_ref.get()
        
        if not user_doc.exists:
            return {"documents": []}
        
        user_data = user_doc.to_dict()
        onboarding_data_str = user_data.get("onboarding_data", "{}")
        
        # Parse onboarding data
        try:
            onboarding_data = json.loads(onboarding_data_str) if isinstance(onboarding_data_str, str) else onboarding_data_str
        except:
            onboarding_data = {}
        
        documents = onboarding_data.get("documents", [])
        
        return {
            "documents": documents,
            "total": len(documents)
        }
    except Exception as e:
        print(f"Error fetching documents: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch documents: {str(e)}")


# --- RAG CHAT ENDPOINT (Logged In) ---
@app.post("/chat")
def chat(req: ChatRequest):
    from .vision import chat_answer

    all_chunks = store.get_all_chunks()
    topk = retrieve(all_chunks, req.query, k=5)
    if not topk:
        context = "No context available yet. Answer briefly."
        sources: List[Dict[str, Any]] = []
    else:
        parts: List[str] = []
        sources = []
        for score, ch in topk:
            parts.append(ch.get("content", ""))
            sources.append({
                "document_id": ch.get("document_id"),
                "chunk_index": ch.get("chunk_index"),
                "score": round(float(score), 4),
            })
        context = "\n\n---\n\n".join(parts)[: req.max_context_chars]

    answer = chat_answer(req.query, context)
    store.append_chat({"query": req.query, "answer": answer, "sources": sources})
    return {"answer": answer, "sources": sources}


# --- NEW: LANDING PAGE CHATBOT (Public) ---
@app.post("/chat/onboarding", response_model=ChatResponse)
def onboarding_chat(req: InteractiveChatRequest):
    """
    Stateful chatbot endpoint for Landing Page.
    """
    doc_event = None
    if req.attached_document_id:
        doc_event = {"document_id": req.attached_document_id}

    response = process_onboarding_chat(
        session_id=req.session_id, 
        user_text=req.message,
        doc_event=doc_event,
        store=store 
    )
    return response


@app.get("/onboarding/score/{document_id}")
def onboarding_score(document_id: str):
    doc = store.get_document(document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    normalized = doc.get("extraction", {})
    validation = doc.get("validation")
    result = score_onboarding(normalized, validation)
    return result

# --- NEW: COACH STATUS ENDPOINT FOR DASHBOARD (WEEK 2 FEATURE) ---
@app.get("/onboarding/coach-status")
def get_onboarding_coach_status(user: dict = Depends(get_current_user)):
    """
    Retrieves the latest compliance score, FMCSA status, and next best actions for the user.
    """
    try:
        uid = user['uid']
        
        # 1. Find the user's latest uploaded document associated with their ID
        # Check if method exists, otherwise return default response
        if not hasattr(store, 'get_latest_document_by_owner'):
            # Return a baseline status if method not available
            return {
                "is_ready": True,
                "status_color": "Green",
                "total_score": 100,
                "document_type": "N/A",
                "next_best_actions": [],
                "fmcsa_status": "Active"
            }
        
        latest_doc = store.get_latest_document_by_owner(uid)
        
        if not latest_doc:
            # If no document is uploaded yet, return a baseline status
            return {
                "is_ready": False,
                "status_color": "Red",
                "total_score": 0,
                "document_type": "None",
                "next_best_actions": ["Start the chatbot to upload your first document (CDL/MC Cert)."],
                "fmcsa_status": "N/A"
            }

        # 2. Recalculate score and NBA using the stored data
        extraction = latest_doc.get("extraction", {})
        validation = latest_doc.get("validation", {})
        
        # This calls score_onboarding which generates NBA and total_score
        coach_data = score_onboarding(extraction, validation)
        
        # 3. Retrieve FMCSA Status from the stored record
        fmcsa_verification = latest_doc.get('fmcsa_verification', {})
        fmcsa_result = fmcsa_verification.get('result', 'Pending')

        # 4. Determine status color for the badge
        score = coach_data['total_score']
        status_color = "Red"
        if score >= 90:
            status_color = "Green"
        elif score >= 50:
            status_color = "Amber"
            
        return {
            "document_id": latest_doc['id'],
            "is_ready": score >= 90,
            "status_color": status_color,
            "fmcsa_status": fmcsa_result,
            **coach_data
        }
    except Exception as e:
        print(f"Error in coach-status endpoint: {e}")
        # Return graceful fallback response instead of 500 error
        return {
            "is_ready": True,
            "status_color": "Green",
            "total_score": 100,
            "document_type": "N/A",
            "next_best_actions": [],
            "fmcsa_status": "Active"
        }


# --- COMPLIANCE STATUS ENDPOINTS FOR DASHBOARD ---
@app.get("/compliance/status")
async def get_compliance_status_dashboard(user: dict = Depends(get_current_user)):
    """
    Compliance status endpoint for dashboard.
    Returns DOT/MC numbers, compliance score, and document information.
    """
    from .onboarding import calculate_document_status
    
    uid = user['uid']
    onboarding_score = user.get("onboarding_score", 0)
    dot_number = user.get("dot_number", "")
    mc_number = user.get("mc_number", "")
    company_name = user.get("company_name", "")
    
    # Parse documents from onboarding_data
    documents = []
    onboarding_data_str = user.get("onboarding_data")
    onboarding_data: Dict[str, Any] = {}

    # Helper: safely pick a non-empty string-ish value
    def _pick_str(d: Any, *keys: str) -> str:
        if not isinstance(d, dict):
            return ""
        for k in keys:
            v = d.get(k)
            if v is None:
                continue
            if isinstance(v, (dict, list)):
                continue
            s = str(v).strip()
            if s and s.lower() not in {"none", "null", "nan"}:
                return s
        return ""

    def _safe_doc_type(doc: Dict[str, Any]) -> str:
        submitted = (doc.get("submitted_type") or "").strip().upper()
        extracted = (doc.get("extracted_fields") or {}).get("document_type")
        extracted = str(extracted or "").strip().upper()
        return extracted or submitted

    def _uploaded_at(doc: Dict[str, Any]) -> float:
        try:
            return float(doc.get("uploaded_at") or 0)
        except Exception:
            return 0.0

    def _latest_doc(raw_docs: List[Dict[str, Any]], wanted_types: List[str]) -> Dict[str, Any]:
        wanted = {t.strip().upper() for t in (wanted_types or []) if t}
        matches = [d for d in raw_docs if _safe_doc_type(d) in wanted]
        matches.sort(key=_uploaded_at, reverse=True)
        return matches[0] if matches else {}
    
    try:
        # Handle None/null values from Firebase
        if not onboarding_data_str:
            onboarding_data = {}
        elif isinstance(onboarding_data_str, str):
            onboarding_data = json.loads(onboarding_data_str)
        elif isinstance(onboarding_data_str, dict):
            onboarding_data = onboarding_data_str
        else:
            onboarding_data = {}
        
        if isinstance(onboarding_data, dict):
            raw_docs = onboarding_data.get("documents", []) or []
            if not isinstance(raw_docs, list):
                raw_docs = []
            
            # Calculate score from documents (always) so score updates when docs are replaced.
            if len(raw_docs) > 0:
                total_score = 0
                valid_docs = 0
                for doc in raw_docs:
                    doc_score = doc.get("score", 0)
                    if isinstance(doc_score, dict):
                        doc_score = (
                            doc_score.get("total_score")
                            or doc_score.get("total")
                            or doc_score.get("score")
                            or doc_score.get("value")
                            or 0
                        )
                    try:
                        doc_score_num = float(doc_score)
                    except Exception:
                        doc_score_num = 0
                    if doc_score_num > 0:
                        total_score += doc_score_num
                        valid_docs += 1

                if valid_docs > 0:
                    computed = int(total_score / valid_docs)
                    if computed != int(onboarding_score or 0):
                        onboarding_score = computed
                        print(f"📊 Calculated onboarding score from documents: {onboarding_score}% (from {valid_docs} documents)")
                        # Update Firebase with calculated score (best-effort)
                        try:
                            user_ref = db.collection("users").document(uid)
                            user_ref.update({"onboarding_score": onboarding_score})
                            print("✅ Updated user onboarding_score in Firebase")
                        except Exception as update_error:
                            print(f"⚠️ Could not update onboarding_score: {update_error}")
            
            for doc in raw_docs:
                status = "Unknown"
                if doc.get("extracted_fields", {}).get("expiry_date"):
                    status = calculate_document_status(
                        doc["extracted_fields"]["expiry_date"]
                    )
                
                documents.append({
                    "id": doc.get("doc_id", ""),
                    "file_name": doc.get("filename", ""),
                    "document_type": doc.get("extracted_fields", {}).get("document_type", "OTHER"),
                    "expiry_date": doc.get("extracted_fields", {}).get("expiry_date"),
                    "score": doc.get("score", 0),
                    "status": status,
                    "uploaded_at": doc.get("uploaded_at"),
                    "file_url": doc.get("download_url"),  # Firebase Storage public URL
                    "storage_path": doc.get("storage_path"),
                    "extracted_fields": doc.get("extracted_fields", {}),
                    "missing_fields": doc.get("missing", [])
                })
    except Exception as e:
        print(f"Error parsing onboarding data: {e}")

    # --- Derive driver compliance fields for UI ---
    # Prefer explicit user profile fields, but backfill from extracted docs.
    raw_docs_for_pick: List[Dict[str, Any]] = []
    try:
        if isinstance(onboarding_data, dict):
            v = onboarding_data.get("documents", []) or []
            raw_docs_for_pick = v if isinstance(v, list) else []
    except Exception:
        raw_docs_for_pick = []

    cdl_doc = _latest_doc(raw_docs_for_pick, ["CDL"])
    med_doc = _latest_doc(raw_docs_for_pick, ["MEDICAL"])
    mvr_doc = _latest_doc(raw_docs_for_pick, ["MVR"])
    clearinghouse_doc = _latest_doc(raw_docs_for_pick, ["CLEARINGHOUSE_CONSENT"])

    cdl_ext = cdl_doc.get("extracted_fields") or {}
    med_ext = med_doc.get("extracted_fields") or {}

    # Map extraction field names (license_number/issuing_state) -> UI contract (cdl_number/cdl_state)
    cdl_number = (user.get("cdl_number") or "").strip() if isinstance(user.get("cdl_number"), str) else ""
    if not cdl_number:
        cdl_number = _pick_str(cdl_ext, "cdl_number", "license_number", "licenseNumber")

    cdl_state = (user.get("cdl_state") or "").strip() if isinstance(user.get("cdl_state"), str) else ""
    if not cdl_state:
        cdl_state = _pick_str(cdl_ext, "cdl_state", "issuing_state", "issuingState", "state")

    cdl_class = (user.get("cdl_class") or "").strip() if isinstance(user.get("cdl_class"), str) else ""
    if not cdl_class:
        cdl_class = _pick_str(cdl_ext, "cdl_class", "class", "cdlClass")

    cdl_expiry = _pick_str(cdl_ext, "cdl_expiry", "cdl_expiry_date", "expiry_date", "expiration_date")
    medical_card_expiry = _pick_str(med_ext, "medical_card_expiry", "medical_cert_expiration", "expiry_date", "expiration_date")

    # Statuses: allow explicit user fields, else infer from presence of docs.
    def _status_from_doc(doc: Dict[str, Any]) -> str:
        if not doc:
            return "pending"
        ext = doc.get("extracted_fields") or {}
        exp = ext.get("expiry_date")
        if exp:
            try:
                st = calculate_document_status(exp)
                if st == "Expired":
                    return "pending"
            except Exception:
                pass
        return "passed"

    drug_test_status = (user.get("drug_test_status") or "").strip().lower() if isinstance(user.get("drug_test_status"), str) else ""
    drug_test_status = drug_test_status or "pending"

    mvr_status = (user.get("mvr_status") or "").strip().lower() if isinstance(user.get("mvr_status"), str) else ""
    mvr_status = mvr_status or _status_from_doc(mvr_doc)

    clearinghouse_status = (user.get("clearinghouse_status") or "").strip().lower() if isinstance(user.get("clearinghouse_status"), str) else ""
    clearinghouse_status = clearinghouse_status or _status_from_doc(clearinghouse_doc)

    # Basic warnings/issues/recommendations derived from document statuses.
    issues: List[str] = []
    warnings: List[str] = []
    recommendations: List[str] = []

    for d in documents:
        dtype = d.get("document_type") or "Document"
        st = d.get("status") or "Unknown"
        missing = d.get("missing_fields") or []
        if missing:
            issues.append(f"{dtype}: missing required fields")
        if st == "Expired":
            warnings.append(f"{dtype}: expired")
        elif st == "Expiring Soon":
            warnings.append(f"{dtype}: expiring soon")

    if not cdl_doc:
        recommendations.append("Upload your CDL to complete driver credential verification")
    if not med_doc:
        recommendations.append("Upload your DOT Medical Certificate to improve safety compliance")
    if not mvr_doc:
        recommendations.append("Upload your MVR to complete driver record verification")
    if not clearinghouse_doc:
        recommendations.append("Upload your Clearinghouse consent form to complete DOT drug query authorization")
    
    # Determine status color
    if onboarding_score >= 80:
        status_color = "Green"
    elif onboarding_score >= 50:
        status_color = "Amber"
    else:
        status_color = "Red"
    
    return {
        "compliance_score": int(onboarding_score),
        "is_compliant": onboarding_score >= 80,
        "dot_number": dot_number,
        "mc_number": mc_number,
        "company_name": company_name,
        "status_color": status_color,
        "documents": documents,
        "score_breakdown": {
            "document_completeness": int(onboarding_score * 0.4),
            "data_accuracy": int(onboarding_score * 0.3),
            "regulatory_compliance": int(onboarding_score * 0.3)
        },
        "issues": issues,
        "warnings": warnings,
        "recommendations": recommendations,
        # UI contract expects flat keys directly on role_data
        "role_data": {
            "cdl_number": cdl_number,
            "cdl_state": cdl_state,
            "cdl_class": cdl_class,
            "cdl_expiry": cdl_expiry,
            "medical_card_expiry": medical_card_expiry,
            "drug_test_status": drug_test_status,
            "mvr_status": mvr_status,
            "clearinghouse_status": clearinghouse_status,
            # Keep nested groups for backwards compatibility / future expansion
            "carrier": {
                "dot_number": dot_number,
                "mc_number": mc_number,
            },
            "driver": {
                "license_verified": bool(cdl_number),
            },
            "shipper": {
                "company_verified": bool(company_name),
            },
        },
    }


def _coerce_percent(value: Any) -> Optional[int]:
    """Coerce a value like 15, "15", "15%" to an int percentile (0-100)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            iv = int(round(float(value)))
        except Exception:
            return None
        return iv if 0 <= iv <= 100 else None
    try:
        s = str(value).strip()
    except Exception:
        return None
    if not s or s.lower() in {"n/a", "na", "none", "null"}:
        return None
    s = s.replace("%", "").strip()
    try:
        iv = int(round(float(s)))
    except Exception:
        return None
    return iv if 0 <= iv <= 100 else None


def _pick_first(d: Any, keys: list[str]) -> Any:
    if not isinstance(d, dict):
        return None
    for k in keys:
        if k in d and d.get(k) is not None:
            return d.get(k)
    return None


def _derive_fmcsa_basics(basics_raw: Any) -> Dict[str, Any]:
    """Best-effort extraction of BASIC percentile/threshold values from FMCSA basics payload."""
    # If FMCSA returns a list of BASIC objects, normalize into a dict by name.
    basics_dict: Dict[str, Any] = {}
    if isinstance(basics_raw, list):
        for item in basics_raw:
            if not isinstance(item, dict):
                continue
            name = str(item.get("basic") or item.get("name") or item.get("basicName") or "").strip().lower()
            if not name:
                continue
            basics_dict[name] = item
    elif isinstance(basics_raw, dict):
        basics_dict = basics_raw

    def _find_for_category(category_aliases: list[str]) -> Dict[str, Optional[int]]:
        # 1) Look for explicit keys in a flat dict (common patterns)
        if isinstance(basics_dict, dict):
            candidates: list[tuple[list[str], list[str]]] = []
            for a in category_aliases:
                base = a.replace(" ", "").replace("/", "").replace("-", "").lower()
                candidates.append(
                    (
                        [
                            f"{base}_percentile",
                            f"{base}Percentile",
                            f"{base}_pct",
                            f"{base}Pct",
                            f"{base}_score",
                            f"{base}Score",
                        ],
                        [
                            f"{base}_threshold",
                            f"{base}Threshold",
                            f"{base}_intervention_threshold",
                            f"{base}InterventionThreshold",
                        ],
                    )
                )

            # Extra known variants from some FMCSA/SMS payloads
            known_variants = {
                "hos": (["hosPercentile", "hoursOfServicePercentile", "hours_of_service_percentile"], ["hosThreshold", "hoursOfServiceThreshold", "hours_of_service_threshold"]),
                "unsafe": (["unsafeDrivingPercentile", "unsafe_driving_percentile"], ["unsafeDrivingThreshold", "unsafe_driving_threshold"]),
                "maintenance": (["vehicleMaintenancePercentile", "vehicle_maintenance_percentile"], ["vehicleMaintenanceThreshold", "vehicle_maintenance_threshold"]),
                "crash": (["crashIndicatorPercentile", "crash_indicator_percentile"], ["crashIndicatorThreshold", "crash_indicator_threshold"]),
                "drug": (["drugAlcoholPercentile", "drug_alcohol_percentile", "drugsAlcoholPercentile"], ["drugAlcoholThreshold", "drug_alcohol_threshold", "drugsAlcoholThreshold"]),
                "hazmat": (["hazmatPercentile", "hazmat_percentile"], ["hazmatThreshold", "hazmat_threshold"]),
            }
            for alias in category_aliases:
                if alias in known_variants:
                    p_keys, t_keys = known_variants[alias]
                    candidates.insert(0, (p_keys, t_keys))

            percentile = None
            threshold = None
            for p_keys, t_keys in candidates:
                if percentile is None:
                    percentile = _coerce_percent(_pick_first(basics_dict, p_keys))
                if threshold is None:
                    threshold = _coerce_percent(_pick_first(basics_dict, t_keys))
                if percentile is not None or threshold is not None:
                    break

            # 2) If basics_dict is keyed by BASIC name, try those nested objects
            if percentile is None and threshold is None:
                for alias in category_aliases:
                    nested = basics_dict.get(alias) if isinstance(basics_dict, dict) else None
                    if not isinstance(nested, dict):
                        continue
                    percentile = _coerce_percent(
                        _pick_first(nested, ["percentile", "Percentile", "pct", "score", "value"])
                    )
                    threshold = _coerce_percent(
                        _pick_first(nested, ["threshold", "Threshold", "interventionThreshold"])
                    )
                    if percentile is not None or threshold is not None:
                        break

            return {"percentile": percentile, "threshold": threshold}

        return {"percentile": None, "threshold": None}

    derived = {
        "hos": _find_for_category(["hos", "hours of service", "hours_of_service"]),
        "unsafe": _find_for_category(["unsafe", "unsafe driving", "unsafe_driving"]),
        "maintenance": _find_for_category(["maintenance", "vehicle maintenance", "vehicle_maintenance"]),
        "crash": _find_for_category(["crash", "crash indicator", "crash_indicator"]),
        "drug": _find_for_category(["drug", "drugs/alcohol", "drugs_alcohol", "drug/alcohol", "drug_alcohol"]),
        "hazmat": _find_for_category(["hazmat", "haz mat", "hm"]),
    }
    return derived


def _append_daily_basics_snapshot(history: Any, derived: Dict[str, Any], now_ts: float) -> list[Dict[str, Any]]:
    day = datetime.fromtimestamp(float(now_ts), tz=timezone.utc).date().isoformat()
    items: list[Dict[str, Any]] = history if isinstance(history, list) else []

    # Replace the snapshot for this day if present, else append.
    replaced = False
    for i, item in enumerate(items):
        if isinstance(item, dict) and item.get("day") == day:
            items[i] = {"day": day, "derived": derived}
            replaced = True
            break
    if not replaced:
        items.append({"day": day, "derived": derived})

    # Keep only the most recent 90 days.
    def _day_key(it: Dict[str, Any]) -> str:
        try:
            return str(it.get("day") or "")
        except Exception:
            return ""
    items.sort(key=_day_key)
    return items[-90:]


@app.get("/compliance/basic-scores")
async def get_compliance_basic_scores(user: dict = Depends(get_current_user)):
    """Return BASIC scores and trend history for the authenticated carrier."""
    uid = user.get("uid")
    dot_number = (user.get("dot_number") or "").strip()

    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")

    if not dot_number:
        return {
            "success": True,
            "usdot": None,
            "as_of": datetime.now(timezone.utc).isoformat(),
            "raw_basics": None,
            "derived": {},
            "history": [],
        }

    user_ref = db.collection("users").document(str(uid))
    doc = user_ref.get().to_dict() or {}

    raw_basics = doc.get("fmcsa_basics_latest")
    derived = doc.get("fmcsa_basics_derived_latest") if isinstance(doc.get("fmcsa_basics_derived_latest"), dict) else None
    history = doc.get("fmcsa_basics_history") if isinstance(doc.get("fmcsa_basics_history"), list) else []

    # If nothing cached yet, fetch live (best-effort).
    if raw_basics is None:
        try:
            client = _get_fmcsa_client()
            raw_basics = client.get_basics(dot_number)
        except Exception:
            raw_basics = None

    if derived is None:
        derived = _derive_fmcsa_basics(raw_basics)

    # Best-effort cache.
    try:
        now_ts = time.time()
        history2 = _append_daily_basics_snapshot(history, derived, now_ts) if derived else history
        user_ref.set(
            {
                "fmcsa_basics_latest": raw_basics,
                "fmcsa_basics_derived_latest": derived,
                "fmcsa_basics_last_fetched_at": now_ts,
                "fmcsa_basics_history": history2,
                "updated_at": now_ts,
            },
            merge=True,
        )
        history = history2
    except Exception:
        pass

    return {
        "success": True,
        "usdot": dot_number,
        "as_of": datetime.now(timezone.utc).isoformat(),
        "raw_basics": raw_basics,
        "derived": derived,
        "history": history,
    }


@app.get("/fmcsa/{usdot}")
def get_fmcsa(usdot: str):
    profile = store.get_fmcsa_profile(usdot)
    if profile:
        return profile
    client = _get_fmcsa_client()
    fetched = client.fetch_profile(usdot)
    if not fetched:
        raise HTTPException(status_code=404, detail="Profile not found")
    profile_dict = profile_to_dict(fetched)
    store.save_fmcsa_profile(profile_dict)
    return profile_dict


@app.post("/fmcsa/verify")
async def fmcsa_verify(
    req: FmcsaVerifyRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """Verify FMCSA information for a carrier."""
    try:
        # Validate that at least one identifier is provided
        if not req.usdot and not req.mc_number:
            raise HTTPException(
                status_code=400, 
                detail="Provide at least a USDOT or MC number"
            )
        
        client = _get_fmcsa_client()
        result = client.verify(req.usdot, req.mc_number)

        # Extract commonly needed fields from FMCSA sections (best-effort; may be absent)
        sections = (result or {}).get("sections") or {}
        carrier_sec = sections.get("carrier") if isinstance(sections, dict) else None
        authority_sec = sections.get("authority") if isinstance(sections, dict) else None
        basics_sec = sections.get("basics") if isinstance(sections, dict) else None

        def _pick(d: Any, *keys: str):
            if not isinstance(d, dict):
                return None
            for k in keys:
                v = d.get(k)
                if v is None:
                    continue
                s = str(v).strip() if not isinstance(v, (dict, list)) else None
                return v if (isinstance(v, (dict, list)) or (s and s.lower() != "none")) else None
            return None

        authority_status = _pick(authority_sec, "status", "commonAuthorityStatus", "authorityStatus")
        operating_authority = _pick(authority_sec, "authorityType", "operatingAuthority", "operating_authority", "authority")
        safety_rating = (
            _pick(carrier_sec, "safetyRating", "safety_rating", "safety_rating_desc", "safety")
            or _pick(basics_sec, "safetyRating", "safety_rating")
        )
        dot_status = _pick(carrier_sec, "status", "carrierStatus", "operatingStatus", "dotStatus", "dot_status")

        # Persist basics for carrier dashboard (best-effort).
        try:
            uid = user.get("uid")
            if uid:
                derived_basics = _derive_fmcsa_basics(basics_sec)
                user_ref = db.collection("users").document(str(uid))
                before_doc = user_ref.get().to_dict() or {}
                history = before_doc.get("fmcsa_basics_history") if isinstance(before_doc.get("fmcsa_basics_history"), list) else []
                now_ts = time.time()
                history2 = _append_daily_basics_snapshot(history, derived_basics, now_ts)
                user_ref.set(
                    {
                        "fmcsa_basics_latest": basics_sec,
                        "fmcsa_basics_derived_latest": derived_basics,
                        "fmcsa_basics_last_fetched_at": now_ts,
                        "fmcsa_basics_history": history2,
                        "updated_at": now_ts,
                    },
                    merge=True,
                )
        except Exception:
            pass
        
        # Save verification result
        store.save_fmcsa_verification(result)
        
        # Fetch and save profile if available
        try:
            profile = client.fetch_profile(result.get("usdot", req.usdot))
            if profile:
                store.save_fmcsa_profile(profile_to_dict(profile))
        except Exception as e:
            print(f"Profile fetch failed (non-critical): {e}")
        
        return {
            "success": True,
            "result": result.get("result"),
            "reasons": result.get("reasons", []),
            "usdot": result.get("usdot"),
            "mc_number": result.get("mc_number"),
            "fetched_at": result.get("fetched_at"),

            # Best-effort extra fields for UI chips (may be null)
            "authority_status": authority_status,
            "operating_authority": operating_authority,
            "safety_rating": safety_rating,
            "dot_status": dot_status,
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        print(f"FMCSA verification error: {exc}")
        raise HTTPException(
            status_code=502, 
            detail=f"FMCSA verification failed: {str(exc)}"
        )


@app.post("/fmcsa/refresh-all")
def fmcsa_refresh_all():
    client = _get_fmcsa_client()
    docs = store.list_documents()
    seen: set[str] = set()
    entries: List[Dict[str, Any]] = []
    for doc in docs:
        extraction = doc.get("extraction", {})
        usdot, mc_number = _extract_identifiers(extraction)
        key = usdot or mc_number
        if not key or key in seen:
            continue
        seen.add(key)
        try:
            verification = client.verify(usdot, mc_number)
            store.save_fmcsa_verification(verification)
            profile = client.fetch_profile(verification["usdot"])
            if profile:
                store.save_fmcsa_profile(profile_to_dict(profile))
            entries.append({"key": key, "result": verification["result"]})
        except Exception as exc:
            entries.append({"key": key, "error": str(exc)})
    return {"processed": len(entries), "entries": entries}


@app.get("/onboarding/coach/{document_id}")
def onboarding_coach(document_id: str):
    doc = store.get_document(document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    validation = doc.get("validation") or {}
    verification = doc.get("fmcsa_verification")
    coach_plan = compute_coach_plan(doc.get("extraction", {}), validation, verification)
    return coach_plan


@app.get("/forms/driver-registration")
def get_driver_registration_draft():
    draft = autofill_driver_registration(store)
    return draft


@app.get("/forms/clearinghouse-consent")
def get_clearinghouse_consent_draft():
    draft = autofill_clearinghouse_consent(store)
    return draft


@app.get("/forms/mvr-release")
def get_mvr_release_draft():
    draft = autofill_mvr_release(store)
    return draft


@app.post("/match")
def match(req: MatchRequest):
    load_dict = req.load.dict()
    carriers = [c.dict() for c in req.carriers]
    results = match_load(
        load_dict,
        carriers,
        top_n=req.top_n,
        min_compliance=req.min_compliance,
        require_fmcsa=req.require_fmcsa,
    )
    return {
        "matches": [
            {
                "carrier_id": r.carrier_id,
                "score": r.score,
                "reasons": r.reasons,
                "carrier": r.carrier,
            }
            for r in results
        ]
    }


# ============================================================================
# 3-STEP LOAD WIZARD ENDPOINTS (New Implementation)
# ============================================================================

@app.post("/loads/step1", response_model=LoadStep1Response)
async def create_load_step1(
    data: LoadStep1Create,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Step 1: Create load with Route & Equipment data.
    Generates Load ID and saves initial load data.
    """
    uid = user['uid']
    user_role = user.get('role', 'carrier')

    ownership = normalized_fields_for_new_load(creator_uid=uid, creator_role=user_role)
    
    # Generate unique Load ID (internal) + human-friendly Load Number (public)
    load_id = generate_load_id(region="ATL", user_code=None)
    load_number = generate_load_number(region="ATL", db_client=db)
    
    # Prepare complete load object with Step 1 data
    load_data = {
        "load_id": load_id,
        "load_number": load_number,
        "created_by": uid,
        "creator_role": user_role,  # Track who created this load
        "created_at": time.time(),
        "updated_at": time.time(),
        "status": LoadStatus.DRAFT.value,

        # Normalized ownership
        **ownership,
        
        # Step 1 data
        "origin": data.origin,
        "destination": data.destination,
        "pickup_date": data.pickup_date,
        "delivery_date": data.delivery_date,
        "pickup_appointment_type": data.pickup_appointment_type.value if data.pickup_appointment_type else None,
        "delivery_appointment_type": data.delivery_appointment_type.value if data.delivery_appointment_type else None,
        "additional_routes": data.additional_routes or [],  # Store additional routes
        "equipment_type": data.equipment_type.value,
        "load_type": data.load_type.value if data.load_type else None,
        "weight": data.weight,
        "pallet_count": data.pallet_count,
        
        # Placeholders for Steps 2 & 3
        "rate_type": None,
        "linehaul_rate": None,
        "fuel_surcharge": None,
        "advanced_charges": [],
        "commodity": None,
        "special_requirements": [],
        "payment_terms": None,
        "notes": None,
        "visibility": None,
        "selected_carriers": [],
        "auto_match_ai": True,
        "instant_booking": False,
        "auto_post_to_freightpower": True,
        "auto_post_to_truckstop": False,
        "auto_post_to_123loadboard": False,
        "notify_on_carrier_views": True,
        "notify_on_offer_received": True,
        "notify_on_load_covered": True,
        
        "metadata": {}
    }
    
    # Save to storage (both JSON and Firestore)
    store.save_load(load_data)
    
    # Save to Firestore
    try:
        load_ref = db.collection("loads").document(load_id)
        load_ref.set(load_data)
        log_action(uid, "LOAD_CREATE_STEP1", f"Created load {load_id} - Step 1 completed")
    except Exception as e:
        print(f"Warning: Could not save load to Firestore: {e}")
    
    # Calculate estimated distance and transit time using HERE Maps API
    estimated_distance = None
    estimated_transit_time = None
    try:
        here_client = get_here_client()
        
        # Convert equipment type to HERE truck type format
        equipment_to_truck_type = {
            "dry_van": "dryVan",
            "reefer": "reefer",
            "flatbed": "flatbed",
            "stepdeck": "stepdeck",
            "poweronly": "powerOnly"
        }
        truck_type = equipment_to_truck_type.get(data.equipment_type.value.lower().replace(" ", "_"), "dryVan")
        
        # Calculate distance using HERE API
        distance_result = here_client.calculate_distance(
            origin=data.origin,
            destination=data.destination,
            truck_type=truck_type,
            weight=data.weight if data.weight else None
        )
        
        estimated_distance = distance_result.get("distance_miles", 0)
        estimated_transit_time = distance_result.get("estimated_hours", 0)
        
        # Update load with calculated values
        load_data["estimated_distance"] = estimated_distance
        load_data["estimated_transit_time"] = estimated_transit_time
        store.update_load(load_id, {
            "estimated_distance": estimated_distance,
            "estimated_transit_time": estimated_transit_time
        })
        
        print(f"✅ Calculated distance via HERE API: {estimated_distance} miles, transit time: {estimated_transit_time} hours")
    except Exception as e:
        print(f"Warning: Distance calculation failed: {e}")
    
    return LoadStep1Response(
        load_id=load_id,
        load_number=load_number,
        estimated_distance=estimated_distance,
        estimated_transit_time=estimated_transit_time,
        message=f"Load {load_id} created successfully"
    )


@app.patch("/loads/{load_id}/step2")
async def update_load_step2(
    load_id: str,
    data: LoadStep2Update,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Step 2: Update load with Pricing & Details data.
    """
    uid = user['uid']
    
    # Get existing load
    existing_load = store.get_load(load_id)
    if not existing_load:
        raise HTTPException(status_code=404, detail="Load not found")
    
    # Verify ownership
    if existing_load.get("created_by") != uid:
        raise HTTPException(status_code=403, detail="Not authorized to update this load")
    
    # Prepare update data
    updates = {
        "updated_at": time.time(),
        "rate_type": data.rate_type.value,
        "linehaul_rate": data.linehaul_rate,
        "fuel_surcharge": data.fuel_surcharge,
        "advanced_charges": data.advanced_charges or [],
        "commodity": data.commodity,
        "special_requirements": data.special_requirements or [],
        "payment_terms": data.payment_terms.value if data.payment_terms else None,
        "notes": data.notes,
    }
    
    # Calculate total rate (linehaul + fuel_surcharge + sum of advanced_charges)
    total_rate = data.linehaul_rate
    if data.fuel_surcharge:
        total_rate += data.fuel_surcharge
    if data.advanced_charges:
        for charge in data.advanced_charges:
            total_rate += float(charge.get("amount", 0))
    updates["total_rate"] = total_rate
    
    # Update in storage
    updated_load = store.update_load(load_id, updates)
    
    # Update Firestore
    try:
        load_ref = db.collection("loads").document(load_id)
        load_ref.update(updates)
        log_action(uid, "LOAD_UPDATE_STEP2", f"Updated load {load_id} - Step 2 completed")
    except Exception as e:
        print(f"Warning: Could not update load in Firestore: {e}")
    
    return {
        "load_id": load_id,
        "message": "Step 2 data saved successfully",
        "total_rate": total_rate
    }


@app.patch("/loads/{load_id}/step3")
async def update_load_step3(
    load_id: str,
    data: LoadStep3Update,
    status: str = "ACTIVE",  # Can be "ACTIVE" or "DRAFT"
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Step 3: Update load with Visibility & Automation preferences.
    Posts the load and triggers auto-matching if enabled.
    
    Status parameter controls final state:
    - "ACTIVE": Load posted and visible to carriers
    - "DRAFT": Settings saved but load remains draft for later posting
    """
    uid = user['uid']
    user_role = user.get('role', 'carrier')
    
    # Get existing load
    existing_load = store.get_load(load_id)
    if not existing_load:
        raise HTTPException(status_code=404, detail="Load not found")
    
    # Verify ownership
    if existing_load.get("created_by") != uid:
        raise HTTPException(status_code=403, detail="Not authorized to update this load")
    
    # Prepare update data
    # Use status from parameter (ACTIVE or DRAFT)
    final_status = LoadStatus.POSTED.value if status == "ACTIVE" else LoadStatus.DRAFT.value
    
    # Get shipper information
    shipper_company_name = user.get("company_name", "")
    shipper_compliance_score = user.get("onboarding_score", 0)
    
    # Get additional stops/routes from existing load (stored in step1)
    additional_stops = existing_load.get("additional_routes", [])
    
    # Get total distance (from step1 calculation)
    total_distance = existing_load.get("estimated_distance") or existing_load.get("miles") or 0
    
    # Get total price (from step2 calculation)
    total_price = existing_load.get("total_rate") or existing_load.get("linehaul_rate") or existing_load.get("rate") or 0
    
    updates = {
        "updated_at": time.time(),
        "status": final_status,
        "visibility": data.visibility.value,
        "selected_carriers": data.selected_carriers or [],
        "auto_match_ai": data.auto_match_ai,
        "instant_booking": data.instant_booking,
        "auto_post_to_freightpower": data.auto_post_to_freightpower,
        "auto_post_to_truckstop": data.auto_post_to_truckstop,
        "auto_post_to_123loadboard": data.auto_post_to_123loadboard,
        "notify_on_carrier_views": data.notify_on_carrier_views,
        "notify_on_offer_received": data.notify_on_offer_received,
        "notify_on_load_covered": data.notify_on_load_covered,
        # Additional shipper and load details
        "shipper_company_name": shipper_company_name,
        "shipper_compliance_score": float(shipper_compliance_score),
        "additional_stops": additional_stops,  # Includes location, type, and date
        "total_distance": float(total_distance),
        "total_price": float(total_price),
    }

    # Initialize workflow status when a shipper/broker posts the load.
    # Do not overwrite a later-stage workflow status (e.g., Tendered/Awarded).
    if status == "ACTIVE" and user_role in ["shipper", "broker"]:
        try:
            existing_ws = str((existing_load or {}).get("workflow_status") or "").strip()
            if not existing_ws:
                updates["workflow_status"] = "Posted"
                updates["workflow_status_updated_at"] = time.time()
        except Exception:
            pass
    
    # Update in storage
    updated_load = store.update_load(load_id, updates)
    
    # Update Firestore
    try:
        load_ref = db.collection("loads").document(load_id)
        load_ref.update(updates)
        log_action(uid, "LOAD_POST", f"Posted load {load_id} - Step 3 completed")
    except Exception as e:
        print(f"Warning: Could not update load in Firestore: {e}")

    # Notify previous carriers when a shipper/broker posts a new load (best-effort).
    if status == "ACTIVE" and user.get("role") in ["shipper", "broker"]:
        try:
            frontend_base_url = str(getattr(settings, "FRONTEND_BASE_URL", "") or "").rstrip("/") or None
            notify_previous_carriers_new_load(
                db=db,
                shipper_uid=str(uid),
                load={"load_id": load_id, **(updated_load or {}), **updates},
                frontend_base_url=frontend_base_url,
            )
        except Exception as e:
            print(f"Warning: notify_previous_carriers_new_load failed: {e}")
    
    # Trigger auto-match if enabled
    matches = []
    if data.auto_match_ai:
        try:
            carriers = store.list_carriers()
            if carriers:
                # Convert updated_load to format match_load expects
                load_for_matching = {
                    "id": load_id,
                    "origin": updated_load.get("origin"),
                    "destination": updated_load.get("destination"),
                    "equipment": updated_load.get("equipment_type"),
                    "weight": updated_load.get("weight"),
                }
                match_results = match_load(load_for_matching, carriers, top_n=5)
                matches = [
                    {
                        "carrier_id": m.carrier_id,
                        "score": m.score,
                        "reasons": m.reasons
                    }
                    for m in match_results
                ]
                
                # Create alerts for top matches
                for m in match_results[:3]:
                    create_alert(
                        store,
                        {
                            "type": "match_suggestion",
                            "message": f"AI matched carrier {m.carrier_id} for load {load_id} (score {m.score:.2f})",
                            "priority": "routine",
                            "entity_id": load_id,
                        },
                    )
        except Exception as e:
            print(f"Auto-match failed: {e}")
    
    # Return appropriate message based on status
    message = f"Load {load_id} posted successfully" if status == "ACTIVE" else f"Load {load_id} saved as draft"
    
    return {
        "load_id": load_id,
        "message": message,
        "status": final_status,
        "matches": matches
    }


@app.post("/loads/generate-instructions", response_model=GenerateInstructionsResponse)
async def generate_driver_instructions(
    req: GenerateInstructionsRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Generate AI-powered driver instructions based on load details.
    """
    from .vision import chat_answer
    
    # Build context prompt for AI
    prompt = f"""Generate professional driver instructions for a freight load with the following details:

Load ID: {req.load_id}
Origin: {req.origin}
Destination: {req.destination}
Equipment Type: {req.equipment_type}
Commodity: {req.commodity or 'General Freight'}
Special Requirements: {', '.join(req.special_requirements) if req.special_requirements else 'None'}

Please provide clear, concise instructions covering:
1. Pickup procedures and timing
2. Load securing requirements
3. Special handling notes (if applicable)
4. Delivery procedures
5. Safety reminders

Keep it professional and under 200 words."""
    
    try:
        instructions = chat_answer(prompt, "")
    except Exception as e:
        # Fallback to template if AI fails
        instructions = f"""DRIVER INSTRUCTIONS - Load {req.load_id}

PICKUP:
• Arrive at {req.origin} on scheduled pickup date
• Contact shipper upon arrival for dock assignment
• Inspect cargo before loading

TRANSIT:
• Equipment: {req.equipment_type}
• Secure load per DOT regulations
{"• Special Requirements: " + ", ".join(req.special_requirements) if req.special_requirements else ""}

DELIVERY:
• Deliver to {req.destination}
• Contact consignee for delivery appointment
• Obtain signed BOL/POD

SAFETY:
• Conduct pre-trip and post-trip inspections
• Maintain HOS compliance
• Report any issues immediately"""
    
    return GenerateInstructionsResponse(
        instructions=instructions,
        load_id=req.load_id
    )


# ============================================================================
# DASHBOARD STATS ENDPOINTS
# ============================================================================

@app.get("/dashboard/stats")
async def get_dashboard_stats(
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Get dashboard statistics for the current user.
    Returns real counts or zeros if no data exists.
    
    Authorization: All authenticated users
    """
    uid = user['uid']
    user_role = user.get("role", "carrier")
    
    try:
        # Get all loads for this user
        filters = {}
        
        if user_role in ["admin", "super_admin"]:
            # Admins see all loads
            all_loads = store.list_loads(filters)
        elif user_role == "shipper" or user_role == "broker":
            # Shippers see only their own loads
            filters["created_by"] = uid
            all_loads = store.list_loads(filters)
        elif user_role == "carrier":
            # Carriers see created_by OR assigned_carrier loads
            filters_created = {"created_by": uid}
            loads_created = store.list_loads(filters_created)
            
            filters_assigned = {"assigned_carrier": uid}
            loads_assigned = store.list_loads(filters_assigned)
            
            # Merge and deduplicate
            load_map = {load["load_id"]: load for load in loads_created}
            for load in loads_assigned:
                if load["load_id"] not in load_map:
                    load_map[load["load_id"]] = load
            
            all_loads = list(load_map.values())
        elif user_role == "driver":
            # Drivers see only assigned loads
            filters["assigned_driver"] = uid
            all_loads = store.list_loads(filters)
        else:
            all_loads = []
        
        # Calculate stats
        active_loads = len([l for l in all_loads if l.get("status") in ["posted", "covered", "in_transit"]])
        pending_tasks = len([l for l in all_loads if l.get("status") == "posted"])
        total_loads = len(all_loads)
        completed_loads = len([l for l in all_loads if l.get("status") == "completed"])
        draft_loads = len([l for l in all_loads if l.get("status") == "draft"])
        
        # Calculate on-time percentage (mock for now, can be enhanced)
        on_time_percentage = 96.2 if completed_loads > 0 else 0
        
        # Calculate total revenue (sum of completed loads' rates)
        total_revenue = sum(
            float(l.get("linehaul_rate", 0) or 0) 
            for l in all_loads 
            if l.get("status") == "completed"
        )
        
        # Compliance score (mock for now)
        compliance_score = 94 if total_loads > 0 else 0
        compliance_expiring = 2
        
        # Rating (mock for now)
        rating = 4.8 if total_loads > 0 else 0
        
        stats = {
            "active_loads": active_loads,
            "active_loads_today": 0,  # Would need timestamp filtering
            "on_time_percentage": on_time_percentage,
            "on_time_change": "+1.2%",
            "rating": rating,
            "rating_label": "Excellent" if rating >= 4.5 else "Good",
            "total_revenue": total_revenue,
            "revenue_change": "+12% MTD",
            "compliance_score": compliance_score,
            "compliance_expiring": compliance_expiring,
            "pending_tasks": pending_tasks,
            "pending_urgent": min(3, pending_tasks),
            "total_loads": total_loads,
            "draft_loads": draft_loads
        }
        
        return JSONResponse(content=stats)
        
    except Exception as e:
        print(f"Error calculating dashboard stats: {e}")
        # Return zeros on error
        return JSONResponse(content={
            "active_loads": 0,
            "active_loads_today": 0,
            "on_time_percentage": 0,
            "on_time_change": "+0%",
            "rating": 0,
            "rating_label": "N/A",
            "total_revenue": 0,
            "revenue_change": "+0%",
            "compliance_score": 0,
            "compliance_expiring": 0,
            "pending_tasks": 0,
            "pending_urgent": 0,
            "total_loads": 0
        })


# ============================================================================
# AI CALCULATION ENDPOINTS
# ============================================================================

@app.post("/ai/calculate-distance", response_model=DistanceCalculationResponse)
async def calculate_distance(
    req: DistanceCalculationRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Calculate distance and estimated transit time between two locations using HERE Maps API.
    This endpoint now uses HERE API instead of GPT for more accurate truck routing.
    
    Authorization: All authenticated users
    """
    try:
        here_client = get_here_client()
        
        # Use dryVan as default if truck type not specified
        truck_type = getattr(req, 'truck_type', 'dryVan')
        weight = getattr(req, 'weight', None)
        
        result = here_client.calculate_distance(
            origin=req.origin,
            destination=req.destination,
            truck_type=truck_type,
            weight=weight
        )
        
        return DistanceCalculationResponse(
            distance_miles=result.get("distance_miles", 0),
            estimated_hours=result.get("estimated_hours", 0),
            estimated_days=result.get("estimated_days", 0),
            confidence=result.get("confidence", 0.0),
            notes=result.get("notes", "Route calculated via HERE Maps API")
        )
    except Exception as e:
        print(f"Error in distance calculation endpoint: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Distance calculation failed: {str(e)}"
        )


@app.post("/ai/calculate-load-cost", response_model=LoadCostCalculationResponse)
async def calculate_load_cost_endpoint(
    req: LoadCostCalculationRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Calculate total load cost based on distance, rate per mile, and additional charges.
    
    Authorization: All authenticated users
    """
    try:
        result = calculate_load_cost(
            req.distance_miles,
            req.rate_per_mile,
            req.additional_charges
        )
        
        return LoadCostCalculationResponse(**result)
    except Exception as e:
        print(f"Error in cost calculation endpoint: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Cost calculation failed: {str(e)}"
        )


# ============================================================================
# LOAD LISTING & MANAGEMENT ENDPOINTS
# ============================================================================

@app.get("/loads/drafts", response_model=LoadListResponse)
async def get_user_drafts(
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Get all draft loads for the current user.
    Drafts are incomplete loads saved after Step 1 that can be resumed later.
    """
    uid = user['uid']
    
    # Get only draft loads for this user
    filters = {
        "created_by": uid,
        "status": LoadStatus.DRAFT.value
    }
    
    draft_loads = store.list_loads(filters)
    
    # Convert to LoadComplete models
    loads = [LoadComplete(**load) for load in draft_loads]
    
    return LoadListResponse(
        loads=loads,
        total=len(loads),
        page=1,
        page_size=len(loads)
    )


@app.get("/loads", response_model=LoadListResponse)
async def list_loads(
    status: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
    exclude_drafts: bool = True,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    List loads with strict role-based filtering:
    - Carriers: See their own loads + loads won from shippers (created_by OR assigned_carrier)
    - Shippers: See ONLY their own loads (all statuses)
    - Drivers: See ONLY loads assigned to them
    - Admins: See all loads
    
    By default, DRAFT loads are excluded from marketplace listings.
    Set exclude_drafts=False to include drafts (for dashboard views).
    
    Business Logic:
    - Carrier's "My Loads" includes:
      1. Loads they posted themselves (created_by=uid)
      2. Loads they won from shippers (assigned_carrier=uid, status=COVERED+)
    """

    def _coerce_load_complete_min_fields(d: Dict[str, Any], *, viewer_uid: str, viewer_role: str) -> Dict[str, Any]:
        """Best-effort compatibility for legacy/incomplete load docs.

        The /loads endpoint historically returned a strict `LoadComplete` model.
        Some Firestore documents may use legacy field names or be missing required fields,
        causing them to be silently skipped and the UI to show 0 loads.

        This function fills ONLY the minimal required `LoadComplete` fields with safe defaults
        and maps a few legacy keys to the current schema.
        """

        out: Dict[str, Any] = dict(d or {})

        def _first_str(*vals: Any) -> str:
            for v in vals:
                s = str(v or "").strip()
                if s:
                    return s
            return ""

        def _to_float(v: Any) -> Optional[float]:
            try:
                if v is None:
                    return None
                if isinstance(v, (int, float)):
                    f = float(v)
                    return f if f > 0 else None
                s = str(v).strip()
                if not s:
                    return None
                f = float(s)
                return f if f > 0 else None
            except Exception:
                return None

        # Normalize common legacy key variants
        if "equipment_type" not in out and "equipmentType" in out:
            out["equipment_type"] = out.get("equipmentType")
        if "pickup_date" not in out and "pickupDate" in out:
            out["pickup_date"] = out.get("pickupDate")
        if "delivery_date" not in out and "deliveryDate" in out:
            out["delivery_date"] = out.get("deliveryDate")
        if "created_by" not in out and "createdBy" in out:
            out["created_by"] = out.get("createdBy")

        now = float(time.time())

        # Required: created_by
        if not _first_str(out.get("created_by")):
            # For shipper/broker views, falling back to viewer uid is reasonable.
            if str(viewer_role or "").lower() in {"shipper", "broker"}:
                out["created_by"] = str(viewer_uid)
            else:
                out["created_by"] = "unknown"

        # Required: created_at / updated_at (float seconds)
        out.setdefault("created_at", _to_float(out.get("created_at")) or _to_float(out.get("createdAt")) or now)
        out.setdefault("updated_at", _to_float(out.get("updated_at")) or _to_float(out.get("updatedAt")) or out.get("created_at") or now)

        # Required: origin/destination
        out.setdefault("origin", _first_str(out.get("origin"), out.get("load_origin"), out.get("pickup"), out.get("pickup_location")))
        out.setdefault(
            "destination",
            _first_str(out.get("destination"), out.get("load_destination"), out.get("delivery"), out.get("delivery_location")),
        )

        # Required: pickup_date, equipment_type, weight
        out.setdefault("pickup_date", _first_str(out.get("pickup_date"), out.get("pickup")))
        out.setdefault("equipment_type", _first_str(out.get("equipment_type"), out.get("equipment"), out.get("mode"), "Unknown"))

        weight = out.get("weight")
        if weight is None or (isinstance(weight, str) and not weight.strip()):
            weight = out.get("weight_lbs") or out.get("weightLbs") or out.get("weight_lb") or out.get("weight_pounds")
        out.setdefault("weight", float(_to_float(weight) or 0.0))

        if not isinstance(out.get("metadata"), dict):
            out["metadata"] = {}

        return out

    uid = user['uid']
    user_role = user.get("role", "carrier")
    
    # Build filters based on role
    if user_role in ["admin", "super_admin"]:
        # Admins see everything
        filters = {}
        if status:
            filters["status"] = status
        all_loads = store.list_loads(filters)
    elif user_role == "shipper" or user_role == "broker":
        # Shippers see ONLY their own loads (strict ownership check) - read from Firestore
        try:
            loads_ref = db.collection("loads")
            all_loads = []
            seen_load_ids = set()

            def _add_stream(stream):
                for doc in stream:
                    load = doc.to_dict() or {}
                    load_id = load.get("load_id") or doc.id
                    if not load_id or load_id in seen_load_ids:
                        continue
                    load["load_id"] = load_id
                    all_loads.append(load)
                    seen_load_ids.add(load_id)

            # Primary: modern ownership field.
            query = loads_ref.where("created_by", "==", uid)
            if status:
                query = query.where("status", "==", status)
            _add_stream(query.stream())

            # Back-compat: normalized payer field.
            query2 = loads_ref.where("payer_uid", "==", uid)
            if status:
                query2 = query2.where("status", "==", status)
            _add_stream(query2.stream())

            # Back-compat: camelCase ownership field.
            query3 = loads_ref.where("createdBy", "==", uid)
            if status:
                query3 = query3.where("status", "==", status)
            _add_stream(query3.stream())
        except Exception as e:
            print(f"Error fetching shipper loads from Firestore: {e}")
            # Fallback to local storage
            filters = {"created_by": uid}
            if status:
                filters["status"] = status
            all_loads = store.list_loads(filters)
    elif user_role == "driver":
        # Drivers see loads assigned to them - query Firestore
        # Include both accepted and pending loads (frontend will separate them)
        try:
            loads_ref = db.collection("loads")
            # Query for loads assigned to this driver using assigned_driver field
            query = loads_ref.where("assigned_driver", "==", uid)
            if status:
                query = query.where("status", "==", status)
            
            all_loads_docs = query.stream()
            all_loads = []
            seen_load_ids = set()
            
            for doc in all_loads_docs:
                load = doc.to_dict()
                load_id = doc.id
                
                # Skip duplicates
                if load_id in seen_load_ids:
                    continue
                seen_load_ids.add(load_id)
                
                load["load_id"] = load_id
                all_loads.append(load)
            
            # Also check assigned_driver_id field if no results or to catch any missed
            if len(all_loads) == 0:
                query2 = loads_ref.where("assigned_driver_id", "==", uid)
                if status:
                    query2 = query2.where("status", "==", status)
                all_loads_docs2 = query2.stream()
                for doc in all_loads_docs2:
                    load = doc.to_dict()
                    load_id = doc.id
                    if load_id not in seen_load_ids:
                        load["load_id"] = load_id
                        all_loads.append(load)
                        seen_load_ids.add(load_id)
        except Exception as e:
            print(f"Error fetching driver loads from Firestore: {e}")
            import traceback
            traceback.print_exc()
            # Fallback to local storage
            filters = {"assigned_driver": uid}
            if status:
                filters["status"] = status
            all_loads = store.list_loads(filters)
    elif user_role == "carrier":
        # Carriers see: created_by=uid OR assigned_carrier=uid
        # Query both from Firestore (primary source) to ensure we get all loads
        all_loads = []
        seen_load_ids = set()
        
        try:
            loads_ref = db.collection("loads")
            
            # Get loads created by this carrier from Firestore
            query_created = loads_ref.where("created_by", "==", uid)
            if status:
                query_created = query_created.where("status", "==", status)
            created_loads_docs = query_created.stream()
            
            for doc in created_loads_docs:
                load = doc.to_dict()
                load_id = load.get("load_id") or doc.id  # Use load_id from doc if available, otherwise use doc.id
                if load_id not in seen_load_ids:
                    load["load_id"] = load_id
                    all_loads.append(load)
                    seen_load_ids.add(load_id)
            
            # Get loads assigned to this carrier from Firestore (these are loads accepted by shippers)
            # Query for loads with assigned_carrier field matching uid
            query_assigned = loads_ref.where("assigned_carrier", "==", uid)
            if status:
                query_assigned = query_assigned.where("status", "==", status)
            assigned_loads_docs = query_assigned.stream()
            
            for doc in assigned_loads_docs:
                load = doc.to_dict()
                load_id = load.get("load_id") or doc.id  # Use load_id from doc if available, otherwise use doc.id
                if load_id not in seen_load_ids:
                    load["load_id"] = load_id
                    all_loads.append(load)
                    seen_load_ids.add(load_id)
            
            # Also check assigned_carrier_id field (for backward compatibility)
            query_assigned_id = loads_ref.where("assigned_carrier_id", "==", uid)
            if status:
                query_assigned_id = query_assigned_id.where("status", "==", status)
            assigned_loads_docs2 = query_assigned_id.stream()
            
            for doc in assigned_loads_docs2:
                load = doc.to_dict()
                load_id = load.get("load_id") or doc.id  # Use load_id from doc if available, otherwise use doc.id
                if load_id not in seen_load_ids:
                    load["load_id"] = load_id
                    all_loads.append(load)
                    seen_load_ids.add(load_id)
            
            print(f"DEBUG: Carrier {uid} - Found {len(all_loads)} total loads ({len(seen_load_ids)} unique)")
        except Exception as e:
            print(f"Error fetching carrier loads from Firestore: {e}")
            import traceback
            traceback.print_exc()
            # Fallback to local storage
            filters_created = {"created_by": uid}
            if status:
                filters_created["status"] = status
            loads_created = store.list_loads(filters_created)
            
            filters_assigned = {"assigned_carrier": uid}
            if status:
                filters_assigned["status"] = status
            loads_assigned = store.list_loads(filters_assigned)
            
            # Merge and deduplicate
            load_map = {load["load_id"]: load for load in loads_created}
            for load in loads_assigned:
                if load["load_id"] not in load_map:
                    load_map[load["load_id"]] = load
            all_loads = list(load_map.values())
    else:
        # Default: see their own loads
        filters = {"created_by": uid}
        if status:
            filters["status"] = status
        all_loads = store.list_loads(filters)
    
    # Filter out drafts if requested (default for marketplace)
    if exclude_drafts:
        all_loads = [load for load in all_loads if load.get("status") != LoadStatus.DRAFT.value]
    
    # Pagination
    total = len(all_loads)
    start_idx = (page - 1) * page_size
    end_idx = start_idx + page_size
    paginated_loads = all_loads[start_idx:end_idx]
    
    # Convert to LoadComplete models
    # Handle cases where load_id might not be set (use doc.id as fallback)
    loads = []
    for load in paginated_loads:
        # Ensure load_id is set
        if "load_id" not in load or not load["load_id"]:
            # Try to use the document ID if available, but this shouldn't happen
            print(f"WARNING: Load missing load_id field: {load.keys()}")
            continue
        try:
            sanitized = sanitize_load_for_viewer(load, viewer_uid=str(uid), viewer_role=str(user_role))
            coerced = _coerce_load_complete_min_fields(sanitized, viewer_uid=str(uid), viewer_role=str(user_role))
            loads.append(LoadComplete(**coerced))
        except Exception as e:
            print(f"ERROR: Failed to convert load {load.get('load_id', 'unknown')} to LoadComplete: {e}")
            import traceback
            traceback.print_exc()
            # Skip this load instead of failing the entire request
            continue
    
    return LoadListResponse(
        loads=loads,
        total=total,
        page=page,
        page_size=page_size
    )


@app.delete("/loads/{load_id}")
async def delete_draft_load(
    load_id: str,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Delete a draft load. Only DRAFT status loads can be deleted.
    POSTED or later loads must be cancelled instead.
    
    Authorization: Load creator only
    """
    uid = user['uid']
    
    # Get existing load
    existing_load = store.get_load(load_id)
    if not existing_load:
        raise HTTPException(status_code=404, detail="Load not found")
    
    # Verify ownership
    if existing_load.get("created_by") != uid:
        raise HTTPException(status_code=403, detail="Not authorized to delete this load")
    
    # Only allow deletion of DRAFT loads
    current_status = existing_load.get("status")
    if current_status != LoadStatus.DRAFT.value:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot delete load with status '{current_status}'. Only DRAFT loads can be deleted. Use cancel endpoint for posted loads."
        )
    
    # Delete from storage
    try:
        store.delete_load(load_id)
        # Delete from Firestore
        db.collection("loads").document(load_id).delete()
        log_action(uid, "LOAD_DELETE", f"Deleted draft load {load_id}")
    except Exception as e:
        print(f"Error deleting load: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete load")
    
    return {"message": f"Draft load {load_id} deleted successfully"}


@app.get("/loads/tendered", response_model=LoadListResponse)
async def list_tendered_loads(
    page: int = 1,
    page_size: int = 20,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    List shipper's tendered loads (POSTED status, awaiting carrier bids).
    
    Authorization: Shippers/Brokers only
    
    Returns: Loads created by this shipper with status=POSTED.
    These are active tendered loads awaiting carrier bids.
    """
    uid = user['uid']
    user_role = user.get("role", "carrier")
    
    # Only shippers/brokers can access this endpoint
    if user_role not in ["shipper", "broker", "admin", "super_admin"]:
        raise HTTPException(
            status_code=403,
            detail="Only shippers can view tendered loads"
        )
    
    # Build filters: created_by + status=POSTED
    filters = {
        "status": "posted"
    }
    
    # Non-admins can only see their own
    if user_role not in ["admin", "super_admin"]:
        filters["created_by"] = uid
    
    all_loads = store.list_loads(filters)
    
    # Pagination
    total = len(all_loads)
    start_idx = (page - 1) * page_size
    end_idx = start_idx + page_size
    paginated_loads = all_loads[start_idx:end_idx]
    
    # Convert to LoadComplete models
    loads = [LoadComplete(**load) for load in paginated_loads]
    
    return LoadListResponse(
        loads=loads,
        total=total,
        page=page,
        page_size=page_size
    )


@app.get("/loads/{load_id}", response_model=LoadResponse)
async def get_load_details(
    load_id: str,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Get detailed information about a specific load.
    
    Authorization:
    - Shippers: Can view ONLY their own loads
    - Drivers: Can view ONLY loads assigned to them
    - Carriers: Can view their own loads
    - Admins: Can view all loads
    """
    # Get load from Firestore first, fallback to local storage
    load = None
    try:
        load_doc = db.collection("loads").document(load_id).get()
        if load_doc.exists:
            load = load_doc.to_dict()
            load["load_id"] = load_id
    except Exception as e:
        print(f"Error fetching load from Firestore: {e}")
    
    # Fallback to local storage if Firestore doesn't have it
    if not load:
        load = store.get_load(load_id)
    
    if not load:
        raise HTTPException(status_code=404, detail="Load not found")
    
    # Strict role-based access control
    uid = user['uid']
    user_role = user.get("role", "carrier")
    
    if user_role in ["admin", "super_admin"]:
        # Admins can view all loads
        pass
    elif user_role == "shipper" or user_role == "broker":
        # Shippers/brokers can ONLY view loads they own.
        # Support legacy ownership fields.
        owner_uid = (
            load.get("created_by")
            or load.get("payer_uid")
            or load.get("createdBy")
        )
        if owner_uid != uid:
            raise HTTPException(
                status_code=403,
                detail="Shippers can only view loads they created"
            )
    elif user_role == "driver":
        # Drivers can ONLY view loads assigned to them
        assigned_driver = str(load.get("assigned_driver") or load.get("assigned_driver_id") or "").strip()
        if assigned_driver != str(uid).strip():
            raise HTTPException(
                status_code=403,
                detail="Drivers can only view loads assigned to them"
            )
    else:
        # Carriers can view their own loads OR marketplace loads (POSTED loads they can bid on)
        created_by = str(load.get("created_by") or "").strip()
        assigned_carrier = str(load.get("assigned_carrier") or load.get("assigned_carrier_id") or "").strip()
        uid_s = str(uid).strip()

        if created_by != uid_s and assigned_carrier != uid_s:
            # Allow carriers to view marketplace loads (POSTED) for bidding,
            # or loads they've already bid on.
            offers = load.get("offers") or []
            has_bid = any(str(o.get("carrier_id") or "").strip() == uid_s for o in offers)
            if load.get("status") != LoadStatus.POSTED.value and not has_bid:
                raise HTTPException(
                    status_code=403,
                    detail="Not authorized to view this load"
                )
    
    sanitized = sanitize_load_for_viewer(load, viewer_uid=str(uid), viewer_role=str(user_role))

    # Best-effort compatibility with legacy loads.
    try:
        # Reuse the same compatibility helper used by /loads
        # (defined inside list_loads for locality; duplicate minimal logic here).
        def _first_str(*vals: Any) -> str:
            for v in vals:
                s = str(v or "").strip()
                if s:
                    return s
            return ""

        def _to_float(v: Any) -> Optional[float]:
            try:
                if v is None:
                    return None
                if isinstance(v, (int, float)):
                    f = float(v)
                    return f if f > 0 else None
                s = str(v).strip()
                if not s:
                    return None
                f = float(s)
                return f if f > 0 else None
            except Exception:
                return None

        d = dict(sanitized or {})
        if "equipment_type" not in d and "equipmentType" in d:
            d["equipment_type"] = d.get("equipmentType")
        if "pickup_date" not in d and "pickupDate" in d:
            d["pickup_date"] = d.get("pickupDate")
        if "delivery_date" not in d and "deliveryDate" in d:
            d["delivery_date"] = d.get("deliveryDate")
        if "created_by" not in d and "createdBy" in d:
            d["created_by"] = d.get("createdBy")

        now = float(time.time())
        if not _first_str(d.get("created_by")):
            if str(user_role or "").lower() in {"shipper", "broker"}:
                d["created_by"] = str(uid)
            else:
                d["created_by"] = "unknown"
        d.setdefault("created_at", _to_float(d.get("created_at")) or _to_float(d.get("createdAt")) or now)
        d.setdefault("updated_at", _to_float(d.get("updated_at")) or _to_float(d.get("updatedAt")) or d.get("created_at") or now)
        d.setdefault("origin", _first_str(d.get("origin"), d.get("load_origin"), d.get("pickup"), d.get("pickup_location")))
        d.setdefault("destination", _first_str(d.get("destination"), d.get("load_destination"), d.get("delivery"), d.get("delivery_location")))
        d.setdefault("pickup_date", _first_str(d.get("pickup_date"), d.get("pickup")))
        d.setdefault("equipment_type", _first_str(d.get("equipment_type"), d.get("equipment"), d.get("mode"), "Unknown"))
        weight = d.get("weight")
        if weight is None or (isinstance(weight, str) and not weight.strip()):
            weight = d.get("weight_lbs") or d.get("weightLbs") or d.get("weight_lb") or d.get("weight_pounds")
        d.setdefault("weight", float(_to_float(weight) or 0.0))
        if not isinstance(d.get("metadata"), dict):
            d["metadata"] = {}

        sanitized = d
    except Exception:
        pass

    return LoadResponse(
        load=LoadComplete(**sanitized),
        message="Success"
    )


# ============================================================================
# LEGACY LOAD ENDPOINTS (Keep for backward compatibility)
# ============================================================================

@app.post("/loads")
def create_load(req: LoadCreateRequest):
    payload = req.dict()
    # Back-compat endpoint: ensure a load_number exists for UI/public reference.
    try:
        if not payload.get("load_number"):
            payload["load_number"] = generate_load_number(region="ATL", db_client=db)
    except Exception:
        pass

    # Back-compat: populate normalized ownership fields from legacy fields.
    created_by = payload.get("created_by")
    creator_role = payload.get("creator_role")
    if created_by and creator_role:
        payload.update(normalized_fields_for_new_load(creator_uid=str(created_by), creator_role=str(creator_role)))

    # If legacy payload already has a carrier assignment, mirror it.
    if payload.get("carrier_id") is None:
        assigned = payload.get("assigned_carrier_id") or payload.get("assigned_carrier")
        if assigned:
            payload["carrier_id"] = assigned
            payload["carrier_uid"] = assigned

    store.save_load(payload)
    # Auto-match and notify
    carriers = store.list_carriers()
    if carriers:
        matches = match_load(payload, carriers, top_n=5)
        for m in matches:
            create_alert(
                store,
                {
                    "type": "match_suggestion",
                    "message": f"Suggested carrier {m.carrier_id} for load {payload['id']} (score {m.score})",
                    "priority": "routine",
                    "entity_id": payload["id"],
                },
            )
    return payload


@app.post("/carriers")
def create_carrier(req: CarrierCreateRequest):
    payload = req.dict()
    store.save_carrier(payload)
    return payload


@app.get("/carriers")
async def list_carriers(
    exclude_taken: bool = True,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    List all carriers from Firestore.
    Shippers use this to find carriers for their loads.
    """
    try:
        uid = user.get("uid")
        user_role = user.get("role", "carrier")

        exclude_carrier_ids: set = set()
        if exclude_taken and user_role in ["shipper", "broker"] and uid:
            try:
                # Exclude carriers that already have an active relationship with this shipper
                rel_ref = db.collection("shipper_carrier_relationships")
                rel_docs = rel_ref.where("shipper_id", "==", uid).where("status", "==", "active").stream()
                for doc in rel_docs:
                    rel = doc.to_dict() or {}
                    carrier_id = rel.get("carrier_id")
                    if carrier_id:
                        exclude_carrier_ids.add(carrier_id)
            except Exception as e:
                print(f"Warning: Could not fetch shipper-carrier relationships for filtering: {e}")

            try:
                # Exclude carriers that this shipper already invited (pending)
                invites_ref = db.collection("carrier_invitations")
                invites_docs = invites_ref.where("shipper_id", "==", uid).where("status", "==", "pending").stream()
                for doc in invites_docs:
                    inv = doc.to_dict() or {}
                    carrier_id = inv.get("carrier_id")
                    if carrier_id:
                        exclude_carrier_ids.add(carrier_id)
            except Exception as e:
                print(f"Warning: Could not fetch carrier invitations for filtering: {e}")

        carriers_ref = db.collection("carriers")
        carriers_docs = carriers_ref.stream()
        
        carriers = []
        for doc in carriers_docs:
            carrier_data = doc.to_dict()
            carrier_data['id'] = doc.id  # Ensure ID is included

            # If shipper/broker already has this carrier "taken" (active or pending invite), hide it
            if exclude_carrier_ids and carrier_data['id'] in exclude_carrier_ids:
                continue

            carriers.append(carrier_data)
        
        return {"carriers": carriers, "total": len(carriers)}
    except Exception as e:
        print(f"Error fetching carriers: {e}")
        # Fallback to local storage if Firebase fails
        return {"carriers": store.list_carriers(), "total": len(store.list_carriers())}


@app.get("/drivers")
async def list_drivers(
    status: Optional[str] = None,
    available_only: bool = True,  # Only show drivers not hired yet
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    List all drivers from Firestore.
    Carriers use this to find available drivers in the marketplace.
    By default, only shows drivers not hired by any carrier (available_only=True).
    Optional status filter: available, on_trip, off_duty
    """
    try:
        # First, get all users with role "driver"
        users_ref = db.collection("users")
        driver_users_query = users_ref.where("role", "==", "driver")
        driver_users_docs = driver_users_query.stream()
        
        driver_user_ids = set()
        for user_doc in driver_users_docs:
            driver_user_ids.add(user_doc.id)
        
        if not driver_user_ids:
            return {"drivers": [], "total": 0}
        
        # Now get driver profiles from drivers collection
        # Driver profiles use the user's uid as the document ID (as per auth.py signup)
        drivers_ref = db.collection("drivers")
        drivers_docs = drivers_ref.stream()
        
        drivers = []
        for doc in drivers_docs:
            driver_data = doc.to_dict()
            driver_id = doc.id
            
            # Only include drivers whose document ID matches a driver user ID
            # (since driver profiles are created with user uid as document ID)
            if driver_id not in driver_user_ids:
                # Also check if there's a user_id field that matches
                driver_user_id = driver_data.get("user_id") or driver_data.get("id")
                if not driver_user_id or driver_user_id not in driver_user_ids:
                    continue
            
            # Filter by available_only (not hired)
            if available_only:
                carrier_id = driver_data.get("carrier_id")
                if carrier_id:
                    continue  # Skip hired drivers
            
            # IMPORTANT: Only show drivers who have toggled availability ON
            is_available = driver_data.get("is_available", False)
            if not is_available:
                continue  # Skip unavailable drivers
            
            # Apply status filter if provided
            if status:
                driver_status = driver_data.get("status", "")
                if driver_status != status:
                    continue
            
            driver_data['id'] = driver_id  # Ensure ID is included
            drivers.append(driver_data)
        
        return {"drivers": drivers, "total": len(drivers)}
    except Exception as e:
        print(f"Error fetching drivers: {e}")
        import traceback
        traceback.print_exc()
        return {"drivers": [], "total": 0}


@app.get("/drivers/me")
async def get_my_driver_profile(
    user: Dict[str, Any] = Depends(get_current_user)
):
    """Return the current user's driver profile document (for driver self-preview).

    Unlike /drivers, this does not apply marketplace availability/hired filters.
    """
    try:
        if (user.get("role") or "").lower() != "driver":
            raise HTTPException(status_code=403, detail="Only drivers can access their driver profile")

        uid = user.get("uid")
        if not uid:
            raise HTTPException(status_code=401, detail="Unauthorized")

        snap = db.collection("drivers").document(uid).get()
        if not snap.exists:
            raise HTTPException(status_code=404, detail="Driver profile not found")

        data = snap.to_dict() or {}
        data["id"] = uid
        return data
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error fetching driver profile for {user.get('uid')}: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch driver profile")


@app.post("/drivers/{driver_id}/hire")
async def hire_driver(
    driver_id: str,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Hire a driver (carrier only).
    Links a driver to the carrier by setting carrier_id in the driver profile.
    """
    try:
        user_role = user.get("role")
        if user_role != "carrier":
            raise HTTPException(status_code=403, detail="Only carriers can hire drivers")
        
        carrier_id = user['uid']
        
        # Get driver document
        driver_ref = db.collection("drivers").document(driver_id)
        driver_doc = driver_ref.get()
        
        if not driver_doc.exists:
            raise HTTPException(status_code=404, detail="Driver not found")
        
        driver_data = driver_doc.to_dict()
        
        # Check if driver is already hired
        if driver_data.get("carrier_id"):
            raise HTTPException(
                status_code=400, 
                detail="Driver is already hired by another carrier"
            )
        
        # Update driver with carrier_id
        driver_ref.update({
            "carrier_id": carrier_id,
            "hired_at": time.time(),
            "updated_at": time.time()
        })
        
        # Log action
        log_action(carrier_id, "DRIVER_HIRED", f"Hired driver {driver_id}")
        
        return JSONResponse(content={
            "success": True,
            "message": "Driver hired successfully",
            "driver_id": driver_id,
            "carrier_id": carrier_id
        })
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error hiring driver: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Failed to hire driver")


class DriverAvailabilityRequest(BaseModel):
    is_available: bool


@app.post("/driver/availability")
async def update_driver_availability(
    request: DriverAvailabilityRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Update driver's availability status.
    Driver only - controls whether they appear in carrier marketplace.
    When available, driver is visible to carriers and can receive job offers.
    When unavailable, driver is hidden from marketplace.
    """
    try:
        user_role = user.get("role")
        if user_role != "driver":
            raise HTTPException(status_code=403, detail="Only drivers can update availability")
        
        driver_id = user['uid']
        
        # Update driver document
        driver_ref = db.collection("drivers").document(driver_id)
        driver_doc = driver_ref.get()
        
        if not driver_doc.exists:
            # Create driver document if it doesn't exist
            driver_ref.set({
                "user_id": driver_id,
                "is_available": request.is_available,
                "availability_updated_at": time.time(),
                "created_at": time.time(),
                "updated_at": time.time()
            })
        else:
            # Update existing document
            driver_ref.update({
                "is_available": request.is_available,
                "availability_updated_at": time.time(),
                "updated_at": time.time()
            })

        # Keep users profile in sync so availability persists across sessions/UI reloads
        # (Most frontend profile fetches read from the users collection.)
        try:
            db.collection("users").document(driver_id).update({
                "is_available": request.is_available,
                "availability_updated_at": time.time(),
                "updated_at": time.time()
            })
        except Exception as e:
            # Non-fatal: driver availability is still persisted in drivers collection
            print(f"Warning: failed to sync users.is_available for {driver_id}: {e}")
        
        # Also update onboarding data if exists
        onboarding_ref = db.collection("onboarding").document(driver_id)
        onboarding_doc = onboarding_ref.get()
        if onboarding_doc.exists:
            onboarding_ref.update({
                "is_available": request.is_available,
                "updated_at": time.time()
            })
        
        # Log action
        log_action(driver_id, "AVAILABILITY_UPDATED", 
                  f"Availability set to: {request.is_available}")
        
        return JSONResponse(content={
            "success": True,
            "message": f"Availability updated to: {'Available' if request.is_available else 'Unavailable'}",
            "is_available": request.is_available
        })
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error updating availability: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Failed to update availability")


class SupportRequest(BaseModel):
    name: str
    email: str
    subject: str
    message: str
    user_id: Optional[str] = None
    timestamp: Optional[str] = None


@app.post("/support/submit")
async def submit_support_request(
    request: SupportRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Submit a support request from a user.
    Stores the request in Firestore and mocks sending to help@freightpower-ai.com
    """
    try:
        user_id = user.get('uid')
        
        # Store support request in Firestore
        support_ref = db.collection("support_requests").document()
        support_data = {
            "user_id": user_id,
            "name": request.name,
            "email": request.email,
            "subject": request.subject,
            "message": request.message,
            "timestamp": request.timestamp or time.time(),
            "status": "pending",
            "created_at": time.time()
        }
        support_ref.set(support_data)
        
        # Mock email notification (in production, integrate with email service)
        # Note: avoid non-ASCII characters in logs to prevent Windows console encoding errors.
        print("[Support] Request received")
        print(f"   From: {request.name} ({request.email})")
        print(f"   Subject: {request.subject}")
        print(f"   Message: {request.message}")
        print("   Mock sent to: help@freightpower-ai.com")
        
        # Log action
        log_action(user_id, "SUPPORT_REQUEST", 
                  f"Support request submitted: {request.subject}")
        
        return JSONResponse(content={
            "success": True,
            "message": "Support request submitted successfully",
            "request_id": support_ref.id,
            "mock_email_sent_to": "help@freightpower-ai.com"
        })
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error submitting support request: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Failed to submit support request")


class TrackDriverViewRequest(BaseModel):
    driver_id: str


@app.post("/marketplace/track-driver-view")
async def track_driver_view(
    request: TrackDriverViewRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Track when a carrier views a driver's profile in the marketplace.
    Increments the driver's marketplace_views_count for the current week.
    Only carriers can track views.
    """
    try:
        user_role = user.get("role")
        if user_role != "carrier":
            raise HTTPException(status_code=403, detail="Only carriers can track driver views")
        
        carrier_id = user['uid']
        driver_id = request.driver_id
        
        # Get driver document
        driver_ref = db.collection("drivers").document(driver_id)
        driver_doc = driver_ref.get()
        
        if not driver_doc.exists:
            raise HTTPException(status_code=404, detail="Driver not found")
        
        driver_data = driver_doc.to_dict()
        
        # CRITICAL: Only track views if driver has availability toggled ON
        is_available = driver_data.get("is_available", False)
        if not is_available:
            raise HTTPException(
                status_code=403, 
                detail="Cannot track views for unavailable driver. Driver must toggle availability ON to be visible."
            )
        
        # Increment marketplace views count
        current_count = driver_data.get("marketplace_views_count", 0)
        new_count = current_count + 1
        
        # Update driver document
        driver_ref.update({
            "marketplace_views_count": new_count,
            "marketplace_views_last_updated": time.time(),
            "updated_at": time.time()
        })
        
        # Also track in onboarding collection if exists
        onboarding_ref = db.collection("onboarding").document(driver_id)
        onboarding_doc = onboarding_ref.get()
        if onboarding_doc.exists:
            onboarding_ref.update({
                "marketplace_views_count": new_count,
                "marketplace_views_last_updated": time.time()
            })
        
        # Log the view for analytics
        view_log_ref = db.collection("marketplace_view_logs").document()
        view_log_ref.set({
            "driver_id": driver_id,
            "carrier_id": carrier_id,
            "viewed_at": time.time(),
            "timestamp": firestore.SERVER_TIMESTAMP
        })
        
        print(f"📊 Carrier {carrier_id} viewed driver {driver_id}. New count: {new_count}")
        
        return JSONResponse(content={
            "success": True,
            "message": "Driver view tracked successfully",
            "new_view_count": new_count
        })
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error tracking driver view: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Failed to track driver view")


@app.post("/marketplace/reset-weekly-views")
async def reset_weekly_views(
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Reset marketplace view counts for all drivers.
    Called by scheduler every Monday at 00:00.
    Can also be manually triggered by admin.
    """
    try:
        user_role = user.get("role")
        # Only allow admin or system to reset
        if user_role not in ["admin", "system"]:
            raise HTTPException(status_code=403, detail="Only admin can reset view counts")
        
        # Get all drivers
        drivers_ref = db.collection("drivers")
        drivers_docs = drivers_ref.stream()
        
        reset_count = 0
        for doc in drivers_docs:
            driver_id = doc.id
            driver_data = doc.to_dict()
            
            current_count = driver_data.get("marketplace_views_count", 0)
            
            # Archive current week's count to history
            history = driver_data.get("marketplace_views_history", [])
            if current_count > 0:
                history.append({
                    "count": current_count,
                    "week_ending": time.time(),
                    "archived_at": time.time()
                })
            
            # Keep only last 12 weeks of history
            if len(history) > 12:
                history = history[-12:]
            
            # Reset count to 0
            doc.reference.update({
                "marketplace_views_count": 0,
                "marketplace_views_last_reset": time.time(),
                "marketplace_views_history": history,
                "updated_at": time.time()
            })
            
            # Also update onboarding collection
            onboarding_ref = db.collection("onboarding").document(driver_id)
            onboarding_doc = onboarding_ref.get()
            if onboarding_doc.exists:
                onboarding_ref.update({
                    "marketplace_views_count": 0,
                    "marketplace_views_last_reset": time.time()
                })
            
            reset_count += 1
        
        print(f"✅ Reset marketplace views for {reset_count} drivers")
        
        # Log reset action
        log_action(user['uid'], "MARKETPLACE_VIEWS_RESET", 
                  f"Reset view counts for {reset_count} drivers")
        
        return JSONResponse(content={
            "success": True,
            "message": f"Successfully reset view counts for {reset_count} drivers",
            "drivers_reset": reset_count
        })
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error resetting weekly views: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Failed to reset weekly views")


@app.get("/drivers/my-drivers")
async def get_my_drivers(
    status: Optional[str] = None,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Get all drivers hired by the current carrier.
    Returns drivers with their availability status from the database.
    """
    try:
        user_role = user.get("role")
        if user_role != "carrier":
            raise HTTPException(status_code=403, detail="Only carriers can view their drivers")
        
        carrier_id = user['uid']
        
        # Get all drivers hired by this carrier
        drivers_ref = db.collection("drivers")
        drivers_query = drivers_ref.where("carrier_id", "==", carrier_id)
        
        # Apply status filter if provided
        if status:
            drivers_query = drivers_query.where("status", "==", status)
        
        drivers_docs = drivers_query.stream()
        
        drivers = []
        for doc in drivers_docs:
            driver_data = doc.to_dict()
            driver_data['id'] = doc.id
            driver_data['driver_id'] = doc.id
            
            # Get is_available from users collection if not in drivers collection
            if 'is_available' not in driver_data:
                user_ref = db.collection("users").document(doc.id)
                user_doc = user_ref.get()
                if user_doc.exists:
                    user_data = user_doc.to_dict()
                    driver_data['is_available'] = user_data.get('is_available', False)
                else:
                    driver_data['is_available'] = False

            # Backfill vehicle_type from users.onboarding_data if missing on driver doc
            if 'vehicle_type' not in driver_data or not driver_data.get('vehicle_type'):
                try:
                    user_ref = db.collection("users").document(doc.id)
                    user_doc = user_ref.get()
                    if user_doc.exists:
                        user_data = user_doc.to_dict() or {}
                        onboarding_str = user_data.get('onboarding_data')
                        if isinstance(onboarding_str, str) and onboarding_str.strip():
                            import json as _json
                            parsed = _json.loads(onboarding_str)
                            if isinstance(parsed, dict):
                                vt = parsed.get('vehicleType') or parsed.get('vehicle_type') or parsed.get('vehicle')
                                if vt:
                                    s = str(vt).strip().lower().replace('-', '_').replace(' ', '_')
                                    if s in {'powerunit', 'power_unit', 'tractor', 'truck', 'semi'}:
                                        s = 'power_unit'
                                    elif s in {'dry', 'dryvan', 'dry_van', 'van'}:
                                        s = 'dry_van'
                                    elif s in {'reefer', 'refrigerated'}:
                                        s = 'reefer'
                                    driver_data['vehicle_type'] = s
                except Exception:
                    pass
            
            drivers.append(driver_data)
        
        return {"drivers": drivers, "total": len(drivers)}
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error fetching my drivers: {e}")
        import traceback
        traceback.print_exc()
        return {"drivers": [], "total": 0}


@app.get("/drivers/my-carrier")
async def get_my_carrier(
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Get carrier information for the current driver.
    Returns the carrier that hired this driver.
    """
    try:
        user_role = user.get("role")
        if user_role != "driver":
            raise HTTPException(status_code=403, detail="Only drivers can view their carrier")
        
        driver_id = user['uid']
        
        # Get driver document to find carrier_id
        driver_ref = db.collection("drivers").document(driver_id)
        driver_doc = driver_ref.get()
        
        if not driver_doc.exists:
            raise HTTPException(status_code=404, detail="Driver profile not found")
        
        driver_data = driver_doc.to_dict()
        carrier_id = driver_data.get("carrier_id")
        
        if not carrier_id:
            # Driver not hired yet
            return JSONResponse(content={
                "carrier": None,
                "message": "You are not currently hired by any carrier"
            })
        
        # Get carrier information
        carrier_ref = db.collection("carriers").document(carrier_id)
        carrier_doc = carrier_ref.get()
        
        if not carrier_doc.exists:
            raise HTTPException(status_code=404, detail="Carrier not found")
        
        carrier_data = carrier_doc.to_dict()
        carrier_data['id'] = carrier_id
        
        return {"carrier": carrier_data}
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error fetching driver's carrier: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Failed to fetch carrier information")


class AssignDriverToLoadRequest(BaseModel):
    driver_id: str
    notes: Optional[str] = None


@app.post("/loads/{load_id}/assign-driver")
async def assign_driver_to_load(
    load_id: str,
    request: AssignDriverToLoadRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Assign a driver to a load.
    Carrier only - can only assign drivers they've hired to loads assigned to them.
    """
    try:
        user_role = user.get("role")
        if user_role != "carrier":
            raise HTTPException(status_code=403, detail="Only carriers can assign drivers to loads")
        
        carrier_id = user['uid']
        
        # Get load from Firestore
        load_ref = db.collection("loads").document(load_id)
        load_doc = load_ref.get()
        
        if not load_doc.exists:
            raise HTTPException(status_code=404, detail="Load not found")
        
        load_data = load_doc.to_dict()
        
        # Check that load is assigned to this carrier (check both field names for compatibility)
        assigned_carrier = load_data.get("assigned_carrier") or load_data.get("assigned_carrier_id")
        if not assigned_carrier or assigned_carrier != carrier_id:
            raise HTTPException(
                status_code=403,
                detail="You can only assign drivers to loads assigned to your carrier"
            )

        # Dispatch gate (backward compatible): if this load is using the contract workflow,
        # require carrier signature before assigning a driver.
        try:
            contract = load_data.get("contract")
            if isinstance(contract, dict) and isinstance(contract.get("rate_confirmation"), dict):
                if not is_rate_con_carrier_signed(load_data):
                    raise HTTPException(
                        status_code=400,
                        detail="Carrier must sign the rate confirmation before dispatching a driver"
                    )
        except HTTPException:
            raise
        except Exception:
            pass
        
        # Check that driver is hired by this carrier
        driver_ref = db.collection("drivers").document(request.driver_id)
        driver_doc = driver_ref.get()
        
        if not driver_doc.exists:
            raise HTTPException(status_code=404, detail="Driver not found")
        
        driver_data = driver_doc.to_dict()
        driver_carrier_id = driver_data.get("carrier_id")
        
        if not driver_carrier_id or driver_carrier_id != carrier_id:
            raise HTTPException(
                status_code=403,
                detail="You can only assign drivers that are hired by your carrier"
            )
        
        # Update load with assigned driver
        # Use both assigned_driver_id and assigned_driver for compatibility
        timestamp = time.time()
        load_ref.update({
            "assigned_driver_id": request.driver_id,
            "assigned_driver": request.driver_id,  # Also set for compatibility with existing queries
            "assigned_driver_name": driver_data.get("name", "Unknown"),
            "driver_assignment_status": "pending",  # Track if driver has accepted
            "assigned_at": timestamp,
            "updated_at": timestamp
        })
        
        # Also update driver status if needed
        current_status = driver_data.get("status", "available")
        if current_status == "available":
            driver_ref.update({
                "status": "assigned",
                "updated_at": timestamp
            })
        
        # Log action
        log_action(carrier_id, "LOAD_ASSIGNED_TO_DRIVER", 
                  f"Assigned load {load_id} to driver {request.driver_id}")
        
        return JSONResponse(content={
            "success": True,
            "message": "Driver assigned to load successfully",
            "load_id": load_id,
            "driver_id": request.driver_id
        })
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error assigning driver to load: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Failed to assign driver to load")


class DriverAcceptLoadRequest(BaseModel):
    accept: bool  # True to accept, False to reject
    notes: Optional[str] = None


@app.post("/loads/{load_id}/driver-accept-assignment")
async def driver_accept_load_assignment(
    load_id: str,
    request: DriverAcceptLoadRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Driver accepts or rejects a load assignment.
    Driver only - can only accept/reject loads assigned to them.
    """
    try:
        user_role = user.get("role")
        if user_role != "driver":
            raise HTTPException(status_code=403, detail="Only drivers can accept/reject load assignments")
        
        driver_id = user['uid']
        
        # Get load from Firestore
        load_ref = db.collection("loads").document(load_id)
        load_doc = load_ref.get()
        
        if not load_doc.exists:
            raise HTTPException(status_code=404, detail="Load not found")
        
        load_data = load_doc.to_dict()
        
        # Check that load is assigned to this driver
        assigned_driver_id = load_data.get("assigned_driver_id") or load_data.get("assigned_driver")
        if not assigned_driver_id or assigned_driver_id != driver_id:
            raise HTTPException(
                status_code=403,
                detail="This load is not assigned to you"
            )
        
        # Check current assignment status
        current_status = load_data.get("driver_assignment_status", "pending")
        if current_status == "accepted":
            raise HTTPException(
                status_code=400,
                detail="You have already accepted this load assignment"
            )
        if current_status == "rejected":
            raise HTTPException(
                status_code=400,
                detail="You have already rejected this load assignment. Contact your carrier to be reassigned."
            )
        
        timestamp = time.time()
        
        if request.accept:
            # Driver accepts the load
            load_ref.update({
                "driver_assignment_status": "accepted",
                "driver_accepted_at": timestamp,
                "updated_at": timestamp
            })
            
            # Log action
            log_action(driver_id, "DRIVER_ACCEPTED_LOAD", f"Driver accepted load assignment {load_id}")
            
            message = "Load assignment accepted successfully"
        else:
            # Driver rejects the load
            load_ref.update({
                "driver_assignment_status": "rejected",
                "driver_rejected_at": timestamp,
                "driver_rejection_notes": request.notes,
                "updated_at": timestamp,
                # Clear driver assignment so carrier can assign to another driver
                "assigned_driver_id": None,
                "assigned_driver": None,
                "assigned_driver_name": None
            })
            
            # Also update driver status back to available
            driver_ref = db.collection("drivers").document(driver_id)
            driver_ref.update({
                "status": "available",
                "updated_at": timestamp
            })
            
            # Log action
            log_action(driver_id, "DRIVER_REJECTED_LOAD", f"Driver rejected load assignment {load_id}")
            
            message = "Load assignment rejected. The carrier can assign it to another driver."
        
        return JSONResponse(content={
            "success": True,
            "message": message,
            "load_id": load_id,
            "driver_id": driver_id,
            "accepted": request.accept
        })
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error processing driver load acceptance: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Failed to process load assignment acceptance")


@app.get("/service-providers")
async def list_service_providers(
    category: Optional[str] = None,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    List all service providers from Firestore.
    Used by shippers, carriers, and drivers to find service providers.
    Optional category filter: factoring, insurance, compliance, legal, repair, medical, testing, dispatch
    """
    try:
        providers_ref = db.collection("service_providers")
        
        # Apply category filter if provided
        if category:
            providers_query = providers_ref.where("category", "==", category)
            providers_docs = providers_query.stream()
        else:
            providers_docs = providers_ref.stream()
        
        providers = []
        for doc in providers_docs:
            provider_data = doc.to_dict()
            provider_data['id'] = doc.id  # Ensure ID is included
            providers.append(provider_data)
        
        # Sort by featured status and rating
        providers.sort(key=lambda x: (x.get('featured', False), x.get('rating', 0)), reverse=True)
        
        return {"providers": providers, "total": len(providers)}
    except Exception as e:
        print(f"Error fetching service providers: {e}")
        return {"providers": [], "total": 0}


@app.post("/match/{load_id}")
def match_for_load(load_id: str, top_n: int = 5):
    load = store.get_load(load_id)
    if not load:
        raise HTTPException(status_code=404, detail="Load not found")
    carriers = store.list_carriers()
    results = match_load(load, carriers, top_n=top_n)
    return {
        "load_id": load_id,
        "matches": [
            {
                "carrier_id": r.carrier_id,
                "score": r.score,
                "reasons": r.reasons,
                "carrier": r.carrier,
            }
            for r in results
        ],
    }


@app.post("/assignments")
def create_assignment(req: AssignmentRequest):
    load = store.get_load(req.load_id)
    carrier = store.get_carrier(req.carrier_id)
    if not load or not carrier:
        raise HTTPException(status_code=404, detail="Load or carrier not found")
    assignment = {
        "load_id": req.load_id,
        "carrier_id": req.carrier_id,
        "reason": req.reason,
    }
    store.save_assignment(assignment)
    create_alert(
        store,
        {
            "type": "assignment",
            "message": f"Assigned carrier {req.carrier_id} to load {req.load_id}",
            "priority": "routine",
            "entity_id": req.load_id,
        },
    )
    return assignment


@app.post("/alerts")
def post_alert(req: AlertRequest):
    alert = create_alert(store, req.dict())
    return alert


@app.get("/alerts")
def get_alerts(priority: Optional[str] = None):
    return {"alerts": list_alerts(store, priority)}


@app.get("/alerts/summary")
def get_alerts_summary():
    return {"summary": summarize_alerts(store)}


@app.get("/alerts/digest")
def get_alerts_digest(limit: int = 20):
    digest = digest_alerts(store, limit=limit)
    # Optional webhook delivery if configured
    webhook = settings.ALERT_WEBHOOK_URL if hasattr(settings, "ALERT_WEBHOOK_URL") else None
    if webhook:
        send_webhook(webhook, digest)
    return digest


# --- Helper Functions ---

def _extract_identifiers(extraction: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    usdot_keys = ["usdot", "usdot_number", "dot_number", "dot"]
    mc_keys = ["mc_number", "mc", "docket_number"]
    usdot = next((str(extraction.get(k)) for k in usdot_keys if extraction.get(k)), None)
    mc_number = next((str(extraction.get(k)) for k in mc_keys if extraction.get(k)), None)
    return usdot, mc_number


def _attempt_fmcsa_verify(usdot: Optional[str], mc_number: Optional[str]) -> Optional[Dict[str, Any]]:
    client = _get_fmcsa_client()
    try:
        verification = client.verify(usdot, mc_number)
    except Exception:
        return None
    store.save_fmcsa_verification(verification)
    profile = client.fetch_profile(verification["usdot"])
    if profile:
        store.save_fmcsa_profile(profile_to_dict(profile))
    return {
        "result": verification.get("result"),
        "reasons": verification.get("reasons", []),
        "usdot": verification.get("usdot"),
        "mc_number": verification.get("mc_number"),
        "fetched_at": verification.get("fetched_at"),
    }


def _get_fmcsa_client() -> FmcsaClient:
    global fmcsa_client
    if fmcsa_client is None:
        fmcsa_client = FmcsaClient()
    return fmcsa_client


def _refresh_fmcsa_all():
    try:
        fmcsa_refresh_all()
    except Exception:
        pass


def _digest_alerts_job():
    digest_alerts(store, limit=50)


# ============================================================================
# Carrier Bidding/Tender Endpoints
# ============================================================================

@app.post("/loads/{load_id}/tender-offer", response_model=LoadActionResponse)
async def carrier_submit_tender(
    load_id: str,
    request: TenderOfferRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Carrier submits a tender offer/bid on a shipper-posted load.
    
    Authorization: Only carriers can submit bids
    Requirements:
    - Load must be status=POSTED
    - Load must be created by shipper/broker (creator_role in [shipper, broker])
    - Carrier cannot bid on their own loads
    
    Business Logic:
    - Carrier views shipper-posted loads in marketplace
    - Carrier submits bid with rate, notes, ETA
    - Offer stored in load.offers array
    - Shipper reviews offers and accepts one carrier
    """
    uid = user['uid']
    user_role = user.get("role", "")
    
    # Role check: Must be carrier
    if user_role != "carrier":
        raise HTTPException(
            status_code=403,
            detail="Only carriers can submit tender offers"
        )
    
    # Get load from Firestore first, fallback to local storage
    load = None
    try:
        load_doc = db.collection("loads").document(load_id).get()
        if load_doc.exists:
            load = load_doc.to_dict()
            load["load_id"] = load_id
    except Exception as e:
        print(f"Error fetching load from Firestore: {e}")
    
    # Fallback to local storage if Firestore doesn't have it
    if not load:
        load = store.get_load(load_id)
    
    if not load:
        raise HTTPException(status_code=404, detail="Load not found")
    
    # Cannot bid on own loads
    if load.get("created_by") == uid:
        raise HTTPException(
            status_code=400,
            detail="Cannot bid on your own load"
        )
    
    # Status check: Must be POSTED
    if load.get("status") != LoadStatus.POSTED.value:
        raise HTTPException(
            status_code=400,
            detail=f"Load is not available for bidding (status: {load.get('status')})"
        )
    
    # Creator role check: Can bid on shipper/broker/carrier loads
    # (Allows carrier-to-carrier brokerage for subcontracting)
    creator_role = load.get("creator_role", "")
    if creator_role not in ["shipper", "broker", "carrier"]:
        raise HTTPException(
            status_code=400,
            detail="Can only bid on shipper/broker/carrier-posted loads"
        )
    
    # Check if carrier already has a pending offer
    existing_offers = load.get("offers", [])
    for offer in existing_offers:
        if offer.get("carrier_id") == uid and offer.get("status") == "pending":
            raise HTTPException(
                status_code=400,
                detail="You already have a pending offer on this load"
            )
    
    # Create offer
    timestamp = time.time()
    offer = {
        "offer_id": f"OFFER-{int(timestamp)}-{uid[:8]}",
        "load_id": load_id,
        "carrier_id": uid,
        "carrier_name": user.get("display_name", user.get("email", "Unknown Carrier")),
        "rate": request.rate,
        "notes": request.notes or "",
        "eta": request.eta or "",
        "status": "pending",
        "submitted_at": timestamp
    }
    
    # Add offer to load
    if "offers" not in load:
        load["offers"] = []
    load["offers"].append(offer)
    
    # Update Firestore (primary storage)
    try:
        load_ref = db.collection("loads").document(load_id)
        patch = {
            "offers": load["offers"],
            "updated_at": timestamp,
        }

        # Workflow: first bid transitions Posted -> Tendered (best-effort)
        try:
            ws = str(load.get("workflow_status") or "").strip()
            if not ws or ws == "Posted":
                patch["workflow_status"] = "Tendered"
                patch["workflow_status_updated_at"] = timestamp
        except Exception:
            pass

        load_ref.update(patch)
    except Exception as e:
        print(f"Error updating Firestore: {e}")
        raise HTTPException(status_code=500, detail="Failed to save bid to database")
    
    # Also update local storage as backup
    try:
        store_patch = {"offers": load["offers"], "updated_at": timestamp}
        try:
            if (not str(load.get("workflow_status") or "").strip()) or str(load.get("workflow_status") or "").strip() == "Posted":
                store_patch["workflow_status"] = "Tendered"
                store_patch["workflow_status_updated_at"] = timestamp
        except Exception:
            pass
        store.update_load(load_id, store_patch)
    except Exception as e:
        print(f"Warning: Could not update local storage: {e}")
    
    # Log action
    log_action(uid, "CARRIER_SUBMIT_TENDER", f"Load {load_id}: Submitted tender offer (Rate: ${request.rate})")
    
    # Create notification for shipper about the new bid
    try:
        shipper_uid = load.get("created_by")
        notify_on_offer_received = True
        try:
            notify_on_offer_received = bool(load.get("notify_on_offer_received", True))
        except Exception:
            notify_on_offer_received = True

        if shipper_uid and notify_on_offer_received:
            # Get carrier information
            carrier_name = user.get("display_name", user.get("email", "Unknown Carrier"))
            carrier_email = user.get("email", "")
            
            # Get load details for notification
            load_origin = load.get("origin", "Unknown")
            load_destination = load.get("destination", "Unknown")
            
            notification_id = str(uuid.uuid4())
            notification_data = {
                "id": notification_id,
                "user_id": shipper_uid,
                "notification_type": "load_update",
                "title": f"New Bid Received on Load {load_id}",
                "message": f"{carrier_name} has submitted a bid of ${request.rate} for your load from {load_origin} to {load_destination}.",
                "resource_type": "bid",
                "resource_id": offer["offer_id"],
                "action_url": f"/shipper-dashboard?nav=carrier-bids",
                "is_read": False,
                "created_at": int(timestamp),
                "bid_data": {
                    "offer_id": offer["offer_id"],
                    "load_id": load_id,
                    "carrier_id": uid,
                    "carrier_name": carrier_name,
                    "carrier_email": carrier_email,
                    "rate": request.rate,
                    "notes": request.notes or "",
                    "eta": request.eta or "",
                    "submitted_at": timestamp
                }
            }
            
            # Save notification to Firestore
            db.collection("notifications").document(notification_id).set(notification_data)
            log_action(shipper_uid, "NOTIFICATION_CREATED", f"Bid notification for load {load_id} from carrier {uid}")
    except Exception as e:
        print(f"Error creating notification for shipper: {e}")
        # Don't fail the bid submission if notification fails
    
    return LoadActionResponse(
        success=True,
        message=f"Tender offer submitted successfully for load {load_id}",
        load_id=load_id,
        data={
            "offer_id": offer["offer_id"],
            "rate": request.rate,
            "submitted_at": timestamp
        }
    )


@app.get("/shipper/bids", response_model=Dict[str, Any])
async def get_all_shipper_bids(
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Get all bids across all loads created by the shipper.
    
    Authorization: Only shippers/brokers can view their bids
    """
    uid = user['uid']
    user_role = user.get("role", "")
    
    if user_role not in ["shipper", "broker", "admin", "super_admin"]:
        raise HTTPException(
            status_code=403,
            detail="Only shippers can view bids on their loads"
        )
    
    # Get all loads created by this shipper from Firestore
    try:
        loads_ref = db.collection("loads")
        query = loads_ref.where("created_by", "==", uid)
        all_loads_docs = query.stream()
        
        all_bids = []
        for doc in all_loads_docs:
            load = doc.to_dict()
            load_id = doc.id
            load["load_id"] = load_id
            
            # Get offers from the load
            offers = load.get("offers", [])
            for offer in offers:
                bid_info = {
                    "offer_id": offer.get("offer_id", ""),
                    "load_id": load_id,
                    "load_origin": load.get("origin", "Unknown"),
                    "load_destination": load.get("destination", "Unknown"),
                    "load_status": load.get("status", ""),
                    "carrier_id": offer.get("carrier_id", ""),
                    "carrier_name": offer.get("carrier_name", "Unknown Carrier"),
                    "rate": offer.get("rate", 0.0),
                    "notes": offer.get("notes", ""),
                    "eta": offer.get("eta", ""),
                    "status": offer.get("status", "pending"),
                    "submitted_at": offer.get("submitted_at", 0.0)
                }
                all_bids.append(bid_info)
        
        # Sort by submission time (newest first)
        all_bids.sort(key=lambda x: x.get("submitted_at", 0), reverse=True)
        
        return {
            "bids": all_bids,
            "total": len(all_bids)
        }
    except Exception as e:
        print(f"Error fetching shipper bids from Firestore: {e}")
        # Fallback to local storage if Firestore fails
        filters = {"created_by": uid}
        all_loads = store.list_loads(filters)
        all_bids = []
        for load in all_loads:
            load_id = load.get("load_id")
            offers = load.get("offers", [])
            for offer in offers:
                bid_info = {
                    "offer_id": offer.get("offer_id", ""),
                    "load_id": load_id,
                    "load_origin": load.get("origin", "Unknown"),
                    "load_destination": load.get("destination", "Unknown"),
                    "load_status": load.get("status", ""),
                    "carrier_id": offer.get("carrier_id", ""),
                    "carrier_name": offer.get("carrier_name", "Unknown Carrier"),
                    "rate": offer.get("rate", 0.0),
                    "notes": offer.get("notes", ""),
                    "eta": offer.get("eta", ""),
                    "status": offer.get("status", "pending"),
                    "submitted_at": offer.get("submitted_at", 0.0)
                }
                all_bids.append(bid_info)
        all_bids.sort(key=lambda x: x.get("submitted_at", 0), reverse=True)
        return {
            "bids": all_bids,
            "total": len(all_bids)
        }


@app.get("/loads/{load_id}/offers", response_model=OffersListResponse)
async def get_load_offers(
    load_id: str,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Get all offers on a load.
    
    Authorization:
    - Shipper/Broker: Can view offers on loads they created
    - Admin: Can view all offers
    - Carriers/Drivers: Cannot view offers (privacy)
    
    Business Logic:
    - Shipper reviews offers from multiple carriers
    - Shipper accepts one carrier using /accept-carrier endpoint
    """
    uid = user['uid']
    user_role = user.get("role", "")
    
    # Get load from Firestore first, fallback to local storage
    load = None
    try:
        load_doc = db.collection("loads").document(load_id).get()
        if load_doc.exists:
            load = load_doc.to_dict()
            load["load_id"] = load_id
    except Exception as e:
        print(f"Error fetching load from Firestore: {e}")
    
    # Fallback to local storage if Firestore doesn't have it
    if not load:
        load = store.get_load(load_id)
    
    if not load:
        raise HTTPException(status_code=404, detail="Load not found")
    
    # Authorization check
    if user_role in ["admin", "super_admin"]:
        # Admins can view all
        pass
    elif user_role in ["shipper", "broker"]:
        # Shippers can only view offers on their own loads
        if load.get("created_by") != uid:
            raise HTTPException(
                status_code=403,
                detail="You can only view offers on loads you created"
            )
    else:
        # Carriers and drivers cannot view offers (prevents seeing competing bids)
        raise HTTPException(
            status_code=403,
            detail="Only shippers can view offers on loads"
        )
    
    # Get offers
    offers = load.get("offers", [])
    
    # Convert to OfferResponse models
    offer_responses = [
        OfferResponse(
            offer_id=offer.get("offer_id", ""),
            load_id=load_id,
            carrier_id=offer.get("carrier_id", ""),
            carrier_name=offer.get("carrier_name", "Unknown"),
            rate=offer.get("rate", 0.0),
            notes=offer.get("notes"),
            eta=offer.get("eta"),
            status=offer.get("status", "pending"),
            submitted_at=offer.get("submitted_at", 0.0)
        )
        for offer in offers
    ]
    
    return OffersListResponse(
        load_id=load_id,
        offers=offer_responses
    )


# ============================================================================
# Shipper Load Management Endpoints
# ============================================================================

@app.post("/loads/{load_id}/accept-carrier", response_model=LoadActionResponse)
async def shipper_accept_carrier(
    load_id: str,
    request: AcceptCarrierRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Shipper accepts a carrier for a POSTED load, transitioning it to COVERED.
    
    Authorization: Only shipper who created the load
    Valid transition: POSTED → COVERED
    """
    uid = user['uid']
    user_role = user.get("role", "")
    
    # Role check: Must be shipper or broker
    if user_role not in ["shipper", "broker", "admin", "super_admin"]:
        raise HTTPException(
            status_code=403,
            detail="Only shippers and brokers can accept carriers for loads"
        )
    
    # Get load from Firestore first, fallback to local storage
    load = None
    try:
        load_doc = db.collection("loads").document(load_id).get()
        if load_doc.exists:
            load = load_doc.to_dict()
            load["load_id"] = load_id
    except Exception as e:
        print(f"Error fetching load from Firestore: {e}")
    
    # Fallback to local storage if Firestore doesn't have it
    if not load:
        load = store.get_load(load_id)
    
    if not load:
        raise HTTPException(status_code=404, detail="Load not found")
    
    # Ownership check
    if load.get("created_by") != uid:
        raise HTTPException(
            status_code=403,
            detail="You can only accept carriers for loads you created"
        )
    
    # Status validation
    current_status = load.get("status", "")
    if current_status != LoadStatus.POSTED.value:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot accept carrier for load with status '{current_status}'. Load must be POSTED."
        )
    
    # Handle offer acceptance if offer_id provided
    offers = load.get("offers", [])
    
    # Ensure offers is a list
    if not isinstance(offers, list):
        offers = []
    
    # Debug: Print offers for troubleshooting
    print(f"DEBUG: Load {load_id} has {len(offers)} offers")
    print(f"DEBUG: Request offer_id: {request.offer_id}, carrier_id: {request.carrier_id}")
    print(f"DEBUG: Offers: {offers}")
    
    if not offers or len(offers) == 0:
        raise HTTPException(
            status_code=400,
            detail="This load has no offers to accept"
        )
    
    accepted_offer = None
    carrier_name_to_use = request.carrier_name
    
    if request.offer_id:
        # Find and mark the accepted offer
        offer_found = False
        for offer in offers:
            # Handle both dict and object types
            offer_id = offer.get("offer_id") if isinstance(offer, dict) else getattr(offer, "offer_id", None)
            offer_carrier_id = offer.get("carrier_id") if isinstance(offer, dict) else getattr(offer, "carrier_id", None)
            offer_status = offer.get("status") if isinstance(offer, dict) else getattr(offer, "status", "pending")
            
            # Compare offer_id as strings to handle any type mismatches
            if offer_id and request.offer_id and str(offer_id) == str(request.offer_id):
                if str(offer_carrier_id) != str(request.carrier_id):
                    raise HTTPException(
                        status_code=400,
                        detail=f"Offer carrier_id ({offer_carrier_id}) does not match request carrier_id ({request.carrier_id})"
                    )
                # Update offer status
                if isinstance(offer, dict):
                    offer["status"] = "accepted"
                    offer["accepted_at"] = time.time()
                    accepted_offer = offer.copy()  # Make a copy to avoid reference issues
                    if not carrier_name_to_use:
                        carrier_name_to_use = offer.get("carrier_name", "Unknown Carrier")
                else:
                    offer.status = "accepted"
                    offer.accepted_at = time.time()
                    accepted_offer = offer
                    if not carrier_name_to_use:
                        carrier_name_to_use = getattr(offer, "carrier_name", "Unknown Carrier")
                offer_found = True
                print(f"DEBUG: Found and accepted offer {request.offer_id} for carrier {request.carrier_id}")
                break  # Exit loop once we found the offer
            elif offer_status and str(offer_status).lower() == "pending":
                # Reject all other pending offers
                if isinstance(offer, dict):
                    offer["status"] = "rejected"
                    offer["rejected_at"] = time.time()
                    offer["rejection_reason"] = "Another carrier was selected"
                else:
                    offer.status = "rejected"
                    offer.rejected_at = time.time()
                    offer.rejection_reason = "Another carrier was selected"
        
        if not offer_found:
            available_offer_ids = [o.get("offer_id") if isinstance(o, dict) else getattr(o, "offer_id", None) for o in offers]
            raise HTTPException(
                status_code=404,
                detail=f"Offer with ID '{request.offer_id}' not found on this load. Available offer IDs: {available_offer_ids}"
            )
    else:
        # If no offer_id provided, try to find offer by carrier_id
        offer_found_by_carrier = False
        for offer in offers:
            offer_carrier_id = offer.get("carrier_id") if isinstance(offer, dict) else getattr(offer, "carrier_id", None)
            offer_status = offer.get("status") if isinstance(offer, dict) else getattr(offer, "status", "pending")
            
            # Compare carrier_id as strings to handle any type mismatches
            if offer_carrier_id and request.carrier_id and str(offer_carrier_id) == str(request.carrier_id) and offer_status and str(offer_status).lower() == "pending":
                # Update offer status
                if isinstance(offer, dict):
                    offer["status"] = "accepted"
                    offer["accepted_at"] = time.time()
                    accepted_offer = offer.copy()  # Make a copy to avoid reference issues
                    if not carrier_name_to_use:
                        carrier_name_to_use = offer.get("carrier_name", "Unknown Carrier")
                else:
                    offer.status = "accepted"
                    offer.accepted_at = time.time()
                    accepted_offer = offer
                    if not carrier_name_to_use:
                        carrier_name_to_use = getattr(offer, "carrier_name", "Unknown Carrier")
                offer_found_by_carrier = True
                print(f"DEBUG: Found and accepted offer for carrier {request.carrier_id} (no offer_id provided)")
                
                # Reject other pending offers
                for other_offer in offers:
                    other_offer_id = other_offer.get("offer_id") if isinstance(other_offer, dict) else getattr(other_offer, "offer_id", None)
                    other_offer_status = other_offer.get("status") if isinstance(other_offer, dict) else getattr(other_offer, "status", "pending")
                    current_offer_id = offer.get("offer_id") if isinstance(offer, dict) else getattr(offer, "offer_id", None)
                    
                    if other_offer_id and current_offer_id and str(other_offer_id) != str(current_offer_id) and other_offer_status and str(other_offer_status).lower() == "pending":
                        if isinstance(other_offer, dict):
                            other_offer["status"] = "rejected"
                            other_offer["rejected_at"] = time.time()
                            other_offer["rejection_reason"] = "Another carrier was selected"
                        else:
                            other_offer.status = "rejected"
                            other_offer.rejected_at = time.time()
                            other_offer.rejection_reason = "Another carrier was selected"
                break
        
        if not offer_found_by_carrier:
            raise HTTPException(
                status_code=404,
                detail=f"No pending offer found for carrier {request.carrier_id} on this load"
            )
    
    # Use carrier_name from offer if still not set
    if not carrier_name_to_use and accepted_offer:
        if isinstance(accepted_offer, dict):
            carrier_name_to_use = accepted_offer.get("carrier_name", "Unknown Carrier")
        else:
            carrier_name_to_use = getattr(accepted_offer, "carrier_name", "Unknown Carrier")
    elif not carrier_name_to_use:
        carrier_name_to_use = "Unknown Carrier"
    
    # Validate that we have an accepted offer
    if not accepted_offer:
        raise HTTPException(
            status_code=400,
            detail="No offer was accepted. Please ensure the offer_id and carrier_id are correct."
        )
    
    # Update load
    timestamp = time.time()
    updates = {
        "status": LoadStatus.COVERED.value,
        "workflow_status": "Awarded",
        "workflow_status_updated_at": timestamp,
        "assigned_carrier": request.carrier_id,
        "assigned_carrier_id": request.carrier_id,  # Also set assigned_carrier_id for consistency
        "carrier_id": request.carrier_id,
        "carrier_uid": request.carrier_id,
        "assigned_carrier_name": carrier_name_to_use,
        "covered_at": timestamp,
        "updated_at": timestamp
    }
    
    # Update offers if any were modified (always include offers array)
    # Convert offers to list of dicts if needed for Firestore
    offers_list = []
    for offer in offers:
        if isinstance(offer, dict):
            offers_list.append(offer)
        else:
            # Convert object to dict
            offers_list.append({
                "offer_id": getattr(offer, "offer_id", ""),
                "carrier_id": getattr(offer, "carrier_id", ""),
                "carrier_name": getattr(offer, "carrier_name", "Unknown"),
                "rate": getattr(offer, "rate", 0.0),
                "notes": getattr(offer, "notes", ""),
                "eta": getattr(offer, "eta", ""),
                "status": getattr(offer, "status", "pending"),
                "submitted_at": getattr(offer, "submitted_at", 0.0),
                "accepted_at": getattr(offer, "accepted_at", None),
                "rejected_at": getattr(offer, "rejected_at", None),
                "rejection_reason": getattr(offer, "rejection_reason", None)
            })
    
    updates["offers"] = offers_list
    
    # Update Firestore (primary storage)
    try:
        load_ref = db.collection("loads").document(load_id)
        # Convert any non-serializable values for Firestore
        firestore_updates = {}
        for key, value in updates.items():
            if key == "offers" and isinstance(value, list):
                # Ensure offers are properly formatted
                firestore_updates[key] = value
            elif isinstance(value, (str, int, float, bool, type(None))):
                firestore_updates[key] = value
            else:
                # Try to convert other types
                try:
                    firestore_updates[key] = value
                except:
                    print(f"Warning: Could not serialize {key} for Firestore")
        
        load_ref.update(firestore_updates)
        print(f"DEBUG: Successfully updated load {load_id} in Firestore with status {LoadStatus.COVERED.value}")
    except Exception as e:
        print(f"Error updating Firestore: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to accept bid in database: {str(e)}")
    
    # Also update local storage as backup
    try:
        store.update_load(load_id, updates)
    except Exception as e:
        print(f"Warning: Could not update local storage: {e}")
    
    # Log status change
    log_entry = {
        "timestamp": timestamp,
        "actor_uid": uid,
        "actor_role": user_role,
        "old_status": current_status,
        "new_status": LoadStatus.COVERED.value,
        "notes": f"Shipper accepted carrier {carrier_name_to_use or request.carrier_id}",
        "metadata": {
            "carrier_id": request.carrier_id,
            "carrier_name": carrier_name_to_use,
            "shipper_notes": request.notes
        }
    }
    store.add_status_change_log(load_id, log_entry)
    
    # Log action
    log_action(uid, "SHIPPER_ACCEPT_CARRIER", f"Load {load_id}: POSTED → COVERED (Carrier: {request.carrier_id})")
    
    # Add status log to Firestore (load update already done above)
    try:
        load_ref = db.collection("loads").document(load_id)
        logs_ref = load_ref.collection("status_logs").document()
        logs_ref.set(log_entry)
    except Exception as e:
        print(f"Warning: Could not add status log to Firestore: {e}")

    # Notify non-selected carriers that the load was awarded (best-effort).
    try:
        rejected_carrier_ids = []
        for o in offers_list:
            try:
                if str(o.get("status") or "").lower() == "rejected":
                    cid = str(o.get("carrier_id") or "").strip()
                    if cid and cid != str(request.carrier_id):
                        rejected_carrier_ids.append(cid)
            except Exception:
                continue

        if rejected_carrier_ids:
            for cid in sorted(set(rejected_carrier_ids)):
                notif_id = str(uuid.uuid4())
                db.collection("notifications").document(notif_id).set(
                    {
                        "id": notif_id,
                        "user_id": cid,
                        "notification_type": "load_awarded",
                        "title": f"Load {load.get('load_number') or load_id} awarded",
                        "message": "This load was awarded to another carrier.",
                        "resource_type": "load",
                        "resource_id": load_id,
                        "action_url": f"/carrier-dashboard?nav=marketplace&load_id={load_id}",
                        "is_read": False,
                        "created_at": int(timestamp),
                        "load_id": load_id,
                    }
                )
    except Exception as e:
        print(f"Warning: could not notify rejected carriers: {e}")

    # Auto-generate and attach a Rate Confirmation PDF (best-effort).
    try:
        rc = ensure_rate_confirmation_document(load_id=load_id, shipper=user)
        if rc and rc.get("url"):
            try:
                db.collection("loads").document(load_id).update({"rate_confirmation_url": rc.get("url"), "rate_confirmation_doc_id": rc.get("doc_id")})
            except Exception:
                pass
    except Exception as e:
        print(f"Warning: Rate confirmation generation failed: {e}")
    
    return LoadActionResponse(
        success=True,
        message=f"Carrier {request.carrier_name or request.carrier_id} accepted for load {load_id}",
        load_id=load_id,
        new_status=LoadStatus.COVERED.value,
        data={
            "carrier_id": request.carrier_id,
            "carrier_name": request.carrier_name,
            "covered_at": timestamp
        }
    )


@app.post("/loads/{load_id}/reject-offer", response_model=LoadActionResponse)
async def shipper_reject_offer(
    load_id: str,
    request: RejectOfferRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Shipper rejects a carrier offer for a load.
    Load remains in POSTED status.
    
    Authorization: Only shipper who created the load
    """
    uid = user['uid']
    user_role = user.get("role", "")
    
    # Role check: Must be shipper or broker
    if user_role not in ["shipper", "broker", "admin", "super_admin"]:
        raise HTTPException(
            status_code=403,
            detail="Only shippers and brokers can reject carrier offers"
        )
    
    # Validate that either offer_id or carrier_id is provided
    if not request.offer_id and not request.carrier_id:
        raise HTTPException(
            status_code=400,
            detail="Either offer_id or carrier_id must be provided"
        )
    
    # Get load from Firestore first, fallback to local storage
    load = None
    try:
        load_doc = db.collection("loads").document(load_id).get()
        if load_doc.exists:
            load = load_doc.to_dict()
            load["load_id"] = load_id
    except Exception as e:
        print(f"Error fetching load from Firestore: {e}")
    
    # Fallback to local storage if Firestore doesn't have it
    if not load:
        load = store.get_load(load_id)
    
    if not load:
        raise HTTPException(status_code=404, detail="Load not found")
    
    # Ownership check
    if load.get("created_by") != uid:
        raise HTTPException(
            status_code=403,
            detail="You can only reject offers for loads you created"
        )
    
    # Status validation - can only reject offers on POSTED loads
    current_status = load.get("status", "")
    if current_status != LoadStatus.POSTED.value:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot reject offer for load with status '{current_status}'. Load must be POSTED."
        )
    
    # Get offers
    offers = load.get("offers", [])


# ============================================================================
# Admin: Backfill normalized load ownership fields
# ============================================================================


@app.post("/admin/loads/backfill-ownership")
async def admin_backfill_load_ownership(
    limit: int = 500,
    dry_run: bool = True,
    user: Dict[str, Any] = Depends(require_admin),
):
    _ = user

    scanned = 0
    updated = 0
    skipped = 0
    errors: list = []

    try:
        stream_iter = db.collection("loads").stream()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to stream loads: {e}")

    for snap in stream_iter:
        scanned += 1
        if scanned > int(limit):
            break
        try:
            d = snap.to_dict() or {}
            d.setdefault("load_id", snap.id)
            patch = normalized_ownership_patch_for_load(d)
            if not patch:
                skipped += 1
                continue
            if not dry_run:
                db.collection("loads").document(snap.id).set(patch, merge=True)
            updated += 1
        except Exception as e:
            errors.append({"load_id": getattr(snap, "id", None), "error": str(e)})

    return {
        "dry_run": bool(dry_run),
        "limit": int(limit),
        "scanned": scanned,
        "updated": updated,
        "skipped": skipped,
        "errors": errors[:25],
    }
    
    # Ensure offers is a list
    if not isinstance(offers, list):
        offers = []
    
    if not offers or len(offers) == 0:
        raise HTTPException(
            status_code=400,
            detail="This load has no offers to reject"
        )
    
    # Find the offer to reject
    offer_found = False
    rejected_offer = None
    
    for offer in offers:
        # Handle both dict and object types
        offer_id = offer.get("offer_id") if isinstance(offer, dict) else getattr(offer, "offer_id", None)
        offer_carrier_id = offer.get("carrier_id") if isinstance(offer, dict) else getattr(offer, "carrier_id", None)
        offer_status = offer.get("status") if isinstance(offer, dict) else getattr(offer, "status", "pending")
        
        # Check if this is the offer to reject
        should_reject = False
        
        if request.offer_id:
            # Prefer offer_id if provided
            if offer_id and str(offer_id) == str(request.offer_id):
                should_reject = True
                # Validate carrier_id matches if provided
                if request.carrier_id and str(offer_carrier_id) != str(request.carrier_id):
                    raise HTTPException(
                        status_code=400,
                        detail=f"Offer carrier_id ({offer_carrier_id}) does not match request carrier_id ({request.carrier_id})"
                    )
        elif request.carrier_id:
            # Fallback to carrier_id
            if offer_carrier_id and str(offer_carrier_id) == str(request.carrier_id):
                # Only reject if status is pending (don't reject already rejected/accepted offers)
                if offer_status and str(offer_status).lower() == "pending":
                    should_reject = True
        
        if should_reject:
            # Update offer status
            timestamp = time.time()
            if isinstance(offer, dict):
                offer["status"] = "rejected"
                offer["rejected_at"] = timestamp
                offer["rejection_reason"] = request.reason or "Shipper rejected offer"
                rejected_offer = offer.copy()
            else:
                offer.status = "rejected"
                offer.rejected_at = timestamp
                offer.rejection_reason = request.reason or "Shipper rejected offer"
                rejected_offer = offer
            
            offer_found = True
            print(f"DEBUG: Found and rejected offer {offer_id or 'N/A'} for carrier {offer_carrier_id}")
            break
    
    if not offer_found:
        available_offer_ids = [o.get("offer_id") if isinstance(o, dict) else getattr(o, "offer_id", None) for o in offers]
        raise HTTPException(
            status_code=404,
            detail=f"Offer not found. Requested: offer_id={request.offer_id}, carrier_id={request.carrier_id}. Available offer IDs: {available_offer_ids}"
        )
    
    # Get carrier info for logging
    if isinstance(rejected_offer, dict):
        carrier_id_to_log = rejected_offer.get("carrier_id", request.carrier_id or "Unknown")
        carrier_name_to_log = rejected_offer.get("carrier_name", "Unknown Carrier")
    else:
        carrier_id_to_log = getattr(rejected_offer, "carrier_id", request.carrier_id or "Unknown")
        carrier_name_to_log = getattr(rejected_offer, "carrier_name", "Unknown Carrier")
    
    # Update load with modified offers
    timestamp = time.time()
    
    # Convert offers to list of dicts if needed for Firestore
    offers_list = []
    for offer in offers:
        if isinstance(offer, dict):
            offers_list.append(offer)
        else:
            # Convert object to dict
            offers_list.append({
                "offer_id": getattr(offer, "offer_id", ""),
                "carrier_id": getattr(offer, "carrier_id", ""),
                "carrier_name": getattr(offer, "carrier_name", "Unknown"),
                "rate": getattr(offer, "rate", 0.0),
                "notes": getattr(offer, "notes", ""),
                "eta": getattr(offer, "eta", ""),
                "status": getattr(offer, "status", "pending"),
                "submitted_at": getattr(offer, "submitted_at", 0.0),
                "accepted_at": getattr(offer, "accepted_at", None),
                "rejected_at": getattr(offer, "rejected_at", None),
                "rejection_reason": getattr(offer, "rejection_reason", None)
            })
    
    updates = {
        "offers": offers_list,
        "updated_at": timestamp
    }
    
    # Update Firestore (primary storage)
    try:
        load_ref = db.collection("loads").document(load_id)
        firestore_updates = {
            "offers": offers_list,
            "updated_at": timestamp
        }
        load_ref.update(firestore_updates)
        print(f"DEBUG: Successfully updated load {load_id} in Firestore with rejected offer")
    except Exception as e:
        print(f"Error updating Firestore: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to reject offer in database: {str(e)}")
    
    # Also update local storage as backup
    try:
        store.update_load(load_id, updates)
    except Exception as e:
        print(f"Warning: Could not update local storage: {e}")
    
    # Log rejection
    log_entry = {
        "timestamp": timestamp,
        "actor_uid": uid,
        "actor_role": user_role,
        "old_status": current_status,
        "new_status": current_status,  # Status unchanged
        "notes": f"Shipper rejected offer from carrier {carrier_name_to_log} ({carrier_id_to_log})",
        "metadata": {
            "carrier_id": carrier_id_to_log,
            "carrier_name": carrier_name_to_log,
            "rejection_reason": request.reason
        }
    }
    store.add_status_change_log(load_id, log_entry)
    
    # Log action
    log_action(uid, "SHIPPER_REJECT_OFFER", f"Load {load_id}: Rejected carrier {carrier_id_to_log}")
    
    # Add rejection log to Firestore
    try:
        load_ref = db.collection("loads").document(load_id)
        logs_ref = load_ref.collection("status_logs").document()
        logs_ref.set(log_entry)
    except Exception as e:
        print(f"Warning: Could not add status log to Firestore: {e}")
    
    return LoadActionResponse(
        success=True,
        message=f"Offer from carrier {carrier_name_to_log} rejected",
        load_id=load_id,
        new_status=current_status,
        data={
            "carrier_id": carrier_id_to_log,
            "carrier_name": carrier_name_to_log,
            "rejection_reason": request.reason
        }
    )


@app.patch("/loads/{load_id}", response_model=LoadActionResponse)
async def update_load_restricted(
    load_id: str,
    request: Dict[str, Any],
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Update load fields like pickup_confirmed, timestamps, GPS coordinates.
    
    Authorization: 
    - Drivers can update pickup/delivery timestamps and GPS
    - Shippers cannot edit COVERED loads
    """
    uid = user['uid']
    user_role = user.get("role", "")
    
    # Get load from Firestore first, fallback to JSON storage
    load = None
    try:
        load_ref = db.collection("loads").document(load_id).get()
        if load_ref.exists:
            load = load_ref.to_dict()
            load["load_id"] = load_ref.id
    except Exception as e:
        print(f"Firestore query error: {e}")
    
    if not load:
        load = store.get_load(load_id)
    
    if not load:
        raise HTTPException(status_code=404, detail="Load not found")
    
    # Authorization checks
    if user_role == "driver":
        # Drivers can only update their assigned loads
        if load.get("assigned_driver") != uid:
            raise HTTPException(
                status_code=403,
                detail="You can only update loads assigned to you"
            )
    elif user_role == "shipper":
        # Ownership check
        if load.get("created_by") != uid:
            raise HTTPException(
                status_code=403,
                detail="Not authorized to edit this load"
            )
        # Status restriction for shippers
        current_status = load.get("status", "")
        if current_status in [LoadStatus.COVERED.value, LoadStatus.IN_TRANSIT.value, 
                              LoadStatus.DELIVERED.value, LoadStatus.COMPLETED.value]:
            raise HTTPException(
                status_code=403,
                detail=f"Cannot edit load with status '{current_status}'. Shippers cannot modify loads after COVERED."
            )
    
    # Update the load in Firestore
    timestamp = time.time()
    updates = {
        "updated_at": timestamp
    }
    
    # Add any fields from the request
    if "pickup_confirmed" in request:
        updates["pickup_confirmed"] = request["pickup_confirmed"]
    if "pickup_timestamp" in request:
        updates["pickup_timestamp"] = request["pickup_timestamp"]
    if "delivery_timestamp" in request:
        updates["delivery_timestamp"] = request["delivery_timestamp"]
    if "latitude" in request and "longitude" in request:
        updates["current_location"] = {
            "latitude": request["latitude"],
            "longitude": request["longitude"],
            "timestamp": timestamp
        }
    
    # Update in Firestore
    try:
        db.collection("loads").document(load_id).update(updates)
        print(f"✅ Load {load_id} updated in Firestore: {updates}")
    except Exception as e:
        print(f"⚠️ Firestore update failed: {e}")
    
    # Update in JSON storage as fallback
    store.update_load(load_id, updates)
    
    return LoadActionResponse(
        success=True,
        message="Load updated successfully",
        load_id=load_id,
        new_status=load.get("status")
    )


@app.delete("/loads/{load_id}/cancel", response_model=LoadActionResponse)
async def shipper_cancel_load(
    load_id: str,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Shipper cancels a load (only if not COVERED).
    
    Authorization: Only shipper who created the load
    Valid statuses: DRAFT, POSTED (cannot cancel COVERED or later)
    """
    uid = user['uid']
    user_role = user.get("role", "")
    
    # Role check: Must be shipper
    if user_role != "shipper":
        raise HTTPException(
            status_code=403,
            detail="Only shippers can cancel their loads"
        )
    
    # Get load
    load = store.get_load(load_id)
    if not load:
        raise HTTPException(status_code=404, detail="Load not found")
    
    # Ownership check
    if load.get("created_by") != uid:
        raise HTTPException(
            status_code=403,
            detail="You can only cancel loads you created"
        )
    
    # Status validation
    current_status = load.get("status", "")
    if current_status not in [LoadStatus.DRAFT.value, LoadStatus.POSTED.value]:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot cancel load with status '{current_status}'. Can only cancel DRAFT or POSTED loads."
        )
    
    # Update to cancelled
    timestamp = time.time()
    updates = {
        "status": LoadStatus.CANCELLED.value,
        "cancelled_at": timestamp,
        "updated_at": timestamp
    }
    store.update_load(load_id, updates)
    
    # Log status change
    log_entry = {
        "timestamp": timestamp,
        "actor_uid": uid,
        "actor_role": user_role,
        "old_status": current_status,
        "new_status": LoadStatus.CANCELLED.value,
        "notes": "Shipper cancelled load",
        "metadata": {}
    }
    store.add_status_change_log(load_id, log_entry)
    
    # Log action
    log_action(uid, "SHIPPER_CANCEL_LOAD", f"Load {load_id}: {current_status} → CANCELLED")
    
    # Update Firestore
    try:
        load_ref = db.collection("loads").document(load_id)
        load_ref.update(updates)
        logs_ref = load_ref.collection("status_logs").document()
        logs_ref.set(log_entry)
    except Exception as e:
        print(f"Warning: Could not update Firestore: {e}")
    
    return LoadActionResponse(
        success=True,
        message=f"Load {load_id} cancelled successfully",
        load_id=load_id,
        new_status=LoadStatus.CANCELLED.value
    )


# ============================================================================
# Driver Load Management Endpoints
# ============================================================================

@app.post("/loads/{load_id}/driver-update-status", response_model=LoadActionResponse)
async def driver_update_status(
    load_id: str,
    request: DriverStatusUpdateRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Driver updates load status with strict state transitions.
    
    Authorization: Only driver assigned to the load
    Valid transitions:
    - COVERED → IN_TRANSIT (pickup confirmed)
    - IN_TRANSIT → DELIVERED (delivery confirmed)
    """
    uid = user['uid']
    user_role = user.get("role", "")
    
    # Role check: Must be driver
    if user_role != "driver":
        raise HTTPException(
            status_code=403,
            detail="Only drivers can update load status"
        )
    
    # Get load from Firestore first, fallback to JSON storage
    load = None
    try:
        load_ref = db.collection("loads").document(load_id).get()
        if load_ref.exists:
            load = load_ref.to_dict()
            load["load_id"] = load_ref.id  # Add document ID as load_id
    except Exception as e:
        print(f"Firestore query error: {e}")
    
    # Fallback to JSON storage if not in Firestore
    if not load:
        load = store.get_load(load_id)
    
    if not load:
        raise HTTPException(status_code=404, detail="Load not found")
    
    # Assignment check: Driver must be assigned to this load
    assigned_driver = str(load.get("assigned_driver") or load.get("assigned_driver_id") or "").strip()
    if assigned_driver != str(uid).strip():
        raise HTTPException(
            status_code=403,
            detail="You can only update loads assigned to you"
        )
    
    # Validate status transition
    current_status = load.get("status", "")
    new_status = request.new_status.upper()
    
    # Define valid transitions for drivers
    valid_transitions = {
        LoadStatus.COVERED.value.upper(): [LoadStatus.IN_TRANSIT.value.upper()],
        LoadStatus.IN_TRANSIT.value.upper(): [LoadStatus.DELIVERED.value.upper()]
    }
    
    # Normalize statuses for comparison
    current_status_normalized = current_status.upper()
    
    if current_status_normalized not in valid_transitions:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot update load from status '{current_status}'. Driver can only update COVERED or IN_TRANSIT loads."
        )
    
    if new_status not in valid_transitions[current_status_normalized]:
        allowed = ", ".join(valid_transitions[current_status_normalized])
        raise HTTPException(
            status_code=400,
            detail=f"Invalid transition: {current_status} → {new_status}. Allowed: {allowed}"
        )
    
    # Update load
    timestamp = time.time()
    updates = {
        "status": new_status.lower(),
        "updated_at": timestamp
    }

    # Keep workflow_status aligned for legacy driver status updates.
    # (Newer workflow endpoints handle this already.)
    try:
        if new_status == LoadStatus.IN_TRANSIT.value.upper():
            updates["workflow_status"] = "In Transit"
            updates["workflow_status_updated_at"] = timestamp
        elif new_status == LoadStatus.DELIVERED.value.upper():
            # Delivery photo URL is treated as POD evidence in this legacy endpoint.
            updates["workflow_status"] = "POD Submitted"
            updates["workflow_status_updated_at"] = timestamp
            updates.setdefault("pod_submitted_at", timestamp)
    except Exception:
        pass
    
    # Add timestamp fields based on status
    if new_status == LoadStatus.IN_TRANSIT.value.upper():
        updates["pickup_confirmed_at"] = timestamp
        updates["in_transit_since"] = timestamp
    elif new_status == LoadStatus.DELIVERED.value.upper():
        updates["delivered_at"] = timestamp
    
    # Add location if provided
    if request.latitude and request.longitude:
        updates["last_location"] = {
            "latitude": request.latitude,
            "longitude": request.longitude,
            "timestamp": timestamp
        }
    
    # Add proof of delivery/pickup
    if request.photo_url:
        if new_status == LoadStatus.IN_TRANSIT.value.upper():
            updates["pickup_photo_url"] = request.photo_url
        elif new_status == LoadStatus.DELIVERED.value.upper():
            updates["delivery_photo_url"] = request.photo_url

    # Also add proof photo URLs into the load-level document vault (best-effort).
    try:
        if request.photo_url and isinstance(request.photo_url, str) and request.photo_url.strip():
            if new_status == LoadStatus.IN_TRANSIT.value.upper():
                create_load_document_from_url(load=load, kind="BOL", url=request.photo_url, actor=user, source="driver_status_photo")
            elif new_status == LoadStatus.DELIVERED.value.upper():
                create_load_document_from_url(load=load, kind="POD", url=request.photo_url, actor=user, source="driver_status_photo")
    except Exception as e:
        print(f"Warning: Could not attach driver photo URL to document vault: {e}")
    
    # Update in Firestore first
    try:
        db.collection("loads").document(load_id).update(updates)
        print(f"✅ Load {load_id} updated in Firestore: {updates}")
    except Exception as e:
        print(f"⚠️ Firestore update failed: {e}")
    
    # Update in JSON storage as fallback
    store.update_load(load_id, updates)
    
    # Log status change
    log_entry = {
        "timestamp": timestamp,
        "actor_uid": uid,
        "actor_role": user_role,
        "old_status": current_status,
        "new_status": new_status.lower(),
        "notes": request.notes or f"Driver updated status to {new_status}",
        "metadata": {
            "latitude": request.latitude,
            "longitude": request.longitude,
            "photo_url": request.photo_url
        }
    }
    store.add_status_change_log(load_id, log_entry)
    
    # Log action
    log_action(uid, "DRIVER_UPDATE_STATUS", f"Load {load_id}: {current_status} → {new_status}")
    
    # Update Firestore
    try:
        load_ref = db.collection("loads").document(load_id)
        load_ref.update(updates)
        logs_ref = load_ref.collection("status_logs").document()
        logs_ref.set(log_entry)
    except Exception as e:
        print(f"Warning: Could not update Firestore: {e}")
    
    return LoadActionResponse(
        success=True,
        message=f"Load {load_id} status updated: {current_status} → {new_status}",
        load_id=load_id,
        new_status=new_status.lower(),
        data={
            "latitude": request.latitude,
            "longitude": request.longitude,
            "photo_url": request.photo_url,
            "timestamp": timestamp
        }
    )


# ============================================================================
# Marketplace Endpoints
# ============================================================================

@app.get("/marketplace/loads", response_model=LoadListResponse)
async def get_marketplace_loads(
    page: int = 1,
    page_size: int = 20,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Get marketplace loads based on user role:
    
    CARRIERS see:
    1. Shipper/Broker-posted loads (creator_role in [shipper, broker])
       → For bidding on freight from shippers
    2. Other Carrier-posted loads (creator_role=carrier, NOT created by them)
       → For carrier-to-carrier brokerage (subcontracting)
    
    SHIPPERS/BROKERS:
    - Do NOT see marketplace (they post loads, not browse them)
    - To find carriers, they should use "Carriers" tab (separate carrier directory)
    - Their loads automatically appear in carrier marketplace
    
    Business Logic:
    - Shipper posts load → ALL carriers see it → Carriers bid
    - Carrier posts load (acting as broker) → OTHER carriers see it → Carriers bid
    - Shipper accepts carrier bid → Load moves to COVERED → Appears in carrier's "My Loads"
    """
    uid = user['uid']
    user_role = user.get("role", "carrier")
    
    # Only carriers can browse marketplace loads
    if user_role != "carrier":
        raise HTTPException(
            status_code=403,
            detail="Marketplace is for carriers to find loads. Shippers should post loads via 'Create Load' and review offers in 'My Loads'."
        )
    
    # Carriers see:
    # 1. Shipper/broker loads (for freight hauling)
    # 2. Other carrier loads (for carrier-to-carrier brokerage, excluding own loads)
    
    # Get all POSTED loads from Firestore
    try:
        loads_ref = db.collection("loads")
        # Query for POSTED loads
        query = loads_ref.where("status", "==", LoadStatus.POSTED.value)
        all_posted_docs = query.stream()
        
        marketplace_loads = []
        for doc in all_posted_docs:
            load = doc.to_dict()
            load["load_id"] = doc.id

            # Safety: if a load is already assigned (even if status didn't transition), don't show it
            if load.get("assigned_carrier") or load.get("assigned_carrier_id"):
                continue
            
            # Filter to show:
            # - All shipper/broker loads
            # - Carrier loads NOT created by this carrier
            creator_role = load.get("creator_role", "")
            created_by = load.get("created_by", "")

            # Prevent duplicate requesting: if this carrier already has an offer on this load, hide it
            offers = load.get("offers") or []
            if isinstance(offers, list) and offers:
                already_offered = any(
                    isinstance(o, dict) and str(o.get("carrier_id")) == str(uid)
                    for o in offers
                )
                if already_offered:
                    continue
            
            if creator_role in ["shipper", "broker"]:
                marketplace_loads.append(sanitize_load_for_viewer(load, viewer_uid=str(uid), viewer_role=str(user_role)))
            elif creator_role == "carrier" and created_by != uid:
                marketplace_loads.append(sanitize_load_for_viewer(load, viewer_uid=str(uid), viewer_role=str(user_role)))
        
        # Apply pagination
        total = len(marketplace_loads)
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        paginated_loads = marketplace_loads[start_idx:end_idx]
        
        return LoadListResponse(
            loads=paginated_loads,
            total=total,
            page=page,
            page_size=page_size
        )
    except Exception as e:
        print(f"Error fetching marketplace loads from Firestore: {e}")
        # Fallback to local storage if Firestore fails
        filters = {"status": LoadStatus.POSTED.value}
        all_posted_loads = store.list_loads(filters)
        marketplace_loads = []
        for load in all_posted_loads:
            if load.get("assigned_carrier") or load.get("assigned_carrier_id"):
                continue
            offers = load.get("offers") or []
            if isinstance(offers, list) and offers:
                already_offered = any(
                    isinstance(o, dict) and str(o.get("carrier_id")) == str(uid)
                    for o in offers
                )
                if already_offered:
                    continue
            if load.get("creator_role") in ["shipper", "broker"] or (
                load.get("creator_role") == "carrier" and load.get("created_by") != uid
            ):
                marketplace_loads.append(sanitize_load_for_viewer(load, viewer_uid=str(uid), viewer_role=str(user_role)))
        total = len(marketplace_loads)
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        paginated_loads = marketplace_loads[start_idx:end_idx]
        return LoadListResponse(
            loads=paginated_loads,
            total=total,
            page=page,
            page_size=page_size
        )


@app.get("/marketplace/nearby-services")
async def get_nearby_services(
    latitude: float,
    longitude: float,
    radius: float = 50.0,
    service_type: Optional[str] = None,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Get nearby services based on GPS/WiFi location.
    
    Query Parameters:
    - latitude: Current latitude
    - longitude: Current longitude
    - radius: Search radius in miles (default: 50)
    - service_type: Filter by type (fuel, parking, repair, etc.)
    
    Returns list of nearby services sorted by distance.
    """
    import math
    
    def haversine_distance(lat1, lon1, lat2, lon2):
        """Calculate distance in miles using Haversine formula"""
        R = 3958.8  # Earth's radius in miles
        
        lat1_rad = math.radians(lat1)
        lat2_rad = math.radians(lat2)
        delta_lat = math.radians(lat2 - lat1)
        delta_lon = math.radians(lon2 - lon1)
        
        a = math.sin(delta_lat / 2) ** 2 + \
            math.cos(lat1_rad) * math.cos(lat2_rad) * \
            math.sin(delta_lon / 2) ** 2
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        
        return R * c
    
    # Server-side enforcement: drivers must have required marketplace consents.
    try:
        role = str(user.get("role") or "").lower()
        if role == "driver":
            from .consents import get_user_missing_marketplace_consents

            missing = get_user_missing_marketplace_consents(uid=user["uid"], role=role)
            if missing:
                raise HTTPException(
                    status_code=403,
                    detail={
                        "code": "CONSENT_REQUIRED",
                        "missing_consents": missing,
                        "message": "Required consents must be signed before accessing marketplace services.",
                    },
                )
    except HTTPException:
        raise
    except Exception as e:
        # Fail closed for driver marketplace if consent check fails.
        print(f"Consent check failed (blocking marketplace services): {e}")
        raise HTTPException(status_code=403, detail="Consent status could not be verified")

    try:
        # First, try to get real places from Geoapify API (for development)
        from .geoapify import get_geoapify_client
        geoapify_client = get_geoapify_client()
        
        # Map service types to Geoapify categories
        category_mapping = {
            "fuel": ["fuel-station", "petrol-station"],
            "parking": ["parking-facility", "parking-garage"],
            "repair": ["repair-facility", "vehicle-repair"],
            "legal": ["legal-services", "attorney"],
            "training": ["education-facility", "training-center"],
            "eld": ["electronics-store", "technology"]
        }
        
        # Get categories for specified service type or all
        if service_type and service_type in category_mapping:
            categories = category_mapping[service_type]
        else:
            # Get all categories if no specific type
            categories = ["fuel-station", "parking-facility", "repair-facility"]
        
        # Search with Geoapify API (convert miles to meters: 1 mile = 1609.34 meters)
        radius_meters = int(radius * 1609.34)
        geoapify_places = geoapify_client.search_nearby_places(
            latitude=latitude,
            longitude=longitude,
            radius=radius_meters,
            categories=categories,
            limit=20
        )
        
        # Convert Geoapify results to our service format
        nearby_services = []
        for place in geoapify_places:
            # Determine service type from categories
            place_categories = [cat.lower() for cat in place.get("categories", [])]
            determined_type = "other"
            
            if any("fuel" in cat or "petrol" in cat or "gas" in cat for cat in place_categories):
                determined_type = "fuel"
            elif any("parking" in cat for cat in place_categories):
                determined_type = "parking"
            elif any("repair" in cat or "mechanic" in cat or "service" in cat for cat in place_categories):
                determined_type = "repair"
            
            service = {
                "id": place.get("id", ""),
                "name": place.get("name", "Unknown"),
                "type": determined_type,
                "address": place.get("address", ""),
                "latitude": place.get("latitude"),
                "longitude": place.get("longitude"),
                "distance": round(place.get("distance", 0) / 1609.34, 2),  # Convert meters to miles
                "phone": place.get("phone", ""),
                "email": place.get("email", ""),
                "website": place.get("website", ""),
                "rating": 4.5,  # Default rating
                "source": "geoapify"
            }
            nearby_services.append(service)
        
        # If Geoapify returned results, use them
        if nearby_services:
            # Sort by distance
            nearby_services.sort(key=lambda x: x.get('distance', float('inf')))
            
            print(f"✅ Returning {len(nearby_services)} real places from Geoapify")
            
            return {
                "services": nearby_services,
                "total": len(nearby_services),
                "location": {
                    "latitude": latitude,
                    "longitude": longitude
                },
                "radius_miles": radius,
                "source": "geoapify"
            }
        
        # Fall back to Firestore if Geoapify returned nothing
        print("⚠️ No results from Geoapify, checking Firestore...")
        
        # Query services from Firestore
        services_ref = db.collection("marketplace_services")
        
        # Get all services (in production, you'd want to use geohashing for efficiency)
        all_services_docs = services_ref.stream()
        
        firestore_services = []
        for doc in all_services_docs:
            service = doc.to_dict()
            service['id'] = doc.id
            
            # Calculate distance
            if 'latitude' in service and 'longitude' in service:
                distance = haversine_distance(
                    latitude, longitude,
                    service['latitude'], service['longitude']
                )
                
                # Filter by radius
                if distance <= radius:
                    service['distance'] = round(distance, 2)
                    
                    # Filter by type if specified
                    if not service_type or service.get('type') == service_type:
                        firestore_services.append(service)
        
        # Sort by distance
        firestore_services.sort(key=lambda x: x.get('distance', float('inf')))
        
        # If found services in Firestore, return them
        if firestore_services:
            print(f"✅ Returning {len(firestore_services)} services from Firestore")
            return {
                "services": firestore_services,
                "total": len(firestore_services),
                "location": {
                    "latitude": latitude,
                    "longitude": longitude
                },
                "radius_miles": radius,
                "source": "firestore"
            }
        
        # Last resort: mock data for development
        print("⚠️ No services found, generating mock data...")
        mock_services = _generate_mock_services(latitude, longitude, radius, haversine_distance)
        
        return {
            "services": mock_services,
            "total": len(mock_services),
            "location": {
                "latitude": latitude,
                "longitude": longitude
            },
            "radius_miles": radius,
            "source": "mock"
        }
        
    except Exception as e:
        print(f"❌ Error fetching nearby services: {e}")
        import traceback
        traceback.print_exc()
        
        # Return mock data as fallback
        return {
            "services": _generate_mock_services(latitude, longitude, radius, haversine_distance),
            "total": 5,
            "location": {
                "latitude": latitude,
                "longitude": longitude
            },
            "radius_miles": radius,
            "source": "mock_error_fallback"
        }


def _generate_mock_services(latitude, longitude, radius, distance_func):
    """Generate mock nearby services for development"""
    import random
    
    service_data = [
        {
            "type": "fuel",
            "names": ["Shell Station", "Pilot Travel Center", "Loves Truck Stop", "Flying J", "TA Petro"],
            "description": "Full-service fuel station with truck parking",
            "phones": ["1-800-SHELL-GO", "1-877-PILOT-77", "1-800-LOVES-01"],
            "websites": ["https://www.shell.us", "https://www.pilotflyingj.com", "https://www.loves.com"]
        },
        {
            "type": "parking",
            "names": ["TruckStop Plaza", "Secure Parking Area", "Rest Stop Parking"],
            "description": "Secure parking with amenities",
            "phones": ["1-555-PARK-NOW", "1-888-TRUCKPARK"],
            "websites": ["https://www.truckstopplaza.com"]
        },
        {
            "type": "repair",
            "names": ["Mike's Truck Repair", "Quick Fix Shop", "Road Service Center", "Truck Maintenance Pro"],
            "description": "Full-service truck repair and maintenance",
            "phones": ["1-555-REPAIR-1", "1-888-FIX-TRUCK"],
            "emails": ["service@mikestruckrepair.com", "contact@truckrepair.com"]
        },
        {
            "type": "legal",
            "names": ["TVC Legal Protection", "CDL Defense Services", "Truckers Legal Aid"],
            "description": "CDL protection and legal services",
            "phones": ["1-888-TVC-LEGAL", "1-877-CDL-HELP"],
            "websites": ["https://www.tvcprotection.com"],
            "emails": ["info@tvcprotection.com"]
        },
        {
            "type": "training",
            "names": ["CDL Training Academy", "Professional Drivers School", "Truck Driver Institute"],
            "description": "Professional CDL training and certification",
            "phones": ["1-555-CDL-TRAIN", "1-888-LEARN-CDL"],
            "websites": ["https://www.cdlacademy.com"],
            "emails": ["register@cdlacademy.com"]
        },
        {
            "type": "eld",
            "names": ["ELD Tech Solutions", "KeepTruckin", "ELD Compliance Pro"],
            "description": "ELD devices, installation, and support",
            "phones": ["1-877-ELD-TECH", "1-888-ELD-HELP"],
            "websites": ["https://www.eldtech.com", "https://www.keeptruckin.com"],
            "emails": ["support@eldtech.com"]
        }
    ]
    
    mock_services = []
    for i, svc_category in enumerate(service_data):
        # Generate 2-3 services per category
        num_services = random.randint(2, 3)
        for j in range(num_services):
            # Generate random nearby coordinates (more realistic distribution)
            # Use smaller offsets for more realistic "nearby" distances
            lat_offset = random.uniform(-0.05, 0.05)  # ~0-3.5 miles
            lon_offset = random.uniform(-0.05, 0.05)
            
            # Calculate actual distance using Haversine formula
            service_lat = latitude + lat_offset
            service_lon = longitude + lon_offset
            distance = distance_func(latitude, longitude, service_lat, service_lon)
            
            if distance <= radius:
                service_name = random.choice(svc_category["names"])
                mock_services.append({
                    "id": f"mock_{svc_category['type']}_{i}_{j}",
                    "name": service_name,
                    "type": svc_category["type"],
                    "latitude": service_lat,
                    "longitude": service_lon,
                    "distance": round(distance, 1),  # Round to 1 decimal
                    "description": svc_category["description"],
                    "openStatus": random.choice(["Open 24/7", "Mon-Fri 9 AM - 5 PM", "Mon-Sat 8 AM - 8 PM"]),
                    "offers": random.choice([
                        "15¢ discount active",
                        "Special promotion this week",
                        "Emergency service available",
                        "Free consultation",
                        "20% off for new customers"
                    ]),
                    "verified": random.choice([True, True, False]),
                    "phone": random.choice(svc_category.get("phones", ["1-555-CONTACT"])),
                    "website": random.choice(svc_category.get("websites", [])) if svc_category.get("websites") else None,
                    "email": random.choice(svc_category.get("emails", [])) if svc_category.get("emails") else None,
                    "address": f"{random.randint(100, 9999)} {random.choice(['Main', 'Highway', 'Industrial', 'Service'])} {random.choice(['St', 'Blvd', 'Ave', 'Dr'])}"
                })
    
    return sorted(mock_services, key=lambda x: x['distance'])


# ============================================================================
# SHIPPER-CARRIER RELATIONSHIP ENDPOINTS
# ============================================================================


@app.get("/partners/{partner_uid}/profile")
async def get_partner_profile(
    partner_uid: str,
    user: Dict[str, Any] = Depends(get_current_user),
):
    """Get a partner (shipper/broker) profile for a carrier.

    Authorization:
    - Carriers can view a partner profile only if:
      - they have an active relationship, OR
      - they have at least one load where assigned_carrier == carrier and created_by == partner
    - Admins can view any partner profile.

    Returns a safe subset of the partner's user document.
    """
    uid = user["uid"]
    role = user.get("role", "carrier")

    if role not in ["carrier", "admin", "super_admin"]:
        raise HTTPException(status_code=403, detail="Unauthorized")

    partner_uid_s = str(partner_uid or "").strip()
    if not partner_uid_s:
        raise HTTPException(status_code=400, detail="partner_uid required")

    if role not in ["admin", "super_admin"]:
        # Check active relationship
        try:
            rel_q = (
                db.collection("shipper_carrier_relationships")
                .where("carrier_id", "==", uid)
                .where("shipper_id", "==", partner_uid_s)
                .where("status", "==", "active")
                .limit(1)
            )
            has_rel = any(True for _ in rel_q.stream())
        except Exception:
            has_rel = False

        if not has_rel:
            # Fallback: verify there is at least one load connecting these parties
            try:
                loads_ref = db.collection("loads")
                q = (
                    loads_ref.where("assigned_carrier", "==", uid)
                    .where("created_by", "==", partner_uid_s)
                    .limit(1)
                )
                has_load = any(True for _ in q.stream())
            except Exception:
                has_load = False

            if not has_load:
                # Backward-compat: some loads may use assigned_carrier_id
                try:
                    loads_ref = db.collection("loads")
                    q = (
                        loads_ref.where("assigned_carrier_id", "==", uid)
                        .where("created_by", "==", partner_uid_s)
                        .limit(1)
                    )
                    has_load = any(True for _ in q.stream())
                except Exception:
                    has_load = False

            if not has_load:
                raise HTTPException(status_code=403, detail="Not authorized to view this profile")

    snap = db.collection("users").document(partner_uid_s).get()
    if not getattr(snap, "exists", False):
        raise HTTPException(status_code=404, detail="Partner not found")

    d = snap.to_dict() or {}
    profile = {
        "uid": partner_uid_s,
        "role": d.get("role"),
        "display_name": d.get("display_name") or d.get("name") or d.get("company_name") or d.get("email"),
        "company_name": d.get("company_name"),
        "email": d.get("email"),
        "phone": d.get("phone"),
        "address": d.get("address") or d.get("street_address"),
        "city": d.get("city"),
        "state": d.get("state"),
        "zip": d.get("zip") or d.get("postal_code"),
        "country": d.get("country"),
    }

    return JSONResponse(content={"profile": profile})

@app.get("/carriers/my-carriers")
async def get_my_carriers(
    status: Optional[str] = None,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Get carriers associated with the current shipper.
    
    Authorization: Shippers/Brokers/Admins only
    """
    uid = user['uid']
    user_role = user.get("role", "carrier")
    
    if user_role not in ["shipper", "broker", "admin", "super_admin"]:
        raise HTTPException(
            status_code=403,
            detail="Only shippers can view their carriers"
        )
    
    try:
        # Fetch from Firestore
        relationships_ref = db.collection("shipper_carrier_relationships")
        
        if user_role in ["admin", "super_admin"]:
            # Admins see all relationships
            query = relationships_ref
        else:
            # Regular shippers see only their relationships
            query = relationships_ref.where("shipper_id", "==", uid)
        
        # Apply status filter
        if status:
            query = query.where("status", "==", status)
        else:
            # Default to active relationships
            query = query.where("status", "==", "active")
        
        # Fetch relationships
        relationships_docs = query.stream()
        relationships = []
        
        for doc in relationships_docs:
            rel_data = doc.to_dict()
            rel_data['id'] = doc.id
            
            # Convert Firestore timestamps
            for time_field in ['created_at', 'accepted_at']:
                if time_field in rel_data and hasattr(rel_data[time_field], 'timestamp'):
                    rel_data[time_field] = int(rel_data[time_field].timestamp())
            
            # Enrich with carrier data from Firestore
            carrier_id = rel_data.get("carrier_id")
            if carrier_id:
                try:
                    carrier_doc = db.collection("users").document(carrier_id).get()
                    if carrier_doc.exists:
                        carrier_data = carrier_doc.to_dict()
                        rel_data['carrier_name'] = carrier_data.get("display_name") or carrier_data.get("name") or carrier_data.get("company_name")
                        rel_data['carrier_phone'] = carrier_data.get("phone")
                        
                        # Also check carriers collection for additional info
                        carrier_profile = db.collection("carriers").document(carrier_id).get()
                        if carrier_profile.exists:
                            carrier_profile_data = carrier_profile.to_dict()
                            rel_data['mc_number'] = carrier_profile_data.get("mc_number")
                            rel_data['dot_number'] = carrier_profile_data.get("dot_number")
                            rel_data['rating'] = carrier_profile_data.get("rating", 0)
                            rel_data['total_loads'] = carrier_profile_data.get("total_loads", 0)
                except Exception as e:
                    print(f"Error enriching carrier data: {e}")
            
            relationships.append(rel_data)
        
        return JSONResponse(content={
            "carriers": relationships,
            "total": len(relationships)
        })
        
    except Exception as e:
        print(f"Error fetching carriers: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch carriers")


@app.get("/shippers/my-shippers")
async def get_my_shippers(
    status: Optional[str] = None,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Get shippers associated with the current carrier.
    
    Authorization: Carriers only
    """
    uid = user['uid']
    user_role = user.get("role", "carrier")
    
    if user_role != "carrier":
        raise HTTPException(
            status_code=403,
            detail="Only carriers can view their shippers"
        )
    
    try:
        # Fetch from Firestore
        relationships_ref = db.collection("shipper_carrier_relationships")
        query = relationships_ref.where("carrier_id", "==", uid)
        
        # Apply status filter
        if status:
            query = query.where("status", "==", status)
        else:
            # Default to active relationships
            query = query.where("status", "==", "active")
        
        # Fetch relationships
        relationships_docs = query.stream()
        enriched_relationships = []
        
        for doc in relationships_docs:
            rel_data = doc.to_dict()
            rel_data['id'] = doc.id
            
            # Convert Firestore timestamps
            for time_field in ['created_at', 'accepted_at']:
                if time_field in rel_data and hasattr(rel_data[time_field], 'timestamp'):
                    rel_data[time_field] = int(rel_data[time_field].timestamp())
            
            # Enrich with shipper data from Firestore
            shipper_id = rel_data.get("shipper_id")
            if shipper_id:
                try:
                    shipper_doc = db.collection("users").document(shipper_id).get()
                    if shipper_doc.exists:
                        shipper_data = shipper_doc.to_dict()
                        rel_data["shipper_name"] = shipper_data.get("display_name") or shipper_data.get("name") or rel_data.get("shipper_email")
                        rel_data["shipper_phone"] = shipper_data.get("phone", "N/A")
                        rel_data["shipper_company"] = shipper_data.get("company_name", "N/A")
                        rel_data["shipper_role"] = shipper_data.get("role")
                        if not rel_data.get("shipper_email"):
                            rel_data["shipper_email"] = shipper_data.get("email")
                except Exception as e:
                    print(f"Error fetching shipper data for {shipper_id}: {e}")
            
            enriched_relationships.append(rel_data)
        
        return JSONResponse(content={
            "shippers": enriched_relationships,
            "total": len(enriched_relationships)
        })
        
    except Exception as e:
        print(f"Error fetching shippers: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch shippers")


@app.delete("/shipper-carrier-relationships/{relationship_id}")
async def remove_shipper_carrier_relationship(
    relationship_id: str,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """Deactivate a shipper-carrier relationship.

    Authorization:
    - Carrier can remove relationships where carrier_id == uid
    - Shipper/Broker can remove relationships where shipper_id == uid
    - Admins can remove any relationship
    """
    uid = user['uid']
    user_role = user.get("role", "carrier")

    try:
        ref = db.collection("shipper_carrier_relationships").document(relationship_id)
        snap = ref.get()
        if not snap.exists:
            raise HTTPException(status_code=404, detail="Relationship not found")

        rel = snap.to_dict() or {}
        shipper_id = str(rel.get("shipper_id") or "").strip()
        carrier_id = str(rel.get("carrier_id") or "").strip()

        is_admin = user_role in ["admin", "super_admin"]
        is_carrier_owner = (user_role == "carrier" and carrier_id and carrier_id == uid)
        is_shipper_owner = (user_role in ["shipper", "broker"] and shipper_id and shipper_id == uid)

        if not (is_admin or is_carrier_owner or is_shipper_owner):
            raise HTTPException(status_code=403, detail="Not authorized to remove this relationship")

        if str(rel.get("status") or "").lower() == "inactive":
            return JSONResponse(content={"success": True})

        ref.update({
            "status": "inactive",
            "removed_at": int(time.time()),
            "removed_by": uid,
        })

        try:
            log_action(uid, "RELATIONSHIP_REMOVED", f"Removed relationship {relationship_id}")
        except Exception:
            pass

        return JSONResponse(content={"success": True})
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error removing relationship {relationship_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to remove relationship")


@app.post("/carriers/invite")
async def invite_carrier(
    invitation: Dict[str, Any],
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Send an invitation to a carrier.
    
    Authorization: Shippers/Brokers/Admins only
    
    Body:
    {
        "carrier_id": "carrier_uid" (optional if carrier_email provided),
        "carrier_email": "carrier@example.com" (required if carrier_id not provided),
        "carrier_name": "Carrier Name" (optional),
        "load_id": "load_id" (optional),
        "message": "Custom message" (optional)
    }
    """
    uid = user['uid']
    user_role = user.get("role", "carrier")
    
    if user_role not in ["shipper", "broker", "admin", "super_admin"]:
        raise HTTPException(
            status_code=403,
            detail="Only shippers can invite carriers"
        )
    
    carrier_id = invitation.get("carrier_id")
    carrier_email = invitation.get("carrier_email")
    
    if not carrier_id and not carrier_email:
        raise HTTPException(status_code=400, detail="Either carrier_id or carrier_email is required")
    
    try:
        # If carrier_id is provided, get the carrier's email from Firestore
        carrier_uid = carrier_id
        if carrier_id:
            try:
                carrier_user_doc = db.collection("users").document(carrier_id).get()
                if carrier_user_doc.exists:
                    carrier_data = carrier_user_doc.to_dict()
                    carrier_email = carrier_data.get("email") or carrier_email
                    if not carrier_email:
                        # Try to get from Firebase Auth
                        try:
                            carrier_firebase_user = firebase_auth.get_user(carrier_id)
                            carrier_email = carrier_firebase_user.email
                        except:
                            pass
                else:
                    raise HTTPException(status_code=404, detail="Carrier not found")
            except HTTPException:
                raise
            except Exception as e:
                print(f"Error fetching carrier user: {e}")
                # Fallback to using email if provided
                if not carrier_email:
                    raise HTTPException(status_code=404, detail="Carrier not found")
        else:
            # If only email provided, try to find carrier by email
            try:
                carrier_firebase_user = firebase_auth.get_user_by_email(carrier_email)
                carrier_uid = carrier_firebase_user.uid
                # Check if user exists in Firestore and is a carrier
                carrier_user_doc = db.collection("users").document(carrier_uid).get()
                if carrier_user_doc.exists:
                    carrier_data = carrier_user_doc.to_dict()
                    if carrier_data.get("role") not in ["carrier", "admin", "super_admin"]:
                        raise HTTPException(status_code=400, detail="User is not a carrier")
            except firebase_auth.UserNotFoundError:
                raise HTTPException(status_code=404, detail="Carrier not found with this email")
            except HTTPException:
                raise
            except Exception as e:
                print(f"Error looking up carrier by email: {e}")
                # Still create invitation, carrier can accept when they sign up
                carrier_uid = None
        
        # Check for duplicate invitation (prevent duplicates)
        invitations_ref = db.collection("carrier_invitations")
        
        # Check if there's already a pending invitation for this shipper-carrier pair
        if carrier_uid:
            existing_query = invitations_ref.where("shipper_id", "==", uid)\
                                            .where("carrier_id", "==", carrier_uid)\
                                            .where("status", "==", "pending")\
                                            .limit(1)
            existing_invites = list(existing_query.stream())
            if existing_invites:
                raise HTTPException(
                    status_code=400, 
                    detail="A pending invitation already exists for this carrier"
                )
        else:
            # Check by email if carrier_uid not available
            existing_query = invitations_ref.where("shipper_id", "==", uid)\
                                            .where("carrier_email", "==", carrier_email)\
                                            .where("status", "==", "pending")\
                                            .limit(1)
            existing_invites = list(existing_query.stream())
            if existing_invites:
                raise HTTPException(
                    status_code=400, 
                    detail="A pending invitation already exists for this carrier email"
                )
        
        invitation_id = f"INV-{uuid.uuid4().hex[:8].upper()}"
        shipper_name = user.get("display_name") or user.get("name") or user.get("email")
        
        invitation_record = {
            "id": invitation_id,
            "shipper_id": uid,
            "shipper_email": user.get("email"),
            "shipper_name": shipper_name,
            "carrier_id": carrier_uid,
            "carrier_email": carrier_email,
            "carrier_name": invitation.get("carrier_name"),
            "load_id": invitation.get("load_id"),
            "message": invitation.get("message"),
            "status": "pending",  # pending, accepted, declined
            "created_at": int(time.time()),
            "invited_by": user.get("email")
        }
        
        # Save to Firestore
        db.collection("carrier_invitations").document(invitation_id).set(invitation_record)
        log_action(uid, "INVITATION_CREATED", f"Invited carrier {carrier_uid or carrier_email}")
        
        # Create notification for carrier if they exist in the system
        if carrier_uid:
            try:
                notification_id = str(uuid.uuid4())
                notification_data = {
                    "id": notification_id,
                    "user_id": carrier_uid,
                    "notification_type": "system",
                    "title": f"New Partnership Invitation from {shipper_name}",
                    "message": invitation.get("message") or f"{shipper_name} has invited you to join their carrier network.",
                    "resource_type": "invitation",
                    "resource_id": invitation_id,
                    "action_url": f"/carriers/invitations/{invitation_id}",
                    "is_read": False,
                    "created_at": int(time.time())
                }
                
                # Save notification to Firestore
                db.collection("notifications").document(notification_id).set(notification_data)
                log_action(carrier_uid, "NOTIFICATION_CREATED", f"Invitation notification from shipper {uid}")
            except Exception as e:
                print(f"Error creating notification: {e}")
                # Don't fail the invite if notification fails
        
        return JSONResponse(content={
            "success": True,
            "invitation_id": invitation_id,
            "message": "Invitation sent successfully"
        })
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error sending invitation: {e}")
        raise HTTPException(status_code=500, detail="Failed to send invitation")


@app.get("/carriers/invitations")
async def list_invitations(
    status: Optional[str] = None,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    List carrier invitations.
    - For shippers: Lists invitations they sent
    - For carriers: Lists invitations they received
    
    Authorization: All authenticated users
    """
    uid = user['uid']
    user_role = user.get("role", "carrier")
    user_email = user.get("email")
    
    try:
        invitations_ref = db.collection("carrier_invitations")
        
        if user_role in ["shipper", "broker", "admin", "super_admin"]:
            # Shippers see invitations they sent
            query = invitations_ref.where("shipper_id", "==", uid)
            if status:
                query = query.where("status", "==", status)
        elif user_role == "carrier":
            # Carriers see invitations they received - check both carrier_id and carrier_email
            # Use compound query or multiple queries
            query1 = invitations_ref.where("carrier_id", "==", uid)
            query2 = invitations_ref.where("carrier_email", "==", user_email)
            
            if status:
                query1 = query1.where("status", "==", status)
                query2 = query2.where("status", "==", status)
            
            # Get results from both queries and merge (removing duplicates)
            invites_by_id: Dict[str, Dict[str, Any]] = {}

            for d in list(query1.stream()):
                dd = d.to_dict() or {}
                dd.setdefault("id", d.id)
                invites_by_id[d.id] = dd

            for d in list(query2.stream()):
                dd = d.to_dict() or {}
                dd.setdefault("id", d.id)
                invites_by_id[d.id] = dd

            invitations = list(invites_by_id.values())

            # Enrich with shipper profile info (best-effort)
            for inv in invitations:
                if 'created_at' in inv and hasattr(inv['created_at'], 'timestamp'):
                    inv['created_at'] = int(inv['created_at'].timestamp())

                shipper_id = inv.get("shipper_id")
                if shipper_id:
                    try:
                        shipper_doc = db.collection("users").document(str(shipper_id)).get()
                        if shipper_doc.exists:
                            shipper_data = shipper_doc.to_dict() or {}
                            inv.setdefault("shipper_role", shipper_data.get("role"))
                            inv.setdefault("shipper_phone", shipper_data.get("phone"))
                            inv.setdefault("shipper_company", shipper_data.get("company_name"))
                            inv.setdefault("shipper_name", shipper_data.get("display_name") or shipper_data.get("name") or inv.get("shipper_name"))

                            # Best-effort location enrichment for UI filters.
                            # These fields are optional and may not exist for all users.
                            try:
                                inv.setdefault("shipper_city", shipper_data.get("city") or shipper_data.get("address_city"))
                            except Exception:
                                pass
                            try:
                                state_guess = shipper_data.get("state") or shipper_data.get("address_state")
                                if not state_guess:
                                    state_guess = _extract_state(
                                        shipper_data.get("address")
                                        or shipper_data.get("location")
                                        or shipper_data.get("company_address")
                                        or shipper_data.get("city_state")
                                    )
                                if state_guess and str(state_guess).strip() and str(state_guess).strip() != "Unknown":
                                    inv.setdefault("shipper_state", str(state_guess).strip().upper())
                            except Exception:
                                pass
                    except Exception:
                        pass
            
            return JSONResponse(content={
                "invitations": invitations,
                "total": len(invitations)
            })
        else:
            raise HTTPException(status_code=403, detail="Unauthorized")
        
        # For shippers, fetch from query
        invitations_docs = query.stream()
        invitations = []
        for doc in invitations_docs:
            inv_data = doc.to_dict()
            inv_data['id'] = doc.id
            # Convert Firestore timestamp if present
            if 'created_at' in inv_data and hasattr(inv_data['created_at'], 'timestamp'):
                inv_data['created_at'] = int(inv_data['created_at'].timestamp())
            invitations.append(inv_data)
        
        return JSONResponse(content={
            "invitations": invitations,
            "total": len(invitations)
        })
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error fetching invitations: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch invitations")


@app.post("/carriers/invitations/{invitation_id}/accept")
async def accept_invitation(
    invitation_id: str,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Accept a carrier invitation.
    
    Authorization: Carriers only
    """
    uid = user['uid']
    user_role = user.get("role", "carrier")
    user_email = user.get("email")
    
    if user_role != "carrier":
        raise HTTPException(
            status_code=403,
            detail="Only carriers can accept invitations"
        )
    
    try:
        # Get the invitation from Firestore
        invitation_ref = db.collection("carrier_invitations").document(invitation_id)
        invitation_doc = invitation_ref.get()
        
        if not invitation_doc.exists:
            raise HTTPException(status_code=404, detail="Invitation not found")
        
        invitation = invitation_doc.to_dict()
        invitation['id'] = invitation_doc.id
        
        # Convert Firestore timestamp if present
        if 'created_at' in invitation and hasattr(invitation['created_at'], 'timestamp'):
            invitation['created_at'] = int(invitation['created_at'].timestamp())
        
        # Verify the invitation is for this carrier
        if invitation.get("carrier_id") != uid and invitation.get("carrier_email") != user_email:
            raise HTTPException(status_code=403, detail="This invitation is not for you")
        
        # Check if already accepted or declined
        if invitation.get("status") == "accepted":
            raise HTTPException(status_code=400, detail="Invitation already accepted")
        if invitation.get("status") == "declined":
            raise HTTPException(status_code=400, detail="Invitation was declined")
        
        # Update invitation status in Firestore
        invitation_ref.update({
            "status": "accepted",
            "accepted_at": int(time.time())
        })
        
        # Create shipper-carrier relationship
        shipper_id = invitation.get("shipper_id")
        
        # Check for duplicate relationship (prevent duplicates)
        relationships_ref = db.collection("shipper_carrier_relationships")
        existing_rel_query = relationships_ref.where("shipper_id", "==", shipper_id)\
                                              .where("carrier_id", "==", uid)\
                                              .where("status", "==", "active")\
                                              .limit(1)
        existing_rels = list(existing_rel_query.stream())
        
        if existing_rels:
            # Relationship already exists - don't create duplicate
            relationship_id = existing_rels[0].id
            existing_rel_data = existing_rels[0].to_dict()
            
            # Just log that it was already there
            log_action(uid, "RELATIONSHIP_EXISTS", f"Relationship already exists with shipper {shipper_id}")
        else:
            # Create new relationship
            relationship_id = f"REL-{uuid.uuid4().hex[:8].upper()}"
            relationship_data = {
                "id": relationship_id,
                "shipper_id": shipper_id,
                "carrier_id": uid,
                "shipper_email": invitation.get("shipper_email"),
                "carrier_email": user_email,
                "status": "active",
                "created_at": int(time.time()),
                "accepted_at": int(time.time()),
                "invitation_id": invitation_id
            }
            # Save to Firestore
            db.collection("shipper_carrier_relationships").document(relationship_id).set(relationship_data)
            log_action(uid, "RELATIONSHIP_CREATED", f"Accepted invitation from shipper {shipper_id}")
        
        # Create notification for shipper about acceptance (only if new relationship)
        if not existing_rels:
            try:
                notification_id = str(uuid.uuid4())
                carrier_name = user.get("display_name") or user.get("name") or user_email
                notification_data = {
                    "id": notification_id,
                    "user_id": shipper_id,
                    "notification_type": "system",
                    "title": f"Carrier {carrier_name} Accepted Your Invitation",
                    "message": f"{carrier_name} has accepted your partnership invitation and has been added to your carrier network.",
                    "resource_type": "relationship",
                    "resource_id": relationship_id,
                    "action_url": f"/carriers/my-carriers",
                    "is_read": False,
                    "created_at": int(time.time())
                }
                db.collection("notifications").document(notification_id).set(notification_data)
                log_action(shipper_id, "NOTIFICATION_CREATED", f"Carrier {uid} accepted invitation")
            except Exception as e:
                print(f"Error creating acceptance notification: {e}")
        
        return JSONResponse(content={
            "success": True,
            "message": "Invitation accepted successfully",
            "relationship_id": relationship_id
        })
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error accepting invitation: {e}")
        raise HTTPException(status_code=500, detail="Failed to accept invitation")


@app.post("/carriers/invitations/{invitation_id}/decline")
async def decline_invitation(
    invitation_id: str,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Decline a carrier invitation.
    
    Authorization: Carriers only
    """
    uid = user['uid']
    user_role = user.get("role", "carrier")
    user_email = user.get("email")
    
    if user_role != "carrier":
        raise HTTPException(
            status_code=403,
            detail="Only carriers can decline invitations"
        )
    
    try:
        # Get invitation from Firestore
        invitation_ref = db.collection("carrier_invitations").document(invitation_id)
        invitation_doc = invitation_ref.get()
        
        if not invitation_doc.exists:
            raise HTTPException(status_code=404, detail="Invitation not found")
        
        invitation = invitation_doc.to_dict()
        
        if invitation.get("carrier_id") != uid and invitation.get("carrier_email") != user_email:
            raise HTTPException(status_code=403, detail="This invitation is not for you")
        
        if invitation.get("status") != "pending":
            raise HTTPException(status_code=400, detail=f"Invitation already {invitation.get('status')}")
        
        # Update in Firestore
        invitation_ref.update({
            "status": "declined",
            "declined_at": int(time.time())
        })
        log_action(uid, "INVITATION_DECLINED", f"Declined invitation {invitation_id}")
        
        return JSONResponse(content={
            "success": True,
            "message": "Invitation declined"
        })
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error declining invitation: {e}")
        raise HTTPException(status_code=500, detail="Failed to decline invitation")


@app.get("/notifications")
async def get_notifications(
    is_read: Optional[bool] = None,
    page: int = 1,
    page_size: int = 20,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Get user's notifications from Firestore.
    
    Authorization: All authenticated users
    """
    uid = user['uid']

    def _pref_on(key: str, default: bool = True) -> bool:
        try:
            prefs = user.get("notification_preferences")
            if isinstance(prefs, dict) and key in prefs:
                return bool(prefs.get(key))
        except Exception:
            pass
        return bool(default)

    messages_on = _pref_on("messages", True)
    compliance_on = _pref_on("compliance_alerts", True)
    loads_on = _pref_on("loads", True)
    finance_on = _pref_on("finance", True)
    system_on = _pref_on("system", True)
    driver_dispatch_on = _pref_on("driver_dispatch", True)

    def _allowed_by_prefs(n: Dict[str, Any]) -> bool:
        try:
            typ = str(n.get("notification_type") or "").strip().lower()
            cat = str(n.get("category") or "").strip().lower()
            resource = str(n.get("resource_type") or "").strip().lower()

            is_compliance = (typ == "compliance_alert") or (cat == "compliance") or (resource == "compliance")
            if is_compliance and not compliance_on:
                return False

            is_load = (typ == "load_update") or (cat == "loads") or (resource in {"load", "loads"})
            if is_load and not loads_on:
                return False

            is_finance = (typ in {"payment", "finance", "invoice"}) or (cat == "finance") or (resource in {"invoice", "payment", "finance"})
            if is_finance and not finance_on:
                return False

            is_system = (typ == "system") or (cat == "system") or (resource == "system")
            if is_system and not system_on:
                return False

            is_message = (
                typ.startswith("message")
                or "messag" in typ
                or cat in {"messaging", "messages"}
                or resource in {"message", "messaging", "thread", "conversation"}
            )
            if is_message and (not messages_on or not driver_dispatch_on):
                return False

            # Driver/dispatch (HOS, dispatch, equipment, inspections) is a catch-all.
            is_driver_dispatch = (
                cat in {"driver", "dispatch", "driver/dispatch"}
                or resource in {"driver", "dispatch", "hos", "equipment", "inspection"}
                or any(k in typ for k in ["driver", "dispatch", "hos", "inspection", "equipment"])
            )
            if is_driver_dispatch and not driver_dispatch_on:
                return False
        except Exception:
            return True

        return True
    
    try:
        notifications_ref = db.collection("notifications").where("user_id", "==", uid)
        
        if is_read is not None:
            notifications_ref = notifications_ref.where("is_read", "==", is_read)
        
        # Note: Firestore requires an index for order_by with where clauses
        # For now, we'll fetch and sort in memory
        notifications_docs = notifications_ref.stream()
        
        # Convert to list and sort
        notifications_list = []
        for doc in notifications_docs:
            notif_data = doc.to_dict()
            notif_data['id'] = doc.id
            notifications_list.append(notif_data)

        # Apply per-user preference filters before sorting/pagination.
        notifications_list = [n for n in notifications_list if _allowed_by_prefs(n)]
        
        # Sort by created_at descending
        notifications_list.sort(key=lambda x: x.get('created_at', 0), reverse=True)
        
        # Pagination
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        paginated_notifications = notifications_list[start_idx:end_idx]
        
        notifications = []
        for notif_data in paginated_notifications:
            # Format timestamp for display
            if 'created_at' in notif_data:
                timestamp = notif_data['created_at']
                if isinstance(timestamp, (int, float)):
                    from datetime import datetime
                    dt = datetime.fromtimestamp(timestamp)
                    notif_data['formatted_time'] = dt.strftime('%Y-%m-%d %H:%M:%S')
                    # Relative time
                    now = time.time()
                    diff = now - timestamp
                    if diff < 3600:
                        notif_data['relative_time'] = f"{int(diff / 60)} minutes ago"
                    elif diff < 86400:
                        notif_data['relative_time'] = f"{int(diff / 3600)} hours ago"
                    else:
                        notif_data['relative_time'] = f"{int(diff / 86400)} days ago"
            
            notifications.append(notif_data)
        
        # Counts should match the filtered list.
        total_count = len(notifications_list)
        unread_count = len([n for n in notifications_list if not n.get("is_read")])
        
        return JSONResponse(content={
            "notifications": notifications,
            "total": total_count,
            "unread_count": unread_count,
            "page": page,
            "page_size": page_size
        })
        
    except Exception as e:
        print(f"Error fetching notifications: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch notifications")


@app.post("/notifications/{notification_id}/mark-read")
async def mark_notification_read(
    notification_id: str,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Mark a notification as read.
    
    Authorization: All authenticated users
    """
    uid = user['uid']
    
    try:
        notification_ref = db.collection("notifications").document(notification_id)
        notification_doc = notification_ref.get()
        
        if not notification_doc.exists:
            raise HTTPException(status_code=404, detail="Notification not found")
        
        notification_data = notification_doc.to_dict()
        if notification_data.get("user_id") != uid:
            raise HTTPException(status_code=403, detail="Not authorized to update this notification")
        
        notification_ref.update({
            "is_read": True,
            "read_at": int(time.time())
        })
        
        return JSONResponse(content={"success": True, "message": "Notification marked as read"})
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error marking notification as read: {e}")
        raise HTTPException(status_code=500, detail="Failed to mark notification as read")


@app.post("/notifications/test")
async def send_test_notification(user: Dict[str, Any] = Depends(get_current_user)):
    """Create an in-app test notification for the current user.

    Authorization: All authenticated users
    """
    uid = user.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")

    try:
        now = int(time.time())
        notification_id = str(uuid.uuid4())
        payload: Dict[str, Any] = {
            "id": notification_id,
            "user_id": str(uid),
            "notification_type": "system",
            "category": "system",
            "priority": "Info",
            "title": "Test Notification",
            "message": "This is a test notification generated from your Alerts settings.",
            "resource_type": "system",
            "resource_id": None,
            "action_url": None,
            "is_read": False,
            "created_at": now,
        }
        db.collection("notifications").document(notification_id).set(payload)
        return JSONResponse(content={"success": True, "notification": payload})
    except Exception as e:
        print(f"Error sending test notification: {e}")
        raise HTTPException(status_code=500, detail="Failed to send test notification")


# --- Email Utility Functions ---

def send_email(to_email: str, subject: str, body: str, is_html: bool = False):
    """Send an email using SMTP."""
    try:
        if not settings.SMTP_USERNAME or not settings.SMTP_PASSWORD:
            # If SMTP not configured, just log it
            print(f"[DEV] Email would be sent to {to_email}")
            print(f"[DEV] Subject: {subject}")
            print(f"[DEV] Body: {body}")
            return True
        
        msg = MIMEMultipart()
        msg['From'] = settings.EMAIL_FROM
        msg['To'] = to_email
        msg['Subject'] = subject
        
        if is_html:
            msg.attach(MIMEText(body, 'html'))
        else:
            msg.attach(MIMEText(body, 'plain'))
        
        server = smtplib.SMTP(settings.SMTP_SERVER, settings.SMTP_PORT)
        server.starttls()
        server.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
        text = msg.as_string()
        server.sendmail(settings.EMAIL_FROM, to_email, text)
        server.quit()
        
        return True
    except Exception as e:
        print(f"Error sending email: {e}")
        return False


# --- Report Fraud and Suggest Edit Endpoints ---

@app.post("/report-fraud")
async def report_fraud(
    request: ReportFraudRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Report fraud - sends email to admin.
    
    Authorization: All authenticated users
    """
    try:
        uid = user.get('uid', 'Unknown')
        user_email = request.user_email or user.get('email', 'Unknown')
        user_name = request.user_name or user.get('display_name') or user.get('name') or user_email.split('@')[0]
        
        subject = request.subject or f"Fraud Report from {user_name}"
        
        email_body = f"""
        <html>
        <body>
            <h2>Fraud Report</h2>
            <p><strong>From:</strong> {user_name} ({user_email})</p>
            <p><strong>User ID:</strong> {uid}</p>
            <p><strong>Subject:</strong> {subject}</p>
            <hr>
            <h3>Message:</h3>
            <p>{request.message.replace(chr(10), '<br>')}</p>
            <hr>
            <p><em>This is an automated message from FreightPower AI.</em></p>
        </body>
        </html>
        """
        
        success = send_email(
            to_email=settings.ADMIN_EMAIL,
            subject=f"Fraud Report: {subject}",
            body=email_body,
            is_html=True
        )
        
        if success:
            log_action(uid, "FRAUD_REPORT", f"Reported fraud: {subject}")
            return JSONResponse(content={
                "success": True,
                "message": "Fraud report submitted successfully"
            })
        else:
            raise HTTPException(status_code=500, detail="Failed to send fraud report")
            
    except Exception as e:
        print(f"Error processing fraud report: {e}")
        raise HTTPException(status_code=500, detail="Failed to process fraud report")


@app.post("/suggest-edit")
async def suggest_edit(
    request: SuggestEditRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Suggest an edit - sends email to admin.
    
    Authorization: All authenticated users
    """
    try:
        uid = user.get('uid', 'Unknown')
        user_email = request.user_email or user.get('email', 'Unknown')
        user_name = request.user_name or user.get('display_name') or user.get('name') or user_email.split('@')[0]
        
        subject = request.subject or f"Edit Suggestion from {user_name}"
        
        email_body = f"""
        <html>
        <body>
            <h2>Edit Suggestion</h2>
            <p><strong>From:</strong> {user_name} ({user_email})</p>
            <p><strong>User ID:</strong> {uid}</p>
            <p><strong>Subject:</strong> {subject}</p>
            <hr>
            <h3>Suggestion:</h3>
            <p>{request.message.replace(chr(10), '<br>')}</p>
            <hr>
            <p><em>This is an automated message from FreightPower AI.</em></p>
        </body>
        </html>
        """
        
        success = send_email(
            to_email=settings.ADMIN_EMAIL,
            subject=f"Edit Suggestion: {subject}",
            body=email_body,
            is_html=True
        )
        
        if success:
            log_action(uid, "EDIT_SUGGESTION", f"Suggested edit: {subject}")
            return JSONResponse(content={
                "success": True,
                "message": "Edit suggestion submitted successfully"
            })
        else:
            raise HTTPException(status_code=500, detail="Failed to send edit suggestion")
            
    except Exception as e:
        print(f"Error processing edit suggestion: {e}")
        raise HTTPException(status_code=500, detail="Failed to process edit suggestion")


# --- HERE Maps API Endpoints ---

@app.post("/maps/geocode")
async def geocode_address(
    request: GeocodeRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Geocode an address to get latitude/longitude coordinates.
    
    Authorization: All authenticated users
    """
    try:
        here_client = get_here_client()
        results = here_client.geocode(request.address, limit=request.limit)
        return JSONResponse(content={
            "success": True,
            "results": results
        })
    except Exception as e:
        print(f"Error geocoding address: {e}")
        raise HTTPException(status_code=500, detail=f"Geocoding failed: {str(e)}")


@app.post("/maps/reverse-geocode")
async def reverse_geocode(
    request: ReverseGeocodeRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Reverse geocode coordinates to get address.
    
    Authorization: All authenticated users
    """
    try:
        here_client = get_here_client()
        result = here_client.reverse_geocode(request.lat, request.lng)
        if result:
            return JSONResponse(content={
                "success": True,
                **result
            })
        else:
            raise HTTPException(status_code=404, detail="Address not found")
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error reverse geocoding: {e}")
        raise HTTPException(status_code=500, detail=f"Reverse geocoding failed: {str(e)}")


@app.post("/maps/route", response_model=RouteResponse)
async def calculate_route(
    request: RouteRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Calculate route between origin and destination with truck-specific parameters.
    
    Authorization: All authenticated users
    """
    try:
        here_client = get_here_client()
        result = here_client.calculate_route(
            origin=request.origin,
            destination=request.destination,
            waypoints=request.waypoints,
            transport_mode=request.transport_mode,
            truck_type=request.truck_type,
            height=request.height,
            width=request.width,
            length=request.length,
            weight=request.weight,
            hazmat=request.hazmat,
            return_polyline=request.return_polyline
        )
        
        if result.get("error"):
            raise HTTPException(status_code=400, detail=result["error"])
        
        return RouteResponse(
            distance_miles=result["distance_miles"],
            distance_meters=result["distance_meters"],
            duration_seconds=result["duration_seconds"],
            duration_hours=result["duration_hours"],
            estimated_days=result["estimated_days"],
            polyline=result.get("polyline"),
            origin=result["origin"],
            destination=result["destination"],
            waypoints=result.get("waypoints")
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error calculating route: {e}")
        raise HTTPException(status_code=500, detail=f"Route calculation failed: {str(e)}")


@app.post("/maps/distance", response_model=DistanceCalculationResponse)
async def calculate_distance_here(
    request: DistanceCalculationRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Calculate distance and estimated transit time between two locations using HERE API.
    This replaces the GPT-based distance calculation.
    
    Authorization: All authenticated users
    """
    try:
        here_client = get_here_client()
        
        # Determine truck type from request if available
        truck_type = getattr(request, 'truck_type', None)
        weight = getattr(request, 'weight', None)
        
        result = here_client.calculate_distance(
            origin=request.origin,
            destination=request.destination,
            truck_type=truck_type,
            weight=weight
        )
        
        return DistanceCalculationResponse(
            distance_miles=result["distance_miles"],
            estimated_hours=result["estimated_hours"],
            estimated_days=result["estimated_days"],
            confidence=result["confidence"],
            notes=result.get("notes")
        )
    except Exception as e:
        print(f"Error calculating distance: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Distance calculation failed: {str(e)}"
        )


@app.post("/maps/matrix", response_model=MatrixResponse)
async def calculate_matrix(
    request: MatrixRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Calculate distance matrix between multiple origins and destinations.
    
    Authorization: All authenticated users
    """
    try:
        here_client = get_here_client()
        result = here_client.calculate_matrix(
            origins=request.origins,
            destinations=request.destinations,
            transport_mode=request.transport_mode
        )
        
        if result.get("error"):
            raise HTTPException(status_code=400, detail=result["error"])
        
        return MatrixResponse(
            matrix=result["matrix"],
            origins=result["origins"],
            destinations=result["destinations"]
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error calculating matrix: {e}")
        raise HTTPException(status_code=500, detail=f"Matrix calculation failed: {str(e)}")


@app.post("/maps/snapshot", response_model=SnapshotResponse)
async def generate_snapshot(
    request: SnapshotRequest,
    user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Generate static map snapshot URL.
    
    Authorization: All authenticated users
    """
    try:
        here_client = get_here_client()
        url = here_client.generate_snapshot(
            center=request.center,
            zoom=request.zoom,
            width=request.width,
            height=request.height,
            markers=request.markers,
            polyline=request.polyline
        )
        
        if not url:
            raise HTTPException(status_code=500, detail="Failed to generate snapshot")
        
        return SnapshotResponse(url=url)
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error generating snapshot: {e}")
        raise HTTPException(status_code=500, detail=f"Snapshot generation failed: {str(e)}")


# --- Application Events ---

# Register Routers at the end to keep clean separation
app.include_router(auth_router)
app.include_router(biometric_router)
app.include_router(onboarding_router) 
app.include_router(messaging_router)
app.include_router(finance_router)
app.include_router(load_documents_router)
app.include_router(load_workflow_router)
app.include_router(consents_router)
app.include_router(calendar_router)
app.include_router(help_center_router)
app.include_router(role_chat_router)

@app.on_event("startup")
def startup_events():
    # Build/refresh the embedded KB index (includes Help Center docs under data/kb).
    # This is required for semantic search and the Help Center AI context.
    try:
        bootstrap_knowledge_base(store)
    except Exception as e:
        print(f"[KB] bootstrap failed: {e}")

    scheduler.start()
    init_finance_scheduler(scheduler)
    scheduler.add_interval_job(_refresh_fmcsa_all, minutes=60 * 24, id="fmcsa_refresh_daily")
    scheduler.add_interval_job(_digest_alerts_job, minutes=60, id="alert_digest_hourly")
    scheduler.add_interval_job(_send_admin_email_digest_job, minutes=60 * 24, id="admin_email_digest_daily")
    # Delayed message email notifications (checks every minute).
    scheduler.add_interval_job(process_pending_message_email_notifications_job, minutes=1, id="message_email_notifications")
    # Execute approved user removals whose grace period elapsed.
    scheduler.add_interval_job(_process_due_user_removals, minutes=10, id="user_removal_processor")
    print(
        f"[Messaging] Delayed email notifications enabled={getattr(settings, 'ENABLE_MESSAGE_EMAIL_NOTIFICATIONS', False)} "
        f"delay_s={getattr(settings, 'MESSAGE_EMAIL_DELAY_SECONDS', 300)} smtp_configured={bool(getattr(settings, 'SMTP_USERNAME', ''))}"
    )


@app.on_event("shutdown")
def shutdown_events():
    scheduler.shutdown()


# --- SPA fallback (serve built React app) ---
# When you run `npm run build`, Vite writes to `dist/`. This handler serves:
# - real files from dist (e.g. /assets/*, /manifest.json, /service-worker.js)
# - otherwise dist/index.html for client-side routes like /admin
_DIST_DIR = Path(__file__).resolve().parents[2] / "dist"
_DIST_INDEX = _DIST_DIR / "index.html"


@app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str, request: Request):
    # If frontend isn't built, don't pretend it exists.
    if not _DIST_INDEX.exists():
        raise HTTPException(status_code=404, detail="Frontend build not found. Run `npm run build` to create dist/.")

    # Serve actual files when present.
    if full_path:
        candidate = (_DIST_DIR / full_path)
        try:
            candidate = candidate.resolve()
        except Exception:
            candidate = None

        if candidate and str(candidate).startswith(str(_DIST_DIR.resolve())) and candidate.exists() and candidate.is_file():
            return FileResponse(candidate)

    # SPA route fallback
    return FileResponse(_DIST_INDEX)
