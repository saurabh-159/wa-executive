import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Optional
import requests
from fastapi import Request, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.models.database import SessionLocal
from app.models.matter import Matter, NextStep, DraftOption, TimelineEvent
from app.models.message import Message
from app.services.chat_isolation import (
    fetch_isolated_messages,
    is_broadcast_lane,
    should_skip_needs_you_card,
)
from app.services.matter_ai_service import synthesize_matter_from_chat
from app.services.matter_db_service import save_or_update_matter

LIVE_WORKER_URL = os.getenv("LIVE_WORKER_URL", "http://127.0.0.1:5001")
TEN_DAYS_SECONDS = 10 * 24 * 60 * 60

ACTION_PATTERNS = [
    r"\?",
    r"\b(kab|kahan|kyun|kaise|kya|bhai)\b",
    r"\b(bhej|send|share|de do|check|dekho|karo|batao|chahiye|dekhna)\b",
    r"\b(urgent|jaldi|call|error|issue|problem|down|bug|block)\b",
    r"\b(payment|invoice|bill|amount|rupaye|rs|paid|pay|transfer)\b",
    r"\b(kal|aaj|deadline|deliver|meeting|connect|meet)\b",
]
ACTION_REGEX = re.compile("|".join(ACTION_PATTERNS), re.IGNORECASE)

CASUAL_ONLY = {
    "ok", "okay", "haa", "ha", "theek hai", "thik hai",
    "done", "thanks", "thank you", "bye", "gm", "good morning", "gn",
}

PENDING_ACK = {
    "ok", "okay", "okk", "okkk", "haa", "ha", "haan",
    "theek hai", "thik hai", "theek", "thik", "alright", "sure",
}

COMPLETION_PATTERNS = [
    r"\b(done|paid|bhej diya|sent|ho gaya|kar diya|check karo|shared|completed)\b",
]
COMPLETION_REGEX = re.compile("|".join(COMPLETION_PATTERNS), re.IGNORECASE)

STITCH_WINDOW = 6


def _extract_tenant_jid(request: Request) -> str:
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

    return "guest_unlinked"


def _msg_text(msg) -> str:
    text = (getattr(msg, "text", None) or "").strip()
    if text:
        return text
    media_type = getattr(msg, "media_type", None)
    if media_type == "audio":
        return "[Voice Note]"
    if media_type == "image":
        return "[Photo]"
    return ""


def _stitch_same_sender(messages: list, count: int = STITCH_WINDOW) -> str:
    if not messages:
        return ""
    window = messages[-count:]
    last_from_me = bool(window[-1].is_from_me)
    parts = []
    for msg in reversed(window):
        if bool(msg.is_from_me) != last_from_me:
            break
        text = _msg_text(msg)
        if text:
            parts.append(text)
    parts.reverse()
    return " ".join(parts).strip()


def _peer_burst_before_user(messages: list) -> str:
    if not messages:
        return ""
    i = len(messages) - 1
    while i >= 0 and messages[i].is_from_me:
        i -= 1
    if i < 0:
        return ""
    parts = []
    while i >= 0 and not messages[i].is_from_me and len(parts) < STITCH_WINDOW:
        text = _msg_text(messages[i])
        if text:
            parts.append(text)
        i -= 1
    parts.reverse()
    return " ".join(parts).strip()


def is_chat_actionable(messages: list) -> bool:
    if not messages:
        return False

    last_msg = messages[-1]
    last_text = _msg_text(last_msg).lower()
    stitched = _stitch_same_sender(messages, STITCH_WINDOW).lower()
    eval_text = stitched or last_text

    if not last_msg.is_from_me:
        if getattr(last_msg, "media_type", None) in {"audio", "image"}:
            return True
        if ACTION_REGEX.search(eval_text) and eval_text not in CASUAL_ONLY:
            return True
        return False

    peer_burst = _peer_burst_before_user(messages).lower()

    if (last_text in PENDING_ACK or eval_text in PENDING_ACK) and peer_burst:
        if ACTION_REGEX.search(peer_burst) or "[voice note]" in peer_burst or "[photo]" in peer_burst:
            return True

    if peer_burst and ACTION_REGEX.search(peer_burst):
        return True

    if COMPLETION_REGEX.search(eval_text):
        return True

    return False


