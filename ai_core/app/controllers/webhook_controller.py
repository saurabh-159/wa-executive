import hashlib
import logging
import os
import time

import requests
from fastapi import Request
from sqlalchemy import and_, or_, text, update
from sqlalchemy.exc import IntegrityError

from app.models.database import SessionLocal
from app.models.message import Message
from app.models.matter import Matter
from app.models.task import Task
from app.services.audit_job_queue import queue_chat_audit_job
from app.services.commitment_service import extract_commitments_from_chat
from app.services.history_backfill import trigger_history_backfill
from app.services.intent_sniffer import is_high_intent_message
from app.services.jid_identity import (
    canonical_chat_jid,
    digits_of,
    format_phone,
    is_raw_lid_name,
    usable_person_name,
)
from app.services.media_processor import process_media_payload
from app.services.multimodal_service import extract_image_context, transcribe_audio_file
from app.services.personal_bot_service import route_self_chat_intent, format_executive_card
from app.services.rag_search_service import generate_contact_audit_summary
from app.services.chat_isolation import fetch_isolated_messages, should_skip_needs_you_card
from app.services.matter_ai_service import synthesize_matter_from_chat
from app.services.matter_db_service import save_or_update_matter

logger = logging.getLogger(__name__)

NODE_WORKER_URL = os.getenv("NODE_WORKER_URL", "http://127.0.0.1:5001")
TEN_DAYS_SECONDS = 10 * 24 * 60 * 60

# wa_worker/downloads directory ka absolute path
MEDIA_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "wa_worker", "downloads")
)


def _resolve_media_path(media_path: str) -> str:
    """Relative media filename ko absolute local path mein convert karta hai."""
    if not media_path:
        return ""
    if os.path.isabs(media_path):
        return media_path
    return os.path.join(MEDIA_DIR, media_path)


def _coerce_from_me(body: dict) -> bool:
    """
    Prefer explicit from_me / is_from_me from Baileys.
    Accepts bool, 0/1, and common string forms — never invert.
    """
    raw = body.get("from_me", body.get("is_from_me", False))
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return bool(int(raw))
    if isinstance(raw, str):
        return raw.strip().lower() in {"1", "true", "yes", "y"}
    return False


def _already_has_media_enrichment(text: str) -> bool:
    lowered = (text or "").lower()
    return (
        "[voice note transcript]:" in lowered
        or "[voice note]:" in lowered
        or "[image ocr/details]:" in lowered
        or "[media extraction unavailable]" in lowered
        or "[media extraction failed]" in lowered
    )


def _compose_message_text(raw_text: str, media_type: str | None, enrichment: str) -> str:
    """Append media enrichment under caption/placeholder text (audio & image)."""
    raw = (raw_text or "").strip()
    extra = (enrichment or "").strip()
    if not extra:
        return raw
    if extra in raw:
        return raw
    # media_type reserved for future format tweaks; both paths use the same join
    _ = media_type
    return f"{raw}\n{extra}".strip() if raw else extra


def _peek_chat_is_monitored(tenant_jid: str, sender_jid: str | None) -> bool:
    """Zero-cost DB peek used before any OpenAI media / LLM work."""
    if not sender_jid:
        return False
    with SessionLocal() as db:
        return bool(
            db.query(Message.id)
            .filter(
                Message.tenant_jid == tenant_jid,
                Message.sender_jid == sender_jid,
                Message.is_monitored == True,  # noqa: E712
            )
            .first()
        )


def _enrich_text_from_media(
    *,
    text: str,
    media_type: str | None,
    media_path: str | None,
    media_base64: str | None,
    is_monitored: bool = True,
    chat_jid: str = "unknown",
) -> str:
    """Append Whisper / Vision extraction into stored message_text."""
    # Guard: unmonitored chats never spend Whisper / Vision tokens.
    if not is_monitored:
        return text
    if _already_has_media_enrichment(text):
        return text
    if (media_type or "").strip().lower() == "sticker":
        return text

    enrichment = ""
    if media_base64 and media_type in {"audio", "image"}:
        enrichment = process_media_payload(
            media_type,
            media_base64,
            is_monitored=is_monitored,
            caption=text,
            chat_jid=chat_jid,
        )
    elif media_type == "audio" and media_path:
        full_audio_path = _resolve_media_path(media_path)
        if os.path.exists(full_audio_path):
            transcribed = transcribe_audio_file(full_audio_path)
            if transcribed:
                enrichment = f"[Voice Note Transcript]: {transcribed}"
    elif media_type == "image" and media_path:
        full_image_path = _resolve_media_path(media_path)
        if os.path.exists(full_image_path):
            try:
                if os.path.getsize(full_image_path) < 5 * 1024:
                    logger.info(
                        "[Media Enrich] Vision skipped | reason=too_small | path=%s",
                        media_path,
                    )
                    return text
            except OSError:
                return text
            ocr = extract_image_context(full_image_path, chat_context=text or "")
            if ocr:
                enrichment = (
                    ocr
                    if ocr.lower().startswith("[image ocr/details]")
                    else f"[Image OCR/Details]: {ocr}"
                )

    # Keep original text even when extraction fails (placeholder still appended)
    return _compose_message_text(text, media_type, enrichment)


