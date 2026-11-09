"""Runtime configuration loaded from environment / CLI flags."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


@dataclass
class Settings:
    input_path: Path
    output_dir: Path
    api_key: str = field(default_factory=lambda: (os.getenv("OPENAI_API_KEY") or "").strip())
    chat_model: str = field(
        default_factory=lambda: os.getenv("OPENAI_CHAT_MODEL", "gpt-4o-mini").strip()
    )
    vision_model: str = field(
        default_factory=lambda: os.getenv("OPENAI_VISION_MODEL", "gpt-4o-mini").strip()
    )
    transcribe_model: str = field(
        default_factory=lambda: os.getenv("OPENAI_TRANSCRIBE_MODEL", "whisper-1").strip()
    )
    dry_run: bool = False
    max_retries: int = 3
    reset_state: bool = False

    @property
    def state_path(self) -> Path:
        return self.output_dir / "state.json"

    @property
    def results_path(self) -> Path:
        return self.output_dir / "results.jsonl"

    @property
    def process_log_path(self) -> Path:
        return self.output_dir / "process.log"

    @property
    def error_log_path(self) -> Path:
        return self.output_dir / "error.log"

    def ensure_dirs(self) -> None:
        self.output_dir.mkdir(parents=True, exist_ok=True)
