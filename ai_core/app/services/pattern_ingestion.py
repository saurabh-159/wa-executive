import os
import re
from typing import Any, Dict, List

import chromadb
from openai import AsyncOpenAI

from app.config import settings
from app.services.token_tracker import log_llm_usage

openai_client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY or None)

CHROMA_DATA_PATH = os.path.join(os.getcwd(), "chroma_db_store")
chroma_client = chromadb.PersistentClient(path=CHROMA_DATA_PATH)

# Short / greeting-only strings that must never burn embedding tokens.
_NOISE_GREETINGS = frozenset(
    {
        "hi",
        "hii",
        "hiii",
        "hello",
        "helo",
        "hey",
        "ok",
        "okay",
        "k",
        "kk",
        "acha",
        "accha",
        "achha",
        "hmm",
        "hmmm",
        "haan",
        "han",
        "ha",
        "yes",
        "yeah",
        "yep",
        "no",
        "nah",
        "nope",
        "bye",
        "gn",
        "gm",
        "dandavat",
        "pranam",
        "namaste",
        "namaskar",
        "hare krishna",
        "hare ram",
        "radhe radhe",
        "jai shree krishna",
        "thanks",
        "thank you",
        "thx",
        "ty",
        "cool",
        "nice",
        "great",
        "lol",
        "haha",
        "hehe",
        "👍",
        "🙏",
        "❤️",
        "😂",
    }
)
_EMOJI_ONLY_RE = re.compile(
    r"^[\s"
    r"\U0001F300-\U0001F9FF"
    r"\u2600-\u26FF"
    r"\u2700-\u27BF"
    r"\U0001FA00-\U0001FAFF"
    r"]+$",
)
_CHUNK_LINE_CONTENT_RE = re.compile(r"\]:\s*(.*)$")


def is_noise_embedding_text(text: str) -> bool:
    """
    True when a chunk / message is too short or greeting-only to justify
    text-embedding-3-small spend.
    """
    raw = (text or "").strip()
    if not raw:
        return True

    # Sliding-window chunks are multi-line; evaluate the spoken content only.
    contents: list[str] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        matched = _CHUNK_LINE_CONTENT_RE.search(line)
        contents.append((matched.group(1) if matched else line).strip())

    if not contents:
        return True

    meaningful = [c for c in contents if c and not c.lower().startswith("media omitted")]
    if not meaningful:
        return True

    # Entire window is short casual banter (< 15 chars of real content total)
    joined = " ".join(meaningful).strip()
    collapsed = re.sub(r"\s+", " ", joined).strip()
    if len(collapsed) < 15:
        return True

    normalized_parts = []
    for part in meaningful:
        cleaned = re.sub(r"[^\w\s]", " ", part, flags=re.UNICODE)
        cleaned = re.sub(r"\s+", " ", cleaned).strip().lower()
        if cleaned:
            normalized_parts.append(cleaned)
        elif _EMOJI_ONLY_RE.match(part):
            continue
        else:
            # Punctuation-only residue
            continue

    if not normalized_parts:
        return True

    return all(part in _NOISE_GREETINGS for part in normalized_parts)

# 8 Universal Cognitive Interaction Probes (Language-agnostic, zero domain hardcoding)
UNIVERSAL_PATTERN_PROBES = [
    # Probe 1: Directed Requests & Explicit Asks (Tasks assigned)
    "action requested pending query please send provide confirm check follow up task needed",
    # Probe 2: Commitments & Conditional Timelines (Future promises)
    "commitment promised will do later scheduled deadline timeline by tomorrow after work soon",
    # Probe 3: Exchanges, Deliverables & Blockers (Halted dependencies, transactions)
    "shared deliverable transaction transfer verified receipt awaiting review blocker status hold",
    # Probe 4: Decisions & Status Resolutions (Final closures, settled outcomes)
    "decision taken completed resolved updated final outcome agreed canceled closed done",
    # Probe 5: Physical Coordination, Location & Meetings (Real-world sync points)
    "meeting location venue reach arrive visit map address call connect time meet spot",
    # Probe 6: Information Anchors & Credentials (Critical assets, keys, access, numbers)
    "details account credentials password access link document id reference code contact file",
    # Probe 7: Friction, Urgency & Escalation (Blockers, delays, complaints, priority shifts)
    "urgent delay emergency error issue warning not working problem missed complaint stuck risk",
    # Probe 8: Emotional / Relational Status (Venting, boundaries, personal check-ins)
    "stressed upset comfort advice busy family health worry mood support clarify feel",
]


def _sanitize_collection_name(tenant_id: str) -> str:
    raw = str(tenant_id or "default").strip().lower()
    cleaned = re.sub(r"[^a-zA-Z0-9_-]", "_", raw)
    return f"tenant_{cleaned}"[:60]