def send_whatsapp_reaction(message_id: str, remote_jid: str, emoji: str):
    """Node.js Baileys worker ko emoji reaction bhejta hai."""
    try:
        requests.post(
            f"{NODE_WORKER_URL}/api/reaction",
            json={
                "message_id": message_id,
                "remote_jid": remote_jid,
                "emoji": emoji,
            },
            timeout=3,
        )
    except Exception as e:
        print(f"Reaction send error: {e}")


def send_whatsapp_reply(remote_jid: str, text: str):
    """Node.js Baileys worker ko reply text message bhejta hai."""
    try:
        requests.post(
            f"{NODE_WORKER_URL}/send-message",
            json={"recipient_jid": remote_jid, "text": text},
            timeout=5,
        )
    except Exception as e:
        print(f"Reply send error: {e}")


async def process_incoming_webhook(request: Request) -> dict:
    """FastAPI route entrypoint jo incoming HTTP request body parse karta hai."""
    body = await request.json()
    return process_message_payload(body)


def resolve_ingest_tenant_id(body: dict | None = None, *, fallback: str = "default") -> str:
    """
    Prefer Firebase UID (`tenant_id`) over legacy `tenant_jid`.
    Never treat a WhatsApp phone JID as the tenant boundary when a UID is present.
    """
    raw = body or {}
    uid = str(raw.get("tenant_id") or "").strip()
    legacy = str(raw.get("tenant_jid") or "").strip()
    if uid and uid != "default" and "@" not in uid:
        return uid
    if legacy and legacy != "default" and "@" not in legacy:
        return legacy
    # Last resort: keep whatever was sent (may be a phone JID from old workers)
    return uid or legacy or fallback


def relink_phone_tenant_messages(db, tenant_id: str, phone_jid: str | None = None) -> dict:
    """
    Permanently reassign orphan rows saved under a WhatsApp phone JID to the
    authenticated Firebase UID. Used on connect + contacts self-heal.
    """
    tenant_id = str(tenant_id or "").strip()
    if not tenant_id or tenant_id == "default" or "@" in tenant_id:
        return {"updated": 0, "reason": "invalid_tenant_id"}

    owned = (
        db.query(Message.id).filter(Message.tenant_jid == tenant_id).limit(1).first()
    )
    # Still allow remapping specific phone_jid even if some rows already exist
    candidates: list[str] = []
    phone = str(phone_jid or "").strip()
    if phone and "@s.whatsapp.net" in phone:
        # Normalize device suffix (123:xx@s.whatsapp.net → 123@s.whatsapp.net)
        base = phone.split(":")[0]
        if "@" not in base:
            base = f"{base}@s.whatsapp.net"
        candidates.append(phone)
        if base != phone:
            candidates.append(base)

    if not candidates:
        phone_tenants = (
            db.query(Message.tenant_jid)
            .filter(Message.tenant_jid.like("%@s.whatsapp.net"))
            .distinct()
            .all()
        )
        values = [str(row[0]).strip() for row in phone_tenants if row and row[0]]
        if len(values) == 1:
            candidates = values
        elif not owned and len(values) > 1:
            # Ambiguous multi-phone orphans — require explicit phone_jid
            return {"updated": 0, "reason": "ambiguous_phone_tenants", "found": values}

    if not candidates:
        return {"updated": 0, "reason": "no_phone_tenant"}

    total = 0
    remapped_from: list[str] = []
    for source in candidates:
        if source == tenant_id:
            continue
        changed = (
            db.query(Message)
            .filter(Message.tenant_jid == source)
            .update({Message.tenant_jid: tenant_id}, synchronize_session=False)
        )
        if changed:
            total += int(changed)
            remapped_from.append(source)

    if total:
        print(
            f"[Tenant Relink] {total} messages → tenant_id={tenant_id} from {remapped_from}"
        )
    return {"updated": total, "from": remapped_from, "tenant_id": tenant_id}


