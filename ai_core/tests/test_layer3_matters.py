"""
Layer 3 terminal tests: Executive Matter extraction, intent gating & guardrails.

Feeds serialized Layer-2 style conversation logs into extract_matters_from_log
and asserts cognitive outcomes (noise drop, multimodal overrides, answered queries).
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import settings
from app.schemas.matter import (
    ExtractedMatter,
    MatterCategory,
    MatterStatus,
)
from app.services.matter_extractor import extract_matters_from_log

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("test_layer3")

pytestmark = pytest.mark.skipif(
    not (settings.OPENAI_API_KEY or "").strip(),
    reason="OPENAI_API_KEY required for Layer 3 live extraction tests",
)


# ---------------------------------------------------------------------------
# Scenario fixtures (Layer-2 serialized logs)
# ---------------------------------------------------------------------------

SCENARIO_A_TANISH = """
Chat: Tanish | JID: 919999000001@s.whatsapp.net
[SYSTEM TURN STATE]: NO_PENDING_QUERY

[2024-10-01 12:05] [Contact (Tanish)]: Hare Krishna bhai
[2024-10-01 12:06] [You (Saurabh)]: Dandavat 🙏
[2024-10-01 12:10] [Contact (Tanish)]: khana khaya? paneer bna h aaj
[2024-10-01 12:11] [You (Saurabh)]: haan abhi khaya, mast tha
[2024-10-01 12:20] [Contact (Tanish)]: yaar HR ne offer diya tha 18L pe, maine reject kar diya mood kharab hai
[2024-10-01 12:21] [You (Saurabh)]: koi na bhai, better milega
[2024-10-01 13:00] [Contact (Tanish)]: Course - 13000 salary aate hi kar dunga, abhi pending hai
[2024-10-01 13:01] [You (Saurabh)]: ok no rush, jab salary aaye tab kar dena
""".strip()

SCENARIO_B_PRABHUJI = """
Chat: Prabhuji | JID: 919999000002@s.whatsapp.net
[SYSTEM TURN STATE]: NO_PENDING_QUERY

[2024-10-02 09:00] [Contact (Prabhuji)]: Brevo SMTP setup kar do email testing ke liye, localhost se check karna
[2024-10-02 09:05] [You (Saurabh)]: ok, Brevo SMTP configure karke email testing start karta hu
[2024-10-02 10:30] [Contact (Prabhuji)]: [Voice Note Transcript]: email testing chhod do, localhost se nahi jati — Brevo wala kaam drop kar do
[2024-10-02 11:00] [You (Saurabh)]: October salary ka 9500 balance bhej raha hu
[2024-10-02 11:01] [You (Saurabh)]: [Image OCR/Details]: GPay payment successful. Amount: ₹9,500. Paid to: Sudha Sharma. UTR: 432198765432. Status: Success.
[2024-10-02 11:05] [Contact (Prabhuji)]: ok mil gaya
""".strip()

SCENARIO_C_ADARSH = """
Chat: Adarsh (Uncle Ji) | JID: 919999000003@s.whatsapp.net
[SYSTEM TURN STATE]: RESOLVED_BY_USER (Answered)
[SYSTEM STATE HINT]: Note to Extractor: The latest query from contact was already answered by You. Do NOT mark this matter as 'Needs you' or create a duplicate task asking for information already provided.

