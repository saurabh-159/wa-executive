from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, Boolean
from sqlalchemy.orm import relationship
from datetime import datetime
from app.models.database import Base


class Matter(Base):
    __tablename__ = "matters"

    id = Column(Integer, primary_key=True, index=True)
    # Tenant boundary: Ye matter kis user/tenant ka hai
    tenant_jid = Column(String(100), index=True, nullable=False, default="default")
    sender_jid = Column(String(100), index=True, nullable=False)  # Counterparty WhatsApp JID
    contact_name = Column(String(100), default="Unknown Contact")
    title = Column(String(255), nullable=False)

    # Status Tabs: 'NEEDS_YOU', 'WAITING', 'LATER', 'DONE', 'DISCARDED'
    status = Column(String(30), default="NEEDS_YOU", index=True)

    # Layer 3 taxonomy: ENGINEERING | CLIENT_DELIVERY | FINANCIAL_SETTLEMENT | ...
    category = Column(String(50), nullable=True, index=True)
    summary = Column(Text, nullable=True)
    situation = Column(Text, nullable=True)
    next_step = Column(Text, nullable=True)
    is_archived = Column(Boolean, default=False, index=True)

    last_activity_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    next_steps = relationship("NextStep", back_populates="matter", cascade="all, delete-orphan")
    draft_options = relationship("DraftOption", back_populates="matter", cascade="all, delete-orphan")
    timeline_events = relationship("TimelineEvent", back_populates="matter", cascade="all, delete-orphan")


class NextStep(Base):
    __tablename__ = "next_steps"

    id = Column(Integer, primary_key=True, index=True)
    matter_id = Column(Integer, ForeignKey("matters.id"), nullable=False)
    step_text = Column(String(255), nullable=False)
    is_completed = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    matter = relationship("Matter", back_populates="next_steps")


class DraftOption(Base):
    __tablename__ = "draft_options"

    id = Column(Integer, primary_key=True, index=True)
    matter_id = Column(Integer, ForeignKey("matters.id"), nullable=False)
    action_label = Column(String(255), nullable=False)
    draft_text = Column(Text, nullable=False)
    action_type = Column(String(30), default="REPLY")
    is_used = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    matter = relationship("Matter", back_populates="draft_options")


class TimelineEvent(Base):
    __tablename__ = "timeline_events"

    id = Column(Integer, primary_key=True, index=True)
    matter_id = Column(Integer, ForeignKey("matters.id"), nullable=False)
    date_label = Column(String(100), nullable=False)
    event_description = Column(Text, nullable=False)
    source_message_id = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    matter = relationship("Matter", back_populates="timeline_events")