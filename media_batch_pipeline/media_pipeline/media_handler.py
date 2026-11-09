"""Media integrity checks — duration, dimensions, corrupt/unsupported detection."""

from __future__ import annotations

import wave
from dataclasses import dataclass
from pathlib import Path

from .scanner import MediaKind, QueuedFile


@dataclass(frozen=True, slots=True)
class IntegrityResult:
    ok: bool
    detail: str
    duration_sec: float | None = None
    width: int | None = None
    height: int | None = None


class CorruptMediaError(Exception):
    """Raised when a file fails integrity validation."""

    def __init__(self, path: Path, reason: str) -> None:
        self.path = path
        self.reason = reason
        super().__init__(f"{path}: {reason}")


def _check_image(path: Path) -> IntegrityResult:
    from PIL import Image

    try:
        with Image.open(path) as img:
            img.verify()
        with Image.open(path) as img:
            width, height = img.size
            if width <= 0 or height <= 0:
                return IntegrityResult(False, "image has zero dimensions")
            return IntegrityResult(
                True,
                f"image {width}x{height} {img.format or 'unknown'}",
                width=width,
                height=height,
            )
    except Exception as exc:
        return IntegrityResult(False, f"corrupt or unreadable image: {exc}")


def _check_wav(path: Path) -> IntegrityResult:
    try:
        with wave.open(str(path), "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate()
            if rate <= 0:
                return IntegrityResult(False, "wav has invalid sample rate")
            duration = frames / float(rate)
            if duration <= 0:
                return IntegrityResult(False, "wav has zero duration")
            return IntegrityResult(True, f"wav duration={duration:.2f}s", duration_sec=duration)
    except Exception as exc:
        return IntegrityResult(False, f"corrupt wav: {exc}")


def _check_audio_mutagen(path: Path) -> IntegrityResult:
    try:
        from mutagen import File as MutagenFile

        audio = MutagenFile(str(path))
        if audio is None:
            return IntegrityResult(False, "unsupported or corrupt audio container")
        length = getattr(getattr(audio, "info", None), "length", None)
        if length is None:
            # Some formats may lack length; accept if file has a parsable header.
            if path.stat().st_size <= 0:
                return IntegrityResult(False, "empty audio file")
            return IntegrityResult(True, "audio header ok (duration unknown)")
        duration = float(length)
        if duration <= 0:
            return IntegrityResult(False, "audio has zero duration")
        return IntegrityResult(True, f"audio duration={duration:.2f}s", duration_sec=duration)
    except Exception as exc:
        return IntegrityResult(False, f"corrupt audio: {exc}")


def _check_audio(path: Path) -> IntegrityResult:
    if path.suffix.lower() == ".wav":
        result = _check_wav(path)
        if result.ok:
            return result
        # Fall through to mutagen for edge-case wav variants.
    return _check_audio_mutagen(path)


def _check_chat(path: Path) -> IntegrityResult:
    try:
        size = path.stat().st_size
        if size <= 0:
            return IntegrityResult(False, "empty chat/transcript file")
        # Probe decode — tolerate mixed encodings by trying utf-8 then latin-1.
        raw = path.read_bytes()[:8192]
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError:
            raw.decode("latin-1")
        return IntegrityResult(True, f"chat/transcript readable ({size} bytes)")
    except Exception as exc:
        return IntegrityResult(False, f"unreadable chat file: {exc}")


def _check_document(path: Path) -> IntegrityResult:
    try:
        size = path.stat().st_size
        if size <= 0:
            return IntegrityResult(False, "empty document")
        header = path.read_bytes()[:8]
        ext = path.suffix.lower()
        if ext == ".pdf" and not header.startswith(b"%PDF"):
            return IntegrityResult(False, "pdf missing %PDF magic header")
        return IntegrityResult(True, f"document ok ({size} bytes)")
    except Exception as exc:
        return IntegrityResult(False, f"unreadable document: {exc}")


def validate_media(item: QueuedFile) -> IntegrityResult:
    """Return integrity details; never raises — caller decides skip vs fail."""
    if not item.path.exists():
        return IntegrityResult(False, "file missing on disk")
    if item.size_bytes <= 0:
        return IntegrityResult(False, "zero-byte file")

    if item.kind is MediaKind.IMAGE:
        return _check_image(item.path)
    if item.kind is MediaKind.AUDIO:
        return _check_audio(item.path)
    if item.kind is MediaKind.CHAT:
        return _check_chat(item.path)
    if item.kind is MediaKind.DOCUMENT:
        return _check_document(item.path)
    return IntegrityResult(False, f"unsupported kind: {item.kind}")


def assert_valid(item: QueuedFile) -> IntegrityResult:
    result = validate_media(item)
    if not result.ok:
        raise CorruptMediaError(item.path, result.detail)
    return result
