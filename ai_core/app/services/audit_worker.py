import asyncio
import time
import uuid
from datetime import datetime
from typing import Any, Dict

from sqlalchemy import and_, or_, text
from sqlalchemy.orm import Session

from app.models.chat_audit_job import ChatAuditJob
from app.models.database import SessionLocal
from app.models.matter_card import MatterCard
from app.models.message import Message
from app.services.contact_names import load_contact_directory, lookup_contact_labels
from app.services.jid_identity import resolve_chat_label
from app.services.matter_extractor import extract_matters_from_context
from app.services.pattern_ingestion import (
    generate_sliding_window_chunks,
    ingest_chat_vectors,
    retrieve_universal_pattern_chunks,
)

# Cap parallel audits so selecting many chats never saturates the event loop / OpenAI
AUDIT_SEMAPHORE = asyncio.Semaphore(3)


def _normalize_status_filter(raw: str | None) -> str:
    """Map LLM output onto Today Desk tabs: Needs you / Waiting / Done."""
    value = (raw or "").strip()
    lowered = value.lower().replace("_", " ").replace("-", " ")
    if lowered in {"needs you", "needsyou", "action required", "todo"}:
        return "Needs you"
    if lowered in {"waiting", "waiting on them", "pending them"}:
        return "Waiting"
    if lowered in {"done", "resolved", "completed", "closed"}:
        return "Done"
    if lowered in {"later", "parked", "low priority"}:
        return "Later"
    # Default actionable so new cards surface under Needs you
    return "Needs you"


def _heuristic_matters_from_messages(
    chat_name: str,
    raw_messages: list,
) -> list[Dict[str, Any]]:
    """
    Offline fallback when OpenAI embeddings/LLM are unavailable (e.g. 429 credits).
    Builds one actionable MatterCard from the latest non-empty messages.
    """
    texts = [
        m for m in (raw_messages or [])
        if isinstance(m, dict) and (m.get("text") or "").strip()
    ]
    if not texts:
        return []

    recent = texts[-8:]
    last = recent[-1]
    preview_bits = []
    for row in recent[-3:]:
        sender = (row.get("sender") or "Contact").strip()
        body = (row.get("text") or "").strip().replace("\n", " ")
        if len(body) > 90:
            body = body[:87] + "…"
        preview_bits.append(f"{sender}: {body}")

    last_body = (last.get("text") or "").strip().replace("\n", " ")
    headline_src = last_body[:48] + ("…" if len(last_body) > 48 else "")
    headline = headline_src or f"Follow up with {chat_name}"

    last_sender = (last.get("sender") or "").strip().lower()
    from_me_last = bool(last.get("from_me") or last.get("is_from_me")) or last_sender.startswith(
        "[you"
    ) or last_sender == "you"
    status = "Waiting" if from_me_last else "Needs you"

    return [
        {
            "headline": headline,
            "summary": " · ".join(preview_bits) or f"Recent thread with {chat_name}.",
            "status_filter": status,
            "priority_dot": "orange",
            "timestamp_display": last.get("time") or "Recent",
            "action_checklist": [
                {"text": f"Review latest messages with {chat_name}", "done": False},
                {"text": "Decide next reply or follow-up", "done": False},
            ],
            "suggested_quick_replies": [
                f"Thanks — I'll get back to {chat_name} shortly.",
                "Got it, following up now.",
            ],
            "resolved_notes": [],
        }
    ]


def _persist_matter_dicts(
    db: Session,
    tenant_id: str,
    jid: str,
    chat_name: str,
    matters: list,
    context_excerpt: str | None,
) -> int:
    """Replace cards for this JID with the provided matter dicts / pydantic models."""
    db.query(MatterCard).filter(
        MatterCard.tenant_id == tenant_id,
        MatterCard.jid == jid,
    ).delete()

    saved = 0
    for m in matters:
        if hasattr(m, "headline"):
            headline = m.headline
            summary = m.summary
            status_filter = _normalize_status_filter(getattr(m, "status_filter", None))
            priority_dot = getattr(m, "priority_dot", None) or "orange"
            timestamp_display = getattr(m, "timestamp_display", None) or "Recent"
            checklist = [item.model_dump() for item in (m.action_checklist or [])]
            replies = list(m.suggested_quick_replies or [])
            notes = list(m.resolved_notes or [])
        else:
            headline = m.get("headline") or f"Follow up with {chat_name}"
            summary = m.get("summary") or ""
            status_filter = _normalize_status_filter(m.get("status_filter"))
            priority_dot = m.get("priority_dot") or "orange"
            timestamp_display = m.get("timestamp_display") or "Recent"
            checklist = list(m.get("action_checklist") or [])
            replies = list(m.get("suggested_quick_replies") or [])
            notes = list(m.get("resolved_notes") or [])

        db.add(
            MatterCard(
                tenant_id=tenant_id,
                jid=jid,
                matter_id=f"mat_{uuid.uuid4().hex[:10]}",
                headline=headline,
                summary=summary,
                source_label=chat_name,
                status_filter=status_filter,
                priority_dot=priority_dot,
                timestamp_display=timestamp_display,
                action_checklist=checklist,
                suggested_quick_replies=replies,
                resolved_notes=notes,
                raw_context_excerpt=(context_excerpt or "")[:500] or None,
            )
        )
        saved += 1
        print(f"   -> Saved Card: [{status_filter}] '{headline}'")
    return saved

