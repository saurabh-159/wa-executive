import json
import time
from datetime import datetime, timedelta, timezone

from app.config.rules_knowledge_base import MATTER_SYNTHESIS_SYSTEM_PROMPT
from app.services.multimodal_service import (
    _get_client,
    transcribe_audio_file,
    extract_image_context,
)
from app.services.token_tracker import log_llm_usage

VALID_STATUSES = {"NEEDS_YOU", "WAITING", "DONE"}
VALID_DOMAINS = {"WORK", "FINANCE", "TRAVEL", "HEALTH", "PERSONAL", "ADMINISTRATIVE"}
VALID_DRAFT_TYPES = {"REPLY", "CALL", "HOLD", "ARCHIVE"}
KEEP_OPEN_DRAFT_TYPES = {"CALL", "HOLD", "ARCHIVE"}
IST = timezone(timedelta(hours=5, minutes=30))


def _as_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _msg_attr(msg, name, default=None):
    if isinstance(msg, dict):
        return msg.get(name, default)
    return getattr(msg, name, default)


def _normalize_matter_payload(raw) -> dict:
    """
    Coerce GPT-4o JSON into title, domain, triage_status, headline, situation,
    core_problem, next_steps, draft_options, and timeline_events.
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return {}
    if not isinstance(raw, dict):
        return {}

    title = _as_text(raw.get("title"))
    if not title:
        return {}

    status = _as_text(raw.get("triage_status") or raw.get("status")).upper()
    if status not in VALID_STATUSES:
        status = "NEEDS_YOU"

    domain = _as_text(raw.get("domain")).upper()
    if domain not in VALID_DOMAINS:
        domain = "PERSONAL"

    headline = _as_text(
        raw.get("headline") or raw.get("core_problem") or raw.get("summary") or title
    )
    situation = _as_text(
        raw.get("situation") or raw.get("sub_caption") or raw.get("caption")
    )
    core_problem = _as_text(raw.get("core_problem") or headline)

    # Clean next steps (round checklist items)
    next_steps = []
    steps_raw = raw.get("next_steps") or []
    if isinstance(steps_raw, str):
        steps_raw = [steps_raw]
    if isinstance(steps_raw, list):
        for step in steps_raw:
            if isinstance(step, dict):
                text = _as_text(
                    step.get("step_text") or step.get("text") or step.get("label")
                )
            else:
                text = _as_text(step)
            if text:
                next_steps.append(text)

    # Intent-Based Multi-Scenario Drafts matching Reference UI
    draft_options = []
    drafts_raw = raw.get("draft_options") or []
    if isinstance(drafts_raw, str):
        drafts_raw = [drafts_raw]
    elif isinstance(drafts_raw, dict):
        drafts_raw = [drafts_raw]

    if isinstance(drafts_raw, list):
        for draft in drafts_raw:
            if len(draft_options) >= 3:
                break
            if isinstance(draft, str):
                text = _as_text(draft)
                if text:
                    draft_options.append(
                        {
                            "label": "Reply to counterparty — draft reply",
                            "action_label": "Reply to counterparty — draft reply",
                            "text": text,
                            "draft_text": text,
                            "type": "REPLY",
                            "action_type": "REPLY",
                        }
                    )
                continue
            if not isinstance(draft, dict):
                continue

            label = _as_text(draft.get("label") or draft.get("action_label"))
            text = _as_text(draft.get("text") or draft.get("draft_text"))
            action_type = (
                _as_text(
                    draft.get("type") or draft.get("action_type") or "REPLY"
                ).upper()
                or "REPLY"
            )
            if action_type not in VALID_DRAFT_TYPES:
                action_type = "REPLY"

            if not label and not text:
                continue

            # Ensure proper suffix for clean action chips
            if not label:
                label = (
                    "I'll handle this myself — keep it open"
                    if action_type in KEEP_OPEN_DRAFT_TYPES
                    else "Draft reply"
                )

            draft_options.append(
                {
                    "label": label,
                    "action_label": label,
                    "text": text,
                    "draft_text": text,
                    "type": action_type,
                    "action_type": action_type,
                    "is_used": False,
                }
            )

    # How we got here timeline
    timeline_events = []
    events_raw = raw.get("timeline_events") or []
    if isinstance(events_raw, str):
        events_raw = [events_raw]
    elif isinstance(events_raw, dict):
        events_raw = [events_raw]
    if isinstance(events_raw, list):
        for event in events_raw:
            if isinstance(event, str):
                desc = _as_text(event)
                if desc:
                    timeline_events.append(
                        {"date_label": "Recent", "description": desc, "event_description": desc}
                    )
                continue
            if not isinstance(event, dict):
                continue
            desc = _as_text(
                event.get("description")
                or event.get("event_description")
                or event.get("event_text")
            )
            if not desc:
                continue
            date_lbl = _as_text(
                event.get("date_label") or event.get("relative_time") or "Recent"
            )
            timeline_events.append(
                {
                    "date_label": date_lbl,
                    "description": desc,
                    "event_description": desc,
                }
            )

    if not headline:
        headline = title
    if not core_problem:
        core_problem = headline

    return {
        "title": title,
        "domain": domain,
        "triage_status": status,
        "status": status,
        "headline": headline,
        "situation": situation,
        "core_problem": core_problem,
        "summary": headline,
        "next_steps": next_steps,
        "draft_options": draft_options,
        "timeline_events": timeline_events,
    }


def _enrich_message_body(msg) -> str:
    """Fold audio transcripts and image descriptions into one conversational line."""
    body = _as_text(_msg_attr(msg, "text", "") or "")
    media_type = _as_text(_msg_attr(msg, "media_type", "") or "").lower()
    media_path = _as_text(_msg_attr(msg, "media_path", "") or "")

    try:
        if media_type == "audio" and media_path:
            already = "[voice note" in body.lower()
            transcript = "" if already else transcribe_audio_file(media_path)
            if transcript:
                voice = (
                    transcript
                    if transcript.lower().startswith("[voice note")
                    else f"[Voice Note Transcript]: {transcript}"
                )
                body = f"{body}\n{voice}".strip() if body else voice
        elif media_type == "image" and media_path:
            already = "[image ocr/details]" in body.lower()
            visual_desc = "" if already else extract_image_context(media_path, chat_context=body)
            if visual_desc and visual_desc not in body:
                tagged = (
                    visual_desc
                    if visual_desc.lower().startswith("[image ocr/details]")
                    else f"[Image OCR/Details]: {visual_desc}"
                )
                body = f"{body}\n{tagged}".strip()
    except Exception as e:
        print(f"[Multimodal Enrich Error] {e}")

    return body


def _line_clock(ts) -> str:
    try:
        stamp = int(ts or 0)
        if stamp > 10**12:
            stamp = stamp // 1000
        if stamp <= 0:
            return ""
        return datetime.fromtimestamp(stamp, tz=IST).strftime("%d %b, %I:%M %p")
    except Exception:
        return ""


def _relative_age(ts) -> str:
    try:
        stamp = int(ts or 0)
        if stamp > 10**12:
            stamp = stamp // 1000
        delta = max(0, time.time() - stamp)
    except Exception:
        return "recently"
    if delta < 120:
        return "a minute ago"
    if delta < 3600:
        return f"{int(delta / 60)} minutes ago"
    if delta < 86400:
        return "earlier today"
    if delta < 172800:
        return "yesterday"
    return "recently"


def _speaker_name(msg, contact_name: str) -> str:
    if _msg_attr(msg, "is_from_me", False) or _msg_attr(msg, "from_me", False):
        return "[You (Saurabh)]"
    participant = _as_text(_msg_attr(msg, "participant_name", "") or "")
    if participant and participant.lower() not in {"you", "unknown", "unknown contact"}:
        return f"[Contact: {participant}]"
    name = contact_name or "Contact"
    return f"[Contact: {name}]"


def _fallback_situation(contact_name: str, messages: list) -> str:
    name = (contact_name or "They").strip() or "They"
    last_in = None
    for msg in reversed(messages or []):
        if _msg_attr(msg, "is_from_me", False):
            continue
        if _as_text(_msg_attr(msg, "text", "") or ""):
            last_in = msg
            break
    if last_in is None:
        return f"{name} is waiting on you; only you know."
    return f"{name} asked {_relative_age(_msg_attr(last_in, 'timestamp', 0))}; only you know."


def ensure_card_copy(ai_data: dict, contact_name: str, messages: list) -> dict:
    if not ai_data or not ai_data.get("title"):
        return ai_data or {}

    headline = _as_text(
        ai_data.get("headline")
        or ai_data.get("summary")
        or ai_data.get("core_problem")
        or ai_data.get("title")
    )
    if not headline:
        return {}

    situation = _as_text(ai_data.get("situation")) or _fallback_situation(
        contact_name, messages
    )
    core_problem = _as_text(ai_data.get("core_problem")) or headline

    ai_data["headline"] = headline
    ai_data["summary"] = headline
    ai_data["core_problem"] = core_problem
    ai_data["situation"] = situation
    return ai_data


def synthesize_matter_from_chat(
    chat_messages: list, contact_name: str, chat_jid: str = ""
) -> dict:
    """Prepares one chat's transcript and calls GPT-4o for structured synthesis."""
    if not chat_messages:
        return {}

    formatted_thread = []
    for msg in chat_messages:
        try:
            row_jid = _as_text(_msg_attr(msg, "sender_jid", "") or "")
            if chat_jid and row_jid and row_jid != str(chat_jid).strip():
                continue
            body = _enrich_message_body(msg)
            if not body:
                continue
            speaker = _speaker_name(msg, contact_name)
            clock = _line_clock(_msg_attr(msg, "timestamp", 0))
            mentioned = (
                " [MENTIONED YOU]"
                if _msg_attr(msg, "mentions_user", False)
                else ""
            )
            stamp = f"[{clock}] " if clock else ""
            formatted_thread.append(f"{stamp}{speaker}{mentioned}: {body}")
        except Exception as e:
            print(f"[Synthesis Error] Skipped a message: {e}")

    if not formatted_thread:
        return {}

    client = _get_client()
    if client is None:
        print(f"[Synthesis Error] OPENAI_API_KEY missing; skipped {contact_name}")
        return {}

    convo_text = "\n".join(formatted_thread)

    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": MATTER_SYNTHESIS_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        f"Chat id: {chat_jid or 'unknown'}\n"
                        f"Contact: {contact_name}\n\n"
                        "ISOLATION & FORMAT DIRECTIVE:\n"
                        "- Transcript below is the only ground truth.\n"
                        "- Provide 'headline' (1 bold sentence explaining the immediate reality).\n"
                        "- Provide 'situation' (1 sentence explaining who is waiting and when it happened).\n"
                        "- Provide 2 to 3 'draft_options' with label & text covering different scenarios "
                        "(e.g., Affirmative/Confirmed, Apologetic/Decline, or Manual follow-up).\n\n"
                        f"Transcript:\n{convo_text}"
                    ),
                },
            ],
            temperature=0.15,
        )
        log_llm_usage(
            "Matter_Synthesis",
            chat_jid or contact_name or "unknown",
            response,
            model_name="gpt-4o",
        )
        choices = getattr(response, "choices", None) or []
        if not choices or not getattr(choices[0], "message", None):
            return {}
        content = choices[0].message.content or ""
        parsed = json.loads(content)
        return ensure_card_copy(
            _normalize_matter_payload(parsed), contact_name, chat_messages
        )
    except Exception as e:
        print(f"[Synthesis Error] Failed for {contact_name}: {e}")
        return {}