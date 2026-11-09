from sqlalchemy import Column, Integer, String, Boolean, BigInteger, Text, DateTime
from datetime import datetime
from app.models.database import Base


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    # Tenant boundary: Ye message kis logged-in user ke session ka hai
    tenant_jid = Column(String(100), index=True, nullable=False, default="default")
    message_id = Column(String(100), unique=True, index=True, nullable=False)
    sender_jid = Column(String(100), index=True, nullable=False)
    phone_number = Column(String(32), index=True, nullable=True)
    sender_name = Column(String(100), default="Unknown")
    participant_name = Column(String(100), nullable=True)
    mentions_user = Column(Boolean, default=False)
    is_from_me = Column(Boolean, default=False)
    is_group = Column(Boolean, default=False, index=True)
    is_monitored = Column(Boolean, default=False, index=True)
    timestamp = Column(BigInteger, nullable=False)
    text = Column(Text, default="")
    media_type = Column(String(20), nullable=True)
    media_path = Column(Text, nullable=True)
    avatar_url = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)