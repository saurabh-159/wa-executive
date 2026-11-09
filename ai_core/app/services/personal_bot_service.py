import json
from openai import OpenAI
from app.config import settings

client = OpenAI(api_key=settings.OPENAI_API_KEY)

# app/services/personal_bot_service.py me SYSTEM_PROMPT me ek aur intent jodh diya:

ROUTER_SYSTEM_PROMPT = """
You are the Executive Personal Assistant Brain running inside WhatsApp self-chat.
Analyze the user's command and categorize the intent.

POSSIBLE INTENTS:
1. 'CREATE_TASK': User wants to add a personal task/reminder.
   Example: "Remind me to call Amit tomorrow at 4 PM"
2. 'QUERY_TASKS': User asks for pending tasks or commitments.
   Example: "Show pending tasks", "Mera kya kaam bacha hai?"
3. 'COMPLETE_TASK': User wants to mark a task as finished.
   Example: "Amit wala task done mark kar do"
4. 'AUDIT_CONTACT': User is asking about past discussions, history, or updates with a specific person.
   Example: "Rahul ke sath payment par kya baat hui thi?", "What did Priya say about the contract?", "Search history with Vikram"
5. 'GENERAL_CHAT': Normal conversational chit-chat.

OUTPUT FORMAT (Strict JSON):
{
  "intent": "CREATE_TASK" | "QUERY_TASKS" | "COMPLETE_TASK" | "AUDIT_CONTACT" | "GENERAL_CHAT",
  "task_data": {
    "heading": "Task title (if CREATE_TASK)",
    "due_date": "Deadline (if CREATE_TASK)",
    "priority": "LOW" | "MEDIUM" | "HIGH"
  },
  "search_keyword": "Task title keyword (if COMPLETE_TASK)",
  "contact_query": {
    "person_name": "Name of person (if AUDIT_CONTACT, e.g. 'Rahul')",
    "query_topic": "What to search (if AUDIT_CONTACT, e.g. 'payment aur quotation')"
  },
  "general_reply": "Crisp reply (if GENERAL_CHAT)"
}
"""

def route_self_chat_intent(user_message: str) -> dict:
    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            response_format={"type": "json_object"},
            temperature=0.1,  # Ultra-strict classification
            messages=[
                {"role": "system", "content": ROUTER_SYSTEM_PROMPT},
                {"role": "user", "content": user_message}
            ]
        )
        return json.loads(response.choices[0].message.content)
    except Exception as e:
        print(f"❌ [Intent Routing Error]: {e}")
        return {"intent": "GENERAL_CHAT", "general_reply": "Kuch gadbad hui, kripya dobara try karein."}


def format_executive_card(title: str, lines: list) -> str:
    """
    WhatsApp par Perisclaw jaisa sleek executive card generate karta hai.
    """
    card = [
        "⚡ *EXECUTIVE DESK AI*",
        "────────────────────────",
        f"📌 *{title.upper()}*",
        ""
    ]
    for line in lines:
        card.append(f"• {line}")
    card.append("────────────────────────")
    return "\n".join(card)