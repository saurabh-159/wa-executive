"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase";
import {
  AlertTriangle,
  Check,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Mic,
  RefreshCw,
  Search,
  Smartphone,
  Unplug,
  Upload,
  User,
  Users,
  X,
} from "lucide-react";
import { DeskServerError } from "@/components/dashboard/DeskStates";
import { useToast } from "@/components/ui/ToastProvider";
import {
  fetchAuthStatus,
  fetchRecentActiveContacts,
  getContactsConfiguredFlag,
  getGoogleAccessToken,
  importPhonebook,
  initializeAuditJobs,
  logoutWhatsApp,
  setMonitoredContacts,
  setContactsConfiguredFlag,
  storeGoogleAccessToken,
  syncGoogleContacts,
} from "@/lib/api";
import { completeLogoutRedirect } from "@/lib/sessionCleanup";
import { avatarTone, initials } from "@/lib/matters";
import { markBackgroundAnalysis } from "@/lib/syncSession";
import { cn } from "@/lib/utils";

const SETUP_BANNER_KEY = "perisclaw_setup_banner";
const SETUP_BANNER_MSG =
  "Please select active chats from the last 10 days to monitor before proceeding.";

const SCAN_STEPS = [
  "Indexing last 10 days of chats…",
  "Attaching media…",
  "Syncing contacts…",
  "Resolving contact names…",
  "Opening selection desk…",
];

const SYNC_PHASE_STEP = {
  messages: 0,
  media: 1,
  contacts: 2,
  names: 3,
  ready: 4,
};

const SCAN_BARRIER_TIMEOUT_MS = 60000;

const CARD_SHADOW = "0 1px 3px rgba(15, 23, 42, 0.05), 0 6px 16px rgba(15, 23, 42, 0.04)";
const ROW_SELECTED_SHADOW = "0 1px 2px rgba(15, 23, 42, 0.04)";

function isSelectionReady(authStatus) {
  if (!authStatus) return false;
  return Boolean(
    authStatus.selection_ready ||
      authStatus.sync_phase === "ready" ||
      (authStatus.status === "ready" && authStatus.phonebook_settled)
  );
}

function phaseStep(authStatus) {
  const phase = authStatus?.sync_phase;
  if (phase && phase in SYNC_PHASE_STEP) return SYNC_PHASE_STEP[phase];
  if (isSelectionReady(authStatus)) return 4;
  return 0;
}

function formatPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length > 10) {
    const local = digits.slice(-10);
    const cc = digits.slice(0, -10);
    return `+${cc} ${local.slice(0, 5)} ${local.slice(5)}`;
  }
  if (digits.length === 10) return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  return digits;
}

function contactMatchesQuery(contact, query) {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const name = String(contact?.name || "").toLowerCase();
  const phone = String(contact?.phone_number || "").toLowerCase();
  const jid = String(contact?.jid || "").toLowerCase();
  return name.includes(q) || phone.includes(q) || jid.includes(q);
}

