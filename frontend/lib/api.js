import axios from "axios";
import { signOut } from "firebase/auth";
import { auth } from "./firebase";

const RAW_API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
const API_ROOT = RAW_API_ROOT.replace(/\/+$/, "");
const API_BASE = `${API_ROOT}/api/v1`;

// ── TENANT SESSION RESOLVER (FIREBASE AUTH & MULTI-TAB SAFE) ────────

const TENANT_STORAGE_KEY = "perisclaw_tenant_jid";
const CONTACTS_CONFIGURED_KEY = "perisclaw_contacts_configured";

/**
 * Priority: Logged-in Firebase User UID -> localStorage -> Fallback 'default'
 */
export function getActiveTenantId() {
  if (typeof window === "undefined") return "default";

  if (auth?.currentUser?.uid) {
    return auth.currentUser.uid;
  }

  const localVal = localStorage.getItem(TENANT_STORAGE_KEY);
  if (localVal && localVal.trim() !== "") {
    return localVal.trim();
  }

  return "default";
}

export function getOrCreateTenantId() {
  return getActiveTenantId();
}

/**
 * Firebase login ya WhatsApp connect hone par ID ko storage me sync karna.
 */
export function setActiveTenantId(realId) {
  if (typeof window !== "undefined" && realId && String(realId).trim()) {
    const cleanId = String(realId).trim();
    localStorage.setItem(TENANT_STORAGE_KEY, cleanId);
    sessionStorage.setItem(TENANT_STORAGE_KEY, cleanId);
  }
}

/**
 * Logout hone par browser session completely wipe karna.
 */
export function clearActiveTenantId() {
  if (typeof window !== "undefined") {
    localStorage.removeItem(TENANT_STORAGE_KEY);
    localStorage.removeItem("user_email");
    localStorage.removeItem("user_name");
    localStorage.removeItem("user_avatar");
    localStorage.removeItem("tenant_jid");
    localStorage.removeItem("google_access_token");
    localStorage.removeItem(CONTACTS_CONFIGURED_KEY);
    sessionStorage.removeItem(TENANT_STORAGE_KEY);
    sessionStorage.removeItem(CONTACTS_CONFIGURED_KEY);
  }
}

/** Local flag set after a successful POST /contacts/set-monitored. */
export function getContactsConfiguredFlag() {
  if (typeof window === "undefined") return false;
  return (
    localStorage.getItem(CONTACTS_CONFIGURED_KEY) === "1" ||
    sessionStorage.getItem(CONTACTS_CONFIGURED_KEY) === "1"
  );
}

export function setContactsConfiguredFlag(value) {
  if (typeof window === "undefined") return;
  if (value) {
    localStorage.setItem(CONTACTS_CONFIGURED_KEY, "1");
    sessionStorage.setItem(CONTACTS_CONFIGURED_KEY, "1");
  } else {
    localStorage.removeItem(CONTACTS_CONFIGURED_KEY);
    sessionStorage.removeItem(CONTACTS_CONFIGURED_KEY);
  }
}

// ── AXIOS CLIENT INSTANCE ──────────────────────────────────────────

export const apiClient = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
});

/**
 * SECURE REQUEST INTERCEPTOR:
 * Injects cryptographic Firebase ID Token into Authorization header.
 * Backend verifies the token signature so tenant UID cannot be spoofed.
 */
apiClient.interceptors.request.use(async (config) => {
  config.headers = config.headers || {};

  try {
    const currentUser = auth?.currentUser;
    if (currentUser) {
      // Force refresh if token is close to expiry
      const token = await currentUser.getIdToken();
      config.headers["Authorization"] = `Bearer ${token}`;
    }
  } catch (err) {
    console.warn("[Auth Interceptor] Failed to attach Firebase ID Token:", err?.message || err);
  }

  // Fallback context header for backward compatibility
  const currentTenant = getActiveTenantId();
  config.headers["X-Tenant-JID"] = currentTenant;

  config.params = config.params || {};
  if (!config.params.tenant_jid && !config.params.tenant_id) {
    config.params.tenant_jid = currentTenant;
  }

  return config;
});

