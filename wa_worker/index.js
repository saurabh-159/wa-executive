import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  extractMessageContent,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import fs from "fs";
import path from "path";
import axios from "axios";
import http from "http";
import QRCode from "qrcode";

function loadWorkerSecret() {
  if (process.env.WORKER_INTERNAL_SECRET && process.env.WORKER_INTERNAL_SECRET.trim()) {
    return process.env.WORKER_INTERNAL_SECRET.trim();
  }
  try {
    const envPath = path.join(process.cwd(), ".env");
    const text = fs.readFileSync(envPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("WORKER_INTERNAL_SECRET=")) continue;
      return trimmed.slice("WORKER_INTERNAL_SECRET=".length).trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* worker .env is optional until the secret is written */
  }
  return "";
}

const WORKER_INTERNAL_SECRET = loadWorkerSecret();

if (!WORKER_INTERNAL_SECRET) {
  console.warn(
    "[Worker] WORKER_INTERNAL_SECRET is empty — FastAPI webhooks will return 403 Forbidden"
  );
}

axios.interceptors.request.use((config) => {
  const url = String(config.url || "");
  if (url.includes("127.0.0.1:8000") || url.includes("localhost:8000")) {
    config.headers = config.headers || {};
    config.headers["X-Worker-Secret"] = WORKER_INTERNAL_SECRET;
  }
  return config;
});

axios.interceptors.response.use(
  (response) => {
    const url = String(response?.config?.url || "");
    if (
      (url.includes("127.0.0.1:8000") || url.includes("localhost:8000")) &&
      response.status !== 200
    ) {
      console.error(
        `[FastAPI non-200] ${response.status} ${url} → ${JSON.stringify(response.data).slice(0, 300)}`
      );
    }
    return response;
  },
  (error) => {
    const url = String(error?.config?.url || "");
    if (url.includes("127.0.0.1:8000") || url.includes("localhost:8000")) {
      const status = error?.response?.status;
      const detail = error?.response?.data
        ? JSON.stringify(error.response.data).slice(0, 300)
        : error.message;
      console.error(`[FastAPI webhook rejected] ${status || "ERR"} ${url} → ${detail}`);
    }
    return Promise.reject(error);
  }
);

const DOWNLOAD_DIR = path.join(process.cwd(), "downloads");
const BASE_AUTH_DIR = path.join(process.cwd(), "auth_sessions");

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(BASE_AUTH_DIR)) {
  fs.mkdirSync(BASE_AUTH_DIR, { recursive: true });
}

const FASTAPI_WEBHOOK_URL = "http://127.0.0.1:8000/api/v1/webhook/incoming";
const FASTAPI_INGEST_URL = "http://127.0.0.1:8000/api/v1/messages/ingest";
const FASTAPI_BATCH_URL = "http://127.0.0.1:8000/api/v1/webhook/incoming-batch";
const FASTAPI_CONTACTS_URL = "http://127.0.0.1:8000/api/v1/webhook/sync-contacts";
const FASTAPI_SETTLE_NAMES_URL = "http://127.0.0.1:8000/api/v1/webhook/settle-contact-names";
const FASTAPI_CHATS_URL = "http://127.0.0.1:8000/api/v1/webhook/sync-chats";
const PHONEBOOK_SETTLE_DEBOUNCE_MS = 5000;
const PHONEBOOK_SETTLE_TIMEOUT_MS = 55000;
const CONTACT_SYNC_QUIET_MS = 6000;
/** Cap intermediate debounce settles so the loader cannot loop forever. */
const PHONEBOOK_SETTLE_MAX_RUNS = 3;
/** After fast unlock, allow a short capped name backfill (no UI block, no API spam). */
const BACKGROUND_NAME_ENRICH_DEBOUNCE_MS = 5000;
const BACKGROUND_NAME_ENRICH_MAX_RUNS = 2;
const SYNC_PHASE_LABELS = {
  messages: "Indexing last 10 days of chats…",
  media: "Attaching media…",
  contacts: "Syncing contacts…",
  names: "Resolving contact names…",
  ready: "Sync complete — Ready for Selection",
};
const FASTAPI_LID_REMAP_URL = "http://127.0.0.1:8000/api/v1/webhook/remap-lids";
const FASTAPI_LID_MAPPINGS_URL = "http://127.0.0.1:8000/api/v1/webhook/sync-lid-mappings";
const FASTAPI_AVATAR_URL = "http://127.0.0.1:8000/api/v1/webhook/sync-avatars";
const FASTAPI_INBOX_URL = "http://127.0.0.1:8000/api/v1/inbox/chats";
const FASTAPI_AUTH_STATUS_URL = "http://127.0.0.1:8000/api/v1/webhook/auth-status";
const FASTAPI_LINK_TENANT_URL = "http://127.0.0.1:8000/api/v1/webhook/link-tenant";
const FASTAPI_MATTERS_TRIGGER_URL = "http://127.0.0.1:8000/api/v1/matters/trigger-background-sync";

const LEGACY_AUTH_DIRS = ["baileys_auth_info", "auth_info_baileys"];

const HISTORY_BATCH_SIZE = 30;
// 10-day processing / discovery window
const TEN_DAYS_SECS = 10 * 24 * 60 * 60;
const GROUP_HISTORY_CAP = 80;
const TIER2_FALLBACK_COUNT = 15;
const AI_DEBOUNCE_MS = 15000;
const AVATAR_MISS_TTL_MS = 6 * 60 * 60 * 1000;
const AUTH_STATUS_DEDUPE_MS = 8000;
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_MAX_ATTEMPTS = 12;

const ACTIONABLE_KEYWORDS = [
  "payment",
  "invoice",
  "urgent",
  "deadline",
  "bhej",
  "share",
  "kab",
  "kaise",
];

function sanitizeTenantId(id = "default") {
  if (!id || typeof id !== "string") return "default";
  // Firebase UID alphanumeric, '-', aur '_' allow karta hai
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Firebase UID only — never WhatsApp phone JID, never empty/"default". */
function isValidTenantId(id) {
  const value = String(id || "").trim();
  if (!value || value === "default") return false;
  if (value.includes("@")) return false; // reject WA JIDs used as tenants
  return /^[a-zA-Z0-9_-]{6,128}$/.test(value);
}

function resolveRequestTenantId(req, urlObj, { allowDefault = false } = {}) {
  const raw =
    urlObj.searchParams.get("tenant_id") ||
    urlObj.searchParams.get("tenant_jid") ||
    req.headers["x-tenant-jid"] ||
    req.headers["X-Tenant-JID"] ||
    "";
  const cleaned = sanitizeTenantId(String(raw || "").trim());
  if (isValidTenantId(cleaned)) return cleaned;
  return allowDefault ? "default" : "";
}

function normalizeJid(jid) {
  if (!jid) return null;
  const normalized = jidNormalizedUser(jid);
  if (normalized) return normalized;
  return String(jid).replace(/:\d+@/, "@");
}

function isLidJid(jid) {
  const value = String(jid || "");
  return value.endsWith("@lid") || value.endsWith("@hosted.lid");
}

function isPhoneJid(jid) {
  const value = String(jid || "");
  return value.endsWith("@s.whatsapp.net") || value.endsWith("@hosted");
}

function isGroupJid(jid) {
  return String(jid || "").endsWith("@g.us");
}

function looksLikePhoneDigits(digits) {
  if (!digits) return false;
  if (digits.length === 10) return true;
  if (digits.length === 12 && digits.startsWith("91")) return true;
  return digits.length >= 11 && digits.length <= 13;
}

function formatPhoneFromJid(jid) {
  if (!jid || isLidJid(jid) || isGroupJid(jid)) return "";
  const digits = String(jid)
    .replace(/@.*/, "")
    .replace(/\D/g, "");
  if (!looksLikePhoneDigits(digits)) return "";
  if (digits.length === 12 && digits.startsWith("91")) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  if (digits.length === 10) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  return `+${digits}`;
}

function isRawIdentifierLabel(name) {
  const compact = String(name || "").replace(/[\s+().-]/g, "");
  return /^\d{14,}$/.test(compact);
}

/** Formatted, bare, or masked phone strings are not address-book names. */
function looksLikePhoneLabel(name) {
  const raw = String(name || "").trim();
  if (!raw) return false;
  if (/note to self/i.test(raw) || /^you \(self\)/i.test(raw)) return false;
  if (/[^\W\d_]/u.test(raw)) return false;
  if (raw.startsWith("+")) return true;
  const digits = raw.replace(/\D/g, "");
  const compact = raw.replace(/[\s().\-]/g, "");
  return /^\d{10,15}$/.test(digits) && /^\d+$/.test(compact);
}

function firstUsableName(...values) {
  for (const value of values) {
    if (isUsableDisplayName(value)) return String(value).trim();
  }
  return "";
}

/** Keep a previously saved name when a later upsert only has an id or a phone. */
function mergeContactRecord(prev, contact, id) {
  const prior = prev || {};
  return {
    ...prior,
    ...contact,
    id: id || contact?.id,
    name: firstUsableName(contact?.name) || firstUsableName(prior.name) || null,
    notify: firstUsableName(contact?.notify) || firstUsableName(prior.notify) || null,
    verifiedName: firstUsableName(contact?.verifiedName) || firstUsableName(prior.verifiedName) || null,
  };
}

// In-memory RAM counters for live sync UI.
// Kept off SQLite so /sync-status never stalls behind ingest writes.
const RECENT_CONTACT_LIMIT = 15;
const TEN_DAYS_MS = TEN_DAYS_SECS * 1000;
/** @type {Map<string, { messagesCount: number, contactsSet: Set<string>, namesSet: Set<string>, isDone: boolean }>} */
const sessionStats = new Map();
const RECENT_CONTACT_PLACEHOLDERS = new Set([
  "you",
  "you (self)",
  "self",
  "contact",
  "whatsapp contact",
  "whatsapp group",
  "active chat",
]);

function getStats(tenantId) {
  if (!tenantId) {
    return { messagesCount: 0, contactsSet: new Set(), namesSet: new Set(), isDone: false };
  }
  if (!sessionStats.has(tenantId)) {
    sessionStats.set(tenantId, {
      messagesCount: 0,
      contactsSet: new Set(),
      namesSet: new Set(),
      isDone: false,
    });
  }
  return sessionStats.get(tenantId);
}

function markStatsDoneIfReady(stats) {
  if (stats.contactsSet.size >= RECENT_CONTACT_LIMIT || stats.namesSet.size >= RECENT_CONTACT_LIMIT) {
    stats.isDone = true;
  }
}

/** Fast RAM bump for a chat JID within the 10-day window (no I/O). */
function bumpRamMessage(tenantId, jid, messageTimestamp) {
  if (!tenantId) return getStats(tenantId);
  const stats = getStats(tenantId);
  const msgMs = (() => {
    const n = Number(messageTimestamp || 0);
    if (!Number.isFinite(n) || n <= 0) return Date.now();
    return n > 1e12 ? n : n * 1000;
  })();
  const cutoff = Date.now() - TEN_DAYS_MS;
  if (msgMs < cutoff) return stats;

  stats.messagesCount += 1;
  if (jid && !String(jid).includes("@broadcast") && jid !== "status@broadcast") {
    const clean = cleanJid(jid) || String(jid);
    if (clean) stats.contactsSet.add(clean);
  }
  markStatsDoneIfReady(stats);
  return stats;
}

function trackSyncedContact(tenantId, name) {
  if (!tenantId || !name || typeof name !== "string") return false;
  const cleaned = name.trim();
  if (!cleaned) return false;
  const lower = cleaned.toLowerCase();
  if (
    cleaned.includes("@s.whatsapp.net") ||
    cleaned.includes("@g.us") ||
    cleaned.includes("@lid") ||
    cleaned.includes("@hosted") ||
    cleaned.includes("@broadcast") ||
    lower.startsWith("note to self") ||
    /^\d{8,}$/.test(cleaned) ||
    isRawIdentifierLabel(cleaned) ||
    RECENT_CONTACT_PLACEHOLDERS.has(lower)
  ) {
    return false;
  }

  const stats = getStats(tenantId);
  if (!stats.namesSet.has(cleaned)) {
    stats.namesSet.add(cleaned);
    // Rolling buffer: drop the oldest unique name once 15 are kept.
    if (stats.namesSet.size > RECENT_CONTACT_LIMIT) {
      const oldest = stats.namesSet.values().next().value;
      stats.namesSet.delete(oldest);
    }
  }
  markStatsDoneIfReady(stats);
  return true;
}

function recentContactsFor(tenantId) {
  const stats = tenantId ? sessionStats.get(tenantId) : null;
  return stats ? Array.from(stats.namesSet) : [];
}

function auditedContactCount(tenantId) {
  const stats = tenantId ? sessionStats.get(tenantId) : null;
  if (!stats) return 0;
  return Math.max(stats.namesSet.size, stats.contactsSet.size);
}

function ramMessagesIndexed(tenantId) {
  const stats = tenantId ? sessionStats.get(tenantId) : null;
  if (!stats) return 0;
  const audited = Math.max(stats.namesSet.size, stats.contactsSet.size);
  return Math.max(stats.messagesCount, audited > 0 ? audited * 8 : 0);
}

function ramHistoryDone(tenantId, session) {
  const stats = tenantId ? sessionStats.get(tenantId) : null;
  return (
    Boolean(stats?.isDone) ||
    Boolean(session?.isHistorySyncComplete) ||
    Boolean(session?.historyCompleted) ||
    auditedContactCount(tenantId) >= RECENT_CONTACT_LIMIT
  );
}

function clearRecentContacts(tenantId) {
  if (tenantId) sessionStats.delete(tenantId);
}

/** Digit / bare-user keys used for phonebook lookups across LID/PN aliases. */
function jidLookupKeys(jid) {
  const keys = new Set();
  if (!jid) return keys;
  const raw = String(jid);
  keys.add(raw);
  const normalized = normalizeJid(raw);
  if (normalized) keys.add(normalized);
  const bare = raw.split(":")[0].split("@")[0];
  if (bare) keys.add(bare);
  if (normalized) {
    const bareNorm = normalized.split(":")[0].split("@")[0];
    if (bareNorm) keys.add(bareNorm);
  }
  // Device-suffix strip: 9198…:12@s.whatsapp.net → 9198…@s.whatsapp.net
  const deviceStripped = raw.replace(/:\d+@/, "@");
  if (deviceStripped && deviceStripped !== raw) keys.add(deviceStripped);
  if (bare && isPhoneJid(raw)) keys.add(`${bare}@s.whatsapp.net`);
  return keys;
}

/** Clean JID to pure phone number or group/user id (no device suffix, no domain). */
function cleanJid(jid) {
  if (!jid) return "";
  return String(jid).split(":")[0].split("@")[0];
}

/**
 * Minimal Baileys v7 replacement for makeInMemoryStore (removed upstream).
 * Keeps contacts + chats in sync via sock.ev so name lookups survive
 * contacts.upsert arriving after messages.upsert.
 */
function makeInMemoryStore(_config = {}) {
  const contacts = Object.create(null);
  const chatMap = new Map();

  const indexContact = (c) => {
    if (!c?.id) return;
    const id = normalizeJid(c.id) || String(c.id);
    const prev = contacts[id] || contacts[c.id] || {};
    const merged = mergeContactRecord(prev, c, id);
    contacts[id] = merged;
    contacts[c.id] = merged;
    const stripped = String(c.id).replace(/:\d+@/, "@");
    if (stripped) contacts[stripped] = merged;
    const bare = cleanJid(c.id);
    if (bare && isPhoneJid(id)) contacts[`${bare}@s.whatsapp.net`] = merged;
    if (c.phoneNumber) {
      const pn = normalizeJid(c.phoneNumber) || String(c.phoneNumber);
      contacts[pn] = merged;
      const pnBare = cleanJid(pn);
      if (pnBare) contacts[`${pnBare}@s.whatsapp.net`] = merged;
    }
    if (c.lid) {
      const lid = normalizeJid(c.lid) || String(c.lid);
      contacts[lid] = merged;
    }
  };

  const indexChat = (chat) => {
    if (!chat?.id) return;
    const id = normalizeJid(chat.id) || String(chat.id);
    const prev = chatMap.get(id) || chatMap.get(chat.id) || {};
    const merged = { ...prev, ...chat, id };
    chatMap.set(id, merged);
    chatMap.set(String(chat.id), merged);
  };

  return {
    contacts,
    chats: {
      get(id) {
        if (!id) return undefined;
        return chatMap.get(id) || chatMap.get(normalizeJid(id) || id);
      },
      set(id, value) {
        chatMap.set(id, value);
      },
      all() {
        return [...new Set(chatMap.values())];
      },
    },
    bind(ev) {
      if (!ev?.on) return;
      ev.on("contacts.upsert", (list) => {
        for (const c of list || []) indexContact(c);
      });
      ev.on("contacts.update", (list) => {
        for (const c of list || []) indexContact(c);
      });
      ev.on("contacts.set", (payload) => {
        for (const c of payload?.contacts || []) indexContact(c);
      });
      ev.on("chats.upsert", (list) => {
        for (const c of list || []) indexChat(c);
      });
      ev.on("chats.update", (list) => {
        for (const c of list || []) indexChat(c);
      });
      ev.on("messaging-history.set", ({ chats: chatList, contacts: contactList } = {}) => {
        for (const c of contactList || []) indexContact(c);
        for (const c of chatList || []) indexChat(c);
      });
    },
  };
}

function pickContactBookName(contactObj) {
  if (!contactObj) return "";
  for (const key of ["name", "notify", "verifiedName"]) {
    const value = contactObj[key];
    if (isUsableDisplayName(value)) return String(value).trim();
  }
  return "";
}

function coerceTimestampNumber(raw) {
  if (raw == null) return 0;
  if (typeof raw === "number") return raw;
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "null" || trimmed === "undefined") return 0;
    return Number(trimmed);
  }
  if (typeof raw === "object") {
    if (typeof raw.toNumber === "function") {
      try {
        return coerceTimestampNumber(raw.toNumber());
      } catch {
        /* fall through */
      }
    }
    if (typeof raw.valueOf === "function" && raw.valueOf !== Object.prototype.valueOf) {
      const v = raw.valueOf();
      if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") {
        return coerceTimestampNumber(v);
      }
    }
    if (typeof raw.low === "number") {
      const low = raw.low >>> 0;
      const high = (raw.high || 0) >>> 0;
      return high * 0x100000000 + low;
    }
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function unixFromMaybeLong(value) {
  const n = coerceTimestampNumber(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Normalize: 10-digit seconds → leave as seconds; 13-digit ms → seconds
  if (n < 10_000_000_000) return Math.floor(n);
  return Math.floor(n / 1000);
}

/** Message timestamp in unix milliseconds (handles sec/ms/Long/string). */
function messageTimestampMs(msg) {
  const n = coerceTimestampNumber(msg?.messageTimestamp);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Normalize: if < 1e10 (≈ year 2286 in seconds), treat as seconds
  if (n < 10_000_000_000) return Math.floor(n * 1000);
  return Math.floor(n);
}

function messageUnixSeconds(msg) {
  const ms = messageTimestampMs(msg);
  return ms ? Math.floor(ms / 1000) : 0;
}

/** Compact name-debug line for terminal tracing after scan. */
function contactDebugLabel(c) {
  if (!c) return "";
  const id = c.id || c.jid || "?";
  const name = c.name || "";
  const notify = c.notify || "";
  const verified = c.verifiedName || "";
  return `${id} | name="${name}" | notify="${notify}" | verified="${verified}"`;
}

function summarizeIncomingContacts(tag, contacts = []) {
  const list = Array.isArray(contacts) ? contacts : [];
  let withName = 0;
  let withNotify = 0;
  let withNeither = 0;
  const namedSamples = [];
  for (const c of list) {
    const hasName = isUsableDisplayName(c?.name) || isUsableDisplayName(c?.verifiedName);
    const hasNotify = isUsableDisplayName(c?.notify);
    if (hasName) {
      withName += 1;
      if (namedSamples.length < 8) namedSamples.push(contactDebugLabel(c));
    } else if (hasNotify) {
      withNotify += 1;
      if (namedSamples.length < 8) namedSamples.push(contactDebugLabel(c));
    } else {
      withNeither += 1;
    }
  }
  console.log(`🧪 [NAME-DEBUG ${tag}] total=${list.length} savedName=${withName} notify=${withNotify} noLabel=${withNeither}`);
  for (const line of namedSamples) {
    console.log(`   ✅ kept/seen label: ${line}`);
  }
  return { withName, withNotify, withNeither };
}

/**
 * Strict 10-day gatekeeper at messaging-history.set entry.
 * Messages/chats: only last 10 days.
 * Contacts: always pass through (no timestamp on address book — feed addressBookMap).
 */
function applyTenDayHistoryGatekeeper({
  chats = [],
  contacts = [],
  messages = [],
  lidPnMappings = [],
  sessionActiveJids = null,
} = {}) {
  const cutoffMs = Date.now() - TEN_DAYS_MS;

  const filteredMessages = (messages || []).filter((msg) => {
    const ts = messageTimestampMs(msg);
    return Boolean(ts && ts >= cutoffMs);
  });

  const activeJids = new Set();
  if (sessionActiveJids && typeof sessionActiveJids[Symbol.iterator] === "function") {
    for (const jid of sessionActiveJids) {
      if (jid) activeJids.add(jid);
    }
  }

  for (const msg of filteredMessages) {
    const remoteJid = normalizeJid(msg?.key?.remoteJid) || msg?.key?.remoteJid;
    if (remoteJid) activeJids.add(remoteJid);
    const participant =
      normalizeJid(msg?.key?.participant) || msg?.key?.participant || null;
    if (participant) activeJids.add(participant);
  }

  // Expand active set via LID↔phone pairs that touch a recent message JID.
  const filteredLidMappings = [];
  for (const map of lidPnMappings || []) {
    const lid = normalizeJid(map?.lid || map?.id) || map?.lid || map?.id;
    const pn = normalizeJid(map?.pn || map?.phoneNumber) || map?.pn || map?.phoneNumber;
    if (!lid && !pn) continue;
    if ((lid && activeJids.has(lid)) || (pn && activeJids.has(pn))) {
      filteredLidMappings.push(map);
      if (lid) activeJids.add(lid);
      if (pn) activeJids.add(pn);
    }
  }

  const filteredChats = (chats || []).filter((c) => {
    const chatId = normalizeJid(c?.id || c?.jid) || c?.id || c?.jid;
    if (!chatId) return false;
    if (activeJids.has(chatId)) return true;
    // Chat metadata may arrive without messages in the same batch — keep if
    // conversation timestamp itself is within the 10-day window.
    const tsSec = unixFromMaybeLong(
      c?.conversationTimestamp ?? c?.lastMsgTimestamp ?? c?.t
    );
    if (tsSec && tsSec * 1000 >= cutoffMs) {
      activeJids.add(chatId);
      return true;
    }
    return false;
  });

  // Contacts are never time-filtered — pass every received row into addressBookMap.
  const passedContacts = Array.isArray(contacts) ? contacts : [];
  let labeledCount = 0;
  let labeledInActive = 0;
  let labeledOutsideActive = 0;
  const labeledActiveSamples = [];
  const labeledOutsideSamples = [];

  for (const c of passedContacts) {
    const hasLabel =
      isUsableDisplayName(c?.name) ||
      isUsableDisplayName(c?.notify) ||
      isUsableDisplayName(c?.verifiedName);
    if (!hasLabel) continue;
    labeledCount += 1;
    const cId = normalizeJid(c?.id || c?.jid) || c?.id || c?.jid;
    const cLid = normalizeJid(c?.lid) || c?.lid || null;
    const inActive =
      (cId && activeJids.has(cId)) || (cLid && activeJids.has(cLid));
    if (inActive) {
      labeledInActive += 1;
      if (labeledActiveSamples.length < 6) {
        labeledActiveSamples.push(contactDebugLabel(c));
      }
    } else {
      labeledOutsideActive += 1;
      if (labeledOutsideSamples.length < 6) {
        labeledOutsideSamples.push(contactDebugLabel(c));
      }
    }
  }

  console.log(`🛡️ [10-DAY GATEKEEPER FIREWALL]`);
  console.log(
    `   Raw Messages: ${messages?.length || 0} -> Retained: ${filteredMessages.length}`
  );
  console.log(
    `   Raw Chats: ${chats?.length || 0} -> Active (Last 10 Days): ${filteredChats.length}`
  );
  console.log(
    `   Raw Contacts: ${contacts?.length || 0} -> Passed (unfiltered): ${passedContacts.length} | sessionActiveJids=${activeJids.size}`
  );
  console.log(
    `   Raw LID maps: ${lidPnMappings?.length || 0} -> Filtered: ${filteredLidMappings.length}`
  );
  console.log(
    `🧪 [NAME-DEBUG GATE] labeled=${labeledCount} in10dActive=${labeledInActive} outside10d(kept)=${labeledOutsideActive}`
  );
  for (const line of labeledActiveSamples) {
    console.log(`   ✅ NAME (10d active): ${line}`);
  }
  for (const line of labeledOutsideSamples) {
    console.log(`   📚 NAME (outside 10d, kept for addressBook): ${line}`);
  }

  return {
    chats: filteredChats,
    contacts: passedContacts,
    messages: filteredMessages,
    lidPnMappings: filteredLidMappings,
    activeJids,
    cutoffMs,
  };
}

/** Reject placeholder / stringified-null display labels. */
function isUsableDisplayName(name) {
  if (name == null) return false;
  const cleaned = String(name).trim();
  if (!cleaned) return false;
  const lower = cleaned.toLowerCase();
  if (
    lower === "null" ||
    lower === "undefined" ||
    lower === "unknown" ||
    lower === "unknown contact" ||
    lower === "whatsapp contact" ||
    lower === "contact" ||
    lower === "user"
  ) {
    return false;
  }
  if (isRawIdentifierLabel(cleaned)) return false;
  if (looksLikePhoneLabel(cleaned)) return false;
  return true;
}

function unwrapContent(msg) {
  try {
    return extractMessageContent(msg?.message) || msg?.message || null;
  } catch {
    return msg?.message || null;
  }
}

function extractMessageText(msg) {
  const raw = msg?.message || {};
  const m = unwrapContent(msg) || raw;
  const text =
    m.conversation ||
    raw.conversation ||
    m.extendedTextMessage?.text ||
    raw.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    raw.imageMessage?.caption ||
    m.videoMessage?.caption ||
    raw.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    "";
  if (text) return text;
  if (m.audioMessage || raw.audioMessage) return "[Voice Note]";
  if (m.imageMessage || raw.imageMessage) return "[Photo]";
  if (m.videoMessage || raw.videoMessage) return "[Video]";
  if (m.documentMessage || raw.documentMessage) return "[Document]";
  return "";
}

function isActionableUnresolvedText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.endsWith("?")) return true;
  const lower = t.toLowerCase();
  return ACTIONABLE_KEYWORDS.some((kw) => lower.includes(kw));
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function disposeSocket(sock) {
  if (!sock) return;
  try {
    sock.ev?.removeAllListeners?.();
  } catch {}
  try {
    sock.end?.(undefined);
  } catch {}
  try {
    sock.ws?.close?.();
  } catch {}
}