def process_message_payload(body: dict) -> dict:
    """Core business logic jo single message ko process, save aur route karti hai (Tenant Isolated)."""
    tenant_jid = resolve_ingest_tenant_id(body)
    message_id = body.get("message_id")
    sender_jid, phone_number = canonical_chat_jid(
        body.get("chat_jid") or body.get("sender_jid"),
        body.get("phone_number"),
    )
    # Cold-start / unindexed chats often arrive with blank or placeholder names.
    # Prefer a formatted phone label, then fall back to "Unknown Contact".
    raw_sender_name = body.get("sender_name")
    sender_name = str(raw_sender_name or "").strip()
    if is_raw_lid_name(sender_name) or not usable_person_name(sender_name):
        sender_name = format_phone(phone_number or sender_jid) or "Unknown Contact"
    text = body.get("text", "") or ""
    is_from_me = _coerce_from_me(body)
    is_self_chat = body.get("is_self_chat", False)
    is_history = body.get("is_history", False)
    is_group = bool(body.get("is_group")) or (
        bool(sender_jid) and str(sender_jid).endswith("@g.us")
    )
    timestamp = body.get("timestamp", 0)
    media_type = body.get("media_type")
    media_path = body.get("media_path")
    media_base64 = body.get("media_base64")
    avatar_url = body.get("avatar_url")
    participant_name = (body.get("participant_name") or "").strip()[:100] or None
    mentions_user = bool(body.get("mentions_user"))

    # ------------------------------------------------------------------
    # Guard 1: resolve monitored flag BEFORE any OpenAI media / LLM spend.
    # Unmonitored casual live traffic → inbox only (regex gate, zero tokens).
    # ------------------------------------------------------------------
    chat_is_monitored = _peek_chat_is_monitored(tenant_jid, sender_jid)
    high_intent = is_high_intent_message(text)
    allow_media_ai = False
    if is_self_chat:
        allow_media_ai = True
    elif chat_is_monitored:
        allow_media_ai = True
    elif (not is_history) and high_intent:
        # High-intent unmonitored may carry a receipt/screenshot worth OCR
        # before auto-promote + audit enqueue.
        allow_media_ai = True

    if allow_media_ai:
        try:
            text = _enrich_text_from_media(
                text=text,
                media_type=media_type,
                media_path=media_path,
                media_base64=media_base64,
                is_monitored=True,
                chat_jid=sender_jid or "unknown",
            )
        except Exception as exc:
            logger.error(
                "[Media Enrich] Unexpected failure (continuing text-only): %s", exc
            )

    if not str(text or "").strip():
        if media_type == "image":
            text = "[Photo]"
        elif media_type == "audio":
            text = "[Voice Note]"
        elif (media_type or "").strip().lower() == "sticker":
            text = "[Sticker]"

    with SessionLocal() as db:
        # Duplicate check per tenant
        existing = (
            db.query(Message)
            .filter(Message.tenant_jid == tenant_jid, Message.message_id == message_id)
            .first()
        )
        if existing:
            changed = False
            # Correct any previously inverted / missing from_me
            if bool(existing.is_from_me) != bool(is_from_me):
                existing.is_from_me = bool(is_from_me)
                changed = True
            if avatar_url and not existing.avatar_url:
                existing.avatar_url = avatar_url
                changed = True
            if media_path and not existing.media_path:
                existing.media_path = media_path
                existing.media_type = media_type
                changed = True
            if media_type and media_path:
                if not existing.media_path:
                    existing.media_path = media_path
                    changed = True
                if media_type and existing.media_type != media_type:
                    existing.media_type = media_type
                    changed = True
                enriched = _already_has_media_enrichment(text)
                existing_plain = not _already_has_media_enrichment(str(existing.text or ""))
                if enriched and existing_plain:
                    existing.text = text
                    changed = True
            if (
                sender_jid
                and existing.sender_jid != sender_jid
                and str(existing.sender_jid).endswith("@lid")
                and str(sender_jid).endswith("@s.whatsapp.net")
            ):
                existing.sender_jid = sender_jid
                changed = True
            if participant_name and not existing.participant_name:
                existing.participant_name = participant_name
                changed = True
            if mentions_user and not existing.mentions_user:
                existing.mentions_user = True
                changed = True
            if phone_number and not existing.phone_number:
                existing.phone_number = phone_number
                changed = True
            if is_raw_lid_name(existing.sender_name) and sender_name and not is_raw_lid_name(sender_name):
                existing.sender_name = sender_name
                changed = True
            if changed:
                db.commit()
                logger.info(
                    "[Ingest Stored] ID: %s | from_me: %s | HasMedia: %s | Preview: %s",
                    message_id,
                    bool(existing.is_from_me),
                    bool(existing.media_type or media_type),
                    (existing.text or "")[:80],
                )
            return {"status": "skipped", "reason": "duplicate_message"}

        # Delete initial placeholder for this tenant and JID
        if sender_jid and message_id and not str(message_id).startswith("sync-ph:"):
            db.query(Message).filter(
                Message.tenant_jid == tenant_jid,
                Message.message_id == _placeholder_message_id(sender_jid),
            ).delete(synchronize_session=False)

        # Re-confirm monitoring flag from DB (Selection Desk) before persist.
        # Prefer True if either the early peek or an existing monitored row says so.
        db_monitored = bool(
            sender_jid
            and db.query(Message.id)
            .filter(
                Message.tenant_jid == tenant_jid,
                Message.sender_jid == sender_jid,
                Message.is_monitored == True,  # noqa: E712
            )
            .first()
        )
        chat_is_monitored = bool(chat_is_monitored or db_monitored)

        new_msg = Message(
            tenant_jid=tenant_jid,
            message_id=message_id,
            sender_jid=sender_jid,
            phone_number=phone_number,
            sender_name=sender_name,
            participant_name=participant_name,
            mentions_user=mentions_user,
            is_from_me=bool(is_from_me),
            is_group=is_group,
            is_monitored=chat_is_monitored,
            timestamp=timestamp,
            text=text,
            media_type=media_type,
            media_path=media_path,
            avatar_url=avatar_url,
        )
        db.add(new_msg)
        db.commit()
        logger.info(
            "[Ingest Stored] ID: %s | from_me: %s | HasMedia: %s | Preview: %s",
            message_id,
            bool(is_from_me),
            bool(media_type),
            (text or "")[:80],
        )

        # Propagate DP to earlier rows for this chat under this tenant
        if avatar_url and sender_jid:
            db.execute(
                update(Message)
                .where(Message.tenant_jid == tenant_jid, Message.sender_jid == sender_jid)
                .where(
                    or_(
                        Message.avatar_url.is_(None),
                        Message.avatar_url == "",
                    )
                )
                .values(avatar_url=avatar_url)
            )
            db.commit()

        if is_history:
            return {"status": "history_saved", "message_id": message_id, "tenant_jid": tenant_jid}

        # -------------------------------------------------------------
        # BRANCH A: AGENTIC SELF-CHAT
        # -------------------------------------------------------------
        if is_self_chat:
            send_whatsapp_reaction(message_id, sender_jid, "👀")

            routed = route_self_chat_intent(text)
            intent = routed.get("intent")
            reply_text = None

            if intent == "CREATE_TASK":
                task_data = routed.get("task_data", {}) or {}
                heading = task_data.get("heading") or text[:30]
                due_date = task_data.get("due_date", "Pending")
                priority = task_data.get("priority", "MEDIUM")

                new_task = Task(
                    task_heading=heading,
                    category="I_OWE_THEM",
                    counterparty_name="Self (Personal)",
                    sender_jid=sender_jid,
                    context_their_message="Personal Command",
                    context_your_reply=text,
                    full_thread_summary=f"Created via self-chat: {text}",
                    due_date_time=due_date,
                    priority=priority,
                    status="PENDING",
                )
                db.add(new_task)
                db.commit()

                reply_text = format_executive_card(
                    "Task Created",
                    [
                        f"*Task:* {heading}",
                        f"*Due:* {due_date}",
                        f"*Priority:* {priority}",
                    ],
                )

            elif intent == "QUERY_TASKS":
                pending_tasks = (
                    db.query(Task)
                    .filter(Task.status == "PENDING")
                    .order_by(Task.id.desc())
                    .limit(5)
                    .all()
                )
                if not pending_tasks:
                    lines = ["Sab clear hai! Koi pending tasks nahi hain."]
                else:
                    lines = [
                        f"{idx + 1}. *{t.task_heading}* ({t.due_date_time})"
                        for idx, t in enumerate(pending_tasks)
                    ]

                reply_text = format_executive_card("Your Pending Tasks", lines)

            elif intent == "COMPLETE_TASK":
                keyword = routed.get("search_keyword", "") or ""
                task_to_close = (
                    db.query(Task)
                    .filter(
                        Task.status == "PENDING",
                        Task.task_heading.ilike(f"%{keyword}%"),
                    )
                    .first()
                )
                if task_to_close:
                    task_to_close.status = "COMPLETED"
                    db.commit()
                    reply_text = format_executive_card(
                        "Task Completed",
                        [
                            f"*Done:* {task_to_close.task_heading}",
                            "Status updated to COMPLETED.",
                        ],
                    )
                else:
                    reply_text = format_executive_card(
                        "Task Not Found",
                        [f"'{keyword}' se related koi pending task nahi mila."],
                    )

            elif intent == "AUDIT_CONTACT":
                audit_info = routed.get("contact_query", {}) or {}
                person_name = audit_info.get("person_name", "") or ""
                topic = audit_info.get("query_topic", text) or text

                contact_match = (
                    db.query(Message)
                    .filter(Message.tenant_jid == tenant_jid)
                    .filter(Message.sender_name.ilike(f"%{person_name}%"))
                    .first()
                )

                if not contact_match:
                    reply_text = format_executive_card(
                        "Audit Not Found",
                        [f"Database mein '{person_name}' naam ka koi contact nahi mila."],
                    )
                else:
                    audit_result = generate_contact_audit_summary(
                        contact_name=contact_match.sender_name,
                        sender_jid=contact_match.sender_jid,
                        query=topic,
                    )
                    reply_text = (
                        "⚡ *EXECUTIVE CHAT AUDIT*\n"
                        "────────────────────────\n"
                        f"👤 *Target:* {contact_match.sender_name}\n"
                        f"🔍 *Query:* {topic}\n"
                        "────────────────────────\n\n"
                        f"{audit_result}"
                    )

            else:
                reply_text = routed.get("general_reply", "Main samajh gaya.")

            if reply_text:
                send_whatsapp_reply(sender_jid, reply_text)
                send_whatsapp_reaction(message_id, sender_jid, "✅")

            return {
                "status": "self_chat_processed",
                "intent": intent,
                "bot_reply": reply_text,
            }

        # -------------------------------------------------------------
        # BRANCH B: REGULAR CHATS (Perisclaw Matter Pipeline)
        # Zero-token guard for unmonitored chats + high-intent auto-promote.
        # -------------------------------------------------------------
        if not chat_is_monitored:
            if not is_high_intent_message(text):
                # Casual / banter — inbox only, no LLM / audit spend.
                return {
                    "status": "stored_inbox_only",
                    "message_id": message_id,
                    "tenant_jid": tenant_jid,
                }

            # High-intent: promote chat, backfill history, enqueue audit.
            db.query(Message).filter(
                Message.tenant_jid == tenant_jid,
                Message.sender_jid == sender_jid,
            ).update(
                {Message.is_monitored: True},
                synchronize_session=False,
            )
            db.commit()
            chat_is_monitored = True

            try:
                trigger_history_backfill(
                    db,
                    tenant_id=tenant_jid,
                    jid=sender_jid,
                )
            except Exception as exc:
                logger.warning(
                    "[Auto-Promote] History backfill failed for %s: %s",
                    sender_jid,
                    exc,
                )

            try:
                queue_chat_audit_job(
                    db,
                    tenant_jid,
                    sender_jid,
                    chat_name=sender_name,
                    is_group=is_group,
                    status="PENDING",
                )
            except Exception as exc:
                logger.warning(
                    "[Auto-Promote] Audit job enqueue failed for %s: %s",
                    sender_jid,
                    exc,
                )

            logger.info(
                "[Auto-Promote] Promoted %s to monitored due to high-intent message",
                sender_jid,
            )
            return {
                "status": "auto_promoted",
                "message_id": message_id,
                "tenant_jid": tenant_jid,
                "chat_jid": sender_jid,
            }

        recent_messages = fetch_isolated_messages(db, sender_jid, limit=12, tenant_jid=tenant_jid)

        # Step 1: Commitments / Tasks Extraction
        full_image_path = _resolve_media_path(media_path) if (media_type == "image" and media_path) else None
        valid_media_path = full_image_path if (full_image_path and os.path.exists(full_image_path)) else None

        ai_result = extract_commitments_from_chat(
            messages=recent_messages,
            counterparty_name=sender_name,
            media_path=valid_media_path,
        )

        if ai_result.get("is_task") is True and ai_result.get("heading"):
            task = Task(
                task_heading=ai_result.get("heading"),
                category=ai_result.get("category", "I_OWE_THEM"),
                counterparty_name=sender_name,
                sender_jid=sender_jid,
                context_their_message=ai_result.get("their_message", ""),
                context_your_reply=ai_result.get("my_reply", ""),
                full_thread_summary=ai_result.get("summary", ""),
                due_date_time=ai_result.get("due_date", "Pending"),
                priority="MEDIUM",
                status="PENDING",
            )
            db.add(task)
            db.commit()

        # Step 2: Perisclaw Matter Intelligence
        try:
            if recent_messages and not should_skip_needs_you_card(
                sender_jid, sender_name, recent_messages
            ):
                matter_ai_result = synthesize_matter_from_chat(
                    recent_messages,
                    sender_name,
                    chat_jid=sender_jid,
                )
                if matter_ai_result:
                    save_or_update_matter(
                        db=db,
                        sender_jid=sender_jid,
                        contact_name=sender_name,
                        ai_data=matter_ai_result,
                        tenant_jid=tenant_jid,
                    )
        except Exception as err:
            print(f"❌ [Matter Pipeline Error]: {err}")

    return {"status": "success", "message_id": message_id, "tenant_jid": tenant_jid}


