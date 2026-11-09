"""
Layer 2: Message normalization, strict speaker attribution, turn-state resolution,
and credential redaction for Matter Extractor briefing logs.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models.message import Message
from app.services.contact_names import load_contact_directory, lookup_contact_labels
from app.services.jid_identity import resolve_chat_label, usable_person_name

OWNER_DISPLAY_NAME = "Saurabh"

TURN_STATE_RESOLVED = "RESOLVED_BY_USER (Answered)"
TURN_STATE_PENDING = "PENDING_USER_REPLY (Actionable)"
TURN_STATE_NONE = "NO_PENDING_QUERY"

RESOLVED_EXTRACTOR_HINT = (
    "Note to Extractor: The latest query from contact was already answered by You. "
    "Do NOT mark this matter as 'Needs you' or create a duplicate task asking for "
    "information already provided. Set status=DONE."
)

PENDING_EXTRACTOR_HINT = (
    "Note to Extractor: Contact has an unanswered query/request. "
    "This may be actionable for the executive."
)

MS_THRESHOLD = 1_000_000_000_000

# Contact asks / clarification cues (Hinglish + English).
_QUESTION_MARKERS = re.compile(
    r"(?:"
    r"\?"
    r"|\b(?:kya|kab|kaise|kitna|kitne|kahan|bata(?:\s*do|\s*dena)?|bta(?:\s*do)?|"
    r"btana|btao|batao|btado|bhej(?:o|na)?|send|share|de\s*do|dedo|"
    r"confirm|status|timing|password|pass\b|otp|access|"
    r"when|what|how|where|why|which|please|pls|plz|"
    r"can\s+you|could\s+you|would\s+you|let\s+me\s+know|"
    r"bhej\s+do|pass(?:word)?\s+bhej)"
    r"\b)",
    re.IGNORECASE,
)

_ACK_OR_SOFT_FOLLOWUP = re.compile(
    r"(?i)^(?:"
    r"ok+|okay|okk+|haan+|han+|ha+|ji+|yes|yep|sure|theek|thik(?:\s*hai)?|"
    r"done|thanks|thank\s*you|ty|cool|great|perfect|got\s*it|noted|"
    r"alright|acha|accha|sahi|samajh\s*gaya|samjh\s*gya|"
    r"to\s*fr\b.*|toh\s*phir\b.*|to\s*phir\b.*|phir\s+check\b.*|"
    r"check\s+kar\s+lena|check\s+kr\s+lena|dekh\s+lena|ok\s+check\b.*"
    r"|👍|🙏|👌|✅"
    r")[\s!.]*$"
)

# Voice/text cancel directives must not reopen a PENDING_USER_REPLY turn.
_CANCEL_OR_DROP_MARKERS = re.compile(
    r"(?i)\b(?:"
    r"chhod\s*do|chor\s*do|drop\s+(?:kar\s+)?do|mat\s+kar(?:na)?|"
    r"rehne\s+do|cancel(?:\s+kar\s+do)?|iske\s+alawa\s+kar\s+lo|"
    r"email\s+ki\s+testing\s+chhod|testing\s+chhod"
    r")\b"
)

def _msg_get(msg: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(msg, dict):
            if name in msg and msg[name] is not None:
                return msg[name]
        else:
            if hasattr(msg, name):
                value = getattr(msg, name)
                if value is not None:
                    return value
    return default


def coerce_from_me(msg: Any) -> bool:
    raw = _msg_get(msg, "from_me", "is_from_me", default=False)
    if isinstance(raw, str):
        return raw.strip().lower() in {"1", "true", "yes", "y"}
    return bool(raw)


def message_timestamp(msg: Any) -> int:
    raw = _msg_get(msg, "timestamp", default=0)
    try:
        return int(raw or 0)
    except (TypeError, ValueError):
        return 0


def format_timestamp_label(ts: int | None) -> str:
    if not ts:
        return ""
    try:
        value = int(ts)
        if value >= MS_THRESHOLD:
            value = value // 1000
        return datetime.fromtimestamp(value, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
    except (OSError, OverflowError, ValueError, TypeError):
        return str(ts)


def sort_messages_chronologically(messages: list) -> list:
    """Strict ascending sort by timestamp (stable for equal stamps)."""
    indexed = list(enumerate(messages or []))
    indexed.sort(key=lambda pair: (message_timestamp(pair[1]), pair[0]))
    return [msg for _, msg in indexed]


def resolve_sender_display_name(
    msg: Any,
    *,
    contact_display_name: str | None = None,
) -> str:
    """
    Prefer pushName / contact name. Use a raw number only when no usable name exists.
    """
    candidates = [
        contact_display_name,
        _msg_get(msg, "participant_name"),
        _msg_get(msg, "sender_name"),
        _msg_get(msg, "push_name", "pushName", "notify_name"),
        _msg_get(msg, "sender"),
    ]
    for candidate in candidates:
        usable = usable_person_name(candidate)
        if usable:
            return usable

    phone = _msg_get(msg, "phone_number")
    jid = _msg_get(msg, "sender_jid", "chat_jid")
    fallback = resolve_chat_label(
        sender_name=_msg_get(msg, "sender_name"),
        jid=jid,
        phone_number=phone,
        saved_name=contact_display_name,
        notify_name=_msg_get(msg, "notify_name", "push_name", "pushName"),
    )
    return (fallback or "Contact").strip() or "Contact"


def redact_sensitive_credentials(text: str) -> str:
    """
    Sanitize plain passwords for LLM briefing logs.
    DB content is left untouched; only the returned string is masked.
    Example: 'Password: hptourism@123' -> '[Credentials Shared: hptourism / ********]'
    """
    body = text or ""
    if not body:
        return body

    def _mask_user_pass(user: str, _secret: str) -> str:
        label = (user or "").strip() or "account"
        return f"[Credentials Shared: {label} / ********]"

    # Combined username + password (either order)
    def _replace_user_pass(match: re.Match[str]) -> str:
        return _mask_user_pass(match.group(1), match.group(2))

    def _replace_pass_user(match: re.Match[str]) -> str:
        return _mask_user_pass(match.group(2), match.group(1))

    updated = re.sub(
        r"(?i)\b(?:user(?:name)?|user\s*id|login|id)\s*[:=]\s*([^\s,;]+)"
        r".{0,60}?\b(?:password|pass(?:word)?|pwd|passwd|ultraviewer(?:\s+password)?)"
        r"\s*[:=]\s*([^\s,;]+)",
        _replace_user_pass,
        body,
    )
    updated = re.sub(
        r"(?i)\b(?:password|pass(?:word)?|pwd|passwd|ultraviewer(?:\s+password)?)"
        r"\s*[:=]\s*([^\s,;]+).{0,60}?\b(?:user(?:name)?|user\s*id|login|id)"
        r"\s*[:=]\s*([^\s,;]+)",
        _replace_pass_user,
        updated,
    )

    def _replace_labeled(match: re.Match[str]) -> str:
        secret = match.group(1) or ""
        # Prefer username-like token before '@' (e.g. hptourism@123 → hptourism)
        account = secret.split("@", 1)[0].strip() if secret else "account"
        if not account or account == secret:
            # No separable username — still hide the secret
            account = "account"
        return f"[Credentials Shared: {account} / ********]"

    updated = re.sub(
        r"(?i)\b(?:password|pass(?:word)?|pwd|passwd|ultraviewer(?:\s+password)?|"
        r"viewer\s*pass(?:word)?|login\s*password)\s*[:=]\s*([^\s,;]+)",
        _replace_labeled,
        updated,
    )

    # Bare "Password hptourism@123" without colon
    updated = re.sub(
        r"(?i)\b(?:password|passwd|pwd|ultraviewer)\s+([^\s,;]{4,})",
        _replace_labeled,
        updated,
    )

    return updated


def format_speaker_prefix(
    *,
    from_me: bool,
    sender_display_name: str | None = None,
) -> str:
    if from_me:
        return f"[You ({OWNER_DISPLAY_NAME})]"
    name = (sender_display_name or "Contact").strip() or "Contact"
    return f"[Contact ({name})]"


def format_message_line(
    msg: Any,
    *,
    contact_display_name: str | None = None,
    redact: bool = True,
    include_timestamp: bool = True,
) -> str:
    """
    Serialize one message with unambiguous speaker identity.
    from_me True  -> [You (Saurabh)]
    from_me False -> [Contact (<Name>)]
    """
    from_me = coerce_from_me(msg)
    raw_text = str(
        _msg_get(msg, "text", "content", "body", default="") or ""
    ).strip()
    media = str(_msg_get(msg, "media_type", default="") or "").strip()
    if not raw_text and media:
        raw_text = f"[{media}]"
    if not raw_text:
        return ""

    body = redact_sensitive_credentials(raw_text) if redact else raw_text
    if from_me:
        speaker = format_speaker_prefix(from_me=True)
    else:
        name = resolve_sender_display_name(
            msg, contact_display_name=contact_display_name
        )
        speaker = format_speaker_prefix(from_me=False, sender_display_name=name)

    stamp = ""
    if include_timestamp:
        label = format_timestamp_label(message_timestamp(msg))
        if label:
            stamp = f"[{label}] "

    return f"{stamp}{speaker}: {body}"


def _is_cancel_directive(text: str) -> bool:
    """True when the contact is dropping/cancelling work (often via voice note)."""
    body = (text or "").strip()
    if not body:
        return False
    lowered = body.lower()
    has_voice = "[voice note transcript]" in lowered or "[voice note]:" in lowered
    if _CANCEL_OR_DROP_MARKERS.search(body):
        return True
    # Voice notes that defer SMTP/email testing without an ask for Saurabh
    if has_voice and re.search(r"(?i)\b(?:smtp|email\s+testing|localhost)\b", body):
        if re.search(r"(?i)\b(?:nahi|not|don't|dont|chhod|drop|alawa)\b", body):
            return True
    return False


def _looks_like_question(text: str) -> bool:
    body = (text or "").strip()
    if not body:
        return False
    if _ACK_OR_SOFT_FOLLOWUP.match(body):
        return False
    # Cancel/drop voice notes may contain "kya" rhetorically — not a pending ask
    if _is_cancel_directive(body):
        return False
    return bool(_QUESTION_MARKERS.search(body))


def _message_body(msg: Any) -> str:
    return str(_msg_get(msg, "text", "content", "body", default="") or "").strip()


def _preview_text(text: str | None, limit: int = 80) -> str:
    preview = (text or "").replace("\n", " ").strip()
    if len(preview) > limit:
        return preview[: limit - 3] + "…"
    return preview


def detect_answered_turns(messages: list, *, tail_size: int = 10) -> dict:
    """
    Pre-LLM turn-state detector over the recent conversation tail.

    Walks the tail chronologically:
    - Contact question + subsequent You reply  -> RESOLVED_BY_USER (Answered)
    - Contact question with no You reply after -> PENDING_USER_REPLY (Actionable)
    Soft acknowledgements after a resolved answer do not reopen the turn.
    """
    ordered = sort_messages_chronologically(messages)
    if not ordered:
        return {
            "turn_state": TURN_STATE_NONE,
            "resolved": False,
            "pending": False,
            "contact_query_index": None,
            "contact_query_text": None,
            "reply_index": None,
            "reply_text": None,
            "system_hint": "",
            "summary": "No messages available.",
            "tail_size": 0,
        }

    window = max(5, min(int(tail_size or 10), 10))
    tail = ordered[-window:]
    offset = len(ordered) - len(tail)

    open_q_idx: int | None = None
    open_q_text: str | None = None
    last_resolved_q_idx: int | None = None
    last_resolved_q_text: str | None = None
    last_reply_idx: int | None = None
    last_reply_text: str | None = None

    for i, msg in enumerate(tail):
        abs_i = offset + i
        body = _message_body(msg)
        if not body:
            continue
        if coerce_from_me(msg):
            if open_q_idx is not None:
                last_resolved_q_idx = open_q_idx
                last_resolved_q_text = open_q_text
                last_reply_idx = abs_i
                last_reply_text = body
                open_q_idx = None
                open_q_text = None
            continue
        if _looks_like_question(body):
            open_q_idx = abs_i
            open_q_text = body

    if open_q_idx is not None:
        preview = _preview_text(open_q_text)
        return {
            "turn_state": TURN_STATE_PENDING,
            "resolved": False,
            "pending": True,
            "contact_query_index": open_q_idx,
            "contact_query_text": open_q_text,
            "reply_index": None,
            "reply_text": None,
            "system_hint": PENDING_EXTRACTOR_HINT,
            "summary": f"Contact query '{preview}' is still awaiting a reply from You.",
            "tail_size": len(tail),
        }

    if last_resolved_q_idx is not None:
        preview = _preview_text(last_resolved_q_text)
        reply_ref = (
            f"message ID {last_reply_idx}"
            if last_reply_idx is not None
            else "a subsequent You reply"
        )
        summary = (
            f"Contact query regarding '{preview}' was answered by You. "
            "Latest contact message is an acknowledgement."
        )
        system_note = (
            f"[SYSTEM NOTE: Contact query was answered by Saurabh in {reply_ref}. "
            "Set status=DONE]."
        )
        return {
            "turn_state": TURN_STATE_RESOLVED,
            "resolved": True,
            "pending": False,
            "contact_query_index": last_resolved_q_idx,
            "contact_query_text": last_resolved_q_text,
            "reply_index": last_reply_idx,
            "reply_text": last_reply_text,
            "system_hint": f"{system_note} {RESOLVED_EXTRACTOR_HINT}",
            "summary": summary,
            "tail_size": len(tail),
        }

    return {
        "turn_state": TURN_STATE_NONE,
        "resolved": False,
        "pending": False,
        "contact_query_index": None,
        "contact_query_text": None,
        "reply_index": None,
        "reply_text": None,
        "system_hint": "",
        "summary": "No contact query detected in the recent window.",
        "tail_size": len(tail),
    }


def format_messages_for_extraction(
    messages: list,
    *,
    contact_display_name: str | None = None,
    redact: bool = True,
    include_timestamps: bool = True,
) -> str:
    """Chronological speaker-labeled log from Message rows or dicts."""
    lines: list[str] = []
    for msg in sort_messages_chronologically(messages):
        line = format_message_line(
            msg,
            contact_display_name=contact_display_name,
            redact=redact,
            include_timestamp=include_timestamps,
        )
        if line:
            lines.append(line)
    return "\n".join(lines)


def build_extraction_context_block(
    messages: list,
    *,
    chat_name: str,
    chat_jid: str,
    contact_display_name: str | None = None,
    redact: bool = True,
) -> str:
    """Structured conversation block + system turn-state hint for the extractor."""
    ordered = sort_messages_chronologically(messages)
    display = (
        usable_person_name(contact_display_name)
        or usable_person_name(chat_name)
        or (chat_name or "Contact").strip()
        or "Contact"
    )
    body = format_messages_for_extraction(
        ordered,
        contact_display_name=display,
        redact=redact,
        include_timestamps=True,
    )
    turn = detect_answered_turns(ordered)

    parts = [
        f"--- CONVERSATION LOG START ({display} | {chat_jid}) ---",
        body if body else "(no message text in window)",
        "--- CONVERSATION LOG END ---",
    ]
    if turn.get("summary"):
        parts.append(f"[SYSTEM TURN STATE]: {turn['summary']}")
    if turn.get("system_hint"):
        parts.append(f"[SYSTEM STATE HINT]: {turn['system_hint']}")
    parts.append(f"Turn State: {turn.get('turn_state') or TURN_STATE_NONE}")
    return "\n".join(parts)


def resolve_chat_contact_name(
    db: Session,
    chat_jid: str,
    *,
    tenant_jid: str | None = None,
    fallback_name: str | None = None,
) -> str:
    """Resolve display name from contacts / pushName for a chat JID."""
    tenant = (tenant_jid or "").strip()
    if not tenant:
        # Infer tenant from the most recent message for this chat when possible.
        row = (
            db.query(Message.tenant_jid)
            .filter(Message.sender_jid == chat_jid)
            .order_by(Message.timestamp.desc())
            .first()
        )
        tenant = (row[0] if row else "") or "default"

    directory = load_contact_directory(db, tenant, jids=[chat_jid])
    saved_name, notify_name = lookup_contact_labels(directory, chat_jid, None)

    sample = (
        db.query(Message)
        .filter(Message.sender_jid == chat_jid)
        .filter(Message.is_from_me.is_(False))
        .order_by(Message.timestamp.desc())
        .first()
    )
    sender_name = getattr(sample, "sender_name", None) if sample else fallback_name
    phone = getattr(sample, "phone_number", None) if sample else None

    resolved = resolve_chat_label(
        sender_name=sender_name or fallback_name,
        jid=chat_jid,
        phone_number=phone,
        saved_name=saved_name,
        notify_name=notify_name,
    )
    return (resolved or fallback_name or "Contact").strip() or "Contact"


def fetch_recent_messages_for_chat(
    db: Session,
    chat_jid: str,
    *,
    limit: int = 50,
    tenant_jid: str | None = None,
) -> list[Message]:
    """Last `limit` messages for chat_jid, returned ascending by timestamp."""
    query = db.query(Message).filter(Message.sender_jid == chat_jid)
    if tenant_jid:
        query = query.filter(Message.tenant_jid == tenant_jid)
    rows = (
        query.order_by(Message.timestamp.desc())
        .limit(max(1, int(limit or 50)))
        .all()
    )
    return sort_messages_chronologically(rows)


def build_chat_context_for_extraction(
    db: Session,
    chat_jid: str,
    limit: int = 50,
    *,
    tenant_jid: str | None = None,
    chat_name: str | None = None,
) -> str:
    """
    Fetch recent SQLite messages for a chat, apply strict speaker formatting,
    evaluate turn resolution, and return a sanitized LLM briefing block.
    """
    messages = fetch_recent_messages_for_chat(
        db, chat_jid, limit=limit, tenant_jid=tenant_jid
    )
    display = resolve_chat_contact_name(
        db,
        chat_jid,
        tenant_jid=tenant_jid,
        fallback_name=chat_name,
    )
    return build_extraction_context_block(
        messages,
        chat_name=display,
        chat_jid=chat_jid,
        contact_display_name=display,
        redact=True,
    )