// -------------------------------------------------------------------------
// PER-TENANT ISOLATED ENGINE CLASS
// -------------------------------------------------------------------------
class TenantSession {
  constructor(tenantId) {
    this.tenantId = tenantId;
    this.authDir = path.join(BASE_AUTH_DIR, sanitizeTenantId(tenantId));
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }

    this.sockInstance = null;
    this.currentQRCodeDataUrl = null;
    this.isConnected = false;
    this.myJid = null;
    this.myLid = null;
    this.authLifecycle = "disconnected";

    if (!isValidTenantId(tenantId)) {
      console.warn(
        `[Tenant] Session created with invalid tenant_id="${tenantId}" — messages may be orphaned`
      );
    }

    this.currentProcessingChat = "Initializing WhatsApp snapshot...";
    this.totalChatsCount = 0;

    this.recentlySentBotIds = new Set();
    this.contactNameByJid = new Map();
    /** Full contact objects keyed by JID / LID for phonebook resolution. */
    this.addressBookMap = new Map();
    this.avatarUrlByJid = new Map();
    this.groupMetaByJid = new Map();
    this.lidToPhoneJid = new Map();
    this.avatarMissAt = new Map();
    // Baileys in-memory contact/chat store (v7-compatible local makeInMemoryStore)
    this.store = makeInMemoryStore({});

    this.lidRemapTimer = null;
    this.isSyncing = false;
    this.totalProcessed = 0;
    this.historyCompleted = false;
    this.isHistorySyncComplete = false;
    this.historyReadyNotified = false;
    this.syncIdleTimer = null;
    this.historyWatchdog = null;
    this.restartScheduled = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.lastAuthNotifyKey = null;
    this.lastAuthNotifyAt = 0;

    /** Post-scan pipeline: messages → media → contacts → names → selection_ready */
    this.syncPhase = "messages";
    this.selectionReady = false;
    this.historyQuiet = false;
    /** JIDs seen in gatekept 10-day messages/chats this sync — used to keep contact names. */
    this.activeTenDayJids = new Set();
    this.contactsSyncInFlight = 0;
    this.lastContactsSyncAt = 0;
    this.secondPhonebookPassDone = false;
    this.phonebookSyncStarted = false;
    this.phonebookSettled = false;
    this.phonebookSettleTimer = null;
    this.phonebookSettleTimeout = null;
    this.phonebookSettleInFlight = false;
    this.phonebookSettleRunCount = 0;
    this.lastSettledUsableContacts = -1;
    this.pendingFinalSettle = false;
    this.pendingReadyReason = null;
    this.phonebookNameHits = 0;
    this.phonebookNotifyHits = 0;
    this.selectionUnlockTimer = null;
    this.backgroundNameEnrichRuns = 0;
    this.backgroundNameEnrichTimer = null;
    this.backgroundNameEnrichInFlight = false;

    this.pendingAiDebounce = new Map();

    this.historyGroupCounts = new Map();
    this.historyTier1Chats = new Set();
    this.historyTier2Chats = new Set();
    this.historyKeptMessageIds = new Set();

    this.CONTACTS_FILE = path.join(this.authDir, "contacts_store.json");
    this.AVATARS_FILE = path.join(this.authDir, "avatars_store.json");

