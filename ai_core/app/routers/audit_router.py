from fastapi import APIRouter, HTTPException, Request
from app.models.database import SessionLocal
from app.models.message import Message
from app.services.firebase_auth import verified_tenant_id
from app.services.rag_search_service import (
    generate_contact_audit_summary,
    search_relevant_context,
)

router = APIRouter(prefix="/api/v1/audit", tags=["Audit"])


@router.post("/search")
async def audit_search(request: Request):
    """
    Frontend Contact Intelligence:
    POST { "query": "Rahul payment update" }
    → { summary, chunks }
    """
    tenant_id = verified_tenant_id(request)
    body = await request.json()
    query = (body.get("query") or "").strip()
    if len(query) < 2:
        raise HTTPException(status_code=400, detail="query kam se kam 2 chars ka ho")

    # Query se pehla naam-jaisa token nikaalna (simple heuristic)
    tokens = [t for t in query.replace(",", " ").split() if t]
    person_guess = tokens[0] if tokens else ""

    with SessionLocal() as db:
        contact_match = None
        if person_guess:
            contact_match = (
                db.query(Message)
                .filter(
                    Message.tenant_jid == tenant_id,
                    Message.sender_name.ilike(f"%{person_guess}%"),
                )
                .first()
            )

        if not contact_match:
            contact_match = (
                db.query(Message)
                .filter(Message.tenant_jid == tenant_id)
                .order_by(Message.id.desc())
                .first()
            )

        if not contact_match:
            return {
                "summary": "Abhi database mein koi chat history nahi hai. Pehle WhatsApp sync chalao.",
                "chunks": [],
            }

        sender_jid = contact_match.sender_jid
        contact_name = contact_match.sender_name or "Contact"

        summary = generate_contact_audit_summary(
            contact_name=contact_name,
            sender_jid=sender_jid,
            query=query,
            tenant_jid=tenant_id,
        )

        raw_docs = search_relevant_context(
            sender_jid=sender_jid,
            query=query,
            top_k=4,
            tenant_jid=tenant_id,
        )
        chunks = [
            {
                "id": f"chunk-{idx}",
                "counterparty_name": contact_name,
                "sender_name": contact_name,
                "timestamp_label": "Retrieved",
                "text": doc,
            }
            for idx, doc in enumerate(raw_docs)
        ]

        return {
            "summary": summary,
            "chunks": chunks,
        }
