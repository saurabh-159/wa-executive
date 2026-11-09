"""WhatsApp auth status for the frontend connect / logout lifecycle."""

from __future__ import annotations

import logging
import os

import httpx
from fastapi import APIRouter, Request
from sqlalchemy import func

from app.models.database import SessionLocal
from app.models.message import Message
from app.services.firebase_auth import verified_tenant_id
from app.services.wa_session_state import get_wa_status, set_wa_status

router = APIRouter(prefix="/api/v1/auth", tags=["Auth"])
logger = logging.getLogger(__name__)

LIVE_WORKER_URL = os.getenv("LIVE_WORKER_URL", "http://127.0.0.1:5001")
WORKER_TIMEOUT = 2.0


def _disconnected_fallback(tenant_id: str, *, source: str = "worker_offline") -> dict:
    """
    Worker unreachable. If we already latched into syncing/ready, preserve that
    snapshot so the UI does not flicker back to the QR screen.
    """
    cached = get_wa_status()
    cached_status = str(cached.get("status") or "").strip().lower()
    detail = cached.get("detail") or {}
    selection_ready = bool(
        detail.get("selection_ready")
        or detail.get("sync_phase") == "ready"
        or (
            (cached.get("isHistorySyncComplete") or detail.get("isHistorySyncComplete"))
            and detail.get("phonebook_settled")
        )
    )
    history_ready = selection_ready

    # Latch: keep syncing/ready alive across momentary worker timeouts
    if cached_status in ("syncing", "ready", "connected") or history_ready:
        status = "ready" if history_ready or cached_status == "ready" else "syncing"
        return {
            "status": status,
            "connected": True,
            "qr_image": None,
            "has_qr": False,
            "jid": cached.get("jid"),
            "isSyncing": status == "syncing",
            "totalProcessed": int(detail.get("totalProcessed") or detail.get("messages_indexed") or 0),
            "totalChatsCount": int(detail.get("totalChatsCount") or detail.get("identified_chats") or 0),
            "currentProcessingChat": detail.get("currentProcessingChat")
            or ("Auditing conversation history..." if status == "syncing" else None),
            "historyCompleted": history_ready,
            "isHistorySyncComplete": history_ready,
            "selection_ready": selection_ready,
            "phonebook_settled": bool(detail.get("phonebook_settled")),
            "sync_phase": detail.get("sync_phase") or (
                "ready" if selection_ready else "messages"
            ),
            "phonebook_names": int(detail.get("phonebook_names") or 0),
            "notify_names": int(detail.get("notify_names") or 0),
            "messages_indexed": int(
                detail.get("messages_indexed") or detail.get("totalProcessed") or 0
            ),
            "identified_chats": int(
                detail.get("identified_chats") or detail.get("totalChatsCount") or 0
            ),
            "recent_contacts": list(detail.get("recent_contacts") or []),
            "hasConfiguredContacts": bool(detail.get("hasConfiguredContacts")),
            "unpaired": bool(detail.get("unpaired") or detail.get("cleared")),
            "cleared": bool(detail.get("cleared")),
            "updated_at": cached.get("updated_at"),
            "source": source,
            "worker_online": False,
            "stale": True,
            "tenant_id": tenant_id,
        }

    return {
        "status": "disconnected",
        "connected": False,
        "qr_image": None,
        "has_qr": False,
        "jid": cached.get("jid"),
        "isSyncing": False,
        "totalProcessed": 0,
        "totalChatsCount": 0,
        "currentProcessingChat": None,
        "historyCompleted": False,
        "isHistorySyncComplete": False,
        "messages_indexed": 0,
        "identified_chats": 0,
        "recent_contacts": [],
        "hasConfiguredContacts": False,
        "updated_at": cached.get("updated_at"),
        "source": source,
        "worker_online": False,
        "tenant_id": tenant_id,
    }


def _normalize_worker_status(payload: dict) -> str:
    """Map worker health/auth payload → ready | syncing | qr_ready | disconnected."""
    if not isinstance(payload, dict):
        return "disconnected"

    explicit = (
        payload.get("status")
        or payload.get("auth_state")
        or payload.get("state")
        or ""
    )
    explicit = str(explicit).strip().lower()
    history_ready = bool(
        payload.get("isHistorySyncComplete") or payload.get("historyCompleted")
    )

    if explicit == "ready":
        return "ready"
    if explicit == "syncing":
        return "syncing"
    if explicit in ("connected", "authenticated", "open"):
        return "ready" if history_ready else "syncing"
    if explicit in ("qr_ready", "qr"):
        return "qr_ready"
    if explicit in ("disconnected", "unpaired", "logged_out"):
        pass

    if payload.get("connected") and history_ready:
        return "ready"
    if payload.get("connected"):
        return "syncing"
    if payload.get("has_qr") or payload.get("qr_image"):
        return "qr_ready"
    return "disconnected"