def get_desk_matters(db: Session, tenant_jid: str = "default", status_filter: str = None, search: str = None):
    query = (
        db.query(Matter)
        .filter(Matter.tenant_jid == tenant_jid)
        .order_by(Matter.last_activity_at.desc())
    )

    if status_filter and status_filter.upper() != "ALL":
        query = query.filter(Matter.status == status_filter.upper())

    if search:
        search_pattern = f"%{search}%"
        query = query.filter(
            (Matter.title.ilike(search_pattern)) |
            (Matter.contact_name.ilike(search_pattern)) |
            (Matter.summary.ilike(search_pattern))
        )

    return query.all()


def _date_label(ts) -> str:
    try:
        stamp = int(ts or 0)
        if stamp > 10**12:
            stamp = stamp // 1000
        if stamp <= 0:
            return "Recent"
        dt = datetime.fromtimestamp(stamp, tz=timezone(timedelta(hours=5, minutes=30)))
        return dt.strftime("%d %b").lstrip("0")
    except Exception:
        return "Recent"


def _park_announcement_matter(db: Session, chat_id: str, name: str, messages: list, tenant_jid: str = "default") -> None:
    matter = (
        db.query(Matter)
        .filter(Matter.tenant_jid == tenant_jid, Matter.sender_jid == chat_id)
        .order_by(Matter.id.desc())
        .first()
    )
    if matter is None:
        return

    summary = (matter.summary or "").strip()
    needs_fix = matter.status == "NEEDS_YOU" or not summary
    if not needs_fix:
        return

    display = (name or matter.contact_name or "This group").strip()
    matter.status = "WAITING"
    matter.summary = f"{display} posted a group update. Nobody asked you directly."
    matter.situation = "This is a broadcast. It stays off Needs you unless you are mentioned."
    db.query(NextStep).filter(NextStep.matter_id == matter.id).delete()
    db.query(DraftOption).filter(DraftOption.matter_id == matter.id).delete()
    db.query(TimelineEvent).filter(TimelineEvent.matter_id == matter.id).delete()

    for msg in (messages or [])[-4:]:
        if getattr(msg, "is_from_me", False):
            continue
        text = " ".join(_msg_text(msg).split())
        if not text:
            continue
        db.add(
            TimelineEvent(
                matter_id=matter.id,
                date_label=_date_label(getattr(msg, "timestamp", 0)),
                event_description=text[:160],
            )
        )
    db.commit()


def _synthesize_one_jid(
    db: Session,
    jid: str,
    name: str = None,
    tenant_jid: str = "default",
    *,
    require_actionable: bool = True,
) -> bool:
    chat_id = str(jid or "").strip()
    if is_broadcast_lane(chat_id):
        _park_announcement_matter(db, chat_id, name or chat_id.split("@")[0], [], tenant_jid=tenant_jid)
        return False

    chat_msgs = fetch_isolated_messages(db, chat_id, limit=12, tenant_jid=tenant_jid)
    if not chat_msgs:
        return False

    contact_display = name or (chat_msgs[-1].sender_name if chat_msgs else None) or chat_id.split("@")[0]

    if should_skip_needs_you_card(chat_id, contact_display, chat_msgs):
        if require_actionable:
            _park_announcement_matter(db, chat_id, contact_display, chat_msgs, tenant_jid=tenant_jid)
            return False

    if require_actionable and not is_chat_actionable(chat_msgs):
        return False

    try:
        ai_data = synthesize_matter_from_chat(chat_msgs, contact_display, chat_jid=chat_id)
        if ai_data and ai_data.get("title"):
            last = chat_msgs[-1] if chat_msgs else None
            last_text = _msg_text(last).lower() if last else ""
            stitched = _stitch_same_sender(chat_msgs, STITCH_WINDOW).lower()
            eval_text = stitched or last_text
            announcement = should_skip_needs_you_card(chat_id, contact_display, chat_msgs)

            if last and last.is_from_me and COMPLETION_REGEX.search(eval_text):
                ai_data["status"] = "DONE"
            elif announcement:
                ai_data["status"] = "WAITING"
                ai_data["triage_status"] = "WAITING"
            elif last and last.is_from_me and (last_text in PENDING_ACK or eval_text in PENDING_ACK):
                ai_data["status"] = "NEEDS_YOU"

            if not ai_data.get("summary") and ai_data.get("core_problem"):
                ai_data["summary"] = ai_data["core_problem"]

            save_or_update_matter(
                db=db,
                sender_jid=chat_id,
                contact_name=contact_display,
                ai_data=ai_data,
                tenant_jid=tenant_jid,
            )
            print(f"[Matters Controller ({tenant_jid})] Created matter for: {contact_display}")
            return True
    except Exception as e:
        print(f"[Matters Controller Error] Failed on {jid}: {e}")
    return False


