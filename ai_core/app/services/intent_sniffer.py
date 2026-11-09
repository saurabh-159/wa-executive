"""Zero-token regex gate for high-intent business / financial / technical messages."""

from __future__ import annotations

import re

# Word-boundary patterns; multi-word Hindi/Hinglish phrases use \\s+.
_HIGH_INTENT_PATTERNS: tuple[str, ...] = (
    # Software / Engineering
    r"\bproject\b",
    r"\bwebsite\b",
    r"\bapp\b",
    r"\bdeploy\b",
    r"\bdatabase\b",
    r"\bapi\b",
    r"\bbug\b",
    r"\bcrash\b",
    r"\berror\b",
    r"\bserver\b",
    # Finance / Debt
    r"\brupaye\b",
    r"\brs\b",
    r"\binr\b",
    r"\bpayment\b",
    r"\bsalary\b",
    r"\btransfer\b",
    r"\bgpay\b",
    r"\bpaytm\b",
    r"\badvance\b",
    r"\binvoice\b",
    r"\bdue\b",
    r"\bdebt\b",
    # Time-sensitive tasks
    r"\burgent\b",
    r"\basap\b",
    r"\bdeadline\b",
    r"\bkal\s+tak\b",
    r"\baaj\s+shaam\b",
    r"\bbhej\s+do\b",
    r"\bstatus\b",
    r"\bmeeting\b",
    r"\bcall\b",
    # Inquiry / Leads
    r"\brequirement\b",
    r"\bpricing\b",
    r"\bquote\b",
    r"\bbudget\b",
    r"\bcost\b",
)

_HIGH_INTENT_RE = re.compile(
    "|".join(f"(?:{p})" for p in _HIGH_INTENT_PATTERNS),
    re.IGNORECASE,
)


def is_high_intent_message(text: str) -> bool:
    """Return True when text matches any high-intent business/finance/tech pattern."""
    if not text or not str(text).strip():
        return False
    return _HIGH_INTENT_RE.search(str(text)) is not None