async def _worker_get(path: str, tenant_id: str, timeout: float = WORKER_TIMEOUT) -> dict | None:
    """
    Non-blocking worker GET with a hard 2s ceiling.

    Raises httpx.ConnectError / httpx.TimeoutException so callers can abort
    immediately instead of cascading into more hung requests.
    """
    async with httpx.AsyncClient(timeout=timeout) as client:
        res = await client.get(
            f"{LIVE_WORKER_URL}{path}",
            params={"tenant_id": tenant_id},
        )
        res.raise_for_status()
        return res.json() if res.content else {}


def _has_configured_contacts(tenant_id: str) -> bool:
    """True when this tenant has at least one monitored contact/thread."""
    try:
        with SessionLocal() as db:
            count = (
                db.query(func.count(func.distinct(Message.sender_jid)))
                .filter(Message.tenant_jid == tenant_id)
                .filter(Message.is_monitored == True)  # noqa: E712
                .scalar()
            ) or 0
            return int(count) > 0
    except Exception as err:
        logger.debug("hasConfiguredContacts check failed: %s", err)
        return False


@router.get("/status")
async def auth_status(request: Request):
    """
    Unified WhatsApp lifecycle for the frontend.

    Returns status ∈ {ready, syncing, qr_ready, disconnected} plus optional
    qr_image, sync progress, and hasConfiguredContacts — so the client only
    needs to poll this single authenticated endpoint.
    """
    tenant_id = verified_tenant_id(request)

    try:
        try:
            worker_payload = await _worker_get("/auth-status", tenant_id)
        except httpx.HTTPStatusError:
            # Path missing on older workers — try health, then QR once
            try:
                worker_payload = await _worker_get("/health", tenant_id)
            except httpx.HTTPStatusError:
                worker_payload = await _worker_get("/qr", tenant_id)
    except (httpx.ConnectError, httpx.TimeoutException) as err:
        logger.warning("wa_worker unreachable for /auth/status: %s", err)
        return _disconnected_fallback(tenant_id)
    except httpx.HTTPError as err:
        logger.warning("wa_worker HTTP error for /auth/status: %s", err)
        return _disconnected_fallback(tenant_id)
    except Exception as err:
        logger.warning("wa_worker unexpected error for /auth/status: %s", err)
        return _disconnected_fallback(tenant_id)

    status = _normalize_worker_status(worker_payload or {})
    jid = (worker_payload or {}).get("jid") or (worker_payload or {}).get("my_jid")
    worker_chat = str((worker_payload or {}).get("currentProcessingChat") or "")
    worker_msgs = int(
        (worker_payload or {}).get("messages_indexed")
        or (worker_payload or {}).get("totalProcessed")
        or 0
    )
    # Self-heal: reconnect can wipe selection_ready while leaving the ready label.
    selection_ready = bool(
        (worker_payload or {}).get("selection_ready")
        or (worker_payload or {}).get("sync_phase") == "ready"
        or (
            (worker_payload or {}).get("status") == "ready"
            and (worker_payload or {}).get("phonebook_settled")
        )
        or (
            "ready for selection" in worker_chat.lower()
            and worker_msgs >= 50
        )
    )
    # Do NOT treat "15 chats indexed" as desk-ready — wait for name mapping / heal signal.
    history_ready = selection_ready

    # Latch against QR flicker: if mirrored state was already syncing/ready, do not
    # demote to qr_ready/disconnected on a momentary handshake blip.
    cached = get_wa_status()
    cached_status = str(cached.get("status") or "").strip().lower()
    cached_detail = cached.get("detail") or {}
    unpaired = bool(
        (worker_payload or {}).get("unpaired")
        or cached_detail.get("unpaired")
        or cached_detail.get("cleared")
    )
    if (
        status in ("qr_ready", "disconnected")
        and cached_status in ("syncing", "ready", "connected")
        and not unpaired
    ):
        status = "ready" if history_ready or cached_status == "ready" else "syncing"

    qr_image = None
    sync_payload: dict = {}

    try:
        if status in ("qr_ready", "disconnected"):
            try:
                qr_payload = await _worker_get("/qr", tenant_id) or {}
            except (httpx.ConnectError, httpx.TimeoutException, httpx.HTTPError):
                qr_payload = {}
            qr_image = qr_payload.get("qr_image") or None
            if qr_image and status == "disconnected":
                status = "qr_ready"
            # Only promote to syncing on a real open socket + phone jid.
            # Bare `connected` blips during QR handshake caused QR↔loader flicker.
            qr_jid = qr_payload.get("jid") or qr_payload.get("my_jid")
            if qr_payload.get("connected") and qr_jid and not history_ready:
                status = "syncing"
                qr_image = None
            elif qr_payload.get("connected") and qr_jid and history_ready:
                status = "ready"
                qr_image = None
        elif status in ("syncing", "ready", "connected"):
            try:
                sync_payload = await _worker_get("/sync-status", tenant_id) or {}
            except (httpx.ConnectError, httpx.TimeoutException, httpx.HTTPError):
                sync_payload = {}
            if sync_payload:
                identified = int(
                    sync_payload.get("identified_chats")
                    or sync_payload.get("totalChatsCount")
                    or 0
                )
                sync_chat = str(sync_payload.get("currentProcessingChat") or "")
                sync_msgs = int(
                    sync_payload.get("messages_indexed")
                    or sync_payload.get("totalProcessed")
                    or 0
                )
                selection_ready = bool(
                    sync_payload.get("selection_ready")
                    or sync_payload.get("sync_phase") == "ready"
                    or selection_ready
                    or (
                        "ready for selection" in sync_chat.lower()
                        and sync_msgs >= 50
                    )
                )
                history_ready = selection_ready
                if selection_ready:
                    status = "ready"
                elif sync_payload.get("connected") or sync_payload.get("status") == "syncing":
                    status = "syncing"
                jid = sync_payload.get("jid") or jid
    except Exception as err:
        logger.debug("Secondary worker enrichment failed: %s", err)

    has_contacts = False
    if status == "ready" and history_ready:
        has_contacts = _has_configured_contacts(tenant_id)

    # Enrich mirrored detail so timeout fallbacks can preserve counters
    mirrored = set_wa_status(
        status,
        jid=jid,
        tenant_id=tenant_id,
        source="worker_poll",
        isHistorySyncComplete=history_ready,
        hasConfiguredContacts=has_contacts,
        totalProcessed=int(
            sync_payload.get("totalProcessed")
            or (worker_payload or {}).get("totalProcessed")
            or 0
        ),
        totalChatsCount=int(
            sync_payload.get("totalChatsCount")
            or sync_payload.get("identified_chats")
            or (worker_payload or {}).get("totalChatsCount")
            or 0
        ),
        messages_indexed=int(
            sync_payload.get("messages_indexed")
            or sync_payload.get("totalProcessed")
            or (worker_payload or {}).get("totalProcessed")
            or 0
        ),
        identified_chats=int(
            sync_payload.get("identified_chats")
            or sync_payload.get("totalChatsCount")
            or (worker_payload or {}).get("identified_chats")
            or 0
        ),
        recent_contacts=list(sync_payload.get("recent_contacts") or []),
        currentProcessingChat=(
            sync_payload.get("currentProcessingChat")
            or (worker_payload or {}).get("currentProcessingChat")
        ),
        selection_ready=selection_ready,
        phonebook_settled=bool(
            sync_payload.get("phonebook_settled")
            or (worker_payload or {}).get("phonebook_settled")
        ),
        sync_phase=(
            sync_payload.get("sync_phase")
            or (worker_payload or {}).get("sync_phase")
            or ("ready" if selection_ready else "messages")
        ),
        phonebook_names=int(
            sync_payload.get("phonebook_names")
            or (worker_payload or {}).get("phonebook_names")
            or 0
        ),
        notify_names=int(
            sync_payload.get("notify_names")
            or (worker_payload or {}).get("notify_names")
            or 0
        ),
    )
    socket_open = status in ("ready", "connected", "syncing") or bool(
        (worker_payload or {}).get("connected")
    )

    return {
        "status": status,
        "connected": socket_open,
        "qr_image": qr_image if status == "qr_ready" else None,
        "has_qr": bool(qr_image) or bool((worker_payload or {}).get("has_qr")),
        "unpaired": unpaired,
        "cleared": bool(cached_detail.get("cleared")),
        "jid": jid or mirrored.get("jid"),
        "isSyncing": bool(
            sync_payload.get("isSyncing")
            or (worker_payload or {}).get("isSyncing")
            or status == "syncing"
        ),
        "totalProcessed": int(
            sync_payload.get("totalProcessed")
            or (worker_payload or {}).get("totalProcessed")
            or 0
        ),
        "totalChatsCount": int(
            sync_payload.get("totalChatsCount")
            or (worker_payload or {}).get("totalChatsCount")
            or 0
        ),
        "currentProcessingChat": (
            sync_payload.get("currentProcessingChat")
            or (worker_payload or {}).get("currentProcessingChat")
            or ("Auditing conversation history..." if status == "syncing" else None)
        ),
        "historyCompleted": history_ready,
        "isHistorySyncComplete": history_ready,
        "selection_ready": selection_ready,
        "phonebook_settled": bool(
            sync_payload.get("phonebook_settled")
            or (worker_payload or {}).get("phonebook_settled")
        ),
        "sync_phase": (
            sync_payload.get("sync_phase")
            or (worker_payload or {}).get("sync_phase")
            or ("ready" if selection_ready else "messages")
        ),
        "phonebook_names": int(
            sync_payload.get("phonebook_names")
            or (worker_payload or {}).get("phonebook_names")
            or 0
        ),
        "notify_names": int(
            sync_payload.get("notify_names")
            or (worker_payload or {}).get("notify_names")
            or 0
        ),
        "messages_indexed": int(
            sync_payload.get("messages_indexed")
            or sync_payload.get("totalProcessed")
            or (worker_payload or {}).get("totalProcessed")
            or 0
        ),
        "identified_chats": int(
            sync_payload.get("identified_chats")
            or sync_payload.get("totalChatsCount")
            or (worker_payload or {}).get("totalChatsCount")
            or 0
        ),
        "recent_contacts": list(sync_payload.get("recent_contacts") or []),
        "hasConfiguredContacts": has_contacts,
        "updated_at": mirrored.get("updated_at"),
        "source": "worker",
        "worker_online": True,
        "tenant_id": tenant_id,
    }