def _park_existing_broadcasts(db: Session, tenant_jid: str = "default") -> None:
    rows = (
        db.query(Matter)
        .filter(Matter.tenant_jid == tenant_jid, Matter.status == "NEEDS_YOU")
        .all()
    )
    for matter in rows:
        chat_id = str(matter.sender_jid or "").strip()
        if not chat_id:
            continue
        if is_broadcast_lane(chat_id):
            _park_announcement_matter(db, chat_id, matter.contact_name or "", [], tenant_jid=tenant_jid)
            continue
        messages = fetch_isolated_messages(db, chat_id, limit=12, tenant_jid=tenant_jid)
        if messages and should_skip_needs_you_card(chat_id, matter.contact_name or "", messages):
            _park_announcement_matter(db, chat_id, matter.contact_name or "", messages, tenant_jid=tenant_jid)


def process_actionable_matters_in_background(
    max_chats: int = 20,
    target_jid: str = None,
    tenant_jid: str = "guest_unlinked",
):
    """
    CRITICAL FIX: Background processing ONLY synthesizes chats where Message.is_monitored == True
    """
    if not tenant_jid or tenant_jid.startswith("guest_"):
        print(f"[Matters Controller] Skipping background synthesis for unlinked session: {tenant_jid}")
        return

    print(f"[Matters Controller ({tenant_jid})] Starting synthesis for MONITORED chats...")
    with SessionLocal() as db:
        processed_count = 0
        seen = set()
        _park_existing_broadcasts(db, tenant_jid=tenant_jid)

        if target_jid:
            seen.add(target_jid)
            if _synthesize_one_jid(db, target_jid, tenant_jid=tenant_jid):
                processed_count += 1
            time.sleep(0.4)

        ten_days_ago = int(time.time()) - TEN_DAYS_SECONDS

        recent_jids = (
            db.query(Message.sender_jid, func.max(Message.sender_name))
            .filter(Message.tenant_jid == tenant_jid)
            .filter(Message.is_monitored == True)  # noqa: E712
            .filter(Message.timestamp >= ten_days_ago)
            .filter(~Message.sender_jid.like("%@broadcast"))
            .filter(~Message.sender_jid.like("%@newsletter"))
            .group_by(Message.sender_jid)
            .order_by(func.max(Message.timestamp).desc())
            .limit(max_chats)
            .all()
        )

        for jid, name in recent_jids:
            if jid in seen:
                continue
            seen.add(jid)

            if _synthesize_one_jid(db, jid, name, tenant_jid=tenant_jid, require_actionable=True):
                processed_count += 1

            time.sleep(0.4)

        print(f"[Matters Controller ({tenant_jid})] Completed. Matters generated: {processed_count}")

def generate_matters_from_recent_history(db: Session, max_chats: int = 10, tenant_jid: str = "default"):
    process_actionable_matters_in_background(max_chats=max_chats, tenant_jid=tenant_jid)
    return {"status": "success", "message": "Matters generation finished"}


