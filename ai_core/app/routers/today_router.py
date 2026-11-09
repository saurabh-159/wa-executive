"""
Today Desk delivery & sync endpoints for MatterCard progressive UI.

Serves matter cards from the Phase 1–3 audit pipeline (MatterCard / ChatAuditJob),
with a fallback to the legacy CRM Matter table when MatterCard rows are empty.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.models.chat_audit_job import ChatAuditJob
from app.models.database import get_db
from app.models.matter import Matter
from app.models.matter_card import MatterCard
from app.models.message import Message
from app.services.firebase_auth import verified_tenant_id

router = APIRouter(prefix="/api/v1/matters", tags=["today-matters"])

VALID_STATUSES = {"Needs you", "Waiting", "Later", "Done", "Sessions"}

# Map UI tab labels <-> stored enum / badge variants
_STATUS_ALIASES = {
    "needs you": ["Needs you", "NEEDS_YOU"],
    "waiting": ["Waiting", "WAITING"],
    "done": ["Done", "DONE"],
    "later": ["Later", "LATER"],
    "sessions": ["Sessions", "SESSIONS"],
}


class ActionItemUpdate(BaseModel):
    index: int
    done: bool


class StatusUpdateRequest(BaseModel):
    new_status: str = Field(description="'Needs you', 'Waiting', 'Later', 'Done', or 'Sessions'")


class MatterActionRequest(BaseModel):
    """Complete/check off a checklist item and/or update matter status."""

    checklist_item: Optional[ActionItemUpdate] = None
    new_status: Optional[str] = None


def _resolve_tenant(
    request: Request,
    tenant_jid: Optional[str] = None,
    tenant_id: Optional[str] = None,
) -> str:
    """Prefer explicit query tenant, then verified auth / header tenant."""
    active = (tenant_jid or tenant_id or "").strip()
    if active:
        return active
    return verified_tenant_id(request)


def _normalize_badge(raw_status: Optional[str]) -> str:
    raw = (raw_status or "Needs you").lower().replace("_", " ")
    if "need" in raw:
        return "Needs you"
    if "wait" in raw:
        return "Waiting"
    if "done" in raw:
        return "Done"
    if "session" in raw:
        return "Sessions"
    return "Later"


def _status_filter_values(status: Optional[str]) -> Optional[List[str]]:
    if not status or status.strip().lower() in ("all", ""):
        return None
    key = status.strip().lower().replace("_", " ")
    return _STATUS_ALIASES.get(key) or [status.strip()]


def _avatars_for_jids(db: Session, tenant_id: str, jids: List[str]) -> Dict[str, str]:
    """Latest non-empty WhatsApp avatar_url per chat JID."""
    clean = [str(j).strip() for j in jids if j and str(j).strip()]
    if not clean or not tenant_id:
        return {}
    rows = (
        db.query(Message.sender_jid, Message.avatar_url, Message.timestamp)
        .filter(Message.tenant_jid == tenant_id)
        .filter(Message.sender_jid.in_(clean))
        .filter(Message.avatar_url.isnot(None))
        .filter(Message.avatar_url != "")
        .order_by(Message.timestamp.desc())
        .all()
    )
    found: Dict[str, str] = {}
    for jid, url, _ts in rows:
        if jid not in found and url:
            found[str(jid)] = str(url).strip()
    return found


def _attach_avatars(
    db: Session, tenant_id: str, cards: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    jids = [c.get("jid") for c in cards if c.get("jid")]
    avatars = _avatars_for_jids(db, tenant_id, jids)
    for card in cards:
        jid = card.get("jid")
        if jid and jid in avatars:
            card["avatar_url"] = avatars[jid]
        else:
            card.setdefault("avatar_url", None)
    return cards


def _serialize_card(card: MatterCard) -> Dict[str, Any]:
    badge = _normalize_badge(card.status_filter)
    label = card.source_label or "Contact"
    return {
        "id": card.id,
        "matter_id": card.matter_id,
        "jid": card.jid,
        "headline": card.headline,
        "summary": card.summary,
        "source_label": label,
        "status_filter": badge,
        "priority_dot": card.priority_dot or "red",
        "timestamp_display": card.timestamp_display or "Today",
        "avatar_url": None,
        "action_checklist": card.action_checklist or [],
        "draft_options": [],
        "suggested_quick_replies": card.suggested_quick_replies
        or [
            f"Tell {label} the affirmative in plain speech — draft reply",
            f"I'll call {label} myself — keep it open",
        ],
        "resolved_notes": card.resolved_notes or [],
        "timeline_context": [{"date": "Today", "text": card.summary}],
        "created_at": card.created_at.isoformat() if card.created_at else None,
        "updated_at": card.updated_at.isoformat() if card.updated_at else None,
    }


def _serialize_legacy_matter(m: Matter) -> Dict[str, Any]:
    badge = _normalize_badge(m.status)
    label = m.contact_name or "Contact"
    summary = m.summary or m.situation or m.title or ""
    checklist = [
        {"text": step.step_text, "done": bool(step.is_completed)}
        for step in (m.next_steps or [])
    ]
    draft_options = [
        {
            "id": d.id,
            "action_label": d.action_label or "Reply",
            "draft_text": d.draft_text or "",
            "action_type": (d.action_type or "REPLY").upper(),
            "is_used": bool(getattr(d, "is_used", False)),
        }
        for d in (m.draft_options or [])
        if (d.action_label or d.draft_text)
    ]
    replies = [
        d["action_label"] if d["action_label"] else d["draft_text"]
        for d in draft_options
    ]
    timeline = [
        {"date": ev.date_label or "Earlier", "text": ev.event_description}
        for ev in (m.timeline_events or [])
    ] or [{"date": "Today", "text": summary}]

    ts = "Today"
    if m.last_activity_at:
        ts = m.last_activity_at.strftime("%H:%M")

    return {
        "id": m.id,
        "matter_id": f"legacy_{m.id}",
        "jid": m.sender_jid,
        "headline": m.title,
        "summary": summary,
        "source_label": label,
        "status_filter": badge,
        "priority_dot": "red" if badge == "Needs you" else "orange" if badge == "Waiting" else "green",
        "timestamp_display": ts,
        "action_checklist": checklist,
        "draft_options": draft_options,
        "suggested_quick_replies": replies
        or [
            f"Tell {label} the affirmative in plain speech — draft reply",
            f"I'll call {label} myself — keep it open",
        ],
        "resolved_notes": [],
        "timeline_context": timeline,
        "avatar_url": None,
        "created_at": m.created_at.isoformat() if m.created_at else None,
        "updated_at": m.last_activity_at.isoformat() if m.last_activity_at else None,
    }


@router.get("/audit-progress")
async def get_audit_progress(
    request: Request,
    tenant_jid: Optional[str] = Query(None),
    tenant_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """Returns live progress of background chat audits."""
    target_tenant = _resolve_tenant(request, tenant_jid, tenant_id)

    query = db.query(ChatAuditJob).filter(ChatAuditJob.tenant_id == target_tenant)
    total = query.count()
    completed = query.filter(
        ChatAuditJob.status.in_(["COMPLETED", "COMPLETED_NO_ACTION", "FAILED"])
    ).count()
    pending = query.filter(
        ChatAuditJob.status.in_(["PENDING", "CHUNKING", "EMBEDDING", "RUNNING"])
    ).count()

    failed = query.filter(ChatAuditJob.status == "FAILED").count()
    no_action = query.filter(ChatAuditJob.status == "COMPLETED_NO_ACTION").count()
    last_error = (
        db.query(ChatAuditJob.error_message)
        .filter(
            ChatAuditJob.tenant_id == target_tenant,
            ChatAuditJob.error_message.isnot(None),
            ChatAuditJob.error_message != "",
        )
        .order_by(ChatAuditJob.updated_at.desc())
        .limit(1)
        .scalar()
    )

    return {
        "total_jobs": total,
        "completed_jobs": completed,
        "failed_jobs": failed,
        "no_action_jobs": no_action,
        "is_auditing": pending > 0,
        "progress_percent": int((completed / total) * 100) if total > 0 else 100,
        "last_error": last_error,
    }


def _monitored_jids(db: Session, tenant_id: str) -> list[str]:
    """JIDs currently flagged is_monitored for this tenant (Selection Desk selection)."""
    rows = (
        db.query(Message.sender_jid)
        .filter(
            Message.tenant_jid == tenant_id,
            Message.is_monitored == True,  # noqa: E712
            Message.sender_jid.isnot(None),
            Message.sender_jid != "",
        )
        .distinct()
        .all()
    )
    return [str(r[0]).strip() for r in rows if r and r[0]]


@router.get("/cards")
async def get_matter_cards(
    request: Request,
    tenant_jid: Optional[str] = Query(None),
    tenant_id: Optional[str] = Query(None),
    status: Optional[str] = Query(
        None, description="Needs you, Waiting, Later, Done, Sessions, or None/All"
    ),
    search: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """
    Fetches MatterCard rows for Today Desk — ONLY for currently monitored chats.
    Path is /cards to avoid clashing with the legacy CRM GET /api/v1/matters feed.
    """
    active_tenant = _resolve_tenant(request, tenant_jid, tenant_id)
    monitored = _monitored_jids(db, active_tenant)
    print(
        f"\n📥 [API FETCH MATTERS] tenant_jid: '{active_tenant}' | tab filter: '{status}' "
        f"| monitored_jids={len(monitored)}"
    )

    status_values = _status_filter_values(status)

    # Strict Selection Desk gate: never show cards for unselected contacts
    if not monitored:
        print("📦 [API RETURN] 0 cards — no monitored contacts for this tenant")
        return {
            "success": True,
            "cards": [],
            "matters": [],
            "total": 0,
            "counts": {"needs_you": 0, "total": 0},
        }

    query = (
        db.query(MatterCard)
        .filter(
            MatterCard.tenant_id == active_tenant,
            MatterCard.jid.in_(monitored),
        )
    )
    if status_values:
        query = query.filter(MatterCard.status_filter.in_(status_values))

    if search and search.strip():
        search_fmt = f"%{search.strip()}%"
        query = query.filter(
            (MatterCard.headline.ilike(search_fmt))
            | (MatterCard.summary.ilike(search_fmt))
            | (MatterCard.source_label.ilike(search_fmt))
        )

    db_cards = query.order_by(MatterCard.created_at.desc()).all()
    serialized: List[Dict[str, Any]] = [_serialize_card(c) for c in db_cards]

    # Fallback: audit pipeline may still be empty while legacy CRM matters exist
    # (still scoped to monitored JIDs only).
    if not serialized:
        legacy_q = db.query(Matter).filter(
            Matter.tenant_jid == active_tenant,
            Matter.sender_jid.in_(monitored),
        )
        if status_values:
            legacy_q = legacy_q.filter(Matter.status.in_(status_values))
        if search and search.strip():
            search_fmt = f"%{search.strip()}%"
            legacy_q = legacy_q.filter(
                (Matter.title.ilike(search_fmt))
                | (Matter.summary.ilike(search_fmt))
                | (Matter.contact_name.ilike(search_fmt))
            )
        legacy_rows = legacy_q.order_by(Matter.last_activity_at.desc()).all()
        serialized = [_serialize_legacy_matter(m) for m in legacy_rows]
        print(
            f"📦 [API RETURN] MatterCards empty — fell back to {len(serialized)} legacy Matters "
            f"(monitored only)"
        )
    else:
        print(
            f"📦 [API RETURN] Found {len(serialized)} MatterCards for tenant '{active_tenant}' "
            f"(monitored={len(monitored)})"
        )

    serialized = _attach_avatars(db, active_tenant, serialized)

    needs_count = (
        db.query(MatterCard)
        .filter(
            MatterCard.tenant_id == active_tenant,
            MatterCard.jid.in_(monitored),
            MatterCard.status_filter.in_(["Needs you", "NEEDS_YOU"]),
        )
        .count()
    )
    if needs_count == 0:
        needs_count = (
            db.query(Matter)
            .filter(
                Matter.tenant_jid == active_tenant,
                Matter.sender_jid.in_(monitored),
                Matter.status.in_(["Needs you", "NEEDS_YOU"]),
            )
            .count()
        )

    return {
        "success": True,
        "cards": serialized,
        "matters": serialized,
        "total": len(serialized),
        "counts": {
            "needs_you": needs_count,
            "total": len(serialized),
        },
    }


@router.patch("/{matter_id}/status")
async def update_matter_status(
    matter_id: str,
    payload: StatusUpdateRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    tenant_id = verified_tenant_id(request)

    if payload.new_status not in VALID_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status. Expected one of: {sorted(VALID_STATUSES)}",
        )

    card = (
        db.query(MatterCard)
        .filter(
            MatterCard.tenant_id == tenant_id,
            MatterCard.matter_id == matter_id,
        )
        .first()
    )

    if card:
        card.status_filter = payload.new_status
        card.updated_at = datetime.utcnow()
        db.commit()
        return {"success": True, "updated_status": payload.new_status}

    # Legacy fallback for cards served from Matter table
    if matter_id.startswith("legacy_"):
        try:
            legacy_id = int(matter_id.replace("legacy_", "", 1))
        except ValueError:
            raise HTTPException(status_code=404, detail="Matter not found")
        matter = (
            db.query(Matter)
            .filter(Matter.tenant_jid == tenant_id, Matter.id == legacy_id)
            .first()
        )
        if not matter:
            raise HTTPException(status_code=404, detail="Matter not found")
        # Persist enum form for legacy table
        enum_map = {
            "Needs you": "NEEDS_YOU",
            "Waiting": "WAITING",
            "Later": "LATER",
            "Done": "DONE",
            "Sessions": "SESSIONS",
        }
        matter.status = enum_map.get(payload.new_status, payload.new_status.upper())
        db.commit()
        return {"success": True, "updated_status": payload.new_status}

    raise HTTPException(status_code=404, detail="Matter not found")


@router.post("/{matter_id}/action")
async def matter_action(
    matter_id: str,
    payload: MatterActionRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Complete/check off checklist tasks or update matter status."""
    tenant_id = verified_tenant_id(request)

    card = (
        db.query(MatterCard)
        .filter(
            MatterCard.tenant_id == tenant_id,
            MatterCard.matter_id == matter_id,
        )
        .first()
    )

    if card:
        if payload.new_status is not None:
            if payload.new_status not in VALID_STATUSES:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid status. Expected one of: {sorted(VALID_STATUSES)}",
                )
            card.status_filter = payload.new_status

        if payload.checklist_item is not None:
            checklist: List[Dict[str, Any]] = list(card.action_checklist or [])
            idx = payload.checklist_item.index
            if idx < 0 or idx >= len(checklist):
                raise HTTPException(status_code=400, detail="Checklist index out of range")
            item = dict(checklist[idx])
            item["done"] = bool(payload.checklist_item.done)
            checklist[idx] = item
            card.action_checklist = checklist

        card.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(card)
        return {"success": True, "matter": _serialize_card(card)}

    if matter_id.startswith("legacy_"):
        try:
            legacy_id = int(matter_id.replace("legacy_", "", 1))
        except ValueError:
            raise HTTPException(status_code=404, detail="Matter not found")
        matter = (
            db.query(Matter)
            .filter(Matter.tenant_jid == tenant_id, Matter.id == legacy_id)
            .first()
        )
        if not matter:
            raise HTTPException(status_code=404, detail="Matter not found")

        if payload.new_status is not None:
            if payload.new_status not in VALID_STATUSES:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid status. Expected one of: {sorted(VALID_STATUSES)}",
                )
            enum_map = {
                "Needs you": "NEEDS_YOU",
                "Waiting": "WAITING",
                "Later": "LATER",
                "Done": "DONE",
                "Sessions": "SESSIONS",
            }
            matter.status = enum_map.get(payload.new_status, payload.new_status.upper())

        if payload.checklist_item is not None:
            steps = list(matter.next_steps or [])
            idx = payload.checklist_item.index
            if idx < 0 or idx >= len(steps):
                raise HTTPException(status_code=400, detail="Checklist index out of range")
            steps[idx].is_completed = bool(payload.checklist_item.done)

        db.commit()
        db.refresh(matter)
        return {"success": True, "matter": _serialize_legacy_matter(matter)}

    raise HTTPException(status_code=404, detail="Matter not found")
