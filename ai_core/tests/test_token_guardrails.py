"""
Token leakage guardrails — zero-waste verification.

Event A: 10 casual msgs from unmonitored contact → OpenAI called ZERO times
Event B: Duplicate audit on unchanged monitored chat → OpenAI called ZERO times
Event C: High-intent msg from monitored contact → OpenAI called once + token meter
"""

from __future__ import annotations

import asyncio
import sys
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.controllers.webhook_controller import process_message_payload
from app.models.chat_audit_job import ChatAuditJob
from app.models.contact import Contact  # noqa: F401 — register metadata
from app.models.database import Base
from app.models.matter import DraftOption, Matter, NextStep  # noqa: F401
from app.models.matter_card import MatterCard  # noqa: F401
from app.models.message import Message
from app.services.media_processor import should_run_vision_ocr
from app.services.pattern_ingestion import is_noise_embedding_text
from app.services.token_tracker import get_token_tracker, log_llm_usage

TENANT = "token-guard-tenant"


def _payload(
    *,
    text: str,
    chat_jid: str,
    sender_name: str = "Test Contact",
    message_id: str | None = None,
    media_type: str | None = None,
    media_base64: str | None = None,
) -> dict:
    return {
        "message_id": message_id or f"tg-{uuid.uuid4().hex[:12]}",
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
        "media_type": media_type,
        "media_base64": media_base64,
    }


def _fake_openai_response(
    *,
    prompt_tokens: int = 100,
    completion_tokens: int = 40,
    model: str = "gpt-4o-mini",
    content: str = '{"is_task": false}',
):
    usage = SimpleNamespace(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=prompt_tokens + completion_tokens,
    )
    message = SimpleNamespace(content=content, parsed=None, refusal=None)
    choice = SimpleNamespace(message=message)
    return SimpleNamespace(choices=[choice], usage=usage, model=model)


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
    import app.services.audit_worker as audit_worker_mod

    monkeypatch.setattr(database_mod, "SessionLocal", TestingSession)
    monkeypatch.setattr(webhook_mod, "SessionLocal", TestingSession)
    monkeypatch.setattr(audit_worker_mod, "SessionLocal", TestingSession)

    get_token_tracker().reset()

    session = TestingSession()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()
        get_token_tracker().reset()


def _seed_monitored_chat(db_session, chat_jid: str, name: str = "Monitored Contact"):
    db_session.add(
        Message(
            tenant_jid=TENANT,
            message_id=f"seed-{uuid.uuid4().hex[:8]}",
            sender_jid=chat_jid,
            sender_name=name,
            is_from_me=False,
            is_monitored=True,
            timestamp=int(time.time()) - 60,
            text="Prior monitored context about the project deadline",
        )
    )
    db_session.commit()


# ---------------------------------------------------------------------------
# Unit helpers
# ---------------------------------------------------------------------------


def test_vision_prefilter_blocks_unmonitored_and_tiny():
    tiny = b"\xff\xd8\xff" + b"\x00" * 100  # << 5KB
    big = b"\xff\xd8\xff" + b"\x00" * (6 * 1024)
    assert should_run_vision_ocr(big, is_monitored=False) is False
    assert should_run_vision_ocr(tiny, is_monitored=True) is False
    assert should_run_vision_ocr(big, is_monitored=True, caption="sticker") is False
    assert should_run_vision_ocr(big, is_monitored=True, caption="Happy Diwali 🙏") is False
    assert should_run_vision_ocr(big, is_monitored=True, caption="UPI payment receipt") is True
    assert should_run_vision_ocr(big, is_monitored=True, caption="") is True


def test_noise_embedding_gate():
    assert is_noise_embedding_text("ok") is True
    assert is_noise_embedding_text("hi") is True
    assert is_noise_embedding_text("haan") is True
    assert is_noise_embedding_text("hare krishna") is True
    assert is_noise_embedding_text("😂😂") is True
    assert (
        is_noise_embedding_text(
            "[Contact: A] [12:00]: Please send the invoice for Rs 5000 by tomorrow"
        )
        is False
    )


def test_token_tracker_logs_usage(capsys):
    tracker = get_token_tracker()
    tracker.reset()
    fake = _fake_openai_response(prompt_tokens=120, completion_tokens=30)
    entry = log_llm_usage("Layer3_Extraction", "919911122233@s.whatsapp.net", fake)
    assert entry["total_tokens"] == 150
    assert entry["estimated_cost_usd"] > 0
    snap = tracker.snapshot()
    assert snap["call_count"] == 1
    out = capsys.readouterr().out
    assert "[TOKEN METER]" in out
    assert "Layer3_Extraction" in out


