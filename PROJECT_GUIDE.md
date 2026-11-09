# WhatsApp Executive Assistant — Current Code Guide

> **Is file ka purpose:** Jo code **abhi disk par hai** uska folder map, file role, data flow, aur API contract.  
> Gemini / kisi AI ko yeh MD dekar aage kaam karwao. Purani guide (3-day history, 7-day contacts, sirf legacy Matter desk, no audit pipeline) **outdated** hai.  
> Snapshot: **9 Nov 2026** (10-day WA sync + MatterCard audit pipeline + Google/phonebook contacts + `/today` desk).

**Product name in the UI:** Perisclaw Executive AI.  
**Repo folder:** `wa-executive-assistant`.  
**Teen local services:** `wa_worker` (Node), `ai_core` (FastAPI), `frontend` (Next.js).  
**Optional sibling CLI:** `media_batch_pipeline/` — offline media/chat batch tool (product desk ka part nahi).  
**Gate:** Google sign-in (Firebase Auth). Bina login ke desk / inbox open nahi hota.

**Live product screens:** `/login` → Google → WhatsApp QR / realtime sync → **Settings** (10-day contacts pick + Google/phonebook names) → **Today** (`/today` MatterCards) + **Inbox** (raw chats + GPT summary). Legacy 3-column desk abhi bhi `/` par hai.

---

## Table of Contents

