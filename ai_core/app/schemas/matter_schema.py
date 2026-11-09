from typing import List

from pydantic import BaseModel, Field


class ActionChecklistItem(BaseModel):
    text: str = Field(description="Clear, actionable task description")
    done: bool = Field(default=False)


class SingleMatterOutput(BaseModel):
    headline: str = Field(
        description=(
            "Crisp 4-6 word title summarizing this specific matter/issue, "
            "e.g. 'Trucart UPI and coupon bugs', 'Rs 9500 balance payment'"
        )
    )
    summary: str = Field(
        description=(
            "One dense sentence detailing what was reported or requested, "
            "who needs to act, and key numbers or links."
        )
    )
    status_filter: str = Field(
        description=(
            "Classify as 'Needs you' (if user owes action/reply), "
            "'Waiting' (if waiting on them), or 'Later' (low priority/parked)"
        )
    )
    priority_dot: str = Field(
        description=(
            "'red' for urgent/blockers/payments, "
            "'orange' for standard pending work, "
            "'green' for resolved/stable"
        )
    )
    timestamp_display: str = Field(
        description=(
            "Relative time marker of this specific event, "
            "e.g. '15:37', 'Yesterday', '04-Nov-26'"
        )
    )
    action_checklist: List[ActionChecklistItem] = Field(
        description="Checklist of next steps strictly for this specific matter"
    )
    suggested_quick_replies: List[str] = Field(
        description="1-click direct response options relevant to this matter"
    )
    resolved_notes: List[str] = Field(
        default_factory=list,
        description="Any prior sub-issues in this thread that are already settled/done",
    )


class ChatMatterSplitResult(BaseModel):
    matters: List[SingleMatterOutput] = Field(
        description=(
            "List of distinct independent matters/topics extracted from this chat thread. "
            "If multiple unrelated issues were discussed, split them into separate matters."
        )
    )