// ── TASKS & ASSISTANT ──────────────────────────────────────────────

export async function fetchTasks(status = "PENDING") {
  const response = await apiClient.get("/tasks", {
    params: { status },
    timeout: 5000,
  });
  return response.data;
}

export async function updateTaskStatus(taskId, status) {
  const response = await apiClient.patch(`/tasks/${taskId}/status`, { status });
  return response.data;
}

/**
 * Auth status is routed strictly through FastAPI backend.
 * Worker port is never exposed directly to the browser.
 * Includes qr_image, sync progress, and hasConfiguredContacts.
 */
export async function fetchAuthStatus() {
  try {
    const response = await apiClient.get("/auth/status", { timeout: 5000 });
    const data = response.data;

    // Prefer Firebase UID tenant fields — never overwrite with WhatsApp phone JID.
    const tenantKey = data?.tenant_id || data?.tenant_jid;
    if (tenantKey && !String(tenantKey).includes("@") && !String(tenantKey).startsWith("guest_")) {
      setActiveTenantId(tenantKey);
    }
    return data;
  } catch (err) {
    return {
      status: "disconnected",
      connected: false,
      qr_image: null,
      isHistorySyncComplete: false,
      selection_ready: false,
      phonebook_settled: false,
      sync_phase: "messages",
      hasConfiguredContacts: false,
      recent_contacts: [],
      worker_online: false,
      error: err?.response?.data?.detail || "Auth status unreachable",
    };
  }
}

/** @deprecated Prefer fetchAuthStatus — QR is now part of GET /auth/status. */
export async function fetchQrStatus() {
  const data = await fetchAuthStatus();
  const connected = Boolean(
    data?.connected ||
      data?.status === "ready" ||
      data?.status === "syncing" ||
      data?.status === "connected"
  );
  return {
    ...data,
    connected,
    qr_image: connected ? null : data?.qr_image || null,
  };
}

export async function fetchSyncStatus() {
  try {
    const response = await apiClient.get("/assistant/sync-status", { timeout: 2000 });
    const data = response.data;

    const tenantKey = data?.tenant_id || data?.tenant_jid;
    if (tenantKey && !String(tenantKey).includes("@") && !String(tenantKey).startsWith("guest_")) {
      setActiveTenantId(tenantKey);
    }

    return data;
  } catch {
    return {
      isSyncing: false,
      totalProcessed: 0,
      connected: false,
      historyCompleted: false,
      isHistorySyncComplete: false,
      selection_ready: false,
      phonebook_settled: false,
      sync_phase: "messages",
      recent_contacts: [],
      error: "Worker offline",
    };
  }
}

export async function searchContactAudit(query) {
  const response = await apiClient.post(
    "/audit/search",
    { query },
    { timeout: 20000 }
  );
  return response.data;
}

export async function draftFollowUp(taskId) {
  const response = await apiClient.post("/assistant/draft-followup", {
    task_id: taskId,
  });
  return response.data;
}

export async function sendWhatsAppMessage(recipientJid, message) {
  const response = await apiClient.post("/assistant/send", {
    recipient_jid: recipientJid,
    message,
  });
  return response.data;
}

/**
 * Tier 1 — App Sign Out:
 * Signs out of the web dashboard only. WhatsApp pairing stays alive on the
 * server so the next Google login can skip the QR scan.
 * Does NOT call POST /assistant/logout or wipe auth_sessions.
 */
export async function signOutApp() {
  try {
    if (auth) await signOut(auth);
  } catch (err) {
    console.warn("[App Sign Out] Firebase notice:", err?.message || err);
  } finally {
    clearActiveTenantId();
  }
  return { status: "success", tier: "app" };
}

/**
 * Tier 2 — Disconnect WhatsApp:
 * Explicit unpair: awaits FastAPI POST /assistant/logout until the worker
 * has wiped auth_sessions/{tenant_id} and bootstrapped a fresh QR socket.
 * Caller must Firebase signOut + redirect only AFTER this resolves.
 */
