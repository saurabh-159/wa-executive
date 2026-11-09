"""
Layer 1 multimodal extraction: Whisper-1 voice notes + GPT-4o-mini Vision OCR.
Never raises to callers — failures return a safe placeholder string.

Zero-waste guards:
  - Skip Vision when chat is not monitored
  - Skip Vision for tiny payloads (<5KB) and sticker-like captions
  - Skip Vision for clearly social captions (greetings / memes / selfies)
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import re
import time
from typing import Optional

from openai import OpenAI

from app.config import settings
from app.services.token_tracker import log_llm_usage

logger = logging.getLogger(__name__)

VISION_PROMPT = (
    "Accurately extract all visible facts from this WhatsApp image: "
    "(1) If payment receipt: extract amount, sender, receiver, transaction ID, "
    "and status (Success/Paid/Failed). "
    "(2) If error screenshot or UI log: extract error name, code, and affected "
    "file/button. "
    "(3) If remote login or credentials: note system name and login ID. "
    "If the image is a sticker, meme, selfie, or greeting with no readable "
    "business/financial/error text, reply exactly: NO_RELEVANT_TEXT. "
    "Keep output factual and concise under 50 words."
)

MEDIA_UNAVAILABLE = "\n[Media extraction unavailable]"
MIN_VISION_BYTES = 5 * 1024  # Skip thumbnails / emoji stickers under 5KB

_STICKER_CAPTION_RE = re.compile(
    r"\b(sticker|animated\s*sticker|webp\s*sticker)\b",
    re.IGNORECASE,
)
_SOCIAL_CAPTION_RE = re.compile(
    r"\b("
    r"meme|selfie|diwali|holi|eid|christmas|birthday|anniversary|"
    r"good\s*morning|good\s*night|congratulations|congrats|"
    r"lol|lmao|haha|hehe|❤️|😂|🙏|dandavat|hare\s*krishna"
    r")\b",
    re.IGNORECASE,
)
_OCR_HINT_RE = re.compile(
    r"\b("
    r"receipt|invoice|payment|paid|upi|gpay|paytm|phonepe|neft|imps|"
    r"error|exception|traceback|screenshot|crash|bug|"
    r"bill|amount|rs\.?|inr|₹|salary|transfer|otp|password|login"
    r")\b",
    re.IGNORECASE,
)

_client: Optional[OpenAI] = None


def _get_client() -> Optional[OpenAI]:
    global _client
    if _client is not None:
        return _client
    api_key = (settings.OPENAI_API_KEY or "").strip()
    if not api_key:
        logger.error("[MediaProcessor Error]: OPENAI_API_KEY missing")
        return None
    try:
        _client = OpenAI(api_key=api_key)
    except Exception as exc:
        logger.error("[MediaProcessor Error]: %s", str(exc))
        return None
    return _client


def _pad_b64(raw: str) -> bytes:
    """Decode base64 with tolerant padding; raises ValueError on bad input."""
    cleaned = (raw or "").strip()
    if not cleaned:
        raise ValueError("empty base64")
    if "," in cleaned and cleaned.lower().startswith("data:"):
        cleaned = cleaned.split(",", 1)[1]
    cleaned = "".join(cleaned.split())
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=")
    cleaned = "".join(ch for ch in cleaned if ch in allowed)
    if not cleaned:
        raise ValueError("empty base64 after sanitize")
    pad = (-len(cleaned)) % 4
    if pad:
        cleaned += "=" * pad
    try:
        return base64.b64decode(cleaned, validate=False)
    except Exception as exc:
        raise ValueError(f"base64 decode failed: {exc}") from exc


def _image_data_url(media_base64: str, image_bytes: bytes) -> str:
    """Prefer caller base64 for JPEG WhatsApp images; sniff mime from magic bytes."""
    cleaned = (media_base64 or "").strip()
    if "," in cleaned and cleaned.lower().startswith("data:"):
        cleaned = cleaned.split(",", 1)[1]
    cleaned = "".join(cleaned.split())
    if image_bytes.startswith(b"\x89PNG"):
        mime = "image/png"
    elif image_bytes[:3] == b"GIF":
        mime = "image/gif"
    elif image_bytes.startswith(b"RIFF") and b"WEBP" in image_bytes[:16]:
        mime = "image/webp"
    else:
        mime = "image/jpeg"
    return f"data:{mime};base64,{cleaned}"


def should_run_vision_ocr(
    image_bytes: bytes,
    *,
    is_monitored: bool = True,
    caption: str | None = None,
    media_type: str | None = None,
) -> bool:
    """
    Zero-cost pre-filter for GPT-4o-mini Vision.
    Returns False when the image is unlikely to contain receipt/error text.
    """
    if not is_monitored:
        logger.info("[MediaProcessor] Vision skipped | reason=unmonitored")
        return False

    mt = (media_type or "").strip().lower()
    if mt in {"sticker", "image/webp+sticker"}:
        logger.info("[MediaProcessor] Vision skipped | reason=sticker_media_type")
        return False

    if not image_bytes or len(image_bytes) < MIN_VISION_BYTES:
        logger.info(
            "[MediaProcessor] Vision skipped | reason=too_small | bytes=%s",
            len(image_bytes or b""),
        )
        return False

    # Animated / sticker WEBP under typical sticker sizes — still blocked by 5KB,
    # but also skip explicit sticker captions regardless of size.
    caption_text = (caption or "").strip()
    if _STICKER_CAPTION_RE.search(caption_text):
        logger.info("[MediaProcessor] Vision skipped | reason=sticker_caption")
        return False

    if caption_text and _SOCIAL_CAPTION_RE.search(caption_text):
        # Social caption with no OCR hint → greetings / memes / selfies
        if not _OCR_HINT_RE.search(caption_text):
            logger.info("[MediaProcessor] Vision skipped | reason=social_caption")
            return False

    # Descriptive non-financial caption on a photo → skip (e.g. "look at this sunset")
    if (
        caption_text
        and len(caption_text) > 24
        and not _OCR_HINT_RE.search(caption_text)
        and not caption_text.startswith("[")
    ):
        logger.info("[MediaProcessor] Vision skipped | reason=non_ocr_caption")
        return False

    return True


def _transcribe_audio_bytes(
    audio_bytes: bytes,
    *,
    chat_jid: str = "unknown",
) -> str:
    client = _get_client()
    if client is None:
        return MEDIA_UNAVAILABLE

    audio_buffer = io.BytesIO(audio_bytes)
    audio_buffer.name = "audio.ogg"
    logger.info("[MediaProcessor] Whisper transcription start | bytes=%s", len(audio_bytes))
    started = time.perf_counter()
    transcript = client.audio.transcriptions.create(
        model="whisper-1",
        file=audio_buffer,
        language="hi",
    )
    duration = time.perf_counter() - started
    text = (getattr(transcript, "text", None) or "").strip()
    # Whisper bills by audio duration; approximate from payload size when unknown.
    approx_audio_sec = max(len(audio_bytes) / 16_000.0, 0.5)
    log_llm_usage(
        "Audio_Whisper",
        chat_jid,
        transcript,
        duration_seconds=approx_audio_sec,
        model_name="whisper-1",
        total_tokens=0,
    )
    logger.info(
        "[MediaProcessor] Whisper transcription done | preview=%s | elapsed=%.2fs",
        text[:80],
        duration,
    )
    return f"\n[Voice Note Transcript]: {text}"


def _extract_image_bytes(
    image_bytes: bytes,
    media_base64: str,
    *,
    is_monitored: bool = True,
    caption: str | None = None,
    media_type: str | None = None,
    chat_jid: str = "unknown",
) -> str:
    if not should_run_vision_ocr(
        image_bytes,
        is_monitored=is_monitored,
        caption=caption,
        media_type=media_type,
    ):
        return ""

    client = _get_client()
    if client is None:
        return MEDIA_UNAVAILABLE

    data_url = _image_data_url(media_base64, image_bytes)
    logger.info("[MediaProcessor] Vision OCR start | bytes=%s", len(image_bytes))
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": VISION_PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {"url": data_url, "detail": "low"},
                    },
                ],
            }
        ],
        max_tokens=200,
        temperature=0.1,
    )
    log_llm_usage("Vision_OCR", chat_jid, response, model_name="gpt-4o-mini")
    choices = getattr(response, "choices", None) or []
    content = ""
    if choices and getattr(choices[0], "message", None):
        content = (choices[0].message.content or "").strip()
    if content.upper() == "NO_RELEVANT_TEXT":
        logger.info("[MediaProcessor] Vision OCR: no relevant text in image")
        return ""
    logger.info("[MediaProcessor] Vision OCR done | preview=%s", content[:80])
    return f"\n[Image OCR/Details]: {content}"


def _process_media_sync(
    media_type: Optional[str],
    media_base64: Optional[str],
    *,
    is_monitored: bool = True,
    caption: str | None = None,
    chat_jid: str = "unknown",
) -> str:
    """Synchronous core used by async wrapper and legacy callers."""
    media_type = (media_type or "").strip().lower() or None
    if not media_base64 or not media_type:
        return ""

    # Hard gate: never spend Whisper/Vision tokens on unmonitored chats.
    if not is_monitored:
        logger.info(
            "[MediaProcessor] Skipping all media AI | reason=unmonitored | type=%s",
            media_type,
        )
        return ""

    logger.info(
        "[MediaProcessor] Extraction start | type=%s | b64_len=%s",
        media_type,
        len(media_base64),
    )

    try:
        raw = _pad_b64(media_base64)
        if media_type == "audio":
            result = _transcribe_audio_bytes(raw, chat_jid=chat_jid)
        elif media_type == "image":
            result = _extract_image_bytes(
                raw,
                media_base64,
                is_monitored=is_monitored,
                caption=caption,
                media_type=media_type,
                chat_jid=chat_jid,
            )
        elif media_type == "sticker":
            logger.info("[MediaProcessor] Sticker media_type — Vision skipped")
            return ""
        else:
            logger.info("[MediaProcessor] Unsupported media_type=%s", media_type)
            return ""

        logger.info(
            "[MediaProcessor] Extraction ok | type=%s | preview=%s",
            media_type,
            (result or "")[:120],
        )
        return result
    except Exception as exc:
        logger.error("[MediaProcessor Error]: %s", str(exc))
        return MEDIA_UNAVAILABLE


async def process_media(
    media_type: str | None,
    media_base64: str | None,
    *,
    is_monitored: bool = True,
    caption: str | None = None,
    chat_jid: str = "unknown",
) -> str:
    """
    Async Layer-1 entrypoint: decode base64 media and return prefixed extraction.
    On OpenAI/network failure returns '\\n[Media extraction unavailable]' — never raises.
    """
    return await asyncio.to_thread(
        _process_media_sync,
        media_type,
        media_base64,
        is_monitored=is_monitored,
        caption=caption,
        chat_jid=chat_jid,
    )


def process_media_payload(
    media_type: Optional[str],
    media_base64: Optional[str],
    *,
    is_monitored: bool = True,
    caption: str | None = None,
    chat_jid: str = "unknown",
) -> str:
    """Sync compatibility wrapper for webhook_controller disk/base64 enrichment."""
    return _process_media_sync(
        media_type,
        media_base64,
        is_monitored=is_monitored,
        caption=caption,
        chat_jid=chat_jid,
    ).lstrip("\n")