def process_incoming_batch(messages: list) -> dict:
    """History / batch messages with tenant forwarding."""
    results = []
    for msg in messages or []:
        payload = dict(msg)
        payload.setdefault("is_history", True)
        results.append(process_message_payload(payload))
    return {
        "status": "success",
        "processed": len(results),
        "results": results,
    }


_PLACEHOLDER_NAMES = (
    "",
    "Unknown",
    "Unknown Contact",
    "WhatsApp Contact",
    "User",
    "Group",
    "WhatsApp Group",
)
_SELF_LABELS = ("You", "You (Self)")


def _upsert_contact_row(db, tenant_jid: str, jid: str, name: str | None, notify: str | None, phone_number: str | None = None):
    """Persist one address-book row into the contacts table (SQLite upsert)."""
    if not tenant_jid or not jid or jid == "status@broadcast":
        return False
    # Keep real names; never let a missing payload wipe a good name.
    # Prefer an already-saved contacts.name (e.g. Google Contacts sync) over
    # a later WhatsApp phonebook/pushName — Google is the display priority.
    # Phone-like names are already filtered to NULL by the caller.
    db.execute(
        text(
            """
            INSERT INTO contacts (tenant_jid, jid, name, notify_name, phone_number, updated_at)
            VALUES (:t, :j, :n, :notif, :phone, CURRENT_TIMESTAMP)
            ON CONFLICT(tenant_jid, jid) DO UPDATE SET
                name = COALESCE(contacts.name, excluded.name),
                notify_name = COALESCE(excluded.notify_name, contacts.notify_name),
                phone_number = COALESCE(excluded.phone_number, contacts.phone_number),
                updated_at = CURRENT_TIMESTAMP
            """
        ),
        {
            "t": tenant_jid,
            "j": jid,
            "n": name,
            "notif": notify,
            "phone": phone_number,
        },
    )
    return True


