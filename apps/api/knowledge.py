from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Dict, Any

from .rag import build_document_chunks
from .settings import settings
from .storage import ResponseStore

KB_DIR = Path(settings.DATA_DIR) / "kb"

DEFAULT_DOCS = {
    "faqs.md": """# FreightPower Onboarding FAQs

## What paperwork do I need?
- Certificate of Insurance (COI) showing active coverage
- IRS Form W-9 with TIN and signature
- CDL for every active driver

## How fast do approvals happen?
Once we receive clean paperwork we update status within one business day.

## Who do I contact for help?
Use the FreightPower assistant or email ai-onboarding@freightpower.example""",
    "onboarding_playbook.md": """# Onboarding Coach Script

1. Welcome the carrier and explain the required documents.
2. Verify MC/DOT information and insurance expiration dates.
3. Confirm driver roster and CDL validity.
4. Share next best actions and timelines.
5. Offer chat assistant for follow-up questions.""",

    # ------------------------------------------------------------------
    # Driver Help Center (in-app) — Articles and FAQs
    # These are written to data/kb so they can be embedded + semantically searched.
    # Filenames starting with help_ are indexed as doc_type=HELP.
    # Filenames starting with faq_ are indexed as doc_type=FAQ.
    # ------------------------------------------------------------------
    "help_driver_getting_started.md": """# Driver Dashboard: Getting Started

Keywords: getting started, dashboard, navigation, driver, help center

This guide helps you get oriented inside the Driver Dashboard.

## Where to start
1. Open **Driver Dashboard**.
2. Review your **Status** and **Alerts/Notifications**.
3. Confirm your **Profile** details (name, email, phone).

## Common issues
- **I can’t see Marketplace:** Your access may be pending onboarding items or consent.
- **Buttons look disabled:** Some features are role-based or still rolling out.

## Next best steps
- Visit **Account & Settings** to set your language and notifications.
- Use **Document Vault** to upload required documents if onboarding is incomplete.
""",

    "help_driver_language_and_accessibility.md": """# Change Language (and Accessibility Settings)

Keywords: language, spanish, arabic, accessibility, rtl, right-to-left

You can change the app language from **Account & Settings** and also inside the Help Center.

## How to change language
1. Open **Account & Settings**.
2. Go to **Preferences → Language**.
3. Select **English**, **Spanish**, or **Arabic**.

## What changes
- UI labels update immediately.
- Arabic enables right-to-left layout.

## Troubleshooting
- If text doesn’t change, refresh the page.
- If some labels show “missing translation”, that screen is still being translated.
""",

    "help_driver_login_session.md": """# Login, Sessions, and Trusted Devices

Keywords: login, sign in, session, logged out, trusted device, security

If you’re getting logged out unexpectedly or can’t stay signed in, this article helps.

## Quick checks
- Confirm you’re connected to the internet.
- Make sure your device date/time is correct.

## Common causes
- **Session revoked:** security protection may have invalidated older sessions.
- **Account deleted/disabled:** contact support to verify your account status.

## What to do
1. Log out.
2. Log back in.
3. If it keeps happening, submit a support ticket from the Help Center.
""",

    "help_driver_notifications.md": """# Alerts & Notifications

Keywords: notifications, alerts, compliance, messages, email digest

Your driver dashboard includes notifications for key events (messages, compliance alerts, and system updates).

## If you’re not receiving notifications
- Check **Account & Settings → Preferences → Notifications**.
- Ensure you have a stable internet connection.

## Notification history
Use **View Notification History** (when available) to review past events.
""",

    "help_driver_document_vault_upload.md": """# Document Vault: Uploading and Fixing Upload Problems

Keywords: document vault, upload, pdf, image, failed upload, file too large

Use Document Vault to upload compliance and trip documents.

## Supported file types (typical)
- PDF
- JPG/JPEG
- PNG

## Common upload errors
- **File too large:** reduce file size or upload a smaller scan.
- **Unsupported type:** convert to PDF or image.
- **Upload failed:** retry on a stronger connection.

## Tips
- Use clear photos (good lighting, no blur).
- Upload the full page(s), not cropped corners.
""",

    "help_driver_consent_esign.md": """# Consent & E‑Signature: Why You Might Be Blocked

Keywords: consent, esign, signature, blocked, onboarding, marketplace access

Some features require signing consents.

## Symptoms
- Marketplace access shows blocked.
- You see an onboarding checklist item requiring signature.

## Fix
1. Open **Consent & E‑Signature**.
2. Review the document.
3. Confirm and sign.

If signing fails, try again and ensure you’re signed in.
""",

    "help_driver_gps_location.md": """# GPS & Location Issues

Keywords: gps, location, not updating, permissions, nearby services

Location is used for maps and nearby services.

## Fix checklist
1. Enable location permissions for your browser/app.
2. Turn on device location services.
3. Refresh the page.

## If you still see “getting location”
- Your network may be blocking location.
- Try switching networks (Wi‑Fi/LTE).
""",

    "help_driver_marketplace_bids.md": """# Marketplace: Offers, Bids, and Why Actions Fail

Keywords: marketplace, bid, offer, accept, reject, cannot submit

If you can’t submit or accept an offer:

## Common reasons
- Your onboarding checklist is incomplete.
- Required documents are missing/expired.
- Consent signature is missing.

## What to do
1. Check **Account & Settings → Onboarding Center**.
2. Resolve missing items.
3. Retry the marketplace action.
""",

    "help_driver_fuel_stations.md": """# Fuel Stations: Missing Results or Wrong Locations

Keywords: fuel stations, nearby, search, map, missing results

If fuel station results look wrong:

## Checks
- Confirm GPS permissions.
- Try expanding your search radius.
- Refresh the map.

## Note
Nearby results depend on third‑party map data and may vary by region.
""",

    "help_driver_support_tickets.md": """# Support Tickets: How to Submit and Track

Keywords: support, ticket, request, status, pending

You can submit a support request from **Account & Settings** or the Help Center.

## Submit a ticket
1. Open **Help Center**.
2. Choose **Submit a Ticket**.
3. Provide a clear subject and describe the issue.

## Track ticket status
Tickets are stored in your account history. Status may show as **pending** until reviewed.
""",

    "faq_driver.md": """# Driver Help Center FAQs

## I can’t find the Help Center. Where is it?
Open **Account & Settings → Support & Help → Help Center & FAQ**.

## Live Chat is disabled. Why?
Live Chat is not yet supported in the app. It will show as **Coming Soon**.

## How do I change the app language?
Go to **Account & Settings → Preferences → Language**.

## My location is not updating.
Enable location permissions and refresh the page. See the GPS article for a checklist.

## How do I contact support?
Use **Submit a Ticket** and describe your issue. Include screenshots if possible.
""",
}