    this.loadSavedContacts();
    this.loadSavedAvatars();
    this.loadLidMappingsFromDisk();
  }

  /** Firebase UID used as tenant boundary for FastAPI / SQLite isolation. */
  logicalTenantId() {
    if (isValidTenantId(this.tenantId)) return this.tenantId;
    console.error(
      `[Tenant] Refusing to use WhatsApp JID as tenant — tenantId="${this.tenantId}" myJid="${this.myJid}"`
    );
    return this.tenantId || "default";
  }

  resetHistoryIngest() {
    this.historyGroupCounts.clear();
    this.historyTier1Chats.clear();
    this.historyTier2Chats.clear();
    this.historyKeptMessageIds.clear();
  }

  historyAlreadyKept(msg) {
    const id = msg?.key?.id;
    return Boolean(id && this.historyKeptMessageIds.has(String(id)));
  }

  markHistoryKept(messages) {
    for (const msg of messages || []) {
      const id = msg?.key?.id;
      if (id) this.historyKeptMessageIds.add(String(id));
    }
  }

  beginSync() {
    this.isSyncing = true;
    this.historyQuiet = false;
    // Never re-lock the selection desk once unlocked — later history batches
    // continue ingesting in the background while the UI stays on /settings.
    if (!this.selectionReady) {
      this.historyCompleted = false;
      this.setSyncPhase("messages");
    }
    if (this.syncIdleTimer) {
      clearTimeout(this.syncIdleTimer);
      this.syncIdleTimer = null;
    }
  }

  /**
   * Fast in-memory pass: map incoming pushName onto the chat/person JID.
   * 1-on-1 chats have no key.participant — use remoteJid. Skip fromMe so we
   * never stamp the owner's pushName onto the peer.
   */
  minePushNamesFromMessages(messages) {
    if (!Array.isArray(messages) || !messages.length) return 0;
    const total = messages.length;
    let mined = 0;
    let sampleLogged = 0;
    const minedContacts = [];

    console.log(
      `🔎 [PUSHNAME MINE ${this.tenantId}] Iterating ${total} raw history messages`
    );

    for (const msg of messages) {
      const fromMe = Boolean(msg?.key?.fromMe);
      const remoteRaw = msg?.key?.remoteJid || null;
      const participantRaw =
        msg?.key?.participantAlt || msg?.key?.participant || null;
      const pushName = msg?.pushName || msg?.verifiedBizName || null;

      // Direct chat samples (incoming only) — diagnose undefined participant
      const isDirect =
        remoteRaw &&
        !isGroupJid(remoteRaw) &&
        remoteRaw !== "status@broadcast" &&
        !String(remoteRaw).endsWith("@broadcast");
      if (!fromMe && isDirect && sampleLogged < 10) {
        console.log(
          `🔎 [PUSHNAME SAMPLE ${sampleLogged}] ` +
            `remoteJid=${remoteRaw} participant=${participantRaw} ` +
            `pushName=${JSON.stringify(pushName)} fromMe=${fromMe}`
        );
        sampleLogged += 1;
      }

      // Only mine incoming messages
      if (fromMe) continue;
      if (!isUsableDisplayName(pushName)) continue;

      // Groups: participant; 1-on-1: participant is undefined → remoteJid
      const jidRaw = participantRaw || remoteRaw;
      if (!jidRaw || jidRaw === "status@broadcast" || String(jidRaw).endsWith("@broadcast")) {
        continue;
      }

      const jid = normalizeJid(jidRaw) || jidRaw;
      const label = String(pushName).trim();
      const digits = String(jid).split("@")[0].replace(/\D/g, "");
      const phoneJid =
        looksLikePhoneDigits(digits) ? `${digits}@s.whatsapp.net` : null;

      const contact = {
        id: jid,
        notify: label,
        name: null,
        phoneNumber: phoneJid || undefined,
      };
      this.applyAddressBookContact(contact);

      // Digit-only aliases so Selection Desk / SQLite lookups ignore formatting
      const book = this.addressBookMap.get(jid) || contact;
      if (digits && digits.length >= 10) {
        this.addressBookMap.set(digits, book);
        if (phoneJid) this.addressBookMap.set(phoneJid, book);
        const last10 = digits.slice(-10);
        if (last10.length === 10) {
          this.addressBookMap.set(last10, book);
          this.addressBookMap.set(`91${last10}`, book);
          this.addressBookMap.set(`${last10}@s.whatsapp.net`, book);
          this.addressBookMap.set(`91${last10}@s.whatsapp.net`, book);
        }
        if (isUsableDisplayName(label)) {
          this.contactNameByJid.set(digits, label);
          this.contactNameByJid.set(jid, label);
          if (phoneJid) this.contactNameByJid.set(phoneJid, label);
        }
      }

      minedContacts.push(contact);
      mined += 1;
    }

    console.log(
      `⚡ [PUSHNAME MINE ${this.tenantId}] Bound ${mined}/${total} incoming pushName hits ` +
        `(samplesLogged=${sampleLogged})`
    );

    // Persist notify_name into FastAPI contacts so Selection Desk can resolve
    if (minedContacts.length) {
      this.syncContactsToBackend(minedContacts).catch((err) =>
        console.error(
          `❌ [PUSHNAME SYNC ${this.tenantId}]`,
          err?.message || err
        )
      );
    }
    return mined;
  }

  /**
   * Unlock Selection Desk immediately after 10-day filter + name mining.
   * Does not wait for phonebook debounce / settle loops.
   */
  markSelectionReadyFast(reason = "history-fast") {
    if (this.selectionReady) return;
    this.isHistorySyncComplete = true;
    this.historyQuiet = true;
    this.historyCompleted = true;
    this.isSyncing = false;
    this.authLifecycle = "ready";
    this.currentProcessingChat = "Sync Complete — Ready for Selection";
    this.setSyncPhase("ready");
    console.log(
      `⚡ [SELECTION READY FAST ${this.tenantId}] reason=${reason} — unlocking without settle wait`
    );
    this.markSelectionReadyFromSettle(reason);
    // Names often arrive via app-state after unlock — backfill once/twice, capped.
    this.scheduleBackgroundNameEnrichment(BACKGROUND_NAME_ENRICH_DEBOUNCE_MS);
  }

  setSyncPhase(phase) {
    if (!phase || this.syncPhase === phase) {
      if (phase && SYNC_PHASE_LABELS[phase] && !this.selectionReady) {
        this.currentProcessingChat = SYNC_PHASE_LABELS[phase];
      }
      return;
    }
    // Never regress once selection is unlocked.
    if (this.selectionReady && phase !== "ready") return;
    const order = ["messages", "media", "contacts", "names", "ready"];
    const cur = order.indexOf(this.syncPhase);
    const next = order.indexOf(phase);
    if (cur >= 0 && next >= 0 && next < cur && phase !== "ready") return;
    this.syncPhase = phase;
    this.currentProcessingChat = SYNC_PHASE_LABELS[phase] || this.currentProcessingChat;
    console.log(`🔄 [SYNC PHASE ${this.tenantId}] → ${phase}`);
  }

  /**
   * Reconnect can wipe selectionReady while leaving the "Ready for Selection"
   * label + history counters intact. Re-latch so the Setup UI can unlock.
   */
  ensureSelectionReadyLatch(reason = "self-heal") {
    if (this.selectionReady) return true;
    const label = String(this.currentProcessingChat || "");
    const audited = auditedContactCount(this.logicalTenantId());
    const processed = Number(this.totalProcessed || 0);
    const looksReady =
      this.historyReadyNotified ||
      /ready for selection/i.test(label) ||
      ((this.historyCompleted || this.isHistorySyncComplete) &&
        (processed >= 50 || audited >= RECENT_CONTACT_LIMIT));
    if (!looksReady) return false;

    console.log(
      `🩹 [SELF-HEAL ${this.tenantId}] Re-latching selection_ready (${reason}) ` +
        `| processed=${processed} audited=${audited}`
    );
    this.isHistorySyncComplete = true;
    this.historyCompleted = true;
    this.historyQuiet = true;
    this.isSyncing = false;
    this.authLifecycle = "ready";
    this.syncPhase = "ready";
    this.currentProcessingChat = SYNC_PHASE_LABELS.ready;
    this.markSelectionReadyFromSettle(reason);
    return true;
  }

  buildSyncStatusFields() {
    this.ensureSelectionReadyLatch("status-poll");
    return {
      sync_phase: this.selectionReady ? "ready" : this.syncPhase,
      phonebook_settled: Boolean(this.phonebookSettled),
      selection_ready: Boolean(this.selectionReady),
      phonebook_names: Number(this.phonebookNameHits || 0),
      notify_names: Number(this.phonebookNotifyHits || 0),
      contacts_sync_in_flight: Number(this.contactsSyncInFlight || 0),
    };
  }

  loadSavedContacts() {
    try {
      if (fs.existsSync(this.CONTACTS_FILE)) {
        const raw = fs.readFileSync(this.CONTACTS_FILE, "utf-8");
        const obj = JSON.parse(raw);
        for (const [jid, name] of Object.entries(obj)) {
          if (!isUsableDisplayName(name)) continue;
          this.contactNameByJid.set(jid, name);
        }
        console.log(`[Cache ${this.tenantId}] ${this.contactNameByJid.size} contacts disk se load hue.`);
      }
    } catch (err) {
      console.error(`[Cache Load Error ${this.tenantId}]`, err.message);
    }
  }

  persistContacts() {
    try {
      const obj = Object.fromEntries(this.contactNameByJid.entries());
      fs.writeFileSync(this.CONTACTS_FILE, JSON.stringify(obj, null, 2), "utf-8");
    } catch (err) {
      console.error(`[Cache Save Error ${this.tenantId}]`, err.message);
    }
  }

  loadSavedAvatars() {
    try {
      if (fs.existsSync(this.AVATARS_FILE)) {
        const obj = JSON.parse(fs.readFileSync(this.AVATARS_FILE, "utf-8"));
        for (const [jid, url] of Object.entries(obj)) {
          if (url) this.avatarUrlByJid.set(jid, url);
        }
        console.log(`[Cache ${this.tenantId}] ${this.avatarUrlByJid.size} avatar URLs disk se load hue.`);
      }
    } catch (err) {
      console.error(`[Avatar Cache Load Error ${this.tenantId}]`, err.message);
    }
  }

  persistAvatars() {
    try {
      const obj = Object.fromEntries(this.avatarUrlByJid.entries());
      fs.writeFileSync(this.AVATARS_FILE, JSON.stringify(obj, null, 2), "utf-8");
    } catch (err) {
      console.error(`[Avatar Cache Save Error ${this.tenantId}]`, err.message);
    }
  }

  rememberLidPair(lid, pn) {
    const lidNorm = normalizeJid(lid);
    const pnNorm = normalizeJid(pn);
    if (!isLidJid(lidNorm) || !isPhoneJid(pnNorm)) return;
    this.lidToPhoneJid.set(lidNorm, pnNorm);
    const name =
      this.contactNameByJid.get(pnNorm) ||
      this.contactNameByJid.get(lidNorm) ||
      null;
    if (name) {
      this.contactNameByJid.set(lidNorm, name);
      this.contactNameByJid.set(pnNorm, name);
    }
  }

  loadLidMappingsFromDisk() {
    try {
      if (!fs.existsSync(this.authDir)) return 0;
      const before = this.lidToPhoneJid.size;
      for (const name of fs.readdirSync(this.authDir)) {
        const reverse = name.match(/^lid-mapping-(\d+)_reverse\.json$/);
        if (reverse) {
          const pnUser = JSON.parse(
            fs.readFileSync(path.join(this.authDir, name), "utf-8")
          );
          const digits = String(pnUser ?? "").replace(/\D/g, "");
          if (digits) this.rememberLidPair(`${reverse[1]}@lid`, `${digits}@s.whatsapp.net`);
          continue;
        }
        const forward = name.match(/^lid-mapping-(\d+)\.json$/);
        if (forward) {
          const lidUser = JSON.parse(
            fs.readFileSync(path.join(this.authDir, name), "utf-8")
          );
          const digits = String(lidUser ?? "").replace(/\D/g, "");
          if (digits) this.rememberLidPair(`${digits}@lid`, `${forward[1]}@s.whatsapp.net`);
        }
      }
      const added = this.lidToPhoneJid.size - before;
      if (this.lidToPhoneJid.size) {
        console.log(`[LID ${this.tenantId}] ${this.lidToPhoneJid.size} LID->phone mappings ready.`);
      }
      return added;
    } catch (err) {
      console.error(`[LID ${this.tenantId}] disk map load failed:`, err.message);
      return 0;
    }
  }

  deriveAuthState() {
    // User-facing ready only after contacts + name mapping settle.
    if (this.selectionReady) return "ready";
    // Explicit unpaired / replaced lifecycle must never report as syncing loader.
    if (
      this.authLifecycle === "disconnected" &&
      !this.isConnected &&
      !this.sockInstance
    ) {
      if (this.currentQRCodeDataUrl) return "qr_ready";
      return "disconnected";
    }
    // Latch: once we have entered syncing (or are mid-ingest), never flash QR
    // during temporary Baileys re-handshake drops.
    if (
      this.isHistorySyncComplete ||
      this.isConnected ||
      this.isSyncing ||
      this.authLifecycle === "syncing" ||
      this.authLifecycle === "connected" ||
      this.authLifecycle === "ready"
    ) {
      return "syncing";
    }
    if (this.currentQRCodeDataUrl || this.authLifecycle === "qr_ready") {
      return "qr_ready";
    }
    return "disconnected";
  }

  /** True once we have latched past the QR stage for this session. */
  isPastQrStage() {
    return (
      this.isHistorySyncComplete ||
      this.isConnected ||
      this.isSyncing ||
      this.authLifecycle === "syncing" ||
      this.authLifecycle === "connected" ||
      this.authLifecycle === "ready"
    );
  }

  /**
   * Internal progress when 15 unique audited chats are on the reel.
   * Does NOT unlock the selection desk — contacts/names must still settle.
   */
  maybeCompleteFromAuditedContacts(reason = "audited-15") {
    const count = auditedContactCount(this.logicalTenantId());
    if (count >= RECENT_CONTACT_LIMIT && !this.isHistorySyncComplete) {
      this.historyCompleted = true;
      this.setSyncPhase("contacts");
      if (this.syncIdleTimer) {
        clearTimeout(this.syncIdleTimer);
        this.syncIdleTimer = null;
      }
      this.markHistorySyncComplete(reason);
      return true;
    }
    return false;
  }

  clearSessionCaches() {
    clearRecentContacts(this.tenantId);
    clearRecentContacts(this.logicalTenantId());
    this.contactNameByJid.clear();
    this.addressBookMap.clear();
    this.avatarUrlByJid.clear();
    this.groupMetaByJid.clear();
    this.lidToPhoneJid.clear();
    this.avatarMissAt.clear();
    this.store = makeInMemoryStore({});
    this.recentlySentBotIds.clear();
    for (const timer of this.pendingAiDebounce.values()) {
      clearTimeout(timer);
    }
    this.pendingAiDebounce.clear();
    if (this.phonebookSettleTimer) {
      clearTimeout(this.phonebookSettleTimer);
      this.phonebookSettleTimer = null;
    }
    if (this.phonebookSettleTimeout) {
      clearTimeout(this.phonebookSettleTimeout);
      this.phonebookSettleTimeout = null;
    }
    if (this.selectionUnlockTimer) {
      clearTimeout(this.selectionUnlockTimer);
      this.selectionUnlockTimer = null;
    }
    if (this.backgroundNameEnrichTimer) {
      clearTimeout(this.backgroundNameEnrichTimer);
      this.backgroundNameEnrichTimer = null;
    }
    this.backgroundNameEnrichRuns = 0;
    this.backgroundNameEnrichInFlight = false;
    this.syncPhase = "messages";
    this.selectionReady = false;
    this.historyQuiet = false;
    this.contactsSyncInFlight = 0;
    this.lastContactsSyncAt = 0;
    this.secondPhonebookPassDone = false;
    this.phonebookSyncStarted = false;
    this.phonebookSettled = false;
    this.phonebookSettleInFlight = false;
    this.phonebookSettleRunCount = 0;
    this.lastSettledUsableContacts = -1;
    this.pendingFinalSettle = false;
    this.pendingReadyReason = null;
    this.phonebookNameHits = 0;
    this.phonebookNotifyHits = 0;
    this.activeTenDayJids = new Set();
    this.isConnected = false;
    this.authLifecycle = "disconnected";
    this.myJid = null;
    this.myLid = null;
    try {
      if (fs.existsSync(this.CONTACTS_FILE)) fs.unlinkSync(this.CONTACTS_FILE);
    } catch {}
    try {
      if (fs.existsSync(this.AVATARS_FILE)) fs.unlinkSync(this.AVATARS_FILE);
    } catch {}
  }

  clearAuthFolder() {
    this.clearSessionCaches();
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (!fs.existsSync(this.authDir)) {
          console.log(`🧹 auth_sessions for ${this.tenantId} already gone`);
          return true;
        }

        const entries = fs.readdirSync(this.authDir);
        for (const name of entries) {
          const full = path.join(this.authDir, name);
          try {
            fs.rmSync(full, { recursive: true, force: true });
          } catch (fileErr) {
            console.log(`[Auth clear ${this.tenantId}] skip ${name}: ${fileErr.message}`);
          }
        }

        fs.rmSync(this.authDir, { recursive: true, force: true });

        if (!fs.existsSync(this.authDir)) {
          console.log(`🧹 Cleared auth_sessions for ${this.tenantId}`);
          return true;
        }
      } catch (err) {
        console.error(`[Auth clear ${this.tenantId}] attempt ${attempt}: ${err.message}`);
      }

      try {
        if (fs.existsSync(this.authDir)) {
          const trash = `${this.authDir}_trash_${Date.now()}`;
          fs.renameSync(this.authDir, trash);
          console.log(`🧹 Renamed locked auth_sessions -> ${path.basename(trash)}`);
          setTimeout(() => {
            try {
              fs.rmSync(trash, { recursive: true, force: true });
            } catch {}
          }, 5000);
          return true;
        }
      } catch (renameErr) {
        console.error(`[Auth clear ${this.tenantId}] rename failed: ${renameErr.message}`);
      }

      sleepSync(300 * attempt);
    }

    console.error(`⚠️ Could not fully clear auth_sessions for ${this.tenantId}`);
    return false;
  }

  async notifyAuthStatus(status, extra = {}) {
    // Stale guest / phone-jid sessions must not hammer FastAPI during history sync.
    if (
      String(this.tenantId || "").startsWith("guest_") ||
      /^\d{10,15}(_s_whatsapp_net)?$/.test(String(this.tenantId || ""))
    ) {
      return;
    }
    const normalized =
      status === "authenticated" || status === "ready" || status === "open"
        ? "connected"
        : status === "unpaired"
        ? "disconnected"
        : status;
    // Never regress a latched syncing/connected lifecycle back to qr/disconnected
    // via status webhooks during temporary re-handshake noise.
    if (
      normalized === "connected" ||
      normalized === "syncing" ||
      normalized === "qr_ready" ||
      normalized === "disconnected"
    ) {
      const latched = this.isPastQrStage();
      if (
        latched &&
        (normalized === "qr_ready" || normalized === "disconnected") &&
        !extra.forceLifecycle
      ) {
        // keep existing authLifecycle
      } else if (this.selectionReady && (normalized === "connected" || status === "ready")) {
        this.authLifecycle = "ready";
      } else {
        this.authLifecycle = normalized === "connected" && !this.isHistorySyncComplete
          ? "syncing"
          : normalized;
      }
    }

    // Collapse reconnect storms: identical status+state must not spam FastAPI.
    const notifyKey = `${status}|${this.authLifecycle}|${Boolean(this.currentQRCodeDataUrl)}`;
    const now = Date.now();
    if (
      !extra.forceNotify &&
      this.lastAuthNotifyKey === notifyKey &&
      now - this.lastAuthNotifyAt < AUTH_STATUS_DEDUPE_MS
    ) {
      return;
    }
    this.lastAuthNotifyKey = notifyKey;
    this.lastAuthNotifyAt = now;

    const currentSessionTenantId = this.logicalTenantId();
    const payload = {
      tenant_id: currentSessionTenantId,
      tenant_jid: currentSessionTenantId,
      status,
      state: this.authLifecycle,
      connected: this.isConnected,
      unpaired: status === "unpaired" || status === "disconnected",
      has_qr: Boolean(this.currentQRCodeDataUrl),
      jid: this.myJid,
      phone_jid: this.myJid,
      isHistorySyncComplete: this.isHistorySyncComplete,
      historyCompleted: this.historyCompleted,
      ...extra,
    };
    // Never let callers override tenant with sock.user.id / phone JID
    payload.tenant_id = currentSessionTenantId;
    payload.tenant_jid = currentSessionTenantId;
    try {
      await axios.post(FASTAPI_AUTH_STATUS_URL, payload, { timeout: 4000 });
      console.log(`[Auth Status ${this.tenantId}] → FastAPI: ${status} (state=${this.authLifecycle})`);
    } catch (err) {
      console.log(`[Auth Status ${this.tenantId}] FastAPI notify failed: ${err.message}`);
    }
  }

  /** Notify FastAPI of Firebase UID ↔ WhatsApp phone JID mapping + heal orphans. */
  async linkTenantToPhoneJid() {
    const currentSessionTenantId = this.logicalTenantId();
    if (!isValidTenantId(currentSessionTenantId) || !this.myJid) {
      console.warn(
        `[Tenant Link ${this.tenantId}] skipped — tenant="${currentSessionTenantId}" phone="${this.myJid}"`
      );
      return;
    }
    try {
      const res = await axios.post(
        FASTAPI_LINK_TENANT_URL,
        {
          tenant_id: currentSessionTenantId,
          tenant_jid: currentSessionTenantId,
          phone_jid: this.myJid,
          jid: this.myJid,
          status: "connected",
          isHistorySyncComplete: this.isHistorySyncComplete,
        },
        { timeout: 8000 }
      );
      const relinked = res.data?.relinked?.updated || 0;
      console.log(
        `[Tenant Link ${this.tenantId}] mapped ${currentSessionTenantId} ↔ ${this.myJid}` +
          (relinked ? ` (healed ${relinked} orphan messages)` : "")
      );
    } catch (err) {
      console.log(`[Tenant Link ${this.tenantId}] failed: ${err.message}`);
    }
  }

  wipeAuthDirectories() {
    const targets = [
      this.authDir,
      ...LEGACY_AUTH_DIRS.map((name) => path.join(process.cwd(), name)),
    ];
    let wiped = true;
    for (const authPath of targets) {
      try {
        if (fs.existsSync(authPath)) {
          fs.rmSync(authPath, { recursive: true, force: true });
          console.log(`🧹 Removed ${path.basename(authPath)}`);
        }
      } catch (err) {
        wiped = false;
        console.error(`[Auth wipe] ${path.basename(authPath)}: ${err.message}`);
      }
    }
    if (!wiped) {
      return this.clearAuthFolder();
    }
    return !fs.existsSync(this.authDir);
  }

  markHistorySyncComplete(reason) {
    this.isHistorySyncComplete = true;
    this.historyQuiet = true;
    this.pendingReadyReason = reason || "history";
    this.setSyncPhase("contacts");
    console.log(
      `[Worker ${this.tenantId}] history complete (${reason}) — waiting for contacts + name mapping`
    );

    // Second app-state pass after history quiet (names often arrive late).
    this.forcePhonebookAppStateSync({ allowSecondPass: true }).catch((err) =>
      console.log(`[PHONEBOOK ${this.tenantId}] ${err.message}`)
    );

    this.schedulePhonebookSettle(PHONEBOOK_SETTLE_DEBOUNCE_MS);
    this.scheduleSelectionUnlockCheck(CONTACT_SYNC_QUIET_MS);

    if (!this.phonebookSettleTimeout) {
      this.phonebookSettleTimeout = setTimeout(() => {
        this.phonebookSettleTimeout = null;
        console.log(
          `⏰ [PHONEBOOK ${this.tenantId}] Hard timeout — final settle + unlock selection`
        );
        this.pendingFinalSettle = true;
        this.settlePhonebookNames("timeout", { final: true }).catch((err) =>
          console.error(`[PHONEBOOK settle ${this.tenantId}]`, err.message)
        );
      }, PHONEBOOK_SETTLE_TIMEOUT_MS);
    }
  }

  contactsPipelineQuiet() {
    if (this.contactsSyncInFlight > 0) return false;
    if (!this.lastContactsSyncAt) return this.historyQuiet;
    return Date.now() - this.lastContactsSyncAt >= CONTACT_SYNC_QUIET_MS;
  }

  scheduleSelectionUnlockCheck(delayMs = CONTACT_SYNC_QUIET_MS) {
    if (this.selectionReady) return;
    if (this.selectionUnlockTimer) clearTimeout(this.selectionUnlockTimer);
    this.selectionUnlockTimer = setTimeout(() => {
      this.selectionUnlockTimer = null;
      this.tryUnlockSelectionReady("quiet-check").catch((err) =>
        console.error(`[Selection unlock ${this.tenantId}]`, err.message)
      );
    }, delayMs);
  }

  async tryUnlockSelectionReady(reason = "unlock") {
    if (this.selectionReady) return true;
    if (!this.isHistorySyncComplete) return false;

    if (!this.contactsPipelineQuiet() && reason !== "timeout") {
      this.setSyncPhase("contacts");
      this.scheduleSelectionUnlockCheck(CONTACT_SYNC_QUIET_MS);
      return false;
    }

    this.setSyncPhase("names");
    await this.settlePhonebookNames(reason, { final: true });
    return this.selectionReady;
  }

  flushPendingReady() {
    if (!this.isHistorySyncComplete || this.historyReadyNotified) return;
    if (!this.phonebookSettled || !this.selectionReady) return;
    this.historyReadyNotified = true;
    this.isSyncing = false;
    this.historyCompleted = true;
    this.authLifecycle = "ready";
    this.setSyncPhase("ready");
    const reason = this.pendingReadyReason || "ready";
    console.log(
      `✅ [READY ${this.tenantId}] Selection desk unlocked (${reason}) | ` +
        `phonebookNames=${this.phonebookNameHits} notifyNames=${this.phonebookNotifyHits}`
    );
    this.notifyAuthStatus("ready", {
      tenant_jid: this.logicalTenantId(),
      authenticated: true,
      contacts_count: this.contactNameByJid.size,
      phonebook_names: this.phonebookNameHits,
      notify_names: this.phonebookNotifyHits,
      jid: this.myJid,
      isHistorySyncComplete: true,
      phonebook_settled: true,
      selection_ready: true,
      sync_phase: "ready",
      forceLifecycle: true,
    }).catch((err) => console.log(`[Ready ${this.tenantId}] notify failed: ${err.message}`));

    if (this.sockInstance) {
      this.backfillInboxAvatars().catch((err) =>
        console.log(`[Avatar ${this.tenantId}] backfill failed: ${err.message}`)
      );
    }
  }

  /**
   * Force WhatsApp address-book sync (saved contact names live in critical_unblock_low).
   * History sync alone usually only brings notify / LID stubs.
   */
  async forcePhonebookAppStateSync({ allowSecondPass = false } = {}) {
    const sock = this.sockInstance;
    if (!sock || typeof sock.resyncAppState !== "function") {
      console.log(`[PHONEBOOK ${this.tenantId}] resyncAppState unavailable on socket`);
      this.schedulePhonebookSettle(1000);
      return;
    }
    if (this.phonebookSyncStarted && !(allowSecondPass && !this.secondPhonebookPassDone)) {
      return;
    }
    if (this.phonebookSyncStarted && allowSecondPass) {
      this.secondPhonebookPassDone = true;
    }
    this.phonebookSyncStarted = true;
    this.setSyncPhase("contacts");
    try {
      console.log(
        `\n📇 [PHONEBOOK ${this.tenantId}] Forcing app-state sync: critical_unblock_low (saved names)...`
      );
      await sock.resyncAppState(["critical_unblock_low"], true);
      console.log(
        `📇 [PHONEBOOK ${this.tenantId}] App-state sync done. ` +
          `addressBook=${this.addressBookMap.size} namedHits=${this.phonebookNameHits}`
      );
    } catch (err) {
      console.error(`❌ [PHONEBOOK ${this.tenantId}] App-state sync failed: ${err.message}`);
    }
    // Pre-ready: normal settle. Post-ready: capped background enrich (via schedulePhonebookSettle).
    this.schedulePhonebookSettle(PHONEBOOK_SETTLE_DEBOUNCE_MS);
    if (!this.selectionReady) {
      this.scheduleSelectionUnlockCheck(CONTACT_SYNC_QUIET_MS);
    }
  }

  notePhonebookContact(contact) {
    if (!contact) return;
    if (isUsableDisplayName(contact.name) || isUsableDisplayName(contact.verifiedName)) {
      this.phonebookNameHits += 1;
    } else if (isUsableDisplayName(contact.notify)) {
      this.phonebookNotifyHits += 1;
    }
  }

  schedulePhonebookSettle(delayMs = PHONEBOOK_SETTLE_DEBOUNCE_MS, { final = false } = {}) {
    // Desk already open → do not block UX; run a capped background name backfill instead.
    if (this.selectionReady) {
      this.scheduleBackgroundNameEnrichment(delayMs);
      return;
    }
    if (final) this.pendingFinalSettle = true;

    // Cap infinite debounce: further non-final schedules become final.
    if (
      !final &&
      !this.pendingFinalSettle &&
      this.phonebookSettleRunCount >= PHONEBOOK_SETTLE_MAX_RUNS
    ) {
      console.log(
        `🛑 [PHONEBOOK SETTLE ${this.tenantId}] Max settle limit reached ` +
          `(${this.phonebookSettleRunCount}). Forcing final ready.`
      );
      this.pendingFinalSettle = true;
      final = true;
    }

    if (this.phonebookSettleTimer) clearTimeout(this.phonebookSettleTimer);
    const runFinal = Boolean(final || this.pendingFinalSettle);
    const waitMs = runFinal ? Math.min(delayMs, 200) : delayMs;
    this.phonebookSettleTimer = setTimeout(() => {
      this.phonebookSettleTimer = null;
      const isFinal = Boolean(this.pendingFinalSettle || runFinal);
      this.settlePhonebookNames(isFinal ? "final" : "debounce", { final: isFinal }).catch(
        (err) => console.error(`[PHONEBOOK settle ${this.tenantId}]`, err.message)
      );
    }, waitMs);
  }

  collectAddressBookContactsForSync() {
    const byId = new Map();
    for (const contact of this.addressBookMap.values()) {
      if (!contact?.id) continue;
      const key = normalizeJid(contact.id) || contact.id;
      const prev = byId.get(key);
      if (!prev) {
        byId.set(key, contact);
        continue;
      }
      // Prefer the record that carries a real phonebook name.
      if (isUsableDisplayName(contact.name) && !isUsableDisplayName(prev.name)) {
        byId.set(key, contact);
      }
    }
    return [...byId.values()].filter(
      (c) =>
        isUsableDisplayName(c.name) ||
        isUsableDisplayName(c.notify) ||
        isUsableDisplayName(c.verifiedName)
    );
  }

  scheduleBackgroundNameEnrichment(delayMs = BACKGROUND_NAME_ENRICH_DEBOUNCE_MS) {
    if (this.backgroundNameEnrichRuns >= BACKGROUND_NAME_ENRICH_MAX_RUNS) return;
    if (this.backgroundNameEnrichTimer) clearTimeout(this.backgroundNameEnrichTimer);
    const waitMs = Math.max(500, Number(delayMs) || BACKGROUND_NAME_ENRICH_DEBOUNCE_MS);
    this.backgroundNameEnrichTimer = setTimeout(() => {
      this.backgroundNameEnrichTimer = null;
      this.enrichContactNamesInBackground("post-ready").catch((err) =>
        console.error(`[NAME ENRICH ${this.tenantId}]`, err.message)
      );
    }, waitMs);
  }

  /**
   * After Selection Desk unlock: push any late phonebook names + settle weak
   * +91 labels. Capped to BACKGROUND_NAME_ENRICH_MAX_RUNS — no UI wait, no loop.
   */
  async enrichContactNamesInBackground(reason = "post-ready") {
    if (this.backgroundNameEnrichInFlight) {
      this.scheduleBackgroundNameEnrichment(1500);
      return;
    }
    if (this.backgroundNameEnrichRuns >= BACKGROUND_NAME_ENRICH_MAX_RUNS) return;

    this.backgroundNameEnrichInFlight = true;
    this.backgroundNameEnrichRuns += 1;
    const run = this.backgroundNameEnrichRuns;
    try {
      const contacts = this.collectAddressBookContactsForSync();
      console.log(
        `\n🩹 [NAME ENRICH ${this.tenantId}] reason=${reason} ` +
          `run=${run}/${BACKGROUND_NAME_ENRICH_MAX_RUNS} usableContacts=${contacts.length} ` +
          `namedHits=${this.phonebookNameHits}`
      );

      if (contacts.length > 0) {
        await this.syncContactsToBackend(contacts, { fromSettle: true });
      }

      const tenantId = this.logicalTenantId();
      const res = await axios.post(
        FASTAPI_SETTLE_NAMES_URL,
        { tenant_id: tenantId, tenant_jid: tenantId },
        { timeout: 30000 }
      );
      console.log(
        `✅ [NAME ENRICH ${this.tenantId}] FastAPI:`,
        JSON.stringify(res.data || {}).slice(0, 240)
      );

      // One optional follow-up if more phonebook names arrived during this pass.
      if (
        run < BACKGROUND_NAME_ENRICH_MAX_RUNS &&
        contacts.length > 0 &&
        contacts.length !== this.lastSettledUsableContacts
      ) {
        this.lastSettledUsableContacts = contacts.length;
        this.scheduleBackgroundNameEnrichment(BACKGROUND_NAME_ENRICH_DEBOUNCE_MS);
      } else {
        this.lastSettledUsableContacts = contacts.length;
        this.phonebookSettled = true;
      }
    } catch (err) {
      console.error(`❌ [NAME ENRICH ${this.tenantId}] ${err.message}`);
    } finally {
      this.backgroundNameEnrichInFlight = false;
    }
  }

  markSelectionReadyFromSettle(reason = "settle") {
    if (this.selectionReady) return;
    this.phonebookSettled = true;
    this.selectionReady = true;
    this.pendingFinalSettle = false;
    if (this.phonebookSettleTimer) {
      clearTimeout(this.phonebookSettleTimer);
      this.phonebookSettleTimer = null;
    }
    if (this.phonebookSettleTimeout) {
      clearTimeout(this.phonebookSettleTimeout);
      this.phonebookSettleTimeout = null;
    }
    if (this.selectionUnlockTimer) {
      clearTimeout(this.selectionUnlockTimer);
      this.selectionUnlockTimer = null;
    }
    // Keep backgroundNameEnrichTimer — late phonebook names still need a pass.
    this.pendingReadyReason = reason || this.pendingReadyReason || "ready";
    console.log(
      `🏁 [PHONEBOOK SETTLE COMPLETE ${this.tenantId}] reason=${reason} — selection READY`
    );
    this.flushPendingReady();
  }

  async settlePhonebookNames(reason = "settle", { final = false } = {}) {
    if (this.selectionReady) {
      this.scheduleBackgroundNameEnrichment(500);
      return;
    }
    if (this.phonebookSettleInFlight) {
      // Preserve final intent — do not downgrade timeout/final into another debounce.
      this.schedulePhonebookSettle(1500, { final });
      return;
    }

    // Force terminal after max intermediate runs or when caller asked for final.
    if (
      final ||
      this.pendingFinalSettle ||
      this.phonebookSettleRunCount >= PHONEBOOK_SETTLE_MAX_RUNS ||
      reason === "timeout"
    ) {
      final = true;
      this.pendingFinalSettle = true;
    }

    // Final unlock prefers quiet contacts, but timeout / max-runs always proceed.
    if (
      final &&
      reason !== "timeout" &&
      this.phonebookSettleRunCount < PHONEBOOK_SETTLE_MAX_RUNS &&
      !this.contactsPipelineQuiet() &&
      this.contactsSyncInFlight > 0
    ) {
      this.setSyncPhase("contacts");
      this.schedulePhonebookSettle(CONTACT_SYNC_QUIET_MS, { final: true });
      return;
    }

    this.phonebookSettleInFlight = true;
    this.phonebookSettleRunCount += 1;
    this.setSyncPhase("names");
    try {
      const contacts = this.collectAddressBookContactsForSync();
      const usableCount = contacts.length;
      const contactsUnchanged =
        this.lastSettledUsableContacts >= 0 &&
        usableCount === this.lastSettledUsableContacts;

      // Dirty check: no new usable contacts since last settle → finalize (no loop).
      if (!final && contactsUnchanged && this.phonebookSettleRunCount > 1) {
        console.log(
          `ℹ️ [PHONEBOOK SETTLE ${this.tenantId}] Contacts unchanged ` +
            `(${usableCount}). Finalizing.`
        );
        final = true;
        this.pendingFinalSettle = true;
      }

      // Cap: treat this run as final even if still "debounce".
      if (!final && this.phonebookSettleRunCount >= PHONEBOOK_SETTLE_MAX_RUNS) {
        console.log(
          `🛑 [PHONEBOOK SETTLE ${this.tenantId}] Max settle runs ` +
            `(${this.phonebookSettleRunCount}). Forcing final.`
        );
        final = true;
        this.pendingFinalSettle = true;
      }

      console.log(
        `\n📇 [PHONEBOOK SETTLE ${this.tenantId}] reason=${reason} final=${final} ` +
          `run=${this.phonebookSettleRunCount}/${PHONEBOOK_SETTLE_MAX_RUNS} ` +
          `usableContacts=${usableCount} namedHits=${this.phonebookNameHits} ` +
          `notifyHits=${this.phonebookNotifyHits} inFlight=${this.contactsSyncInFlight}`
      );

      // Only push contacts when dirty or this is the first/final pass.
      const shouldSyncContacts =
        contacts.length > 0 &&
        (final || !contactsUnchanged || this.lastSettledUsableContacts < 0);
      if (shouldSyncContacts) {
        await this.syncContactsToBackend(contacts, { fromSettle: true });
      }
      this.lastSettledUsableContacts = usableCount;

      const tenantId = this.logicalTenantId();
      const res = await axios.post(
        FASTAPI_SETTLE_NAMES_URL,
        { tenant_id: tenantId, tenant_jid: tenantId },
        { timeout: 30000 }
      );
      console.log(
        `✅ [PHONEBOOK SETTLE ${this.tenantId}] FastAPI:`,
        JSON.stringify(res.data || {}).slice(0, 240)
      );

      if (final || this.contactsSyncInFlight === 0) {
        this.markSelectionReadyFromSettle(reason);
        return;
      }

      // Rare: settle finished but another contact batch is still in flight.
      this.schedulePhonebookSettle(CONTACT_SYNC_QUIET_MS, { final: true });
    } catch (err) {
      console.error(`❌ [PHONEBOOK SETTLE ${this.tenantId}] ${err.message}`);
      if (final || reason === "timeout" || this.phonebookSettleRunCount >= PHONEBOOK_SETTLE_MAX_RUNS) {
        this.markSelectionReadyFromSettle(`${reason}-error`);
      } else {
        this.schedulePhonebookSettle(2000, { final: false });
      }
    } finally {
      this.phonebookSettleInFlight = false;
    }
  }

  async pushInitialChats(chats) {
    if (!Array.isArray(chats) || chats.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    const oldest = now - TEN_DAYS_SECS;
    const payload = [];

    for (const chat of chats) {
      const jid = normalizeJid(chat?.id);
      if (!jid || jid === "status@broadcast" || String(jid).endsWith("@broadcast")) continue;
      const phoneJid = isLidJid(jid) ? this.lidToPhoneJid.get(jid) || null : isPhoneJid(jid) ? jid : null;
      const storedJid = phoneJid || jid;
      const name = this.safeDisplayName(
        chat.name || chat.displayName || this.contactNameByJid.get(jid) || this.contactNameByJid.get(storedJid),
        storedJid
      );
      if (name && isUsableDisplayName(name)) {
        this.contactNameByJid.set(storedJid, name);
        trackSyncedContact(this.logicalTenantId(), name);
      }
      const timestamp = unixFromMaybeLong(
        chat.conversationTimestamp ?? chat.lastMsgTimestamp
      );
      
      if (!timestamp || timestamp >= oldest) {
        const currentSessionTenantId = this.logicalTenantId();
        payload.push({
          tenant_id: currentSessionTenantId,
          tenant_jid: currentSessionTenantId,
          jid: storedJid,
          name:
            (isUsableDisplayName(name) && name) ||
            formatPhoneFromJid(storedJid) ||
            "WhatsApp Contact",
          phone_number: isPhoneJid(storedJid) ? storedJid.split("@")[0] : null,
          timestamp: timestamp || now,
          is_group: isGroupJid(storedJid),
        });
      }
    }

    if (!payload.length) return;
    this.persistContacts();
    try {
      const currentSessionTenantId = this.logicalTenantId();
      await axios.post(
        FASTAPI_CHATS_URL,
        {
          tenant_id: currentSessionTenantId,
          tenant_jid: currentSessionTenantId,
          chats: payload,
        },
        { timeout: 30000 }
      );
      console.log(`[Worker ${this.tenantId}] Pushed ${payload.length} initial chats (last 10 days) to FastAPI`);
    } catch (err) {
      console.error(`[Worker ${this.tenantId}] Initial chats push error:`, err.message);
    }
  }

  scheduleReconnect(reason = "connection-close") {
    if (this.restartScheduled) return;
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      console.error(
        `[Worker ${this.tenantId}] Reconnect cap (${RECONNECT_MAX_ATTEMPTS}) hit after ${reason} — waiting for /qr`
      );
      this.authLifecycle = this.currentQRCodeDataUrl ? "qr_ready" : "disconnected";
      this.notifyAuthStatus("disconnected", {
        forceLifecycle: true,
        forceNotify: true,
        reconnect_exhausted: true,
      }).catch(() => {});
      return;
    }

    this.restartScheduled = true;
    this.reconnectAttempts += 1;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** Math.max(0, this.reconnectAttempts - 1),
      RECONNECT_MAX_MS
    );
    console.log(
      `[Worker ${this.tenantId}] Reconnect #${this.reconnectAttempts} in ${delay}ms (${reason})`
    );

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const prev = this.sockInstance;
    this.sockInstance = null;
    disposeSocket(prev);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      startTenantWhatsAppBot(this.tenantId)
        .catch((err) => {
          console.error(`[Reconnect failed ${this.tenantId}]`, err?.message || err);
        })
        .finally(() => {
          this.restartScheduled = false;
        });
    }, delay);
  }

  scheduleFreshStart() {
    if (this.restartScheduled) return;
    this.restartScheduled = true;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.clearSessionCaches();
    this.currentQRCodeDataUrl = null;
    this.isSyncing = false;
    this.totalProcessed = 0;
    this.historyCompleted = false;
    this.isHistorySyncComplete = false;
    this.historyReadyNotified = false;
    this.resetHistoryIngest();
    if (this.syncIdleTimer) {
      clearTimeout(this.syncIdleTimer);
      this.syncIdleTimer = null;
    }
    if (this.historyWatchdog) {
      clearTimeout(this.historyWatchdog);
      this.historyWatchdog = null;
    }

    const prev = this.sockInstance;
    this.sockInstance = null;
    disposeSocket(prev);

    setTimeout(() => {
      const cleared = this.clearAuthFolder();
      console.log(
        cleared
          ? `🔄 [${this.tenantId}] Auth wiped — starting fresh WhatsApp session...`
          : `🔄 [${this.tenantId}] Auth wipe incomplete — starting session anyway...`
      );
      startTenantWhatsAppBot(this.tenantId)
        .catch((err) => {
          console.error(`[Fresh start failed ${this.tenantId}]`, err?.message || err);
          this.clearAuthFolder();
          return new Promise((r) => setTimeout(r, 2000)).then(() =>
            startTenantWhatsAppBot(this.tenantId)
          );
        })
        .catch(console.error)
        .finally(() => {
          this.restartScheduled = false;
        });
    }, 800);
  }

  markSyncActivity() {
    // After selection unlock, keep ingesting quietly — do not re-lock the desk UI.
    if (this.selectionReady) {
      this.historyQuiet = false;
      if (this.syncIdleTimer) clearTimeout(this.syncIdleTimer);
      this.syncIdleTimer = setTimeout(() => {
        this.syncIdleTimer = null;
        this.historyQuiet = true;
      }, 8000);
      return;
    }

    this.isSyncing = true;
    this.historyCompleted = false;
    this.historyQuiet = false;
    this.setSyncPhase("messages");
    if (this.syncIdleTimer) clearTimeout(this.syncIdleTimer);

    // 8s idle → history quiet; fast unlock path usually beats this.
    this.syncIdleTimer = setTimeout(async () => {
      this.syncIdleTimer = null;
      this.historyCompleted = true;
      this.historyQuiet = true;
      console.log(
        `✅ [History Sync ${this.tenantId}] Message ingest quiet. Continuing contacts/name mapping…`
      );
      this.setSyncPhase("media");
      setTimeout(() => {
        if (!this.selectionReady) this.setSyncPhase("contacts");
      }, 800);

      if (!this.isHistorySyncComplete) {
        this.markHistorySyncComplete("idle-settle");
      } else {
        this.scheduleSelectionUnlockCheck(CONTACT_SYNC_QUIET_MS);
      }
    }, 8000);
  }

  scheduleAiDebounce(jid) {
    if (!jid || String(jid).endsWith("@broadcast")) return;
    if (this.pendingAiDebounce.has(jid)) {
      clearTimeout(this.pendingAiDebounce.get(jid));
    }
    const timer = setTimeout(async () => {
      this.pendingAiDebounce.delete(jid);
      try {
        await axios.post(
          FASTAPI_MATTERS_TRIGGER_URL,
          { tenant_jid: this.logicalTenantId(), target_jid: jid },
          { timeout: 5000 }
        );
      } catch (e) {
        console.error(`[Debounce Error ${this.tenantId}]`, e.message);
      }
    }, AI_DEBOUNCE_MS);
    this.pendingAiDebounce.set(jid, timer);
  }

  safeDisplayName(name, jid) {
    if (isUsableDisplayName(name)) return String(name).trim();
    const phoneJid = isPhoneJid(jid)
      ? normalizeJid(jid)
      : this.lidToPhoneJid.get(normalizeJid(jid)) || null;
    if (phoneJid) {
      const mapped = this.contactNameByJid.get(phoneJid);
      if (isUsableDisplayName(mapped)) return mapped;
    }
    // Do not cache a formatted phone as a "name" — leave empty for resolve fallback.
    return "";
  }

  async resolvePhoneJid(jid) {
    const normalized = normalizeJid(jid);
    if (!normalized) return null;
    if (isPhoneJid(normalized)) return normalized;
    if (!isLidJid(normalized)) return null;

    const cached = this.lidToPhoneJid.get(normalized);
    if (cached) return cached;

    try {
      const pn = await this.sockInstance?.signalRepository?.lidMapping?.getPNForLID(normalized);
      const pnNorm = normalizeJid(pn);
      if (isPhoneJid(pnNorm)) {
        this.rememberLidPair(normalized, pnNorm);
        this.scheduleLidRemap();
        return pnNorm;
      }
    } catch (err) {
      console.log(`[LID ${this.tenantId}] signal lookup ${normalized}: ${err.message}`);
    }

    const lidUser = normalized.split("@")[0];
    const reverseFile = path.join(this.authDir, `lid-mapping-${lidUser}_reverse.json`);
    try {
      if (fs.existsSync(reverseFile)) {
        const pnUser = JSON.parse(fs.readFileSync(reverseFile, "utf-8"));
        const digits = String(pnUser ?? "").replace(/\D/g, "");
        if (digits) {
          const pnJid = `${digits}@s.whatsapp.net`;
          this.rememberLidPair(normalized, pnJid);
          this.scheduleLidRemap();
          return pnJid;
        }
      }
    } catch {}
    return null;
  }

  scheduleLidRemap() {
    if (this.lidRemapTimer) clearTimeout(this.lidRemapTimer);
    this.lidRemapTimer = setTimeout(() => {
      this.lidRemapTimer = null;
      this.pushLidRemap().catch((err) => console.error(`[LID remap ${this.tenantId}]`, err.message));
    }, 1200);
  }

  async pushLidMappingsToBackend(mappings) {
    if (!Array.isArray(mappings) || !mappings.length) return;
    try {
      const tenantId = this.logicalTenantId();
      await axios.post(
        FASTAPI_LID_MAPPINGS_URL,
        { tenant_id: tenantId, tenant_jid: tenantId, mappings },
        { timeout: 30000 }
      );
      console.log(
        `🔗 [Worker] Successfully pushed ${mappings.length} LID mappings to FastAPI`
      );
    } catch (err) {
      console.error(`❌ [LID Push Error ${this.tenantId}]:`, err.message);
    }
  }

  async pushLidRemap() {
    if (!this.lidToPhoneJid.size) return;
    if (!this._syncedLidKeys) this._syncedLidKeys = new Set();

    // Only push newly learned LID→phone pairs. Re-sending 1000+ every debounce
    // locks SQLite and times out /recent-active + auth-status.
    const fresh = [...this.lidToPhoneJid.entries()].filter(
      ([lid]) => !this._syncedLidKeys.has(lid)
    );
    if (!fresh.length) return;

    const mappings = fresh.map(([lid, pn]) => ({
      lid,
      pn,
      name: this.contactNameByJid.get(pn) || this.contactNameByJid.get(lid) || null,
    }));
    // Persist mappings into lid_mappings table (name resolution)
    await this.pushLidMappingsToBackend(mappings);
    // Also remap any rows already stored under @lid
    try {
      await axios.post(
        FASTAPI_LID_REMAP_URL,
        { tenant_id: this.logicalTenantId(), tenant_jid: this.logicalTenantId(), mappings },
        { timeout: 30000 }
      );
      for (const [lid] of fresh) this._syncedLidKeys.add(lid);
      console.log(`[LID ${this.tenantId}] Pushed ${mappings.length} new mappings to backend.`);
    } catch (err) {
      console.error(`[LID remap error ${this.tenantId}]`, err.message);
    }
  }

  /**
   * Resolve display name: LID→phone remap → address book → pushName → formatted phone.
   * Never returns the placeholder "WhatsApp Contact" when a phone JID is known.
   */
  getResolvedContactName(rawJid, pushName) {
    if (!rawJid) return "Unknown";

    // 1. Groups — prefer store chat name / cached subject
    if (isGroupJid(rawJid)) {
      const groupMeta =
        this.store?.chats?.get(rawJid) ||
        this.groupMetaByJid.get(rawJid) ||
        this.groupMetaByJid.get(normalizeJid(rawJid) || rawJid);
      const groupName = groupMeta?.name || groupMeta?.subject;
      if (isUsableDisplayName(groupName)) return String(groupName).trim();
      const mapped =
        this.contactNameByJid.get(rawJid) ||
        this.contactNameByJid.get(normalizeJid(rawJid) || rawJid);
      if (isUsableDisplayName(mapped)) return mapped;
      return "WhatsApp Group";
    }

    // 2. If LID, resolve mapped phone JID before address-book lookup
    let targetPhoneJid = rawJid;
    if (isLidJid(rawJid)) {
      const mapped =
        this.lidToPhoneJid.get(normalizeJid(rawJid)) ||
        this.lidToPhoneJid.get(rawJid) ||
        null;
      if (mapped) {
        targetPhoneJid = mapped.includes("@") ? mapped : `${mapped}@s.whatsapp.net`;
      }
    }

    const lookupIds = [
      targetPhoneJid,
      rawJid,
      normalizeJid(targetPhoneJid),
      normalizeJid(rawJid),
      ...jidLookupKeys(targetPhoneJid),
      ...jidLookupKeys(rawJid),
    ];

    // 3. Address book map + Baileys store (phonebook saved name first)
    for (const id of lookupIds) {
      if (!id) continue;
      const book =
        this.addressBookMap.get(id) ||
        this.store?.contacts?.[id] ||
        null;
      if (book?.name && isUsableDisplayName(book.name)) return String(book.name).trim();
      const bookName = pickContactBookName(book);
      if (isUsableDisplayName(bookName)) return bookName;
    }

    // 4. Local persisted name cache
    for (const key of lookupIds) {
      if (!key) continue;
      const mapped = this.contactNameByJid.get(key);
      if (isUsableDisplayName(mapped)) return mapped;
    }

    // 5. Explicit pushName from the message (incoming 1-on-1 miner / live upsert)
    if (isUsableDisplayName(pushName)) return String(pushName).trim();

    // 6. notify from address book (digit aliases included)
    for (const id of lookupIds) {
      if (!id) continue;
      const book = this.addressBookMap.get(id) || this.store?.contacts?.[id];
      if (book?.notify && isUsableDisplayName(book.notify)) {
        return String(book.notify).trim();
      }
    }
    // Digit-only addressBook aliases (e.g. 919891519151)
    {
      const dig = String(targetPhoneJid.split("@")[0] || "").replace(/\D/g, "");
      if (dig.length >= 10) {
        for (const key of [dig, dig.slice(-10), `91${dig.slice(-10)}`]) {
          const book = this.addressBookMap.get(key);
          if (book?.notify && isUsableDisplayName(book.notify)) {
            return String(book.notify).trim();
          }
          if (book?.name && isUsableDisplayName(book.name)) {
            return String(book.name).trim();
          }
          const mapped = this.contactNameByJid.get(key);
          if (isUsableDisplayName(mapped)) return mapped;
        }
      }
    }

    // 7. Format clean phone number ONLY after every name path fails
    const phoneDigits = String(targetPhoneJid.split("@")[0] || "").replace(/\D/g, "");
    if (phoneDigits.length >= 10 && !isLidJid(targetPhoneJid)) {
      if (phoneDigits.startsWith("91") && phoneDigits.length === 12) {
        return `+91 ${phoneDigits.slice(2, 7)} ${phoneDigits.slice(7)}`;
      }
      return (
        formatPhoneFromJid(targetPhoneJid) ||
        (phoneDigits.length === 10
          ? `+91 ${phoneDigits.slice(0, 5)} ${phoneDigits.slice(5)}`
          : `+${phoneDigits}`)
      );
    }

    // Fallback — never leave a bare "WhatsApp Contact" when we at least know the LID
    if (isLidJid(rawJid)) {
      const short = String(rawJid).split("@")[0].slice(0, 5);
      return `User (${short})`;
    }
    return phoneDigits || String(targetPhoneJid).split("@")[0] || "Unknown";
  }

  resolveContactName(jid, pushName, isFromMe, phoneJid = null) {
    if (isFromMe) return "You";

    // Prefer phone JID alias when LID chat maps to a known PN
    const primary = phoneJid || jid;
    const fromStore = this.getResolvedContactName(primary, pushName);
    if (isUsableDisplayName(fromStore) && fromStore !== "WhatsApp Group") {
      return fromStore;
    }

    // Also try the original jid if different (LID vs PN)
    if (phoneJid && jid && phoneJid !== jid) {
      const alt = this.getResolvedContactName(jid, pushName);
      if (isUsableDisplayName(alt)) return alt;
    }

    const phoneSource = isPhoneJid(phoneJid)
      ? phoneJid
      : isPhoneJid(jid)
      ? jid
      : isLidJid(jid)
      ? this.lidToPhoneJid.get(normalizeJid(jid)) || this.lidToPhoneJid.get(jid)
      : null;
    return (
      formatPhoneFromJid(phoneSource) ||
      (isUsableDisplayName(fromStore) ? fromStore : null) ||
      this.getResolvedContactName(phoneSource || jid, null)
    );
  }

  async resolveChatIdentity(msg, { fast = false } = {}) {
    const remoteJid = normalizeJid(msg.key?.remoteJid);
    if (!remoteJid || remoteJid === "status@broadcast" || remoteJid.endsWith("@broadcast")) {
      return null;
    }

    if (isGroupJid(remoteJid)) {
      const participant =
        normalizeJid(msg.key?.participantAlt) ||
        normalizeJid(msg.key?.participant) ||
        null;
      let participantPhone = null;
      if (isPhoneJid(participant)) participantPhone = participant;
      else if (isLidJid(participant)) {
        participantPhone = fast
          ? this.lidToPhoneJid.get(participant) || null
          : await this.resolvePhoneJid(participant);
      }
      return {
        chatJid: remoteJid,
        isGroup: true,
        phoneJid: null,
        participantJid: participantPhone || participant,
      };
    }

    const remoteAlt = normalizeJid(msg.key?.remoteJidAlt);
    const participant = normalizeJid(msg.key?.participant);
    const participantAlt = normalizeJid(msg.key?.participantAlt);

    let phoneJid = null;
    if (isPhoneJid(remoteJid)) phoneJid = remoteJid;
    else if (isPhoneJid(remoteAlt)) phoneJid = remoteAlt;
    else if (isLidJid(remoteJid) && isPhoneJid(participant)) phoneJid = participant;
    else if (isPhoneJid(participantAlt)) phoneJid = participantAlt;
    else if (isLidJid(remoteJid)) {
      phoneJid = fast
        ? this.lidToPhoneJid.get(remoteJid) || null
        : await this.resolvePhoneJid(remoteJid);
    }

    if (isLidJid(remoteJid) && phoneJid) this.rememberLidPair(remoteJid, phoneJid);
    if (isLidJid(remoteAlt) && phoneJid) this.rememberLidPair(remoteAlt, phoneJid);

    return {
      chatJid: phoneJid || remoteJid,
      isGroup: false,
      phoneJid,
      participantJid: null,
    };
  }

  async resolveGroupSubject(groupJid) {
    const cached = this.groupMetaByJid.get(groupJid);
    if (cached?.subject) return cached.subject;
    if (!this.sockInstance) return null;
    try {
      const meta = await this.sockInstance.groupMetadata(groupJid);
      const subject = meta?.subject || meta?.name || null;
      if (subject) {
        this.groupMetaByJid.set(groupJid, { subject, fetchedAt: Date.now() });
        this.contactNameByJid.set(groupJid, subject);
        this.persistContacts();
      }
      return subject;
    } catch (err) {
      return cached?.subject || null;
    }
  }

  async resolveAvatarUrl(jid) {
    if (!jid || jid === "status@broadcast" || String(jid).endsWith("@broadcast")) return null;
    const normalized = normalizeJid(jid) || jid;
    const cached =
      this.avatarUrlByJid.get(jid) || this.avatarUrlByJid.get(normalized) || null;
    if (cached) return cached;
    const missed = this.avatarMissAt.get(normalized);
    if (missed && Date.now() - missed < AVATAR_MISS_TTL_MS) return null;
    if (!this.sockInstance) return null;
    try {
      const url = await this.sockInstance.profilePictureUrl(normalized, "image").catch(() => null);
      if (url) {
        this.avatarUrlByJid.set(jid, url);
        if (normalized) this.avatarUrlByJid.set(normalized, url);
        this.avatarMissAt.delete(normalized);
        this.persistAvatars();
        return url;
      }
      this.avatarMissAt.set(normalized, Date.now());
      return null;
    } catch {
      this.avatarMissAt.set(normalized, Date.now());
      return null;
    }
  }

  contactDisplayName(contact) {
    if (!contact?.id) return "";
    const displayName = firstUsableName(contact.name, contact.notify, contact.verifiedName);
    if (!displayName) {
      const phoneJid = isPhoneJid(contact.phoneNumber)
        ? normalizeJid(contact.phoneNumber)
        : isPhoneJid(contact.id)
        ? normalizeJid(contact.id)
        : this.lidToPhoneJid.get(normalizeJid(contact.id)) ||
          this.lidToPhoneJid.get(contact.id) ||
          null;
      const mapped = phoneJid ? this.contactNameByJid.get(phoneJid) : "";
      if (isUsableDisplayName(mapped)) return mapped;
      const book = this.addressBookMap.get(phoneJid) || this.addressBookMap.get(contact.id);
      if (book?.name && isUsableDisplayName(book.name)) return String(book.name).trim();
      return formatPhoneFromJid(phoneJid) || "";
    }
    return String(displayName).trim();
  }

  /**
   * Merge a Baileys contact into addressBookMap (and legacy caches).
   * Always stores the object so later LID→phone resolution can read .name/.notify.
   */
  applyAddressBookContact(contact) {
    if (!contact || !contact.id) return;
    const id = normalizeJid(contact.id) || contact.id;
    const existing =
      this.addressBookMap.get(id) ||
      this.addressBookMap.get(contact.id) ||
      {};
    const merged = mergeContactRecord(existing, contact, id);
    this.addressBookMap.set(id, merged);
    this.addressBookMap.set(contact.id, merged);

    // Link under LID / phone aliases so either key resolves
    if (contact.lid) {
      const lidKey = normalizeJid(contact.lid) || contact.lid;
      this.addressBookMap.set(lidKey, merged);
      this.addressBookMap.set(contact.lid, merged);
    }
    if (contact.phoneNumber) {
      const pn = normalizeJid(contact.phoneNumber) || contact.phoneNumber;
      this.addressBookMap.set(pn, merged);
    }
    const bare = cleanJid(id);
    if (bare && isPhoneJid(id)) {
      this.addressBookMap.set(`${bare}@s.whatsapp.net`, merged);
    }

    this.rememberContact(merged);
  }

  rememberContact(contact) {
    if (!contact?.id) return;

    // Always merge into address book even when display name is missing
    const id = normalizeJid(contact.id) || contact.id;
    if (!this.addressBookMap.has(id) && !this.addressBookMap.has(contact.id)) {
      const existing = this.addressBookMap.get(id) || {};
      const merged = mergeContactRecord(existing, contact, id);
      this.addressBookMap.set(id, merged);
      this.addressBookMap.set(contact.id, merged);
      if (contact.lid) {
        this.addressBookMap.set(normalizeJid(contact.lid) || contact.lid, merged);
      }
    }

    const displayName = this.contactDisplayName(contact);

    // Keep Baileys store in sync even when contacts arrive via history / manual paths
    if (this.store?.contacts) {
      const prev = this.store.contacts[id] || {};
      const merged = mergeContactRecord(prev, contact, id);
      this.store.contacts[id] = merged;
      this.store.contacts[contact.id] = merged;
      const bare = cleanJid(contact.id);
      if (bare && isPhoneJid(id)) this.store.contacts[`${bare}@s.whatsapp.net`] = merged;
      if (contact.phoneNumber) {
        const pn = normalizeJid(contact.phoneNumber) || contact.phoneNumber;
        this.store.contacts[pn] = merged;
      }
    }

    if (displayName && isUsableDisplayName(displayName)) {
      const bindName = (rawJid) => {
        if (!rawJid) return;
        for (const key of jidLookupKeys(rawJid)) {
          this.contactNameByJid.set(key, displayName);
        }
      };

      bindName(contact.id);
      bindName(contact.phoneNumber);
      bindName(contact.lid);
    }

    if (contact.lid && contact.phoneNumber) this.rememberLidPair(contact.lid, contact.phoneNumber);
    if (isLidJid(contact.id) && contact.phoneNumber) this.rememberLidPair(contact.id, contact.phoneNumber);
    if (isGroupJid(contact.id) && displayName) {
      this.groupMetaByJid.set(contact.id, { subject: displayName, fetchedAt: Date.now() });
      this.store?.chats?.set(contact.id, {
        id: contact.id,
        name: displayName,
        subject: displayName,
      });
    }
  }

  contactSyncEntries(contact) {
    if (!contact?.id) return [];
    this.rememberContact(contact);

    // Persist only real labels. A formatted phone must never land in contacts.name.
    const savedName = firstUsableName(contact.name, contact.verifiedName, contact.username) || null;
    const notify = firstUsableName(contact.notify) || null;
    if (!savedName && !notify) return [];
    const phoneJid = isPhoneJid(contact.phoneNumber)
      ? normalizeJid(contact.phoneNumber)
      : isPhoneJid(contact.id)
      ? normalizeJid(contact.id)
      : null;
    const phoneNumber = phoneJid ? String(phoneJid).split("@")[0] : null;

    const jids = new Set();
    for (const raw of [
      contact.id,
      contact.lid,
      contact.phoneNumber,
      normalizeJid(contact.id),
      normalizeJid(contact.lid),
      normalizeJid(contact.phoneNumber),
    ]) {
      if (!raw || raw === "status@broadcast" || raw.endsWith("@broadcast")) continue;
      jids.add(raw);
    }

    const currentSessionTenantId = this.logicalTenantId();
    return [...jids].map((jid) => ({
      tenant_id: currentSessionTenantId,
      tenant_jid: currentSessionTenantId,
      jid,
      id: jid,
      name: savedName,
      notify,
      phone_number: phoneNumber,
      saved: Boolean(savedName),
    }));
  }

  async syncContactsToBackend(contacts, { fromSettle = false } = {}) {
    if (!Array.isArray(contacts) || contacts.length === 0) return;

    const byJid = new Map();
    for (const contact of contacts) {
      for (const entry of this.contactSyncEntries(contact)) {
        const prev = byJid.get(entry.jid);
        if (!prev || (entry.saved && !prev.saved)) {
          byJid.set(entry.jid, entry);
        }
      }
    }

    const contactsToSync = [...byJid.values()];
    if (contactsToSync.length === 0) return;

    this.persistContacts();
    this.contactsSyncInFlight += 1;
    if (!fromSettle && !this.selectionReady) {
      this.setSyncPhase("contacts");
      // External contact batch — desk waits for another quiet settle.
      this.phonebookSettled = false;
    }

    try {
      const currentSessionTenantId = this.logicalTenantId();
      await axios.post(
        FASTAPI_CONTACTS_URL,
        {
          tenant_id: currentSessionTenantId,
          tenant_jid: currentSessionTenantId,
          contacts: contactsToSync,
        },
        { timeout: 30000 }
      );
      this.lastContactsSyncAt = Date.now();
      console.log(
        `[Contacts Synced ${this.tenantId}] ${contactsToSync.length} contacts synced.`
      );
      // Do NOT re-schedule settle when we were invoked FROM settle — that loops forever.
      if (!this.selectionReady && !fromSettle) {
        this.schedulePhonebookSettle(PHONEBOOK_SETTLE_DEBOUNCE_MS);
        this.scheduleSelectionUnlockCheck(CONTACT_SYNC_QUIET_MS);
      }
    } catch (err) {
      console.error(`[Contacts Sync Error ${this.tenantId}]`, err.message);
    } finally {
      this.contactsSyncInFlight = Math.max(0, this.contactsSyncInFlight - 1);
      if (!this.selectionReady && !fromSettle && this.contactsSyncInFlight === 0) {
        this.scheduleSelectionUnlockCheck(CONTACT_SYNC_QUIET_MS);
      }
    }
  }

  async handleMediaDownload(msg) {
    const content = unwrapContent(msg);
    const imageMsg = content?.imageMessage;
    const audioMsg = content?.audioMessage;
    if (!imageMsg && !audioMsg) return null;

    const mediaType = imageMsg ? "image" : "audio";
    const caption = (imageMsg?.caption || audioMsg?.caption || "").trim();
    const messageId = msg.key?.id || `tmp_${Date.now()}`;
    const ext = imageMsg
      ? "jpg"
      : String(audioMsg.mimetype || "").includes("mpeg") ||
        String(audioMsg.mimetype || "").includes("mp3")
      ? "mp3"
      : "ogg";
    const fileName = `media_${messageId}.${ext}`;
    const fullPath = path.join(DOWNLOAD_DIR, fileName);
    try {
      let buffer = null;
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).size > 0) {
        buffer = fs.readFileSync(fullPath);
      } else {
        buffer = await downloadMediaMessage(
          msg,
          "buffer",
          {},
          {
            logger: console,
            reuploadRequest: this.sockInstance?.updateMediaMessage,
          }
        );
        if (!buffer || !buffer.length) {
          console.error("[Baileys Ingest Error]: empty media buffer");
          return { media_type: mediaType, file_name: null, media_base64: null, caption };
        }
        fs.writeFileSync(fullPath, buffer);
        console.log(`${imageMsg ? "📸" : "🎙️"} [Media Saved]: ${fileName}`);
      }

      const mediaBase64 = Buffer.isBuffer(buffer)
        ? buffer.toString("base64")
        : Buffer.from(buffer).toString("base64");
      console.log("[Worker] Media dispatched:", {
        id: msg.key?.id,
        type: mediaType,
        hasBase64: !!mediaBase64,
      });
      return {
        media_type: mediaType,
        file_name: fileName,
        media_base64: mediaBase64,
        caption,
      };
    } catch (err) {
      console.error("[Baileys Ingest Error]:", err?.message || err);
      // Graceful fallback: text-only ingest continues without base64
      return { media_type: mediaType, file_name: null, media_base64: null, caption };
    }
  }

  detectSelfChat(remoteJid, isFromMe) {
    if (!remoteJid) return false;
    const remote = normalizeJid(remoteJid);
    const me = normalizeJid(this.myJid);

    if (me && remote === me) return true;
    if (this.myLid && (remoteJid === this.myLid || remote === normalizeJid(this.myLid))) return true;

    if (isFromMe && me) {
      const myNum = me.split("@")[0];
      if (myNum && remoteJid.includes(myNum)) return true;
    }
    return false;
  }

  mentionsCurrentUser(content) {
    if (!content) return false;
    const bags = [
      content.extendedTextMessage?.contextInfo?.mentionedJid,
      content.imageMessage?.contextInfo?.mentionedJid,
      content.videoMessage?.contextInfo?.mentionedJid,
      content.audioMessage?.contextInfo?.mentionedJid,
      content.documentMessage?.contextInfo?.mentionedJid,
    ];
    const me = normalizeJid(this.myJid);
    const myNum = me ? String(me).split("@")[0] : "";
    for (const list of bags) {
      if (!Array.isArray(list)) continue;
      for (const jid of list) {
        const normalized = normalizeJid(jid);
        if (me && normalized === me) return true;
        if (this.myLid && normalized === normalizeJid(this.myLid)) return true;
        if (myNum && String(jid || "").includes(myNum)) return true;
      }
    }
    return false;
  }

  filterHistoryMessagesThreeTier(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return { selected: [], tier1Count: 0, tier2Count: 0, groupsKept: 0, groupsCapped: 0 };
    }

    const nowMs = Date.now();
    const tenDaysMs = TEN_DAYS_MS;
    const cutoffMs = nowMs - tenDaysMs;

    const byChat = new Map();
    let skippedNoTs = 0;
    let skippedOld = 0;
    for (const msg of messages) {
      const remoteJid = msg?.key?.remoteJid;
      if (
        !remoteJid ||
        remoteJid === "status@broadcast" ||
        String(remoteJid).endsWith("@broadcast")
      ) {
        continue;
      }

      const tsMs = messageTimestampMs(msg);
      if (!tsMs) {
        skippedNoTs += 1;
        continue;
      }
      if (tsMs < cutoffMs) {
        skippedOld += 1;
        continue;
      }

      if (!byChat.has(remoteJid)) byChat.set(remoteJid, []);
      byChat.get(remoteJid).push(msg);
    }

    const selected = [];
    let tier1Count = 0;
    let tier2Count = 0;
    let groupsKept = 0;
    let groupsCapped = 0;

    for (const [remoteJid, chatMsgs] of byChat) {
      chatMsgs.sort((a, b) => messageTimestampMs(a) - messageTimestampMs(b));
      const within10Days = chatMsgs;

      if (isGroupJid(remoteJid)) {
        const fresh = within10Days.filter((msg) => !this.historyAlreadyKept(msg));
        const already = this.historyGroupCounts.get(remoteJid) || 0;
        const room = GROUP_HISTORY_CAP - already;
        if (room <= 0) {
          if (fresh.length) groupsCapped += 1;
          continue;
        }
        const capped = fresh.length > room ? fresh.slice(-room) : fresh;
        if (fresh.length > room) groupsCapped += 1;
        if (capped.length) {
          this.historyGroupCounts.set(remoteJid, already + capped.length);
          this.historyTier1Chats.add(remoteJid);
          this.markHistoryKept(capped);
          selected.push(...capped);
          groupsKept += capped.length;
          tier1Count += capped.length;
        }
        continue;
      }

      const fresh10Days = within10Days.filter((msg) => !this.historyAlreadyKept(msg));
      if (fresh10Days.length > 0) {
        this.historyTier1Chats.add(remoteJid);
        this.markHistoryKept(fresh10Days);
        selected.push(...fresh10Days);
        tier1Count += fresh10Days.length;
      }
    }

    console.log(
      `⏱️ [CORRECTED 10-DAY FILTER] Total: ${messages.length} -> Valid within last 10 days: ${selected.length}` +
        ` (skipped no-ts=${skippedNoTs}, older=${skippedOld})`
    );
    return { selected, tier1Count, tier2Count, groupsKept, groupsCapped };
  }

  async buildPayloadFromWaMessage(
    msg,
    {
      isHistory = false,
      mediaPath = null,
      mediaType = null,
      mediaBase64 = null,
      caption = null,
      fast = false,
    } = {}
  ) {
    const identity = await this.resolveChatIdentity(msg, { fast });
    if (!identity) return null;

    const { chatJid, isGroup, phoneJid, participantJid } = identity;
    const messageId = msg.key?.id;
    // Baileys key.fromMe is the sole source of truth — never invert.
    const isFromMe = Boolean(msg.key?.fromMe);
    const isSelfChat = !isGroup && this.detectSelfChat(chatJid, isFromMe);
    const content = unwrapContent(msg);
    let text = extractMessageText(msg);
    if (!text && caption) text = String(caption).trim();

    if (!text && mediaType === "audio") text = "[Voice Note]";
    if (!text && mediaType === "image") text = "[Photo]";

    // Always dispatch when media_type is known, even if base64 download failed.
    if (!text && !mediaPath && !mediaBase64 && !mediaType) return null;
    if (isSelfChat && !isFromMe) return null;

    let senderName;
    let participantName = null;

    if (isGroup) {
      const groupSubject = fast
        ? this.groupMetaByJid.get(chatJid)?.subject ||
          this.getResolvedContactName(chatJid, null) ||
          this.contactNameByJid.get(chatJid) ||
          "WhatsApp Group"
        : (await this.resolveGroupSubject(chatJid)) ||
          this.getResolvedContactName(chatJid, null) ||
          this.contactNameByJid.get(chatJid) ||
          "WhatsApp Group";
      senderName = groupSubject === "Unknown Contact" ? "WhatsApp Group" : groupSubject;
      participantName = isFromMe
        ? "You"
        : this.getResolvedContactName(participantJid, msg.pushName);
    } else if (isSelfChat) {
      const phone = formatPhoneFromJid(this.myJid || phoneJid || chatJid);
      senderName = phone ? `Note to self (${phone})` : "You (Self)";
    } else {
      senderName = this.resolveContactName(chatJid, msg.pushName, false, phoneJid);
    }

    const timestamp = messageUnixSeconds(msg) || Math.floor(Date.now() / 1000);
    const phoneNumber = phoneJid ? String(phoneJid).split("@")[0] : "";

    const tenantId = this.logicalTenantId();
    return {
      tenant_id: tenantId,
      tenant_jid: tenantId,
      message_id: messageId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: chatJid,
      sender_jid: chatJid,
      sender_name: senderName,
      participant_name: participantName,
      mentions_user: this.mentionsCurrentUser(content),
      phone_number: phoneNumber || null,
      from_me: isFromMe,
      is_from_me: isFromMe,
      is_self_chat: isSelfChat,
      is_group: isGroup,
      is_history: isHistory,
      timestamp,
      text: text || (mediaType === "audio" ? "[Voice Note]" : mediaType === "image" ? "[Photo]" : ""),
      media_type: mediaType,
      media_path: mediaPath,
      media_base64: mediaBase64 || null,
    };
  }

  async forwardToPythonAI(payload) {
    const tenantId = this.logicalTenantId();
    payload.tenant_id = tenantId;
    payload.tenant_jid = tenantId;
    // Layer-1 multimodal path: Whisper/Vision need a longer timeout than plain text.
    const targetUrl = payload.media_base64 || payload.media_type
      ? FASTAPI_INGEST_URL
      : FASTAPI_WEBHOOK_URL;
    const timeoutMs = payload.media_base64 || payload.media_type ? 30000 : 20000;

    try {
      const res = await axios.post(targetUrl, payload, {
        timeout: timeoutMs,
        headers: { "X-Worker-Secret": WORKER_INTERNAL_SECRET },
      });

      if (res.status !== 200) {
        console.error(
          `[FastAPI ${this.tenantId}] ingest returned ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`
        );
      }

      if (res.data?.bot_reply && this.sockInstance && this.isConnected && !payload.is_history) {
        const sent = await this.sockInstance.sendMessage(payload.sender_jid, {
          text: res.data.bot_reply,
        });
        if (sent?.key?.id) {
          this.recentlySentBotIds.add(sent.key.id);
          setTimeout(() => this.recentlySentBotIds.delete(sent.key.id), 120000);
        }
        console.log(`🤖 [Personal Bot Replied]: "${res.data.bot_reply.slice(0, 80)}..."`);
      }
    } catch (error) {
      const status = error?.response?.status;
      const detail = error?.response?.data
        ? JSON.stringify(error.response.data).slice(0, 300)
        : error.message;
      console.error("[Baileys Ingest Error]:", detail);
      console.error(
        `[FastAPI ${this.tenantId}] ingest failed${status ? ` (${status})` : ""}: ${detail}`
      );
    }
  }

  async forwardHistoryBatch(payloads) {
    if (!payloads.length) return;

    const tenantId = this.logicalTenantId();
    for (const p of payloads) {
      p.tenant_id = tenantId;
      p.tenant_jid = tenantId;
    }

    try {
      const res = await axios.post(
        FASTAPI_BATCH_URL,
        { tenant_id: tenantId, tenant_jid: tenantId, messages: payloads },
        {
          timeout: 60000,
          headers: { "X-Worker-Secret": WORKER_INTERNAL_SECRET },
        }
      );
      if (res.status !== 200) {
        console.error(
          `[History Sync ${this.tenantId}] /incoming-batch returned ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`
        );
      }
      this.totalProcessed += payloads.length;
      this.markSyncActivity();
      console.log(
        `📦 [History Sync ${this.tenantId}] Batch of ${payloads.length} -> FastAPI (total: ${this.totalProcessed})`
      );
    } catch (batchErr) {
      const status = batchErr?.response?.status;
      const detail = batchErr?.response?.data
        ? JSON.stringify(batchErr.response.data).slice(0, 300)
        : batchErr.message;
      console.error(
        `[History Sync ${this.tenantId}] Batch failed${status ? ` (${status})` : ""}: ${detail} — falling back to /incoming`
      );
      for (let i = 0; i < payloads.length; i += HISTORY_BATCH_SIZE) {
        const chunk = payloads.slice(i, i + HISTORY_BATCH_SIZE);
        await Promise.allSettled(chunk.map((p) => this.forwardToPythonAI(p)));
        this.totalProcessed += chunk.length;
        this.markSyncActivity();
      }
    }
  }

  async cacheParticipatingGroups() {
    if (!this.sockInstance) return;
    try {
      const groups = await this.sockInstance.groupFetchAllParticipating();
      const entries = Object.values(groups || {});
      for (const meta of entries) {
        const id = meta?.id;
        const subject = meta?.subject;
        if (!id || !subject) continue;
        this.groupMetaByJid.set(id, { subject, fetchedAt: Date.now() });
        this.contactNameByJid.set(id, subject);
      }
      if (entries.length) {
        this.persistContacts();
        console.log(`[Groups ${this.tenantId}] Cached ${entries.length} group names`);
      }
    } catch (err) {
      console.error(`[Groups Cache Error ${this.tenantId}]`, err.message);
    }
  }

  async backfillInboxAvatars() {
    if (!this.sockInstance) return;
    try {
      // Do NOT call /api/v1/inbox/* here — that route needs Firebase auth.
      // Use session JIDs + webhook /sync-avatars (worker-secret allowed).
      const jidSet = new Set();
      for (const jid of this.activeTenDayJids || []) if (jid) jidSet.add(String(jid));
      for (const jid of this.historyTier1Chats || []) if (jid) jidSet.add(String(jid));
      for (const jid of this.contactNameByJid?.keys?.() || []) {
        if (jid && !String(jid).endsWith("@lid")) jidSet.add(String(jid));
      }
      for (const jid of this.avatarUrlByJid.keys()) jidSet.add(String(jid));

      const avatars = [];
      let attempted = 0;
      let missed = 0;
      for (const jid of jidSet) {
        if (!jid || jid === "status@broadcast" || String(jid).endsWith("@broadcast")) continue;
        if (this.avatarUrlByJid.get(jid)) {
          avatars.push({ jid, avatar_url: this.avatarUrlByJid.get(jid) });
          continue;
        }
        attempted += 1;
        const url = await this.resolveAvatarUrl(jid);
        if (url) avatars.push({ jid, avatar_url: url });
        else missed += 1;
      }

      if (avatars.length) {
        await axios.post(
          FASTAPI_AVATAR_URL,
          { tenant_jid: this.logicalTenantId(), avatars },
          { timeout: 20000, headers: { "X-Worker-Secret": WORKER_INTERNAL_SECRET } }
        );
        console.log(
          `[Avatar ${this.tenantId}] Backfilled ${avatars.length} profile photos ` +
            `(jids=${jidSet.size}, attempted=${attempted}, missed=${missed})`
        );
      } else {
        console.log(
          `[Avatar ${this.tenantId}] No DPs backfilled ` +
            `(jids=${jidSet.size}, attempted=${attempted}, missed=${missed})`
        );
      }
    } catch (err) {
      console.log(`[Avatar ${this.tenantId}] backfill error: ${err.message}`);
    }
  }

  /**
   * Ask WhatsApp for older messages for one chat (on-demand).
   * Results arrive asynchronously via messaging-history.set (already ingested).
   * Free vs OpenAI — this only talks to WhatsApp.
   */
  async requestOnDemandHistory({
    jid,
    oldestMessageId,
    oldestFromMe = false,
    oldestTimestamp,
    count = 50,
  } = {}) {
    if (!this.sockInstance || !this.isConnected) {
      return { ok: false, error: "socket_not_connected" };
    }
    if (!jid || !oldestMessageId || oldestTimestamp == null) {
      return { ok: false, error: "missing_anchor_message" };
    }
    if (typeof this.sockInstance.fetchMessageHistory !== "function") {
      return { ok: false, error: "fetchMessageHistory_unavailable" };
    }

    this.onDemandHistoryAt = this.onDemandHistoryAt || new Map();
    const key = normalizeJid(jid) || jid;
    const lastAt = this.onDemandHistoryAt.get(key) || 0;
    if (Date.now() - lastAt < 20_000) {
      return { ok: true, skipped: true, reason: "throttled" };
    }
    this.onDemandHistoryAt.set(key, Date.now());

    let tsMs = Number(oldestTimestamp);
    if (!Number.isFinite(tsMs) || tsMs <= 0) {
      return { ok: false, error: "bad_timestamp" };
    }
    // DB often stores unix seconds; Baileys PDO wants ms.
    if (tsMs < 1_000_000_000_000) tsMs *= 1000;

    const n = Math.max(5, Math.min(Number(count) || 50, 100));
    try {
      await this.sockInstance.fetchMessageHistory(
        n,
        {
          remoteJid: key,
          id: String(oldestMessageId),
          fromMe: Boolean(oldestFromMe),
        },
        tsMs
      );
      console.log(
        `📥 [OnDemand History ${this.tenantId}] requested ${n} msgs before ` +
          `${oldestMessageId} for ${key}`
      );
      return { ok: true, requested: n, jid: key };
    } catch (err) {
      console.error(
        `[OnDemand History ${this.tenantId}] failed for ${key}:`,
        err?.message || err
      );
      return { ok: false, error: err?.message || "fetch_failed" };
    }
  }
}