def _bulk_rename_weak_messages(db, tenant_jid: str, renames: dict[str, str]) -> int:
    """Apply display-name renames once per JID instead of once per contact upsert."""
    updated = 0
    for jid, display_name in renames.items():
        if not jid or not display_name:
            continue
        result = db.execute(
            update(Message)
            .where(
                Message.tenant_jid == tenant_jid,
                Message.sender_jid == jid,
                or_(
                    Message.sender_name.is_(None),
                    and_(
                        ~Message.sender_name.ilike("You (Self)%"),
                        ~Message.sender_name.ilike("Note to self%"),
                        or_(
                            Message.sender_name.in_(_PLACEHOLDER_NAMES),
                            Message.sender_name.like("+%"),
                            Message.sender_name == "WhatsApp Contact",
                            Message.sender_name == jid,
                            Message.sender_name == jid.split("@")[0],
                        ),
                    ),
                ),
            )
            .values(sender_name=display_name)
        )
        if result.rowcount and result.rowcount > 0:
            updated += int(result.rowcount)
    return updated


def update_contacts_in_db(db, contacts: list, tenant_jid: str = "default"):
    """
    Upsert worker address-book rows into `contacts`, then rename weak
    Message.sender_name values for that tenant in one pass.
    """
    upserted = 0
    renames: dict[str, str] = {}
    for c in contacts:
        jid = (c.get("jid") or c.get("id") or "").strip()
        name_raw = (c.get("name") or "").strip()
        notify_raw = (c.get("notify") or c.get("notify_name") or "").strip()
        # Never persist a formatted phone as the address-book name.
        name = (usable_person_name(name_raw) or "")[:100] or None
        notify = (usable_person_name(notify_raw) or "")[:100] or None
        c_tenant = c.get("tenant_jid") or c.get("tenant_id") or tenant_jid
        if not jid or jid == "status@broadcast":
            continue

        phone_number = None
        raw_phone = c.get("phone_number")
        if raw_phone:
            # Digits only — strips spaces, +, dashes, parentheses, @domain
            phone_number = digits_of(raw_phone) or None

        if _upsert_contact_row(db, c_tenant, jid, name, notify, phone_number):
            upserted += 1

        # Also index canonical phone JID when available
        canon_jid, phone_digits = canonical_chat_jid(jid, phone_number or c.get("phone_number"))
        if canon_jid and canon_jid != jid:
            if _upsert_contact_row(db, c_tenant, canon_jid, name, notify, phone_digits or phone_number):
                upserted += 1

        display_name = name or notify
        if not display_name:
            continue
        for target in {jid, canon_jid}:
            if not target:
                continue
            # Prefer phonebook name over notify if both appear for same JID.
            if target not in renames or name:
                renames[target] = display_name

    # Clear polluted phone-as-name rows so notify/message fallbacks can win.
    db.execute(
        text(
            """
            UPDATE contacts
            SET name = NULL
            WHERE tenant_jid = :t
              AND name IS NOT NULL
              AND (
                name LIKE '+%'
                OR (
                  replace(replace(replace(name, ' ', ''), '+', ''), '-', '') GLOB '[0-9]*'
                  AND length(replace(replace(replace(name, ' ', ''), '+', ''), '-', '')) BETWEEN 10 AND 15
                  AND name NOT GLOB '*[A-Za-z]*'
                )
              )
            """
        ),
        {"t": tenant_jid},
    )

    updated_count = _bulk_rename_weak_messages(db, tenant_jid, renames)
    db.commit()
    print(f"✅ [WEBHOOK] Synced {upserted} contacts into DB; renamed {updated_count} messages")
    return {
        "status": "ok",
        "synced": upserted,
        "updated_messages": updated_count,
    }


