"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Inbox, ListChecks, MessageCircle } from "lucide-react";
import { motion } from "framer-motion";
import ContactAuditSearch from "@/components/audit/ContactAuditSearch";
import CenterDesk from "@/components/dashboard/CenterDesk";
import { DeskEmptySync, DeskServerError } from "@/components/dashboard/DeskStates";
import LeftFeed, { NewMatterDialog } from "@/components/dashboard/LeftFeed";
import RightChatStream from "@/components/dashboard/RightChatStream";
import { useToast } from "@/components/ui/ToastProvider";
import {
  fetchAuthStatus,
  fetchMatterChat,
  fetchMatterDetails,
  fetchMatters,
  sendMatterDraft,
  syncRecentMatters,
  toggleMatterStep,
} from "@/lib/api";
import {
  answerMatter,
  buildLocalMatter,
  filterMatters,
  formatDeskDate,
  matterStats,
  normalizeTs,
} from "@/lib/matters";
import {
  backgroundAnalysisFresh,
  clearBackgroundAnalysis,
  markBackgroundAnalysis,
} from "@/lib/syncSession";
import { cn } from "@/lib/utils";

const PANELS = [
  { id: "feed", label: "Today", icon: Inbox },
  { id: "desk", label: "Desk", icon: ListChecks },
  { id: "chat", label: "Chat", icon: MessageCircle },
];

function timeValue(value) {
  const ms = normalizeTs(value);
  return Number.isNaN(ms) ? 0 : ms;
}