def _ensure_default_docs():
    KB_DIR.mkdir(parents=True, exist_ok=True)
    for name, content in DEFAULT_DOCS.items():
        path = KB_DIR / name
        if not path.exists():
            path.write_text(content.strip() + "\n", encoding="utf-8")


def bootstrap_knowledge_base(store: ResponseStore):
    """Load FAQ/onboarding docs into the local vector index."""
    _ensure_default_docs()
    existing = {doc["id"]: doc for doc in store.list_documents()}

    def _doc_type_for(md_name: str) -> str:
        n = (md_name or '').strip().lower()
        if n.startswith('help_'):
            return 'HELP'
        if n.startswith('faq_'):
            return 'FAQ'
        return 'KB'

    for md_path in KB_DIR.glob("*.md"):
        doc_id = f"kb::{md_path.stem}"
        text = md_path.read_text(encoding="utf-8").strip()
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()

        existing_record = existing.get(doc_id)
        if existing_record:
            stored_digest = (existing_record.get("metadata") or {}).get("digest")
            if stored_digest == digest and existing_record.get("chunk_count"):
                continue

        chunks = build_document_chunks(doc_id, text, doc_type=_doc_type_for(md_path.name))
        store.upsert_document_chunks(doc_id, chunks)

        # Extract a user-friendly title (first Markdown H1) for UI.
        title = None
        for line in text.splitlines():
            ln = line.strip()
            if ln.startswith('# '):
                title = ln[2:].strip()
                break

        record = {
            "id": doc_id,
            "filename": md_path.name,
            "doc_type": _doc_type_for(md_path.name),
            "source": "knowledge_base",
            "chunk_count": len(chunks),
            "metadata": {"digest": digest, "title": title or md_path.stem},
            "detection": {"document_type": "KB", "confidence": 1.0},
            "extraction": {"document_type": "KB", "text": text},
        }
        store.save_document(record)
