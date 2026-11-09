import time
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, BackgroundTasks, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, func, or_
from sqlalchemy.orm import Session

from app.models.database import SessionLocal
from app.models.message import Message
from app.controllers.matters_controller import process_actionable_matters_in_background
from app.controllers.webhook_controller import relink_phone_tenant_messages
from app.services.audit_job_queue import upsert_audit_jobs
from app.services.audit_worker import trigger_pending_audit_pool
from app.services.contact_names import load_contact_directory, lookup_contact_labels
from app.services.firebase_auth import verified_tenant_id
from app.services.history_backfill import backfill_jids_then_wait
from app.services.jid_identity import resolve_chat_label
from app.services.phonebook_import import apply_phonebook_import
from app.services.wa_session_state import get_wa_status

router = APIRouter(prefix="/api/v1/contacts", tags=["contacts"])

TEN_DAYS_SECONDS = 10 * 86400  # 10-day discovery window
FALLBACK_CONTACT_LIMIT = 30
MS_THRESHOLD = 1_000_000_000_000  # 13-digit unix ms vs 10-digit unix sec


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _extract_tenant_id(request: Request, body_tenant: Optional[str] = None) -> str:
    """Prefer verified Firebase UID from state / verified_tenant_id; never 'default'."""
    try:
        verified = verified_tenant_id(request)
        if verified and str(verified).strip() and str(verified).strip() != "default":
            return str(verified).strip()
    except HTTPException:
        pass

    state_uid = str(getattr(request.state, "firebase_uid", "") or "").strip()
    if state_uid and state_uid != "default":
        return state_uid

    if body_tenant and str(body_tenant).strip() and str(body_tenant).strip() != "default":
        cleaned = str(body_tenant).strip()
        if "@" not in cleaned:
            return cleaned

    raise HTTPException(status_code=401, detail="Sign-in is required.")


def _reconcile_orphan_messages(db: Session, tenant_id: str) -> int:
    """
    Self-heal: if this Firebase UID owns 0 rows but phone-JID-tenant orphans
    exist (legacy ingestion), permanently reassign them to tenant_id.
    """
    owned = (
        db.query(func.count(Message.id))
        .filter(Message.tenant_jid == tenant_id)
        .scalar()
    ) or 0
    if owned > 0:
        return 0

    session = get_wa_status()
    phone_jid = session.get("jid")
    result = relink_phone_tenant_messages(db, tenant_id, phone_jid)
    updated = int(result.get("updated") or 0)
    if updated:
        db.commit()
    return updated


def _recent_window_filter(cutoff_sec: int, cutoff_ms: int):
    """
    Accept both Unix-seconds and Unix-milliseconds timestamps.

    A naive OR of (ts >= sec_cutoff | ts >= ms_cutoff) would treat every
    millisecond value as "recent" because ms >> sec. Discriminate by magnitude.
    """
    return or_(
        and_(Message.timestamp < MS_THRESHOLD, Message.timestamp >= cutoff_sec),
        and_(Message.timestamp >= MS_THRESHOLD, Message.timestamp >= cutoff_ms),
    )


def _contact_stats_query(
    db: Session,
    tenant_id: str,
    *,
    apply_time_window: bool,
    cutoff_sec: int,
    cutoff_ms: int,
    limit: Optional[int] = None,
):
    query = (
        db.query(
            Message.sender_jid,
            func.max(Message.sender_name).label("sender_name"),
            func.max(Message.phone_number).label("phone_number"),
            func.max(Message.avatar_url).label("avatar_url"),
            func.max(Message.timestamp).label("last_message_time"),
            func.count(Message.id).label("total_msgs"),
            func.sum(case((Message.media_type == "image", 1), else_=0)).label("image_count"),
            func.sum(case((Message.media_type == "audio", 1), else_=0)).label("audio_count"),
            func.max(
                case(
                    (
                        or_(
                            Message.is_group == True,  # noqa: E712
                            Message.sender_jid.like("%@g.us"),
                        ),
                        1,
                    ),
                    else_=0,
                )
            ).label("is_group"),
            func.max(case((Message.is_monitored == True, 1), else_=0)).label(  # noqa: E712
                "is_monitored"
            ),
        )
        .filter(Message.tenant_jid == tenant_id)
        .filter(~Message.sender_jid.like("%@broadcast"))
        .filter(~Message.sender_jid.like("%@newsletter"))
        .filter(~Message.message_id.like("sync-ph:%"))
        .filter(Message.sender_jid.isnot(None))
        .filter(Message.sender_jid != "")
    )

    if apply_time_window:
        query = query.filter(_recent_window_filter(cutoff_sec, cutoff_ms))

    query = query.group_by(Message.sender_jid).order_by(func.max(Message.timestamp).desc())

    if limit is not None:
        query = query.limit(limit)

    return query.all()


