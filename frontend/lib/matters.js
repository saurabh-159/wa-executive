export const FEED_TABS = [
  { id: "ALL", label: "All" },
  { id: "NEEDS_YOU", label: "Needs you", countKey: "needs_you" },
  { id: "WAITING", label: "Waiting" },
  { id: "DONE", label: "Done" },
];

export const STATUS_META = {
  NEEDS_YOU: {
    label: "Needs you",
    pill: "border-rose-200 bg-rose-50 text-rose-600",
    dot: "bg-rose-500",
  },
  WAITING: {
    label: "Waiting",
    pill: "border-amber-200 bg-amber-50 text-amber-700",
    dot: "bg-amber-500",
  },
  LATER: {
    label: "Later",
    pill: "border-slate-200 bg-slate-100 text-slate-600",
    dot: "bg-slate-400",
  },
  DONE: {
    label: "Done",
    pill: "border-emerald-200 bg-emerald-50 text-emerald-600",
    dot: "bg-emerald-500",
  },
  SESSION: {
    label: "Session",
    pill: "border-orange-200 bg-orange-50 text-orange-600",
    dot: "bg-orange-500",
  },
};

const AVATAR_TONES = [
  "bg-orange-100 text-orange-700",
  "bg-amber-100 text-amber-800",
  "bg-rose-50 text-rose-600",
  "bg-slate-100 text-slate-700",
];

export function normalizeTs(value) {
  if (value == null || value === "") return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? NaN : parsed;
}

function pick(parts, type) {
  return parts.find((part) => part.type === type)?.value ?? "";
}

export function istParts(value) {
  const ms = normalizeTs(value);
  if (Number.isNaN(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const hour24 = Number(pick(parts, "hour"));
  const minute = pick(parts, "minute");
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return {
    dayKey: `${pick(parts, "year")}-${pick(parts, "month")}-${pick(parts, "day")}`,
    day: pick(parts, "day"),
    month: pick(parts, "month"),
    time: `${hour12}:${minute} ${suffix}`,
  };
}

function relation(value) {
  const parts = istParts(value);
  if (!parts) return null;
  const today = istParts(new Date());
  const yesterday = istParts(Date.now() - 86400000);
  if (parts.dayKey === today?.dayKey) return { ...parts, when: "Today" };
  if (parts.dayKey === yesterday?.dayKey) return { ...parts, when: "Yesterday" };
  return { ...parts, when: `${Number(parts.day)} ${parts.month}` };
}

export function formatActivity(value) {
  const parts = relation(value);
  if (!parts) return "";
  return `${parts.when} ${parts.time}`;
}

/** Compact card stamp e.g. 27-Oct-26 */
export function formatCardDate(value) {
  const ms = normalizeTs(value);
  if (Number.isNaN(ms)) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "2-digit",
  }).formatToParts(new Date(ms));
  const day = pick(parts, "day");
  const month = pick(parts, "month");
  const year = pick(parts, "year");
  return `${day}-${month}-${year}`;
}

export function formatStamp(value) {
  const parts = relation(value);
  if (!parts) return "";
  return `${parts.when} · ${parts.time}`;
}

export function formatDayChip(value) {
  return relation(value)?.when || "";
}

export function formatClock(value) {
  return istParts(value)?.time || "";
}

export function formatDeskDate(value = new Date()) {
  const ms = normalizeTs(value);
  const date = new Date(Number.isNaN(ms) ? Date.now() : ms);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "short",
  }).formatToParts(date);
  return `${pick(parts, "weekday")}, ${pick(parts, "day")} ${pick(parts, "month")}`;
}

export function phoneFromJid(jid) {
  const raw = String(jid || "");
  if (/@(lid|g\.us|broadcast|hosted\.lid)$/i.test(raw)) return "";
  const digits = raw.replace(/@.*/, "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  if (digits.length === 10) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  if (digits.length >= 14 || !digits) return "";
  if (digits.length >= 11 && digits.length <= 13) return `+${digits}`;
  return "";
}

export function jidFromPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  const normalized = digits.length === 10 ? `91${digits}` : digits;
  return `${normalized}@s.whatsapp.net`;
}

export function initials(name) {
  const parts = String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2);
  const letters = parts.map((part) => part[0]?.toUpperCase() || "").join("");
  return letters || "?";
}

