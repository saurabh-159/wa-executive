"""Request WhatsApp on-demand history for a chat (no OpenAI tokens)."""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import requests
from sqlalchemy.orm import Session

from app.models.message import Message

logger = logging.getLogger(__name__)

LIVE_WORKER_URL = os.getenv("LIVE_WORKER_URL", "http://127.0.0.1:5001")
WORKER_INTERNAL_SECRET = os.getenv("WORKER_INTERNAL_SECRET", "").strip()

# Soft target before we bother asking WhatsApp for more.
BACKFILL_SOFT_CAP = 40
DEFAULT_ON_DEMAND_COUNT = 50


def _oldest_anchor(db: Session, tenant_id: str, jid: str) -> Message | None:
    return (
        db.query(Message)
        .filter(
            Message.tenant_jid == tenant_id,
            Message.sender_jid == jid,
            ~Message.message_id.like("sync-ph:%"),
            Message.message_id.isnot(None),
            Message.message_id != "",
        )
        .order_by(Message.timestamp.asc())
        .first()
    )


def count_chat_messages(db: Session, tenant_id: str, jid: str) -> int:
    return (
        db.query(Message)
        .filter(
            Message.tenant_jid == tenant_id,
            Message.sender_jid == jid,
            ~Message.message_id.like("sync-ph:%"),
        )
        .count()
    )


def request_on_demand_history(
    db: Session,
    *,
    tenant_id: str,
    jid: str,
    count: int = DEFAULT_ON_DEMAND_COUNT,
    force: bool = False,
) -> dict[str, Any]:
    """
    Ask wa_worker to pull older WhatsApp messages for one chat.
    Returns immediately after the request is accepted; messages land via
    messaging-history.set → ingest (async).
    """
    tid = (tenant_id or "").strip()
    chat = (jid or "").strip()
    if not tid or not chat:
        return {"ok": False, "error": "missing_tenant_or_jid"}

    existing = count_chat_messages(db, tid, chat)
    if not force and existing >= BACKFILL_SOFT_CAP:
        return {
            "ok": True,
            "skipped": True,
            "reason": "enough_local_messages",
            "local_count": existing,
        }

    anchor = _oldest_anchor(db, tid, chat)
    if anchor is None:
        return {
            "ok": False,
            "error": "no_anchor_message",
            "local_count": existing,
            "hint": "Need at least 1 synced message before on-demand backfill",
        }

    payload = {
        "tenant_id": tid,
        "tenant_jid": tid,
        "jid": chat,
        "oldest_message_id": anchor.message_id,
        "oldest_from_me": bool(anchor.is_from_me),
        "oldest_timestamp": int(anchor.timestamp or 0),
        "count": max(5, min(int(count or DEFAULT_ON_DEMAND_COUNT), 100)),
    }
    headers = {}
    if WORKER_INTERNAL_SECRET:
        headers["X-Worker-Secret"] = WORKER_INTERNAL_SECRET

    try:
        res = requests.post(
            f"{LIVE_WORKER_URL}/fetch-history",
            json=payload,
            headers=headers,
            timeout=15,
            params={"tenant_id": tid},
        )
        data = res.json() if res.content else {}
        if res.status_code >= 400:
            logger.warning(
                "On-demand history rejected (%s) tenant=%s jid=%s: %s",
                res.status_code,
                tid,
                chat,
                data,
            )
            return {
                "ok": False,
                "error": data.get("error") or f"http_{res.status_code}",
                "local_count": existing,
            }
        logger.info(
            "On-demand history requested tenant=%s jid=%s local=%s result=%s",
            tid,
            chat,
            existing,
            data,
        )
        return {
            "ok": True,
            "local_count": existing,
            "worker": data,
        }
    except Exception as exc:
        logger.warning("On-demand history call failed: %s", exc)
        return {"ok": False, "error": str(exc), "local_count": existing}


def trigger_history_backfill(
    db: Session,
    *,
    tenant_id: str,
    jid: str,
    count: int = DEFAULT_ON_DEMAND_COUNT,
    force: bool = False,
) -> dict[str, Any]:
    """
    Fire-and-forget history pull for a newly auto-promoted (or selected) chat.
    Does not sleep — messages land asynchronously via messaging-history.set.
    """
    return request_on_demand_history(
        db,
        tenant_id=tenant_id,
        jid=jid,
        count=count,
        force=force,
    )


def backfill_jids_then_wait(
    db: Session,
    *,
    tenant_id: str,
    jids: list[str],
    settle_seconds: float = 8.0,
) -> dict[str, Any]:
    """
    Request on-demand history for each jid, then wait briefly so
    messaging-history.set can land before AI audit runs.
    """
    results = []
    requested = 0
    for jid in jids or []:
        jid = (jid or "").strip()
        if not jid:
            continue
        result = request_on_demand_history(db, tenant_id=tenant_id, jid=jid, force=False)
        results.append({"jid": jid, **result})
        if result.get("ok") and not result.get("skipped"):
            requested += 1

    if requested and settle_seconds > 0:
        time.sleep(min(float(settle_seconds), 20.0))

    return {
        "requested": requested,
        "results": results,
        "settled_seconds": settle_seconds if requested else 0,
    }