[2024-10-03 14:00] [Contact (Adarsh (Uncle Ji))]: Live ki timing bata do, kitne baje live kiya tha?
[2024-10-03 14:05] [You (Saurabh)]: raat ko 11 baje approx
[2024-10-03 14:06] [Contact (Adarsh (Uncle Ji))]: To fr check kr lena
""".strip()


def _dump_matters(label: str, matters: list[ExtractedMatter]) -> None:
    logger.info("=== %s | count=%d ===", label, len(matters))
    for i, m in enumerate(matters, 1):
        logger.info(
            "  [%d] title=%r category=%s status=%s next_step=%r",
            i,
            m.title,
            m.category,
            m.status,
            m.next_step,
        )
        logger.info("      summary=%s", m.summary)
        for a in m.actions or []:
            logger.info("      action=%r reply=%r", a.action_label, a.suggested_reply)


def test_scenario_a_tanish_course_liability_only():
    """Casual banter dropped; only ₹13,000 course PERSONAL_LIABILITY remains."""
    matters = extract_matters_from_log(SCENARIO_A_TANISH)
    _dump_matters("Scenario A (Tanish)", matters)

    assert isinstance(matters, list)
    for m in matters:
        assert isinstance(m, ExtractedMatter)

    # Noise gate: food / Hare Krishna / HR offer venting must not appear
    blob = " ".join(f"{m.title} {m.summary}".lower() for m in matters)
    assert "paneer" not in blob
    assert "khana" not in blob
    assert "hare krishna" not in blob
    assert "dandavat" not in blob

    liability = [
        m
        for m in matters
        if m.category == MatterCategory.PERSONAL_LIABILITY
        or "13000" in f"{m.title} {m.summary}"
        or "13,000" in f"{m.title} {m.summary}"
        or "course" in f"{m.title} {m.summary}".lower()
    ]
    assert len(liability) >= 1, f"Expected course liability matter, got: {matters!r}"
    assert liability[0].status in {MatterStatus.WAITING, MatterStatus.NEEDS_YOU}

    # Prefer single card — banter must not inflate count
    assert len(matters) == 1, f"Expected exactly 1 matter (noise dropped), got {len(matters)}: {matters!r}"
    assert matters[0].category == MatterCategory.PERSONAL_LIABILITY


def test_scenario_b_prabhuji_voice_discard_and_receipt_done():
    """Brevo SMTP cancelled via voice → DISCARDED; ₹9,500 receipt → DONE."""
    matters = extract_matters_from_log(SCENARIO_B_PRABHUJI)
    _dump_matters("Scenario B (Prabhuji)", matters)

    assert isinstance(matters, list)
    for m in matters:
        assert isinstance(m, ExtractedMatter)

    blob_rows = [(m, f"{m.title} {m.summary} {m.category}".lower()) for m in matters]

    brevo = [
        m
        for m, blob in blob_rows
        if "brevo" in blob or "smtp" in blob or "email testing" in blob
    ]
    salary = [
        m
        for m, blob in blob_rows
        if "9500" in blob
        or "9,500" in blob
        or "salary" in blob
        or m.category == MatterCategory.FINANCIAL_SETTLEMENT
    ]

    assert brevo, f"Expected Brevo/SMTP matter, got: {matters!r}"
    assert all(
        m.status == MatterStatus.DISCARDED
        or m.status == MatterStatus.DONE
        for m in brevo
    ), f"Brevo should be DISCARDED/DONE after voice cancel, got: {brevo!r}"
    # Prefer DISCARDED for explicit cancel instruction
    assert any(m.status == MatterStatus.DISCARDED for m in brevo) or all(
        m.status == MatterStatus.DONE for m in brevo
    )

    assert salary, f"Expected salary/₹9500 matter, got: {matters!r}"
    assert all(m.status == MatterStatus.DONE for m in salary), (
        f"Salary with receipt OCR must be DONE, got: {salary!r}"
    )


def test_scenario_c_adarsh_answered_query_is_done():
    """Answered 'live timing' query must be DONE, never NEEDS_YOU."""
    matters = extract_matters_from_log(SCENARIO_C_ADARSH)
    _dump_matters("Scenario C (Adarsh)", matters)

    assert isinstance(matters, list)
    for m in matters:
        assert isinstance(m, ExtractedMatter)

    # Either empty (fully resolved noise) or DONE — never NEEDS_YOU for timing ask
    for m in matters:
        assert m.status != MatterStatus.NEEDS_YOU, (
            f"Answered live-timing query must not be NEEDS_YOU: {m!r}"
        )
        timing_related = any(
            tok in f"{m.title} {m.summary}".lower()
            for tok in ("live", "timing", "11", "baje")
        )
        if timing_related:
            assert m.status == MatterStatus.DONE, f"Timing matter must be DONE: {m!r}"


def test_extraction_response_schema_roundtrip_empty_log():
    """Empty / whitespace context returns [] without schema errors."""
    assert extract_matters_from_log("") == []
    assert extract_matters_from_log("   \n  ") == []
