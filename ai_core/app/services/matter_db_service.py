from datetime import datetime
from app.models.matter import Matter, NextStep, DraftOption, TimelineEvent

def save_or_update_matter(
    db,
    sender_jid: str,
    contact_name: str,
    ai_data: dict,
    tenant_jid: str = "default",
) -> Matter:
    headline = (
        (ai_data or {}).get("headline")
        or (ai_data or {}).get("summary")
        or (ai_data or {}).get("core_problem")
        or (ai_data or {}).get("title")
        or ""
    ).strip()
    if not ai_data or not ai_data.get("title") or not headline:
        return None
    situation = str(ai_data.get("situation") or "").strip()
    t_jid = str(tenant_jid or "default").strip()

    # 1. Tenant-isolated check: sirf is logged-in user ka matter dhoondho
    matter = (
        db.query(Matter)
        .filter(
            Matter.tenant_jid == t_jid,
            Matter.sender_jid == sender_jid,
        )
        .order_by(Matter.id.desc())
        .first()
    )

    if not matter:
        # Naya matter create karo tenant tag ke sath
        matter = Matter(
            tenant_jid=t_jid,
            sender_jid=sender_jid,
            contact_name=contact_name,
            title=ai_data.get("title", "New Conversation"),
            status=ai_data.get("status", "NEEDS_YOU"),
            summary=headline,
            situation=situation,
            last_activity_at=datetime.utcnow(),
        )
        db.add(matter)
        db.commit()
        db.refresh(matter)
    else:
        # Existing matter update karo
        matter.title = ai_data.get("title", matter.title)
        matter.status = ai_data.get("status", matter.status)
        matter.summary = headline
        matter.situation = situation
        matter.last_activity_at = datetime.utcnow()

        # Wipe previous steps/drafts/events strictly on this matter_id
        db.query(NextStep).filter(NextStep.matter_id == matter.id).delete()
        db.query(DraftOption).filter(DraftOption.matter_id == matter.id).delete()
        db.query(TimelineEvent).filter(TimelineEvent.matter_id == matter.id).delete()
        db.commit()

    # 2. Next Steps Insert karna
    for step_text in ai_data.get("next_steps", []):
        db.add(NextStep(matter_id=matter.id, step_text=step_text, is_completed=False))

    # 3. Draft Options Insert karna
    for draft in ai_data.get("draft_options", []):
        db.add(
            DraftOption(
                matter_id=matter.id,
                action_label=draft.get("label", ""),
                draft_text=draft.get("text", ""),
                action_type=draft.get("type", "REPLY"),
            )
        )

    # 4. Timeline Events Insert karna
    db.query(TimelineEvent).filter(TimelineEvent.matter_id == matter.id).delete()
    for event in ai_data.get("timeline_events", []):
        desc = (event.get("description") or "").strip()
        if not desc:
            continue
        db.add(
            TimelineEvent(
                matter_id=matter.id,
                date_label=event.get("date_label", "Recent"),
                event_description=desc,
            )
        )

    db.commit()
    db.refresh(matter)
    print(f"🎯 [Matter Synced ({t_jid})]: [{matter.status}] {matter.title} ({matter.contact_name})")
    return matter