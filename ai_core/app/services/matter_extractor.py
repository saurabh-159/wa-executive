"""
Layer 3: Executive Matter Extraction Engine — structured OpenAI parse,
intent gating, multimodal overrides, and SQLite persistence.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import List, Optional

from openai import AsyncOpenAI, OpenAI
from sqlalchemy.orm import Session

from app.config import settings
from app.knowledge_base.chat_guardrails import MATTER_SYSTEM_PROMPT
from app.models.matter import DraftOption, Matter, NextStep
from app.schemas.matter import (
    ExtractedMatter,
    ExtractionResponse,
    MatterStatus,
)
from app.schemas.matter_schema import ChatMatterSplitResult, SingleMatterOutput
from app.services.guardrails_engine import sanitize_and_validate_matters
from app.services.token_tracker import log_llm_usage
from app.services.message_formatter import (
    OWNER_DISPLAY_NAME,
    build_chat_context_for_extraction,
    format_messages_for_extraction as _format_messages_layer2,
    format_speaker_prefix,
    redact_sensitive_credentials,
    resolve_chat_contact_name,
)

logger = logging.getLogger(__name__)

MATTER_EXTRACTION_SYSTEM_PROMPT = """
You are the Executive Desk Intelligence Engine for Saurabh (Software Engineer).
Your mission is to transform raw serialized WhatsApp conversation logs into clean, accurate, and non-hallucinated Executive Matters.

=== CORE EXTRACTION RULES ===

1. SPEAKER IDENTITY & ATTRIBUTION (CRITICAL):
   - Lines marked "[You (Saurabh)]" are sent by Saurabh.
   - Lines marked "[Contact (<Name>)]" or "[Contact: <Name>]" are sent by the other party.
   - NEVER invert attribution:
     • If Saurabh explains his project (e.g. Perisclaw, LangGraph, GenAI, OpenAPI, vector embeddings),
       attribute it to Saurabh. NEVER say the contact (e.g. Tanish) is building Perisclaw.
     • If Saurabh says he will pay ("mai kr dunga", "salary aate hi"), the liability belongs to Saurabh.
     • If a contact/boss states deductions or payment rules, attribute the statement to the contact, never say "User reported".
     • Saurabh saying "sir ip allowe krna hoga" is a proposal, NOT a standing NEEDS_YOU task once cancelled.

2. CASUAL NOISE GATE (DISCARD BANTER) — NEGATIVE FEW-SHOTS:
   - These MUST yield ZERO matters:
     • Food/lunch ("khana khaya?", "paneer bna h", "lunch karte hain")
     • Festival / Diwali hamper jokes ("150 rs ka hamper diya 😂")
     • Religious greetings ("Hare Krishna", "Dandavat")
     • Rejected HR / job-offer venting ("HR ne offer diya tha, maine reject kar diya")
     • Pure "work focus" pep talk with no deliverable
     • Offering to demo a personal GenAI project (Perisclaw) with no owed deliverable
   - If a conversation segment has NO deliverables, liabilities, or deadlines, output NO matter for that segment.

3. EMBEDDED REAL COMMITMENTS (FAMILY & FRIENDS):
   - If real-world commitments are embedded inside casual conversations, EXTRACT THEM ACCURATELY:
     • Financial Liabilities: e.g. "[You (Saurabh)]: Course - 13000... salary aate hi mai kr dunga"
       -> Category: PERSONAL_LIABILITY, Status: WAITING or NEEDS_YOU. Exactly ONE such card.
     • Domestic Errands: e.g. "bachon ko 2 baje lana hai", "maa ko clinic se lete aana" -> Category: DOMESTIC_ERRAND, Status: NEEDS_YOU.
     • Concrete Work Promises: e.g. "kal project done hai" -> Category: ENGINEERING, Status: NEEDS_YOU.

4. MULTIMODAL OVERRIDES & CANCELLATIONS:
   - Voice Note Overrides: If a [Voice Note Transcript] instructs to drop or cancel a prior text task
     (e.g. "email testing chhod do", "Iske alawa kar lo", "localhost se email jaati nahi"),
     the related Brevo/SMTP/IP-whitelist matter status is DISCARDED or DONE — NEVER NEEDS_YOU.
     Do NOT ask Saurabh to whitelist an IP after a voice cancel.
   - Visual Receipt Settlements: If [Image OCR/Details] proves a transfer
     (e.g. UPI Payment Successful ₹9,500 to SUDHA SHARMA), the October Salary / balance matter
     status MUST BE DONE. Never flag as needs clarification or open dispute.

5. CONVERSATION STATE & ANSWERED QUERIES:
   - If a contact asks (e.g. "Live ki timing bta do") and [You (Saurabh)] answered
     ("raat ko 11 baje approax"), the query is RESOLVED. Set status = DONE.
     NEVER create action "Provide live timings" or tag NEEDS_YOU.
   - Soft acks like "To fr check kr lena" do NOT reopen the query.
   - Obey [SYSTEM TURN STATE] / [SYSTEM STATE HINT] / [SYSTEM NOTE: ... Set status=DONE] when present.

