from datetime import datetime

from sqlalchemy import Boolean, BigInteger, Column, DateTime, Integer, String, Text

from app.models.database import Base


class ChatSummary(Base):
    """Cached 10-day WhatsApp chat summary with dirty-flag refresh support."""

    __tablename__ = "chat_summaries"

    id = Column(Integer, primary_key=True, index=True)
    sender_jid = Column(String(100), unique=True, index=True, nullable=False)
    tenant_jid = Column(String(100), index=True, nullable=False, default="default")
    contact_name = Column(String(100), default="Unknown")
    summary_text = Column(Text, default="")
    ball_in_court = Column(String(32), default="")
    key_points = Column(Text, default="[]")  # JSON array of strings
    last_summarized_msg_id = Column(String(100), nullable=True)
    last_summarized_timestamp = Column(BigInteger, nullable=True)
    is_stale = Column(Boolean, default=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
