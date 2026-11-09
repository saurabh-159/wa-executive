import asyncio
import os
import threading
import time
import requests
from fastapi import Request, HTTPException
from sqlalchemy import func, desc, or_
from app.models.database import SessionLocal
from app.models.message import Message
from app.services.contact_names import load_contact_directory, lookup_contact_labels
from app.services.jid_identity import (
    format_last_message_time,
    is_lid_jid,
    is_phone_jid,
    is_sync_placeholder,
    preview_text,
    resolve_chat_label,
    usable_person_name,
)
from app.services.history_backfill import request_on_demand_history
from app.services.multimodal_service import get_last_transcribe_error, transcribe_audio_file

LIVE_WORKER_URL = os.getenv("LIVE_WORKER_URL", "http://127.0.0.1:5001")
TEN_DAYS_SECONDS = 10 * 24 * 60 * 60

_TRANSCRIBE_BATCH = 6
_transcribe_guard = threading.Lock()
_transcribe_locks: dict[str, threading.Lock] = {}

_WEAK_CHAT_NAMES = {
    "",
    "Unknown",
    "Unknown Contact",
    "User",
    "You",
}


def _extract_tenant_jid(request: Request) -> str:
    """Header ya query parameter se tenant_jid extract karta hai bina blind 'default' fallback ke."""
    header = (
        request.headers.get("X-Tenant-JID")
        or request.headers.get("x-tenant-jid")
        or ""
    ).strip()
    if header:
        return header

    param = (
        request.query_params.get("tenant_jid")
        or request.query_params.get("tenant_id")
        or ""
    ).strip()
    if param:
        return param

    # Isolated guest context taaki Incognito me data leak na ho
    return "guest_unlinked"


def _is_lid_jid(jid: str | None) -> bool:
    value = str(jid or "")
    return value.endswith("@lid") or value.endswith("@hosted.lid")


def _phone_digits(jid: str | None) -> str:
    return "".join(ch for ch in str(jid or "").split("@")[0] if ch.isdigit())


def _is_real_phone_jid(jid: str | None) -> bool:
    """Handset JIDs only. LID and group ids are not phone numbers."""
    if not jid or _is_group_jid(jid) or _is_lid_jid(jid):
        return False
    digits = _phone_digits(jid)
    if len(digits) == 10:
        return True
    if len(digits) == 12 and digits.startswith("91"):
        return True
    return 11 <= len(digits) <= 13


def _format_phone(jid: str) -> str:
    if not _is_real_phone_jid(jid):
        return ""
    digits = _phone_digits(jid)
    if len(digits) == 12 and digits.startswith("91"):
        return f"+91 {digits[2:7]} {digits[7:]}"
    if len(digits) == 10:
        return f"+91 {digits[:5]} {digits[5:]}"
    return f"+{digits}"


def _is_self_label(name: str | None) -> bool:
    cleaned = (name or "").strip().lower()
    return cleaned.startswith("you (self)") or cleaned.startswith("note to self")


def _is_group_jid(jid: str | None) -> bool:
    return bool(jid) and str(jid).endswith("@g.us")


def _usable_contact_name(name: str | None, jid: str) -> str | None:
    cleaned = (name or "").strip()
    phone = jid.split("@")[0] if jid else ""
    if _is_self_label(cleaned):
        return cleaned if cleaned else "Note to self"
    if cleaned == phone:
        return None
    return usable_person_name(cleaned)


def _better_names_for(db, jids: list[str], tenant_jid: str = "guest_unlinked") -> dict[str, str]:
    """Latest-message name 'You' / phone ho to usi chat ka saved contact name (Tenant Scoped)."""
    if not jids or tenant_jid == "guest_unlinked":
        return {}
    rows = (
        db.query(Message.sender_jid, Message.sender_name)
        .filter(Message.tenant_jid == tenant_jid)
        .filter(Message.sender_jid.in_(jids))
        .filter(Message.sender_name.isnot(None))
        .filter(Message.sender_name.notin_(list(_WEAK_CHAT_NAMES)))
        .all()
    )
    found = {}
    for jid, name in rows:
        usable = _usable_contact_name(name, jid)
        if usable and jid not in found:
            found[jid] = usable
    return found


def _avatars_for(db, jids: list[str], tenant_jid: str = "guest_unlinked") -> dict[str, str]:
    """Latest non-empty avatar_url per chat jid (Tenant Scoped)."""
    if not jids or tenant_jid == "guest_unlinked":
        return {}
    rows = (
        db.query(Message.sender_jid, Message.avatar_url, Message.timestamp)
        .filter(Message.tenant_jid == tenant_jid)
        .filter(Message.sender_jid.in_(jids))
        .filter(Message.avatar_url.isnot(None))
        .filter(Message.avatar_url != "")
        .order_by(Message.timestamp.desc())
        .all()
    )
    found = {}
    for jid, url, _ts in rows:
        if jid not in found and url:
            found[jid] = url
    return found


