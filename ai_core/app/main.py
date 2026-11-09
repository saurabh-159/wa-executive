import logging
import os
from pathlib import Path

os.environ["DISABLE_SQLALCHEMY_CEXT"] = "1"

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s %(name)s: %(message)s",
)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app.models.database import Base, engine
from app.models import message as _message_model  # noqa: F401 — register tables
from app.models import task as _task_model  # noqa: F401 — register tables
from app.models import summary as _summary_model  # noqa: F401 — register tables
from app.models import chat_audit_job as _chat_audit_job_model  # noqa: F401 — register tables
from app.models import matter_card as _matter_card_model  # noqa: F401 — register tables
from app.models import contact as _contact_model  # noqa: F401 — register contacts + lid_mappings
from app.models.message import Message  # noqa: F401
from app.models.task import Task  # noqa: F401
from app.models.matter import Matter, NextStep, DraftOption, TimelineEvent  # noqa: F401
from app.models.summary import ChatSummary  # noqa: F401
from app.models.chat_audit_job import ChatAuditJob  # noqa: F401
from app.models.matter_card import MatterCard  # noqa: F401
from app.models.contact import Contact, LidMapping  # noqa: F401
from app.routers.webhook_router import router as webhook_router
from app.routers.messages_router import router as messages_router
from app.routers.tasks_router import router as tasks_router
from app.routers.assistant_router import router as assistant_router
from app.routers.auth_router import router as auth_router
from app.routers.audit_router import router as audit_router
from app.routers.matters_router import router as matters_router
from app.routers.inbox_router import router as inbox_router
from app.routers.contacts_router import router as contacts_router
from app.routers.summary_router import router as summary_router
from app.routers.setup_router import router as setup_router
from app.routers.today_router import router as today_router
from app.services.firebase_auth import FirebaseAuthMiddleware, credentials_configured

# SQLite tables create karna
Base.metadata.create_all(bind=engine)


def _ensure_sqlite_columns():
    """Add columns that create_all will not alter on existing SQLite tables."""
    desired = {
        "messages": {
            "tenant_jid": "VARCHAR(100) DEFAULT 'default'",
            "media_type": "VARCHAR(20)",
            "media_path": "TEXT",
            "avatar_url": "TEXT",
            "is_group": "BOOLEAN DEFAULT 0",
            "is_monitored": "BOOLEAN DEFAULT 0",
            "participant_name": "VARCHAR(100)",
            "mentions_user": "BOOLEAN DEFAULT 0",
            "phone_number": "VARCHAR(32)",
        },
        "matters": {
            "tenant_jid": "VARCHAR(100) DEFAULT 'default'",
            "situation": "TEXT",
            "category": "VARCHAR(50)",
            "next_step": "TEXT",
            "is_archived": "BOOLEAN DEFAULT 0",
        },
        "chat_summaries": {
            "tenant_jid": "VARCHAR(100) DEFAULT 'default'",
            "ball_in_court": "VARCHAR(32) DEFAULT ''",
        },
        "tasks": {
            "tenant_jid": "VARCHAR(100) DEFAULT 'default'",
            "category": "VARCHAR(32) DEFAULT 'THEY_OWE_ME'",
        },
    }
    with engine.begin() as conn:
        for table, columns in desired.items():
            try:
                existing = {
                    row[1] for row in conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
                }
                for col_name, col_type in columns.items():
                    if col_name not in existing:
                        conn.execute(
                            text(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_type}")
                        )
            except Exception as e:
                print(f"[DB Schema Init Warning on {table}]: {e}")

        # Backfill group flag for rows ingested before is_group existed
        try:
            msg_cols = {
                row[1] for row in conn.execute(text("PRAGMA table_info(messages)")).fetchall()
            }
            if "is_group" in msg_cols:
                conn.execute(
                    text(
                        "UPDATE messages SET is_group = 1 "
                        "WHERE sender_jid LIKE '%@g.us' AND (is_group IS NULL OR is_group = 0)"
                    )
                )
        except Exception:
            pass


_ensure_sqlite_columns()

from app.services.message_reconcile import reconcile_message_rows

try:
    with engine.begin() as _conn:
        print(f"[DB Sync] {reconcile_message_rows(_conn)}")
except Exception as e:
    print(f"[DB Sync Reconcile Error]: {e}")

app = FastAPI(title="Executive Assistant AI Core")

if credentials_configured():
    print("[Auth] Firebase admin credentials found. Google ID tokens will be verified.")
else:
    print(
        "[Auth] Firebase admin credentials missing. "
        "Paste FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY into ai_core/.env."
    )

MEDIA_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "wa_worker", "downloads")
)
if not os.path.exists(MEDIA_DIR):
    os.makedirs(MEDIA_DIR, exist_ok=True)

_frontend_origins = [
    origin.strip()
    for origin in os.getenv(
        "FRONTEND_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]

# Auth middleware is added first so CORS stays outermost and still
# labels 401 responses for the browser.
app.add_middleware(FirebaseAuthMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_frontend_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# Routes register karna
app.include_router(webhook_router)
app.include_router(messages_router)
app.include_router(tasks_router)
app.include_router(assistant_router)
app.include_router(auth_router)
app.include_router(audit_router)
# today_router first so static paths (/audit-progress, /cards) win over /{matter_id}/...
app.include_router(today_router)
app.include_router(matters_router)
app.include_router(inbox_router)
app.include_router(contacts_router)
app.include_router(summary_router)
app.include_router(setup_router)

app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")


@app.get("/")
async def health():
    return {"status": "ok", "service": "ai_core"}