def process_selected_jids_in_background(selected_jids: list[str] | None = None, tenant_jid: str = "default"):
    jids = [str(j).strip() for j in (selected_jids or []) if j and str(j).strip()]
    print(f"[Matters Controller ({tenant_jid})] Processing {len(jids)} selected contact(s)...")
    with SessionLocal() as db:
        processed_count = 0
        for jid in jids:
            if _synthesize_one_jid(db, jid, tenant_jid=tenant_jid, require_actionable=False):
                processed_count += 1
            time.sleep(0.4)
        print(f"[Matters Controller ({tenant_jid})] Selected run done. Generated: {processed_count}")
    return processed_count


def process_monitored_matters_in_background(max_chats: int = 40, tenant_jid: str = "default"):
    print(f"[Matters Controller ({tenant_jid})] Processing monitored contacts...")
    with SessionLocal() as db:
        rows = (
            db.query(Message.sender_jid, func.max(Message.sender_name))
            .filter(Message.tenant_jid == tenant_jid)
            .filter(Message.is_monitored == True)  # noqa: E712
            .filter(~Message.sender_jid.like("%@broadcast"))
            .filter(~Message.sender_jid.like("%@newsletter"))
            .group_by(Message.sender_jid)
            .order_by(func.max(Message.timestamp).desc())
            .limit(max_chats)
            .all()
        )
        processed_count = 0
        for jid, name in rows:
            if _synthesize_one_jid(db, jid, name, tenant_jid=tenant_jid, require_actionable=False):
                processed_count += 1
            time.sleep(0.4)
        print(f"[Matters Controller ({tenant_jid})] Monitored run done. Generated: {processed_count}")
    return processed_count


# 1. LEFT PANEL: Saare matters list karna (Tenant Isolated)
# 1. LEFT PANEL: Saare matters list karna (Tenant Isolated)
async def get_matters_feed(request: Request, tenant_id: Optional[str] = None) -> dict:
    status_filter = request.query_params.get("status")
    search_query = request.query_params.get("search")
    
    # Priority: Dependency-injected tenant_id -> Request headers/query
    resolved_tenant = tenant_id or _extract_tenant_jid(request) or "default"
    # Firebase UID sanitize (alphanumeric + _ + -)
    clean_tenant = "".join(c for c in resolved_tenant.strip() if c.isalnum() or c in ("_", "-")) or "default"

    with SessionLocal() as db:
        query = db.query(Matter).filter(Matter.tenant_jid == clean_tenant)

        if status_filter and status_filter.upper() != "ALL":
            query = query.filter(Matter.status == status_filter.upper())

        if search_query:
            query = query.filter(
                (Matter.title.ilike(f"%{search_query}%")) |
                (Matter.contact_name.ilike(f"%{search_query}%"))
            )

        matters = query.order_by(Matter.last_activity_at.desc()).all()

        jids = [m.sender_jid for m in matters if m.sender_jid]
        avatar_by_jid = {}
        if jids:
            rows = (
                db.query(Message.sender_jid, Message.avatar_url, Message.timestamp)
                .filter(Message.tenant_jid == clean_tenant)
                .filter(Message.sender_jid.in_(jids))
                .filter(Message.avatar_url.isnot(None))
                .filter(Message.avatar_url != "")
                .order_by(Message.timestamp.desc())
                .all()
            )
            for jid, url, _ts in rows:
                if jid not in avatar_by_jid and url:
                    avatar_by_jid[jid] = url

        needs_you_count = (
            db.query(Matter)
            .filter(Matter.tenant_jid == clean_tenant, Matter.status == "NEEDS_YOU")
            .count()
        )
        waiting_count = (
            db.query(Matter)
            .filter(Matter.tenant_jid == clean_tenant, Matter.status == "WAITING")
            .count()
        )
        done_count = (
            db.query(Matter)
            .filter(Matter.tenant_jid == clean_tenant, Matter.status == "DONE")
            .count()
        )

        data_items = []
        for m in matters:
            headline_text = m.summary or m.situation or m.title or ""
            data_items.append({
                "id": m.id,
                "tenant_jid": m.tenant_jid,
                "sender_jid": m.sender_jid,
                "contact_name": m.contact_name,
                "title": m.title,
                "status": m.status,
                "summary": headline_text,
                "headline": headline_text,
                "situation": m.situation or "",
                "core_problem": headline_text,
                "last_activity_at": m.last_activity_at.isoformat() if m.last_activity_at else None,
                "avatar_url": avatar_by_jid.get(m.sender_jid),
            })

        return {
            "status": "success",
            "tenant_jid": clean_tenant,
            "stats": {
                "needs_you": needs_you_count,
                "waiting": waiting_count,
                "done": done_count,
                "total": len(matters)
            },
            "data": data_items
        }