TEN_DAYS_SECONDS = 10 * 86400
MS_THRESHOLD = 1_000_000_000_000  # 13-digit unix ms vs 10-digit unix sec


def _format_message_time(ts: int | None) -> str:
    """Human-readable time for chunking labels."""
    if not ts:
        return ""
    try:
        value = int(ts)
        if value >= MS_THRESHOLD:
            value = value // 1000
        return datetime.utcfromtimestamp(value).strftime("%Y-%m-%d %H:%M")
    except (OSError, OverflowError, ValueError):
        return str(ts)


def _message_to_chunk_dict(msg: Message) -> Dict[str, Any]:
    from_me = bool(getattr(msg, "is_from_me", False))
    if from_me:
        sender = "[You (Saurabh)]"
    else:
        contact = (
            getattr(msg, "participant_name", None)
            or getattr(msg, "sender_name", None)
            or "Contact"
        )
        sender = f"[Contact: {contact}]"

    text_val = (getattr(msg, "text", None) or "").strip()
    media = (getattr(msg, "media_type", None) or "").strip()
    if not text_val and media:
        text_val = f"[{media}]"

    return {
        "sender": sender,
        "text": text_val,
        "time": _format_message_time(getattr(msg, "timestamp", None)),
        "from_me": from_me,
        "is_from_me": from_me,
        "sender_name": getattr(msg, "sender_name", None),
        "participant_name": getattr(msg, "participant_name", None),
    }


def resolve_display_name_from_db(tenant_id: str, jid: str, current_name: str, db: Session) -> str:
    """
    Looks up saved name from contacts table, handling LID resolution if needed.
    Phone-like values stored in contacts.name are ignored.
    """
    if not tenant_id or not jid:
        return current_name

    directory = load_contact_directory(db, tenant_id, jids=[jid])
    saved_name, notify_name = lookup_contact_labels(directory, jid, None)
    resolved = resolve_chat_label(current_name, jid, None, saved_name, notify_name)
    if resolved and resolved != current_name:
        print(f"🔄 [NAME RESOLVED] '{current_name}' -> '{resolved}'")
    return resolved or current_name


def fetch_10_day_messages_for_jid(tenant_id: str, jid: str, db: Session) -> list:
    """
    Query the local Message store for this tenant + JID over the last 10 days.
    Returns list of dicts: [{"sender": "...", "text": "...", "time": "..."}]
    """
    now_sec = int(time.time())
    cutoff_sec = now_sec - TEN_DAYS_SECONDS
    cutoff_ms = cutoff_sec * 1000

    print(f"\n🔍 [STEP 2: QUERYING SQLITE] Target JID: '{jid}' | Tenant: '{tenant_id}'")
    print(f"⏱️ Cutoff: {cutoff_sec} (sec) / {cutoff_ms} (ms)")

    # 1. Primary strict filter query
    rows = (
        db.query(Message)
        .filter(Message.tenant_jid == tenant_id)
        .filter(Message.sender_jid == jid)
        .filter(~Message.message_id.like("sync-ph:%"))
        .filter(
            or_(
                and_(Message.timestamp < MS_THRESHOLD, Message.timestamp >= cutoff_sec),
                and_(Message.timestamp >= MS_THRESHOLD, Message.timestamp >= cutoff_ms),
            )
        )
        .order_by(Message.timestamp.asc())
        .all()
    )

    print(f"📊 [STRICT QUERY RESULT] Found {len(rows)} messages matching exact 10-day timestamp & sender_jid.")

    # 2. Fallback diagnostic query: agar strict query 0 de, toh check karein table me bina timestamp filter ke kitne hain
    if not rows:
        loose_count = db.query(Message).filter(Message.tenant_jid == tenant_id, Message.sender_jid == jid).count()
        print(f"⚠️ [DIAGNOSTIC] Total messages for JID without timestamp filter: {loose_count}")
        
        # Check if JID is stored in receiver_jid or conversation_jid
        alt_check = db.execute(
            text("SELECT count(*) FROM messages WHERE sender_jid = :j OR receiver_jid = :j"), 
            {"j": jid}
        ).scalar()
        print(f"⚠️ [DIAGNOSTIC] Messages matching sender OR receiver JID: {alt_check}")

    result = [_message_to_chunk_dict(row) for row in rows if (row.text or row.media_type)]
    print(f"📦 [EXTRACTED CLEAN MESSAGES] Total {len(result)} ready for AI Chunking.")
    return result