def _rows_to_contacts(stats, directory=None):
    from app.services.jid_identity import digits_of

    directory = directory or {}
    contacts = []
    logged = 0
    for row in stats:
        jid = row.sender_jid or ""
        if not jid or jid.endswith("@broadcast"):
            continue
        is_group = bool(row.is_group) or jid.endswith("@g.us")
        # Normalize phone to digits before address-book lookup
        raw_phone = row.phone_number or (None if is_group else jid.split("@")[0])
        phone = digits_of(raw_phone) or raw_phone
        saved_name, notify_name = lookup_contact_labels(directory, jid, phone)
        name = resolve_chat_label(row.sender_name, jid, phone, saved_name, notify_name)
        if logged < 12 and not is_group:
            print(
                f"📇 [SELECTION LOOKUP] jid={jid!r} phone_digits={phone!r} "
                f"msg.sender_name={row.sender_name!r} "
                f"contacts.name={saved_name!r} contacts.notify={notify_name!r} "
                f"→ resolved={name!r}"
            )
            logged += 1
        contacts.append(
            {
                "jid": jid,
                "sender_jid": jid,
                "name": name,
                "sender_name": name,
                "phone_number": phone,
                "avatar_url": row.avatar_url,
                "last_message_time": row.last_message_time,
                "last_activity": row.last_message_time,
                "total_msgs": int(row.total_msgs or 0),
                "image_count": int(row.image_count or 0),
                "audio_count": int(row.audio_count or 0),
                "is_group": is_group,
                "is_monitored": bool(row.is_monitored),
            }
        )
    return contacts


class MonitorSelectionRequest(BaseModel):
    tenant_jid: Optional[str] = None
    selected_jids: List[str] = Field(default_factory=list)


class GoogleContactsSyncRequest(BaseModel):
    access_token: str = Field(..., min_length=10)
    tenant_jid: Optional[str] = None


