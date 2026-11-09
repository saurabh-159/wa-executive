"""Zero-token guard + high-intent auto-promotion for unmonitored chats."""

from __future__ import annotations

import sys
import time
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.controllers.webhook_controller import process_message_payload
from app.models.chat_audit_job import ChatAuditJob  # noqa: F401 — register metadata
from app.models.contact import Contact  # noqa: F401
from app.models.database import Base
from app.models.matter import DraftOption, Matter, NextStep  # noqa: F401
from app.models.message import Message
from app.services.intent_sniffer import is_high_intent_message

TENANT = "intent-guard-tenant"


def _payload(*, text: str, chat_jid: str, sender_name: str = "Test Contact") -> dict:
    return {
        "message_id": f"intent-{uuid.uuid4().hex[:12]}",
        "from_me": False,
        "is_from_me": False,
        "text": text,
        "sender_name": sender_name,
        "sender_jid": chat_jid,
        "chat_jid": chat_jid,
        "timestamp": int(time.time()),
        "tenant_jid": TENANT,
        "tenant_id": TENANT,
        "is_history": False,
        "is_self_chat": False,
    }


@pytest.fixture()
def db_session(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    import app.controllers.webhook_controller as webhook_mod
    import app.models.database as database_mod

    monkeypatch.setattr(database_mod, "SessionLocal", TestingSession)
    monkeypatch.setattr(webhook_mod, "SessionLocal", TestingSession)

    # Block any accidental LLM / network work in these unit tests.
    monkeypatch.setattr(
        webhook_mod,
        "extract_commitments_from_chat",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("LLM must not run")),
    )
    monkeypatch.setattr(
        webhook_mod,
        "synthesize_matter_from_chat",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("LLM must not run")),
    )
    monkeypatch.setattr(
        webhook_mod,
        "trigger_history_backfill",
        lambda *a, **k: {"ok": True, "skipped": True, "reason": "test_stub"},
    )

    session = TestingSession()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


def test_intent_sniffer_patterns():
    assert is_high_intent_message("Khana kha liya bhai?") is False
    assert is_high_intent_message(
        "Bhai website ka deployment ruk gaya hai error check karo"
    ) is True
    assert is_high_intent_message("Payment of Rs 5000 due asap") is True


def test_a_casual_unmonitored_stays_inbox_only(db_session):
    chat_jid = "919900000001@s.whatsapp.net"
    result = process_message_payload(
        _payload(text="Khana kha liya bhai?", chat_jid=chat_jid)
    )

    assert result["status"] == "stored_inbox_only"

    rows = (
        db_session.query(Message)
        .filter(Message.tenant_jid == TENANT, Message.sender_jid == chat_jid)
        .all()
    )
    assert len(rows) == 1
    assert rows[0].is_monitored is False

    jobs = (
        db_session.query(ChatAuditJob)
        .filter(ChatAuditJob.tenant_id == TENANT, ChatAuditJob.jid == chat_jid)
        .count()
    )
    assert jobs == 0


def test_b_high_intent_auto_promotes_and_queues_audit(db_session, monkeypatch):
    import app.controllers.webhook_controller as webhook_mod

    chat_jid = "919900000002@s.whatsapp.net"
    backfill_calls: list[dict] = []

    def _capture_backfill(db, *, tenant_id, jid, **kwargs):
        backfill_calls.append({"tenant_id": tenant_id, "jid": jid, **kwargs})
        return {"ok": True, "local_count": 1}

    monkeypatch.setattr(webhook_mod, "trigger_history_backfill", _capture_backfill)

    result = process_message_payload(
        _payload(
            text="Bhai website ka deployment ruk gaya hai error check karo",
            chat_jid=chat_jid,
            sender_name="Dev Lead",
        )
    )

    assert result["status"] == "auto_promoted"

    rows = (
        db_session.query(Message)
        .filter(Message.tenant_jid == TENANT, Message.sender_jid == chat_jid)
        .all()
    )
    assert len(rows) == 1
    assert rows[0].is_monitored is True

    jobs = (
        db_session.query(ChatAuditJob)
        .filter(ChatAuditJob.tenant_id == TENANT, ChatAuditJob.jid == chat_jid)
        .all()
    )
    assert len(jobs) == 1
    assert jobs[0].status == "PENDING"

    assert len(backfill_calls) == 1
    assert backfill_calls[0]["jid"] == chat_jid
    assert backfill_calls[0]["tenant_id"] == TENANT
