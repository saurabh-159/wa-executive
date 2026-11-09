"""
Comprehensive E2E: Layers 1 → 2 → 3 multimodal pipeline.

Mocks production WhatsApp cases with full message serialization + SQLite
interaction, then asserts cognitive outcomes (cancellation, receipt settlement,
answered queries, noise gating, cold-start ingest).
"""

from __future__ import annotations

import logging
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

from app.config import settings
from app.models.contact import Contact  # noqa: F401 — register metadata
from app.models.database import Base
from app.models.matter import DraftOption, Matter, NextStep  # noqa: F401
from app.models.message import Message
from app.schemas.matter import (
    ExtractedMatter,
    MatterCategory,
    MatterStatus,
)
from app.services.matter_extractor import sync_chat_matters
from app.services.message_formatter import (
    TURN_STATE_PENDING,
    TURN_STATE_RESOLVED,
    build_extraction_context_block,
    detect_answered_turns,
    format_messages_for_extraction,
)
from app.controllers.webhook_controller import (
    _compose_message_text,
    process_message_payload,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("test_pipeline_e2e")

pytestmark = pytest.mark.skipif(
    not (settings.OPENAI_API_KEY or "").strip(),
    reason="OPENAI_API_KEY required for Layer 3 live extraction tests",
)

TENANT = "e2e-pipeline-tenant"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ts(offset: int = 0) -> int:
    return 1_730_000_000 + offset


def _msg(
    *,
    from_me: bool,
    text: str,
    sender_name: str,
    chat_jid: str,
    timestamp: int,
    message_id: str | None = None,
    media_type: str | None = None,
) -> dict:
    return {
        "message_id": message_id or f"e2e-{uuid.uuid4().hex[:12]}",
        "from_me": from_me,
        "is_from_me": from_me,
        "text": text,
        "sender_name": sender_name,
        "sender_jid": chat_jid,
        "chat_jid": chat_jid,
        "timestamp": timestamp,
        "media_type": media_type,
        "tenant_jid": TENANT,
        "tenant_id": TENANT,
    }


def _layer1_append_media(caption: str, enrichment: str) -> str:
    """Simulate Layer 1 multimodal enrichment joining caption + OCR/transcript."""
    composed = _compose_message_text(caption, None, enrichment)
    logger.info("[Layer 1] Enriched preview: %s", composed[:160].replace("\n", " | "))
    return composed


def _seed_messages(db, messages: list[dict]) -> None:
    for m in messages:
        db.add(
            Message(
                tenant_jid=TENANT,
                message_id=m["message_id"],
                sender_jid=m["sender_jid"],
                phone_number=str(m["sender_jid"]).split("@")[0],
                sender_name=m.get("sender_name") or "Unknown Contact",
                is_from_me=bool(m.get("from_me") or m.get("is_from_me")),
                timestamp=int(m["timestamp"]),
                text=m.get("text") or "",
                media_type=m.get("media_type"),
            )
        )
    db.commit()


def _run_layers(
    db,
    *,
    chat_jid: str,
    chat_name: str,
    messages: list[dict],
    label: str,
) -> tuple[str, list[ExtractedMatter], list[Matter]]:
    """Layer 2 serialize + turn-state → Layer 3 extract → SQLite upsert."""
    body = format_messages_for_extraction(
        messages, contact_display_name=chat_name, redact=True
    )
    logger.info("[Layer 2] Serialized log for %s:\n%s", label, body)

    you_lines = [ln for ln in body.splitlines() if "[You (Saurabh)]:" in ln]
    contact_lines = [ln for ln in body.splitlines() if "[Contact (" in ln]
    logger.info(
        "[Layer 2] Speaker check | You lines=%d | Contact lines=%d",
        len(you_lines),
        len(contact_lines),
    )
    for ln in you_lines:
        assert "[You (Saurabh)]:" in ln
        assert not ln.lstrip().startswith("[Contact"), ln
    for ln in contact_lines:
        assert f"[Contact ({chat_name})]:" in ln or "[Contact (" in ln

    turn = detect_answered_turns(messages)
    logger.info(
        "[Layer 2] Turn State: %s | hint=%s",
        turn.get("turn_state"),
        (turn.get("system_hint") or "")[:160],
    )

    context = build_extraction_context_block(
        messages,
        chat_name=chat_name,
        chat_jid=chat_jid,
        contact_display_name=chat_name,
        redact=True,
    )
    logger.info("[Layer 2] Extraction context block:\n%s", context)

    _seed_messages(db, messages)

    # Single Layer-3 call: sync rebuilds briefing from DB then upserts
    matters = sync_chat_matters(
        db,
        chat_jid,
        tenant_jid=TENANT,
        limit=50,
        chat_name=chat_name,
    )
    logger.info("[Layer 3] ExtractionResponse matters count=%d", len(matters))
    for i, m in enumerate(matters, 1):
        logger.info(
            "  [%d] title=%r category=%s status=%s next_step=%r summary=%s",
            i,
            m.title,
            m.category,
            m.status,
            m.next_step,
            m.summary,
        )
        for a in m.actions or []:
            logger.info("      action=%r reply=%r", a.action_label, a.suggested_reply)
            assert "draft reply — draft reply" not in (a.action_label or "").lower()

    rows = (
        db.query(Matter)
        .filter(Matter.tenant_jid == TENANT, Matter.sender_jid == chat_jid)
        .all()
    )
    logger.info("[DB] Persisted matter rows=%d", len(rows))
    for row in rows:
        logger.info(
            "  DB row id=%s title=%r status=%s category=%s archived=%s",
            row.id,
            row.title,
            row.status,
            row.category,
            row.is_archived,
        )

    return context, matters, rows


def _blob(matters: list[ExtractedMatter]) -> str:
    return " ".join(
        f"{m.title} {m.summary} {m.category} {m.next_step or ''} "
        + " ".join(a.action_label for a in (m.actions or []))
        for m in matters
    ).lower()


@pytest.fixture()
def db_session(monkeypatch):
    """Isolated in-memory SQLite shared across connections (ingest + sync)."""
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

    session = TestingSession()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


# ---------------------------------------------------------------------------
# Scenario 1 — Audio Task Cancellation (Brevo / IP whitelist)
# ---------------------------------------------------------------------------


def test_scenario_1_audio_task_cancellation_brevo(db_session):
    chat_jid = "919811100001@s.whatsapp.net"
    chat_name = "Saurabh Prabhuji"

    voice = _layer1_append_media(
        "",
        "[Voice Note Transcript]: Is se kya hoga sir? Ye to SMTP matlab email ke inge hai na? "
        "Localhost se email jaati nahi hai. To aap email ki testing chhod do, iske alawa kar lo.",
    )
    assert voice.startswith("[Voice Note Transcript]:"), voice
    assert "\n[" not in voice.split(":", 1)[0]  # no malformed double header prefix junk

    messages = [
        _msg(
            from_me=True,
            text="sir ip allowe krna hoga",
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(1),
        ),
        _msg(
            from_me=False,
            text="Brevo SMTP se email testing karna hai, IP whitelist bhi dekhna",
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(2),
        ),
        _msg(
            from_me=True,
            text="ok Brevo SMTP configure karke dekh raha hu",
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(3),
        ),
        _msg(
            from_me=False,
            text=voice,
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(4),
            media_type="audio",
        ),
    ]

    turn = detect_answered_turns(messages)
    assert turn["turn_state"] != TURN_STATE_PENDING, (
        f"Voice cancel must not leave PENDING_USER_REPLY, got: {turn}"
    )
    logger.info("[Layer 2] Scenario 1 Turn State after cancel: %s", turn["turn_state"])

    _context, matters, _rows = _run_layers(
        db_session,
        chat_jid=chat_jid,
        chat_name=chat_name,
        messages=messages,
        label="Scenario 1 Brevo cancel",
    )

    assert isinstance(matters, list)
    for m in matters:
        assert isinstance(m, ExtractedMatter)

    blob = _blob(matters)
    brevo = [
        m
        for m in matters
        if any(
            tok in f"{m.title} {m.summary} {m.category}".lower()
            for tok in ("brevo", "smtp", "email", "ip", "whitelist", "allow")
        )
    ]
    assert brevo, f"Expected Brevo/SMTP/IP matter, got: {matters!r}"

    for m in brevo:
        assert m.status in {MatterStatus.DISCARDED, MatterStatus.DONE}, (
            f"Brevo after voice cancel must be DISCARDED/DONE, got {m.status}: {m!r}"
        )
        assert m.status != MatterStatus.NEEDS_YOU
        action_blob = " ".join(a.action_label.lower() for a in (m.actions or []))
        assert "whitelist" not in action_blob
        assert "ip allow" not in action_blob

    assert "needs_you" not in "".join(m.status.value.lower() for m in brevo)
    # Must not ask Saurabh to whitelist IP
    assert "whitelist ip" not in blob
    assert "ip allowe" not in blob or all(
        m.status in {MatterStatus.DISCARDED, MatterStatus.DONE} for m in brevo
    )


# ---------------------------------------------------------------------------
# Scenario 2 — Receipt OCR Settlement (October Salary ₹9,500)
# ---------------------------------------------------------------------------


def test_scenario_2_receipt_ocr_salary_settlement(db_session):
    chat_jid = "919811100002@s.whatsapp.net"
    chat_name = "Saurabh Prabhuji"

    ocr = _layer1_append_media(
        "",
        "[Image OCR/Details]: UPI Payment Successful: ₹9,500 transferred to SUDHA SHARMA. "
        "Reference ID: 321894719.",
    )
    assert ocr.startswith("[Image OCR/Details]:"), ocr

    messages = [
        _msg(
            from_me=False,
            text="October salary: 23800 received, 14300 deduction, 9500 balance bhejna hai",
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(10),
        ),
        _msg(
            from_me=True,
            text="haan 23800 - 14300 = 9500, abhi bhej raha hu",
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(11),
        ),
        _msg(
            from_me=True,
            text=ocr,
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(12),
            media_type="image",
        ),
        _msg(
            from_me=False,
            text="ok mil gaya",
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(13),
        ),
    ]

    _context, matters, _rows = _run_layers(
        db_session,
        chat_jid=chat_jid,
        chat_name=chat_name,
        messages=messages,
        label="Scenario 2 Salary receipt",
    )

    salary = [
        m
        for m in matters
        if any(
            tok in f"{m.title} {m.summary}".lower()
            for tok in ("9500", "9,500", "salary", "sudha", "october")
        )
        or m.category == MatterCategory.FINANCIAL_SETTLEMENT
    ]
    assert salary, f"Expected October Salary matter, got: {matters!r}"
    for m in salary:
        assert m.status == MatterStatus.DONE, (
            f"Receipt OCR salary must be DONE, not open dispute: {m!r}"
        )
        assert m.status != MatterStatus.NEEDS_YOU
        summary_l = (m.summary or "").lower()
        assert "clarification" not in summary_l
        assert "dispute" not in summary_l


# ---------------------------------------------------------------------------
# Scenario 3 — Answered State Check (Adarsh / Live Timings)
# ---------------------------------------------------------------------------


def test_scenario_3_answered_live_timings(db_session):
    chat_jid = "919811100003@s.whatsapp.net"
    chat_name = "Adarsh (Uncle Ji)"

    messages = [
        _msg(
            from_me=False,
            text="Live ki timing bta do",
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(20),
        ),
        _msg(
            from_me=True,
            text="raat ko 11 baje approax",
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(21),
        ),
        _msg(
            from_me=False,
            text="To fr check kr lena",
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(22),
        ),
    ]

    turn = detect_answered_turns(messages)
    assert turn["turn_state"] == TURN_STATE_RESOLVED
    assert turn["resolved"] is True
    assert "Set status=DONE" in (turn.get("system_hint") or "")
    logger.info("[Layer 2] Scenario 3 Turn State confirmed RESOLVED_BY_USER")

    _context, matters, _rows = _run_layers(
        db_session,
        chat_jid=chat_jid,
        chat_name=chat_name,
        messages=messages,
        label="Scenario 3 Adarsh timings",
    )

    for m in matters:
        assert m.status != MatterStatus.NEEDS_YOU, (
            f"Answered live-timing query must never be NEEDS_YOU: {m!r}"
        )
        action_blob = " ".join(a.action_label.lower() for a in (m.actions or []))
        assert "provide live" not in action_blob
        assert "live timing" not in action_blob or m.status == MatterStatus.DONE

        timing_related = any(
            tok in f"{m.title} {m.summary}".lower()
            for tok in ("live", "timing", "11", "baje")
        )
        if timing_related:
            assert m.status == MatterStatus.DONE, f"Timing matter must be DONE: {m!r}"


# ---------------------------------------------------------------------------
# Scenario 4 — Casual Banter vs Embedded Debt (Tanish / ₹13,000 course)
# ---------------------------------------------------------------------------


def test_scenario_4_tanish_course_liability_only(db_session):
    chat_jid = "919811100004@s.whatsapp.net"
    chat_name = "Tanish"

    messages = [
        _msg(
            from_me=False,
            text="yaar HR ne offer diya tha 18L pe, maine reject kar diya mood kharab hai",
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(30),
        ),
        _msg(
            from_me=True,
            text="koi na bhai, better milega. abhi work pe focus kar",
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(31),
        ),
        _msg(
            from_me=False,
            text="150 rs ka Diwali hamper diya office ne 😂 kya joke hai",
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(32),
        ),
        _msg(
            from_me=True,
            text="hahaha pagal hai ye log. lunch karte hain kal?",
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(33),
        ),
        _msg(
            from_me=False,
            text="haan lunch chalte hain",
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(34),
        ),
        _msg(
            from_me=True,
            text=(
                "Course - 13000... bhai mujhe yaad hai jaise hi ayegi salary "
                "so mai kr dunga isey jldi"
            ),
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(35),
        ),
        _msg(
            from_me=True,
            text=(
                "Mai tumhe Apna gen ai ka project dikhaunga... Perisclaw naam suna... "
                "vector embedding and open api langgraph concepts se build krke bna rha hun"
            ),
            sender_name=chat_name,
            chat_jid=chat_jid,
            timestamp=_ts(36),
        ),
    ]

    context, matters, _rows = _run_layers(
        db_session,
        chat_jid=chat_jid,
        chat_name=chat_name,
        messages=messages,
        label="Scenario 4 Tanish liability",
    )

    # Layer 2 role check: You lines must be Saurabh-prefixed
    assert "[You (Saurabh)]: Course - 13000" in context or "[You (Saurabh)]:" in context
    assert "Perisclaw" in context
    you_perisclaw = any(
        "[You (Saurabh)]:" in ln and "Perisclaw" in ln
        for ln in context.splitlines()
    )
    assert you_perisclaw, "Perisclaw must remain attributed to [You (Saurabh)]"

    blob = _blob(matters)
    assert "hamper" not in blob
    assert "diwali" not in blob
    assert "lunch" not in blob
    assert "18l" not in blob.replace(" ", "")
    assert "hr offer" not in blob and "job offer" not in blob
    # Must NOT attribute Perisclaw ownership to Tanish
    for m in matters:
        combined = f"{m.title} {m.summary}".lower()
        if "perisclaw" in combined:
            assert "tanish" not in combined, f"Role inversion on Perisclaw: {m!r}"

    liability = [
        m
        for m in matters
        if m.category == MatterCategory.PERSONAL_LIABILITY
        or any(
            tok in f"{m.title} {m.summary}".lower()
            for tok in ("13000", "13,000", "course")
        )
    ]
    assert len(liability) >= 1, f"Expected course liability, got: {matters!r}"
    assert liability[0].status in {MatterStatus.WAITING, MatterStatus.NEEDS_YOU}

    # Exactly one matter — banter + GenAI demo dropped
    assert len(matters) == 1, (
        f"Expected exactly 1 PERSONAL_LIABILITY matter, got {len(matters)}: {matters!r}"
    )
    assert matters[0].category == MatterCategory.PERSONAL_LIABILITY


# ---------------------------------------------------------------------------
# Scenario 5 — Cold-Start / Unindexed Chat Ingestion
# ---------------------------------------------------------------------------


def test_scenario_5_cold_start_unindexed_chat(db_session, monkeypatch):
    """Unindexed phone with empty DB must ingest + extract without KeyError."""
    unknown_jid = "919800012345@s.whatsapp.net"
    message_id = f"cold-{uuid.uuid4().hex[:10]}"

    # Ensure DB has zero prior rows for this JID
    prior = (
        db_session.query(Message)
        .filter(Message.sender_jid == unknown_jid)
        .count()
    )
    assert prior == 0

    payload = {
        "tenant_id": TENANT,
        "tenant_jid": TENANT,
        "message_id": message_id,
        "chat_jid": unknown_jid,
        "sender_jid": unknown_jid,
        "phone_number": "919800012345",
        "sender_name": "",  # unindexed — no saved contact name
        "text": "Bhai kal meeting confirm hai kya?",
        "from_me": False,
        "is_from_me": False,
        "timestamp": int(time.time()),
        "is_history": True,  # persist only; skip live Baileys side-effects
    }

    try:
        result = process_message_payload(payload)
    except KeyError as exc:
        pytest.fail(f"Cold-start ingest raised KeyError: {exc}")
    except Exception as exc:
        pytest.fail(f"Cold-start ingest raised unexpectedly: {type(exc).__name__}: {exc}")

    logger.info("[Layer 1] Cold-start ingest result: %s", result)
    assert result.get("status") in {"success", "history_saved", "skipped"}

    db_session.expire_all()
    stored = (
        db_session.query(Message)
        .filter(Message.tenant_jid == TENANT, Message.message_id == message_id)
        .first()
    )
    assert stored is not None, "Message must be persisted for unindexed JID"
    # Auto-assigned identity (formatted phone or Unknown Contact), never blank
    assert stored.sender_name and str(stored.sender_name).strip(), (
        "Cold-start must auto-assign contact identity"
    )
    assert stored.sender_name != ""
    logger.info(
        "[Layer 1] Cold-start identity assigned: sender_name=%r jid=%s",
        stored.sender_name,
        stored.sender_jid,
    )

    # Layer 2 + 3 must run without exception on the new chat
    try:
        matters = sync_chat_matters(
            db_session,
            unknown_jid,
            tenant_jid=TENANT,
            limit=20,
            chat_name=stored.sender_name,
        )
    except KeyError as exc:
        pytest.fail(f"Cold-start extraction KeyError: {exc}")
    except Exception as exc:
        pytest.fail(
            f"Cold-start extraction failed: {type(exc).__name__}: {exc}"
        )

    logger.info(
        "[Layer 3] Cold-start extraction ok | matters=%d",
        len(matters),
    )
    assert isinstance(matters, list)
    for m in matters:
        assert isinstance(m, ExtractedMatter)


if __name__ == "__main__":
    raise SystemExit(
        pytest.main(
            [
                __file__,
                "-s",
                "-v",
                "--log-cli-level=INFO",
            ]
        )
    )