def settle_contact_names_from_db(db, tenant_jid: str = "default") -> dict:
    """
    After phonebook app-state sync: apply contacts.name / notify_name onto any
    weak Message.sender_name values for this tenant (phone labels, placeholders).
    """
    if not tenant_jid:
        return {"status": "skipped", "reason": "empty_tenant"}

    rows = db.execute(
        text(
            """
            SELECT jid, name, notify_name, phone_number
            FROM contacts
            WHERE tenant_jid = :t
            """
        ),
        {"t": tenant_jid},
    ).fetchall()

    renames: dict[str, str] = {}
    named = 0
    notified = 0
    for jid, name, notify, phone in rows:
        saved = usable_person_name(name)
        push = usable_person_name(notify)
        display = saved or push
        if not display:
            continue
        if saved:
            named += 1
        elif push:
            notified += 1
        targets = {jid}
        if phone:
            digits = str(phone).replace("+", "").strip()
            if digits:
                targets.add(digits)
                targets.add(f"{digits}@s.whatsapp.net")
        canon_jid, _ = canonical_chat_jid(jid, phone)
        if canon_jid:
            targets.add(canon_jid)
        for target in targets:
            if not target:
                continue
            prev = renames.get(target)
            if not prev or saved:
                renames[target] = display

    updated = _bulk_rename_weak_messages(db, tenant_jid, renames)
    db.commit()
    print(
        f"✅ [SETTLE NAMES] tenant={tenant_jid} phonebook={named} "
        f"notify={notified} renamed_messages={updated}"
    )
    return {
        "status": "ok",
        "phonebook_names": named,
        "notify_names": notified,
        "rename_targets": len(renames),
        "updated_messages": updated,
    }