// -------------------------------------------------------------------------
// SESSION REGISTRY & LAZY BOOTSTRAP
// -------------------------------------------------------------------------
const sessions = new Map();

function getOrCreateSession(tenantId = "default") {
  const safeId = sanitizeTenantId(tenantId);
  if (!sessions.has(safeId)) {
    sessions.set(safeId, new TenantSession(safeId));
  }
  return sessions.get(safeId);
}

async function startTenantWhatsAppBot(tenantId = "default") {
  const safeId = sanitizeTenantId(tenantId);
  if (!isValidTenantId(safeId)) {
    console.error(
      `[Tenant Guard] Refusing to start WhatsApp bot for invalid tenant_id="${tenantId}"`
    );
    return null;
  }

  const session = getOrCreateSession(safeId);
  if (session.sockInstance) {
    const prev = session.sockInstance;
    session.sockInstance = null;
    disposeSocket(prev);
  }

  // Fresh socket on temporary reconnect must NOT wipe a completed selection latch —
  // that is what stuck the Executive Setup UI at 95% / "SYNCING...".
  const keepReadyLatch = Boolean(
    session.selectionReady ||
      session.historyReadyNotified ||
      (session.isHistorySyncComplete &&
        (session.phonebookSettled ||
          /ready for selection/i.test(String(session.currentProcessingChat || ""))))
  );
  if (keepReadyLatch) {
    console.log(
      `[Reconnect ${session.tenantId}] Preserving selection_ready latch across socket rebuild`
    );
  } else {
    session.syncPhase = "messages";
    session.selectionReady = false;
    session.historyQuiet = false;
    session.contactsSyncInFlight = 0;
    session.lastContactsSyncAt = 0;
    session.secondPhonebookPassDone = false;
    session.phonebookSyncStarted = false;
    session.phonebookSettled = false;
    session.phonebookSettleInFlight = false;
    session.phonebookSettleRunCount = 0;
    session.lastSettledUsableContacts = -1;
    session.pendingFinalSettle = false;
    session.activeTenDayJids = new Set();
    session.pendingReadyReason = null;
    session.phonebookNameHits = 0;
    session.phonebookNotifyHits = 0;
    session.backgroundNameEnrichRuns = 0;
    session.backgroundNameEnrichInFlight = false;
    session.historyReadyNotified = false;
    if (session.backgroundNameEnrichTimer) {
      clearTimeout(session.backgroundNameEnrichTimer);
      session.backgroundNameEnrichTimer = null;
    }
    if (session.phonebookSettleTimer) {
      clearTimeout(session.phonebookSettleTimer);
      session.phonebookSettleTimer = null;
    }
    if (session.phonebookSettleTimeout) {
      clearTimeout(session.phonebookSettleTimeout);
      session.phonebookSettleTimeout = null;
    }
    if (session.selectionUnlockTimer) {
      clearTimeout(session.selectionUnlockTimer);
      session.selectionUnlockTimer = null;
    }
  }

  // Yahan session.authDir use hoga (jo session instance ke constructor se linked hai)
  const { state, saveCreds } = await useMultiFileAuthState(session.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true,
  });

  session.sockInstance = sock;
  // Bind in-memory store so contacts.upsert chunks populate before/alongside messages
  session.store.bind(sock.ev);
  sock.ev.on("creds.update", saveCreds);

  /** Apply phonebook contact to addressBookMap + caches; FastAPI renames message rows. */
  const applyAddressBookContact = (c) => {
    if (!c?.id) return;
    session.applyAddressBookContact(c);
    session.notePhonebookContact(c);

    const realName = firstUsableName(c.name, c.notify, c.verifiedName);
    if (!realName || String(realName).includes("@")) return;
    const clean = String(realName).trim();

    trackSyncedContact(session.logicalTenantId(), clean);

    if (session.store?.chats) {
      const existing = session.store.chats.get(c.id) || session.store.chats.get(normalizeJid(c.id));
      if (existing) {
        session.store.chats.set(existing.id || c.id, { ...existing, name: clean, notify: clean });
      } else {
        session.store.chats.set(c.id, { id: c.id, name: clean });
      }
    }
  };

  sock.ev.on("contacts.upsert", (contacts) => {
    console.log("\n=======================================================");
    console.log(`📇 [EVENT: contacts.upsert] Total contacts chunk: ${Array.isArray(contacts) ? contacts.length : 0}`);
    console.log("=======================================================");

    if (Array.isArray(contacts) && contacts.length > 0) {
      console.log("🔍 [CONTACTS SAMPLE]:", JSON.stringify(contacts.slice(0, 2), null, 2));
      summarizeIncomingContacts("UPSERT", contacts);

      let withNameCount = 0;
      let withNotifyCount = 0;
      let matchedActive = 0;

      for (const c of contacts) {
        if (isUsableDisplayName(c.name) || isUsableDisplayName(c.verifiedName)) withNameCount++;
        if (isUsableDisplayName(c.notify)) withNotifyCount++;

        const cId = normalizeJid(c.id) || c.id;
        const cLid = normalizeJid(c.lid) || c.lid;
        const isActive =
          (cId && session.activeTenDayJids.has(cId)) ||
          (cLid && session.activeTenDayJids.has(cLid));
        if (isActive) matchedActive += 1;

        if (
          isActive ||
          isUsableDisplayName(c.name) ||
          c.id?.includes("9654896725") ||
          c.id?.includes("8147355905") ||
          c.id?.includes("9839026529")
        ) {
          console.log(
            `🏷️ [UPSERT TRACE] ${isActive ? "ACTIVE10D" : "OTHER"} | ${contactDebugLabel(c)}`
          );
        }
        applyAddressBookContact(c);
      }

      console.log(
        `📊 [CONTACT STATS] Phonebook .name: ${withNameCount} | PushName .notify: ${withNotifyCount} | matched10dActive=${matchedActive}`
      );
      session.schedulePhonebookSettle(PHONEBOOK_SETTLE_DEBOUNCE_MS);
      session.maybeCompleteFromAuditedContacts("contacts-upsert");
    }

    console.log(`🚀 [BACKEND SYNC] Sending ${Array.isArray(contacts) ? contacts.length : 0} contacts to backend...`);
    session
      .syncContactsToBackend(contacts)
      .then((res) => {
        console.log(`✅ [BACKEND SYNC OK ${session.tenantId}] Synced successfully with status:`, res?.status || "200/OK");
      })
      .catch((err) => {
        console.error(`❌ [Contacts Sync Error ${session.tenantId}]:`, err.message);
      });
  });

  // Full address-book replace from Baileys (phonebook saved names)
  sock.ev.on("contacts.set", ({ contacts }) => {
    if (!Array.isArray(contacts) || !contacts.length) return;
    console.log(`📇 [EVENT: contacts.set] count=${contacts.length}`);
    summarizeIncomingContacts("SET", contacts);
    for (const c of contacts) applyAddressBookContact(c);
    session.schedulePhonebookSettle(PHONEBOOK_SETTLE_DEBOUNCE_MS);
    session.maybeCompleteFromAuditedContacts("contacts-set");
    session.syncContactsToBackend(contacts).catch((err) =>
      console.error(`[Contacts Set Error ${session.tenantId}]`, err.message)
    );
  });

  sock.ev.on("contacts.update", (contacts) => {
    if (Array.isArray(contacts) && contacts.length) {
      console.log(`📇 [EVENT: contacts.update] count=${contacts.length}`);
      summarizeIncomingContacts("UPDATE", contacts);
      for (const c of contacts) applyAddressBookContact(c);
    }
    session.schedulePhonebookSettle(PHONEBOOK_SETTLE_DEBOUNCE_MS);
    session.syncContactsToBackend(contacts).catch((err) =>
      console.error(`[Contacts Sync Error ${session.tenantId}]`, err.message)
    );
  });

  sock.ev.on("lid-mapping.update", ({ lid, pn }) => {
    session.rememberLidPair(lid, pn);
    session.scheduleLidRemap();
  });

  sock.ev.on("connection.update", async (update) => {
    if (session.sockInstance !== sock) return;

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // State latch: ignore QR flashes once we have entered syncing/connected.
      // Baileys often re-emits QR during temporary re-handshake drops.
      if (session.isPastQrStage()) {
        console.log(
          `[Worker ${session.tenantId}] Ignoring QR during latched ${session.deriveAuthState()} state`
        );
      } else {
        try {
          session.currentQRCodeDataUrl = await QRCode.toDataURL(qr);
          session.authLifecycle = "qr_ready";
          session.isConnected = false;
          session.isHistorySyncComplete = false;
          session.historyReadyNotified = false;
          session.historyCompleted = false;
          console.log(`📲 QR ready for tenant [${session.tenantId}] -> http://127.0.0.1:5001/qr?tenant_id=${session.tenantId}`);
          session.notifyAuthStatus("qr_ready").catch(() => {});
        } catch (err) {
          console.error("QR Code generation error:", err);
        }
      }
    }

    if (connection === "close") {
      session.isConnected = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const badSession = statusCode === DisconnectReason.badSession;
      const replaced = statusCode === DisconnectReason.connectionReplaced;
      const shouldReconnect = !loggedOut && !badSession && !replaced;

      console.log(
        `[Worker ${session.tenantId}] connection.close code=${statusCode ?? "?"} ` +
          `reconnect=${shouldReconnect} attempts=${session.reconnectAttempts}`
      );

      if (shouldReconnect) {
        // Re-handshake temporary drop: retain syncing/ready latch — do NOT emit QR.
        if (session.selectionReady || session.historyReadyNotified) {
          session.authLifecycle = "ready";
          console.log(
            `[Worker ${session.tenantId}] Temporary connection drop after selection_ready — retaining READY latch`
          );
          session.notifyAuthStatus("ready", {
            reconnecting: true,
            latched: true,
            selection_ready: true,
            phonebook_settled: true,
            sync_phase: "ready",
            isHistorySyncComplete: true,
          }).catch(() => {});
        } else if (session.isHistorySyncComplete) {
          session.authLifecycle = "connected";
          console.log(
            `[Worker ${session.tenantId}] Temporary connection drop after history — retaining history latch`
          );
          session.notifyAuthStatus("syncing", { reconnecting: true, latched: true }).catch(() => {});
        } else if (session.isSyncing || session.authLifecycle === "syncing") {
          session.authLifecycle = "syncing";
          console.log(
            `[Worker ${session.tenantId}] Temporary connection drop — retaining syncing state`
          );
          session.notifyAuthStatus("syncing", { reconnecting: true, latched: true }).catch(() => {});
        } else {
          session.authLifecycle = session.currentQRCodeDataUrl ? "qr_ready" : "disconnected";
          session.notifyAuthStatus("disconnected", { reconnecting: true }).catch(() => {});
        }
        session.scheduleReconnect(`close:${statusCode ?? "?"}`);
      } else if (replaced) {
        console.log(
          `⚠️ Tenant [${session.tenantId}] Connection replaced — wiping latch and issuing fresh QR`
        );
        // Clear sync latch so UI does not sit on a dead "syncing" loader with no QR
        session.isSyncing = false;
        session.isHistorySyncComplete = false;
        session.historyReadyNotified = false;
        session.historyCompleted = false;
        session.selectionReady = false;
        session.phonebookSettled = false;
        session.authLifecycle = "disconnected";
        session.currentQRCodeDataUrl = null;
        session.notifyAuthStatus("unpaired", {
          forceLifecycle: true,
          forceNotify: true,
          unpaired: true,
          reason: "connection_replaced",
        }).catch(() => {});
        session.scheduleFreshStart();
      } else {
        console.log(
          `🔒 Tenant [${session.tenantId}] ${
            badSession ? "Bad session" : "Logged out"
          }. Wiping credentials and backend data...`
        );

        axios.post("http://127.0.0.1:8000/api/v1/webhook/wipe-tenant-data", {
          tenant_id: session.logicalTenantId(),
          tenant_jid: session.logicalTenantId(),
        }).catch((err) => console.error(`[Wipe Error ${session.tenantId}]`, err.message));

        session.isHistorySyncComplete = false;
        session.historyReadyNotified = false;
        session.authLifecycle = "disconnected";
        session.notifyAuthStatus("unpaired", {
          forceLifecycle: true,
          forceNotify: true,
        }).catch(() => {});
        session.scheduleFreshStart();
      }
    } else if (connection === "open") {
      session.isConnected = true;
      session.reconnectAttempts = 0;
      // Drop QR immediately so polls cannot flap back to the scan screen
      session.currentQRCodeDataUrl = null;
      // Latch permanently to syncing during initial session load
      session.authLifecycle = "syncing";
      // Store phone JID for display / linking only — NEVER as tenant_id
      session.myJid = normalizeJid(sock.user?.id) || null;
      session.myLid = sock.user?.lid ? normalizeJid(sock.user.lid) : null;

      // Keep session keyed only by Firebase tenantId — never alias under WhatsApp phone JID.
      console.log(
        `\n✅ WhatsApp CONNECTED [Tenant: ${session.logicalTenantId()}] as ${session.myJid}${session.myLid ? ` (lid: ${session.myLid})` : ""}`
      );

      // Internal webhook: Firebase UID ↔ WhatsApp phone JID + orphan heal
      session.linkTenantToPhoneJid().catch((err) =>
        console.log(`[Tenant Link ${session.tenantId}] ${err.message}`)
      );

      session.resetHistoryIngest();
      session.loadLidMappingsFromDisk();
      session.scheduleLidRemap();
      // Saved phonebook names come from app-state, not history — force that sync now.
      session.forcePhonebookAppStateSync().catch((err) =>
        console.log(`[PHONEBOOK ${session.tenantId}] ${err.message}`)
      );
      session.cacheParticipatingGroups().catch((err) =>
        console.log(`[Ready ${session.tenantId}] groups fetch: ${err.message}`)
      );
      if (
        session.selectionReady ||
        session.historyReadyNotified ||
        session.ensureSelectionReadyLatch("socket-open")
      ) {
        session.authLifecycle = "ready";
        session.flushPendingReady();
        session.notifyAuthStatus("ready", {
          jid: session.myJid,
          phone_jid: session.myJid,
          selection_ready: true,
          phonebook_settled: true,
          sync_phase: "ready",
          isHistorySyncComplete: true,
        }).catch(() => {});
      } else {
        console.log(`[Worker ${session.tenantId}] Socket open — waiting for messaging-history.set + phonebook`);
        session.historyCompleted = false;
        session.authLifecycle = "syncing";
        session.notifyAuthStatus("syncing", {
          jid: session.myJid,
          phone_jid: session.myJid,
          isHistorySyncComplete: false,
          phonebook_settled: false,
          selection_ready: false,
          sync_phase: session.syncPhase || "messages",
        }).catch(() => {});
        session.beginSync();
        if (session.historyWatchdog) clearTimeout(session.historyWatchdog);
        session.historyWatchdog = setTimeout(() => {
          if (session.isSyncing && !session.syncIdleTimer && !session.isHistorySyncComplete) {
            console.log(`[History Sync ${session.tenantId}] No history chunks yet — idle settle...`);
            session.markSyncActivity();
          }
        }, 15000);
      }
    }
  });

  // 🔴 10-DAY HISTORY INGESTION — fast selection unlock, media continues in background
  sock.ev.on("messaging-history.set", async (payload) => {
    const rawChats = payload?.chats;
    const rawContacts = payload?.contacts;
    const rawMessages = payload?.messages;
    const rawLidMaps = payload?.lidPnMappings;
    const isLatest = payload?.isLatest;
    const ingestStartedAt = Date.now();

    console.log("\n=======================================================");
    console.log(`📥 [EVENT: messaging-history.set]`);
    console.log(`   Raw chats: ${Array.isArray(rawChats) ? rawChats.length : 0}`);
    console.log(`   Raw contacts: ${Array.isArray(rawContacts) ? rawContacts.length : 0}`);
    console.log(`   Raw messages: ${Array.isArray(rawMessages) ? rawMessages.length : 0}`);
    console.log(`   Raw LID-PN maps: ${Array.isArray(rawLidMaps) ? rawLidMaps.length : 0}`);
    console.log(`   isLatest: ${isLatest}`);
    console.log("=======================================================");

    // 1) FAST: in-memory pushName mining before any I/O
    session.minePushNamesFromMessages(rawMessages);

    // 2) GATEKEEPER: drop stale messages/chats only; contacts always pass through
    summarizeIncomingContacts("HISTORY-RAW", rawContacts);
    const {
      chats,
      contacts,
      messages,
      lidPnMappings,
      activeJids,
    } = applyTenDayHistoryGatekeeper({
      chats: rawChats,
      contacts: rawContacts,
      messages: rawMessages,
      lidPnMappings: rawLidMaps,
      sessionActiveJids: session.activeTenDayJids,
    });
    for (const jid of activeJids || []) {
      session.activeTenDayJids.add(jid);
    }

    session.beginSync();
    if (!session.selectionReady) {
      session.authLifecycle = "syncing";
      session.currentProcessingChat = "Connecting & indexing WhatsApp chats...";
    }
    session.totalChatsCount = Math.max(
      Number(session.totalChatsCount || 0),
      Array.isArray(chats) ? chats.length : 0
    );

    // 3) Ingest ALL contacts into addressBookMap (never time-filtered)
    if (Array.isArray(contacts) && contacts.length) {
      console.log("🔍 [HISTORY CONTACTS SAMPLE]:", JSON.stringify(contacts.slice(0, 2), null, 2));
      summarizeIncomingContacts("HISTORY-KEPT", contacts);
      let histNamed = 0;
      let histNotify = 0;
      for (const c of contacts) {
        if (isUsableDisplayName(c.name) || isUsableDisplayName(c.verifiedName)) histNamed++;
        if (isUsableDisplayName(c.notify)) histNotify++;
        applyAddressBookContact(c);
      }
      console.log(
        `📊 [HISTORY CONTACT STATS] Phonebook .name: ${histNamed} | PushName .notify: ${histNotify}`
      );
      // Fire-and-forget backend sync — do not block selection_ready
      session
        .syncContactsToBackend(contacts)
        .then(() => console.log("✅ [HISTORY CONTACTS SYNC] Done"))
        .catch((err) => console.error("❌ [HISTORY CONTACTS SYNC FAILED]:", err.message));
    }

    if (Array.isArray(lidPnMappings) && lidPnMappings.length) {
      console.log("🔗 [LID-PN MAPPINGS SAMPLE]:", JSON.stringify(lidPnMappings.slice(0, 3), null, 2));
      for (const map of lidPnMappings) {
        const lid = map.lid || map.id;
        const pn = map.pn || map.phoneNumber;
        if (lid && pn) {
          session.rememberLidPair(lid, pn);
        }
      }
      session.scheduleLidRemap();
    }

    if (Array.isArray(chats) && chats.length) {
      console.log(`💬 [CHATS PUSH] Pushing ${chats.length} active (≤10d) chats to session`);
      await session.pushInitialChats(chats);
    }

    // 4) Fast text forward (no media I/O) so selection desk unlocks in < 4s
    const { selected } = session.filterHistoryMessagesThreeTier(messages || []);
    console.log(
      `⏱️ [10-DAY FILTER] Gatekept messages: ${messages?.length || 0} -> Tier-selected: ${selected?.length || 0}`
    );
    const payloads = [];
    const currentSessionTenantId = session.logicalTenantId();

    // Resolve each chat DP once (cached) so history rows are not avatar-blank forever.
    const historyAvatarByJid = new Map();
    for (const msg of selected) {
      bumpRamMessage(currentSessionTenantId, msg?.key?.remoteJid, msg?.messageTimestamp);

      const chatJid = normalizeJid(msg.key?.remoteJid);
      const senderJid = msg.key?.remoteJid;
      const contactName =
        (isGroupJid(chatJid) ? session.groupMetaByJid.get(chatJid)?.subject : null) ||
        session.getResolvedContactName(
          senderJid || chatJid,
          msg.pushName || msg.verifiedBizName
        );

      if (!session.selectionReady) {
        session.currentProcessingChat = contactName;
      }
      session.totalProcessed = Number(session.totalProcessed || 0) + 1;
      const ram = getStats(currentSessionTenantId);
      if (ram.messagesCount < session.totalProcessed) {
        ram.messagesCount = session.totalProcessed;
      }
      trackSyncedContact(currentSessionTenantId, contactName);

      // Skip media on the hot path — download in background after unlock
      const payload = await session.buildPayloadFromWaMessage(msg, {
        isHistory: true,
        mediaPath: null,
        mediaType: null,
        fast: true,
      });
      if (payload) {
        const avatarKey = payload.sender_jid || chatJid;
        if (avatarKey && !historyAvatarByJid.has(avatarKey)) {
          historyAvatarByJid.set(
            avatarKey,
            await session.resolveAvatarUrl(avatarKey).catch(() => null)
          );
        }
        payload.avatar_url = historyAvatarByJid.get(avatarKey) || null;
        payloads.push(payload);
      }
    }

    console.log(`📦 [BATCH FORWARD] Forwarding ${payloads.length} message payloads to backend...`);
    if (payloads.length) {
      await session.forwardHistoryBatch(payloads);
    }

    // 5) Unlock Selection Desk immediately — do NOT wait for settle debounce loops.
    // Skip empty early contact-only batches so the desk isn't opened with zero chats.
    if (!session.selectionReady) {
      const hasSelectionSignal =
        payloads.length > 0 ||
        (Array.isArray(chats) && chats.length > 0) ||
        Boolean(isLatest);
      if (hasSelectionSignal) {
        const elapsed = Date.now() - ingestStartedAt;
        console.log(
          `🏁 [SYNC STATUS] Fast selection unlock after ${elapsed}ms ` +
            `(isLatest: ${isLatest}, msgs: ${payloads.length}, chats: ${chats?.length || 0})`
        );
        session.markSelectionReadyFast(
          isLatest ? "history-latest-fast" : "history-ingest-fast"
        );
      } else {
        session.markSyncActivity();
      }
    } else {
      session.markSyncActivity();
    }

    // 6) Background media enrichment (non-blocking for UI)
    if (selected.length) {
      setImmediate(() => {
        (async () => {
          let mediaForwarded = 0;
          for (const msg of selected) {
            try {
              const mediaInfo = await session.handleMediaDownload(msg);
              if (!mediaInfo?.media_type) continue;
              const payload = await session.buildPayloadFromWaMessage(msg, {
                isHistory: true,
                mediaPath: mediaInfo.file_name || null,
                mediaType: mediaInfo.media_type || null,
                mediaBase64: mediaInfo.media_base64 || null,
                caption: mediaInfo.caption || null,
                fast: true,
              });
              if (payload) {
                await session.forwardToPythonAI(payload);
                mediaForwarded += 1;
              }
            } catch (err) {
              console.error(
                `[Media bg ${session.tenantId}]`,
                err?.message || err
              );
            }
          }
          if (mediaForwarded) {
            console.log(
              `🎞️ [MEDIA BG ${session.tenantId}] Enriched ${mediaForwarded} media messages after selection unlock`
            );
          }
        })().catch((err) =>
          console.error(`[Media bg ${session.tenantId}]`, err?.message || err)
        );
      });
    }

    // Soft enrichment: phonebook app-state can still improve names in the background
    if (isLatest) {
      session.forcePhonebookAppStateSync({ allowSecondPass: true }).catch((err) =>
        console.log(`[PHONEBOOK ${session.tenantId}] ${err.message}`)
      );
    }
  });

  // REALTIME MESSAGES UPSERT — RAM counters first (non-blocking), then heavy work
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;

    const currentSessionTenantId = session.logicalTenantId();

    // Synchronous RAM pass — keeps /sync-status moving even while media/SQLite await
    for (const m of messages || []) {
      const jid = m?.key?.remoteJid;
      if (!jid || jid === "status@broadcast" || String(jid).endsWith("@broadcast")) continue;
      bumpRamMessage(currentSessionTenantId, jid, m.messageTimestamp);
    }

    for (const msg of messages) {
      if (!msg.message) continue;

      const messageId = msg.key?.id;
      if (messageId && session.recentlySentBotIds.has(messageId)) continue;

      const jid = msg.key?.remoteJid;
      if (!jid || jid === "status@broadcast" || String(jid).endsWith("@broadcast")) continue;

      if (type !== "notify") {
        const tsMs = messageTimestampMs(msg);
        const cutoffMs = Date.now() - TEN_DAYS_MS;
        if (!tsMs || tsMs < cutoffMs) continue;
        if (session.historyAlreadyKept(msg)) continue;
        if (isGroupJid(jid)) {
          const already = session.historyGroupCounts.get(jid) || 0;
          if (already >= GROUP_HISTORY_CAP) continue;
          session.historyGroupCounts.set(jid, already + 1);
        }
        session.markHistoryKept([msg]);
      }

      const displayName = msg.key?.fromMe
        ? "You"
        : session.getResolvedContactName(jid, msg.pushName || msg.verifiedBizName);
      trackSyncedContact(currentSessionTenantId, displayName);

      let mediaInfo = null;
      try {
        mediaInfo = await session.handleMediaDownload(msg);
      } catch (mediaErr) {
        console.error(
          `[Media Download Fallback ${session.tenantId}]`,
          mediaErr?.message || mediaErr
        );
      }

      const payload = await session.buildPayloadFromWaMessage(msg, {
        isHistory: type !== "notify",
        mediaPath: mediaInfo?.file_name || null,
        mediaType: mediaInfo?.media_type || null,
        mediaBase64: mediaInfo?.media_base64 || null,
        caption: mediaInfo?.caption || null,
      });
      if (!payload) continue;

      if (payload.sender_name) trackSyncedContact(currentSessionTenantId, payload.sender_name);
      if (payload.participant_name) {
        trackSyncedContact(currentSessionTenantId, payload.participant_name);
      }
      session.maybeCompleteFromAuditedContacts("live-audit");

      let avatarUrl = await session.resolveAvatarUrl(payload.sender_jid);
      if (!avatarUrl && jid !== payload.sender_jid) {
        avatarUrl = await session.resolveAvatarUrl(jid);
      }
      payload.avatar_url = avatarUrl;

      try {
        await session.forwardToPythonAI(payload);
      } catch (err) {
        console.error(`[Webhook Forward Error ${session.tenantId}]`, err?.message || err);
      }

      if (type === "notify") {
        session.scheduleAiDebounce(payload.sender_jid || jid);
      }
    }
  });
}