async def audit_single_chat(tenant_id: str, job_id: int):
    """
    Processes one chat end-to-end under semaphore protection.
    """
    async with AUDIT_SEMAPHORE:
        db: Session = SessionLocal()
        try:
            job = db.query(ChatAuditJob).filter(ChatAuditJob.id == job_id).first()
            if not job or job.status != "PENDING":
                print(f"⏭️ [WORKER SKIP] Job {job_id} not found or status != PENDING (current: {job.status if job else 'None'})")
                return

            print(f"\n=======================================================")
            print(f"🚀 [STEP 1: START CHAT AUDIT] Job ID: {job_id}")
            print(f"📌 Contact: '{job.chat_name}' | JID: '{job.jid}' | IsGroup: {job.is_group}")
            print(f"=======================================================")

            # Resolve phonebook name before chunking / matter cards
            resolved_name = resolve_display_name_from_db(
                tenant_id, job.jid, job.chat_name or "", db
            )
            if resolved_name and resolved_name != job.chat_name:
                job.chat_name = resolved_name

            # 1. Fetch raw messages from Message store (10-day window)
            # Capture prior completed window size BEFORE overwriting (dedupe guard).
            prior_message_count = int(job.total_raw_messages or 0)

            job.status = "CHUNKING"
            job.updated_at = datetime.utcnow()
            db.commit()

            raw_messages = fetch_10_day_messages_for_jid(tenant_id, job.jid, db)
            current_count = len(raw_messages)

            if not raw_messages:
                print(
                    f"⚠️ [STOPPED] 0 messages for '{job.chat_name}'. "
                    "Marking COMPLETED_NO_ACTION (other chats continue)."
                )
                job.status = "COMPLETED_NO_ACTION"
                job.total_raw_messages = 0
                job.matters_generated = 0
                job.error_message = "No messages in 10-day window"
                job.updated_at = datetime.utcnow()
                db.commit()
                return

            # Guard 4: skip Layer 3 / embeddings when the 10-day window is unchanged
            # since the last successful audit for this chat.
            if prior_message_count > 0 and current_count == prior_message_count:
                print(f"[Audit Skipped] No new messages for {job.jid}")
                job.status = "COMPLETED_NO_ACTION"
                job.total_raw_messages = current_count
                job.error_message = "No new messages since last audit"
                job.updated_at = datetime.utcnow()
                db.commit()
                return

            job.total_raw_messages = current_count

            # 2–6. Prefer LLM path; fall back to heuristic cards if OpenAI/Chroma fails
            matters: list = []
            retrieved_context = ""
            used_fallback = False
            pipeline_error: str | None = None

            try:
                chunks = generate_sliding_window_chunks(raw_messages, window_size=6, overlap=2)
                print(f"✂️ [STEP 3: CHUNKING] Created {len(chunks)} sliding window chunks.")

                job.status = "EMBEDDING"
                job.updated_at = datetime.utcnow()
                db.commit()

                print(f"🧬 [STEP 4: CHROMADB] Ingesting {len(chunks)} chunks into Vector DB...")
                await ingest_chat_vectors(tenant_id, job.jid, chunks)

                print(f"📡 [STEP 5: RETRIEVAL] Running 8 Universal Cognitive Probes...")
                retrieved_context = await retrieve_universal_pattern_chunks(tenant_id, job.jid)
                print(
                    f"📄 [STEP 5 CONTEXT] Retrieved {len(retrieved_context.splitlines())} lines of dense text."
                )

                print(f"🤖 [STEP 6: OPENAI GPT-4O-MINI] Calling LLM with Guardrails...")
                matters = await extract_matters_from_context(
                    chat_name=job.chat_name,
                    is_group=bool(job.is_group),
                    retrieved_context=retrieved_context,
                )
                print(f"✨ [STEP 6 RESULT] Extracted {len(matters)} distinct Matter Cards.")
            except Exception as pipeline_err:
                pipeline_error = str(pipeline_err)
                print(f"⚠️ [PIPELINE FALLBACK] LLM/embed path failed for '{job.chat_name}': {pipeline_err}")

            if not matters:
                matters = _heuristic_matters_from_messages(job.chat_name or "Contact", raw_messages)
                used_fallback = bool(matters)
                if used_fallback:
                    print(f"🛟 [FALLBACK] Wrote {len(matters)} heuristic card(s) for '{job.chat_name}'")

            print(f"💾 [STEP 7: WRITING TO SQLITE] Writing to 'matter_cards' table...")
            saved = _persist_matter_dicts(
                db,
                tenant_id,
                job.jid,
                job.chat_name or "Contact",
                matters,
                retrieved_context or None,
            )

            job.matters_generated = saved
            if saved:
                job.status = "COMPLETED"
                job.error_message = (
                    f"Fallback cards (OpenAI unavailable): {pipeline_error}"
                    if used_fallback and pipeline_error
                    else None
                )
            else:
                job.status = "COMPLETED_NO_ACTION"
                job.error_message = pipeline_error or "No actionable matters"
            job.updated_at = datetime.utcnow()
            db.commit()
            print(f"✅ [SUCCESS] {job.chat_name} finished! Generated {saved} cards.\n")

        except Exception as e:
            db.rollback()
            print(f"💥 [CRITICAL ERROR in JOB {job_id}]: {e}")
            import traceback
            traceback.print_exc()
            try:
                failed_job = db.query(ChatAuditJob).filter(ChatAuditJob.id == job_id).first()
                if failed_job:
                    # Last-resort: still try heuristic cards so Today Desk is not empty
                    try:
                        msgs = fetch_10_day_messages_for_jid(tenant_id, failed_job.jid, db)
                        heuristic = _heuristic_matters_from_messages(
                            failed_job.chat_name or "Contact", msgs
                        )
                        if heuristic:
                            saved = _persist_matter_dicts(
                                db,
                                tenant_id,
                                failed_job.jid,
                                failed_job.chat_name or "Contact",
                                heuristic,
                                None,
                            )
                            failed_job.matters_generated = saved
                            failed_job.status = "COMPLETED"
                            failed_job.error_message = f"Fallback after crash: {e}"
                            failed_job.updated_at = datetime.utcnow()
                            db.commit()
                            print(f"🛟 [CRASH FALLBACK] Saved {saved} card(s) for job {job_id}")
                            return
                    except Exception as fb_err:
                        print(f"💥 [FALLBACK ALSO FAILED] job {job_id}: {fb_err}")

                    failed_job.status = "FAILED"
                    failed_job.error_message = str(e)
                    failed_job.updated_at = datetime.utcnow()
                    db.commit()
            except Exception as mark_err:
                print(f"💥 [FAILED to mark job {job_id} FAILED]: {mark_err}")
        finally:
            db.close()