# 2. CENTER PANEL: Selected Matter ki complete details fetch karna
async def get_matter_details(
    matter_id: int, 
    request: Optional[Request] = None, 
    tenant_id: Optional[str] = None
) -> dict:
    resolved_tenant = tenant_id or (_extract_tenant_jid(request) if request else None)
    clean_tenant = None
    if resolved_tenant:
        clean_tenant = "".join(c for c in resolved_tenant.strip() if c.isalnum() or c in ("_", "-")) or None

    with SessionLocal() as db:
        query = db.query(Matter).filter(Matter.id == matter_id)
        if clean_tenant:
            query = query.filter(Matter.tenant_jid == clean_tenant)

        matter = query.first()
        if not matter:
            raise HTTPException(status_code=404, detail="Matter nahi mila")

        next_steps = db.query(NextStep).filter(NextStep.matter_id == matter_id).all()
        draft_options = db.query(DraftOption).filter(DraftOption.matter_id == matter_id).all()
        timeline_events = (
            db.query(TimelineEvent)
            .filter(TimelineEvent.matter_id == matter_id)
            .order_by(TimelineEvent.id.asc())
            .all()
        )

        avatar_url = None
        if matter.sender_jid:
            avatar_row = (
                db.query(Message.avatar_url)
                .filter(Message.tenant_jid == matter.tenant_jid)
                .filter(Message.sender_jid == matter.sender_jid)
                .filter(Message.avatar_url.isnot(None))
                .filter(Message.avatar_url != "")
                .order_by(Message.timestamp.desc())
                .first()
            )
            if avatar_row:
                avatar_url = avatar_row[0]

        headline_text = matter.summary or matter.situation or matter.title or "Ongoing conversation"

        return {
            "status": "success",
            "data": {
                "id": matter.id,
                "tenant_jid": matter.tenant_jid,
                "sender_jid": matter.sender_jid,
                "contact_name": matter.contact_name,
                "title": matter.title,
                "status": matter.status,
                "summary": headline_text,
                "headline": headline_text,
                "situation": matter.situation or headline_text,
                "core_problem": headline_text,
                "avatar_url": avatar_url,
                "next_steps": [
                    {
                        "id": s.id,
                        "step_text": s.step_text,
                        "is_completed": s.is_completed,
                    }
                    for s in next_steps
                ],
                "draft_options": [
                    {
                        "id": d.id,
                        "action_label": d.action_label,
                        "draft_text": d.draft_text,
                        "action_type": d.action_type,
                        "is_used": d.is_used,
                    }
                    for d in draft_options
                ],
                "timeline_events": [
                    {
                        "id": t.id,
                        "date_label": t.date_label,
                        "event_description": t.event_description,
                    }
                    for t in timeline_events
                ],
            },
        }

