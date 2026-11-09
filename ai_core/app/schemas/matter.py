"""Layer 3: Structured OpenAI output schemas for Executive Matter extraction."""

from __future__ import annotations

import re
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field, field_validator


class MatterCategory(str, Enum):
    ENGINEERING = "ENGINEERING"  # Code, deployment, admin panels, bugs
    CLIENT_DELIVERY = "CLIENT_DELIVERY"  # Client-facing milestones & handovers
    FINANCIAL_SETTLEMENT = "FINANCIAL_SETTLEMENT"  # Salary, client payments, invoices
    PERSONAL_LIABILITY = "PERSONAL_LIABILITY"  # Borrowed money, personal debts
    DOMESTIC_ERRAND = "DOMESTIC_ERRAND"  # Family commitments, school pickups, etc.


class MatterStatus(str, Enum):
    NEEDS_YOU = "NEEDS_YOU"  # Direct pending action required from Saurabh
    WAITING = "WAITING"  # Waiting for contact/client/third-party response
    DONE = "DONE"  # Task, payment, or handover completely resolved
    DISCARDED = "DISCARDED"  # Task cancelled/dropped (e.g. via audio instruction)


_DUP_DRAFT_SUFFIX = re.compile(
    r"(?:\s*[—\-–]\s*draft\s*reply)+$",
    re.IGNORECASE,
)
_REPEATED_CHUNK = re.compile(
    r"^(.+?)(?:\s*[—\-–]\s*\1)+$",
    re.IGNORECASE,
)


def sanitize_action_label(label: str | None) -> str:
    """Strip duplicated '— draft reply' tails and repeated phrase concatenation."""
    text = (label or "").strip()
    if not text:
        return ""
    # Collapse "… — draft reply — draft reply"
    while _DUP_DRAFT_SUFFIX.search(text):
        text = _DUP_DRAFT_SUFFIX.sub("", text).strip()
    # Collapse "Foo — Foo" style duplication
    match = _REPEATED_CHUNK.match(text)
    if match:
        text = match.group(1).strip()
    return text


class SuggestedAction(BaseModel):
    action_label: str = Field(
        description=(
            "Clean button label WITHOUT redundant suffixes or duplicated phrases. "
            "NEVER emit 'draft reply — draft reply' or any repeated concatenation. "
            "Good example: 'Acknowledge specs to Client'"
        )
    )
    suggested_reply: Optional[str] = Field(
        None,
        description=(
            "Ready-to-send natural Hinglish/English reply draft "
            "if an outbound message is needed"
        ),
    )

    @field_validator("action_label", mode="before")
    @classmethod
    def _clean_action_label(cls, value: object) -> str:
        return sanitize_action_label(str(value) if value is not None else "")


class ExtractedMatter(BaseModel):
    title: str = Field(
        description=(
            "Crisp 3-6 word matter title, e.g., "
            "'October Salary Settlement', 'Trucart Role Isolation'"
        )
    )
    category: MatterCategory
    status: MatterStatus
    summary: str = Field(
        description=(
            "Concise 1-2 sentence executive briefing accurately reflecting who did what. "
            "NEVER invert speakers: statements from [You (Saurabh)] stay attributed to "
            "Saurabh; statements from [Contact (...)] stay with the contact."
        )
    )
    next_step: Optional[str] = Field(
        None,
        description="Concrete next technical or real-world action, or null if Done/Discarded",
    )
    actions: List[SuggestedAction] = Field(
        default_factory=list,
        description=(
            "Contextual quick action drafts (max 2). Omit for DONE/DISCARDED unless "
            "a courtesy ack is useful. Labels must not duplicate phrases."
        ),
    )


class ExtractionResponse(BaseModel):
    matters: List[ExtractedMatter] = Field(
        description=(
            "Genuine independent actionable matters ONLY. "
            "Return [] for pure banter (food, festival jokes, rejected job-offer venting, "
            "Diwali hamper jokes, lunch chat). "
            "Do NOT create cards for HR offers, workplace venting, or GenAI project demos "
            "unless there is a concrete deliverable/liability. "
            "Negative few-shot: job-offer rant + 150rs Diwali hamper joke + lunch talk → 0 cards. "
            "Positive embedded: 'Course - 13000 salary aate hi kar dunga' → exactly 1 "
            "PERSONAL_LIABILITY card."
        )
    )