async def audit_single_chat_safe(tenant_id: str, job_id: int):
    """Wrapper so one chat failure never cancels sibling tasks in the pool."""
    try:
        await audit_single_chat(tenant_id, job_id)
    except Exception as e:
        print(f"💥 [SAFE WRAPPER] Unhandled error for job {job_id}: {e}")


async def trigger_pending_audit_pool(tenant_id: str):
    """
    Finds all PENDING jobs for tenant and runs them through the semaphore pool.
    FastAPI BackgroundTasks awaits this after the HTTP response is sent.
    Each chat is an isolated task — failures do not abort the batch.
    """
    db: Session = SessionLocal()
    try:
        pending_jobs = (
            db.query(ChatAuditJob)
            .filter(
                ChatAuditJob.tenant_id == tenant_id,
                ChatAuditJob.status == "PENDING",
            )
            .all()
        )
        job_ids = [j.id for j in pending_jobs]
    finally:
        db.close()

    if not job_ids:
        print(f"ℹ️ [AuditWorker] No PENDING jobs found for tenant={tenant_id}")
        return

    print(f"\n⚡ [AuditWorker] Starting pool for {len(job_ids)} PENDING jobs (tenant={tenant_id})")
    # Fire each chat independently; semaphore inside audit_single_chat caps concurrency at 3
    await asyncio.gather(
        *[audit_single_chat_safe(tenant_id, job_id) for job_id in job_ids],
        return_exceptions=True,
    )