# 3. RIGHT PANEL: Raw WhatsApp chat history
async def get_matter_raw_chat(
    matter_id: int,
    request: Request,
    tenant_id: Optional[str] = None,
) -> dict:
    limit = int(request.query_params.get("limit", 50))
    tenant_jid = tenant_id or _extract_tenant_jid(request)

    with SessionLocal() as db:
        query = db.query(Matter).filter(Matter.id == matter_id)
        if tenant_jid:
            query = query.filter(Matter.tenant_jid == tenant_jid)

        matter = query.first()
        if not matter:
            raise HTTPException(status_code=404, detail="Matter nahi mila")

        messages = fetch_isolated_messages(
            db,
            matter.sender_jid,
            limit=limit,
            tenant_jid=matter.tenant_jid,
        )

        avatar_url = None
        for msg in reversed(messages):
            if msg.avatar_url:
                avatar_url = msg.avatar_url
                break

        return {
            "status": "success",
            "tenant_jid": matter.tenant_jid,
            "contact_name": matter.contact_name,
            "sender_jid": matter.sender_jid,
            "avatar_url": avatar_url,
            "count": len(messages),
            "data": [
                {
                    "id": msg.id,
                    "message_id": msg.message_id,
                    "text": msg.text,
                    "is_from_me": msg.is_from_me,
                    "media_type": msg.media_type,
                    "media_path": msg.media_path,
                    "avatar_url": msg.avatar_url,
                    "timestamp": msg.timestamp,
                }
                for msg in messages
            ],
        }

# 4. ACTION 1: Quick Draft WhatsApp par send karna (Tenant Isolated Outbox)
async def send_draft_reply(
    matter_id: int,
    request: Request,
    tenant_id: Optional[str] = None,
) -> dict:
    body = await request.json()
    draft_id = body.get("draft_id")
    custom_text = body.get("custom_text")
    tenant_jid = tenant_id or _extract_tenant_jid(request)

    with SessionLocal() as db:
        query = db.query(Matter).filter(Matter.id == matter_id)
        if tenant_jid and tenant_jid != "default":
            query = query.filter(Matter.tenant_jid == tenant_jid)

        matter = query.first()
        if not matter:
            raise HTTPException(status_code=404, detail="Matter nahi mila")

        text_to_send = ""
        if custom_text:
            text_to_send = custom_text
        elif draft_id:
            draft = db.query(DraftOption).filter(DraftOption.id == draft_id).first()
            if draft:
                text_to_send = draft.draft_text
                draft.is_used = True

        if not text_to_send:
            raise HTTPException(status_code=400, detail="Bhejne ke liye koi text nahi mila")

        try:
            resp = requests.post(
                f"{LIVE_WORKER_URL}/send-message",
                json={
                    "tenant_jid": matter.tenant_jid,
                    "recipient_jid": matter.sender_jid,
                    "text": text_to_send,
                },
                timeout=10,
            )
            if resp.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail="WhatsApp worker se message deliver nahi hua",
                )
        except HTTPException:
            raise
        except requests.exceptions.RequestException as e:
            raise HTTPException(
                status_code=503,
                detail=f"Live Worker offline ya unreachable hai: {e}",
            )

        matter.status = "WAITING"
        now_ts = int(time.time())
        db.add(
            Message(
                tenant_jid=matter.tenant_jid,
                message_id=f"draft_out_{now_ts}_{matter_id}",
                sender_jid=matter.sender_jid,
                sender_name="You",
                is_from_me=True,
                timestamp=now_ts,
                text=text_to_send,
                media_type=None,
                media_path=None,
            )
        )
        db.commit()

        return {
            "status": "success",
            "tenant_jid": matter.tenant_jid,
            "message": "Reply WhatsApp par successfully send ho gaya",
            "sent_text": text_to_send,
        }


# 5. ACTION 2: Next step checkbox toggle karna
async def toggle_next_step(step_id: int, tenant_id: Optional[str] = None) -> dict:
    with SessionLocal() as db:
        step = db.query(NextStep).filter(NextStep.id == step_id).first()
        if not step:
            raise HTTPException(status_code=404, detail="Step nahi mila")

        step.is_completed = not step.is_completed
        db.commit()

        return {
            "status": "success",
            "step_id": step.id,
            "is_completed": step.is_completed
        }