export default function DashboardPage() {
  const { push } = useToast();
  const [feedState, setFeedState] = useState("loading");
  const [liveMatters, setLiveMatters] = useState([]);
  const [localMatters, setLocalMatters] = useState([]);
  const [statusOverrides, setStatusOverrides] = useState({});
  const [activityOverrides, setActivityOverrides] = useState({});
  const [detailById, setDetailById] = useState({});
  const [status, setStatus] = useState("ALL");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [panel, setPanel] = useState("feed");
  const [creating, setCreating] = useState(false);
  const [audit, setAudit] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [feedLoading, setFeedLoading] = useState(true);
  const [detailErrorId, setDetailErrorId] = useState(null);
  const [detailTick, setDetailTick] = useState(0);
  const [notes, setNotes] = useState({});
  const [pending, setPending] = useState(null);
  const [connected, setConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [historyCompleted, setHistoryCompleted] = useState(false);
  const [syncKnown, setSyncKnown] = useState(false);
  const [backgroundGeneration, setBackgroundGeneration] = useState(false);
  const [qrImage, setQrImage] = useState(null);
  const [syncingClick, setSyncingClick] = useState(false);

  const feedToken = useRef(0);
  const detailToken = useRef(0);
  const mergedRef = useRef([]);
  const matterCountRef = useRef(0);
  const feedStateRef = useRef("loading");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab === "audit") setAudit(true);
    if (tab === "outgoing") setStatus("NEEDS_YOU");
    if (tab === "incoming") setStatus("WAITING");
  }, []);

  const loadLinkState = useCallback(async () => {
    const auth = await fetchAuthStatus();
    if (auth?.error && !auth?.worker_online) {
      setConnected(false);
      setQrImage(null);
      return { connected: false, syncing: false, historyCompleted: false };
    }

    const nextConnected = Boolean(
      auth?.connected ||
        auth?.status === "ready" ||
        auth?.status === "syncing" ||
        auth?.status === "connected"
    );
    const nextSyncing = Boolean(auth?.isSyncing || auth?.status === "syncing");
    const nextHistory = Boolean(
      auth?.historyCompleted || auth?.isHistorySyncComplete || auth?.status === "ready"
    );

    setConnected(nextConnected);
    setQrImage(nextConnected ? null : auth?.qr_image || null);
    setSyncing(nextSyncing);
    setHistoryCompleted(nextHistory);
    setSyncKnown(true);

    const historyBusy = nextConnected && (nextSyncing || !nextHistory);
    if (historyBusy) {
      markBackgroundAnalysis();
      setBackgroundGeneration(true);
    } else if (matterCountRef.current === 0 && backgroundAnalysisFresh()) {
      setBackgroundGeneration(true);
    } else {
      setBackgroundGeneration(false);
    }
    return { connected: nextConnected, syncing: nextSyncing, historyCompleted: nextHistory };
  }, []);

  const loadFeed = useCallback(async () => {
    const token = ++feedToken.current;
    setFeedLoading(true);
    try {
      const res = await fetchMatters();
      if (token !== feedToken.current) return;
      const items = Array.isArray(res?.data) ? res.data : [];
      setLiveMatters(items);
      matterCountRef.current = items.length;
      feedStateRef.current = "ready";
      setFeedState("ready");
    } catch {
      if (token !== feedToken.current) return;
      feedStateRef.current = "error";
      setFeedState("error");
    } finally {
      if (token === feedToken.current) {
        setFeedLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadFeed();
    loadLinkState();
  }, [loadFeed, loadLinkState, refreshTick]);

  useEffect(() => {
    const onLogout = () => {
      feedToken.current += 1;
      detailToken.current += 1;
      setLiveMatters([]);
      setLocalMatters([]);
      setStatusOverrides({});
      setActivityOverrides({});
      setDetailById({});
      setSelectedId(null);
      setNotes({});
      setPending(null);
      setConnected(false);
      setSyncing(false);
      setHistoryCompleted(false);
      setSyncKnown(false);
      setBackgroundGeneration(false);
      matterCountRef.current = 0;
      clearBackgroundAnalysis();
      setQrImage(null);
      feedStateRef.current = "ready";
      setFeedState("ready");
      setFeedLoading(false);
      setDetailErrorId(null);
    };
    window.addEventListener("wa-logout", onLogout);
    return () => window.removeEventListener("wa-logout", onLogout);
  }, []);

  const merged = useMemo(() => {
    const locals = localMatters.filter(
      (matter) => !liveMatters.some((item) => String(item.id) === String(matter.id))
    );
    return [...locals, ...liveMatters]
      .map((matter) => ({
        ...matter,
        ...(statusOverrides[matter.id] ? { status: statusOverrides[matter.id] } : {}),
        ...(activityOverrides[matter.id] ? { last_activity_at: activityOverrides[matter.id] } : {}),
      }))
      .sort((a, b) => timeValue(b.last_activity_at) - timeValue(a.last_activity_at));
  }, [liveMatters, localMatters, statusOverrides, activityOverrides]);

  mergedRef.current = merged;

  const visible = useMemo(
    () => filterMatters(merged, status, search),
    [merged, status, search]
  );
  const visibleKey = visible.map((matter) => matter.id).join("|");
  const stats = useMemo(() => matterStats(merged), [merged]);
  const hasDeskItems = merged.length > 0;
  const showServerError = feedState === "error";
  const showFeedSkeleton = feedState === "loading";
  const showProgressiveSkeleton =
    syncKnown &&
    !showServerError &&
    !hasDeskItems &&
    (syncing || (connected && !historyCompleted) || backgroundGeneration);
  const showEmptySync = feedState === "ready" && !hasDeskItems && !showProgressiveSkeleton;
  const deskBooting = showFeedSkeleton || showProgressiveSkeleton;

  useEffect(() => {
    if (!showEmptySync) return undefined;
    const timer = window.setInterval(() => {
      loadLinkState();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [showEmptySync, loadLinkState]);

  useEffect(() => {
    if (!showProgressiveSkeleton || feedState === "error") return undefined;
    const pull = () => setRefreshTick((tick) => tick + 1);
    const timer = window.setInterval(pull, 3500);
    return () => window.clearInterval(timer);
  }, [showProgressiveSkeleton, feedState]);

  useEffect(() => {
    if (feedState !== "ready") return;
    if (!visible.length) {
      setSelectedId((current) => (String(current || "").startsWith("local-") ? current : null));
      return;
    }
    setSelectedId((current) => {
      if (current != null && visible.some((matter) => String(matter.id) === String(current))) {
        return current;
      }
      return visible[0].id;
    });
  }, [visibleKey, feedState, visible]);

  const selected = useMemo(() => {
    if (selectedId == null) return null;
    const base = merged.find((matter) => String(matter.id) === String(selectedId));
    const extra = detailById[selectedId];
    if (!base && !extra) return null;
    return {
      ...(base || {}),
      ...(extra || {}),
      status: (base || extra).status,
      contact_name: (base || extra).contact_name,
      title: (base || extra).title,
      headline:
        (extra && (extra.headline || extra.core_problem || extra.summary)) ||
        base?.headline ||
        base?.summary ||
        (base || extra).title ||
        "",
      situation: (extra && extra.situation) || base?.situation || "",
      summary:
        (extra && (extra.headline || extra.summary || extra.core_problem)) ||
        base?.summary ||
        (base || extra).title ||
        "",
      core_problem:
        (extra && (extra.core_problem || extra.headline || extra.summary)) ||
        base?.core_problem ||
        base?.summary ||
        "",
      avatar_url: (extra && extra.avatar_url) || base?.avatar_url || null,
    };
  }, [merged, selectedId, detailById]);

  const detailPending =
    feedState === "ready" &&
    selected &&
    !String(selected.id).startsWith("local-") &&
    !Array.isArray(selected.next_steps) &&
    String(detailErrorId) !== String(selected.id);

  useEffect(() => {
    if (feedState !== "ready" || selectedId == null) return;
    if (String(selectedId).startsWith("local-")) return;
    const token = ++detailToken.current;
    setDetailErrorId((current) => (String(current) === String(selectedId) ? null : current));
    (async () => {
      try {
        const [detailRes, chatRes] = await Promise.all([
          fetchMatterDetails(selectedId),
          fetchMatterChat(selectedId),
        ]);
        if (token !== detailToken.current) return;
        const data = detailRes?.data || {};
        setDetailById((prev) => ({
          ...prev,
          [selectedId]: {
            ...(prev[selectedId] || {}),
            ...data,
            avatar_url:
              chatRes?.avatar_url ||
              data.avatar_url ||
              prev[selectedId]?.avatar_url ||
              null,
            messages: Array.isArray(chatRes?.data) ? chatRes.data : [],
          },
        }));
        setDetailErrorId((current) => (String(current) === String(selectedId) ? null : current));
      } catch {
        if (token !== detailToken.current) return;
        setDetailErrorId(selectedId);
        push("Could not load that matter");
      }
    })();
  }, [selectedId, feedState, detailTick, push]);

  const patchDetail = useCallback((id, recipe) => {
    setDetailById((prev) => {
      const fromList = mergedRef.current.find((matter) => String(matter.id) === String(id));
      const current = prev[id] || fromList;
      if (!current) return prev;
      return {
        ...prev,
        [id]: recipe({ ...(fromList || {}), ...current }),
      };
    });
  }, []);

  const selectMatter = (id) => {
    setSelectedId(id);
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      setPanel("desk");
    }
  };

  const handleSync = async () => {
    setSyncingClick(true);
    try {
      const link = await loadLinkState();
      if (link?.connected || link?.syncing) {
        await syncRecentMatters();
        await loadFeed();
        push("Matters synced from recent chats");
      } else {
        await loadFeed();
        push("QR / connection refreshed");
      }
    } catch {
      push("Sync failed — try again in a moment");
    } finally {
      setSyncingClick(false);
    }
  };

  const handleRetry = () => {
    setFeedState("loading");
    setRefreshTick((tick) => tick + 1);
  };

  const handleToggleStep = async (step) => {
    if (!selected) return;
    const next = !step.is_completed;
    patchDetail(selected.id, (detail) => ({
      ...detail,
      next_steps: (detail.next_steps || []).map((item) =>
        item.id === step.id ? { ...item, is_completed: next } : item
      ),
    }));
    if (String(step.id).startsWith("local")) return;
    try {
      const res = await toggleMatterStep(step.id);
      patchDetail(selected.id, (detail) => ({
        ...detail,
        next_steps: (detail.next_steps || []).map((item) =>
          item.id === step.id ? { ...item, is_completed: Boolean(res?.is_completed) } : item
        ),
      }));
    } catch {
      patchDetail(selected.id, (detail) => ({
        ...detail,
        next_steps: (detail.next_steps || []).map((item) =>
          item.id === step.id ? { ...item, is_completed: step.is_completed } : item
        ),
      }));
      push("Could not update that step");
    }
  };

  const deliver = async ({ text, draft }) => {
    if (!selected) return;
    const matterId = selected.id;
    const live = !String(matterId).startsWith("local-");
    if (live) {
      const payload = {};
      if (draft && text === draft.draft_text) payload.draft_id = draft.id;
      else payload.custom_text = text;
      if (draft && text !== draft.draft_text) payload.custom_text = text;
      await sendMatterDraft(matterId, payload);
    }
    const sentAt = new Date().toISOString();
    patchDetail(matterId, (detail) => ({
      ...detail,
      messages: [
        ...(detail.messages || []),
        {
          id: `local-msg-${crypto.randomUUID()}`,
          text,
          is_from_me: true,
          timestamp: sentAt,
        },
      ],
      draft_options: (detail.draft_options || []).map((item) =>
        draft && item.id === draft.id ? { ...item, is_used: true } : item
      ),
    }));
    setStatusOverrides((prev) => ({ ...prev, [matterId]: "WAITING" }));
    setActivityOverrides((prev) => ({ ...prev, [matterId]: sentAt }));
    push(live ? "Reply sent on WhatsApp" : "Reply saved on the desk");
  };

  const handleSendDraft = async ({ draft, text }) => {
    if (!text?.trim()) return;
    setPending({ kind: "draft", id: draft?.id });
    try {
      await deliver({ text: text.trim(), draft });
    } catch {
      push("WhatsApp did not send that reply");
      throw new Error("send failed");
    } finally {
      setPending(null);
    }
  };

  const handleSendChat = async (text) => {
    setPending({ kind: "chat" });
    try {
      await deliver({ text });
    } catch {
      push("WhatsApp did not send that message");
      throw new Error("send failed");
    } finally {
      setPending(null);
    }
  };

  const handleAsk = (question) => {
    if (!selected) return;
    const answer = answerMatter(selected, question);
    setNotes((prev) => ({
      ...prev,
      [selected.id]: [...(prev[selected.id] || []), { id: crypto.randomUUID(), question, answer }],
    }));
  };

  const handleStatus = (nextStatus) => {
    if (!selected || selected.status === nextStatus) return;
    setStatusOverrides((prev) => ({ ...prev, [selected.id]: nextStatus }));
    const label = {
      NEEDS_YOU: "Needs you",
      WAITING: "Waiting",
      LATER: "Later",
      DONE: "Done",
    }[nextStatus];
    push(`Moved to ${label}`);
  };

  const handleCreate = (fields) => {
    const matter = buildLocalMatter(fields);
    setLocalMatters((prev) => [matter, ...prev]);
    setDetailById((prev) => ({ ...prev, [matter.id]: matter }));
    setStatus("ALL");
    setSearch("");
    setSelectedId(matter.id);
    setPanel("desk");
    setCreating(false);
    push("Matter opened on the desk");
  };

  const closeDialog = useCallback(() => setCreating(false), []);
  const deskDate = formatDeskDate();

  if (audit) {
    return (
      <div className="h-full overflow-y-auto bg-white text-slate-900">
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          <button
            type="button"
            onClick={() => {
              setAudit(false);
              window.history.replaceState(null, "", "/");
            }}
            className="mb-4 text-sm font-semibold text-orange-600"
          >
            Back to desk
          </button>
          <ContactAuditSearch />
        </div>
      </div>
    );
  }

  if (showServerError) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-white text-slate-900">
        <DeskServerError onRetry={handleRetry} retrying={feedLoading} />
      </div>
    );
  }

  if (showEmptySync) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-white text-slate-900">
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-600">
              Perisclaw
            </p>
            <h1 className="font-serif text-2xl font-medium tracking-tight text-slate-900">Today</h1>
            <p className="text-xs text-slate-500">{deskDate}</p>
          </div>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-full bg-gradient-to-r from-orange-500 to-amber-500 px-3 py-1.5 text-xs font-semibold text-white shadow-sm"
          >
            + New
          </button>
        </header>
        <DeskEmptySync
          syncing={syncing}
          connected={connected}
          qrImage={qrImage}
          onSync={handleSync}
          syncingClick={syncingClick || feedLoading}
        />
        <NewMatterDialog open={creating} onClose={closeDialog} onSubmit={handleCreate} />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 overflow-hidden bg-[#F1F3F5] p-2.5 lg:p-3 text-slate-900">
      <div className="flex h-full w-full min-h-0 min-w-0 gap-2.5 lg:gap-3 overflow-hidden">
        {/* Panel 1: Today Feed */}
        <section
          className={cn(
            "h-full min-h-0 shrink-0 flex-col rounded-2xl border border-slate-200/80 bg-white shadow-sm overflow-hidden",
            "w-full lg:w-[320px] xl:w-[350px]",
            panel === "feed" ? "flex" : "hidden lg:flex"
          )}
        >
          <LeftFeed
            matters={deskBooting ? [] : visible}
            loading={showFeedSkeleton}
            generating={showProgressiveSkeleton}
            needsYouCount={stats.needs_you}
            status={status}
            onStatus={setStatus}
            search={search}
            onSearch={setSearch}
            selectedId={selectedId}
            onSelect={selectMatter}
            onNew={() => setCreating(true)}
            refreshing={feedLoading && feedState !== "loading"}
            deskDate={deskDate}
            onSync={handleSync}
            syncing={syncing || syncingClick}
          />
        </section>

        {/* Panel 2: Center Desk */}
        <section
          className={cn(
            "h-full min-h-0 min-w-0 flex-1 flex-col rounded-2xl border border-slate-200/80 bg-white shadow-sm overflow-hidden",
            panel === "desk" ? "flex" : "hidden lg:flex"
          )}
        >
          {detailErrorId != null && String(detailErrorId) === String(selectedId) && !selected?.next_steps ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 bg-white px-6 text-center">
              <span className="text-3xl" aria-hidden>☁️</span>
              <p className="text-sm font-medium text-slate-700">Server error</p>
              <p className="text-xs text-slate-500">This matter didn’t load.</p>
              <button
                type="button"
                onClick={() => setDetailTick((tick) => tick + 1)}
                className="rounded-full bg-orange-500 px-4 py-2 text-sm font-semibold text-white"
              >
                Retry
              </button>
            </div>
          ) : (
            <CenterDesk
              matter={deskBooting ? null : selected}
              loading={deskBooting || detailPending}
              notes={notes[selectedId] || []}
              pendingDraftId={pending?.kind === "draft" ? pending.id : null}
              onToggleStep={handleToggleStep}
              onSendDraft={handleSendDraft}
              onAsk={handleAsk}
              onStatus={handleStatus}
              onOpenChat={() => setPanel("chat")}
              onBack={() => setPanel("feed")}
            />
          )}
        </section>

        {/* Panel 3: Right Chat Stream */}
        <section
          className={cn(
            "h-full min-h-0 shrink-0 flex-col rounded-2xl border border-slate-200/80 bg-white shadow-sm overflow-hidden",
            "w-full lg:w-[380px] xl:w-[420px]",
            panel === "chat" ? "flex" : "hidden lg:flex"
          )}
        >
          <RightChatStream
            contactName={selected?.contact_name}
            phone={selected?.phone}
            senderJid={selected?.sender_jid}
            avatarUrl={selected?.avatar_url}
            messages={selected?.messages}
            loading={deskBooting || detailPending}
            pending={pending?.kind === "chat"}
            onSend={handleSendChat}
            onBack={() => setPanel("feed")}
          />
        </section>
      </div>

      {/* Mobile Bottom Navigation */}
      <nav
        aria-label="Desk sections"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-slate-200 bg-white lg:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {PANELS.map((item) => {
          const active = panel === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setPanel(item.id)}
              className={cn(
                "relative flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-semibold",
                active ? "text-orange-600" : "text-slate-500"
              )}
              aria-current={active ? "page" : undefined}
            >
              {active && (
                <motion.span
                  layoutId="deskTab"
                  className="absolute inset-x-8 top-0 h-0.5 rounded-full bg-orange-500"
                />
              )}
              <Icon className="h-4 w-4" />
              <span>{item.label}</span>
              {item.id === "feed" && stats.needs_you > 0 && (
                <span className="absolute right-[30%] top-2 h-2 w-2 rounded-full bg-rose-500" />
              )}
            </button>
          );
        })}
      </nav>

      <NewMatterDialog open={creating} onClose={closeDialog} onSubmit={handleCreate} />
    </div>
  );
}