def _chat_display_name(
    sender_name: str | None,
    jid: str,
    better_names: dict[str, str],
    saved_name: str | None = None,
    notify_name: str | None = None,
    phone_number: str | None = None,
) -> str:
    if _is_self_label(sender_name):
        phone = _format_phone(jid)
        if phone and phone not in (sender_name or ""):
            return f"Note to self ({phone})"
        return (sender_name or "").strip() or "Note to self"
    sender = better_names.get(jid) or sender_name
    phone = phone_number or (_phone_digits(jid) if _is_real_phone_jid(jid) else None)
    resolved = resolve_chat_label(sender, jid, phone, saved_name, notify_name)
    if _is_group_jid(jid) and resolved in {"", jid, jid.split("@")[0]}:
        return "WhatsApp Group"
    return resolved


def _chat_key(message: Message) -> str:
    """Group phone and LID copies of the same 1:1 chat onto one row."""
    if message.phone_number and _is_real_phone_jid(f"{message.phone_number}@s.whatsapp.net"):
        return message.phone_number
    if is_phone_jid(message.sender_jid):
        return _phone_digits(message.sender_jid)
    return message.sender_jid


def _alias_jids(db, jid: str, tenant_jid: str = "guest_unlinked") -> set[str]:
    """sender_jid values that belong to this chat, strictly within this tenant."""
    aliases = {jid}
    if tenant_jid == "guest_unlinked":
        return aliases

    phone = _phone_digits(jid) if _is_real_phone_jid(jid) else ""
    conds = [Message.sender_jid == jid]
    if phone:
        conds.append(Message.phone_number == phone)
        conds.append(Message.sender_jid == f"{phone}@s.whatsapp.net")

    rows = (
        db.query(Message.sender_jid, Message.phone_number)
        .filter(Message.tenant_jid == tenant_jid)
        .filter(or_(*conds))
        .all()
    )
    for sender_jid, phone_number in rows:
        if sender_jid:
            aliases.add(sender_jid)
        if phone_number and _is_real_phone_jid(f"{phone_number}@s.whatsapp.net"):
            aliases.add(f"{phone_number}@s.whatsapp.net")
    return aliases


async def get_inbox_chats(request: Request, tenant_id: str | None = None) -> dict:
    """Inbox list — last real message per chat from the last 10 days (Tenant Isolated)."""
    search = (request.query_params.get("search") or "").strip().lower()
    tenant_jid = tenant_id or _extract_tenant_jid(request)

    # Agar tenant linked nahi hai toh direct empty list return karein
    if tenant_jid == "guest_unlinked":
        return {
            "status": "success",
            "tenant_jid": tenant_jid,
            "total_chats": 0,
            "data": [],
        }

    ten_days_ago = int(time.time()) - TEN_DAYS_SECONDS

    with SessionLocal() as db:
        rows = (
            db.query(Message)
            .filter(Message.tenant_jid == tenant_jid)
            .filter(~Message.sender_jid.like("%@broadcast"))
            .filter(~Message.sender_jid.like("%@newsletter"))
            .filter(Message.timestamp >= ten_days_ago)
            .all()
        )
        grouped: dict[str, list[Message]] = {}
        for row in rows:
            grouped.setdefault(_chat_key(row), []).append(row)

        desk_jids = []
        desk_phones = []
        for messages in grouped.values():
            for row in messages:
                if row.sender_jid:
                    desk_jids.append(row.sender_jid)
                if row.phone_number:
                    desk_phones.append(row.phone_number)
        directory = load_contact_directory(
            db, tenant_jid, jids=desk_jids, phone_numbers=desk_phones
        )
        data = []
        for messages in grouped.values():
            real = [row for row in messages if not is_sync_placeholder(row.message_id)]
            if not real:
                continue
            real.sort(key=lambda row: int(row.timestamp or 0), reverse=True)
            latest = real[0]
            jid = next(
                (row.sender_jid for row in real if is_phone_jid(row.sender_jid) or _is_group_jid(row.sender_jid)),
                latest.sender_jid,
            )
            names = {row.sender_jid: row.sender_name for row in real}
            better = {}
            for row in real:
                usable = _usable_contact_name(row.sender_name, row.sender_jid)
                if usable:
                    better.setdefault(row.sender_jid, usable)
            preview = preview_text(latest.text, latest.media_type)
            phone_number = next((row.phone_number for row in real if row.phone_number), None)
            saved_name, notify_name = lookup_contact_labels(directory, jid, phone_number)
            name = _chat_display_name(
                names.get(jid) or latest.sender_name,
                jid,
                better,
                saved_name,
                notify_name,
                phone_number,
            )
            if search and search not in " ".join(
                filter(None, [name, jid, latest.text, latest.sender_jid])
            ).lower():
                continue
            avatar = next((row.avatar_url for row in real if row.avatar_url), None)
            data.append(
                {
                    "jid": jid,
                    "name": name,
                    "phone": _phone_digits(jid) if _is_real_phone_jid(jid) else None,
                    "is_group": _is_group_jid(jid),
                    "last_message": preview,
                    "last_timestamp": latest.timestamp,
                    "last_message_time": format_last_message_time(latest.timestamp),
                    "is_from_me": latest.is_from_me,
                    "media_type": latest.media_type,
                    "avatar_url": avatar,
                }
            )

        data.sort(key=lambda item: int(item["last_timestamp"] or 0), reverse=True)
        return {
            "status": "success",
            "tenant_jid": tenant_jid,
            "total_chats": len(data),
            "data": data,
        }


