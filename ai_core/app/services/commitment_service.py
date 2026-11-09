import json
from openai import OpenAI
from app.config import settings
from app.services.multimodal_service import encode_image_to_base64
from app.services.token_tracker import log_llm_usage

client = OpenAI(api_key=settings.OPENAI_API_KEY)

SYSTEM_PROMPT = """
You are an Executive Commitment Extraction Agent.
Analyze the conversation between 'Me' and 'Counterparty'.
If an image is attached, inspect it carefully (it could be an invoice, bill, receipt, screenshot of transaction, or handwritten note).

Your task is to identify commitments, deliverables, or promises.

Categories:
- 'I_OWE_THEM': User ('Me') committed to doing something for the other person.
- 'THEY_OWE_ME': The counterparty committed to doing something for the user.

Rules:
- For casual chit-chat, greetings, or questions with no promise, return: {"is_task": false}
- If a valid commitment exists, return valid JSON with these exact keys:
{
  "is_task": true,
  "heading": "Short 4-6 word task title",
  "category": "I_OWE_THEM" or "THEY_OWE_ME",
  "their_message": "Exact quote from counterparty or image details",
  "my_reply": "Exact quote from user",
  "summary": "1-2 line clear executive summary",
  "due_date": "Relative or clear deadline (e.g., 'Tomorrow 5 PM', 'Today', or 'Pending')"
}
"""

def extract_commitments_from_chat(messages: list, counterparty_name: str, media_path: str = None) -> dict:
    if not messages and not media_path:
        return {"is_task": False}

    # Chronological chat text construct karna
    chat_lines = [
        f"{'[You (Saurabh)]' if m.is_from_me else f'[Contact: {counterparty_name}]'}: {m.text or ''}"
        for m in messages
    ]
    chat_text = "\n".join(chat_lines)

    # User content payload construct karna
    user_content = [
        {
            "type": "text", 
            "text": f"Counterparty: {counterparty_name}\n\nRecent Chat History:\n{chat_text}"
        }
    ]

    # Agar koi image path aaya hai, toh use Base64 karke GPT-4o Vision ko pass karo
    if media_path:
        b64_image = encode_image_to_base64(media_path)
        if b64_image:
            user_content.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{b64_image}"
                }
            })

    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            response_format={"type": "json_object"},  # Strict JSON Mode
            temperature=0.2,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content}  # Array with text + image
            ]
        )
        log_llm_usage(
            "Commitment_Extraction",
            counterparty_name or "unknown",
            response,
            model_name="gpt-4o",
        )

        raw_text = response.choices[0].message.content
        return json.loads(raw_text)

    except Exception as e:
        print(f"❌ [Commitment Service Error]: {e}")
        return {"is_task": False, "error": str(e)}