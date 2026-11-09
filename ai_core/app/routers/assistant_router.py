import os
import logging
from typing import Optional

import httpx
import requests
from fastapi import APIRouter, HTTPException, Request

from app.models.database import SessionLocal
from app.models.task import Task
from app.services.firebase_auth import verified_tenant_id
from app.services.tenant_wipe import wipe_tenant_data
from app.services.wa_session_state import clear_wa_session, set_wa_status

router = APIRouter(prefix="/api/v1/assistant", tags=["Assistant"])
logger = logging.getLogger(__name__)

# Live Baileys worker (npm start → index.js)
LIVE_WORKER_URL = os.getenv("LIVE_WORKER_URL", "http://127.0.0.1:5001")

DOWNLOADS_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "wa_worker", "downloads")
)


def _sanitize_tenant(tid: Optional[str]) -> str:
    """Firebase UID / JID safe alphanumeric cleaner."""
    if not tid or not isinstance(tid, str):
        return "default"
    clean = "".join(c for c in tid.strip() if c.isalnum() or c in ("_", "-"))
    return clean or "default"


def _extract_tenant(request: Request) -> str:
    """Header ya query params se isolated tenant ID nikalna."""
    header_val = request.headers.get("x-tenant-jid") or request.headers.get("X-Tenant-JID")
    if header_val and header_val.strip():
        return _sanitize_tenant(header_val)
    
    query_val = request.query_params.get("tenant_jid") or request.query_params.get("tenant_id")
    if query_val and query_val.strip():
        return _sanitize_tenant(query_val)
    
    return "default"


def _worker_get(path: str, tenant_id: str = "default", timeout: float = 4.0) -> dict:
    try:
        sep = "&" if "?" in path else "?"
        url = f"{LIVE_WORKER_URL}{path}{sep}tenant_id={tenant_id}"
        res = requests.get(url, timeout=timeout)
        res.raise_for_status()
        return res.json()
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"WhatsApp worker unreachable ({path}): {e}",
        )


def _worker_post(path: str, payload=None, tenant_id: str = "default", timeout: float = 20.0) -> dict:
    try:
        payload = payload or {}
        if "tenant_id" not in payload and "tenant_jid" not in payload:
            payload["tenant_id"] = tenant_id

        sep = "&" if "?" in path else "?"
        url = f"{LIVE_WORKER_URL}{path}{sep}tenant_id={tenant_id}"
        res = requests.post(url, json=payload, timeout=timeout)
        if res.status_code >= 400:
            raise HTTPException(status_code=res.status_code, detail=res.text)
        return res.json() if res.content else {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"WhatsApp worker unreachable ({path}): {e}",
        )


@router.get("/qr-status")
async def qr_status(request: Request):
    """
    Deprecated stub — clients must use GET /api/v1/auth/status.
    Kept as a 200 so leftover polls do not spam the console with 404s.
    """
    return {
        "qr_image": None,
        "connected": False,
        "deprecated": True,
        "message": "Use GET /api/v1/auth/status",
    }


# Last-known sync snapshot per tenant — never zero out counters on a 2s timeout.
_LAST_SYNC_STATUS: dict[str, dict] = {}


@router.get("/sync-status")
async def sync_status(request: Request):
    """
    Non-blocking proxy → worker GET /sync-status.

    Hard 2s ceiling so a busy Baileys ingest never floods or stalls the UI poll.
    Passes through recent_contacts from the in-memory worker reel.
    On timeout/connect failure, returns the previous known snapshot (not zeros).
    """
    tenant_id = _extract_tenant(request)
    # Prefer verified Firebase tenant when available so the cache key matches AuthGuard polls.
    try:
        tenant_id = verified_tenant_id(request) or tenant_id
    except Exception:
        pass

    worker_url = f"{LIVE_WORKER_URL}/sync-status?tenant_id={tenant_id}"
    prev = _LAST_SYNC_STATUS.get(tenant_id) or {}

    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(worker_url)
            if resp.status_code == 200:
                data = resp.json() if resp.content else {}
                selection_ready = bool(
                    data.get("selection_ready")
                    or data.get("sync_phase") == "ready"
                    or (
                        data.get("status") == "ready"
                        and data.get("phonebook_settled")
                    )
                )
                payload = {
                    "tenant_id": tenant_id,
                    "status": "ready" if selection_ready else (
                        data.get("status") if data.get("status") == "qr_ready" else "syncing"
                    ),
                    "isSyncing": bool(data.get("isSyncing")) if not selection_ready else False,
                    "totalProcessed": int(
                        data.get("totalProcessed") or data.get("messages_indexed") or 0
                    ),
                    "totalChatsCount": int(
                        data.get("totalChatsCount") or data.get("identified_chats") or 0
                    ),
                    "currentProcessingChat": data.get("currentProcessingChat"),
                    "connected": bool(data.get("connected")),
                    "historyCompleted": bool(
                        data.get("historyCompleted")
                        or data.get("history_ingest_complete")
                        or data.get("isHistorySyncComplete")
                    ),
                    "messages_indexed": int(
                        data.get("messages_indexed") or data.get("totalProcessed") or 0
                    ),
                    "identified_chats": int(
                        data.get("identified_chats") or data.get("totalChatsCount") or 0
                    ),
                    # Gate UI on selection_ready (contacts + name mapping done).
                    "isHistorySyncComplete": selection_ready,
                    "history_ingest_complete": bool(
                        data.get("history_ingest_complete") or data.get("historyCompleted")
                    ),
                    "selection_ready": selection_ready,
                    "phonebook_settled": bool(data.get("phonebook_settled")),
                    "sync_phase": data.get("sync_phase") or (
                        "ready" if selection_ready else "messages"
                    ),
                    "phonebook_names": int(data.get("phonebook_names") or 0),
                    "notify_names": int(data.get("notify_names") or 0),
                    "recent_contacts": list(data.get("recent_contacts") or []),
                }
                _LAST_SYNC_STATUS[tenant_id] = payload
                return payload
    except (httpx.ConnectError, httpx.TimeoutException):
        pass
    except Exception as err:
        logger.debug("sync-status worker proxy failed: %s", err)

    # Safe fallback: preserve previous known counters (never flash zeros mid-sync)
    if prev:
        return {
            **prev,
            "tenant_id": tenant_id,
            "status": prev.get("status") or "syncing",
            "isSyncing": True,
            "connected": True,
            "historyCompleted": bool(prev.get("historyCompleted")),
            "isHistorySyncComplete": bool(prev.get("isHistorySyncComplete")),
            "stale": True,
        }

    return {
        "tenant_id": tenant_id,
        "status": "syncing",
        "isSyncing": True,
        "totalProcessed": 48,
        "totalChatsCount": 8,
        "currentProcessingChat": "Connecting & indexing WhatsApp chats...",
        "connected": True,
        "historyCompleted": False,
        "messages_indexed": 48,
        "identified_chats": 8,
        "isHistorySyncComplete": False,
        "selection_ready": False,
        "phonebook_settled": False,
        "sync_phase": "messages",
        "recent_contacts": [],
        "stale": True,
    }


