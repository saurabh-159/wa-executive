from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.models.database import SessionLocal
from app.controllers.matters_controller import (
    get_matters_feed,
    get_matter_details,
    get_matter_raw_chat,
    send_draft_reply,
    toggle_next_step,
    process_actionable_matters_in_background,
    generate_matters_from_recent_history,
    process_selected_jids_in_background,
    process_monitored_matters_in_background,
)

router = APIRouter(prefix="/api/v1/matters", tags=["Matters & CRM"])


def _sanitize_tenant(tid: Optional[str]) -> str:
    """Firebase UID / JID safe alphanumeric cleaner."""
    if not tid or not isinstance(tid, str):
        return "default"
    clean = "".join(c for c in tid.strip() if c.isalnum() or c in ("_", "-"))
    return clean or "default"


def extract_tenant_id(
    request: Request,
    x_tenant_jid: Optional[str] = Header(None, alias="X-Tenant-JID"),
) -> str:
    """Header ya query params se isolated tenant ID nikalna."""
    if x_tenant_jid and x_tenant_jid.strip():
        return _sanitize_tenant(x_tenant_jid)
    header_val = request.headers.get("x-tenant-jid") or request.headers.get("X-Tenant-JID")
    if header_val and header_val.strip():
        return _sanitize_tenant(header_val)
    query_val = request.query_params.get("tenant_jid") or request.query_params.get("tenant_id")
    if query_val and query_val.strip():
        return _sanitize_tenant(query_val)
    return "default"


class TriggerBackgroundSyncBody(BaseModel):
    target_jid: Optional[str] = Field(
        default=None,
        description="If set, prioritize generating/updating the matter for this contact first.",
    )
    tenant_jid: Optional[str] = Field(
        default=None,
        description="Firebase tenant UID override if sent in body.",
    )


class ProcessSelectedBody(BaseModel):
    selected_jids: List[str] = Field(default_factory=list)
    tenant_jid: Optional[str] = Field(
        default=None,
        description="Firebase tenant UID override if sent in body.",
    )


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# 1. Left Panel List (Tenant-Scoped)
@router.get("")
async def list_matters_endpoint(
    request: Request,
    tenant_id: str = Depends(extract_tenant_id),
):
    """Today Desk left feed ke liye matters laata hai."""
    return await get_matters_feed(request, tenant_id=tenant_id)


@router.post("/trigger-background-sync")
async def trigger_background_matters(
    request: Request,
    background_tasks: BackgroundTasks,
    body: TriggerBackgroundSyncBody = TriggerBackgroundSyncBody(),
    tenant_id: str = Depends(extract_tenant_id),
):
    """
    Scan settle / burst debounce ke baad worker isko call karke turant 200 return karta hai.
    Optional `{ target_jid }` → us contact ko pehle process karo.
    """
    active_tenant = _sanitize_tenant(body.tenant_jid) if body.tenant_jid else tenant_id
    target_jid = (body.target_jid or "").strip() or None

    background_tasks.add_task(
        process_actionable_matters_in_background,
        max_chats=8,
        target_jid=target_jid,
        tenant_jid=active_tenant,
    )
    return {
        "status": "queued",
        "message": "Background matter generation started",
        "target_jid": target_jid,
        "tenant_id": active_tenant,
    }


@router.post("/sync-recent")
def manual_sync_recent(
    request: Request,
    db: Session = Depends(get_db),
    tenant_id: str = Depends(extract_tenant_id),
):
    """Today Desk par Sync Now click hone par call hota hai."""
    return generate_matters_from_recent_history(db, max_chats=10, tenant_jid=tenant_id)


@router.post("/process-selected")
async def process_selected_matters(
    request: Request,
    background_tasks: BackgroundTasks,
    body: ProcessSelectedBody = ProcessSelectedBody(),
    tenant_id: str = Depends(extract_tenant_id),
):
    """
    Settings Contact Selection Gate — queue matter generation for chosen JIDs.
    Falls back to is_monitored rows when selected_jids is empty.
    """
    active_tenant = _sanitize_tenant(body.tenant_jid) if body.tenant_jid else tenant_id
    selected = [jid.strip() for jid in (body.selected_jids or []) if jid and str(jid).strip()]

    if selected:
        background_tasks.add_task(
            process_selected_jids_in_background,
            selected,
            tenant_jid=active_tenant,
        )
    else:
        background_tasks.add_task(
            process_monitored_matters_in_background,
            tenant_jid=active_tenant,
        )

    return {
        "status": "queued",
        "message": "Selected contact analysis started",
        "selected_count": len(selected),
        "tenant_id": active_tenant,
    }


# 2. Center Panel Details (Tenant-Scoped)
@router.get("/{matter_id}/details")
async def matter_details_endpoint(
    matter_id: int,
    tenant_id: str = Depends(extract_tenant_id),
):
    return await get_matter_details(matter_id, tenant_id=tenant_id)


# 3. Right Panel Raw WhatsApp Chat Stream (Tenant-Scoped)
@router.get("/{matter_id}/raw-chat")
async def matter_raw_chat_endpoint(
    matter_id: int,
    request: Request,
    tenant_id: str = Depends(extract_tenant_id),
):
    return await get_matter_raw_chat(matter_id, request, tenant_id=tenant_id)


# 4. Action: 1-Click WhatsApp Draft Deliver
@router.post("/{matter_id}/send-draft")
async def send_draft_endpoint(
    matter_id: int,
    request: Request,
    tenant_id: str = Depends(extract_tenant_id),
):
    return await send_draft_reply(matter_id, request, tenant_id=tenant_id)


# 5. Action: Checkbox Toggle
@router.patch("/steps/{step_id}/toggle")
async def toggle_step_endpoint(
    step_id: int,
    tenant_id: str = Depends(extract_tenant_id),
):
    return await toggle_next_step(step_id, tenant_id=tenant_id)