def _jid_transcribe_lock(jid: str) -> threading.Lock:
    with _transcribe_guard:
        lock = _transcribe_locks.get(jid)
        if lock is None:
            lock = threading.Lock()
            _transcribe_locks[jid] = lock
        return lock


def _stored_transcript(text: str | None) -> str:
    raw = (text or "").strip()
    lowered = raw.lower()
    if not (
        lowered.startswith("[voice note]:")
        or lowered.startswith("[voice note transcript]:")
    ):
        return ""
    return raw.split(":", 1)[1].strip()


def _transcribe_chat_voice_notes_sync(jid: str, tenant_jid: str = "guest_unlinked") -> dict:
    """Fill missing voice-note transcripts for one chat and persist them (Tenant Scoped)."""
    if tenant_jid == "guest_unlinked":
        return {"status": "success", "updated": [], "failed": [], "remaining": 0}

    lock = _jid_transcribe_lock(f"{tenant_jid}:{jid}")
    with lock:
        updated = []
        failed = []
        remaining = 0
        last_error = ""
        with SessionLocal() as db:
            aliases = _alias_jids(db, jid, tenant_jid=tenant_jid)
            rows = (
                db.query(Message)
                .filter(Message.tenant_jid == tenant_jid)
                .filter(Message.sender_jid.in_(aliases))
                .filter(func.lower(Message.media_type) == "audio")
                .filter(Message.media_path.isnot(None))
                .filter(Message.media_path != "")
                .order_by(desc(Message.timestamp))
                .limit(100)
                .all()
            )
            pending = [row for row in rows if not _stored_transcript(row.text)]
            batch = pending[:_TRANSCRIBE_BATCH]
            for msg in batch:
                transcript = transcribe_audio_file(msg.media_path)
                if not transcript:
                    failed.append(msg.id)
                    last_error = get_last_transcribe_error() or last_error
                    continue
                caption = (msg.text or "").strip()
                caption_l = caption.lower()
                if caption and not (
                    caption_l.startswith("[voice note]:")
                    or caption_l.startswith("[voice note transcript]:")
                ):
                    msg.text = f"[Voice Note Transcript]: {transcript}\n{caption}"
                else:
                    msg.text = f"[Voice Note Transcript]: {transcript}"
                updated.append(
                    {
                        "id": msg.id,
                        "message_id": msg.message_id,
                        "text": msg.text,
                    }
                )
            if updated:
                db.commit()
            remaining = max(0, len(pending) - len(batch))

        err_hint = ""
        if failed and not updated:
            err = last_error or get_last_transcribe_error()
            if "429" in err or "credits" in err.lower():
                err_hint = "openai_credits"
            elif err:
                err_hint = "transcribe_failed"

        return {
            "status": "success",
            "updated": updated,
            "failed": failed,
            "remaining": remaining,
            "error": err_hint or None,
            "error_detail": (last_error or get_last_transcribe_error() or None)
            if failed and not updated
            else None,
        }


async def transcribe_chat_voice_notes(
    jid: str, request: Request = None, tenant_id: str | None = None
) -> dict:
    tenant_jid = tenant_id or (
        _extract_tenant_jid(request) if request else "guest_unlinked"
    )
    return await asyncio.to_thread(_transcribe_chat_voice_notes_sync, jid, tenant_jid)