export async function logoutWhatsApp() {
  const tenant = getActiveTenantId();

  // Step A: Request worker unpair and wait for verified acknowledgment
  const response = await apiClient.post(
    `/assistant/logout`,
    { tenant_id: tenant },
    { timeout: 20000 }
  );

  // Step B: Purge browser persistence only after backend confirms wipe
  setContactsConfiguredFlag(false);
  clearActiveTenantId();
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(TENANT_STORAGE_KEY);
      localStorage.removeItem("perisclaw_tenant_jid");
      sessionStorage.clear();
    } catch {
      /* storage unavailable */
    }
  }

  return {
    status: "success",
    tenant_jid: tenant,
    tier: "whatsapp",
    ...(response?.data || {}),
  };
}

export const logoutAssistant = logoutWhatsApp;

// ── MATTERS & SYNTHESIS ────────────────────────────────────────────

export async function fetchMatters({ status, search } = {}) {
  const params = {};
  if (status && String(status).toUpperCase() !== "ALL") params.status = status;
  if (search && String(search).trim()) params.search = String(search).trim();
  const response = await apiClient.get("/matters", { params, timeout: 5000 });
  return response.data;
}

export async function syncRecentMatters() {
  const response = await apiClient.post("/matters/sync-recent", {}, { timeout: 180000 });
  return response.data;
}

export async function fetchMatterDetails(matterId) {
  const response = await apiClient.get(`/matters/${matterId}/details`, { timeout: 5000 });
  return response.data;
}

export async function fetchMatterChat(matterId) {
  const response = await apiClient.get(`/matters/${matterId}/raw-chat`, {
    params: { limit: 80 },
    timeout: 5000,
  });
  return response.data;
}

export async function sendMatterDraft(matterId, payload) {
  const response = await apiClient.post(`/matters/${matterId}/send-draft`, payload, {
    timeout: 8000,
  });
  return response.data;
}

export async function toggleMatterStep(stepId) {
  const response = await apiClient.patch(`/matters/steps/${stepId}/toggle`);
  return response.data;
}

// ── INBOX (RAW WHATSAPP CHATS) ─────────────────────────────────────

export async function fetchInboxChats(search = "") {
  const params = search ? { search } : {};
  const res = await apiClient.get("/inbox/chats", { params, timeout: 5000 });
  return res.data;
}

export async function fetchInboxMessages(jid, limit = 100) {
  const res = await apiClient.get(
    `/inbox/chats/${encodeURIComponent(jid)}/messages`,
    { params: { limit }, timeout: 5000 }
  );
  return res.data;
}

export async function sendInboxMessage(jid, text) {
  const res = await apiClient.post(
    `/inbox/chats/${encodeURIComponent(jid)}/send`,
    { text },
    { timeout: 8000 }
  );
  return res.data;
}

export async function transcribeInboxAudio(jid) {
  const res = await apiClient.post(
    `/inbox/chats/${encodeURIComponent(jid)}/transcribe`,
    {},
    { timeout: 120000 }
  );
  return res.data;
}

// ── CHAT SUMMARY ───────────────────────────────────────────────────

export async function fetchChatSummary(jid) {
  const res = await apiClient.get(`/summary/${encodeURIComponent(jid)}`, {
    timeout: 5000,
  });
  return res.data;
}

export async function generateChatSummary(jid) {
  const res = await apiClient.post(
    `/summary/${encodeURIComponent(jid)}/generate`,
    {},
    { timeout: 90000 }
  );
  return res.data;
}

// ── CONTACTS / SETTINGS GATE ───────────────────────────────────────

export async function fetchRecentActiveContacts() {
  const response = await apiClient.get("/contacts/recent-active", { timeout: 20000 });
  return response.data;
}

/** Upload phone-exported .vcf / .csv to map saved names onto WhatsApp contacts. */
export async function importPhonebook(file) {
  const form = new FormData();
  form.append("file", file);
  const response = await apiClient.post("/contacts/import-phonebook", form, {
    timeout: 60000,
  });
  return response.data;
}

const GOOGLE_ACCESS_TOKEN_KEY = "google_access_token";