def _placeholder_message_id(jid: str) -> str:
    token = f"sync-ph:{jid}"
    if len(token) <= 100:
        return token
    return f"sync-ph:{hashlib.sha1(jid.encode('utf-8')).hexdigest()}"


def upsert_initial_chats(db, chats: list) -> dict:
    """
    Insert one recent-chat placeholder per JID (10-day window, Tenant Isolated).
    """
    created = 0
    now = int(time.time())
    oldest = now - TEN_DAYS_SECONDS

    for chat in chats or []:
        tenant_jid = resolve_ingest_tenant_id(chat)
        jid, phone_number = canonical_chat_jid(
            str((chat or {}).get("jid") or "").strip(),
            (chat or {}).get("phone_number"),
        )
        if not jid or jid.endswith("@broadcast") or jid.endswith("@newsletter"):
            continue
        try:
            timestamp = int(chat.get("timestamp") or 0)
        except (TypeError, ValueError):
            timestamp = 0
        if timestamp and timestamp < oldest:
            continue

        already = (
            db.query(Message.id)
            .filter(Message.tenant_jid == tenant_jid, Message.sender_jid == jid)
            .first()
        )
        if already:
            continue

        raw_name = str(chat.get("name") or "").strip()
        if is_raw_lid_name(raw_name):
            raw_name = ""
        name = (raw_name or format_phone(phone_number or jid) or "Unknown")[:100]
        db.add(
            Message(
                tenant_jid=tenant_jid,
                message_id=_placeholder_message_id(jid),
                sender_jid=jid,
                phone_number=phone_number,
                sender_name=name,
                is_from_me=False,
                is_group=bool(chat.get("is_group")) or jid.endswith("@g.us"),
                timestamp=timestamp or now,
                text="",
            )
        )
        try:
            db.commit()
            created += 1
        except IntegrityError:
            db.rollback()

    return {"status": "success", "created": created}


_WEAK_REMAP_NAMES = {
    "",
    "You",
    "Unknown",
    "Unknown Contact",
    "WhatsApp Contact",
    "User",
    "Group",
    "WhatsApp Group",
}


def upsert_lid_mappings(db, mappings: list, tenant_jid: str = "default", *, commit: bool = True) -> dict:
    """Persist LID→phone mappings into `lid_mappings` for later name resolution."""
    count = 0
    for m in mappings or []:
        lid = str((m or {}).get("lid") or (m or {}).get("id") or "").strip()
        pn = str((m or {}).get("pn") or (m or {}).get("phoneNumber") or "").strip()
        m_tenant = (m or {}).get("tenant_jid") or (m or {}).get("tenant_id") or tenant_jid
        if not lid or not pn:
            continue
        if not lid.endswith("@lid") and not lid.endswith("@hosted.lid"):
            continue

        phone_jid = pn if "@" in pn else f"{pn}@s.whatsapp.net"
        clean_num = phone_jid.split("@")[0].replace("+", "").strip()

        db.execute(
            text(
                """
                INSERT INTO lid_mappings (tenant_jid, lid, phone_jid, phone_number)
                VALUES (:t, :lid, :p_jid, :p_num)
                ON CONFLICT(tenant_jid, lid) DO UPDATE SET
                    phone_jid = excluded.phone_jid,
                    phone_number = excluded.phone_number
                """
            ),
            {"t": m_tenant, "lid": lid, "p_jid": phone_jid, "p_num": clean_num},
        )
        count += 1

    if commit:
        db.commit()
        print(f"🔗 [WEBHOOK] Synced {count} LID-to-PN mappings for tenant {tenant_jid}")
    return {"status": "ok", "mappings_synced": count}


