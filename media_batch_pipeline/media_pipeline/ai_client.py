"""AI API client with tenacity exponential-backoff retries."""

from __future__ import annotations

import base64
import logging
import mimetypes
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
    before_sleep_log,
)

from .config import Settings
from .scanner import MediaKind, QueuedFile

logger = logging.getLogger("media_pipeline.process")


class AIProcessingError(Exception):
    """Transient or permanent AI API failure."""


@dataclass(frozen=True, slots=True)
class AIResult:
    text: str
    model: str
    latency_sec: float
    tokens: int | None
    raw_preview: str


def _mime_for(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or "application/octet-stream"


class AIClient:
    """Thin OpenAI wrapper — chat transcripts, Whisper audio, Vision images."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client = None
        if not settings.dry_run:
            if not settings.api_key:
                raise AIProcessingError(
                    "OPENAI_API_KEY is missing. Set it in the environment or .env file."
                )
            from openai import OpenAI

            self._client = OpenAI(api_key=settings.api_key)

    def process(self, item: QueuedFile, integrity_detail: str) -> AIResult:
        started = time.perf_counter()
        if self.settings.dry_run:
            text = f"[dry-run] would process {item.kind.value}: {item.path.name} ({integrity_detail})"
            return AIResult(
                text=text,
                model="dry-run",
                latency_sec=time.perf_counter() - started,
                tokens=None,
                raw_preview=text,
            )

        if item.kind is MediaKind.AUDIO:
            result = self._transcribe(item.path)
        elif item.kind is MediaKind.IMAGE:
            result = self._vision(item.path)
        elif item.kind is MediaKind.CHAT:
            result = self._summarize_text(item.path, kind_label="chat transcript")
        elif item.kind is MediaKind.DOCUMENT:
            result = self._summarize_text(item.path, kind_label="document")
        else:
            raise AIProcessingError(f"unsupported media kind: {item.kind}")

        latency = time.perf_counter() - started
        return AIResult(
            text=result["text"],
            model=result["model"],
            latency_sec=latency,
            tokens=result.get("tokens"),
            raw_preview=result["text"][:500],
        )

    def _transcribe(self, path: Path) -> dict[str, Any]:
        @_retryable_method(self)
        def _call() -> dict[str, Any]:
            assert self._client is not None
            try:
                with path.open("rb") as handle:
                    transcript = self._client.audio.transcriptions.create(
                        model=self.settings.transcribe_model,
                        file=handle,
                    )
                text = (getattr(transcript, "text", None) or "").strip()
                return {
                    "text": text or "[empty transcript]",
                    "model": self.settings.transcribe_model,
                    "tokens": None,
                }
            except Exception as exc:
                raise AIProcessingError(f"transcription failed: {exc}") from exc

        return _call()

    def _vision(self, path: Path) -> dict[str, Any]:
        @_retryable_method(self)
        def _call() -> dict[str, Any]:
            assert self._client is not None
            try:
                data = path.read_bytes()
                b64 = base64.b64encode(data).decode("ascii")
                mime = _mime_for(path)
                data_url = f"data:{mime};base64,{b64}"
                completion = self._client.chat.completions.create(
                    model=self.settings.vision_model,
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "text",
                                    "text": (
                                        "Extract all visible facts from this image. "
                                        "Be concise and factual."
                                    ),
                                },
                                {
                                    "type": "image_url",
                                    "image_url": {"url": data_url},
                                },
                            ],
                        }
                    ],
                )
                text = (completion.choices[0].message.content or "").strip()
                usage = getattr(completion, "usage", None)
                tokens = getattr(usage, "total_tokens", None) if usage else None
                return {
                    "text": text or "[empty vision response]",
                    "model": self.settings.vision_model,
                    "tokens": tokens,
                }
            except Exception as exc:
                raise AIProcessingError(f"vision failed: {exc}") from exc

        return _call()

    def _summarize_text(self, path: Path, kind_label: str) -> dict[str, Any]:
        @_retryable_method(self)
        def _call() -> dict[str, Any]:
            assert self._client is not None
            try:
                # Cap prompt size for large transcripts/docs.
                raw = path.read_text(encoding="utf-8", errors="replace")
                excerpt = raw[:12000]
                completion = self._client.chat.completions.create(
                    model=self.settings.chat_model,
                    messages=[
                        {
                            "role": "system",
                            "content": (
                                "You are an executive assistant. Summarize the "
                                f"{kind_label}, list action items, and note open questions."
                            ),
                        },
                        {
                            "role": "user",
                            "content": f"File: {path.name}\n\n{excerpt}",
                        },
                    ],
                )
                text = (completion.choices[0].message.content or "").strip()
                usage = getattr(completion, "usage", None)
                tokens = getattr(usage, "total_tokens", None) if usage else None
                return {
                    "text": text or "[empty summary]",
                    "model": self.settings.chat_model,
                    "tokens": tokens,
                }
            except Exception as exc:
                raise AIProcessingError(f"text processing failed: {exc}") from exc

        return _call()


def _retryable_method(client: AIClient):
    """Decorator factory so max_retries comes from settings at call time."""
    return retry(
        reraise=True,
        stop=stop_after_attempt(client.settings.max_retries),
        wait=wait_exponential(multiplier=1, min=1, max=20),
        retry=retry_if_exception_type((AIProcessingError, OSError, TimeoutError)),
        before_sleep=before_sleep_log(logger, logging.WARNING),
    )
