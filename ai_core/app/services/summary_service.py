import json
import time
from datetime import datetime

from sqlalchemy.orm import Session

from app.config.rules_knowledge_base import INBOX_SUMMARY_PROMPT
from app.models.message import Message
from app.models.summary import ChatSummary
from app.services.multimodal_service import _get_client

TEN_DAYS_SECONDS = 10 * 24 * 60 * 60
VALID_BALL_IN_COURT = {"USER", "COUNTERPARTY", "BLOCKED_EXTERNAL"}


def _as_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _parse_key_points(raw) -> list:
    if isinstance(raw, list):
        return [_as_text(item) for item in raw if _as_text(item)]
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [_as_text(item) for item in parsed if _as_text(item)]
        except Exception:
            text = _as_text(raw)
            return [text] if text else []
    return []


def _serialize_key_points(points) -> str:
    return json.dumps(_parse_key_points(points), ensure_ascii=False)


def _format_thread(messages: list, contact_name: str) -> str:
    lines = []
    for msg in messages:
        sender = "You" if getattr(msg, "is_from_me", False) else (contact_name or "Contact")
        body = _as_text(getattr(msg, "text", "") or "")
        media = _as_text(getattr(msg, "media_type", "") or "")
        if not body and media:
            body = f"[{media}]"
        if body:
            lines.append(f"{sender}: {body}")
    return "\n".join(lines)


def _normalize_ball_in_court(raw) -> str:
    ball = _as_text(raw).upper().replace(" ", "_").replace("-", "_")
    return ball if ball in VALID_BALL_IN_COURT else ""


def _call_gpt(
    contact_name: str,
    conversation: str,
    prior_summary: str | None = None,
    system_prompt: str | None = None,
) -> dict:
    client = _get_client()
    if client is None:
        return {}

    chat_text = conversation
    if prior_summary:
        chat_text = f"{conversation}\n\nPrior brief to refresh:\n{prior_summary}"

    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system_prompt or INBOX_SUMMARY_PROMPT},
                {
                    "role": "user",
                    "content": f"Chat with {contact_name} over the last 10 days:\n\n{chat_text}",
                },
            ],
            temperature=0.2,
        )
        choices = getattr(response, "choices", None) or []
        if not choices or not getattr(choices[0], "message", None):
            return {}
        content = choices[0].message.content or ""
        parsed = json.loads(content)
        if not isinstance(parsed, dict):
            return {}
        summary = _as_text(parsed.get("summary") or parsed.get("summary_text"))
        key_points = _parse_key_points(parsed.get("key_points") or parsed.get("takeaways"))
        ball_in_court = _normalize_ball_in_court(parsed.get("ball_in_court"))
        if not summary:
            return {}
        return {
            "summary": summary,
            "summary_text": summary,
            "ball_in_court": ball_in_court,
            "key_points": key_points,
        }
    except Exception as e:
        print(f"[Summary Error] GPT failed for {contact_name}: {e}")
        return {}


def _messages_for_tenant(query, tenant_jid: str | None):
    if tenant_jid:
        return query.filter(Message.tenant_jid == tenant_jid)
    return query


def get_window_messages(
    db: Session,
    jid: str,
    since_ts: int | None = None,
    tenant_jid: str | None = None,
) -> list:
    """Messages for this chat in the 10-day window (optionally only after since_ts)."""
    cutoff = int(time.time()) - TEN_DAYS_SECONDS
    lower = max(cutoff, int(since_ts or 0))
    query = _messages_for_tenant(
        db.query(Message)
        .filter(Message.sender_jid == jid)
        .filter(Message.timestamp >= cutoff),
        tenant_jid,
    )
    if since_ts is not None:
        query = query.filter(Message.timestamp > lower)
    return query.order_by(Message.timestamp.asc()).all()


