from fastapi import APIRouter, Request, BackgroundTasks
from pydantic import BaseModel
from app.controllers.webhook_controller import (
    process_incoming_webhook,
    process_incoming_batch,
    update_contacts_in_db,
    settle_contact_names_from_db,
    upsert_initial_chats,
    upsert_lid_mappings,
    remap_lid_identifiers,
    apply_avatar_updates,
    resolve_ingest_tenant_id,
    relink_phone_tenant_messages,
)
from app.services.rag_search_service import index_chat_conversation
from app.services.tenant_wipe import wipe_tenant_data
from app.services.wa_session_state import set_wa_status
from app.models.database import SessionLocal
from app.models.message import Message

router = APIRouter(prefix="/api/v1/webhook", tags=["Webhook"])


class WipeTenantRequest(BaseModel):
    tenant_jid: str
    tenant_id: str | None = None


@router.post("/wipe-tenant-data")
async def wipe_tenant_data_endpoint(payload: WipeTenantRequest):
    """
    Hard-logout / session drop: full tenant clean slate
    (messages, cards, matters, contacts, audit jobs, Chroma vectors).
    """
    tenant_jid = (payload.tenant_jid or payload.tenant_id or "").strip()
    if not tenant_jid:
        return {"status": "skipped", "reason": "empty_tenant_jid"}

    with SessionLocal() as db:
        result = wipe_tenant_data(db, tenant_jid, commit=True)
    return result


@router.post("/incoming")
async def incoming_webhook(request: Request):
    """Live + draft worker → single WhatsApp message (isolated by tenant_jid)."""
    return await process_incoming_webhook(request)


@router.post("/messages-ingest")
async def messages_ingest_alias(request: Request):
    """Alias for multimodal ingest verification (same handler as /api/v1/messages/ingest)."""
    return await process_incoming_webhook(request)


@router.post("/incoming-batch")
async def incoming_batch_webhook(request: Request):
    """History sync batches from live worker with tenant isolation."""
    body = await request.json()
    messages = body.get("messages", [])
    tenant_jid = resolve_ingest_tenant_id(body)

    # Ensure Firebase UID flows to every message (never leave phone JID as tenant)
    for msg in messages:
        msg["tenant_id"] = resolve_ingest_tenant_id(msg, fallback=tenant_jid)
        msg["tenant_jid"] = msg["tenant_id"]

    return process_incoming_batch(messages)


@router.post("/sync-history")
async def sync_history_endpoint(request: Request, background_tasks: BackgroundTasks):
    """Index a contact's saved messages into ChromaDB for tenant-isolated RAG audit."""
    body = await request.json()
    sender_jid = body.get("sender_jid")
    sender_name = body.get("sender_name", "Contact")
    tenant_jid = body.get("tenant_jid") or "default"

    def run_indexing(jid: str, name: str, t_jid: str):
        with SessionLocal() as db:
            all_msgs = (
                db.query(Message)
                .filter(Message.tenant_jid == t_jid)
                .filter(Message.sender_jid == jid)
                .order_by(Message.timestamp.asc())
                .all()
            )
            # Pass tenant_jid to namespace the vector collections
            index_chat_conversation(jid, name, all_msgs, tenant_jid=t_jid)

    background_tasks.add_task(run_indexing, sender_jid, sender_name, tenant_jid)
    return {"status": "indexing_started", "contact": sender_name, "tenant": tenant_jid}


@router.post("/sync-chats")
async def sync_chats_endpoint(payload: dict):
    """
    Initial Baileys history snapshot (10-day window).
    Payload: { "tenant_id"/"tenant_jid": Firebase UID, "chats": [ ... ] }
    """
    chats = payload.get("chats", [])
    tenant_jid = resolve_ingest_tenant_id(payload)
    if not chats:
        return {"status": "skipped", "reason": "empty_chats"}

    for c in chats:
        resolved = resolve_ingest_tenant_id(c, fallback=tenant_jid)
        c["tenant_id"] = resolved
        c["tenant_jid"] = resolved

    with SessionLocal() as db:
        return upsert_initial_chats(db, chats)


@router.post("/sync-contacts")
async def sync_contacts_endpoint(payload: dict):
    """
    Payload: { "tenant_id"/"tenant_jid": Firebase UID, "contacts": [ ... ] }
    Upserts into `contacts` and renames weak Message.sender_name values.
    """
    contacts = payload.get("contacts", [])
    tenant_jid = resolve_ingest_tenant_id(payload)
    if not tenant_jid or not contacts:
        return {"status": "skipped", "count": 0}

    for ct in contacts:
        resolved = resolve_ingest_tenant_id(ct, fallback=tenant_jid)
        ct["tenant_id"] = resolved
        ct["tenant_jid"] = resolved

    with SessionLocal() as db:
        return update_contacts_in_db(db, contacts, tenant_jid=tenant_jid)


