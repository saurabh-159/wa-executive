from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text

from app.models.database import Base


class ChatAuditJob(Base):
    """Tracks background ingestion and parsing state for each selected chat/group."""

    __tablename__ = "chat_audit_jobs"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(String, index=True, nullable=False)
    jid = Column(String, index=True, nullable=False)
    chat_name = Column(String, default="Unknown Contact")
    is_group = Column(Boolean, default=False)

    # Lifecycle: PENDING → CHUNKING → EMBEDDING → COMPLETED | COMPLETED_NO_ACTION | FAILED
    status = Column(String, default="PENDING", index=True)
    error_message = Column(Text, nullable=True)

    total_raw_messages = Column(Integer, default=0)
    matters_generated = Column(Integer, default=0)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
