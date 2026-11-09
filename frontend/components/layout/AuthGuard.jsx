"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { Loader2, ShieldCheck, Zap } from "lucide-react";
import {
  apiClient,
  setActiveTenantId,
  clearActiveTenantId,
  getContactsConfiguredFlag,
  setContactsConfiguredFlag,
} from "@/lib/api";
import RealtimeSyncStreamCard from "@/components/setup/RealtimeSyncStreamCard";

const SETUP_BANNER_KEY = "perisclaw_setup_banner";
const SYNC_LATCH_KEY = "perisclaw_wa_sync_latched";
const SETUP_PATH = "/settings?setup=true";
const SYNC_POLL_MS = 1800;
const SYNC_INTERP_MS = 120;
const SYNC_CHAT_TARGET = 15;

function readSyncLatch() {
  try {
    return sessionStorage.getItem(SYNC_LATCH_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSyncLatch(on) {
  try {
    if (on) sessionStorage.setItem(SYNC_LATCH_KEY, "1");
    else sessionStorage.removeItem(SYNC_LATCH_KEY);
  } catch {
    /* ignore */
  }
}

export default function AuthGuard({ children }) {
  const router = useRouter();
  const pathname = usePathname();

  // Firebase Auth State
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // WhatsApp Sync & Handshake State
  const [authStatus, setAuthStatus] = useState("loading"); // 'loading' | 'qr_ready' | 'syncing' | 'ready' | 'disconnected'
  const [qrCode, setQrCode] = useState(null);
  const [syncState, setSyncState] = useState({
    totalProcessed: 0,
    totalChatsCount: 0,
    currentProcessingChat: "Connecting to WhatsApp database...",
    historyCompleted: false,
    recent_contacts: [],
    messages_indexed: 0,
    identified_chats: 0,
  });
  // Displayed counts — smooth client-side interpolation so the loader never freezes
  const [displaySync, setDisplaySync] = useState({
    messages_indexed: 0,
    identified_chats: 0,
  });

  // Contact monitoring gate
  const [hasConfiguredContacts, setHasConfiguredContacts] = useState(null); // null = unchecked
  const [contactsChecked, setContactsChecked] = useState(false);

  const redirectedRef = useRef(false);
  const pollIntervalRef = useRef(null);
  const interpIntervalRef = useRef(null);
  const syncTargetRef = useRef({ messages_indexed: 0, identified_chats: 0 });
  const lastServerCountsRef = useRef({ messages_indexed: 0, identified_chats: 0 });
  const isAuthenticatedRef = useRef(false);
  const pathnameRef = useRef(pathname);
  const authStatusRef = useRef(authStatus);
  const disconnectCountRef = useRef(0);
  const lastServerTickRef = useRef(Date.now());
  const syncLatchedRef = useRef(false);
  const qrStickyRef = useRef(null);

  useEffect(() => {
    syncLatchedRef.current = readSyncLatch();
  }, []);

  useEffect(() => {
    isAuthenticatedRef.current = isAuthenticated;
  }, [isAuthenticated]);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    authStatusRef.current = authStatus;
  }, [authStatus]);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const stopInterpolation = useCallback(() => {
    if (interpIntervalRef.current) {
      clearInterval(interpIntervalRef.current);
      interpIntervalRef.current = null;
    }
  }, []);

  const goToContactSetup = useCallback(() => {
    stopPolling();
    stopInterpolation();
    redirectedRef.current = true;
    try {
      sessionStorage.setItem(SETUP_BANNER_KEY, "1");
    } catch {
      /* ignore */
    }
    router.push(SETUP_PATH);
  }, [router, stopPolling, stopInterpolation]);

  // True after worker selection_ready (fast history unlock).
  const isSyncComplete = Boolean(syncState.historyCompleted);

  // ── 1. FIREBASE AUTH STATE LISTENER ────────────────────────────────
  useEffect(() => {
    if (!auth) {
      setIsAuthenticated(false);
      setCheckingAuth(false);
      if (pathname !== "/login") {
        router.replace("/login");
      }
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user?.uid) {
        setActiveTenantId(user.uid);
        setIsAuthenticated(true);
      } else {
        clearActiveTenantId();
        setIsAuthenticated(false);
        setAuthStatus("loading");
        setHasConfiguredContacts(null);
        setContactsChecked(false);
        redirectedRef.current = false;
        if (pathname !== "/login") {
          router.replace("/login");
        }
      }
      setCheckingAuth(false);
    });

    return () => unsubscribe();
  }, [pathname, router]);

  // Snapshot progress from identified chats (capped at 98% until completion)
  const progressPercent = useMemo(() => {
    const chats = Number(
      displaySync.identified_chats ||
        syncState.identified_chats ||
        syncState.totalChatsCount ||
        0
    );
    if (syncState.historyCompleted) return 100;
    if (chats <= 0) return 8;
    // Cap below 100 until selection_ready — 15 chats is progress, not unlock.
    return Math.min(Math.round((chats / SYNC_CHAT_TARGET) * 100), 95);
  }, [
    displaySync.identified_chats,
    syncState.identified_chats,
    syncState.totalChatsCount,
    syncState.historyCompleted,
  ]);

  const resolveContactsConfigured = useCallback(async () => {
    // Fast path from a successful set-monitored in this browser session
    if (getContactsConfiguredFlag()) return true;

    try {
      const res = await apiClient.get("/contacts/recent-active", { timeout: 20000 });
      const monitoredCount = Number(res.data?.monitored_count || 0);
      if (monitoredCount > 0) {
        setContactsConfiguredFlag(true);
        return true;
      }
      const dms = res.data?.data?.dms || [];
      const groups = res.data?.data?.groups || [];
      const anyMonitored = [...dms, ...groups].some((c) => Boolean(c?.is_monitored));
      if (anyMonitored) setContactsConfiguredFlag(true);
      return anyMonitored;
    } catch {
      // Fail open only when the flag already said configured; otherwise treat as not ready
      return getContactsConfiguredFlag();
    }
  }, []);

  // ── 2. UNIFIED AUTH / QR / SYNC POLL (single endpoint) ─────────────
  const checkStatus = useCallback(async () => {
    if (!isAuthenticatedRef.current || pathnameRef.current === "/login") return;

    try {
      const res = await apiClient.get("/auth/status");
      const data = res.data || {};
      const status = data.status || "disconnected";
      const identifiedChats = Number(
        data.identified_chats ?? data.totalChatsCount ?? 0
      );
      const phoneJid = String(data.jid || "").trim();
      const hasPhoneJid = Boolean(phoneJid && phoneJid.includes("@"));
      // Desk unlock after selection_ready (contacts + name mapping).
      // Self-heal: worker may show "Ready for Selection" after a reconnect wiped the
      // selection_ready latch — don't leave the Setup UI spinning forever.
      const readyLabel = /ready for selection/i.test(
        String(data.currentProcessingChat || "")
      );
      const historyDone = Boolean(
        data.selection_ready ||
          data.sync_phase === "ready" ||
          (status === "ready" && data.phonebook_settled) ||
          data.isHistorySyncComplete ||
          (readyLabel &&
            Number(data.messages_indexed || data.totalProcessed || 0) >= 50)
      );
      const contactsConfigured = Boolean(data.hasConfiguredContacts);
      const unpaired = Boolean(data.unpaired || data.cleared);
      disconnectCountRef.current = 0; // reset on any successful poll

      const applySyncSnapshot = (prevOrNull, { completed }) => {
        const base = prevOrNull || {};
        const nextMessages = Math.max(
          Number(
            data.messages_indexed ??
              data.totalProcessed ??
              base.messages_indexed ??
              0
          ),
          Number(base.messages_indexed || 0),
          Number(base.totalProcessed || 0)
        );
        const nextChats = Math.max(
          Number(
            data.identified_chats ??
              data.totalChatsCount ??
              base.identified_chats ??
              0
          ),
          Number(base.identified_chats || 0),
          Number(base.totalChatsCount || 0)
        );
        lastServerTickRef.current = Date.now();
        lastServerCountsRef.current = {
          messages_indexed: Math.max(
            lastServerCountsRef.current.messages_indexed,
            nextMessages
          ),
          identified_chats: Math.max(
            lastServerCountsRef.current.identified_chats,
            nextChats
          ),
        };
        syncTargetRef.current = {
          messages_indexed: Math.max(
            syncTargetRef.current.messages_indexed,
            nextMessages
          ),
          identified_chats: Math.max(
            syncTargetRef.current.identified_chats,
            nextChats
          ),
        };
        return {
          totalProcessed: nextMessages,
          totalChatsCount: nextChats,
          currentProcessingChat:
            data.currentProcessingChat ||
            base.currentProcessingChat ||
            (completed
              ? "Sync Complete — Ready for Selection"
              : "Auditing conversation history..."),
          historyCompleted: Boolean(completed),
          messages_indexed: nextMessages,
          identified_chats: nextChats,
          recent_contacts: Array.isArray(data.recent_contacts)
            ? data.recent_contacts.length
              ? data.recent_contacts
              : base.recent_contacts || []
            : base.recent_contacts || [],
        };
      };

      const latchSyncing = () => {
        syncLatchedRef.current = true;
        writeSyncLatch(true);
        qrStickyRef.current = null;
        setAuthStatus("syncing");
        setQrCode(null);
      };

      // Explicit logout / wipe — allow QR again
      if (unpaired) {
        syncLatchedRef.current = false;
        writeSyncLatch(false);
      }

      const alreadyLatched =
        syncLatchedRef.current ||
        authStatusRef.current === "syncing" ||
        authStatusRef.current === "ready" ||
        readSyncLatch();

      // Unlock only after selection_ready (contacts + name mapping settled).
      if (historyDone) {
        syncLatchedRef.current = true;
        writeSyncLatch(true);
        stopPolling();
        setAuthStatus("ready");
        setQrCode(null);
        setSyncState((prev) => applySyncSnapshot(prev, { completed: true }));
        setHasConfiguredContacts(contactsConfigured);
        setContactsChecked(true);
        if (contactsConfigured) {
          setContactsConfiguredFlag(true);
        } else if (
          !redirectedRef.current &&
          pathnameRef.current !== "/settings" &&
          pathnameRef.current !== "/login"
        ) {
          goToContactSetup();
        }
        return;
      }

      // Strong sync signal only — never flip to loader from stale chat counts
      // while the worker is still on the QR screen (that caused QR↔loader flicker).
      const enterSyncing = Boolean(
        status === "syncing" ||
          status === "ready" ||
          (data.connected && hasPhoneJid && status !== "qr_ready") ||
          (alreadyLatched && status !== "qr_ready" && !unpaired)
      );

      if (enterSyncing) {
        latchSyncing();
        setSyncState((prev) => applySyncSnapshot(prev, { completed: false }));
        return;
      }

      if (status === "qr_ready" || status === "disconnected") {
        // Sticky latch: once scanned / syncing, never flash QR on reconnect noise
        if (alreadyLatched && !unpaired) {
          latchSyncing();
          setSyncState((prev) => applySyncSnapshot(prev, { completed: false }));
          return;
        }
        setAuthStatus("qr_ready");
        setHasConfiguredContacts(null);
        setContactsChecked(false);
        redirectedRef.current = false;
        // Keep last QR image sticky — avoid "Generating…" spinner flicker
        if (data.qr_image) {
          qrStickyRef.current = data.qr_image;
          setQrCode(data.qr_image);
        } else if (qrStickyRef.current) {
          setQrCode(qrStickyRef.current);
        }
        return;
      }

      // Fallback ready path — also stop polling
      syncLatchedRef.current = true;
      writeSyncLatch(true);
      stopPolling();
      setAuthStatus("ready");
      setQrCode(null);
      setSyncState((prev) => applySyncSnapshot(prev, { completed: true }));
      setHasConfiguredContacts(contactsConfigured);
      setContactsChecked(true);
      if (contactsConfigured) {
        setContactsConfiguredFlag(true);
      } else if (
        !redirectedRef.current &&
        pathnameRef.current !== "/settings" &&
        pathnameRef.current !== "/login"
      ) {
        goToContactSetup();
      }
    } catch (err) {
      const statusCode = err?.response?.status;
      const latched =
        syncLatchedRef.current ||
        authStatusRef.current === "syncing" ||
        authStatusRef.current === "ready" ||
        readSyncLatch();
      if (statusCode === 401 || statusCode === 403) {
        disconnectCountRef.current += 1;
        // Never drop a latched sync back to QR on auth blips
        if (disconnectCountRef.current >= 3 && !latched) {
          setAuthStatus("qr_ready");
        }
        return;
      }
      disconnectCountRef.current += 1;
      console.error("Auth verification error:", err);
      if (disconnectCountRef.current >= 3 && !latched) {
        setAuthStatus("qr_ready");
      }
    }
  }, [stopPolling, goToContactSetup]);

  useEffect(() => {
    if (!isAuthenticated || pathname === "/login") {
      stopPolling();
      stopInterpolation();
      return;
    }

    // Stable poller — do NOT restart when authStatus flips (that caused flicker)
    checkStatus();
    stopPolling();
    pollIntervalRef.current = setInterval(checkStatus, SYNC_POLL_MS);

    return () => stopPolling();
  }, [isAuthenticated, pathname, checkStatus, stopPolling, stopInterpolation]);

  useEffect(() => {
    if (authStatus === "ready") {
      stopPolling();
      stopInterpolation();
    }
  }, [authStatus, stopPolling, stopInterpolation]);

  // Smooth counter interpolation while syncing (keeps UI alive if server ticks stall)
  useEffect(() => {
    if (authStatus !== "syncing") {
      stopInterpolation();
      return undefined;
    }

    stopInterpolation();
    interpIntervalRef.current = setInterval(() => {
      const target = syncTargetRef.current;
      const stalledMs = Date.now() - lastServerTickRef.current;

      // Soft creep if the worker has gone quiet for >2.5s during ingest
      if (stalledMs > 2500) {
        const server = lastServerCountsRef.current;
        const msgCeiling = server.messages_indexed + 80;
        const chatCeiling = Math.min(
          SYNC_CHAT_TARGET - 1,
          Math.max(server.identified_chats + 2, 3)
        );
        if (target.messages_indexed < msgCeiling) {
          target.messages_indexed += 2;
        }
        if (target.identified_chats < chatCeiling && Math.random() < 0.15) {
          target.identified_chats += 1;
        }
      }

      setDisplaySync((prev) => {
        const nextMessages =
          prev.messages_indexed < target.messages_indexed
            ? Math.min(
                target.messages_indexed,
                prev.messages_indexed +
                  Math.max(
                    1,
                    Math.ceil((target.messages_indexed - prev.messages_indexed) / 6)
                  )
              )
            : Math.max(prev.messages_indexed, target.messages_indexed);
        const nextChats =
          prev.identified_chats < target.identified_chats
            ? Math.min(target.identified_chats, prev.identified_chats + 1)
            : Math.max(prev.identified_chats, target.identified_chats);
        if (
          nextMessages === prev.messages_indexed &&
          nextChats === prev.identified_chats
        ) {
          return prev;
        }
        return { messages_indexed: nextMessages, identified_chats: nextChats };
      });
    }, SYNC_INTERP_MS);

    return () => stopInterpolation();
  }, [authStatus, stopInterpolation]);

  // ── 2b. CONTACT MONITORING GATE (after WA ready) ───────────────────
  useEffect(() => {
    if (!isAuthenticated || authStatus !== "ready" || pathname === "/login") return;

    let cancelled = false;

    (async () => {
      const configured = await resolveContactsConfigured();
      if (cancelled) return;

      setHasConfiguredContacts(configured);
      setContactsChecked(true);

      if (!configured) {
        if (
          pathname !== "/settings" &&
          pathname !== "/login" &&
          !redirectedRef.current
        ) {
          goToContactSetup();
        }
        return;
      }

      // Contacts ready — soft land on Today Desk after login / first setup
      if (!redirectedRef.current && (pathname === "/login" || pathname === "/settings")) {
        // Stay on settings if user intentionally opened it after setup
        if (pathname === "/settings" && getContactsConfiguredFlag()) {
          redirectedRef.current = true;
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authStatus, isAuthenticated, pathname, resolveContactsConfigured, goToContactSetup]);

  // Re-check when settings page signals successful set-monitored
  useEffect(() => {
    const onConfigured = () => {
      setContactsConfiguredFlag(true);
      setHasConfiguredContacts(true);
      setContactsChecked(true);
      redirectedRef.current = true;
      stopPolling();
      stopInterpolation();
      // Land on Today Desk so streamed matter cards are visible while audits run
      router.push("/today");
    };
    const onWaLogout = () => {
      setContactsConfiguredFlag(false);
      setHasConfiguredContacts(null);
      setContactsChecked(false);
      redirectedRef.current = false;
      disconnectCountRef.current = 0;
      syncLatchedRef.current = false;
      writeSyncLatch(false);
      qrStickyRef.current = null;
      authStatusRef.current = "qr_ready";
      setAuthStatus("qr_ready");
      setQrCode(null);
      syncTargetRef.current = { messages_indexed: 0, identified_chats: 0 };
      lastServerCountsRef.current = { messages_indexed: 0, identified_chats: 0 };
      setDisplaySync({ messages_indexed: 0, identified_chats: 0 });
      setSyncState({
        totalProcessed: 0,
        totalChatsCount: 0,
        currentProcessingChat: "Connecting to WhatsApp database...",
        historyCompleted: false,
        recent_contacts: [],
        messages_indexed: 0,
        identified_chats: 0,
      });
      // Resume polling for a fresh QR after unlink
      if (isAuthenticatedRef.current && pathnameRef.current !== "/login") {
        stopPolling();
        stopInterpolation();
        checkStatus();
        pollIntervalRef.current = setInterval(checkStatus, SYNC_POLL_MS);
      }
    };
    window.addEventListener("contacts-configured", onConfigured);
    window.addEventListener("wa-logout", onWaLogout);
    return () => {
      window.removeEventListener("contacts-configured", onConfigured);
      window.removeEventListener("wa-logout", onWaLogout);
    };
  }, [router, checkStatus, stopPolling, stopInterpolation]);

  const handleProceedToSettings = useCallback(() => {
    goToContactSetup();
  }, [goToContactSetup]);

  // Auto-redirect to Selection Desk when selection_ready / progress hits 100%.
  useEffect(() => {
    if (!isAuthenticated || pathname === "/login" || pathname === "/settings") return;
    if (redirectedRef.current || getContactsConfiguredFlag()) return;
    if (isSyncComplete || progressPercent >= 100 || authStatus === "ready") {
      goToContactSetup();
    }
  }, [
    isAuthenticated,
    pathname,
    isSyncComplete,
    progressPercent,
    authStatus,
    goToContactSetup,
  ]);

  // ── 3. FIREBASE AUTH CHECKING SPINNER ──────────────────────────────
  if (checkingAuth) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#F8FAFC] text-slate-500">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
          <span className="text-sm font-medium tracking-wide">
            Verifying Authentication...
          </span>
        </div>
      </div>
    );
  }

  // Login page par children direct render honge
  if (pathname === "/login") {
    return <>{children}</>;
  }

  // Not authenticated
  if (!isAuthenticated) {
    return null;
  }

  // ── 4. INITIAL WORKER STATE PLACEHOLDER ────────────────────────────
  if (authStatus === "loading") {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#F8FAFC] text-slate-500">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
          <span className="text-sm font-medium tracking-wide">
            Initializing Perisclaw Workspace...
          </span>
        </div>
      </div>
    );
  }

  // ── 5. DISCONNECTED / QR REQUIRED SCREEN ───────────────────────────
  if (authStatus === "qr_ready" || authStatus === "disconnected") {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-[#F8FAFC] p-6 text-center select-none">
        <div className="w-full max-w-sm rounded-3xl bg-white p-8 shadow-2xl shadow-slate-200/60 border border-slate-100">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-600 font-bold text-xl">
            <Zap className="h-6 w-6 text-orange-500 fill-orange-500" />
          </div>
          <h2 className="text-lg font-bold text-slate-900 mb-1">
            Connect Your WhatsApp
          </h2>
          <p className="text-xs text-slate-500 mb-6">
            Scan the QR code from WhatsApp Linked Devices to begin your 10-day sync.
          </p>

          <div className="relative mx-auto flex h-64 w-64 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 overflow-hidden shadow-inner">
            {qrCode || qrStickyRef.current ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrCode || qrStickyRef.current}
                alt="WhatsApp QR Code"
                className="h-full w-full object-contain p-3"
              />
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
                <span className="text-xs text-slate-400 font-medium">
                  Generating fresh QR code...
                </span>
              </div>
            )}
          </div>

          <div className="mt-6 flex items-center justify-center gap-2 text-[11px] text-slate-400 font-medium">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
            <span>End-to-End Encrypted Handshake</span>
          </div>
        </div>
      </div>
    );
  }

  // ── 6. STRICT LIVE 10-DAY INGESTION LOADER SCREEN ─────────────────
  if (authStatus === "syncing" || (authStatus !== "ready" && !syncState.historyCompleted)) {
    const messagesIndexed = Math.max(
      displaySync.messages_indexed,
      syncState.messages_indexed || syncState.totalProcessed || 0
    );
    const identifiedChats = Math.max(
      displaySync.identified_chats,
      syncState.identified_chats || syncState.totalChatsCount || 0
    );
    const syncCompleteHere = isSyncComplete;

    return (
      <div className="fixed inset-0 z-50 bg-zinc-900/30 backdrop-blur-xs flex items-center justify-center p-6 select-none">
        <div className="w-full max-w-4xl flex flex-col items-center">
          {/* Page Header */}
          <div className="w-full mb-6">
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600">
              Executive Setup
            </span>
            <h2 className="text-xl font-bold text-zinc-900">
              Syncing Contacts & Activity
            </h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Processing active conversations from the last 10 days. Sync is in
              progress...
            </p>
          </div>

          {/* Side-by-Side Dual Cards */}
          <div className="w-full flex flex-col sm:flex-row items-stretch justify-center gap-5">
            {/* Left Card: Auditing Last 10 Days Activity */}
            <div className="w-full flex-1 min-h-[300px] bg-white rounded-2xl border border-zinc-200/80 shadow-xs p-6 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500 text-white font-bold flex items-center justify-center text-base shadow-xs">
                    P
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-zinc-900 leading-tight">
                      Auditing Last 10 Days Activity
                    </h3>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      Indexing conversations, media assets, and active threads.
                    </p>
                  </div>
                </div>

                <div className="mt-5">
                  <div className="flex justify-between text-xs font-semibold text-zinc-500 mb-1.5">
                    <span>Snapshot Ingestion</span>
                    <span className="text-amber-600 font-bold">
                      {progressPercent}%
                    </span>
                  </div>
                  <div className="w-full h-2 bg-zinc-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-amber-500 to-emerald-500 transition-all duration-300 rounded-full"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Metrics Grid */}
              <div className="grid grid-cols-2 gap-3 my-3">
                <div className="p-3.5 bg-zinc-50/80 rounded-xl border border-zinc-100">
                  <span className="text-[10px] font-semibold tracking-wider text-zinc-400 uppercase">
                    Messages Indexed
                  </span>
                  <div className="text-2xl font-extrabold text-zinc-900 mt-1 tabular-nums">
                    {messagesIndexed || 0}
                  </div>
                </div>

                <div className="p-3.5 bg-zinc-50/80 rounded-xl border border-zinc-100">
                  <span className="text-[10px] font-semibold tracking-wider text-zinc-400 uppercase">
                    Identified Chats
                  </span>
                  <div className="text-2xl font-extrabold text-sky-600 mt-1 tabular-nums">
                    {Math.min(identifiedChats || 0, SYNC_CHAT_TARGET)}
                  </div>
                </div>
              </div>

              {/* Active Thread Bar */}
              <div className="flex items-center justify-between px-3.5 py-2 bg-zinc-50 rounded-lg border border-zinc-100">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                  <span className="text-xs text-zinc-500 truncate">
                    {syncCompleteHere
                      ? "Sync Complete — Preparing Selection..."
                      : syncState.currentProcessingChat ||
                        "Connecting & indexing WhatsApp chats..."}
                  </span>
                </div>
                <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 shrink-0">
                  LIVE
                </span>
              </div>
            </div>

            {/* Right Card: Real-time Stream Reel */}
            <RealtimeSyncStreamCard
              contacts={syncState.recent_contacts}
              currentCount={Math.min(identifiedChats || 0, SYNC_CHAT_TARGET)}
              totalCount={SYNC_CHAT_TARGET}
              complete={syncCompleteHere}
            />
          </div>

          {/* Action Button: activates only after selection_ready (names mapped) */}
          <div className="w-full mt-7 flex flex-col items-center">
            <button
              type="button"
              disabled={!syncCompleteHere}
              onClick={handleProceedToSettings}
              className={`w-full py-3 rounded-xl text-sm font-semibold text-center transition-all shadow-xs ${
                syncCompleteHere
                  ? "bg-amber-500 text-white hover:bg-amber-600 cursor-pointer"
                  : "bg-amber-200/70 text-amber-800 cursor-not-allowed"
              }`}
            >
              {syncCompleteHere
                ? "Continue to Contact Selection →"
                : "Continue to Today Desk (Syncing...) →"}
            </button>
            <p className="text-xs text-zinc-400 mt-2.5 flex items-center gap-1.5">
              {!syncCompleteHere && (
                <span className="w-3 h-3 border-2 border-zinc-400 border-t-transparent rounded-full animate-spin inline-block" />
              )}
              {syncCompleteHere
                ? "Sync completed. Click above to proceed to contact selection."
                : "Please keep this desk window open. Preparing contacts selection..."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Gate: wait for contacts check before rendering desk routes
  if (authStatus === "ready" && !contactsChecked) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#F8FAFC] text-slate-500">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
          <span className="text-sm font-medium tracking-wide">
            Checking monitoring preferences...
          </span>
        </div>
      </div>
    );
  }

  // Strict lock: no monitored contacts → only /settings is allowed
  if (
    authStatus === "ready" &&
    hasConfiguredContacts === false &&
    pathname !== "/settings"
  ) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#F8FAFC] text-slate-500">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
          <span className="text-sm font-medium tracking-wide">
            Redirecting to contact setup...
          </span>
        </div>
      </div>
    );
  }

  // ── 7. AUTHENTICATED & FULLY SYNCED: RENDER FULL DASHBOARD ────────
  return <>{children}</>;
}
