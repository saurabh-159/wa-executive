# WhatsApp Executive Assistant

WhatsApp conversations se commitments extract karta hai aur web dashboard par dikhata hai.

## Architecture

| Service | Port | Role |
|---------|------|------|
| `wa_worker` | 5001 | Baileys WhatsApp socket + QR API |
| `ai_core` | 8000 | FastAPI — webhook, AI, tasks |
| `frontend` | 3000 | Next.js dashboard (QR scan yahan) |

QR code **terminal mein nahi** dikhta — sirf web dashboard (`/`) par.

## Setup

### 1. AI Core (Python)

```bash
cd ai_core
python -m venv venv
# Windows:
.\venv\Scripts\activate
pip install -r requirements.txt
```

`.env` me apni OpenAI key set karo:

```
OPENAI_API_KEY=sk-...
```

```bash
uvicorn app.main:app --reload --port 8000
```

### 2. WhatsApp Worker (Node)

```bash
cd wa_worker
npm install
npm start
```

### 3. Frontend (Next.js)

```bash
cd frontend
npm install
npm run dev
```

Browser: http://localhost:3000 — WhatsApp link nahi hai toh QR card dikhega.
