from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, String, UniqueConstraint

from app.models.database import Base


class Contact(Base):
    """WhatsApp address-book / push-name cache, keyed per tenant + JID."""

    __tablename__ = "contacts"

    id = Column(Integer, primary_key=True, index=True)
    tenant_jid = Column(String, index=True, nullable=False)
    jid = Column(String, index=True, nullable=False)  # phone JID or LID
    name = Column(String, nullable=True)  # phonebook saved name
    notify_name = Column(String, nullable=True)  # PushName / WA status name
    phone_number = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("tenant_jid", "jid", name="uq_tenant_contact_jid"),
    )


class LidMapping(Base):
    """Linked-Identity (@lid) → phone JID mapping for a tenant."""

    __tablename__ = "lid_mappings"

    id = Column(Integer, primary_key=True, index=True)
    tenant_jid = Column(String, index=True, nullable=False)
    lid = Column(String, index=True, nullable=False)  # e.g. 82815660064779@lid
    phone_jid = Column(String, index=True, nullable=False)  # e.g. 9196…@s.whatsapp.net
    phone_number = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("tenant_jid", "lid", name="uq_tenant_lid"),
    )
