"""
Centralized real-time OpenAI token / cost interceptor.

Tracks per-tenant and per-chat usage across Whisper, Vision, embeddings,
and chat completions. Prints a clean terminal meter on every logged call.
"""

from __future__ import annotations

import threading
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, DefaultDict, Dict, Optional


# Official list prices (USD) used for estimated_cost_usd.
_MODEL_RATES: Dict[str, Dict[str, float]] = {
    "gpt-4o-mini": {"prompt": 0.15 / 1_000_000, "completion": 0.60 / 1_000_000},
    "gpt-4o": {"prompt": 2.50 / 1_000_000, "completion": 10.00 / 1_000_000},
    "text-embedding-3-small": {"prompt": 0.02 / 1_000_000, "completion": 0.0},
    "whisper-1": {"per_minute": 0.006},
}


@dataclass
class UsageBucket:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    estimated_cost_usd: float = 0.0
    calls: int = 0
    by_origin: Dict[str, int] = field(default_factory=dict)
    by_model: Dict[str, int] = field(default_factory=dict)


class TokenTracker:
    """Process-wide singleton that aggregates LLM spend."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._total_cost_usd: float = 0.0
        self._by_tenant: DefaultDict[str, UsageBucket] = defaultdict(UsageBucket)
        self._by_chat: DefaultDict[str, UsageBucket] = defaultdict(UsageBucket)
        self._call_log: list[dict] = []

    @property
    def total_cost_usd(self) -> float:
        with self._lock:
            return self._total_cost_usd

    def reset(self) -> None:
        """Clear all counters (used by unit tests)."""
        with self._lock:
            self._total_cost_usd = 0.0
            self._by_tenant.clear()
            self._by_chat.clear()
            self._call_log.clear()

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "total_cost_usd": self._total_cost_usd,
                "call_count": len(self._call_log),
                "calls": list(self._call_log),
            }

    def estimate_cost(
        self,
        model_name: str,
        *,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        total_tokens: int = 0,
        duration_seconds: float = 0.0,
    ) -> float:
        rates = _MODEL_RATES.get(model_name) or _MODEL_RATES["gpt-4o-mini"]
        if model_name == "whisper-1" or "per_minute" in rates:
            minutes = max(float(duration_seconds), 0.0) / 60.0
            # Fall back to ~1s billed minimum when duration unknown.
            if minutes <= 0:
                minutes = 1.0 / 60.0
            return minutes * float(rates.get("per_minute", 0.006))

        prompt = int(prompt_tokens or 0)
        completion = int(completion_tokens or 0)
        if total_tokens and not (prompt or completion):
            prompt = int(total_tokens)
        return (
            prompt * float(rates.get("prompt", 0.0))
            + completion * float(rates.get("completion", 0.0))
        )

    def record(
        self,
        *,
        call_origin: str,
        chat_jid: str,
        model_name: str,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        total_tokens: int = 0,
        duration_seconds: float = 0.0,
        tenant_id: str = "default",
    ) -> dict:
        prompt = int(prompt_tokens or 0)
        completion = int(completion_tokens or 0)
        total = int(total_tokens or (prompt + completion))
        cost = self.estimate_cost(
            model_name,
            prompt_tokens=prompt,
            completion_tokens=completion,
            total_tokens=total,
            duration_seconds=duration_seconds,
        )

        with self._lock:
            self._total_cost_usd += cost
            cumulative = self._total_cost_usd

            for key, store in (
                (tenant_id or "default", self._by_tenant),
                (chat_jid or "unknown", self._by_chat),
            ):
                bucket = store[key]
                bucket.prompt_tokens += prompt
                bucket.completion_tokens += completion
                bucket.total_tokens += total
                bucket.estimated_cost_usd += cost
                bucket.calls += 1
                bucket.by_origin[call_origin] = bucket.by_origin.get(call_origin, 0) + 1
                bucket.by_model[model_name] = bucket.by_model.get(model_name, 0) + 1

            entry = {
                "call_origin": call_origin,
                "chat_jid": chat_jid,
                "tenant_id": tenant_id,
                "model_name": model_name,
                "prompt_tokens": prompt,
                "completion_tokens": completion,
                "total_tokens": total,
                "estimated_cost_usd": cost,
                "cumulative_cost_usd": cumulative,
            }
            self._call_log.append(entry)

        print(
            f"[TOKEN METER] Origin: {call_origin} | JID: {chat_jid} | "
            f"Tokens: {total} | Cost: ${cost:.6f} | Cumulative: ${cumulative:.4f}"
        )
        return entry


_TRACKER = TokenTracker()


def get_token_tracker() -> TokenTracker:
    return _TRACKER


def _usage_from_response(response: Any) -> tuple[int, int, int, str]:
    """Best-effort extraction of token counts + model from an OpenAI response."""
    usage = getattr(response, "usage", None)
    prompt = int(getattr(usage, "prompt_tokens", 0) or 0) if usage else 0
    completion = int(getattr(usage, "completion_tokens", 0) or 0) if usage else 0
    total = int(getattr(usage, "total_tokens", 0) or (prompt + completion)) if usage else 0

    # Embeddings responses expose usage.total_tokens / prompt_tokens only.
    if usage and not total:
        total = int(getattr(usage, "total_tokens", 0) or 0)
        if not prompt:
            prompt = total

    model_name = str(getattr(response, "model", None) or "").strip()
    return prompt, completion, total, model_name


def log_llm_usage(
    call_origin: str,
    chat_jid: str,
    response: Any,
    duration_seconds: float = 0.0,
    *,
    model_name: Optional[str] = None,
    tenant_id: str = "default",
    prompt_tokens: Optional[int] = None,
    completion_tokens: Optional[int] = None,
    total_tokens: Optional[int] = None,
) -> dict:
    """
    Record one OpenAI call and print the terminal token meter line.

    `response` may be an OpenAI API object (chat/embeddings/whisper) or None
    when callers supply explicit token counts (e.g. Whisper duration billing).
    """
    p, c, t, detected_model = _usage_from_response(response)
    if prompt_tokens is not None:
        p = int(prompt_tokens)
    if completion_tokens is not None:
        c = int(completion_tokens)
    if total_tokens is not None:
        t = int(total_tokens)
    elif not t:
        t = p + c

    resolved_model = (
        (model_name or "").strip()
        or detected_model
        or "gpt-4o-mini"
    )
    # Normalize fine-tuned / dated model ids onto rate-card keys.
    if "whisper" in resolved_model:
        resolved_model = "whisper-1"
    elif "embedding" in resolved_model:
        resolved_model = "text-embedding-3-small"
    elif resolved_model.startswith("gpt-4o-mini"):
        resolved_model = "gpt-4o-mini"
    elif resolved_model.startswith("gpt-4o"):
        resolved_model = "gpt-4o"

    return _TRACKER.record(
        call_origin=call_origin,
        chat_jid=chat_jid or "unknown",
        model_name=resolved_model,
        prompt_tokens=p,
        completion_tokens=c,
        total_tokens=t,
        duration_seconds=duration_seconds,
        tenant_id=tenant_id or "default",
    )
