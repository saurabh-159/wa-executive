"""Full tenant wipe — SQLite + Chroma vectors for WhatsApp unlink/logout."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from app.models.chat_audit_job import ChatAuditJob
from app.models.contact import Contact, LidMapping
from app.models.matter import DraftOption, Matter, NextStep, TimelineEvent
from app.models.matter_card import MatterCard
from app.models.message import Message
from app.models.summary import ChatSummary
from app.models.task import Task
from app.services.pattern_ingestion import wipe_tenant_vectors

logger = logging.getLogger(__name__)


def wipe_tenant_sqlite(db: Session, tenant_id: str) -> dict[str, int]:
    """Delete every tenant-scoped SQLite row. Caller owns commit."""
    tid = (tenant_id or "").strip()
    if not tid:
        return {}

    counts: dict[str, int] = {}

    matters = db.query(Matter).filter(Matter.tenant_jid == tid).all()
    nested = 0
    for m in matters:
        nested += db.query(TimelineEvent).filter(TimelineEvent.matter_id == m.id).delete()
        nested += db.query(DraftOption).filter(DraftOption.matter_id == m.id).delete()
        nested += db.query(NextStep).filter(NextStep.matter_id == m.id).delete()
        db.delete(m)
    counts["matters"] = len(matters)
    counts["matter_nested"] = nested

    counts["matter_cards"] = (
        db.query(MatterCard).filter(MatterCard.tenant_id == tid).delete(synchronize_session=False)
    )
    counts["chat_audit_jobs"] = (
        db.query(ChatAuditJob)
        .filter(ChatAuditJob.tenant_id == tid)
        .delete(synchronize_session=False)
    )
    counts["tasks"] = (
        db.query(Task).filter(Task.tenant_jid == tid).delete(synchronize_session=False)
    )
    counts["messages"] = (
        db.query(Message).filter(Message.tenant_jid == tid).delete(synchronize_session=False)
    )
    counts["chat_summaries"] = (
        db.query(ChatSummary)
        .filter(ChatSummary.tenant_jid == tid)
        .delete(synchronize_session=False)
    )
    counts["contacts"] = (
        db.query(Contact).filter(Contact.tenant_jid == tid).delete(synchronize_session=False)
    )
    counts["lid_mappings"] = (
        db.query(LidMapping)
        .filter(LidMapping.tenant_jid == tid)
        .delete(synchronize_session=False)
    )

    return counts


def wipe_tenant_data(db: Session, tenant_id: str, *, commit: bool = True) -> dict[str, Any]:
    """
    Full clean slate for one tenant:
    messages, matter cards, matters, tasks, summaries, contacts,
    LID maps, audit jobs, and Chroma vector collection.
    """
    tid = (tenant_id or "").strip()
    if not tid:
        return {"status": "skipped", "reason": "empty_tenant_id"}

    sqlite_counts = wipe_tenant_sqlite(db, tid)
    if commit:
        db.commit()

    vectors_wiped = wipe_tenant_vectors(tid)
    result = {
        "status": "success",
        "tenant_jid": tid,
        "sqlite": sqlite_counts,
        "vectors_wiped": vectors_wiped,
    }
    logger.info("Full tenant wipe complete: %s", result)
    print(f"🧹 [Full Wipe] tenant={tid} sqlite={sqlite_counts} vectors={vectors_wiped}")
    return result
