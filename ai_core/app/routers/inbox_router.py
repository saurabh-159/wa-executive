from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Request
from app.controllers.inbox_controller import (
    get_inbox_chats,
    get_chat_conversation,
    send_chat_message,
    transcribe_chat_voice_notes,
)

router = APIRouter(prefix="/api/v1/inbox", tags=["WhatsApp Inbox"])


def _sanitize_tenant(tid: Optional[str]) -> str:
    """Firebase UID / JID safe alphanumeric cleaner."""
    if not tid or not isinstance(tid, str):
        return ""
    return "".join(c for c in tid.strip() if c.isalnum() or c in ("_", "-"))


def _verify_tenant_context(request: Request) -> str:
    """
    Ensure X-Tenant-JID header or tenant_id/tenant_jid query parameter exists
    to prevent cross-tenant data leaks across windows/incognito.
    """
    tenant_jid = (
        request.headers.get("x-tenant-jid")
        or request.headers.get("X-Tenant-JID")
        or request.query_params.get("tenant_jid")
        or request.query_params.get("tenant_id")
    )

    clean_tenant = _sanitize_tenant(tenant_jid)

    if not clean_tenant:
        raise HTTPException(
            status_code=400,
            detail="Missing X-Tenant-JID header or tenant query parameter. Tenant isolation required.",
        )
    return clean_tenant


# Saare chats list karna (Tenant Isolated)
@router.get("/chats")
async def fetch_all_chats(
    request: Request,
    tenant_id: str = Depends(_verify_tenant_context),
):
    """
    Returns chats scoped strictly to the calling tenant.
    Reads tenant_id from headers or query parameters.
    """
    return await get_inbox_chats(request, tenant_id=tenant_id)


# Kisi ek contact ki puri chat nikaalna (Tenant Isolated)
@router.get("/chats/{jid:path}/messages")
async def fetch_single_chat(
    jid: str,
    request: Request,
    tenant_id: str = Depends(_verify_tenant_context),
):
    """
    Fetches raw conversation history strictly for the calling tenant.
    """
    return await get_chat_conversation(jid, request, tenant_id=tenant_id)


# Audio voice notes transcribe karna
@router.post("/chats/{jid:path}/transcribe")
async def transcribe_chat_audio(
    jid: str,
    request: Request,
    tenant_id: str = Depends(_verify_tenant_context),
):
    return await transcribe_chat_voice_notes(jid, request, tenant_id=tenant_id)


# WhatsApp message send karna
@router.post("/chats/{jid:path}/send")
async def send_message_endpoint(
    jid: str,
    request: Request,
    tenant_id: str = Depends(_verify_tenant_context),
):
    return await send_chat_message(jid, request, tenant_id=tenant_id)