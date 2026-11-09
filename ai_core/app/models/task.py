from sqlalchemy import Column, Integer, String, Text, DateTime
from datetime import datetime
from app.models.database import Base

class Task(Base):
    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True, index=True)
    task_heading = Column(String(255), nullable=False)  # e.g., "Submit Pitch Deck to Client"
    category = Column(String(50), nullable=False)       # "I_OWE_THEM" ya "THEY_OWE_ME"
    counterparty_name = Column(String(100), default="Unknown")
    sender_jid = Column(String(100), index=True, nullable=False)
    tenant_jid = Column(String(100), index=True, nullable=False, default="default")
    
    # Click karne par jo accordion details dikhengi:
    context_their_message = Column(Text, default="")    # Samne wale ne kya bola
    context_your_reply = Column(Text, default="")       # Aapne kya commit kiya
    full_thread_summary = Column(Text, default="")      # Executive summary
    
    due_date_time = Column(String(100), nullable=True)  # "Tomorrow 4:00 PM" ya ISO format
    priority = Column(String(20), default="MEDIUM")     # LOW, MEDIUM, HIGH, URGENT
    status = Column(String(20), default="PENDING")       # PENDING, COMPLETED, DISMISSED
    
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)