import re
from typing import List

from app.schemas.matter_schema import SingleMatterOutput

# Words that indicate informal banter or sarcasm, not ledger transactions
FRIVOLOUS_FINANCE_TRIGGERS = [
    r"hamper",
    r"diwali",
    r"gift",
    r"chocolate",
    r"party",
    r"treat",
    r"samosa",
    r"crorepati",
    r"lakhpati",
    r"shagun",
    r"pepsi",
]


def sanitize_and_validate_matters(matters: List[SingleMatterOutput]) -> List[SingleMatterOutput]:
    """
    Enforces post-LLM validation to eliminate hallucinated or frivolous cards.
    """
    validated: List[SingleMatterOutput] = []

    for matter in matters:
        headline_clean = matter.headline.strip()
        headline_lower = headline_clean.lower()
        summary_lower = matter.summary.lower()

        # Guardrail 1: Block Frivolous/Joke Payment Tasks
        has_frivolous_word = any(
            re.search(pat, headline_lower) or re.search(pat, summary_lower)
            for pat in FRIVOLOUS_FINANCE_TRIGGERS
        )
        has_money_marker = any(
            m in headline_lower for m in ["rs", "₹", "payment", "rupaye", "transfer"]
        )

        if has_money_marker and has_frivolous_word:
            print(f"[Guardrails] Blocked frivolous payment card: '{matter.headline}'")
            continue

        # Guardrail 2: Ensure Action Items exist for 'Needs you'
        if matter.status_filter == "Needs you" and not matter.action_checklist:
            # If nothing actionable was provided, downgrade status
            matter.status_filter = "Waiting"

        # Guardrail 3: Quality Check on Headlines
        words = headline_clean.split()
        if len(words) < 2:
            print(f"[Guardrails] Dropped low-quality single-word card: '{matter.headline}'")
            continue

        validated.append(matter)

    return validated