function ScanBarrier({ step, timedOut = false, onContinue, syncInfo }) {
  const active = Math.max(0, Math.min(step, SCAN_STEPS.length - 1));
  const phaseLabel = SCAN_STEPS[active];

  return (
    <div
      className="flex h-full min-h-0 items-center justify-center bg-canvas px-6"
      role="status"
      aria-live="polite"
      aria-busy={!timedOut}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-line bg-surface px-8 py-10"
        style={{ boxShadow: CARD_SHADOW }}
      >
        <div className="relative mx-auto mb-6 grid h-16 w-16 place-items-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-saffron/25" />
          <span className="absolute inset-1.5 animate-pulse rounded-full bg-gradient-to-br from-saffron to-orange-400" />
          <span className="relative grid h-11 w-11 place-items-center rounded-full bg-surface text-sm font-bold text-saffron">
            P
          </span>
        </div>
        <p className="text-center text-[10px] font-semibold uppercase tracking-[0.2em] text-saffron">
          Perisclaw Executive AI
        </p>
        <h1 className="mt-2 text-center text-xl font-bold tracking-tight text-ink">
          {timedOut ? "Taking longer than usual" : "Preparing Your Executive Desk"}
        </h1>

        {timedOut ? (
          <p className="mt-3 text-center text-sm text-muted">
            WhatsApp is linked. You can proceed to select contacts while final name mapping finishes in the
            background.
          </p>
        ) : (
          <p className="mt-2 text-center text-xs text-muted">{phaseLabel}</p>
        )}

        {syncInfo && !timedOut && (
          <div className="mt-6 rounded-2xl border border-line bg-canvas p-4">
            <div className="mb-2 flex items-center justify-between text-xs font-semibold text-muted">
              <span>Messages Synced</span>
              <span className="font-mono font-bold text-saffron">{syncInfo.processed || 0}</span>
            </div>
            {(syncInfo.currentChat || phaseLabel) && (
              <div className="flex items-center gap-2 truncate text-[11px] text-muted">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                <span className="truncate">{syncInfo.currentChat || phaseLabel}</span>
              </div>
            )}
          </div>
        )}

        <ol className="mt-6 space-y-4">
          {SCAN_STEPS.map((label, index) => {
            const done = index < active || timedOut;
            const current = !timedOut && index === active;
            return (
              <li key={label} className="flex items-center gap-3">
                <span
                  className={cn(
                    "grid h-7 w-7 shrink-0 place-items-center rounded-full border text-[11px] font-semibold",
                    done && "border-saffron/30 bg-saffron-soft text-saffron",
                    current && "border-saffron bg-saffron text-on-saffron",
                    !done && !current && "border-line bg-canvas text-muted/40"
                  )}
                >
                  {done ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : current ? (
                    <span className="h-2 w-2 animate-pulse rounded-full bg-on-saffron" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span
                  className={cn(
                    "text-sm",
                    current && "font-semibold text-ink",
                    done && "text-muted",
                    !done && !current && "text-muted/40"
                  )}
                >
                  {label}
                </span>
                {current ? (
                  <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin text-saffron" />
                ) : null}
              </li>
            );
          })}
        </ol>

        {timedOut && typeof onContinue === "function" ? (
          <button
            type="button"
            onClick={onContinue}
            className="mt-8 inline-flex w-full items-center justify-center rounded-2xl bg-saffron px-4 py-3 text-sm font-bold text-on-saffron shadow-[var(--shadow-glow-saffron)] transition hover:bg-saffron-deep"
          >
            Continue to contacts selection
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ContactAvatar({ name, avatarUrl, isGroup = false }) {
  const [failed, setFailed] = useState(false);
  if (avatarUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt={name || ""}
        referrerPolicy="no-referrer"
        className="h-11 w-11 shrink-0 rounded-full object-cover ring-2 ring-white shadow-sm"
        onError={() => setFailed(true)}
      />
    );
  }
  if (isGroup) {
    return (
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-500 ring-2 ring-white shadow-sm">
        <Users className="h-4 w-4" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "grid h-11 w-11 shrink-0 place-items-center rounded-full text-sm font-semibold ring-2 ring-white shadow-sm",
        avatarTone(name)
      )}
    >
      {initials(name)}
    </span>
  );
}

function ContactRow({ contact, selected, onToggle }) {
  const phone = formatPhone(contact.phone_number || (!contact.is_group ? contact.jid?.split("@")[0] : ""));
  const subtitle = contact.is_group
    ? `${contact.total_msgs || 0} message${(contact.total_msgs || 0) === 1 ? "" : "s"}`
    : phone || `${contact.total_msgs || 0} msgs`;

  return (
    <button
      type="button"
      onClick={() => onToggle(contact.jid)}
      className={cn(
        "flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition",
        selected
          ? "border-orange-200 bg-orange-50/50"
          : "border-slate-100 bg-white hover:border-slate-200 hover:bg-slate-50/70"
      )}
      style={selected ? { boxShadow: ROW_SELECTED_SHADOW } : undefined}
    >
      <span
        className={cn(
          "grid h-5 w-5 shrink-0 place-items-center rounded-md border",
          selected
            ? "border-orange-500 bg-orange-500 text-white"
            : "border-slate-300 bg-white text-transparent"
        )}
        aria-hidden
      >
        <Check className="h-3.5 w-3.5" />
      </span>
      <ContactAvatar
        name={contact.name}
        avatarUrl={contact.avatar_url}
        isGroup={Boolean(contact.is_group)}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-900">
          {contact.name || contact.jid?.split("@")[0]}
        </p>
        <p className="mt-0.5 truncate text-xs text-slate-500">{subtitle}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-[11px] font-semibold tabular-nums text-slate-500">
          {contact.total_msgs || 0} msgs
        </span>
        <div className="flex items-center gap-1">
          {(contact.audio_count || 0) > 0 ? (
            <span className="inline-flex items-center gap-0.5 rounded-full border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">
              <Mic className="h-3 w-3" />
              {contact.audio_count}
            </span>
          ) : null}
          {(contact.image_count || 0) > 0 ? (
            <span className="inline-flex items-center gap-0.5 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">
              <ImageIcon className="h-3 w-3" />
              {contact.image_count}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function ContactsColumnSkeleton({ rows = 6 }) {
  return (
    <div className="space-y-2.5" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 rounded-2xl border border-slate-100 bg-white px-3 py-3"
        >
          <div className="h-5 w-5 shrink-0 animate-pulse rounded-md bg-slate-100" />
          <div className="h-11 w-11 shrink-0 animate-pulse rounded-full bg-slate-100" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-2/3 animate-pulse rounded-md bg-slate-100" />
            <div className="h-2.5 w-1/3 animate-pulse rounded-md bg-slate-50" />
          </div>
          <div className="h-2.5 w-10 animate-pulse rounded-md bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

function ContactsEmptyState({ onRefresh, refreshing = false }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-50 text-slate-400">
        <MessageSquare className="h-5 w-5" />
      </div>
      <p className="mt-4 text-sm font-semibold text-slate-900">
        No active conversations found in the last 10 days
      </p>
      <p className="mt-1 text-sm text-slate-500">
        Sync may still be catching up. Refresh to re-check your WhatsApp index.
      </p>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="mt-5 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 disabled:opacity-60"
      >
        {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Retry / Refresh Contacts
      </button>
    </div>
  );
}

function ConversationColumn({
  title,
  items,
  selected,
  onToggle,
  onSelectAll,
  onDeselectAll,
  search,
  onSearchChange,
  searchPlaceholder,
  loading,
  emptyLabel,
  embedded = false,
}) {
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.jid));
  const noneSelected = items.every((item) => !selected.has(item.jid));

  return (
    <section
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-3xl bg-white",
        embedded ? "rounded-2xl border border-slate-100" : "border border-slate-200/70"
      )}
      style={embedded ? undefined : { boxShadow: CARD_SHADOW }}
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-100/90 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-bold text-slate-900">{title}</h2>
          <span className="grid h-6 min-w-6 place-items-center rounded-full bg-orange-500 px-1.5 text-[11px] font-bold text-white tabular-nums">
            {loading ? "…" : items.length}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs font-semibold">
          <button
            type="button"
            onClick={onSelectAll}
            disabled={loading || items.length === 0 || allSelected}
            className="text-orange-600 transition hover:text-orange-700 disabled:opacity-35"
          >
            Select All
          </button>
          <button
            type="button"
            onClick={onDeselectAll}
            disabled={loading || noneSelected}
            className="text-slate-500 transition hover:text-slate-800 disabled:opacity-35"
          >
            Deselect All
          </button>
        </div>
      </div>

      <div className="border-b border-slate-100 px-3 py-2">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            disabled={loading}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-orange-300 focus:bg-white focus:ring-2 focus:ring-orange-100 disabled:opacity-60"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2.5">
        {loading ? (
          <ContactsColumnSkeleton />
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-10 text-center">
            <p className="text-sm font-semibold text-slate-800">{emptyLabel}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((contact) => (
              <ContactRow
                key={contact.jid}
                contact={contact}
                selected={selected.has(contact.jid)}
                onToggle={onToggle}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function useContactSelection({ enabled = true, preselectAllDmsIfEmpty = true } = {}) {
  const { push } = useToast();
  const [dms, setDms] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [loadingContacts, setLoadingContacts] = useState(Boolean(enabled));
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [importingPhonebook, setImportingPhonebook] = useState(false);
  const [syncingGoogle, setSyncingGoogle] = useState(false);
  const [dmQuery, setDmQuery] = useState("");
  const [groupQuery, setGroupQuery] = useState("");
  const phonebookInputRef = useRef(null);

  const loadContacts = useCallback(async ({ silent = false } = {}) => {
    if (!enabled) return;
    if (!silent) setLoadingContacts(true);
    setError(null);
    try {
      try {
        const authStatus = await fetchAuthStatus();
        if (!isSelectionReady(authStatus)) {
          console.info(
            "[SelectionDesk] selection_ready not latched yet — loading recent-active anyway"
          );
        }
      } catch {
        /* proceed */
      }

      const res = await fetchRecentActiveContacts();
      const payload = res?.data || {};

      let nextDms = Array.isArray(payload.dms) ? payload.dms : [];
      let nextGroups = Array.isArray(payload.groups) ? payload.groups : [];

      if (!nextDms.length && !nextGroups.length && Array.isArray(res?.contacts)) {
        const flat = res.contacts;
        nextDms = flat.filter((c) => c && c.is_group === false);
        nextGroups = flat.filter((c) => c && c.is_group === true);
      }

      setDms(nextDms);
      setGroups(nextGroups);

      setSelected((prev) => {
        const preselected = new Set();
        [...nextDms, ...nextGroups].forEach((item) => {
          if (item?.is_monitored && item?.jid) preselected.add(item.jid);
        });

        if (preselected.size === 0 && preselectAllDmsIfEmpty) {
          // Soft refresh: keep user's current ticks; only auto-select on first empty load.
          if (silent && prev.size > 0) return prev;
          nextDms.forEach((item) => {
            if (item?.jid) preselected.add(item.jid);
          });
        }

        if (silent && prev.size > 0) {
          // Preserve in-progress selection; drop JIDs that disappeared.
          const alive = new Set(
            [...nextDms, ...nextGroups].map((item) => item?.jid).filter(Boolean)
          );
          const merged = new Set();
          prev.forEach((jid) => {
            if (alive.has(jid)) merged.add(jid);
          });
          preselected.forEach((jid) => merged.add(jid));
          return merged;
        }
        return preselected;
      });
    } catch (err) {
      setError(err?.response?.data?.detail || err?.message || "Could not load contacts");
    } finally {
      if (!silent) setLoadingContacts(false);
    }
  }, [enabled, preselectAllDmsIfEmpty]);

  useEffect(() => {
    if (!enabled) {
      setLoadingContacts(false);
      return;
    }
    loadContacts();
    // Late phonebook / Google names land after fast unlock — soft refresh twice, no spinner spam.
    const t1 = window.setTimeout(() => loadContacts({ silent: true }), 6000);
    const t2 = window.setTimeout(() => loadContacts({ silent: true }), 14000);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [enabled, loadContacts]);

  const contacts = useMemo(() => [...dms, ...groups], [dms, groups]);
  const filteredDms = useMemo(
    () => dms.filter((c) => contactMatchesQuery(c, dmQuery)),
    [dms, dmQuery]
  );
  const filteredGroups = useMemo(
    () => groups.filter((c) => contactMatchesQuery(c, groupQuery)),
    [groups, groupQuery]
  );
  const selectedCount = selected.size;

  const toggleOne = (jid) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(jid)) next.delete(jid);
      else next.add(jid);
      return next;
    });
  };

  const selectAllIn = (list) => {
    setSelected((prev) => {
      const next = new Set(prev);
      list.forEach((item) => {
        if (item?.jid) next.add(item.jid);
      });
      return next;
    });
  };

  const deselectAllIn = (list) => {
    setSelected((prev) => {
      const next = new Set(prev);
      list.forEach((item) => {
        if (item?.jid) next.delete(item.jid);
      });
      return next;
    });
  };

  const handlePhonebookFile = async (event) => {
    const file = event?.target?.files?.[0];
    if (event?.target) event.target.value = "";
    if (!file || importingPhonebook || submitting) return;

    setImportingPhonebook(true);
    try {
      const result = await importPhonebook(file);
      const updated = Number(result?.updated_contacts || 0);
      const matched = Number(result?.matched || 0);
      push(
        updated > 0
          ? `Phonebook mapped: ${updated} name${updated === 1 ? "" : "s"} applied (${matched} matched).`
          : matched > 0
            ? `Phonebook checked: ${matched} already had names or matched without updates.`
            : result?.message || "No matching WhatsApp chats found for numbers in this file."
      );
      await loadContacts();
    } catch (err) {
      push(err?.response?.data?.detail || err?.message || "Phonebook import failed");
    } finally {
      setImportingPhonebook(false);
    }
  };

  const handleSyncGoogleContacts = async () => {
    if (syncingGoogle || submitting || importingPhonebook) return;
    setSyncingGoogle(true);
    try {
      let token = getGoogleAccessToken();
      if (!token && auth && googleProvider) {
        const result = await signInWithPopup(auth, googleProvider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        token = credential?.accessToken || "";
        if (token) storeGoogleAccessToken(token);
      }
      if (!token) {
        push("Could not get Google Contacts permission. Sign in again and allow Contacts.");
        return;
      }
      const result = await syncGoogleContacts(token);
      const updated = Number(result?.updated_contacts || 0);
      const matched = Number(result?.matched || 0);
      push(
        updated > 0
          ? `Google Contacts: ${updated} name${updated === 1 ? "" : "s"} applied (${matched} matched).`
          : matched > 0
            ? `Google Contacts checked: ${matched} already had saved names.`
            : result?.message || "No Google phone numbers matched WhatsApp chats yet."
      );
      await loadContacts();
    } catch (err) {
      push(err?.response?.data?.detail || err?.message || "Google Contacts sync failed");
    } finally {
      setSyncingGoogle(false);
    }
  };

  const saveSelection = async ({ onSuccess } = {}) => {
    if (selectedCount === 0 || submitting) return false;
    const jids = Array.from(selected);
    const contactPayload = contacts
      .filter((c) => c?.jid && selected.has(c.jid))
      .map((c) => ({
        jid: c.jid,
        name: c.name || c.display_name || c.jid.split("@")[0] || "Unknown Contact",
        isGroup: Boolean(c.is_group ?? c.isGroup),
      }));
    const known = new Set(contactPayload.map((c) => c.jid));
    jids.forEach((jid) => {
      if (!known.has(jid)) {
        contactPayload.push({
          jid,
          name: jid.split("@")[0] || "Unknown Contact",
          isGroup: jid.includes("@g.us"),
        });
      }
    });

    setSubmitting(true);
    try {
      await setMonitoredContacts(jids);
      setContactsConfiguredFlag(true);
      try {
        sessionStorage.removeItem(SETUP_BANNER_KEY);
      } catch {
        /* ignore */
      }
      markBackgroundAnalysis();
      push(`Analyzing ${jids.length} selected chat${jids.length === 1 ? "" : "s"}…`);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("contacts-configured"));
      }
      onSuccess?.();
      initializeAuditJobs(contactPayload).catch((auditErr) => {
        console.error("[SelectionDesk] initializeAuditJobs failed:", auditErr);
      });
      return true;
    } catch (err) {
      push(err?.response?.data?.detail || "Could not save preferences");
      setSubmitting(false);
      return false;
    }
  };

  return {
    dms,
    groups,
    filteredDms,
    filteredGroups,
    selected,
    selectedCount,
    loadingContacts,
    error,
    submitting,
    importingPhonebook,
    syncingGoogle,
    dmQuery,
    groupQuery,
    setDmQuery,
    setGroupQuery,
    phonebookInputRef,
    loadContacts,
    toggleOne,
    selectAllIn,
    deselectAllIn,
    handlePhonebookFile,
    handleSyncGoogleContacts,
    saveSelection,
  };
}

function DualConversationPanels({
  loadingContacts,
  error,
  filteredDms,
  filteredGroups,
  dmsCount,
  groupsCount,
  selected,
  toggleOne,
  selectAllIn,
  deselectAllIn,
  dmQuery,
  groupQuery,
  setDmQuery,
  setGroupQuery,
  loadContacts,
  embedded = false,
  dmEmptyLabel = "No direct chats match this search",
  groupEmptyLabel = "No groups match this search",
}) {
  if (error) {
    return (
      <div className="rounded-3xl border border-rose-200 bg-rose-50 px-4 py-6 text-center">
        <p className="text-sm font-semibold text-rose-700">{error}</p>
        <button
          type="button"
          onClick={loadContacts}
          className="mt-3 inline-flex items-center gap-2 rounded-full border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-600"
        >
          <RefreshCw className="h-4 w-4" />
          Retry
        </button>
      </div>
    );
  }

  if (!loadingContacts && dmsCount === 0 && groupsCount === 0) {
    return <ContactsEmptyState onRefresh={loadContacts} refreshing={loadingContacts} />;
  }

  return (
    <div className={cn("grid h-full min-h-0 flex-1 items-stretch gap-3 lg:grid-cols-2")}>
      <ConversationColumn
        title="Direct Chats"
        items={filteredDms}
        selected={selected}
        onToggle={toggleOne}
        onSelectAll={() => selectAllIn(filteredDms)}
        onDeselectAll={() => deselectAllIn(filteredDms)}
        search={dmQuery}
        onSearchChange={setDmQuery}
        searchPlaceholder="Search chats…"
        loading={loadingContacts}
        emptyLabel={dmEmptyLabel}
        embedded={embedded}
      />
      <ConversationColumn
        title="Groups"
        items={filteredGroups}
        selected={selected}
        onToggle={toggleOne}
        onSelectAll={() => selectAllIn(filteredGroups)}
        onDeselectAll={() => deselectAllIn(filteredGroups)}
        search={groupQuery}
        onSearchChange={setGroupQuery}
        searchPlaceholder="Search groups…"
        loading={loadingContacts}
        emptyLabel={groupEmptyLabel}
        embedded={embedded}
      />
    </div>
  );
}

/** Mode A — first-time / locked setup after scan */
function ContactSelectionGate({ onAnalyzed }) {
  const selection = useContactSelection();
  const {
    filteredDms,
    filteredGroups,
    dms,
    groups,
    selected,
    selectedCount,
    loadingContacts,
    error,
    submitting,
    importingPhonebook,
    syncingGoogle,
    dmQuery,
    groupQuery,
    setDmQuery,
    setGroupQuery,
    phonebookInputRef,
    loadContacts,
    toggleOne,
    selectAllIn,
    deselectAllIn,
    handlePhonebookFile,
    handleSyncGoogleContacts,
    saveSelection,
  } = selection;

  const handleAnalyze = async () => {
    await saveSelection({ onSuccess: () => onAnalyzed?.() });
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-white">
      <header className="shrink-0 border-b border-slate-100 bg-white px-5 py-3">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-600">
              10-Day Discovery Audit
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
              Select Conversations to Monitor
            </h1>
            <p className="mt-1 max-w-xl text-sm text-slate-500">
              Choose active chats and groups for your AI assistant.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <input
              ref={phonebookInputRef}
              type="file"
              accept=".vcf,.csv,text/vcard,text/csv,text/x-vcard"
              className="hidden"
              onChange={handlePhonebookFile}
            />
            <button
              type="button"
              onClick={handleSyncGoogleContacts}
              disabled={syncingGoogle || importingPhonebook || loadingContacts || submitting}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 disabled:opacity-50"
            >
              {syncingGoogle ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <User className="h-3.5 w-3.5" />}
              Sync Google Contacts
            </button>
            <button
              type="button"
              onClick={() => phonebookInputRef.current?.click()}
              disabled={importingPhonebook || loadingContacts || submitting || syncingGoogle}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 disabled:opacity-50"
            >
              {importingPhonebook ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              Import phonebook
            </button>
            <button
              type="button"
              onClick={loadContacts}
              disabled={loadingContacts || submitting || importingPhonebook || syncingGoogle}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 disabled:opacity-50"
            >
              {loadingContacts ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Refresh Contacts
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col px-5 py-3">
        <DualConversationPanels
          loadingContacts={loadingContacts}
          error={error}
          filteredDms={filteredDms}
          filteredGroups={filteredGroups}
          dmsCount={dms.length}
          groupsCount={groups.length}
          selected={selected}
          toggleOne={toggleOne}
          selectAllIn={selectAllIn}
          deselectAllIn={deselectAllIn}
          dmQuery={dmQuery}
          groupQuery={groupQuery}
          setDmQuery={setDmQuery}
          setGroupQuery={setGroupQuery}
          loadContacts={loadContacts}
        />
      </div>

      <div className="shrink-0 border-t border-slate-100 bg-white px-5 py-3">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3">
          <div className="inline-flex shrink-0 items-center rounded-full bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white">
            {selectedCount} conversation{selectedCount === 1 ? "" : "s"} selected
          </div>
          <button
            type="button"
            onClick={handleAnalyze}
            disabled={selectedCount === 0 || submitting || loadingContacts}
            className="inline-flex min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl bg-orange-500 px-5 py-3 text-sm font-bold text-white shadow-sm shadow-orange-500/20 transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Proceed to Inbox →
          </button>
        </div>
      </div>
    </div>
  );
}

/** Mode B — revisit monitoring scope embedded in Desk & WhatsApp */
function MonitoringScopePanel({
  selection,
  onSave,
  showSaveBar = true,
  booting = false,
}) {
  const {
    filteredDms,
    filteredGroups,
    dms,
    groups,
    selected,
    selectedCount,
    loadingContacts,
    error,
    submitting,
    dmQuery,
    groupQuery,
    setDmQuery,
    setGroupQuery,
    loadContacts,
    toggleOne,
    selectAllIn,
    deselectAllIn,
  } = selection;
  const [scopeFilter, setScopeFilter] = useState("all");

  // Session check + contacts fetch both need skeleton — never flash empty/disconnect UI.
  // If contacts already arrived (parallel fetch), show them even while auth is still settling.
  const showContactsLoading =
    loadingContacts || (booting && dms.length === 0 && groups.length === 0);

  const matchesScope = (contact) => {
    const on = selected.has(contact?.jid);
    if (scopeFilter === "processing") return on;
    if (scopeFilter === "idle") return !on;
    return true;
  };

  const visibleDms = filteredDms.filter(matchesScope);
  const visibleGroups = filteredGroups.filter(matchesScope);
  const processingCount = [...dms, ...groups].filter((contact) => selected.has(contact?.jid)).length;
  const idleCount = dms.length + groups.length - processingCount;

  const dmEmpty =
    scopeFilter === "processing"
      ? "No direct chats are being processed"
      : scopeFilter === "idle"
        ? "No direct chats are off"
        : "No direct chats match this search";
  const groupEmpty =
    scopeFilter === "processing"
      ? "No groups are being processed"
      : scopeFilter === "idle"
        ? "No groups are off"
        : "No groups match this search";

  return (
    <section
      className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden rounded-3xl border border-slate-200/80 bg-white"
      style={{ boxShadow: CARD_SHADOW }}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-600">
            Monitoring Scope
          </p>
          <h2 className="text-sm font-bold text-slate-900">Conversations for AI auditing</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div
            className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-0.5"
            role="group"
            aria-label="Filter by AI processing"
          >
            {[
              ["all", "All", dms.length + groups.length],
              ["processing", "AI on", processingCount],
              ["idle", "AI off", idleCount],
            ].map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                onClick={() => setScopeFilter(id)}
                disabled={showContactsLoading}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-50",
                  scopeFilter === id
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-800"
                )}
              >
                {label}
                <span
                  className={cn(
                    "tabular-nums",
                    scopeFilter === id ? "text-orange-600" : "text-slate-400"
                  )}
                >
                  {showContactsLoading ? "…" : count}
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={loadContacts}
            disabled={showContactsLoading || submitting}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 disabled:opacity-50"
          >
            {showContactsLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-3">
        <DualConversationPanels
          loadingContacts={showContactsLoading}
          error={booting ? null : error}
          filteredDms={visibleDms}
          filteredGroups={visibleGroups}
          dmsCount={dms.length}
          groupsCount={groups.length}
          selected={selected}
          toggleOne={toggleOne}
          selectAllIn={selectAllIn}
          deselectAllIn={deselectAllIn}
          dmQuery={dmQuery}
          groupQuery={groupQuery}
          setDmQuery={setDmQuery}
          setGroupQuery={setGroupQuery}
          loadContacts={loadContacts}
          embedded
          dmEmptyLabel={dmEmpty}
          groupEmptyLabel={groupEmpty}
        />
      </div>

      {showSaveBar ? (
        <div className="flex shrink-0 items-center gap-3 border-t border-slate-100 bg-white px-4 py-2.5">
          <div className="inline-flex shrink-0 items-center rounded-full bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white">
            {selectedCount} conversation{selectedCount === 1 ? "" : "s"} selected
          </div>
          <button
            type="button"
            onClick={onSave}
            disabled={selectedCount === 0 || submitting || showContactsLoading}
            className="inline-flex min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl bg-orange-500 px-5 py-2.5 text-sm font-bold text-white shadow-sm shadow-orange-500/20 transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save & go to Inbox →
          </button>
        </div>
      ) : null}
    </section>
  );
}

function readSetupModeFromWindow() {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("setup") === "true") {
      return true;
    }
    if (sessionStorage.getItem(SETUP_BANNER_KEY) === "1") return true;
  } catch {
    /* ignore */
  }
  return !getContactsConfiguredFlag();
}

export default function SettingsPage() {
  const router = useRouter();
  const { push } = useToast();
  const [state, setState] = useState("loading");
  const [connected, setConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [qrImage, setQrImage] = useState(null);
  const [processed, setProcessed] = useState(0);
  const [currentSyncChat, setCurrentSyncChat] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [scanHold, setScanHold] = useState(false);
  const [scanTimedOut, setScanTimedOut] = useState(false);
  const [step, setStep] = useState(0);
  const [syncPhase, setSyncPhase] = useState("messages");
  const [isSetupMode, setIsSetupMode] = useState(() => readSetupModeFromWindow());
  const [setupBanner, setSetupBanner] = useState(() => readSetupModeFromWindow());
  const [showContactGate, setShowContactGate] = useState(false);

  const [userProfile, setUserProfile] = useState({ name: "", email: "", avatar: "" });

  const scanHoldRef = useRef(false);
  const gateOpenedRef = useRef(false);
  const loggingOutRef = useRef(false);
  const wasConnectedRef = useRef(null);
  const postScanSelectRef = useRef(false);
  const statusRequest = useRef(0);
  const qrPollRef = useRef(null);
  const syncPollRef = useRef(null);
  const scanTimeoutRef = useRef(null);

  const sessionChecking = state === "loading";
  // If user already finished setup, kick off contacts while auth/status is still settling
  // so Inbox → Settings does not wait serially on /auth/status then /recent-active.
  const revisitSelectionEnabled =
    (connected || (sessionChecking && getContactsConfiguredFlag())) &&
    !scanHold &&
    !showContactGate &&
    !isSetupMode;
  const revisitSelection = useContactSelection({
    enabled: revisitSelectionEnabled,
    preselectAllDmsIfEmpty: false,
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      setUserProfile({
        name: localStorage.getItem("user_name") || "Desk User",
        email: localStorage.getItem("user_email") || "",
        avatar: localStorage.getItem("user_avatar") || "",
      });
      const setup = readSetupModeFromWindow();
      setIsSetupMode(setup);
      try {
        if (sessionStorage.getItem(SETUP_BANNER_KEY) === "1" || setup) {
          setSetupBanner(true);
        }
      } catch {
        if (setup) setSetupBanner(true);
      }
      if (setup && !getContactsConfiguredFlag()) {
        postScanSelectRef.current = true;
        gateOpenedRef.current = false;
        scanHoldRef.current = true;
        setScanHold(true);
        setShowContactGate(false);
        setState("ready");
      }
    }
  }, []);

  const openContactGate = useCallback(
    (fromStep = 2, { force = false } = {}) => {
      if (loggingOutRef.current) return;
      if (gateOpenedRef.current && showContactGate && !force) return;
      gateOpenedRef.current = true;
      scanHoldRef.current = false;
      setIsSetupMode(true);
      setSetupBanner(true);
      setStep(fromStep);
      setScanTimedOut(false);
      if (scanTimeoutRef.current) {
        window.clearTimeout(scanTimeoutRef.current);
        scanTimeoutRef.current = null;
      }
      setScanHold(true);
      window.setTimeout(() => {
        if (loggingOutRef.current) return;
        setScanHold(false);
        setShowContactGate(true);
      }, 400);
    },
    [showContactGate]
  );

  const load = useCallback(async () => {
    if (loggingOutRef.current) return;
    const requestId = ++statusRequest.current;
    setRefreshing(true);
    try {
      const setupForced = readSetupModeFromWindow() || isSetupMode;
      if (setupForced) {
        setIsSetupMode(true);
        setSetupBanner(true);
      }

      if (setupForced && !getContactsConfiguredFlag() && !gateOpenedRef.current) {
        scanHoldRef.current = true;
        setScanHold(true);
        setShowContactGate(false);
        setState("ready");
      }

      let authStatus = null;
      try {
        authStatus = await fetchAuthStatus();
      } catch {
        authStatus = null;
      }

      if (requestId !== statusRequest.current || loggingOutRef.current) return;

      const nextConnected = Boolean(
        authStatus?.connected ||
          authStatus?.status === "connected" ||
          authStatus?.status === "ready" ||
          authStatus?.status === "syncing" ||
          authStatus?.status === "authenticated"
      );
      const nextSyncing = Boolean(authStatus?.isSyncing || authStatus?.status === "syncing");
      const selectionReady = isSelectionReady(authStatus);
      const nextPhase = authStatus?.sync_phase || (selectionReady ? "ready" : "messages");
      const nextStep = phaseStep(authStatus);

      wasConnectedRef.current = nextConnected;
      setConnected(nextConnected);
      setQrImage(nextConnected ? null : authStatus?.qr_image || null);
      setSyncing(nextSyncing);
      setProcessed(Number(authStatus?.totalProcessed || authStatus?.messages_indexed || 0));
      setCurrentSyncChat(authStatus?.currentProcessingChat || "");
      setSyncPhase(nextPhase);
      setStep(nextStep);
      setState("ready");

      if (selectionReady) {
        if (syncPollRef.current) {
          window.clearInterval(syncPollRef.current);
          syncPollRef.current = null;
        }
      }

      if (nextConnected) {
        if (!selectionReady && !gateOpenedRef.current) {
          postScanSelectRef.current = true;
          setContactsConfiguredFlag(false);
          try {
            sessionStorage.setItem(SETUP_BANNER_KEY, "1");
          } catch {
            /* ignore */
          }
          scanHoldRef.current = true;
          setScanHold(true);
          setShowContactGate(false);
          setIsSetupMode(true);
          setSetupBanner(true);
          return;
        }

        if (selectionReady && !gateOpenedRef.current) {
          setStep(4);
          setSyncPhase("ready");

          let forceBanner = false;
          try {
            forceBanner = sessionStorage.getItem(SETUP_BANNER_KEY) === "1";
          } catch {
            forceBanner = false;
          }

          let monitored = 0;
          try {
            const contacts = await fetchRecentActiveContacts();
            monitored = Number(contacts?.monitored_count || 0);
          } catch {
            monitored = 0;
          }

          const mustSelect =
            postScanSelectRef.current ||
            setupForced ||
            forceBanner ||
            monitored === 0 ||
            !getContactsConfiguredFlag() ||
            !Boolean(authStatus?.hasConfiguredContacts);

          if (mustSelect) {
            postScanSelectRef.current = false;
            setContactsConfiguredFlag(false);
            setSetupBanner(true);
            setIsSetupMode(true);
            openContactGate(4);
          } else {
            gateOpenedRef.current = true;
            scanHoldRef.current = false;
            setScanHold(false);
            setShowContactGate(false);
            setIsSetupMode(false);
            setSetupBanner(false);
          }
          return;
        }
      }

      if (!nextConnected && !setupForced && getContactsConfiguredFlag()) {
        gateOpenedRef.current = false;
        scanHoldRef.current = false;
        setScanHold(false);
        setShowContactGate(false);
        setScanTimedOut(false);
        setStep(0);
      }
    } catch {
      if (
        requestId === statusRequest.current &&
        !scanHoldRef.current &&
        !readSetupModeFromWindow()
      ) {
        setState("error");
      }
    } finally {
      if (requestId === statusRequest.current) setRefreshing(false);
    }
  }, [openContactGate, isSetupMode]);

  const startQrPoll = useCallback(() => {
    if (qrPollRef.current) window.clearInterval(qrPollRef.current);
    let polls = 0;
    qrPollRef.current = window.setInterval(() => {
      polls += 1;
      load();
      if (polls >= 40 && wasConnectedRef.current) {
        window.clearInterval(qrPollRef.current);
        qrPollRef.current = null;
      }
    }, 1200);
  }, [load]);

  useEffect(() => {
    load();
    syncPollRef.current = window.setInterval(load, 1500);

    return () => {
      if (qrPollRef.current) window.clearInterval(qrPollRef.current);
      if (syncPollRef.current) window.clearInterval(syncPollRef.current);
      if (scanTimeoutRef.current) window.clearTimeout(scanTimeoutRef.current);
    };
  }, [load]);

  useEffect(() => {
    if (!scanHold || gateOpenedRef.current) {
      if (scanTimeoutRef.current) {
        window.clearTimeout(scanTimeoutRef.current);
        scanTimeoutRef.current = null;
      }
      return undefined;
    }
    if (scanTimeoutRef.current) return undefined;
    scanTimeoutRef.current = window.setTimeout(() => {
      scanTimeoutRef.current = null;
      if (!gateOpenedRef.current && scanHoldRef.current) {
        setScanTimedOut(true);
      }
    }, SCAN_BARRIER_TIMEOUT_MS);
    return () => {
      if (scanTimeoutRef.current) {
        window.clearTimeout(scanTimeoutRef.current);
        scanTimeoutRef.current = null;
      }
    };
  }, [scanHold]);

  useEffect(() => {
    if (connected || scanHold || showContactGate) return undefined;
    startQrPoll();
    return () => {
      if (qrPollRef.current) {
        window.clearInterval(qrPollRef.current);
        qrPollRef.current = null;
      }
    };
  }, [connected, scanHold, showContactGate, startQrPoll]);

  const handleDisconnectWhatsApp = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    loggingOutRef.current = true;
    setConfirmUnlink(false);

    if (syncPollRef.current) window.clearInterval(syncPollRef.current);
    if (qrPollRef.current) window.clearInterval(qrPollRef.current);

    try {
      await logoutWhatsApp();
      try {
        await signOut(auth);
      } catch (err) {
        console.warn("Firebase signout notice:", err);
      }
      setContactsConfiguredFlag(false);
      completeLogoutRedirect("/login");
    } catch (err) {
      console.error("Backend unpair failed — staying signed in:", err);
      loggingOutRef.current = false;
      setLoggingOut(false);
      push(
        err?.response?.data?.detail ||
          err?.message ||
          "Could not unlink WhatsApp. Please try again."
      );
    }
  };

  const finishSetupToInbox = () => {
    setSetupBanner(false);
    setIsSetupMode(false);
    setShowContactGate(false);
    gateOpenedRef.current = true;
    setContactsConfiguredFlag(true);
    try {
      sessionStorage.removeItem(SETUP_BANNER_KEY);
    } catch {
      /* ignore */
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("contacts-configured"));
    }
    router.push("/inbox");
  };

  if (scanHold || (scanHoldRef.current && !showContactGate && !gateOpenedRef.current)) {
    return (
      <ScanBarrier
        step={step}
        timedOut={scanTimedOut}
        onContinue={() => openContactGate(4)}
        syncInfo={{ processed, currentChat: currentSyncChat, phase: syncPhase }}
      />
    );
  }

  const inGuardedSetup =
    showContactGate ||
    (isSetupMode && gateOpenedRef.current) ||
    (setupBanner && gateOpenedRef.current && !getContactsConfiguredFlag());

  if (inGuardedSetup) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04),0_4px_16px_rgba(15,23,42,0.04)]">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-200/80 bg-amber-50 px-5 py-2.5 text-xs text-amber-800">
          <span className="font-medium">{SETUP_BANNER_MSG}</span>
          <span className="shrink-0 rounded bg-amber-200/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
            Required
          </span>
        </div>
        <ContactSelectionGate onAnalyzed={finishSetupToInbox} />
      </div>
    );
  }

  if (state === "error" && !scanHold) {
    return <DeskServerError onRetry={load} retrying={refreshing} />;
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04),0_4px_16px_rgba(15,23,42,0.04)]">
      {confirmUnlink && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="unlink-title"
        >
          <div
            className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6"
            style={{ boxShadow: CARD_SHADOW }}
          >
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-rose-50 text-rose-600">
                <AlertTriangle className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="unlink-title" className="text-base font-bold text-slate-900">
                  Unlink WhatsApp?
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  This will unpair your WhatsApp device and require a new QR scan on your next session.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setConfirmUnlink(false)}
                className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-50 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmUnlink(false)}
                disabled={loggingOut}
                className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDisconnectWhatsApp}
                disabled={loggingOut}
                className="inline-flex items-center gap-2 rounded-full border border-rose-200 bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-50"
              >
                {loggingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
                Unlink & Sign Out
              </button>
            </div>
          </div>
        </div>
      )}

      <header className="flex shrink-0 items-center justify-between border-b border-slate-100 bg-white px-5 py-2.5">
        <div className="flex items-baseline gap-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-600">Settings</p>
          <h1 className="text-lg font-bold tracking-tight text-slate-900">Desk & WhatsApp</h1>
        </div>

        <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-1.5 shadow-sm">
          {userProfile.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={userProfile.avatar}
              alt={userProfile.name}
              className="h-8 w-8 rounded-full border border-slate-200 object-cover"
            />
          ) : (
            <div className="grid h-8 w-8 place-items-center rounded-full bg-orange-50 text-orange-600">
              <User className="h-4 w-4" />
            </div>
          )}
          <div className="hidden text-left sm:block">
            <p className="text-xs font-bold leading-none text-slate-800">{userProfile.name}</p>
            <p className="mt-0.5 max-w-[140px] truncate text-[10px] leading-tight text-slate-500">
              {userProfile.email}
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-7xl min-h-0 flex-1 gap-3 overflow-hidden px-4 py-3 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          <section
            className="rounded-3xl border border-slate-200/80 bg-white p-5"
            style={{ boxShadow: CARD_SHADOW }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-orange-50 text-orange-600">
                  <Smartphone className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">WhatsApp Instance</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {state === "loading"
                      ? "Checking session…"
                      : connected
                        ? "Dedicated instance linked and verified."
                        : "Not linked. Scan the QR code to pair your device."}
                  </p>
                </div>
              </div>
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold",
                  sessionChecking
                    ? "border-slate-200 bg-slate-50 text-slate-600"
                    : connected
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-amber-200 bg-amber-50 text-amber-700"
                )}
              >
                {sessionChecking ? "Checking…" : connected ? "Connected" : "Offline"}
              </span>
            </div>

            {!connected && qrImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrImage}
                alt="WhatsApp QR code"
                className="mx-auto mt-5 h-44 w-44 rounded-2xl border border-slate-200 bg-white p-2"
              />
            )}

            <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Sync Status
                </p>
                <p className="mt-1 font-semibold text-slate-800">
                  {syncing ? "Auditing History" : "Idle / Complete"}
                </p>
              </div>
              <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Messages</p>
                <p className="mt-1 font-semibold tabular-nums text-slate-800">
                  {processed.toLocaleString()}
                </p>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={load}
                disabled={refreshing}
                className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 disabled:opacity-60"
              >
                {refreshing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Refresh status
              </button>
              <button
                type="button"
                onClick={() => setConfirmUnlink(true)}
                disabled={loggingOut}
                className="inline-flex items-center gap-2 rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-600 transition hover:bg-rose-100 disabled:opacity-50"
              >
                {loggingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
                Unlink / Reset WhatsApp
              </button>
            </div>
          </section>

          <section
            className="rounded-3xl border border-slate-200/80 bg-white p-5"
            style={{ boxShadow: CARD_SHADOW }}
          >
            <h2 className="text-sm font-semibold text-slate-900">Tenant Isolation</h2>
            <p className="mt-1 text-sm leading-relaxed text-slate-500">
              This workspace session is anchored to your Google Account UID. Disconnecting removes your
              local pairing credentials from this worker instance.
            </p>
          </section>
        </div>

        <div className="relative flex h-full min-h-0">
          {sessionChecking || connected ? (
            <MonitoringScopePanel
              selection={revisitSelection}
              booting={sessionChecking && !connected}
              onSave={async () => {
                const ok = await revisitSelection.saveSelection({
                  onSuccess: () => router.push("/inbox"),
                });
                if (!ok) return;
              }}
            />
          ) : (
            <section
              className="flex h-full min-h-[280px] items-center justify-center rounded-3xl border border-dashed border-slate-200 bg-white px-6 text-center"
              style={{ boxShadow: CARD_SHADOW }}
            >
              <div>
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-50 text-slate-400">
                  <Users className="h-5 w-5" />
                </div>
                <p className="mt-4 text-sm font-semibold text-slate-900">Connect WhatsApp to manage scope</p>
                <p className="mt-1 text-sm text-slate-500">
                  Once linked, your direct chats and groups appear here for monitoring.
                </p>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
