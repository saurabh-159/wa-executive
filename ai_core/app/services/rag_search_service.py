import os
import re
import chromadb
from openai import OpenAI
from app.config import settings

client = OpenAI(api_key=settings.OPENAI_API_KEY)

# 1. Local ChromaDB Persistent Client
CHROMA_DATA_PATH = os.path.join(os.getcwd(), "chroma_db_store")
chroma_client = chromadb.PersistentClient(path=CHROMA_DATA_PATH)


def _sanitize_collection_name(tenant_jid: str) -> str:
    """
    ChromaDB collection names must be 3-63 chars, alphanumeric, with dots/dashes/underscores.
    """
    raw = str(tenant_jid or "default").strip().lower()
    cleaned = re.sub(r"[^a-zA-Z0-9_-]", "_", raw)
    name = f"tenant_{cleaned}"[:60]
    return name


def _get_tenant_collection(tenant_jid: str = "default"):
    """Har tenant ke liye dedicated vector collection return karta hai."""
    coll_name = _sanitize_collection_name(tenant_jid)
    return chroma_client.get_or_create_collection(name=coll_name)


# 2. Text ko Vector Numbers me badalna (Embedding API Call)
def get_embedding(text: str) -> list:
    """
    OpenAI text-embedding-3-small model se text ko 1536 floats ki list banata hai
    """
    try:
        response = client.embeddings.create(
            model="text-embedding-3-small",
            input=text
        )
        return response.data[0].embedding
    except Exception as e:
        print(f"❌ [Embedding Error]: {e}")
        return []


# 3. Purani Chats ko Chunks me Vector DB me Index/Save karna (Tenant Isolated)
def index_chat_conversation(
    sender_jid: str,
    sender_name: str,
    messages: list,
    tenant_jid: str = "default",
):
    """
    messages: List of Message database objects
    Inhe 5-5 ke blocks me todkar tenant ke dedicated collection me upsert karte hain.
    """
    if not messages:
        return

    collection = _get_tenant_collection(tenant_jid)
    chunk_size = 5

    for i in range(0, len(messages), chunk_size):
        chunk_slice = messages[i:i + chunk_size]

        lines = []
        for m in chunk_slice:
            label = "Me" if m.is_from_me else sender_name
            lines.append(f"{label}: {m.text or ''}")

        chunk_text = "\n".join(lines)
        if not chunk_text.strip():
            continue

        vector = get_embedding(chunk_text)
        if not vector:
            continue

        chunk_id = f"chunk_{tenant_jid}_{sender_jid}_{i}_{chunk_slice[0].timestamp}"

        collection.upsert(
            ids=[chunk_id],
            embeddings=[vector],
            documents=[chunk_text],
            metadatas=[{
                "tenant_jid": str(tenant_jid),
                "sender_jid": sender_jid,
                "sender_name": sender_name,
                "timestamp": int(chunk_slice[-1].timestamp or 0)
            }]
        )

    print(f"✅ [RAG Indexed ({tenant_jid})]: {len(messages)} messages indexed for {sender_name}")


# 4. Semantic Search (Tenant Scoped)
def search_relevant_context(
    sender_jid: str,
    query: str,
    top_k: int = 3,
    tenant_jid: str = "default",
) -> list:
    """
    Tenant ke isolated collection se matching conversation chunks dhoondhta hai.
    """
    query_vector = get_embedding(query)
    if not query_vector:
        return []

    collection = _get_tenant_collection(tenant_jid)

    results = collection.query(
        query_embeddings=[query_vector],
        n_results=top_k,
        where={"sender_jid": sender_jid}
    )

    documents = results.get("documents", [[]])[0]
    return documents


# 5. RAG Generation
AUDIT_SYSTEM_PROMPT = """
You are an Executive WhatsApp Intelligence Agent.
You are provided with relevant retrieved chat excerpts between the user ('Me') and a counterparty.

Your job is to answer the user's specific audit question with absolute precision.

Rules:
- Give a crisp 3-4 bullet point executive breakdown.
- Mention clear dates, commitments, deliverables, or pending points if discussed.
- If information is not in the excerpts, clearly state that it was not found in recent records.
- Use clean WhatsApp formatting (bold headings, bullet points).
"""


def generate_contact_audit_summary(
    contact_name: str,
    sender_jid: str,
    query: str,
    tenant_jid: str = "default",
) -> str:
    """
    RAG Pipeline:
    Query -> Vector Search (Tenant Collection) -> Top Chunks -> GPT-4o Reasoning -> Executive Audit
    """
    matched_chunks = search_relevant_context(
        sender_jid=sender_jid,
        query=query,
        top_k=3,
        tenant_jid=tenant_jid,
    )

    if not matched_chunks:
        return f"📌 *AUDIT: {contact_name.upper()}*\n\nRecords mein is vishay par koi purani baat-cheet nahi mili."

    context_block = "\n---\n".join(matched_chunks)

    user_prompt = f"""
Contact Name: {contact_name}
User Query: "{query}"

Retrieved Chat Excerpts:
\"\"\"
{context_block}
\"\"\"

Provide the executive audit summary based strictly on these excerpts.
"""

    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            temperature=0.2,
            messages=[
                {"role": "system", "content": AUDIT_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt}
            ]
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        print(f"❌ [RAG Generation Error]: {e}")
        return "Audit generate karne mein dikkat aayi."