async def get_chat_conversation(
    jid: str, request: Request, tenant_id: str | None = None
) -> dict:
    """Returns conversation history strictly for the calling tenant."""
    limit = int(request.query_params.get("limit", 100))
    tenant_jid = tenant_id or _extract_tenant_jid(request)

    if tenant_jid == "guest_unlinked":
        return {
            "status": "success",
            "tenant_jid": tenant_jid,
            "jid": jid,
            "contact_name": "Unlinked",
            "phone": None,
            "is_group": _is_group_jid(jid),
            "avatar_url": None,
            "count": 0,
            "data": [],
        }

    with SessionLocal() as db:
        aliases = _alias_jids(db, jid, tenant_jid=tenant_jid)
        messages = (
            db.query(Message)
            .filter(Message.tenant_jid == tenant_jid)
            .filter(Message.sender_jid.in_(aliases))
            .filter(~Message.message_id.like("sync-ph:%"))
            .order_by(Message.timestamp.desc())
            .limit(limit)
            .all()
        )
        messages.reverse()
        jid = next((item for item in aliases if is_phone_jid(item) or _is_group_jid(item)), jid)

        better_names = _better_names_for(db, [jid], tenant_jid=tenant_jid)
        phone_number = next((row.phone_number for row in messages if row.phone_number), None)
        directory = load_contact_directory(
            db,
            tenant_jid,
            jids=list(aliases),
            phone_numbers=[phone_number] if phone_number else None,
        )
        saved_name, notify_name = lookup_contact_labels(directory, jid, phone_number)
        contact_name = _chat_display_name(
            messages[-1].sender_name if messages else None,
            jid,
            better_names,
            saved_name,
            notify_name,
            phone_number,
        )
        avatars = _avatars_for(db, [jid], tenant_jid=tenant_jid)

        # Thin chats: ask WhatsApp for older msgs (async ingest). No OpenAI tokens.
        backfill = {"ok": False, "skipped": True, "reason": "not_needed"}
        if messages:
            try:
                backfill = request_on_demand_history(
                    db, tenant_id=tenant_jid, jid=jid, force=False
                )
            except Exception as exc:
                backfill = {"ok": False, "error": str(exc)}

        return {
            "status": "success",
            "tenant_jid": tenant_jid,
            "jid": jid,
            "contact_name": contact_name,
            "phone": _phone_digits(jid) if _is_real_phone_jid(jid) else None,
            "is_group": _is_group_jid(jid),
            "avatar_url": avatars.get(jid),
            "count": len(messages),
            "history_backfill": backfill,
            "data": [
                {
                    "id": m.id,
                    "message_id": m.message_id,
                    "text": m.text,
                    "is_from_me": m.is_from_me,
                    "is_group": bool(m.is_group) or _is_group_jid(m.sender_jid),
                    "media_type": m.media_type,
                    "media_path": m.media_path,
                    "avatar_url": m.avatar_url,
                    "timestamp": m.timestamp,
                }
                for m in messages
            ],
        }


async def send_chat_message(
    jid: str, request: Request, tenant_id: str | None = None
) -> dict:
    body = await request.json()
    text = body.get("text", "").strip()
    tenant_jid = tenant_id or _extract_tenant_jid(request)

    if tenant_jid == "guest_unlinked":
        raise HTTPException(status_code=401, detail="Active WhatsApp session required to send messages.")

    if not text:
        raise HTTPException(status_code=400, detail="Message text khali nahi ho sakta")

    try:
        resp = requests.post(
            f"{LIVE_WORKER_URL}/send-message",
            json={
                "tenant_id": tenant_jid,
                "recipient_jid": jid,
                "text": text,
            },
            timeout=10,
        )
        if resp.status_code != 200:
            raise HTTPException(
                status_code=502, detail="WhatsApp worker message deliver nahi kar paya"
            )
    except requests.exceptions.RequestException as e:
        raise HTTPException(
            status_code=503, detail=f"Live Worker offline ya unreachable hai: {str(e)}"
        )

    now = int(time.time())
    with SessionLocal() as db:
        new_msg = Message(
            tenant_jid=tenant_jid,
            message_id=f"web_out_{now * 1000}",
            sender_jid=jid,
            sender_name="You",
            is_from_me=True,
            is_group=_is_group_jid(jid),
            timestamp=now,
            text=text,
            media_type=None,
            media_path=None,
        )
        db.add(new_msg)
        db.commit()

    return {
        "status": "success",
        "tenant_jid": tenant_jid,
        "message": "Message sent successfully",
        "text": text,
    }