@router.get("/recent-active")
def get_recent_active_contacts(request: Request, db: Session = Depends(get_db)):
    """Active DMs and groups from the last 10 days, scoped by authenticated tenant_id."""
    tenant_id = _extract_tenant_id(request)
    now_sec = int(time.time())
    cutoff_sec = now_sec - TEN_DAYS_SECONDS
    cutoff_ms = cutoff_sec * 1000

    try:
        relinked = _reconcile_orphan_messages(db, tenant_id)

        monitored_count = (
            db.query(func.count(func.distinct(Message.sender_jid)))
            .filter(Message.tenant_jid == tenant_id)
            .filter(Message.is_monitored == True)  # noqa: E712
            .scalar()
        ) or 0

        # Resilient 10-day window: accept both second and millisecond timestamps
        # (magnitude-discriminated so ms values aren't always "recent").
        stats = _contact_stats_query(
            db,
            tenant_id,
            apply_time_window=True,
            cutoff_sec=cutoff_sec,
            cutoff_ms=cutoff_ms,
        )

        # Smart fallback: if the time filter yields 0 but messages exist, return
        # the latest unique conversations for this tenant regardless of timestamp.
        used_fallback = False
        if not stats:
            stats = _contact_stats_query(
                db,
                tenant_id,
                apply_time_window=False,
                cutoff_sec=cutoff_sec,
                cutoff_ms=cutoff_ms,
                limit=FALLBACK_CONTACT_LIMIT,
            )
            used_fallback = bool(stats)

        # Only resolve names for chats on this desk — never load the full address book.
        desk_jids = [row.sender_jid for row in stats if row.sender_jid]
        desk_phones = [row.phone_number for row in stats if row.phone_number]
        directory = load_contact_directory(
            db,
            tenant_id,
            jids=desk_jids,
            phone_numbers=desk_phones,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load active contacts: {e}") from e

    contacts = _rows_to_contacts(stats, directory)
    direct_chats = [c for c in contacts if not c["is_group"]]
    groups = [c for c in contacts if c["is_group"]]

    return {
        "status": "success",
        "tenant_id": tenant_id,
        "tenant_jid": tenant_id,
        "days": 10,
        "monitored_count": int(monitored_count),
        "relinked_messages": int(relinked),
        "window_fallback": used_fallback,
        "contacts": contacts,
        "count": len(contacts),
        "direct_chats_count": len(direct_chats),
        "groups_count": len(groups),
        "direct_count": len(direct_chats),
        "group_count": len(groups),
        "data": {
            "dms": direct_chats,
            "groups": groups,
            "total_active": len(contacts),
        },
    }


@router.post("/sync-google")
def sync_google_contacts(
    payload: GoogleContactsSyncRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """
    Use a Google OAuth access token (contacts.readonly) to pull People API
    connections and map display names onto WhatsApp contacts by phone digits.
    """
    tenant_id = _extract_tenant_id(request, payload.tenant_jid)
    token = (payload.access_token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="access_token is required")

    try:
        from app.services.google_contacts import apply_google_contacts

        result = apply_google_contacts(db, tenant_id=tenant_id, access_token=token)
        result["tenant_id"] = tenant_id
        print(
            f"📒 [GOOGLE SYNC DONE] tenant={tenant_id} "
            f"updated={result.get('updated_contacts')} matched={result.get('matched')}"
        )
        return result
    except PermissionError as err:
        raise HTTPException(status_code=403, detail=str(err)) from err
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=500, detail=f"Google contacts sync failed: {e}"
        ) from e


@router.post("/import-phonebook")
async def import_phonebook(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """
    Upload a phone-exported .vcf / .csv and map saved names onto WhatsApp contacts
    by phone-number digits, then settle weak message labels.
    """
    tenant_id = _extract_tenant_id(request)
    filename = (file.filename or "contacts.vcf").strip()
    lower = filename.lower()
    if not (lower.endswith(".vcf") or lower.endswith(".csv") or lower.endswith(".txt")):
        raise HTTPException(
            status_code=400,
            detail="Upload a .vcf (vCard) or .csv phonebook export",
        )

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(raw) > 8 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 8MB)")

    try:
        result = apply_phonebook_import(
            db,
            tenant_id=tenant_id,
            filename=filename,
            raw_bytes=raw,
        )
        result["tenant_id"] = tenant_id
        return result
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Phonebook import failed: {e}") from e


@router.post("/set-monitored")
def set_monitored_contacts(
    payload: MonitorSelectionRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """
    1. Scoped to authenticated tenant_id (Firebase UID).
    2. Reset previous monitoring flags for this tenant only.
    3. Mark selected JIDs as is_monitored = True.
    4. Trigger background AI synthesis ONLY for newly monitored chats.
    """
    tenant_id = _extract_tenant_id(request, payload.tenant_jid)
    selected = [jid.strip() for jid in (payload.selected_jids or []) if jid and str(jid).strip()]

    try:
        db.query(Message).filter(Message.tenant_jid == tenant_id).update(
            {Message.is_monitored: False},
            synchronize_session=False,
        )

        if selected:
            db.query(Message).filter(
                Message.tenant_jid == tenant_id,
                Message.sender_jid.in_(selected),
            ).update(
                {Message.is_monitored: True},
                synchronize_session=False,
            )

        # Drop Today Desk cards for chats the user did NOT select this round
        from app.models.matter_card import MatterCard

        if selected:
            pruned = (
                db.query(MatterCard)
                .filter(
                    MatterCard.tenant_id == tenant_id,
                    ~MatterCard.jid.in_(selected),
                )
                .delete(synchronize_session=False)
            )
        else:
            pruned = (
                db.query(MatterCard)
                .filter(MatterCard.tenant_id == tenant_id)
                .delete(synchronize_session=False)
            )
        if pruned:
            print(
                f"🧹 [SET-MONITORED] Removed {pruned} MatterCards outside selection "
                f"(tenant={tenant_id})"
            )

        db.commit()

        queued_jobs = 0
        if selected:
            # Resolve display names for audit cards
            name_rows = (
                db.query(Message.sender_jid, func.max(Message.sender_name))
                .filter(
                    Message.tenant_jid == tenant_id,
                    Message.sender_jid.in_(selected),
                )
                .group_by(Message.sender_jid)
                .all()
            )
            name_map = {
                str(jid): (name or "").strip() or str(jid).split("@")[0]
                for jid, name in name_rows
            }
            contacts = [
                {
                    "jid": jid,
                    "name": name_map.get(jid, jid.split("@")[0] or "Unknown Contact"),
                    "is_group": jid.endswith("@g.us"),
                }
                for jid in selected
            ]
            queued_jobs = upsert_audit_jobs(db, tenant_id, contacts)

            def _backfill_then_audit(tid: str, jids: list[str]) -> None:
                # 1) Pull older WhatsApp history into SQLite (no OpenAI tokens)
                with SessionLocal() as session:
                    backfill_jids_then_wait(
                        session,
                        tenant_id=tid,
                        jids=jids,
                        settle_seconds=8.0,
                    )
                # 2) Then run AI on whatever is now in DB (monitored only)
                trigger_pending_audit_pool(tid)
                process_actionable_matters_in_background(tenant_jid=tid)

            background_tasks.add_task(_backfill_then_audit, tenant_id, list(selected))

        return {
            "status": "success",
            "tenant_id": tenant_id,
            "tenant_jid": tenant_id,
            "monitored_count": len(selected),
            "queued_audit_jobs": queued_jobs,
            "message": (
                "Monitoring updated. Fetching extra WhatsApp history for selected "
                "chats, then starting AI audit."
            ),
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e)) from e
