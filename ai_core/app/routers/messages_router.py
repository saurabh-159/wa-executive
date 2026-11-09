"""Layer 1 message ingest: multimodal enrichment then SQLite persistence."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request

from app.controllers.webhook_controller import process_message_payload
from app.services.media_processor import process_media

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/messages", tags=["Messages"])


@router.post("/ingest")
async def ingest_message(request: Request):
    """
    POST /api/v1/messages/ingest

    Runs Whisper / Vision asynchronously, concatenates into message text,
    then upserts into SQLite via the shared ingest pipeline.
    """
    body = await request.json()
    if not isinstance(body, dict):
        body = {}

    media_type = body.get("media_type")
    media_base64 = body.get("media_base64")
    raw_text = body.get("text") or ""

    # Process media off the event loop; never let OpenAI failures 500 the route
    try:
        media_context = await process_media(media_type, media_base64)
    except Exception as exc:
        logger.error("[MediaProcessor Error]: %s", str(exc))
        media_context = "\n[Media extraction unavailable]"

    if media_context:
        combined_content = (str(raw_text) + " " + media_context).strip()
    else:
        combined_content = str(raw_text).strip()

    # Avoid double enrichment inside process_message_payload
    body = dict(body)
    body["text"] = combined_content
    body["media_base64"] = None
    if body.get("from_me") is None and body.get("is_from_me") is not None:
        body["from_me"] = body.get("is_from_me")

    result = process_message_payload(body)

    from_me = body.get("from_me", body.get("is_from_me", False))
    logger.info(
        "[Ingest Stored] ID: %s | from_me: %s | HasMedia: %s | Preview: %s",
        body.get("message_id"),
        from_me,
        bool(media_type),
        (combined_content or "")[:80],
    )
    return result
