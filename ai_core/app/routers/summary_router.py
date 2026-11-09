from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.services.firebase_auth import verified_tenant_id

from app.config.rules_knowledge_base import INBOX_SUMMARY_PROMPT
from app.models.database import get_db
from app.models.summary import ChatSummary
from app.services.summary_service import (
    count_newer_messages,
    generate_or_refresh_summary,
    latest_message,
    summary_to_dict,
)

router = APIRouter(prefix="/api/v1/summary", tags=["Chat Summary"])


@router.get("/{jid:path}")
def get_chat_summary(jid: str, request: Request, db: Session = Depends(get_db)):
    """
    Return cached 10-day summary for a chat.
    If missing → { status: 'not_generated' }.
    If newer messages exist since last summarize → is_dirty + new_messages_count.
    """
    jid = (jid or "").strip()
    if not jid:
        raise HTTPException(status_code=400, detail="jid is required")

    tenant_id = verified_tenant_id(request)
    row = (
        db.query(ChatSummary)
        .filter(ChatSummary.sender_jid == jid, ChatSummary.tenant_jid == tenant_id)
        .first()
    )
    if row is None:
        return {"status": "not_generated"}

    newer_count = count_newer_messages(
        db,
        jid,
        after_ts=row.last_summarized_timestamp,
        after_msg_id=row.last_summarized_msg_id,
        tenant_jid=tenant_id,
    )
    # Also treat a newer absolute latest message id as dirty
    latest = latest_message(db, jid, tenant_jid=tenant_id)
    if (
        newer_count == 0
        and latest is not None
        and row.last_summarized_msg_id
        and latest.message_id
        and latest.message_id != row.last_summarized_msg_id
        and (latest.timestamp or 0) >= (row.last_summarized_timestamp or 0)
    ):
        newer_count = count_newer_messages(
            db,
            jid,
            after_ts=row.last_summarized_timestamp,
            after_msg_id=None,
            tenant_jid=tenant_id,
        )
        if newer_count == 0:
            newer_count = 1

    is_dirty = newer_count > 0
    if is_dirty and not row.is_stale:
        row.is_stale = True
        row.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(row)

    return summary_to_dict(row, is_dirty=is_dirty, new_messages_count=newer_count)


@router.post("/{jid:path}/generate")
def generate_chat_summary(jid: str, request: Request, db: Session = Depends(get_db)):
    """Generate or delta-refresh the 10-day GPT-4o summary and persist watermarks."""
    jid = (jid or "").strip()
    if not jid:
        raise HTTPException(status_code=400, detail="jid is required")

    tenant_id = verified_tenant_id(request)
    latest = latest_message(db, jid, tenant_jid=tenant_id)
    contact_name = getattr(latest, "sender_name", None) if latest else None

    try:
        return generate_or_refresh_summary(
            db,
            jid,
            contact_name=contact_name,
            system_prompt=INBOX_SUMMARY_PROMPT,
            tenant_jid=tenant_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Summary generation failed: {e}") from e