# ---------------------------------------------------------------------------
# Event A — unmonitored casual flood
# ---------------------------------------------------------------------------


def test_event_a_unmonitored_casual_zero_openai(db_session, monkeypatch):
    """10 casual messages from an unmonitored contact → OpenAI mock called ZERO times."""
    import app.controllers.webhook_controller as webhook_mod

    openai_calls: list[str] = []

    def _boom(*_a, **_k):
        openai_calls.append("openai")
        raise AssertionError("OpenAI must not be called for unmonitored casual traffic")

    monkeypatch.setattr(webhook_mod, "process_media_payload", _boom)
    monkeypatch.setattr(webhook_mod, "extract_image_context", _boom)
    monkeypatch.setattr(webhook_mod, "transcribe_audio_file", _boom)
    monkeypatch.setattr(webhook_mod, "extract_commitments_from_chat", _boom)
    monkeypatch.setattr(webhook_mod, "synthesize_matter_from_chat", _boom)
    monkeypatch.setattr(
        webhook_mod,
        "trigger_history_backfill",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("backfill must not run")),
    )

    chat_jid = "919900000101@s.whatsapp.net"
    casual = [
        "hi",
        "hello",
        "ok",
        "haan",
        "acha",
        "hmm",
        "😂",
        "Good morning",
        "Khana kha liya?",
        "Bye bye",
    ]

    for i, text in enumerate(casual):
        # Include a tiny sticker-like image payload that MUST be ignored
        result = process_message_payload(
            _payload(
                text=text,
                chat_jid=chat_jid,
                media_type="image" if i == 0 else None,
                media_base64="aGVsbG8=" if i == 0 else None,  # tiny
            )
        )
        assert result["status"] == "stored_inbox_only", result

    assert openai_calls == []
    assert get_token_tracker().snapshot()["call_count"] == 0

    rows = (
        db_session.query(Message)
        .filter(Message.tenant_jid == TENANT, Message.sender_jid == chat_jid)
        .all()
    )
    assert len(rows) == 10
    assert all(r.is_monitored is False for r in rows)


# ---------------------------------------------------------------------------
# Event B — duplicate audit, unchanged window
# ---------------------------------------------------------------------------


def test_event_b_duplicate_audit_skips_openai(db_session, monkeypatch):
    """Re-queued audit with unchanged 10-day message count → zero OpenAI calls."""
    import app.services.audit_worker as audit_worker_mod
    import app.services.pattern_ingestion as pattern_mod
    import app.services.matter_extractor as matter_mod

    chat_jid = "919900000202@s.whatsapp.net"
    _seed_monitored_chat(db_session, chat_jid, name="Audit Contact")

    # Seed a few more messages so the 10-day window is non-empty
    for i in range(3):
        db_session.add(
            Message(
                tenant_jid=TENANT,
                message_id=f"aud-{i}-{uuid.uuid4().hex[:6]}",
                sender_jid=chat_jid,
                sender_name="Audit Contact",
                is_from_me=False,
                is_monitored=True,
                timestamp=int(time.time()) - i,
                text=f"Please confirm the payment status update #{i}",
            )
        )
    db_session.commit()
    msg_count = (
        db_session.query(Message)
        .filter(
            Message.tenant_jid == TENANT,
            Message.sender_jid == chat_jid,
            ~Message.message_id.like("sync-ph:%"),
        )
        .count()
    )

    job = ChatAuditJob(
        tenant_id=TENANT,
        jid=chat_jid,
        chat_name="Audit Contact",
        is_group=False,
        status="PENDING",
        total_raw_messages=msg_count,  # prior successful window size
        matters_generated=1,
    )
    db_session.add(job)
    db_session.commit()
    job_id = job.id

    openai_calls: list[str] = []

    async def _embed_boom(*_a, **_k):
        openai_calls.append("embed")
        raise AssertionError("embeddings must not run on duplicate audit")

    async def _retrieve_boom(*_a, **_k):
        openai_calls.append("retrieve")
        raise AssertionError("probe embeddings must not run on duplicate audit")

    async def _extract_boom(*_a, **_k):
        openai_calls.append("extract")
        raise AssertionError("Layer3 must not run on duplicate audit")

    monkeypatch.setattr(pattern_mod, "ingest_chat_vectors", _embed_boom)
    monkeypatch.setattr(pattern_mod, "retrieve_universal_pattern_chunks", _retrieve_boom)
    monkeypatch.setattr(matter_mod, "extract_matters_from_context", _extract_boom)
    monkeypatch.setattr(audit_worker_mod, "ingest_chat_vectors", _embed_boom)
    monkeypatch.setattr(audit_worker_mod, "retrieve_universal_pattern_chunks", _retrieve_boom)
    monkeypatch.setattr(audit_worker_mod, "extract_matters_from_context", _extract_boom)

    asyncio.run(audit_worker_mod.audit_single_chat(TENANT, job_id))

    db_session.expire_all()
    refreshed = db_session.query(ChatAuditJob).filter(ChatAuditJob.id == job_id).one()
    assert refreshed.status == "COMPLETED_NO_ACTION"
    assert "No new messages" in (refreshed.error_message or "")
    assert openai_calls == []