6. MULTI-CARD CRITERIA:
   - Generate multiple distinct matters within the same chat ONLY IF they represent genuinely separate domains or distinct lifecycles (e.g., Salary Settlement [DONE] vs Admin Panel Feature [NEEDS_YOU]).
   - Do NOT fragment a single ongoing topic into multiple cards.
   - A salary discussion + its matching UPI receipt is ONE FINANCIAL_SETTLEMENT matter (DONE), not two cards.

7. BUTTON & DRAFT SANITIZATION:
   - Provide clean action labels (e.g. 'Share ETA with Client').
   - NEVER duplicate label strings (e.g., no 'draft reply — draft reply').
   - At most 2 actions per matter. Omit actions for DONE/DISCARDED unless a courtesy ack is useful.
"""

_openai_sync: OpenAI | None = None
openai_client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY or None)


def _get_sync_client() -> OpenAI | None:
    global _openai_sync
    api_key = (settings.OPENAI_API_KEY or "").strip()
    if not api_key:
        logger.error("[MatterExtractor] OPENAI_API_KEY missing")
        return None
    if _openai_sync is None:
        _openai_sync = OpenAI(api_key=api_key)
    return _openai_sync


def format_chat_log_line(
    *,
    from_me: bool,
    sender_name: str | None,
    text: str,
    timestamp_label: str | None = None,
) -> str:
    """
    Explicit speaker attribution for LLM matter extraction.
    Never reverse roles — from_me True is always the executive (Saurabh).
    """
    body = redact_sensitive_credentials((text or "").strip())
    speaker = format_speaker_prefix(
        from_me=bool(from_me),
        sender_display_name=sender_name,
    )
    if timestamp_label:
        stamp = str(timestamp_label).strip()
        if stamp and not stamp.startswith("["):
            stamp = f"[{stamp}]"
        return f"{stamp} {speaker}: {body}".strip()
    return f"{speaker}: {body}"


def format_messages_for_extraction(messages: list) -> str:
    """
    Build a chat log from Message ORM rows or dicts with is_from_me / from_me.
    Delegates to Layer 2 message_formatter (sort, speaker rules, redaction).
    """
    return _format_messages_layer2(messages, redact=True, include_timestamps=True)


def _sanitize_extracted(matters: List[ExtractedMatter]) -> List[ExtractedMatter]:
    """Clamp actions to 2, scrub duplicate labels, clear next_step for terminal statuses."""
    from app.schemas.matter import sanitize_action_label

    cleaned: List[ExtractedMatter] = []
    for matter in matters:
        actions = []
        for action in list(matter.actions or [])[:2]:
            label = sanitize_action_label(action.action_label)
            if not label and not (action.suggested_reply or "").strip():
                continue
            actions.append(
                action.model_copy(
                    update={"action_label": label or "Reply"}
                )
            )
        next_step = matter.next_step
        if matter.status in {MatterStatus.DONE, MatterStatus.DISCARDED}:
            next_step = None
            # Drop "provide timings"-style reopen actions on closed matters
            actions = [
                a
                for a in actions
                if "provide live" not in (a.action_label or "").lower()
            ]
        cleaned.append(
            matter.model_copy(update={"actions": actions, "next_step": next_step})
        )
    return cleaned


def extract_matters_from_log(formatted_context: str) -> List[ExtractedMatter]:
    """
    Layer 3 cognitive extract: parse a Layer-2 serialized chat log into
    structured Executive Matters via gpt-4o-mini structured outputs.
    """
    if not formatted_context or not str(formatted_context).strip():
        return []

    client = _get_sync_client()
    if client is None:
        return []

    user_prompt = (
        "Serialized WhatsApp conversation log below. "
        "Apply all CORE EXTRACTION RULES strictly. "
        "Return only genuine independent matters (empty list if pure banter).\n\n"
        f"{formatted_context.strip()}"
    )

    try:
        completion = client.beta.chat.completions.parse(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": MATTER_EXTRACTION_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            response_format=ExtractionResponse,
            temperature=0.1,
        )
        log_llm_usage(
            "Layer3_Extraction",
            "sync_extract",
            completion,
            model_name="gpt-4o-mini",
        )
        parsed: ExtractionResponse | None = completion.choices[0].message.parsed
        if parsed is None:
            refusal = getattr(completion.choices[0].message, "refusal", None)
            logger.warning("[MatterExtractor] Empty parse (refusal=%s)", refusal)
            return []
        matters = _sanitize_extracted(list(parsed.matters or []))
        logger.info(
            "[MatterExtractor] Parsed %d matter(s) via ExtractionResponse",
            len(matters),
        )
        return matters
    except Exception as e:
        logger.exception("[MatterExtractor] extract_matters_from_log failed: %s", e)
        return []


def _upsert_extracted_matter(
    db: Session,
    *,
    chat_jid: str,
    contact_name: str,
    extracted: ExtractedMatter,
    tenant_jid: str = "default",
) -> Matter:
    """Match existing row by (sender_jid/chat_jid, title); update or insert."""
    title = (extracted.title or "").strip()
    t_jid = str(tenant_jid or "default").strip()
    status_value = (
        extracted.status.value
        if isinstance(extracted.status, MatterStatus)
        else str(extracted.status)
    )
    category_value = (
        extracted.category.value
        if hasattr(extracted.category, "value")
        else str(extracted.category)
    )
    should_archive = status_value in {
        MatterStatus.DONE.value,
        MatterStatus.DISCARDED.value,
    }

    matter = (
        db.query(Matter)
        .filter(
            Matter.tenant_jid == t_jid,
            Matter.sender_jid == chat_jid,
            Matter.title == title,
        )
        .order_by(Matter.id.desc())
        .first()
    )

    if not matter:
        matter = Matter(
            tenant_jid=t_jid,
            sender_jid=chat_jid,
            contact_name=contact_name or "Unknown Contact",
            title=title or "Untitled Matter",
            status=status_value,
            summary=extracted.summary,
            situation=extracted.summary,
            category=category_value,
            next_step=extracted.next_step,
            is_archived=should_archive,
            last_activity_at=datetime.utcnow(),
        )
        db.add(matter)
        db.flush()
    else:
        matter.contact_name = contact_name or matter.contact_name
        matter.status = status_value
        matter.summary = extracted.summary
        matter.situation = extracted.summary
        matter.category = category_value
        matter.next_step = extracted.next_step
        matter.is_archived = should_archive
        matter.last_activity_at = datetime.utcnow()
        db.query(NextStep).filter(NextStep.matter_id == matter.id).delete()
        db.query(DraftOption).filter(DraftOption.matter_id == matter.id).delete()

    if extracted.next_step:
        db.add(
            NextStep(
                matter_id=matter.id,
                step_text=extracted.next_step[:255],
                is_completed=should_archive,
            )
        )

    for action in (extracted.actions or [])[:2]:
        label = (action.action_label or "").strip()
        reply = (action.suggested_reply or "").strip()
        if not label and not reply:
            continue
        db.add(
            DraftOption(
                matter_id=matter.id,
                action_label=label or "Reply",
                draft_text=reply or label,
                action_type="REPLY",
            )
        )

    return matter


def sync_chat_matters(
    db: Session,
    chat_jid: str,
    *,
    tenant_jid: str = "default",
    limit: int = 50,
    chat_name: Optional[str] = None,
) -> List[ExtractedMatter]:
    """
    Layer 2 context → Layer 3 extract → upsert into SQLite `matters`.
    Auto-archives rows whose status is DONE or DISCARDED.
    """
    jid = str(chat_jid or "").strip()
    if not jid:
        return []

    context = build_chat_context_for_extraction(
        db,
        jid,
        limit=limit,
        tenant_jid=tenant_jid,
        chat_name=chat_name,
    )
    if not context or not context.strip():
        logger.info("[MatterExtractor] Chat: %s | Extracted: 0 matters (empty context)", jid)
        return []

    matters = extract_matters_from_log(context)
    contact = resolve_chat_contact_name(
        db,
        jid,
        tenant_jid=tenant_jid,
        fallback_name=chat_name,
    )

    try:
        for extracted in matters:
            _upsert_extracted_matter(
                db,
                chat_jid=jid,
                contact_name=contact,
                extracted=extracted,
                tenant_jid=tenant_jid,
            )
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("[MatterExtractor] Failed persisting matters for %s", jid)
        raise

    logger.info(
        "[MatterExtractor] Chat: %s | Extracted: %d matters",
        jid,
        len(matters),
    )
    return matters


async def extract_matters_from_context(
    chat_name: str,
    is_group: bool,
    retrieved_context: str,
) -> List[SingleMatterOutput]:
    """
    Legacy audit-worker path: retrieved semantic chunks → gpt-4o-mini
    structured output guided by MATTER_SYSTEM_PROMPT + Guardrail Engine.
    """
    if not retrieved_context or not retrieved_context.strip():
        return []

    user_prompt = f"""
    Source Chat: {chat_name} (Group Chat: {is_group})

    10-Day Aggregated Context Chunks (speakers already labeled as
    [You ({OWNER_DISPLAY_NAME})] or [Contact (<name>)]):
    {retrieved_context}

    Apply the Knowledge Base behavioral patterns and extract all distinct, valid matters.
    Obey Speaker Attribution, Voice Supersedes Text, Receipt Resolution,
    Answered Queries, and Noise Filter rules strictly.
    """

    try:
        completion = await openai_client.beta.chat.completions.parse(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": MATTER_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            response_format=ChatMatterSplitResult,
            temperature=0.1,
        )
        log_llm_usage(
            "Layer3_Extraction",
            chat_name or "unknown",
            completion,
            model_name="gpt-4o-mini",
        )

        parsed_result: ChatMatterSplitResult | None = completion.choices[0].message.parsed
        raw_matters = parsed_result.matters if parsed_result else []
        return sanitize_and_validate_matters(raw_matters)

    except Exception as e:
        print(f"[MatterExtractor] Error processing chat '{chat_name}': {e}")
        return []


# Back-compat alias used by older call sites / tests
extract_matters = extract_matters_from_context
