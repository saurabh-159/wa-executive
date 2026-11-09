"""Shared WhatsApp JID, contact-name, and chat-preview helpers."""

from __future__ import annotations

import re
from datetime import datetime

_LID_NAME_RE = re.compile(r"^\d{14,}$")


def digits_of(value: str | None) -> str:
    return "".join(ch for ch in str(value or "").split("@")[0] if ch.isdigit())


def is_lid_jid(jid: str | None) -> bool:
    value = str(jid or "")
    return value.endswith("@lid") or value.endswith("@hosted.lid")


def is_group_jid(jid: str | None) -> bool:
    return str(jid or "").endswith("@g.us")


def is_real_phone_digits(value: str | None) -> bool:
    digits = digits_of(value) if value and not str(value).isdigit() else str(value or "")
    if not digits.isdigit():
        digits = digits_of(value)
    if not digits:
        return False
    if len(digits) == 10:
        return True
    if len(digits) == 12 and digits.startswith("91"):
        return True
    return 11 <= len(digits) <= 13


def is_phone_jid(jid: str | None) -> bool:
    value = str(jid or "")
    if not (value.endswith("@s.whatsapp.net") or value.endswith("@hosted")):
        return False
    return is_real_phone_digits(digits_of(value))


def is_raw_lid_name(name: str | None) -> bool:
    """True for bare LID user ids such as 159378317541470."""
    compact = re.sub(r"[\s+().-]", "", str(name or ""))
    return bool(_LID_NAME_RE.fullmatch(compact))


_WEAK_PERSON_LABELS = {
    "unknown",
    "unknown contact",
    "whatsapp contact",
    "whatsapp",
    "contact",
    "user",
    "group",
    "whatsapp group",
    ".",
    "you",
}


def is_self_chat_label(name: str | None) -> bool:
    cleaned = str(name or "").strip().casefold()
    return cleaned.startswith("you (self)") or cleaned.startswith("note to self")


def is_phone_label(name: str | None) -> bool:
    """True when a stored 'name' is really a formatted or masked phone number."""
    raw = str(name or "").strip()
    if not raw or is_self_chat_label(raw):
        return False
    # Any unicode letter means this is a person or group label, not a number.
    if re.search(r"[^\W\d_]", raw, flags=re.UNICODE):
        return False
    if raw.startswith("+"):
        return True
    digits = re.sub(r"\D", "", raw)
    compact = re.sub(r"[\s().\-]", "", raw)
    return bool(re.fullmatch(r"\d{10,15}", digits) and compact.isdigit())


def usable_person_name(name: str | None) -> str | None:
    """
    Phonebook / push / message label worth showing.
    Formatted numbers, LID ids, and placeholders are not names.
    """
    cleaned = str(name or "").strip()
    if not cleaned or is_self_chat_label(cleaned):
        return None
    if is_phone_label(cleaned) or is_raw_lid_name(cleaned):
        return None
    if "@" in cleaned or cleaned.casefold() in _WEAK_PERSON_LABELS:
        return None
    return cleaned


def resolve_chat_label(
    sender_name: str | None,
    jid: str | None,
    phone_number: str | None = None,
    saved_name: str | None = None,
    notify_name: str | None = None,
) -> str:
    """
    Display hierarchy:
    contacts.name (Google Contacts preferred once synced)
    -> contacts.notify_name -> messages.sender_name -> formatted phone.
    """
    if is_self_chat_label(sender_name):
        return str(sender_name).strip()
    resolved = (
        usable_person_name(saved_name)
        or usable_person_name(notify_name)
        or usable_person_name(sender_name)
        or format_phone(phone_number or jid)
    )
    if resolved:
        return resolved
    fallback = str(sender_name or "").strip()
    if fallback and not is_phone_label(fallback):
        return fallback
    local = str(jid or "").split("@")[0]
    return local or "Unknown Contact"


def format_phone(jid_or_digits: str | None) -> str:
    digits = digits_of(jid_or_digits)
    if not is_real_phone_digits(digits):
        return ""
    if len(digits) == 12 and digits.startswith("91"):
        return f"+91 {digits[2:7]} {digits[7:]}"
    if len(digits) == 10:
        return f"+91 {digits[:5]} {digits[5:]}"
    return f"+{digits}"


def canonical_chat_jid(chat_jid: str | None, phone_number: str | None = None) -> tuple[str, str | None]:
    """
    Store 1:1 threads on the phone JID.
    Returns (chat_jid, phone_digits or None). Groups stay on @g.us.
    """
    chat = str(chat_jid or "").strip()
    phone = digits_of(phone_number) or (digits_of(chat) if is_phone_jid(chat) else "")
    if is_group_jid(chat):
        return chat, None
    if is_real_phone_digits(phone):
        return f"{phone}@s.whatsapp.net", phone
    return chat, None


def is_sync_placeholder(message_id: str | None) -> bool:
    return str(message_id or "").startswith("sync-ph:")


def preview_text(text: str | None, media_type: str | None) -> str:
    raw = (text or "").strip()
    media = (media_type or "").strip().lower()
    lowered = raw.lower()
    if lowered.startswith("[voice note]:") and len(raw) > len("[Voice Note]:"):
        return raw
    if media == "audio" or lowered in {"[voice note]", "[audio]"}:
        return "[Voice Note]"
    if media == "image" or lowered in {"[photo]", "[image]"}:
        return "[Photo]"
    if raw and raw != "[Media]":
        return raw
    if media == "video":
        return "[Video]"
    return ""


def format_last_message_time(timestamp: int | None) -> str:
    try:
        stamp = int(timestamp or 0)
    except (TypeError, ValueError):
        return ""
    if stamp <= 0:
        return ""
    if stamp > 10**12:
        stamp //= 1000
    moment = datetime.fromtimestamp(stamp)
    now = datetime.now()
    day_delta = (
        datetime(now.year, now.month, now.day) - datetime(moment.year, moment.month, moment.day)
    ).days
    if day_delta == 0:
        return moment.strftime("%I:%M %p").lstrip("0")
    if day_delta == 1:
        return "Yesterday"
    if 1 < day_delta < 7:
        return moment.strftime("%a")
    return moment.strftime("%d %b")