def count_newer_messages(
    db: Session,
    jid: str,
    after_ts: int | None,
    after_msg_id: str | None,
    tenant_jid: str | None = None,
) -> int:
    if after_ts is None and not after_msg_id:
        return 0
    query = _messages_for_tenant(
        db.query(Message).filter(Message.sender_jid == jid),
        tenant_jid,
    )
    if after_ts is not None:
        query = query.filter(Message.timestamp > int(after_ts))
    elif after_msg_id:
        anchor = _messages_for_tenant(
            db.query(Message).filter(Message.message_id == after_msg_id),
            tenant_jid,
        ).first()
        if anchor is None:
            return 0
        query = query.filter(Message.timestamp > anchor.timestamp)
    return int(query.count() or 0)


def latest_message(db: Session, jid: str, tenant_jid: str | None = None) -> Message | None:
    return (
        _messages_for_tenant(
            db.query(Message).filter(Message.sender_jid == jid),
            tenant_jid,
        )
        .order_by(Message.timestamp.desc(), Message.id.desc())
        .first()
    )


def summary_to_dict(row: ChatSummary, *, is_dirty: bool = False, new_messages_count: int = 0) -> dict:
    return {
        "status": "ready",
        "sender_jid": row.sender_jid,
        "contact_name": row.contact_name,
        "summary": row.summary_text or "",
        "summary_text": row.summary_text or "",
        "ball_in_court": row.ball_in_court or "",
        "key_points": _parse_key_points(row.key_points),
        "last_summarized_msg_id": row.last_summarized_msg_id,
        "last_summarized_timestamp": row.last_summarized_timestamp,
        "is_stale": bool(row.is_stale),
        "is_dirty": bool(is_dirty),
        "new_messages_count": int(new_messages_count or 0),
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def generate_or_refresh_summary(
    db: Session,
    jid: str,
    contact_name: str | None = None,
    system_prompt: str | None = None,
    tenant_jid: str | None = None,
) -> dict:
    """Full 10-day generate, or delta-refresh when a cached summary already exists."""
    summary_query = db.query(ChatSummary).filter(ChatSummary.sender_jid == jid)
    if tenant_jid:
        summary_query = summary_query.filter(ChatSummary.tenant_jid == tenant_jid)
    existing = summary_query.first()
    latest = latest_message(db, jid, tenant_jid=tenant_jid)
    name = (
        _as_text(contact_name)
        or (existing.contact_name if existing else None)
        or (getattr(latest, "sender_name", None) if latest else None)
        or "Unknown"
    )

    if existing and existing.last_summarized_timestamp is not None:
        delta = get_window_messages(
            db,
            jid,
            since_ts=existing.last_summarized_timestamp,
            tenant_jid=tenant_jid,
        )
        if not delta:
            # Nothing new — just clear stale and return cache
            existing.is_stale = False
            existing.updated_at = datetime.utcnow()
            db.commit()
            db.refresh(existing)
            return summary_to_dict(existing, is_dirty=False, new_messages_count=0)

        prior = (
            f"{existing.summary_text}\n"
            + "\n".join(f"- {p}" for p in _parse_key_points(existing.key_points))
        ).strip()
        conversation = _format_thread(delta, name)
        result = _call_gpt(name, conversation, prior_summary=prior, system_prompt=system_prompt)
        messages_for_anchor = delta
    else:
        window = get_window_messages(db, jid, tenant_jid=tenant_jid)
        if not window:
            raise ValueError("No messages in the last 10 days to summarize")
        conversation = _format_thread(window, name)
        result = _call_gpt(name, conversation, system_prompt=system_prompt)
        messages_for_anchor = window

    if not result:
        raise RuntimeError("Summary generation failed")

    anchor = messages_for_anchor[-1]
    # Prefer absolute latest in chat for the watermark
    if latest is not None:
        anchor = latest

    if existing is None:
        existing = ChatSummary(sender_jid=jid, tenant_jid=tenant_jid or "default")
        db.add(existing)

    existing.contact_name = name
    existing.summary_text = result["summary"]
    existing.ball_in_court = result.get("ball_in_court") or ""
    existing.key_points = _serialize_key_points(result["key_points"])
    existing.last_summarized_msg_id = getattr(anchor, "message_id", None)
    existing.last_summarized_timestamp = getattr(anchor, "timestamp", None)
    existing.is_stale = False
    existing.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(existing)
    return summary_to_dict(existing, is_dirty=False, new_messages_count=0)