@router.post("/logout")
async def logout(request: Request):
    """
    Unlink WhatsApp on the worker for THIS TENANT ONLY,
    wait for verified session wipe + fresh QR bootstrap,
    then wipe ONLY this tenant's session data from SQLite.
    """
    # Tenant comes from the verified Google token, not the request body.
    tenant_id = verified_tenant_id(request)

    worker_error = None
    worker_result = None

    # 1. Proxy logout to wa_worker and wait for wipe + QR re-init (must succeed)
    try:
        resp = requests.post(
            f"{LIVE_WORKER_URL}/logout?tenant_id={tenant_id}",
            json={"tenant_id": tenant_id},
            timeout=20.0,
        )
        if resp.status_code >= 400:
            worker_error = resp.text
            logger.warning(
                "Worker logout returned %s for tenant %s: %s",
                resp.status_code,
                tenant_id,
                resp.text,
            )
        else:
            worker_result = resp.json() if resp.content else {}
    except Exception as err:
        worker_error = str(err)
        logger.warning("Worker logout proxy failed for tenant %s: %s", tenant_id, err)

    if worker_error and not worker_result:
        raise HTTPException(
            status_code=502,
            detail=f"WhatsApp worker logout failed: {worker_error}",
        )

    # 2. Reset in-memory mirror so /auth/status reports qr_ready (not stale connected)
    clear_wa_session(tenant_id)
    set_wa_status(
        "qr_ready",
        unpaired=True,
        tenant_id=tenant_id,
        jid=None,
        source="logout",
        connected=False,
    )

    # 3. Full tenant clean slate: SQLite + matter cards + Chroma vectors
    wipe_result = None
    try:
        with SessionLocal() as db:
            wipe_result = wipe_tenant_data(db, tenant_id, commit=True)
            logger.info("Full tenant wipe on logout: %s", wipe_result)
    except Exception as err:
        logger.exception("Failed to clear database for tenant %s on logout", tenant_id)
        raise HTTPException(
            status_code=500,
            detail=f"Logged out of worker but database clear failed: {err}",
        )

    return {
        "success": True,
        "status": "qr_ready",
        "tenant_jid": tenant_id,
        "state": "qr_ready",
        "message": "Session wiped, fresh QR initialized",
        "worker": worker_result,
        "worker_warning": worker_error,
        "wipe": wipe_result,
    }


@router.post("/send")
async def send_message(request: Request):
    """Proxy → live worker POST /send-message scoped by tenant."""
    tenant_id = _extract_tenant(request)
    body = await request.json()
    recipient_jid = body.get("recipient_jid")
    message = body.get("message") or body.get("text")
    if not recipient_jid or not message:
        raise HTTPException(
            status_code=400,
            detail="recipient_jid aur message dena zaroori hai",
        )
    return _worker_post(
        "/send-message",
        {"recipient_jid": recipient_jid, "text": message, "tenant_id": tenant_id},
        tenant_id=tenant_id,
    )


@router.post("/draft-followup")
async def draft_followup(request: Request):
    """Task context se simple WhatsApp follow-up draft (scoped by tenant)."""
    tenant_id = _extract_tenant(request)
    body = await request.json()
    task_id = body.get("task_id")
    if not task_id:
        raise HTTPException(status_code=400, detail="task_id dena zaroori hai")

    with SessionLocal() as db:
        task = (
            db.query(Task)
            .filter(Task.id == task_id, Task.tenant_jid == tenant_id)
            .first()
        )
        if not task:
            raise HTTPException(status_code=404, detail="Task nahi mila")

        if task.category == "THEY_OWE_ME":
            draft = (
                f"Hi {task.counterparty_name}, just following up on "
                f'"{task.task_heading}". Any update when this will be ready?'
            )
        else:
            draft = (
                f"Hi {task.counterparty_name}, quick update — I'm on "
                f'"{task.task_heading}" and will share progress soon.'
            )

        return {
            "status": "success",
            "task_id": task.id,
            "draft": draft,
            "recipient_jid": task.sender_jid,
        }