// -------------------------------------------------------------------------
// MULTI-TENANT HTTP REST SERVER
// -------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Tenant-JID");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  // Session routes that must never bootstrap under empty/"default"
  const requiresStrictTenant =
    pathname === "/qr" || pathname === "/sync-status" || pathname === "/auth-status";

  const tenantId = resolveRequestTenantId(req, urlObj, {
    allowDefault: !requiresStrictTenant,
  });

  if (requiresStrictTenant && !tenantId) {
    console.error(
      `[Tenant Guard] Rejected ${pathname} — missing/invalid tenant_id (got empty or "default")`
    );
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        error: "tenant_id is required and must not be empty or 'default'",
        path: pathname,
      })
    );
  }

  const session = tenantId ? getOrCreateSession(tenantId) : null;

  // Never auto-boot from status/QR polls while a reconnect/fresh-start is queued —
  // that was regenerating QR mid-handshake and flickering the Setup UI.
  if (
    tenantId &&
    session &&
    !session.sockInstance &&
    !session.restartScheduled &&
    !session.reconnectTimer
  ) {
    startTenantWhatsAppBot(tenantId).catch(console.error);
  }

  // 1. QR Code Endpoint
  if (req.method === "GET" && pathname === "/qr") {
    const authState =
      typeof session.deriveAuthState === "function"
        ? session.deriveAuthState()
        : session.isConnected
        ? "syncing"
        : "qr_ready";
    const pastQr = typeof session.isPastQrStage === "function" && session.isPastQrStage();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        connected: Boolean(session.isConnected) || pastQr,
        tenant_id: session.logicalTenantId(),
        tenant_jid: session.logicalTenantId(),
        jid: session.myJid,
        // Hide QR once past scan stage even if data URL still cached in RAM
        qr_image:
          pastQr || authState !== "qr_ready"
            ? null
            : session.currentQRCodeDataUrl || null,
        auth_state: authState,
        status: pastQr ? (session.selectionReady ? "ready" : "syncing") : authState,
      })
    );
  }

  // 2. Sync Status Endpoint — reads RAM only (never touches SQLite / media paths)
  if (req.method === "GET" && pathname === "/sync-status") {
    const tenantKey = session.logicalTenantId();
    const contactsList = recentContactsFor(tenantKey);
    const identifiedChats = auditedContactCount(tenantKey);
    const messagesIndexed = Math.max(
      ramMessagesIndexed(tenantKey),
      Number(session.totalProcessed || 0)
    );
    const historyDone = ramHistoryDone(tenantKey, session);
    const authState = session.deriveAuthState();
    const selectionReady = Boolean(session.selectionReady);
    const syncFields =
      typeof session.buildSyncStatusFields === "function"
        ? session.buildSyncStatusFields()
        : {};

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        tenant_id: tenantKey,
        tenant_jid: tenantKey,
        jid: session.myJid,
        // Never mark ready until selection_ready — historyDone alone is not enough.
        // disconnected must stay disconnected (was incorrectly falling through to "syncing").
        status: selectionReady
          ? "ready"
          : authState === "qr_ready"
          ? "qr_ready"
          : authState === "disconnected"
          ? "disconnected"
          : "syncing",
        isSyncing: !selectionReady && (Boolean(session.isSyncing) || authState === "syncing" || historyDone),
        totalProcessed: messagesIndexed,
        totalChatsCount: identifiedChats,
        currentProcessingChat:
          session.currentProcessingChat ||
          SYNC_PHASE_LABELS[session.syncPhase] ||
          "Syncing messages...",
        connected: Boolean(session.isConnected) || authState === "syncing" || selectionReady,
        historyCompleted: historyDone,
        // Keep history flag for progress, but UI must gate on selection_ready.
        isHistorySyncComplete: selectionReady,
        history_ingest_complete: historyDone,
        messages_indexed: messagesIndexed,
        identified_chats: identifiedChats,
        recent_contacts: contactsList,
        ...syncFields,
      })
    );
  }

  // 3. Health Endpoint
  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "ok",
        tenant_id: session.logicalTenantId(),
        tenant_jid: session.logicalTenantId(),
        connected: session.isConnected,
        my_jid: session.myJid,
        has_qr: Boolean(session.currentQRCodeDataUrl),
        auth_state: typeof session.deriveAuthState === "function" ? session.deriveAuthState() : (session.isConnected ? "ready" : "disconnected"),
        isSyncing: session.isSyncing,
        totalProcessed: session.totalProcessed,
        historyCompleted: session.historyCompleted,
        isHistorySyncComplete: session.isHistorySyncComplete,
      })
    );
  }

  // 4. Auth Status Endpoint — RAM counters only
  if (req.method === "GET" && pathname === "/auth-status") {
    const tenantKey = session.logicalTenantId();
    const authState =
      typeof session.deriveAuthState === "function"
        ? session.deriveAuthState()
        : session.isConnected
        ? "ready"
        : "disconnected";
    const contactsList = recentContactsFor(tenantKey);
    const audited = auditedContactCount(tenantKey);
    const historyDone = ramHistoryDone(tenantKey, session);
    const selectionReady = Boolean(session.selectionReady);
    const messagesIndexed = Math.max(
      ramMessagesIndexed(tenantKey),
      Number(session.totalProcessed || 0)
    );
    const syncFields =
      typeof session.buildSyncStatusFields === "function"
        ? session.buildSyncStatusFields()
        : {};
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        tenant_id: tenantKey,
        tenant_jid: tenantKey,
        status: selectionReady
          ? "ready"
          : authState === "qr_ready"
          ? "qr_ready"
          : authState === "disconnected"
          ? "disconnected"
          : "syncing",
        connected:
          Boolean(session.isConnected) ||
          authState === "syncing" ||
          selectionReady,
        has_qr: Boolean(session.currentQRCodeDataUrl) && authState === "qr_ready",
        jid: session.myJid,
        isSyncing: !selectionReady && (Boolean(session.isSyncing) || authState === "syncing" || historyDone),
        historyCompleted: historyDone,
        isHistorySyncComplete: selectionReady,
        history_ingest_complete: historyDone,
        messages_indexed: messagesIndexed,
        identified_chats: audited,
        totalProcessed: messagesIndexed,
        totalChatsCount: audited,
        recent_contacts: contactsList,
        currentProcessingChat:
          session.currentProcessingChat ||
          SYNC_PHASE_LABELS[session.syncPhase] ||
          "Syncing messages...",
        ...syncFields,
      })
    );
  }

  // 5. Logout Endpoint — wipe session, then bootstrap a fresh socket for QR
  if (req.method === "POST" && pathname === "/logout") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        let bodyTenant = null;
        try {
          bodyTenant = JSON.parse(body)?.tenant_id;
        } catch (_) {}

        const tenantToLogout = sanitizeTenantId(
          bodyTenant ||
            urlObj.searchParams.get("tenant_id") ||
            urlObj.searchParams.get("tenant_jid") ||
            req.headers["x-tenant-jid"] ||
            ""
        );

        if (!isValidTenantId(tenantToLogout)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: "tenant_id is required and must not be empty or 'default'",
            })
          );
        }

        let targetSession = sessions.get(tenantToLogout);
        if (!targetSession) {
          targetSession = getOrCreateSession(tenantToLogout);
        }

        // Block connection.close auto-reconnect / scheduleFreshStart during wipe
        targetSession.restartScheduled = true;

        const sock = targetSession.sockInstance;
        // Null first so connection.update handlers bail out (sockInstance !== sock)
        targetSession.sockInstance = null;

        if (sock) {
          try {
            await sock.logout();
          } catch (err) {
            try {
              sock.end(new Error("User logged out"));
            } catch (_) {}
          }
          disposeSocket(sock);
        }

        // Reset in-memory sync / auth caches before credential wipe
        targetSession.isConnected = false;
        targetSession.currentQRCodeDataUrl = null;
        targetSession.isSyncing = false;
        targetSession.totalProcessed = 0;
        targetSession.historyCompleted = false;
        targetSession.isHistorySyncComplete = false;
        targetSession.historyReadyNotified = false;
        targetSession.currentProcessingChat = "Initializing WhatsApp snapshot...";
        targetSession.totalChatsCount = 0;
        clearRecentContacts(tenantToLogout);
        clearRecentContacts(targetSession.logicalTenantId?.() || tenantToLogout);
        targetSession.resetHistoryIngest();
        if (targetSession.syncIdleTimer) {
          clearTimeout(targetSession.syncIdleTimer);
          targetSession.syncIdleTimer = null;
        }
        if (targetSession.historyWatchdog) {
          clearTimeout(targetSession.historyWatchdog);
          targetSession.historyWatchdog = null;
        }

        // Safe directory wipe with retry for Windows / OneDrive file locks
        let wiped = false;
        try {
          wiped = targetSession.clearAuthFolder();
        } catch (e) {
          console.error(`[Logout ${tenantToLogout}] clearAuthFolder: ${e.message}`);
        }
        if (!wiped || fs.existsSync(targetSession.authDir)) {
          await new Promise((r) => setTimeout(r, 200));
          try {
            if (fs.existsSync(targetSession.authDir)) {
              fs.rmSync(targetSession.authDir, { recursive: true, force: true });
            }
            wiped = !fs.existsSync(targetSession.authDir);
          } catch (e) {
            console.error(`[Logout ${tenantToLogout}] rmSync retry: ${e.message}`);
            wiped = targetSession.clearAuthFolder();
          }
        }

        targetSession.authLifecycle = "qr_ready";
        sessions.set(tenantToLogout, targetSession);

        // Brief pause so Windows releases locks before useMultiFileAuthState recreates dir
        await new Promise((r) => setTimeout(r, 300));

        try {
          if (!fs.existsSync(targetSession.authDir)) {
            fs.mkdirSync(targetSession.authDir, { recursive: true });
          }
        } catch (mkdirErr) {
          console.error(
            `[Logout ${tenantToLogout}] authDir mkdir: ${mkdirErr.message}`
          );
        }

        targetSession.restartScheduled = false;
        startTenantWhatsAppBot(tenantToLogout).catch((err) => {
          console.error(
            `[Logout ${tenantToLogout}] fresh socket bootstrap failed:`,
            err?.message || err
          );
        });

        console.log(
          `🧹 [Worker] Session wiped + fresh QR init for tenant [${tenantToLogout}] (wiped=${wiped})`
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            success: true,
            status: "qr_ready",
            tenant_id: tenantToLogout,
            message: "Session wiped, fresh QR initialized",
          })
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 6b. On-demand chat history (WhatsApp → messaging-history.set → FastAPI ingest)
  if (req.method === "POST" && pathname === "/fetch-history") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const activeTenant = sanitizeTenantId(
          parsed.tenant_id || parsed.tenant_jid || tenantId || ""
        );
        if (!isValidTenantId(activeTenant)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: "tenant_id is required and must not be empty or 'default'",
            })
          );
        }
        const session = getOrCreateSession(activeTenant);
        const result = await session.requestOnDemandHistory({
          jid: parsed.jid || parsed.chat_jid,
          oldestMessageId: parsed.oldest_message_id || parsed.message_id,
          oldestFromMe: Boolean(parsed.oldest_from_me ?? parsed.from_me),
          oldestTimestamp: parsed.oldest_timestamp ?? parsed.timestamp,
          count: parsed.count,
        });
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tenant: activeTenant, ...result }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 6. Send Message Endpoint (Strict Tenant Routing)
  if (req.method === "POST" && pathname === "/send-message") {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const { recipient_jid, text, tenant_id: bodyTenant } = JSON.parse(body);
        const activeTenant = sanitizeTenantId(bodyTenant || tenantId || "");
        if (!isValidTenantId(activeTenant)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({ error: "tenant_id is required and must not be empty or 'default'" })
          );
        }
        const sendSession = getOrCreateSession(activeTenant);

        if (!sendSession.sockInstance || !sendSession.isConnected) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({ error: `WhatsApp socket not connected for tenant [${activeTenant}]` })
          );
        }

        const sent = await sendSession.sockInstance.sendMessage(recipient_jid, { text });
        if (sent?.key?.id) {
          sendSession.recentlySentBotIds.add(sent.key.id);
          setTimeout(() => sendSession.recentlySentBotIds.delete(sent.key.id), 120000);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "sent", to: recipient_jid, tenant: sendSession.tenantId }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.on("error", (err) => {
  console.error("[HTTP server error]", err.message);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.stack || err);
});
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

