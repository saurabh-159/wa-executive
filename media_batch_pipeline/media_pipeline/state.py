"""Checkpoint persistence — atomic state.json writes after every step."""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class PipelineState:
    """Cursor + audit fields restored on restart."""

    input_path: str = ""
    current_index: int = 0
    total_files: int = 0
    last_successful_file: str | None = None
    last_successful_index: int | None = None
    processed_sha256: list[str] = field(default_factory=list)
    skipped: list[dict[str, Any]] = field(default_factory=list)
    failed: list[dict[str, Any]] = field(default_factory=list)
    succeeded: int = 0
    status: str = "idle"  # idle | running | completed | interrupted
    updated_at: str = field(default_factory=_utc_now)
    created_at: str = field(default_factory=_utc_now)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PipelineState":
        known = {f.name for f in cls.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        filtered = {k: v for k, v in data.items() if k in known}
        return cls(**filtered)

    def mark_success(self, index: int, path: str, sha256: str) -> None:
        self.current_index = index + 1
        self.last_successful_file = path
        self.last_successful_index = index
        self.succeeded += 1
        if sha256 not in self.processed_sha256:
            self.processed_sha256.append(sha256)
        self.updated_at = _utc_now()

    def mark_skip(self, index: int, path: str, reason: str, sha256: str | None = None) -> None:
        self.current_index = index + 1
        self.skipped.append(
            {
                "index": index,
                "path": path,
                "reason": reason,
                "at": _utc_now(),
            }
        )
        if sha256 and sha256 not in self.processed_sha256:
            self.processed_sha256.append(sha256)
        self.updated_at = _utc_now()

    def mark_failure(self, index: int, path: str, error: str) -> None:
        """Advance cursor after exhausting retries so resume does not loop forever."""
        self.current_index = index + 1
        self.failed.append(
            {
                "index": index,
                "path": path,
                "error": error,
                "at": _utc_now(),
            }
        )
        self.updated_at = _utc_now()


class StateStore:
    """Load / save pipeline checkpoints with atomic replace."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> PipelineState | None:
        if not self.path.exists():
            return None
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                return None
            return PipelineState.from_dict(raw)
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            return None

    def save(self, state: PipelineState) -> None:
        state.updated_at = _utc_now()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(state.to_dict(), indent=2, ensure_ascii=False)
        fd, tmp_name = tempfile.mkstemp(
            prefix=".state_",
            suffix=".tmp",
            dir=str(self.path.parent),
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_name, self.path)
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    def reset(self) -> None:
        if self.path.exists():
            self.path.unlink()