export function storeGoogleAccessToken(token) {
  if (typeof window === "undefined") return;
  try {
    if (token) {
      localStorage.setItem(GOOGLE_ACCESS_TOKEN_KEY, String(token));
    } else {
      localStorage.removeItem(GOOGLE_ACCESS_TOKEN_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function getGoogleAccessToken() {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(GOOGLE_ACCESS_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

/** Sync Google People API contacts → WhatsApp contacts.name via last-10 digit match. */
export async function syncGoogleContacts(accessToken) {
  const token = String(accessToken || getGoogleAccessToken() || "").trim();
  if (!token) {
    throw new Error("Google access token missing — sign in again with Contacts access.");
  }
  storeGoogleAccessToken(token);
  const response = await apiClient.post(
    "/contacts/sync-google",
    {
      access_token: token,
      tenant_jid: getActiveTenantId(),
    },
    { timeout: 90000 }
  );
  return response.data;
}

export async function setMonitoredContacts(selectedJids = []) {
  const response = await apiClient.post(
    "/contacts/set-monitored",
    {
      tenant_jid: getActiveTenantId(),
      selected_jids: selectedJids,
    },
    { timeout: 10000 }
  );
  if (Array.isArray(selectedJids) && selectedJids.length > 0) {
    setContactsConfiguredFlag(true);
  } else {
    setContactsConfiguredFlag(false);
  }
  return response.data;
}

export async function processSelectedMatters(selectedJids = []) {
  const response = await apiClient.post(
    "/matters/process-selected",
    {
      tenant_jid: getActiveTenantId(),
      selected_jids: selectedJids,
    },
    { timeout: 10000 }
  );
  return response.data;
}

/**
 * Queue ChatAuditJob rows and kick the async audit pool.
 * Returns immediately (200) so the UI can navigate to Today Desk while
 * matter cards stream in one-by-one as each chat finishes.
 */
export async function initializeAuditJobs(contacts = []) {
  const payload = {
    contacts: (Array.isArray(contacts) ? contacts : [])
      .filter((c) => c && (c.jid || c.id))
      .map((c) => ({
        jid: String(c.jid || c.id).trim(),
        name: String(c.name || c.display_name || c.pushName || "Unknown Contact").trim() || "Unknown Contact",
        isGroup: Boolean(c.isGroup ?? c.is_group),
      })),
  };
  const response = await apiClient.post("/assistant/initialize-audit-jobs", payload, {
    timeout: 15000,
  });
  return response.data;
}

/** Recovery: queue audits for already-monitored chats when Today Desk is empty. */
export async function bootstrapAuditFromMonitored() {
  const response = await apiClient.post(
    "/assistant/bootstrap-audit-from-monitored",
    {},
    { timeout: 15000 }
  );
  return response.data;
}

// ── TODAY DESK (MatterCard progressive stream) ─────────────────────

export async function fetchMatterCards({ status, search } = {}) {
  const params = {};
  if (status && String(status).toLowerCase() !== "all") params.status = status;
  if (search && String(search).trim()) params.search = String(search).trim();
  const response = await apiClient.get("/matters/cards", { params, timeout: 8000 });
  const data = response.data || {};
  const cards = Array.isArray(data.cards)
    ? data.cards
    : Array.isArray(data.matters)
      ? data.matters
      : Array.isArray(data)
        ? data
        : [];
  return {
    ...data,
    cards,
    matters: cards,
    counts: data.counts || { needs_you: 0, total: cards.length },
  };
}

export async function fetchAuditProgress() {
  const response = await apiClient.get("/matters/audit-progress", { timeout: 5000 });
  return response.data;
}

export async function updateMatterCardStatus(matterId, newStatus) {
  const response = await apiClient.patch(`/matters/${encodeURIComponent(matterId)}/status`, {
    new_status: newStatus,
  });
  return response.data;
}

export async function matterCardAction(matterId, payload = {}) {
  const response = await apiClient.post(
    `/matters/${encodeURIComponent(matterId)}/action`,
    payload,
    { timeout: 8000 }
  );
  return response.data;
}