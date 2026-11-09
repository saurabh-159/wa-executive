export const MOCK_TASKS = [
  {
    id: "mock-1",
    task_heading: "Send revised pitch deck",
    category: "I_OWE_THEM",
    counterparty_name: "Rahul Mehta",
    sender_jid: "919810011001@s.whatsapp.net",
    context_their_message:
      "The deck still has last quarter's numbers. Can you send the revised version before the partner call?",
    context_your_reply: "Yes — I'll send the updated deck tomorrow by 5 PM.",
    full_thread_summary:
      "You committed to deliver a revised pitch deck to Rahul before tomorrow's partner call.",
    due_date_time: "Tomorrow 5 PM",
    priority: "HIGH",
    status: "PENDING",
  },
  {
    id: "mock-2",
    task_heading: "Confirm ₹1.8L payment receipt",
    category: "THEY_OWE_ME",
    counterparty_name: "Rahul Mehta",
    sender_jid: "919810011001@s.whatsapp.net",
    context_their_message:
      "Payment of ₹1.8L is cleared from my side. You'll have the advice slip by Friday morning.",
    context_your_reply: "Perfect. I'll match it against the invoice once the slip lands.",
    full_thread_summary:
      "Rahul owes the payment advice for the ₹1.8L transfer he said was already cleared.",
    due_date_time: "Today 11 AM",
    priority: "HIGH",
    status: "PENDING",
  },
  {
    id: "mock-3",
    task_heading: "Share signed vendor agreement",
    category: "I_OWE_THEM",
    counterparty_name: "Neha Kapoor",
    sender_jid: "919820022002@s.whatsapp.net",
    context_their_message:
      "Legal signed off. I just need the countersigned PDF so procurement can raise the PO.",
    context_your_reply: "I'll countersign tonight and drop the PDF here before lunch tomorrow.",
    full_thread_summary:
      "Procurement is blocked on the countersigned vendor agreement you promised Neha.",
    due_date_time: "Tomorrow 1 PM",
    priority: "MEDIUM",
    status: "PENDING",
  },
  {
    id: "mock-4",
    task_heading: "Return redlines on SOW",
    category: "THEY_OWE_ME",
    counterparty_name: "Arjun Shah",
    sender_jid: "919830033003@s.whatsapp.net",
    context_their_message:
      "I'll send the SOW redlines after the 4 PM standup. Two clauses on liability still need a look.",
    context_your_reply: "Thanks. Once I have the redlines I'll lock the kickoff date.",
    full_thread_summary:
      "Arjun still owes SOW redlines, specifically the liability clauses, after today's standup.",
    due_date_time: "Today 6 PM",
    priority: "MEDIUM",
    status: "PENDING",
  },
  {
    id: "mock-5",
    task_heading: "Book Delhi client dinner",
    category: "I_OWE_THEM",
    counterparty_name: "Priya Nair",
    sender_jid: "919840044004@s.whatsapp.net",
    context_their_message:
      "The Mumbai team lands Thursday. Can you hold a quiet table for six near Aerocity?",
    context_your_reply: "I'll book Indian Accent's private room and send the confirmation.",
    full_thread_summary:
      "You owe Priya a Thursday dinner reservation for six near Aerocity.",
    due_date_time: "Wednesday 3 PM",
    priority: "LOW",
    status: "PENDING",
  },
  {
    id: "mock-6",
    task_heading: "Send Q3 invoice pack",
    category: "THEY_OWE_ME",
    counterparty_name: "Vikram Desai",
    sender_jid: "919850055005@s.whatsapp.net",
    context_their_message:
      "Accounts will mail the Q3 invoice pack with GST breakup. Give me until Monday.",
    context_your_reply: "Monday works. I'll release the next milestone once the pack is in.",
    full_thread_summary:
      "Vikram's accounts team owes the Q3 invoice pack with GST breakup by Monday.",
    due_date_time: "Monday 10 AM",
    priority: "MEDIUM",
    status: "PENDING",
  },
  {
    id: "mock-7",
    task_heading: "Intro deck for Studio North",
    category: "I_OWE_THEM",
    counterparty_name: "Studio North",
    sender_jid: "919860066006@s.whatsapp.net",
    context_their_message:
      "If you can send a one-pager on the WhatsApp desk, I'll circulate it to the partners this week.",
    context_your_reply: "I'll send a tight one-pager by Friday noon.",
    full_thread_summary:
      "Studio North is waiting on a one-page intro before their partner circulation.",
    due_date_time: "Friday 12 PM",
    priority: "LOW",
    status: "PENDING",
  },
  {
    id: "mock-8",
    task_heading: "Escalate customs hold",
    category: "THEY_OWE_ME",
    counterparty_name: "Neha Kapoor",
    sender_jid: "919820022002@s.whatsapp.net",
    context_their_message:
      "The shipment is sitting with customs. I'll call the broker and update you with a release window.",
    context_your_reply: "Please do. The client demo can't move without that crate.",
    full_thread_summary:
      "Neha owes a customs-release window after promising to call the broker.",
    due_date_time: "Tomorrow 9 AM",
    priority: "URGENT",
    status: "PENDING",
  },
];

