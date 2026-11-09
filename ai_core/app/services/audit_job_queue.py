"""Shared helpers to enqueue ChatAuditJob rows and kick the worker pool."""

from __future__ import annotations

from datetime import datetime
from typing import Sequence

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.chat_audit_job import ChatAuditJob
from app.models.message import Message


def upsert_audit_jobs(
    db: Session,
    tenant_id: str,
    contacts: Sequence[dict],
) -> int:
    """
    Upsert PENDING ChatAuditJob rows for the given contacts.
    Each contact dict: {jid, name?, is_group?/isGroup?}
    Returns number of jobs queued/reset to PENDING.
    """
    queued = 0
    for raw in contacts:
        jid = str((raw or {}).get("jid") or "").strip()
        if not jid:
            continue
        name = (
            str((raw or {}).get("name") or (raw or {}).get("chat_name") or "").strip()
            or jid.split("@")[0]
            or "Unknown Contact"
        )
        is_group = bool(
            (raw or {}).get("isGroup")
            if "isGroup" in (raw or {})
            else (raw or {}).get("is_group", jid.endswith("@g.us"))
        )

        existing = (
            db.query(ChatAuditJob)
            .filter(ChatAuditJob.tenant_id == tenant_id, ChatAuditJob.jid == jid)
            .first()
        )
        if existing:
            # Don't interrupt an in-flight job; only re-queue idle/failed/done
            if existing.status in {
                "PENDING",
                "COMPLETED",
                "COMPLETED_NO_ACTION",
                "FAILED",
            }:
                # FAILED retries must re-run OpenAI even if message count is unchanged.
                # COMPLETED* rows keep total_raw_messages so audit_worker can dedupe.
                if existing.status == "FAILED":
                    existing.total_raw_messages = 0
                existing.status = "PENDING"
                existing.chat_name = name
                existing.is_group = is_group
                existing.error_message = None
                existing.updated_at = datetime.utcnow()
                queued += 1
        else:
            db.add(
                ChatAuditJob(
                    tenant_id=tenant_id,
                    jid=jid,
                    chat_name=name,
                    is_group=is_group,
                    status="PENDING",
                )
            )
            queued += 1

    if queued:
        db.commit()
    return queued


def monitored_contacts_for_tenant(db: Session, tenant_id: str) -> list[dict]:
    """Distinct monitored sender JIDs with best-effort display names."""
    rows = (
        db.query(
            Message.sender_jid,
            func.max(Message.sender_name).label("sender_name"),
        )
        .filter(
            Message.tenant_jid == tenant_id,
            Message.is_monitored == True,  # noqa: E712
            Message.sender_jid.isnot(None),
            Message.sender_jid != "",
        )
        .group_by(Message.sender_jid)
        .all()
    )
    contacts: list[dict] = []
    for jid, name in rows:
        jid_s = str(jid or "").strip()
        if not jid_s:
            continue
        contacts.append(
            {
                "jid": jid_s,
                "name": (name or "").strip() or jid_s.split("@")[0] or "Unknown Contact",
                "is_group": jid_s.endswith("@g.us"),
            }
        )
    return contacts


def queue_monitored_audit_jobs(db: Session, tenant_id: str) -> int:
    contacts = monitored_contacts_for_tenant(db, tenant_id)
    return upsert_audit_jobs(db, tenant_id, contacts)


def queue_chat_audit_job(
    db: Session,
    tenant_id: str,
    jid: str,
    *,
    chat_name: str | None = None,
    is_group: bool | None = None,
    status: str = "PENDING",
) -> int:
    """
    Enqueue (or reset to PENDING) a single ChatAuditJob for one chat.
    `status` is accepted for API clarity; queued rows always land as PENDING
    so the audit worker can pick them up.
    """
    jid_s = str(jid or "").strip()
    if not jid_s or not str(tenant_id or "").strip():
        return 0
    _ = status  # reserved; upsert path always uses PENDING lifecycle start
    contact = {
        "jid": jid_s,
        "name": (chat_name or "").strip() or jid_s.split("@")[0] or "Unknown Contact",
        "is_group": bool(is_group) if is_group is not None else jid_s.endswith("@g.us"),
    }
    return upsert_audit_jobs(db, tenant_id, [contact])
