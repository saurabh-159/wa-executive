"""In-memory WhatsApp auth / session state shared across FastAPI routers."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

# ready | connected | syncing | qr_ready | disconnected
_status: str = "disconnected"
_jid: str | None = None  # WhatsApp phone JID (@s.whatsapp.net)
_tenant_id: str | None = None  # Firebase UID
_updated_at: str | None = None
_detail: dict[str, Any] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def set_wa_status(
    status: str,
    *,
    jid: str | None = None,
    tenant_id: str | None = None,
    **extra: Any,
) -> dict:
    """Update the live WhatsApp lifecycle status."""
    global _status, _jid, _tenant_id, _updated_at, _detail

    normalized = (status or "").strip().lower()
    if normalized in ("authenticated", "open", "connected"):
        normalized = "connected"
    elif normalized == "ready":
        normalized = "ready"
    elif normalized in ("unpaired", "logged_out", "logout"):
        normalized = "disconnected"
    elif normalized not in ("ready", "connected", "syncing", "qr_ready", "disconnected"):
        normalized = "disconnected"

    # Sticky latch: never flap syncing/ready → QR on temporary reconnect noise.
    # Explicit logout / wipe must pass unpaired=True or force=True / cleared=True.
    force_demote = bool(
        extra.get("unpaired")
        or extra.get("force")
        or extra.get("forceLifecycle")
        or extra.get("cleared")
    )
    if (
        normalized in ("qr_ready", "disconnected")
        and _status in ("syncing", "ready", "connected")
        and not force_demote
    ):
        normalized = "ready" if _status == "ready" else "syncing"

    _status = normalized
    if jid is not None:
        _jid = jid
    elif normalized == "disconnected" and force_demote:
        _jid = None
    if tenant_id is not None:
        cleaned = str(tenant_id).strip()
        if cleaned and cleaned != "default" and "@" not in cleaned:
            _tenant_id = cleaned
    elif normalized == "disconnected" and force_demote:
        _tenant_id = None
    _updated_at = _now_iso()
    # Merge detail so latch polls keep counters/names across reconnect blips
    merged = dict(_detail)
    for key, value in extra.items():
        if value is not None:
            merged[key] = value
    _detail = merged
    return get_wa_status()


def get_wa_status() -> dict:
    return {
        "status": _status,
        "connected": _status in ("ready", "connected", "syncing"),
        "isHistorySyncComplete": bool(_detail.get("isHistorySyncComplete")),
        "jid": _jid,
        "tenant_id": _tenant_id,
        "updated_at": _updated_at,
        "detail": dict(_detail),
    }


def clear_wa_session(tenant_id: str | None = None) -> dict:
    """Wipe in-memory WhatsApp session mirrors after logout; mark qr_ready for re-pair."""
    global _status, _jid, _tenant_id, _updated_at, _detail
    _status = "qr_ready"
    _jid = None
    if tenant_id is not None:
        cleaned = str(tenant_id).strip()
        if cleaned and cleaned != "default" and "@" not in cleaned:
            _tenant_id = cleaned
        else:
            _tenant_id = None
    else:
        _tenant_id = None
    _updated_at = _now_iso()
    _detail = {"cleared": True, "connected": False, "unpaired": True}
    return get_wa_status()