export function avatarTone(name) {
  const text = String(name || "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash + text.charCodeAt(index) * (index + 1)) % 997;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

export function messageBody(message) {
  const text = String(message?.text || "").trim();
  if (text) return text;
  if (message?.media_type === "image") return "Photo";
  if (message?.media_type === "audio") return "Voice note";
  if (message?.media_type === "video") return "Video";
  if (message?.media_type) return "Attachment";
  return "";
}

export function filterMatters(matters, status, search) {
  const query = String(search || "").trim().toLowerCase();
  return matters.filter((matter) => {
    if (status && status !== "ALL" && matter.status !== status) return false;
    if (!query) return true;
    const haystack = [matter.title, matter.contact_name, matter.summary]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

export function matterStats(matters) {
  const count = (status) => matters.filter((matter) => matter.status === status).length;
  return {
    needs_you: count("NEEDS_YOU"),
    waiting: count("WAITING"),
    later: count("LATER"),
    sessions: count("SESSION"),
    done: count("DONE"),
    total: matters.length,
  };
}

export function istISO(dayOffset, hour, minute) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = Number(pick(parts, "year"));
  const month = Number(pick(parts, "month"));
  const day = Number(pick(parts, "day"));
  const start = Date.UTC(year, month - 1, day) - (5 * 60 + 30) * 60 * 1000;
  return new Date(start + dayOffset * 86400000 + (hour * 60 + minute) * 60000).toISOString();
}

export function buildLocalMatter({ contactName, title, summary, phone }) {
  const name = contactName.trim();
  const heading = title.trim();
  const id = `local-${crypto.randomUUID()}`;
  return {
    id,
    sender_jid: jidFromPhone(phone),
    contact_name: name,
    title: heading,
    status: "NEEDS_YOU",
    headline:
      summary.trim() || `${name} needs a reply on “${heading}”.`,
    situation: `${name} just landed on your desk; only you know.`,
    summary: summary.trim() || `${name} needs a reply on “${heading}”.`,
    last_activity_at: new Date().toISOString(),
    phone: String(phone || "").trim(),
    next_steps: [
      {
        id: `local-step-${crypto.randomUUID()}`,
        step_text: `Reply to ${name} on “${heading}”`,
        is_completed: false,
      },
    ],
    draft_options: [
      {
        id: `local-draft-${crypto.randomUUID()}`,
        action_label: `Tell ${name} you're on it — draft reply`,
        draft_text: `Hey, got it. I'm on “${heading}” and I'll update you shortly.`,
        action_type: "REPLY",
        is_used: false,
      },
      {
        id: `local-draft-${crypto.randomUUID()}`,
        action_label: `Tell ${name} you can't take this and apologise — draft reply`,
        draft_text: `Sorry, I can't take “${heading}” right now.`,
        action_type: "REPLY",
        is_used: false,
      },
      {
        id: `local-draft-${crypto.randomUUID()}`,
        action_label: `I'll call ${name} myself — keep it open`,
        draft_text: "",
        action_type: "CALL",
        is_used: false,
      },
    ],
    timeline_events: [
      {
        id: `local-time-${crypto.randomUUID()}`,
        date_label: "Just now",
        event_description: "Opened on the desk.",
      },
    ],
    messages: [],
  };
}

export function answerMatter(matter, question) {
  const name = matter?.contact_name || "They";
  const title = matter?.title || "this matter";
  const summary = String(matter?.summary || "").trim();
  const open = (matter?.next_steps || []).filter((step) => !step.is_completed);
  const latest = matter?.timeline_events?.[matter.timeline_events.length - 1];
  const draft = (matter?.draft_options || []).find(
    (item) => !item.is_used && item.action_type !== "CALL"
  );
  const q = String(question || "").toLowerCase();
  const blob = `${name} ${title} ${summary}`.toLowerCase();
  const aboutAkash = /akash|star health|missed meet|ncb/.test(blob);

  if (aboutAkash && /where|meet|reception|miss|9/.test(q)) {
    return "Akash was at reception at 9 and could not find you. You had both confirmed that meet. Tell him you were there too, send the previous Star Health PDF, and move it to a 4:30 call before the renewal window.";
  }

  if (aboutAkash && /policy|insurance|renew|pdf|ncb|send|file/.test(q)) {
    return "The deliverable is last year's Star Health policy, ₹10L, with the no-claim bonus intact. Akash still does not have it, and renewal is the urgent clock. Send the PDF first. The missed meet is the second sentence, not the first.";
  }

  if (/next|priority|should|what do|step|todo/.test(q)) {
    if (!open[0]) return `${name} has nothing open on “${title}”. It is safe to mark done.`;
    const rest = open.length - 1;
    const follow = rest > 0 ? ` ${rest} more after that.` : " That clears the list.";
    const context = latest ? ` Latest in the thread: ${latest.event_description}` : "";
    return `Next: ${open[0].step_text}.${follow}${context}`;
  }

  if (/draft|reply|say|write|whatsapp|message|text/.test(q)) {
    if (draft) return `Send this to ${name}: “${draft.draft_text}”`;
    return `Acknowledge ${name}, name the deliverable, and give a clock time. ${summary}`;
  }

  const next = open[0]
    ? ` Your next step is to ${open[0].step_text.charAt(0).toLowerCase()}${open[0].step_text.slice(1)}.`
    : " Nothing is open.";
  return `${summary}${next}`.trim();
}