def wipe_tenant_vectors(tenant_id: str) -> bool:
    """Delete the tenant-scoped Chroma collection (full unlink clean slate)."""
    name = _sanitize_collection_name(tenant_id)
    try:
        chroma_client.delete_collection(name)
        return True
    except Exception:
        # Collection may not exist yet — treat as already clean.
        try:
            existing = {c.name for c in chroma_client.list_collections()}
            if name not in existing:
                return True
        except Exception:
            pass
        return False


def generate_sliding_window_chunks(
    messages: List[Dict[str, Any]],
    window_size: int = 6,
    overlap: int = 2,
) -> List[Dict[str, Any]]:
    """
    Creates overlapping conversational windows of 6 messages so context is preserved across replies.
    """
    if not messages:
        return []

    chunks = []
    step = max(1, window_size - overlap)

    for i in range(0, len(messages), step):
        window = messages[i : i + window_size]
        text_lines = []
        for m in window:
            # Prefer pre-formatted [You (Saurabh)] / [Contact: …] labels from audit_worker
            sender = m.get("sender", "Unknown")
            if not str(sender).startswith("["):
                if m.get("from_me") or m.get("is_from_me"):
                    sender = "[You (Saurabh)]"
                else:
                    contact = (
                        m.get("participant_name")
                        or m.get("sender_name")
                        or sender
                        or "Contact"
                    )
                    sender = f"[Contact: {contact}]"
            t_str = m.get("time", "")
            content = (m.get("text") or "").strip()
            # Basic noise drop: skip pure blank lines or media omitted markers
            if content and not content.lower().startswith("media omitted"):
                text_lines.append(f"{sender} [{t_str}]: {content}")

        if text_lines:
            chunks.append(
                {
                    "chunk_id": f"chunk_{i}",
                    "text": "\n".join(text_lines),
                    "start_time": window[0].get("time", ""),
                    "end_time": window[-1].get("time", ""),
                }
            )

    return chunks


async def ingest_chat_vectors(tenant_id: str, jid: str, chunks: List[Dict[str, Any]]):
    """
    Generates text-embedding-3-small embeddings and upserts into ChromaDB.
    Noise / greeting-only windows are dropped before the embedding call.
    """
    if not chunks:
        return

    kept = [c for c in chunks if not is_noise_embedding_text(c.get("text") or "")]
    dropped = len(chunks) - len(kept)
    if dropped:
        print(
            f"[Embedding Gate] Dropped {dropped}/{len(chunks)} noise chunks for {jid}"
        )
    if not kept:
        return

    texts = [c["text"] for c in kept]
    ids = [f"{jid}_{c['chunk_id']}" for c in kept]
    metadatas = [
        {
            "jid": jid,
            "tenant_id": tenant_id,
            "start_time": str(c["start_time"] or ""),
            "end_time": str(c["end_time"] or ""),
        }
        for c in kept
    ]

    res = await openai_client.embeddings.create(
        model="text-embedding-3-small",
        input=texts,
    )
    log_llm_usage(
        "Chroma_Embeddings",
        jid,
        res,
        model_name="text-embedding-3-small",
        tenant_id=tenant_id,
    )
    embeddings = [r.embedding for r in res.data]

    collection = chroma_client.get_or_create_collection(
        name=_sanitize_collection_name(tenant_id)
    )
    collection.upsert(
        ids=ids,
        embeddings=embeddings,
        documents=texts,
        metadatas=metadatas,
    )


async def retrieve_universal_pattern_chunks(tenant_id: str, jid: str) -> str:
    """
    Executes a single batch embedding call for the 8 universal probes
    and extracts top semantic context chunks matching any real communication primitive.
    """
    collection = chroma_client.get_or_create_collection(
        name=_sanitize_collection_name(tenant_id)
    )

    probe_response = await openai_client.embeddings.create(
        model="text-embedding-3-small",
        input=UNIVERSAL_PATTERN_PROBES,
    )
    log_llm_usage(
        "Chroma_Embeddings",
        jid,
        probe_response,
        model_name="text-embedding-3-small",
        tenant_id=tenant_id,
    )
    probe_vectors = [p.embedding for p in probe_response.data]

    matched_ids = set()
    dense_context_blocks = []

    for vec in probe_vectors:
        results = collection.query(
            query_embeddings=[vec],
            n_results=1,
            where={"jid": jid},
        )

        docs = results.get("documents", [[]])[0]
        ids = results.get("ids", [[]])[0]

        for doc_id, text in zip(ids, docs):
            if doc_id not in matched_ids:
                matched_ids.add(doc_id)
                dense_context_blocks.append(text)

    return "\n\n---\n\n".join(dense_context_blocks)