def remap_lid_identifiers(db, mappings: list, tenant_jid: str = "default") -> dict:
    """Persist LID maps, then rewrite chats stored under @lid onto real phone JIDs."""
    # Always persist mappings first so name resolution works even before remap completes
    persist = upsert_lid_mappings(db, mappings, tenant_jid=tenant_jid, commit=False)

    updated_messages = 0
    updated_matters = 0
    updated_tasks = 0
    renamed = 0

    # Only remap LIDs that actually appear as sender_jid — avoid 1000 empty UPDATEs.
    lids = []
    by_lid = {}
    for item in mappings or []:
        lid = str((item or {}).get("lid") or "").strip()
        pn = str((item or {}).get("pn") or "").strip()
        name = usable_person_name(str((item or {}).get("name") or "").strip())
        m_tenant = (item or {}).get("tenant_jid") or tenant_jid
        if not pn:
            continue
        phone_jid = pn if "@" in pn else f"{pn}@s.whatsapp.net"
        if not (lid.endswith("@lid") or lid.endswith("@hosted.lid")):
            continue
        if not phone_jid.endswith("@s.whatsapp.net") and not phone_jid.endswith("@hosted"):
            continue
        lids.append(lid)
        by_lid[lid] = (phone_jid, name, m_tenant)

    if lids:
        present: set[str] = set()
        chunk_size = 400
        for i in range(0, len(lids), chunk_size):
            chunk = lids[i : i + chunk_size]
            present.update(
                row[0]
                for row in db.execute(
                    text(
                        """
                        SELECT DISTINCT sender_jid FROM messages
                        WHERE tenant_jid = :t AND sender_jid IN ({placeholders})
                        """.format(
                            placeholders=", ".join(f":l{n}" for n in range(len(chunk)))
                        )
                    ),
                    {"t": tenant_jid, **{f"l{n}": lid for n, lid in enumerate(chunk)}},
                ).fetchall()
            )
        for lid in present:
            phone_jid, name, m_tenant = by_lid[lid]
            msg_result = db.execute(
                update(Message)
                .where(Message.tenant_jid == m_tenant, Message.sender_jid == lid)
                .values(sender_jid=phone_jid)
            )
            updated_messages += msg_result.rowcount or 0

            matter_result = db.execute(
                update(Matter)
                .where(Matter.tenant_jid == m_tenant, Matter.sender_jid == lid)
                .values(sender_jid=phone_jid)
            )
            updated_matters += matter_result.rowcount or 0

            task_result = db.execute(
                update(Task).where(Task.sender_jid == lid).values(sender_jid=phone_jid)
            )
            updated_tasks += task_result.rowcount or 0

            if name and name not in _WEAK_REMAP_NAMES:
                result = db.execute(
                    update(Message)
                    .where(Message.tenant_jid == m_tenant, Message.sender_jid == phone_jid)
                    .where(
                        or_(
                            Message.sender_name.is_(None),
                            Message.sender_name.in_(list(_WEAK_REMAP_NAMES)),
                            Message.sender_name == "WhatsApp Contact",
                            Message.sender_name == lid.split("@")[0],
                            Message.sender_name == phone_jid.split("@")[0],
                            Message.sender_name.like("+%"),
                        )
                    )
                    .values(sender_name=name)
                )
                renamed += result.rowcount or 0

    db.commit()
    synced = persist.get("mappings_synced", 0)
    print(
        f"🔗 [WEBHOOK] Synced {synced} LID mappings; "
        f"remapped msgs={updated_messages} matters={updated_matters} "
        f"tasks={updated_tasks} renamed={renamed}"
    )
    return {
        "status": "success",
        "mappings_synced": synced,
        "updated_messages": updated_messages,
        "updated_matters": updated_matters,
        "updated_tasks": updated_tasks,
    }


def apply_avatar_updates(db, avatars: list, tenant_jid: str = "default") -> dict:
    """Stamp WhatsApp profile-photo URLs onto chats for the specified tenant."""
    updated = 0
    for item in avatars or []:
        jid = str((item or {}).get("jid") or "").strip()
        url = str((item or {}).get("avatar_url") or "").strip()
        a_tenant = (item or {}).get("tenant_jid") or tenant_jid
        if not jid or not url:
            continue
        result = db.execute(
            update(Message)
            .where(Message.tenant_jid == a_tenant, Message.sender_jid == jid)
            .where(or_(Message.avatar_url.is_(None), Message.avatar_url == ""))
            .values(avatar_url=url)
        )
        updated += result.rowcount or 0
    db.commit()
    return {"status": "success", "updated_messages": updated}