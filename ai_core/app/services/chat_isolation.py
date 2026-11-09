"""Load one chat's messages without letting any other JID into the transcript."""
from sqlalchemy import or_
from app.models.message import Message
import re

from app.models.message import Message

# WhatsApp lanes that are never a personal thread.
_BROADCAST_SUFFIXES = ("@broadcast", "@newsletter")

# Name of an announce-only room, not a working group that happens to say "community".
_ANNOUNCEMENT_NAME_RE = re.compile(
    r"\b(announcements?|newsletter|webinars?|broadcast channel|alerts channel)\b",
    re.IGNORECASE,
)

# Mass posts. A single GitHub link in a working group is not enough on its own.
_MASS_ALERT_RE = re.compile(
    r"("
    r"\beveryone\b|"
    r"\bguys\b|"
    r"join now|please join|joining today'?s|"
    r"session (is|will)|"
    r"don'?t miss|"
    r"upvote this|"
    r"book your seat|"
    r"register (now|and|here)|"
    r"webinars?|"
    r"zoom\.us|"
    r"meet\.google\.com|"
    r"comment [\"“][^\"”]{0,24}[\"”] to get"
    r")",
    re.IGNORECASE,
)

# Explicit @mention or a line that asks this user for a personal reply.
_PERSONAL_DEMAND_RE = re.compile(
    r"("
    r"@\d{6,}"
    r"|please reply|reply personally|dm me"
    r"|message me (personally|directly)"
    r"|only you|tum hi|aap hi|tumhe hi|aapko hi"
    r"|1[- ]?on[- ]?1|one[- ]on[- ]one"
    r"|mujhe (call|batao|bhej)|call me personally"
    r"|aap reply|tum reply|you specifically"
    r")",
    re.IGNORECASE,
)


def _text(msg) -> str:
    return str(getattr(msg, "text", None) or "").strip()


def is_broadcast_lane(jid: str) -> bool:
    """status@broadcast, list broadcasts, and newsletter channels."""
    chat_id = str(jid or "").strip().lower()
    if not chat_id or chat_id == "status@broadcast":
        return True
    return chat_id.endswith(_BROADCAST_SUFFIXES)


def is_group_chat(jid: str, messages: list | None = None) -> bool:
    if str(jid or "").strip().endswith("@g.us"):
        return True
    return any(bool(getattr(msg, "is_group", False)) for msg in (messages or []))


def demands_personal_response(messages: list) -> bool:
    """True when this user was @mentioned or asked for a direct reply."""
    for msg in messages or []:
        if getattr(msg, "is_from_me", False):
            continue
        if bool(getattr(msg, "mentions_user", False)):
            return True
        if _PERSONAL_DEMAND_RE.search(_text(msg)):
            return True
    return False


def is_announcement_channel(jid: str, name: str, messages: list) -> bool:
    """
    Community / announcement rooms and broadcast channels.
    A normal working group (questions, back-and-forth) is not one of these.
    """
    if is_broadcast_lane(jid):
        return True
    if not is_group_chat(jid, messages):
        return False
    if _ANNOUNCEMENT_NAME_RE.search(name or ""):
        return True

    inbound = [msg for msg in (messages or []) if not getattr(msg, "is_from_me", False) and _text(msg)]
    if len(inbound) < 2:
        return False
    mass_hits = sum(1 for msg in inbound if _MASS_ALERT_RE.search(_text(msg)))
    return mass_hits >= 2 and (mass_hits / len(inbound)) >= 0.5


def should_skip_needs_you_card(jid: str, name: str, messages: list) -> bool:
    """Do not auto-open a high-priority card for a mass post that never addresses the user."""
    if not is_announcement_channel(jid, name, messages):
        return False
    return not demands_personal_response(messages)

 

def fetch_isolated_messages(db, jid: str, limit: int = 12, tenant_jid: str = "guest_unlinked") -> list:
    """
    Messages for this chat strictly scoped to the tenant_jid.
    Prevents cross-user transcript leakage when two tenants share a common group/contact.
    Handles Outgoing (is_from_me), Phone JIDs, and LID mappings seamlessly.
    """
    chat_id = str(jid or "").strip()
    t_jid = str(tenant_jid or "").strip()

    # 1. Reject unlinked guest context immediately
    if not t_jid or t_jid == "guest_unlinked":
        return []

    # 2. Skip broadcast channels / newsletters
    if is_broadcast_lane(chat_id):
        return []

    # 3. Resolve phone digits if 1:1 chat to match both phone & LID aliases
    clean_digits = "".join(ch for ch in chat_id.split("@")[0] if ch.isdigit())
    target_conditions = [Message.sender_jid == chat_id]
    
    # Agar phone number hai toh @s.whatsapp.net aur raw digits dono allow karein
    if clean_digits and len(clean_digits) >= 10:
        target_conditions.append(Message.sender_jid == f"{clean_digits}@s.whatsapp.net")
        if hasattr(Message, "phone_number"):
            target_conditions.append(Message.phone_number == clean_digits)

    # 4. Strictly scoped query with exclusion of Baileys sync placeholders
    query = (
        db.query(Message)
        .filter(Message.tenant_jid == t_jid)
        .filter(or_(*target_conditions))
        .filter(~Message.message_id.like("sync-ph:%"))
    )

    rows = (
        query.order_by(Message.timestamp.desc())
        .limit(max(1, int(limit)))
        .all()
    )

    # Chronological order for AI Context synthesis
    rows.reverse()
    return rows