1. [Phase 0 — Project kya hai?](#phase-0--project-kya-hai)
2. [Phase 1 — Architecture aur current wiring](#phase-1--architecture-aur-current-wiring)
3. [Phase 2 — Folder structure](#phase-2--folder-structure)
4. [Phase 3 — Setup & run](#phase-3--setup--run)
5. [Phase 4 — Firebase Auth + Middleware](#phase-4--firebase-auth--middleware)
6. [Phase 5 — Live worker: `wa_worker/index.js`](#phase-5--live-worker-wa_workerindexjs)
7. [Phase 6 — Draft worker: `wa_worker/src`](#phase-6--draft-worker-wa_workersrc)
8. [Phase 7 — `ai_core` entry, config, database](#phase-7--ai_core-entry-config-database)
9. [Phase 8 — Models](#phase-8--models)
10. [Phase 9 — Services](#phase-9--services)
11. [Phase 10 — Routers aur controllers](#phase-10--routers-aur-controllers)
12. [Phase 11 — Frontend](#phase-11--frontend)
13. [Phase 12 — Message journeys](#phase-12--message-journeys)
14. [Phase 13 — Glossary](#phase-13--glossary)
15. [Phase 14 — API cheat sheet](#phase-14--api-cheat-sheet)
16. [Phase 15 — Gemini context prompt](#phase-15--gemini-context-prompt)
17. [Phase 16 — Optional: media_batch_pipeline](#phase-16--optional-media_batch_pipeline)

---

## Phase 0 — Project kya hai?

Business WhatsApp par promises, deadlines, payments, aur “kal bhej dunga” type commitments ek desk par aani chahiye — **multi-user ready**, har Google account ka data alag (`tenant_jid` / `tenant_id` = Firebase UID).

**User journey (current):**

1. `/login` → **Continue with Google** (Firebase popup).
2. Frontend Firebase ID token har API call par `Authorization: Bearer …` bhejta hai.
3. FastAPI `FirebaseAuthMiddleware` token verify karta hai → `uid` ko tenant lock karta hai.
4. AuthGuard: WhatsApp QR → realtime history sync overlay → **Settings setup** (`?setup=true`).
5. Settings: last **10 days** active DMs/groups select → optional Google Contacts / phonebook (vCard/CSV) name resolve → `set-monitored` + **audit jobs** queue.
6. Background audit pool (max 3 parallel): chunk → embed (Chroma) → extract **MatterCards** → Today desk fill.
7. **Today** (`/today`): Needs you / Waiting / Done tabs + checklist + quick replies + thread drawer.
8. **Inbox**: raw threads + optional **3-day chat summary** widget.
9. Logout: WhatsApp unpair + full tenant wipe (SQLite + vectors) + Firebase `signOut` + browser storage clear.

**UI brand:** light desk, orange → amber, Inter + Newsreader fonts, theme `#F1F3F5`. Title: **Perisclaw Executive AI**.

---

## Phase 1 — Architecture aur current wiring

```
Browser :3000  Next.js
   │  1) Firebase Google login (client SDK)
   │  2) axios → :8000/api/v1/...
   │     Header: Authorization: Bearer <Firebase ID token>
   │     Header: X-Tenant-JID <uid>   (server overwrite karta hai)
   ▼
ai_core :8000  FastAPI
   │  FirebaseAuthMiddleware
   │  SQLite assistant.db (tenant scoped rows)
   │  Chroma chroma_db_store (+ pattern collections)
   │  /media → wa_worker/downloads
   ▲                          │
   │  webhook + X-Worker-Secret│  send / QR / logout / fetch-history
   │                          ▼
wa_worker :5001  Baileys (tenant sessions)
   ▼
WhatsApp
```

| Piece | File | Port | Load hoti hai? |
|-------|------|------|----------------|
| Live WhatsApp worker | `wa_worker/index.js` | **5001** | Haan — `npm start` (pehle `patch-baileys.js`) |
| Draft Express worker | `wa_worker/src/server.js` | **5000** | Nahi — alag se chalana |
| FastAPI | `ai_core/app/main.py` | **8000** | Haan — `uvicorn app.main:app` |
| Desk UI | `frontend/` | **3000** | Haan — `npm run dev` |
| Media batch CLI | `media_batch_pipeline/` | — | Optional offline tool |

### Kaun kis port / secret ko bolta hai

| Caller | Path | Target / auth |
|--------|------|----------------|
| Browser | sab `/api/v1/*` except webhook | Firebase **Bearer** token |
| `index.js` | `POST /api/v1/webhook/*` | Header **`X-Worker-Secret`** = `WORKER_INTERNAL_SECRET` (local only) |
| `assistant_router` / `auth_router` | QR, sync, logout, send | `LIVE_WORKER_URL` default `:5001` + `tenant_id` query |
| Matter / Inbox send | `:5001/send-message` | Python → live worker |
| On-demand history | `:5001/fetch-history` | `history_backfill.py` → worker |
| Self-chat Python reply/reaction | `:5000/api/send` + `/api/reaction` | `NODE_WORKER_URL` (draft; optional) |

**Practical:** Sirf `npm start` (worker :5001) + uvicorn + Next kaafi hai Today / Inbox / QR ke liye. Draft `:5000` sirf self-chat Python-side reaction path ke liye.

---

## Phase 2 — Folder structure

`node_modules`, `venv`, `.next`, `auth_sessions`, `downloads`, `__pycache__` ignore. Source tree:

```
wa-executive-assistant/
├── README.md                     # short setup (thoda outdated vs is guide)
├── PROJECT_GUIDE.md              # yeh file
│
├── wa_worker/
│   ├── package.json              # start → patch-baileys.js && node index.js
│   ├── index.js                  # LIVE multi-tenant Baileys + HTTP :5001
│   ├── patch-baileys.js          # 10-day history + groups + onDemandReady
│   └── src/                      # DRAFT Express :5000 (optional)
│       ├── server.js
│       ├── wa_client.js
│       └── handlers/message_handler.js
│
├── ai_core/
│   ├── requirements.txt          # firebase-admin, openai, chromadb, faster-whisper, …
│   ├── .env                      # OPENAI + FIREBASE admin + WORKER_INTERNAL_SECRET
│   ├── .env.example
│   ├── assistant.db
│   ├── chroma_db_store/
│   ├── diagnose_contacts.py      # ad-hoc contact debug (not part of uvicorn boot)
│   ├── _audit_sync.py / _audit_sync2.py / _tmp_inbox_diag.py   # scratch / one-off diags
│   ├── scripts/
│   │   ├── verify_multimodal_ingest.py
│   │   └── fixtures_receipt.jpg
│   ├── tests/
│   │   ├── test_layer3_matters.py
│   │   ├── test_message_formatter.py
│   │   └── test_pipeline_e2e.py
│   └── app/
│       ├── main.py               # middleware + routers + /media mount
│       ├── config/
│       │   ├── __init__.py       # Settings (OPENAI / DB)
│       │   └── rules_knowledge_base.py   # GPT prompts / rules + INBOX_SUMMARY_PROMPT
│       ├── knowledge_base/
│       │   └── chat_guardrails.py        # universal behavioral patterns + MATTER_SYSTEM_PROMPT
│       ├── models/
│       │   ├── database.py
│       │   ├── message.py        # tenant_jid, is_group, is_monitored, avatar, …
│       │   ├── task.py           # tenant_jid
│       │   ├── matter.py         # legacy CRM Matter + steps/drafts/timeline
│       │   ├── matter_card.py    # Today desk cards (audit pipeline)
│       │   ├── chat_audit_job.py # per-chat audit lifecycle
│       │   ├── contact.py        # contacts + lid_mappings
│       │   └── summary.py        # chat_summaries
│       ├── schemas/
│       │   ├── matter.py
│       │   └── matter_schema.py  # extraction / split result shapes
│       ├── routers/
│       │   ├── webhook_router.py
│       │   ├── messages_router.py        # POST /messages/ingest (multimodal)
│       │   ├── tasks_router.py
│       │   ├── assistant_router.py       # QR / sync / logout / send
│       │   ├── setup_router.py           # initialize-audit-jobs, bootstrap
│       │   ├── auth_router.py
│       │   ├── audit_router.py           # RAG contact search
│       │   ├── today_router.py           # cards, audit-progress, status, action
│       │   ├── matters_router.py         # legacy Matter CRM APIs
│       │   ├── inbox_router.py
│       │   ├── contacts_router.py        # recent-active, Google, phonebook, monitored
│       │   └── summary_router.py
│       ├── controllers/
│       │   ├── webhook_controller.py
│       │   ├── tasks_controller.py
│       │   ├── matters_controller.py
│       │   └── inbox_controller.py
│       └── services/
│           ├── firebase_auth.py
│           ├── wa_session_state.py
│           ├── jid_identity.py
│           ├── message_reconcile.py
│           ├── chat_isolation.py
│           ├── contact_names.py
│           ├── google_contacts.py
│           ├── phonebook_import.py
│           ├── history_backfill.py
│           ├── tenant_wipe.py
│           ├── audit_job_queue.py
│           ├── audit_worker.py           # pool + MatterCard persist
│           ├── pattern_ingestion.py      # sliding windows → Chroma
│           ├── matter_extractor.py       # Layer 3 GPT extraction
│           ├── message_formatter.py
│           ├── media_processor.py
│           ├── guardrails_engine.py
│           ├── summary_service.py
│           ├── commitment_service.py
│           ├── multimodal_service.py
│           ├── personal_bot_service.py
│           ├── rag_search_service.py
│           ├── matter_ai_service.py      # legacy synthesize path
│           └── matter_db_service.py
│
├── frontend/
│   ├── .env.local / .env.example # NEXT_PUBLIC_API_URL + Firebase WEB keys
│   ├── package.json / jsconfig.json / next.config.js / postcss.config.mjs / tailwind.config.js
│   ├── AGENTS.md                 # Next.js auto agent-rules stub (dev regenerates)
│   ├── lib/
│   │   ├── firebase.js
│   │   ├── api.js                # axios + Bearer + all API helpers
│   │   ├── sessionCleanup.js
│   │   ├── syncSession.js
│   │   ├── matters.js
│   │   ├── utils.js
│   │   └── mockData.js
│   ├── components/
│   │   ├── layout/
│   │   │   ├── AuthGuard.jsx     # login + QR/sync + contacts setup gate
│   │   │   ├── AppShell.jsx
│   │   │   ├── AppSidebar.jsx    # nav: Today / Inbox / Settings
│   │   │   ├── MobileNav.jsx
│   │   │   ├── Navbar.jsx
│   │   │   ├── TabNavigation.jsx
│   │   │   └── TabRedirect.jsx   # /you-owe /waiting-on /history redirects
│   │   ├── setup/RealtimeSyncStreamCard.jsx
│   │   ├── inbox/ChatSummaryWidget.jsx
│   │   ├── sync/SyncLoadingOverlay.jsx
│   │   ├── audit/
│   │   │   ├── AuditTimeline.jsx
│   │   │   └── ContactAuditSearch.jsx
│   │   ├── dashboard/            # mainly legacy `/` desk
│   │   │   ├── LeftFeed.jsx / CenterDesk.jsx / RightChatStream.jsx
│   │   │   ├── DeskStates.jsx
│   │   │   ├── StatCard.jsx / TaskCard.jsx / TaskList.jsx / TaskDetailModal.jsx
│   │   ├── ui/                   # Badge, PriorityIndicator, SkeletonLoader, ToastProvider
│   │   └── legacy root leftovers (still on disk; mostly unused by live nav):
│   │       EmptyState.js, Header.js, MetricCards.js, PriorityBadge.js,
│   │       QRScannerModal.jsx, Sidebar.js, SyncBanner.jsx, TaskCard.jsx, TaskSkeleton.jsx
│   ├── app/
│   │   ├── globals.css
│   │   ├── layout.jsx            # AuthGuard wraps AppShell
│   │   ├── login/page.jsx
│   │   ├── today/page.jsx        # PRIMARY Today desk (MatterCards)
│   │   ├── page.jsx              # legacy 3-column desk (still mounted)
│   │   ├── inbox/page.jsx
│   │   ├── settings/page.jsx     # QR + 10-day monitor picker + contacts import
│   │   ├── you-owe/page.js       # → TabRedirect
│   │   ├── waiting-on/page.js
│   │   └── history/page.js
│   └── hooks/
│       ├── useAudit.js
│       └── useTasks.js           # legacy; live Today uses api.js directly
│
├── wa_worker/ also keeps runtime data (ignore in git usually):
│   auth_sessions/, downloads/, contacts_store.json, avatars_store.json
│
└── media_batch_pipeline/         # optional offline CLI (see Phase 16)
    ├── run.py / requirements.txt / README.md / .env.example
    └── media_pipeline/
        ├── __main__.py / cli.py / config.py / pipeline.py
        ├── scanner.py / state.py / media_handler.py
        ├── ai_client.py / display.py / logging_setup.py
```

**Coverage check (9 Nov 2026):** `ai_core/app` ke saare routers / models / services / controllers / schemas / knowledge_base guide mein hain. Miss nahi: sirf pehle abbreviated legacy UI + `scripts/` + `tests/` + root scratch `_*` diags — ab upar listed.

**Next.js `middleware.js` file nahi hai.** Auth gate React mein hai (`AuthGuard`). Server-side API auth FastAPI middleware mein hai.

---

## Phase 3 — Setup & run

Teen terminals: worker + ai_core + frontend.

### 3.1 AI Core

```bash
cd ai_core
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

`ai_core/.env` (private — commit mat karo):

```
OPENAI_API_KEY=sk-...
LIVE_WORKER_URL=http://127.0.0.1:5001
NODE_WORKER_URL=http://127.0.0.1:5000

# Firebase Admin (service account) — token verify ke liye
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-...@....iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_ALLOWED_EMAILS=          # empty = koi bhi verified Google; warna comma list

FRONTEND_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
WORKER_INTERNAL_SECRET=long-random-shared-secret
```

`requirements.txt` highlights: **`firebase-admin`**, **`openai`**, **`chromadb`**, **`faster-whisper`**, **`httpx`**.

Boot kya karta hai (`main.py`):

1. Model import → `create_all` + `_ensure_sqlite_columns` (tenant / group / monitored / matter extras).
2. `reconcile_message_rows` (phone backfill, sync placeholders clean).
3. `FirebaseAuthMiddleware` + CORS (sirf `FRONTEND_ORIGINS`).
4. Routers (order matter karti hai — `today_router` **pehle** `matters_router` se taaki `/cards` / `/audit-progress` static paths jeetein).
5. `/media` static → `wa_worker/downloads`.

### 3.2 WhatsApp worker (live)

```bash
cd wa_worker
npm install
npm start
```

`npm start` = `node patch-baileys.js && node index.js`. Port **5001**. Auth folders tenant-aware. Worker FastAPI ko `X-Worker-Secret` bhejta hai.

`patch-baileys.js`: Baileys `validate-connection.js` mein:

- `recentSyncDaysLimit: 10`
- `supportGroupHistory: true`
- `onDemandReady: true`

Taaki QR ke baad groups + ~10 din history + on-demand backfill milen.

### 3.3 Frontend

```bash
cd frontend
npm install
npm run dev
```

`frontend/.env.local` (**public web keys only** — service-account private key yahan mat daalo):

```
NEXT_PUBLIC_API_URL=http://127.0.0.1:8000
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=....firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
```

Browser: **http://localhost:3000/login**

Firebase Console checklist:

1. Authentication → Sign-in method → **Google** enable.
2. Authorized domains mein `localhost`.
3. Project settings → Web app → config values `.env.local` mein.
4. Service account JSON se admin fields `ai_core/.env` mein.
5. (Optional) Google Contacts People API — Settings “Sync Google” ke liye OAuth access token client se aata hai.

---

## Phase 4 — Firebase Auth + Middleware

### 4.1 Do alag “doors”

| Door | Kaun | Kaise prove |
|------|------|-------------|
| Browser APIs | Logged-in Google user | `Authorization: Bearer <Firebase ID token>` |
| WhatsApp webhooks | Local `wa_worker` | `X-Worker-Secret` + request **localhost** se |

Browser kabhi seedha `:5001` mat call kare — hamesha Python proxy (`/assistant/*`, `/auth/status`).

### 4.2 Frontend — `lib/firebase.js`

- `initializeApp` + `getAuth` + `GoogleAuthProvider` (email + profile scopes).
- `isFirebaseConfigured()` — keys missing → login page error.
- Private key yahan **nahi** aati.

### 4.3 Frontend — `lib/api.js`

- `apiClient` axios base `/api/v1`.
- Request interceptor: `currentUser.getIdToken()` → `Authorization: Bearer …`.
- Fallback header `X-Tenant-JID` + query `tenant_jid` (server inhe trust nahi karta — middleware overwrite).
- Tenant helpers: `getActiveTenantId`, `setActiveTenantId`, `clearActiveTenantId` (`perisclaw_tenant_jid`).
- Contacts gate flag: `getContactsConfiguredFlag` / `setContactsConfiguredFlag`.
- Google token helpers: `storeGoogleAccessToken` / `getGoogleAccessToken` / `syncGoogleContacts`.

### 4.4 Frontend — `AuthGuard.jsx` + `/login`

1. `onAuthStateChanged` → logged out? → `/login`.
2. Logged in → UID tenant set → WhatsApp status poll (`/auth/status`, QR, sync).
3. States: `loading` | `qr_ready` | `syncing` | `ready` | `disconnected`.
4. Sync UI: `RealtimeSyncStreamCard` + interpolated message/chat counts.
5. Contacts not configured → force `/settings?setup=true` (sidebar bhi lock).

Login page: Google popup; non-Google / unverified email reject + `signOut`.

### 4.5 Backend — `services/firebase_auth.py`

| Function / class | Role |
|------------------|------|
| `credentials_configured()` | Admin env present? |
| `get_firebase_app()` | Admin SDK once |
| `verify_google_id_token(token)` | Google provider + email_verified + optional allow-list |
| `verified_tenant_id(request)` | Middleware-stamped UID |
| **`FirebaseAuthMiddleware`** | ASGI gate on `/api/v1/*` |

Middleware rules:

- `OPTIONS` aur non-`/api/v1` → pass.
- `/api/v1/webhook*` → **sirf** local + matching `X-Worker-Secret`, warna **403**.
- Baaki `/api/v1/*` → Bearer token verify; fail → **401/403/503**.
- Success → `request.state.firebase_uid`, header `x-tenant-jid` = uid, query `tenant_id`/`tenant_jid` force uid.

### 4.6 `routers/auth_router.py`

`GET /api/v1/auth/status` → worker `/auth-status` (fallback `/health` ya `/qr`) → normalize:

`connected` / `ready` | `syncing` | `qr_ready` | `disconnected`

Extra fields frontend use karti hai: `isHistorySyncComplete`, `selection_ready`, `sync_phase`, `phonebook_settled`, `qr_image`, message/chat progress.

In-memory mirror: `wa_session_state.py` (`set_wa_status` / `get_wa_status` / `clear_wa_session`).

---

## Phase 5 — Live worker: `wa_worker/index.js`

Ek process, **tenant sessions** (query/body `tenant_id` — empty/`default` reject). Port **5001**. `npm start` yahi.

### 5.1 Important behaviour

- Har FastAPI call par `X-Worker-Secret`.
- History / selection flags: `isHistorySyncComplete`, `selection_ready`, `sync_phase` (`messages` → `media` → `contacts` → `names` → `ready`).
- Groups (`@g.us`) sync (`patch-baileys.js` + monitored selection).
- Echo guard `recentlySentBotIds`.
- On-demand history: `POST /fetch-history`.
- HTTP (mostly `?tenant_id=`):

| Method | Path | Role |
|--------|------|------|
| GET | `/qr` | QR image / pairing |
| GET | `/sync-status` | Progress counters |
| GET | `/health` | Liveness |
| GET | `/auth-status` | Unified lifecycle |
| POST | `/logout` | Unpair + wipe trigger |
| POST | `/fetch-history` | On-demand backfill for JIDs |
| POST | `/send-message` | `{ recipient_jid, text, tenant_id? }` |

### 5.2 Forward → FastAPI webhooks

| Kind | URL |
|------|-----|
| Live | `POST :8000/api/v1/webhook/incoming` |
| Batch | `POST …/incoming-batch` |
| Chats snapshot | `…/sync-chats` |
| Contacts | `…/sync-contacts` |
| Name settle | `…/settle-contact-names` |
| LID map | `…/sync-lid-mappings`, `…/remap-lids` |
| Avatars | `…/sync-avatars` |
| Auth mirror | `…/auth-status` |
| Tenant link | `…/link-tenant` |
| Wipe | `…/wipe-tenant-data` |

`bot_reply` response → WhatsApp send (history pe nahi).

---

## Phase 6 — Draft worker: `wa_worker/src`

Optional. `package.json` start nahi karta. Port **5000**, auth folder `auth_info_baileys`.

| File | Role |
|------|------|
| `server.js` | HTML QR, `POST /api/send`, `POST /api/reaction` |
| `wa_client.js` | Baileys connect |
| `message_handler.js` | notify → FastAPI `/webhook/incoming` |

Self-chat Python path abhi bhi yahan reaction/send try karta hai; live `index.js` `bot_reply` se bhi deliver kar sakta hai.

---

## Phase 7 — `ai_core` entry, config, database

### 7.1 `app/config/__init__.py`

`Settings`: `APP_NAME`, `DEBUG`, `DATABASE_URL`, `OPENAI_API_KEY`. Firebase / worker secrets **Settings class mein nahi** — seedha `os.getenv`.

### 7.2 Prompt / rules homes

| File | Role |
|------|------|
| `config/rules_knowledge_base.py` | ~30 cognitive rules + `INBOX_SUMMARY_PROMPT` |
| `knowledge_base/chat_guardrails.py` | Universal behavioral patterns + `MATTER_SYSTEM_PROMPT` |
| `services/matter_extractor.py` | Executive extraction system prompt (speaker attribution, noise gate, multimodal cancel) |

### 7.3 `app/main.py` (order matter karti hai)

1. Models import (Message, Task, Matter…, ChatSummary, **ChatAuditJob**, **MatterCard**, **Contact**, **LidMapping**).
2. `create_all` + column ensure + reconcile.
3. `FirebaseAuthMiddleware` **pehle**, phir `CORSMiddleware`.
4. Routers: webhook, messages, tasks, assistant, auth, audit, **today**, matters, inbox, contacts, summary, **setup**.
5. `app.mount("/media", … downloads)`.
6. `GET /` health.

### 7.4 `database.py`

SQLite `sqlite:///./assistant.db`, `SessionLocal`, `get_db()`.

---

## Phase 8 — Models

### `messages`

| Column | Meaning |
|--------|---------|
| `tenant_jid` | Firebase UID — **isolation key** |
| `message_id` | Unique WA id (`sync-ph:…` placeholders temporary) |
| `sender_jid` | Chat id (phone `@s.whatsapp.net` / `@lid` / `@g.us`) |
| `phone_number` | Digits jab resolve ho |
| `sender_name` / `participant_name` | Display / group sender |
| `mentions_user` | Group @mention flag |
| `is_from_me` | Outgoing |
| `is_group` | Group chat |
| `is_monitored` | Settings se select — audit + AI focus |
| `timestamp` | Unix seconds **ya** ms (queries magnitude se discriminate) |
| `text` / `media_type` / `media_path` / `avatar_url` | Content + avatar |

### `contacts` + `lid_mappings`

Phonebook / push-name cache per tenant+JID. LID → phone JID map for inbox heal.

### `tasks`

Purane columns + `tenant_jid`. Categories `I_OWE_THEM` / `THEY_OWE_ME`. Desk UI ab primarily MatterCards dikhati hai; tasks API alive hai.

### `matters` (+ children) — **legacy CRM**

+ `tenant_jid`, `situation`, `category`, `next_step`, `is_archived`.  
Statuses: `NEEDS_YOU`, `WAITING`, `LATER`, `DONE`, `DISCARDED`.  
Children: `next_steps`, `draft_options`, `timeline_events`.  
Used by `/` legacy desk + `matters_router` + some live webhook synthesis.

### `matter_cards` — **Today desk (primary)**

| Column | Meaning |
|--------|---------|
| `tenant_id` + `jid` | Scope |
| `matter_id` | Unique string id |
| `headline` / `summary` / `source_label` | Card copy |
| `status_filter` | UI tab: `Needs you`, `Waiting`, `Later`, `Done`, `Sessions` |
| `priority_dot` | `red` / `orange` / `blue` / … |
| `timestamp_display` | Human time label |
| `action_checklist` | JSON checklist |
| `suggested_quick_replies` | JSON drafts |
| `resolved_notes` | JSON notes / timeline bits |
| `raw_context_excerpt` | Optional excerpt |

### `chat_audit_jobs`

Per monitored chat lifecycle:

`PENDING` → `CHUNKING` → `EMBEDDING` → `COMPLETED` | `COMPLETED_NO_ACTION` | `FAILED`

Tracks `total_raw_messages`, `matters_generated`, `error_message`.

### `chat_summaries`

3-day GPT brief cache: `summary_text`, `ball_in_court`, `key_points`, watermarks, `is_stale`.

---

## Phase 9 — Services

### Auth / session / identity / wipe

| File | Beginner one-liner |
|------|--------------------|
| `firebase_auth.py` | Token verify + middleware + `verified_tenant_id` |
| `wa_session_state.py` | Connected/QR/sync memory for `/auth/status` |
| `jid_identity.py` | Phone vs LID vs group; labels; placeholders |
| `message_reconcile.py` | Boot repair |
| `chat_isolation.py` | Broadcast / group noise vs personal demand |
| `contact_names.py` | Directory load + best label lookup |
| `google_contacts.py` | People API phonebook → rename contacts |
| `phonebook_import.py` | vCard / CSV import + match to chats |
| `history_backfill.py` | Call worker `/fetch-history`, wait for rows |
| `tenant_wipe.py` | Full tenant SQLite + vector wipe |

### Audit → MatterCard pipeline (Today)

| File | Role |
|------|------|
| `audit_job_queue.py` | Upsert PENDING jobs; bootstrap from `is_monitored` |
| `audit_worker.py` | Semaphore(3) pool; 10-day msgs → chunks → embed → extract → persist cards; heuristic fallback if OpenAI down |
| `pattern_ingestion.py` | Sliding-window chunks → Chroma; retrieve pattern context |
| `matter_extractor.py` | GPT structured extraction + legacy Matter upsert helpers |
| `message_formatter.py` | Speaker prefixes, redaction, answered-turn detection |
| `media_processor.py` | Whisper / vision enrichment for ingest |
| `guardrails_engine.py` | Sanitize / validate extracted cards |

### AI / data (legacy + shared)

| File | Role |
|------|------|
| `commitment_service.py` | GPT task extract |
| `multimodal_service.py` | Whisper + image (file-based) |
| `personal_bot_service.py` | Self-chat intents |
| `rag_search_service.py` | Chroma contact audit search |
| `matter_ai_service.py` | Legacy matter synthesize |
| `matter_db_service.py` | Upsert legacy matter + replace steps/drafts |
| `summary_service.py` | 3-day window GPT summary, delta refresh |

---

## Phase 10 — Routers aur controllers

Sab `main.py` mein mounted. Prefix = final path.

### 10.1 Webhook `/api/v1/webhook` — worker only (secret)

| Method | Path | Behaviour |
|--------|------|-----------|
| POST | `/incoming` | Live/history message pipeline |
| POST | `/messages-ingest` | Alias → same as incoming |
| POST | `/incoming-batch` | History chunks |
| POST | `/sync-history` | RAG index background |
| POST | `/sync-chats` | Initial chat list (~10-day) |
| POST | `/sync-contacts` | Upsert `contacts` + rename weak labels |
| POST | `/settle-contact-names` | Phonebook settle pass |
| POST | `/sync-lid-mappings` | Persist LID→phone |
| POST | `/remap-lids` | Rewrite inbox rows off `@lid` |
| POST | `/sync-avatars` | Avatar URLs |
| POST | `/link-tenant` | Firebase UID ↔ phone JID; orphan relink |
| POST | `/auth-status` | Worker → Python session mirror |
| POST | `/wipe-tenant-data` | Logout tenant wipe |

Live path (short): save Message (tenant scoped) → history early return → self-chat bot → else task / legacy matter paths as applicable.

### 10.2 Messages `/api/v1/messages`

| POST `/ingest` | Multimodal enrich (`media_processor`) then shared `process_message_payload` |

### 10.3 Auth `/api/v1/auth`

| GET `/status` | Worker auth/health/QR → `{ status, connected, isHistorySyncComplete, selection_ready, sync_phase, … }` |

### 10.4 Assistant `/api/v1/assistant`

Proxy to `:5001` with tenant: `qr-status`, `sync-status`, `logout`, `send`, `draft-followup`.

**Setup routes (same prefix, `setup_router.py`):**

| Method | Path | Behaviour |
|--------|------|-----------|
| POST | `/initialize-audit-jobs` | Body `{ contacts: [{jid,name,isGroup}] }` → PENDING jobs + start pool |
| POST | `/bootstrap-audit-from-monitored` | Recovery: invent jobs from `is_monitored` messages |

### 10.5 Contacts `/api/v1/contacts`

| Method | Path | Behaviour |
|--------|------|-----------|
| GET | `/recent-active` | Last **10 days** DMs + groups (counts, avatar, monitored). Fallback top contacts if window empty. Orphan relink heal. |
| POST | `/sync-google` | Google People API token → apply names |
| POST | `/import-phonebook` | Upload vCard/CSV |
| POST | `/set-monitored` | `{ selected_jids }` → flags + queue audit jobs + optional history backfill + background process |

### 10.6 Today / MatterCards (also under `/api/v1/matters`)

`today_router.py` — mount **before** `matters_router`:

| Method | Path | Behaviour |
|--------|------|-----------|
| GET | `/audit-progress` | Job counts / status for progressive UI |
| GET | `/cards` | MatterCard list (fallback legacy Matter if cards empty) |
| PATCH | `/{matter_id}/status` | Move card tab |
| POST | `/{matter_id}/action` | Checklist toggle and/or status |

### 10.7 Matters `/api/v1/matters` — legacy CRM

| Method | Path | Behaviour |
|--------|------|-----------|
| GET | `` | List legacy matters |
| POST | `/sync-recent` | Manual recent sync / synthesis |
| POST | `/process-selected` | Selected JIDs background process |
| POST | `/trigger-background-sync` | Background actionable matters |
| GET | `/{id}/details` | Detail payload |
| GET | `/{id}/raw-chat` | Raw messages |
| POST | `/{id}/send-draft` | Send via worker |
| PATCH | `/steps/{step_id}/toggle` | Step complete |

### 10.8 Inbox `/api/v1/inbox`

| Method | Path | Behaviour |
|--------|------|-----------|
| GET | `/chats` | Tenant-scoped chat list |
| GET | `/chats/{jid}/messages` | Thread |
| POST | `/chats/{jid}/send` | Send via :5001 + outgoing Message |
| POST | `/chats/{jid}/transcribe` | Voice notes Whisper batch |

### 10.9 Summary `/api/v1/summary`

| Method | Path | Behaviour |
|--------|------|-----------|
| GET | `/{jid}` | Cached summary ya `not_generated`; dirty + `new_messages_count` |
| POST | `/{jid}/generate` | GPT generate / delta refresh |

### 10.10 Tasks / Audit

Tasks API pehle jaisi (tenant aware). Audit `POST /audit/search` — Chroma + GPT; index `sync-history` / pattern ingestion se.

---

## Phase 11 — Frontend

### 11.1 Stack

Next.js App Router (v16), React 19, Tailwind 4, axios, framer-motion, lucide-react, **firebase** auth client.  
Shell: `AuthGuard` → `AppShell` → page.

### 11.2 Routes

| Path | Screen |
|------|--------|
| `/login` | Google sign-in |
| `/today` | **Primary** Today desk (MatterCards + audit progress) |
| `/` | Legacy 3-column desk (`fetchMatters` / CRM Matter) |
| `/inbox` | Raw chats + summary widget |
| `/settings` | Sync barrier + **10-day** monitor picker + Google/phonebook + logout |
| `/you-owe` `/waiting-on` `/history` | Query redirects |

Sidebar nav: **Today** (`/today`), **Inbox**, **Settings**. Setup gate / sync barrier Today+Inbox lock kar sakta hai.

### 11.3 Key lib exports (`api.js`)

Auth/session: `fetchAuthStatus`, `fetchQrStatus`, `fetchSyncStatus`, `logoutWhatsApp` / `signOutApp`, tenant + contacts-configured helpers.  
Contacts: `fetchRecentActiveContacts`, `setMonitoredContacts`, `syncGoogleContacts`, `importPhonebook`.  
Setup/Today: `initializeAuditJobs`, `bootstrapAuditFromMonitored`, `fetchMatterCards`, `fetchAuditProgress`, `updateMatterCardStatus`, `matterCardAction`.  
Legacy matters: `fetchMatters`, `syncRecentMatters`, `fetchMatterDetails`, `fetchMatterChat`, `sendMatterDraft`, `toggleMatterStep`, `processSelectedMatters`.  
Inbox: `fetchInboxChats`, `fetchInboxMessages`, `sendInboxMessage`, `transcribeInboxAudio`.  
Summary: `fetchChatSummary`, `generateChatSummary`.

### 11.4 Components worth knowing

| File | Role |
|------|------|
| `AuthGuard.jsx` | Login + WA connect/sync + contacts setup redirect |
| `RealtimeSyncStreamCard.jsx` | Live sync stream UI during handshake |
| `SyncLoadingOverlay.jsx` | Full-screen sync spinner (timeout safety) |
| `ChatSummaryWidget.jsx` | Inbox 3-day brief UI |
| `today/page.jsx` | MatterCard feed, tabs, drawer, quick replies |
| `LeftFeed` / `CenterDesk` / `RightChatStream` | Legacy `/` columns |
| `AppSidebar` | Nav + profile logout; setup/sync locks |
| `sessionCleanup.js` | `clearBrowserStorage`, `completeLogoutRedirect`, `completeAppSignOutRedirect` |
| `syncSession.js` | “background analysis” freshness flag |

### 11.5 Settings monitor gate (mental model)

```
QR linked + sync_phase / selection_ready
  → GET /contacts/recent-active   (10-day window)
  → optional Google sync / phonebook upload
  → user ticks DMs/groups
  → POST /contacts/set-monitored
       + POST /assistant/initialize-audit-jobs
  → ChatAuditJob PENDING → audit_worker pool
  → MatterCards appear on /today
  → setContactsConfiguredFlag(true) → nav unlock
```

---

## Phase 12 — Message journeys

### A — First-time user

```
Google login → Firebase token
  → AuthGuard polls /auth/status
  → QR (assistant/qr-status → worker)
  → history sync (messages → media → contacts → names → ready)
  → Settings contact picker (10-day) → set-monitored + initialize-audit-jobs
  → audit pool → MatterCards on /today
```

### B — Live chat

```
WA notify → worker + secret → /webhook/incoming
  → Message (tenant_jid)
  → (live) task / legacy matter if actionable/monitored
  → Inbox updates; Today cards via audit / process paths
```

History: save-first (heavy AI skip on bulk) — Inbox list bhar sakti hai; cards mainly audit jobs / process-selected se.

### C — Inbox reply + summary

```
GET /inbox/chats → open thread
GET /summary/{jid} → widget
POST /summary/{jid}/generate → GPT brief
POST /inbox/chats/{jid}/send → :5001
POST …/transcribe → voice notes text
```

### D — Today card actions

```
GET /matters/cards (+ /audit-progress poll)
PATCH /matters/{id}/status
POST /matters/{id}/action   { checklist_item?, new_status? }
POST /inbox/chats/{jid}/send  (quick reply from card)
```

### E — Logout

```
Sidebar/Settings
  → Firebase signOut / signOutApp
  → POST /assistant/logout (worker unpair + wipe-tenant-data)
  → clearBrowserStorage / completeLogoutRedirect
```

---

## Phase 13 — Glossary

| Term | Meaning |
|------|---------|
| Firebase UID | Google user id = **`tenant_jid` / `tenant_id`** for rows |
| Bearer token | Firebase ID token; middleware verify karta hai |
| `WORKER_INTERNAL_SECRET` | Shared secret worker ↔ webhook |
| `is_monitored` | Settings-selected chats for AI / audit |
| `selection_ready` / `sync_phase` | Worker flags — Settings picker unlock |
| `isHistorySyncComplete` | Worker history complete flag |
| Matter (legacy) | CRM card table `matters` + children |
| MatterCard | Today desk card from audit pipeline |
| ChatAuditJob | Per-chat background audit state machine |
| Chat summary | Cached 3-day GPT brief (`chat_summaries`) |
| `ball_in_court` | Who should act next in summary |
| Chat isolation | Group/broadcast noise filter vs personal @mention |
| LID | WhatsApp linked-device id (`@lid`) — map to phone |
| `patch-baileys.js` | Force **10-day** + group + on-demand history |
| AuthGuard | Frontend gate (not Next middleware.js) |
| FirebaseAuthMiddleware | FastAPI ASGI auth gate |
| Pattern ingestion | Sliding windows → Chroma for audit context |

---

## Phase 14 — API cheat sheet

### Live worker `:5001`

```
GET  /qr?tenant_id=
GET  /sync-status?tenant_id=
GET  /health?tenant_id=
GET  /auth-status?tenant_id=
POST /logout
POST /fetch-history
POST /send-message   { recipient_jid, text, tenant_id? }
```

### FastAPI `:8000` (browser = Bearer; webhook = worker secret)

```
GET   /

POST  /api/v1/webhook/incoming
POST  /api/v1/webhook/messages-ingest
POST  /api/v1/webhook/incoming-batch
POST  /api/v1/webhook/sync-history
POST  /api/v1/webhook/sync-chats | sync-contacts | settle-contact-names
POST  /api/v1/webhook/sync-lid-mappings | remap-lids | sync-avatars
POST  /api/v1/webhook/link-tenant
POST  /api/v1/webhook/auth-status
POST  /api/v1/webhook/wipe-tenant-data

POST  /api/v1/messages/ingest

GET   /api/v1/auth/status

GET   /api/v1/assistant/qr-status
GET   /api/v1/assistant/sync-status
POST  /api/v1/assistant/logout
POST  /api/v1/assistant/send
POST  /api/v1/assistant/draft-followup
POST  /api/v1/assistant/initialize-audit-jobs     { contacts: [...] }
POST  /api/v1/assistant/bootstrap-audit-from-monitored

GET   /api/v1/contacts/recent-active
POST  /api/v1/contacts/sync-google
POST  /api/v1/contacts/import-phonebook           (multipart file)
POST  /api/v1/contacts/set-monitored              { selected_jids }

GET   /api/v1/matters/audit-progress
GET   /api/v1/matters/cards
PATCH /api/v1/matters/{matter_id}/status
POST  /api/v1/matters/{matter_id}/action

GET   /api/v1/matters
POST  /api/v1/matters/sync-recent
POST  /api/v1/matters/process-selected
POST  /api/v1/matters/trigger-background-sync
GET   /api/v1/matters/{id}/details
GET   /api/v1/matters/{id}/raw-chat
POST  /api/v1/matters/{id}/send-draft
PATCH /api/v1/matters/steps/{step_id}/toggle

GET   /api/v1/inbox/chats
GET   /api/v1/inbox/chats/{jid}/messages
POST  /api/v1/inbox/chats/{jid}/send              { text }
POST  /api/v1/inbox/chats/{jid}/transcribe

GET   /api/v1/summary/{jid}
POST  /api/v1/summary/{jid}/generate

GET   /api/v1/tasks...
POST  /api/v1/audit/search                        { query }

GET   /media/...                                  # downloaded WA media
```

---

## Phase 15 — Gemini context prompt

```
You are working in repo "wa-executive-assistant" (UI: Perisclaw Executive AI).
Read PROJECT_GUIDE.md first. Match files that exist today (snapshot 9 Nov 2026).

Auth model (do not regress):
- Frontend: Firebase Google sign-in (lib/firebase.js, /login, AuthGuard).
- Every browser API call: Authorization Bearer Firebase ID token (lib/api.js interceptor).
- Backend: FirebaseAuthMiddleware in services/firebase_auth.py.
- tenant_jid/tenant_id = verified Firebase uid (never trust client-only tenant spoofing).
- Webhooks: only localhost + X-Worker-Secret == WORKER_INTERNAL_SECRET.
- No Next.js middleware.js; AuthGuard is the page gate.

Three processes:
1) wa_worker index.js :5001 multi-tenant Baileys; patch-baileys.js enables 10-day + groups + onDemandReady.
   Endpoints: /qr /sync-status /health /auth-status /logout /fetch-history /send-message.
2) ai_core uvicorn :8000 — routers webhook, messages, tasks, assistant (+setup), auth, audit,
   today, matters, inbox, contacts, summary.
   Models: Message, Task, Matter(+children), MatterCard, ChatAuditJob, Contact, LidMapping, ChatSummary.
3) frontend :3000 — /login, /today (MatterCards), / (legacy desk), /inbox, /settings
   (10-day contact monitor + Google/phonebook), RealtimeSyncStreamCard, ChatSummaryWidget.

Today pipeline:
  set-monitored / initialize-audit-jobs → ChatAuditJob → audit_worker (sem 3) →
  pattern_ingestion + matter_extractor → MatterCard → GET /matters/cards.

Contacts gate: GET /contacts/recent-active (10 days) → POST /contacts/set-monitored →
audit jobs. Inbox summaries: GET/POST /api/v1/summary/{jid}.

Keep QR off terminal. Do not mix :5001 send-message with :5000 /api/send for desk sends.
Service-account private key stays in ai_core/.env only; frontend gets public web config.
media_batch_pipeline/ is a separate offline CLI — do not wire it into the desk unless asked.

My request: <WRITE WHAT YOU WANT HERE>
```

---

## Phase 16 — Optional: media_batch_pipeline

Standalone Python CLI under `media_batch_pipeline/`. Product WhatsApp desk se **alag**. Recursive media/chat scan, FIFO queue, OpenAI calls, `state.json` checkpoint, Rich UI.

```bash
cd media_batch_pipeline
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python run.py "C:\path\to\chats_or_media" --dry-run
```

Details: `media_batch_pipeline/README.md`.

---

## One-line model

**Google (Firebase) → Bearer API → tenant SQLite → WhatsApp worker (:5001 + secret, 10-day sync) → monitor pick → audit jobs → MatterCards on /today + inbox summaries.**

---

*Yeh guide current source se 9 Nov 2026 ko update hui. Architecture / auth / Today pipeline badle to isi file ko pehle update karo.*
