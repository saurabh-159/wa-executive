"""Recursive input scanner producing a strictly ordered FIFO work queue."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Iterable


class MediaKind(str, Enum):
    CHAT = "chat"
    AUDIO = "audio"
    IMAGE = "image"
    DOCUMENT = "document"
    UNKNOWN = "unknown"


AUDIO_EXTS = {".mp3", ".ogg", ".wav", ".m4a", ".flac", ".aac", ".wma", ".opus"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif"}
CHAT_EXTS = {".txt", ".json", ".jsonl", ".md", ".csv", ".html", ".htm", ".log"}
DOCUMENT_EXTS = {".pdf", ".doc", ".docx", ".rtf", ".odt"}

SUPPORTED_EXTS = AUDIO_EXTS | IMAGE_EXTS | CHAT_EXTS | DOCUMENT_EXTS


@dataclass(frozen=True, slots=True)
class QueuedFile:
    """One work item in the FIFO processing queue."""

    index: int
    path: Path
    kind: MediaKind
    size_bytes: int
    sha256: str

    @property
    def name(self) -> str:
        return self.path.name

    def relative_to(self, root: Path) -> str:
        try:
            return str(self.path.relative_to(root))
        except ValueError:
            return str(self.path)


def classify(path: Path) -> MediaKind:
    ext = path.suffix.lower()
    if ext in AUDIO_EXTS:
        return MediaKind.AUDIO
    if ext in IMAGE_EXTS:
        return MediaKind.IMAGE
    if ext in CHAT_EXTS:
        return MediaKind.CHAT
    if ext in DOCUMENT_EXTS:
        return MediaKind.DOCUMENT
    return MediaKind.UNKNOWN


def _file_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _iter_candidate_files(root: Path) -> Iterable[Path]:
    if root.is_file():
        yield root
        return
    # Deterministic lexical order for stable FIFO across restarts.
    for path in sorted(root.rglob("*")):
        if path.is_file() and not path.name.startswith("."):
            yield path


def scan_input(input_path: Path) -> list[QueuedFile]:
    """
    Recursively discover supported media/chat/document files.

    Returns a FIFO-ordered list (alphabetical by absolute path) with stable
    0-based indices used as the processing cursor.
    """
    root = input_path.resolve()
    if not root.exists():
        raise FileNotFoundError(f"Input path does not exist: {root}")

    queue: list[QueuedFile] = []
    for path in _iter_candidate_files(root):
        kind = classify(path)
        if kind is MediaKind.UNKNOWN:
            continue
        try:
            size = path.stat().st_size
            digest = _file_sha256(path)
        except OSError:
            continue
        queue.append(
            QueuedFile(
                index=len(queue),
                path=path,
                kind=kind,
                size_bytes=size,
                sha256=digest,
            )
        )
    return queue