const MOCK_CHUNKS = [
  {
    id: "chunk-rahul-pay",
    counterparty_name: "Rahul Mehta",
    timestamp_label: "28 Oct · 4:12 PM",
    topic: "payment update invoice advice",
    text: "Rahul: Payment of ₹1.8L is cleared from my side. You'll have the advice slip by Friday morning.\nMe: Perfect. I'll match it against the invoice once the slip lands.",
  },
  {
    id: "chunk-rahul-deck",
    counterparty_name: "Rahul Mehta",
    timestamp_label: "29 Oct · 11:05 AM",
    topic: "pitch deck partner call",
    text: "Rahul: The deck still has last quarter's numbers. Can you send the revised version before the partner call?\nMe: Yes — I'll send the updated deck tomorrow by 5 PM.",
  },
  {
    id: "chunk-neha-po",
    counterparty_name: "Neha Kapoor",
    timestamp_label: "27 Oct · 6:40 PM",
    topic: "vendor agreement procurement",
    text: "Neha: Legal signed off. I just need the countersigned PDF so procurement can raise the PO.\nMe: I'll countersign tonight and drop the PDF here before lunch tomorrow.",
  },
  {
    id: "chunk-neha-customs",
    counterparty_name: "Neha Kapoor",
    timestamp_label: "29 Oct · 8:18 AM",
    topic: "customs shipment broker",
    text: "Neha: The shipment is sitting with customs. I'll call the broker and update you with a release window.\nMe: Please do. The client demo can't move without that crate.",
  },
  {
    id: "chunk-arjun-sow",
    counterparty_name: "Arjun Shah",
    timestamp_label: "30 Oct · 9:02 AM",
    topic: "sow redlines liability",
    text: "Arjun: I'll send the SOW redlines after the 4 PM standup. Two clauses on liability still need a look.\nMe: Thanks. Once I have the redlines I'll lock the kickoff date.",
  },
  {
    id: "chunk-vikram-gst",
    counterparty_name: "Vikram Desai",
    timestamp_label: "26 Oct · 2:27 PM",
    topic: "invoice gst q3 accounts",
    text: "Vikram: Accounts will mail the Q3 invoice pack with GST breakup. Give me until Monday.\nMe: Monday works. I'll release the next milestone once the pack is in.",
  },
  {
    id: "chunk-priya-dinner",
    counterparty_name: "Priya Nair",
    timestamp_label: "25 Oct · 7:55 PM",
    topic: "dinner delhi aerocity",
    text: "Priya: The Mumbai team lands Thursday. Can you hold a quiet table for six near Aerocity?\nMe: I'll book Indian Accent's private room and send the confirmation.",
  },
];

function summaryFor(query, chunks, matched) {
  const names = [...new Set(chunks.map((chunk) => chunk.counterparty_name))];
  const who = names.slice(0, 3).join(", ");
  if (!matched) {
    return `No exact thread matched “${query}”. Closest desk context is with ${who}: open payment, delivery, and follow-up language is still sitting in those chats.`;
  }
  return `Across ${chunks.length} retrieved excerpt${chunks.length === 1 ? "" : "s"} with ${who}, the open point is a concrete commitment — a payment proof, a file, or a deadline — and the latest reply already accepted that timing.`;
}

export function mockAuditSearch(query) {
  const stopWords = new Set(["with", "the", "and", "for", "from", "that", "this", "your"]);
  const terms = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9₹]+/i)
    .filter((word) => word.length > 2 && !stopWords.has(word));

  const scored = MOCK_CHUNKS.map((chunk) => {
    const hay = `${chunk.text} ${chunk.counterparty_name} ${chunk.topic}`.toLowerCase();
    const score = terms.reduce((total, term) => total + (hay.includes(term) ? 1 : 0), 0);
    return { chunk, score };
  }).sort((a, b) => b.score - a.score);

  const matched = scored.filter((item) => item.score > 0).map((item) => item.chunk);
  const chunks = (matched.length ? matched : scored.map((item) => item.chunk)).slice(0, 4);

  return {
    query: query || "Payment update with Rahul",
    summary: summaryFor(query || "recent commitments", chunks, matched.length > 0),
    chunks,
    live: false,
  };
}
