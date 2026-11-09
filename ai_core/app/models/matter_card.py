from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, JSON, String, Text

from app.models.database import Base


class MatterCard(Base):
    """
    Independent matter/topic card extracted from conversations.
    Supports multiple distinct matters from a single chat/group thread.
    """

    __tablename__ = "matter_cards"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(String, index=True, nullable=False)
    jid = Column(String, index=True, nullable=False)
    matter_id = Column(String, unique=True, index=True, nullable=False)

    # UI Metadata for Today Desk
    headline = Column(String, nullable=False)
    summary = Column(Text, nullable=False)
    source_label = Column(String, nullable=False)
    status_filter = Column(String, default="Needs you", index=True)
    priority_dot = Column(String, default="red")
    timestamp_display = Column(String, nullable=False)

    # Structured Payloads for Detailed Drawer & Quick Actions
    action_checklist = Column(JSON, default=list)
    suggested_quick_replies = Column(JSON, default=list)
    resolved_notes = Column(JSON, default=list)
    raw_context_excerpt = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
