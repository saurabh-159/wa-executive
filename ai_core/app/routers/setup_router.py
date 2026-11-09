from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.database import get_db
from app.services.audit_job_queue import queue_monitored_audit_jobs, upsert_audit_jobs
from app.services.audit_worker import trigger_pending_audit_pool
from app.services.firebase_auth import verified_tenant_id

router = APIRouter(prefix="/api/v1/assistant", tags=["assistant-setup"])


class ContactItem(BaseModel):
    jid: str
    name: str = "Unknown Contact"
    isGroup: bool = False


class MonitoredSelectionRequest(BaseModel):
    contacts: List[ContactItem]


@router.post("/initialize-audit-jobs")
async def initialize_audit_jobs(
    payload: MonitoredSelectionRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """
    Fast non-blocking selection: register PENDING ChatAuditJob rows and return 200 OK
    so the client can queue 40+ contacts without waiting on ingestion.
    """
    tenant_id = verified_tenant_id(request)

    if not payload.contacts:
        raise HTTPException(status_code=400, detail="No contacts provided")

    queued_count = upsert_audit_jobs(
        db,
        tenant_id,
        [
            {"jid": c.jid, "name": c.name, "isGroup": c.isGroup}
            for c in payload.contacts
        ],
    )

    background_tasks.add_task(trigger_pending_audit_pool, tenant_id)

    return {
        "success": True,
        "message": f"Successfully queued and started audit for {queued_count} chats.",
        "queued_jobs": queued_count,
    }


@router.post("/bootstrap-audit-from-monitored")
async def bootstrap_audit_from_monitored(
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """
    Recovery path: if selection already saved monitored JIDs but never queued
    ChatAuditJob rows (empty Today Desk), invent jobs from is_monitored messages
    and start the pool. Idempotent for in-flight jobs.
    """
    tenant_id = verified_tenant_id(request)
    queued_count = queue_monitored_audit_jobs(db, tenant_id)

    if queued_count:
        background_tasks.add_task(trigger_pending_audit_pool, tenant_id)

    return {
        "success": True,
        "queued_jobs": queued_count,
        "message": (
            f"Queued audit for {queued_count} monitored chat(s)."
            if queued_count
            else "No monitored chats to audit (or jobs already running)."
        ),
    }