@router.post("/settle-contact-names")
async def settle_contact_names_endpoint(payload: dict):
    """
    After phonebook app-state sync: rename weak message labels from contacts table.
    Payload: { "tenant_id" / "tenant_jid": Firebase UID }
    """
    tenant_jid = resolve_ingest_tenant_id(payload)
    if not tenant_jid:
        return {"status": "skipped", "reason": "empty_tenant"}
    with SessionLocal() as db:
        return settle_contact_names_from_db(db, tenant_jid=tenant_jid)


@router.post("/sync-lid-mappings")
async def sync_lid_mappings_endpoint(payload: dict):
    """
    Persist LID→phone mappings from the Baileys worker into `lid_mappings`.
    Payload: { "tenant_jid"/"tenant_id": ..., "mappings": [{ "lid", "pn" }, ...] }
    """
    tenant_jid = resolve_ingest_tenant_id(payload)
    mappings = payload.get("mappings") or []
    if not tenant_jid or not mappings:
        return {"status": "skipped", "count": 0}

    with SessionLocal() as db:
        return upsert_lid_mappings(db, mappings, tenant_jid=tenant_jid)


@router.post("/remap-lids")
async def remap_lids_endpoint(payload: dict):
    """Worker LID→phone map. Persists mappings and rewrites inbox rows off @lid identifiers."""
    mappings = payload.get("mappings", [])
    tenant_jid = resolve_ingest_tenant_id(payload) or payload.get("tenant_jid") or "default"
    if not mappings:
        return {"status": "skipped", "reason": "empty_mappings"}
    with SessionLocal() as db:
        return remap_lid_identifiers(db, mappings, tenant_jid=tenant_jid)


@router.post("/sync-avatars")
async def sync_avatars_endpoint(payload: dict):
    """Worker profile-photo backfill for chats already stored."""
    avatars = payload.get("avatars", [])
    tenant_jid = payload.get("tenant_jid") or "default"
    if not avatars:
        return {"status": "skipped", "reason": "empty_avatars"}
    with SessionLocal() as db:
        return apply_avatar_updates(db, avatars, tenant_jid=tenant_jid)


@router.post("/link-tenant")
async def link_tenant_webhook(payload: dict):
    """
    Map Firebase UID ↔ connected WhatsApp phone JID and heal orphan rows
    that were previously saved under the phone JID as tenant_jid.
    """
    tenant_id = resolve_ingest_tenant_id(payload)
    phone_jid = (
        payload.get("phone_jid")
        or payload.get("wa_jid")
        or payload.get("jid")
        or ""
    )
    phone_jid = str(phone_jid).strip() or None

    if not tenant_id or tenant_id == "default" or "@" in tenant_id:
        return {"status": "skipped", "reason": "invalid_tenant_id"}

    set_wa_status(
        payload.get("status") or "connected",
        jid=phone_jid,
        tenant_id=tenant_id,
        source="link_tenant",
        isHistorySyncComplete=payload.get("isHistorySyncComplete"),
    )

    with SessionLocal() as db:
        result = relink_phone_tenant_messages(db, tenant_id, phone_jid)
        if result.get("updated"):
            db.commit()

    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "phone_jid": phone_jid,
        "relinked": result,
    }


@router.post("/auth-status")
async def auth_status_webhook(payload: dict):
    """
    Live Baileys worker → FastAPI auth lifecycle events.
    Stores Firebase UID separately from the WhatsApp phone JID.
    """
    status = payload.get("status") or payload.get("state") or "disconnected"
    tenant_id = resolve_ingest_tenant_id(payload)
    # Phone JID only — never fall back to Firebase UID for `jid`
    phone_jid = payload.get("jid") or payload.get("phone_jid") or payload.get("wa_jid")
    if phone_jid and "@" not in str(phone_jid):
        phone_jid = None

    mirrored = set_wa_status(
        status,
        jid=phone_jid,
        tenant_id=tenant_id if tenant_id != "default" else None,
        unpaired=payload.get("unpaired"),
        authenticated=payload.get("authenticated"),
        contacts_count=payload.get("contacts_count"),
        has_qr=payload.get("has_qr"),
        isHistorySyncComplete=payload.get("isHistorySyncComplete"),
        source="worker_webhook",
    )

    relinked = {"updated": 0}
    if (
        tenant_id
        and tenant_id != "default"
        and "@" not in tenant_id
        and phone_jid
        and str(status).lower() in ("connected", "authenticated", "ready", "open", "syncing")
    ):
        with SessionLocal() as db:
            relinked = relink_phone_tenant_messages(db, tenant_id, str(phone_jid))
            if relinked.get("updated"):
                db.commit()

    return {
        "status": "ok",
        "tenant_id": tenant_id,
        "tenant_jid": tenant_id,
        "jid": phone_jid,
        "relinked": relinked,
        "session": mirrored,
    }