server.listen(5001, () => {
  console.log("Worker API running on http://127.0.0.1:5001");
  console.log("Multi-Tenant & 10-Day Window Architecture Active.");

  try {
    if (fs.existsSync(BASE_AUTH_DIR)) {
      const existing = fs.readdirSync(BASE_AUTH_DIR).filter((f) => {
        try {
          return fs.statSync(path.join(BASE_AUTH_DIR, f)).isDirectory();
        } catch {
          return false;
        }
      });
      const validTenants = existing
        .map((t) => sanitizeTenantId(t))
        .filter((t) => {
          if (!isValidTenantId(t) || t.includes("trash")) return false;
          // Guest / phone-jid leftovers spam QR + auth-status and starve FastAPI.
          if (t.startsWith("guest_")) return false;
          if (/^\d{10,15}(_s_whatsapp_net)?$/.test(t)) return false;
          return true;
        });

      if (validTenants.length) {
        console.log(`[Auto-Resume] Found ${validTenants.length} tenant folders on disk. Booting...`);
        validTenants.forEach((t) => startTenantWhatsAppBot(t).catch(console.error));
      } else {
        console.log(
          "[Auto-Resume] No valid Firebase tenant sessions on disk — waiting for /qr?tenant_id=..."
        );
      }
    } else {
      console.log("[Startup] auth_sessions missing — waiting for authenticated tenant bootstrap");
    }
  } catch (err) {
    console.error("[Startup Error]", err);
  }
});