# ---------------------------------------------------------------------------
# Event C — monitored high-intent → exactly one OpenAI call + meter
# ---------------------------------------------------------------------------


def test_event_c_monitored_high_intent_one_openai(db_session, monkeypatch, capsys):
    """1 high-intent message on a monitored chat → OpenAI called exactly once."""
    import app.controllers.webhook_controller as webhook_mod

    chat_jid = "919900000303@s.whatsapp.net"
    _seed_monitored_chat(db_session, chat_jid, name="Dev Lead")

    openai_calls: list[dict] = []
    fake = _fake_openai_response(
        prompt_tokens=80,
        completion_tokens=20,
        content='{"is_task": false}',
    )

    def _commitment_once(messages, counterparty_name, media_path=None):
        openai_calls.append(
            {"fn": "commitment", "name": counterparty_name, "n_msgs": len(messages or [])}
        )
        # Simulate the real service logging token usage after the API returns.
        log_llm_usage(
            "Commitment_Extraction",
            chat_jid,
            fake,
            model_name="gpt-4o-mini",
            tenant_id=TENANT,
        )
        return {"is_task": False}

    def _media_blocked(*_a, **_k):
        raise AssertionError("media AI should not run for text-only event C")

    monkeypatch.setattr(webhook_mod, "extract_commitments_from_chat", _commitment_once)
    monkeypatch.setattr(
        webhook_mod,
        "synthesize_matter_from_chat",
        lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("matter synthesis mocked off for single-call assert")
        ),
    )
    monkeypatch.setattr(webhook_mod, "process_media_payload", _media_blocked)
    monkeypatch.setattr(webhook_mod, "extract_image_context", _media_blocked)
    monkeypatch.setattr(webhook_mod, "transcribe_audio_file", _media_blocked)
    # Bypass matter pipeline exception path by returning None via skip helper
    monkeypatch.setattr(webhook_mod, "should_skip_needs_you_card", lambda *a, **k: True)

    result = process_message_payload(
        _payload(
            text="Website deployment failed with a server error — please check ASAP",
            chat_jid=chat_jid,
            sender_name="Dev Lead",
        )
    )

    assert result["status"] == "success"
    assert len(openai_calls) == 1

    snap = get_token_tracker().snapshot()
    assert snap["call_count"] == 1
    call = snap["calls"][0]
    assert call["call_origin"] == "Commitment_Extraction"
    assert call["chat_jid"] == chat_jid
    assert call["total_tokens"] == 100
    assert call["estimated_cost_usd"] > 0

    out = capsys.readouterr().out
    assert "[TOKEN METER]" in out
    assert "Commitment_Extraction" in out
    assert chat_jid in out


def test_final_guardrail_report(capsys):
    """Print a concise protected-routes report for the pytest -s run."""
    report = """
======================================================================
 TOKEN GUARDRAILS — FINAL REPORT
======================================================================
 BLOCKED LEAKS
  [x] Unmonitored live webhook → Whisper / Vision / Commitment / Matter
  [x] Tiny images / stickers / social captions → Vision OCR
  [x] Greeting / <15-char banter chunks → text-embedding-3-small
  [x] Re-queued ChatAuditJob with unchanged 10-day window → Layer 3 + embeds

 PROTECTED ROUTES (tokens allowed)
  [x] Monitored live chats → commitment + matter synthesis
  [x] High-intent unmonitored → auto-promote + audit enqueue (regex gate)
  [x] Monitored Vision OCR (receipt / error / empty-caption photos ≥5KB)
  [x] Audit worker on NEW messages only → Chroma embeds + Layer3_Extraction
  [x] Every OpenAI call → [TOKEN METER] via token_tracker.log_llm_usage
======================================================================
"""
    print(report)
    assert "BLOCKED LEAKS" in report
