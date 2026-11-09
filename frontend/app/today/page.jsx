"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Clock,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Phone,
  Plus,
  RotateCw,
  Search,
} from "lucide-react";
import RightChatStream from "@/components/dashboard/RightChatStream";
import { useToast } from "@/components/ui/ToastProvider";
import {
  bootstrapAuditFromMonitored,
  fetchAuditProgress,
  fetchInboxMessages,
  fetchMatterCards,
  matterCardAction,
  sendInboxMessage,
  sendMatterDraft,
  transcribeInboxAudio,
  updateMatterCardStatus,
} from "@/lib/api";
import {
  avatarTone,
  formatDeskDate,
  initials,
  phoneFromJid,
} from "@/lib/matters";
import {
  backgroundAnalysisFresh,
  clearBackgroundAnalysis,
} from "@/lib/syncSession";
import { cn, copyText } from "@/lib/utils";

const TABS = ["All", "Needs you", "Waiting", "Done"];

const STATUS_PILL = {
  "Needs you": "bg-rose-50 text-rose-600 border-rose-100",
  Waiting: "bg-amber-50 text-amber-700 border-amber-100",
  Later: "bg-slate-100 text-slate-600 border-slate-200",
  Done: "bg-emerald-50 text-emerald-600 border-emerald-100",
  Sessions: "bg-orange-50 text-orange-600 border-orange-100",
};

function priorityClass(dot) {
  if (dot === "red") return "bg-rose-500";
  if (dot === "orange") return "bg-amber-500";
  if (dot === "blue") return "bg-sky-500";
  return "bg-emerald-500";
}

function buildTimeline(matter) {
  if (Array.isArray(matter?.timeline_context) && matter.timeline_context.length) {
    return matter.timeline_context;
  }
  const notes = Array.isArray(matter?.resolved_notes) ? matter.resolved_notes : [];
  if (notes.length) {
    return notes.map((note) => {
      if (typeof note === "object" && note) {
        return { date: note.date || "Earlier", text: note.text || String(note) };
      }
      const raw = String(note);
      const match = raw.match(/^([^:]{2,24}):\s*(.+)$/);
      if (match) return { date: match[1], text: match[2] };
      return { date: "Note", text: raw };
    });
  }
  const label = matter?.source_label || "Contact";
  return [
    { date: "Earlier", text: `${label} shared context in this thread.` },
    { date: "Recent", text: matter?.summary || "Open items still need attention." },
  ];
}

const ACTION_SUFFIX_RE = /\s*[—\-–]\s*(draft reply|keep it open)\s*$/i;

function stripActionSuffix(reply) {
  return String(reply || "").replace(ACTION_SUFFIX_RE, "").trim();
}

function classifyQuickAction(reply, actionType) {
  const kind = String(actionType || "").toUpperCase();
  if (kind === "CALL" || kind === "HOLD" || kind === "ARCHIVE") return "keep it open";
  const text = String(reply || "");
  if (/call|keep it open|myself/i.test(text)) return "keep it open";
  return "draft reply";
}

function seedDraftText(reply, matter, draftText) {
  const fromOption = String(draftText || "").trim();
  if (fromOption) return fromOption;
  const raw = String(reply || "").trim();
  const cleaned = stripActionSuffix(raw);
  // Plain message without action suffix → use as sendable draft
  if (cleaned && cleaned === raw) return raw;
  const name = matter?.source_label || "there";
  if (/affirmative|confirm|yes|on it|got it/i.test(cleaned)) {
    return `Yes, confirmed — thanks ${name}.`;
  }
  if (/can't|cannot|apologis|sorry|unable|decline/i.test(cleaned)) {
    return `Sorry, I won't be able to take this on right now.`;
  }
  return cleaned || `Thanks ${name} — noted.`;
}

function buildQuickActions(matter) {
  const drafts = Array.isArray(matter?.draft_options) ? matter.draft_options : [];
  if (drafts.length) {
    return drafts.map((draft, idx) => {
      const label = draft.action_label || draft.draft_text || "Reply";
      return {
        id: draft.id ?? `draft-${idx}`,
        label,
        draftText: draft.draft_text || "",
        actionType: String(draft.action_type || "REPLY").toUpperCase(),
        action: classifyQuickAction(label, draft.action_type),
        isUsed: Boolean(draft.is_used),
        legacyDraft: draft.id != null && String(matter?.matter_id || "").startsWith("legacy_"),
      };
    });
  }
  const replies = Array.isArray(matter?.suggested_quick_replies)
    ? matter.suggested_quick_replies
    : [];
  return replies.map((reply, idx) => ({
    id: `reply-${idx}`,
    label: String(reply || ""),
    draftText: "",
    actionType: /call|keep it open|myself/i.test(String(reply || "")) ? "CALL" : "REPLY",
    action: classifyQuickAction(reply),
    isUsed: false,
    legacyDraft: false,
  }));
}

function MatterSkeleton() {
  return (
    <div className="flex items-start gap-2.5 p-3.5 animate-pulse">
      <div className="h-9 w-9 shrink-0 rounded-full bg-slate-200" />
      <div className="w-full space-y-2">
        <div className="h-3 w-1/2 rounded bg-slate-200" />
        <div className="h-2.5 w-4/5 rounded bg-slate-100" />
        <div className="h-2 w-1/4 rounded bg-slate-100" />
      </div>
    </div>
  );
}

function MatterAvatar({ name, avatarUrl, className = "h-9 w-9" }) {
  const [failed, setFailed] = useState(false);
  if (avatarUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt={name || ""}
        referrerPolicy="no-referrer"
        className={cn("shrink-0 rounded-full object-cover border border-amber-200", className)}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border border-amber-200 text-xs font-bold",
        avatarTone(name),
        className
      )}
    >
      {initials(name || "?")}
    </div>
  );
}

export default function TodayDeskPage() {
  const { push } = useToast();
  const [matters, setMatters] = useState([]);
  const [selectedMatter, setSelectedMatter] = useState(null);
  const [activeTab, setActiveTab] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [needsYouCount, setNeedsYouCount] = useState(0);
  const [isAuditing, setIsAuditing] = useState(false);
  const [completedJobs, setCompletedJobs] = useState(0);
  const [totalJobs, setTotalJobs] = useState(0);
  const [failedJobs, setFailedJobs] = useState(0);
  const [noActionJobs, setNoActionJobs] = useState(0);
  const [auditError, setAuditError] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [bgAnalysisFresh, setBgAnalysisFresh] = useState(() =>
    typeof window !== "undefined" ? backgroundAnalysisFresh() : false
  );
  const [isTimelineOpen, setIsTimelineOpen] = useState(true);
  const [customPrompt, setCustomPrompt] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSending, setChatSending] = useState(false);
  const [failedTranscriptIds, setFailedTranscriptIds] = useState(() => new Set());
  const [openDraftId, setOpenDraftId] = useState(null);
  const [draftText, setDraftText] = useState("");
  const [draftSending, setDraftSending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const selectedChatJidRef = useRef(null);
  const transcribeInflight = useRef(null);

  // Hold skeleton across the enqueue→progress race after Selection Desk Proceed.
  // NEVER show "No matters…" while loading or while background analysis is fresh.
  const showMatterSkeleton =
    isLoading || (bgAnalysisFresh && matters.length === 0);
  const isActivelyProcessing =
    isAuditing || (bgAnalysisFresh && matters.length === 0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 280);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const fetchMatters = useCallback(
    async (isManualSync = false) => {
      if (isManualSync) setIsSyncing(true);
      try {
        const data = await fetchMatterCards({
          status: activeTab === "All" ? "" : activeTab,
          search: debouncedSearch,
        });
        const loaded = Array.isArray(data?.cards)
          ? data.cards
          : Array.isArray(data?.matters)
            ? data.matters
            : Array.isArray(data)
              ? data
              : [];
        console.log("[TodayDesk] Cards received:", loaded.length);
        setMatters(loaded);
        setNeedsYouCount(data?.counts?.needs_you || 0);
        if (loaded.length > 0) {
          clearBackgroundAnalysis();
          setBgAnalysisFresh(false);
        }
        setSelectedMatter((prev) => {
          if (!loaded.length) return null;
          if (!prev) return loaded[0];
          return loaded.find((m) => m.matter_id === prev.matter_id) || loaded[0];
        });
      } catch (err) {
        console.error("[TodayDesk] Failed to fetch cards:", err);
      } finally {
        setIsLoading(false);
        if (isManualSync) setTimeout(() => setIsSyncing(false), 500);
      }
    },
    [activeTab, debouncedSearch]
  );

  useEffect(() => {
    let cancelled = false;
    let wasAuditing = false;
    let bootstrapAttempted = false;
    const checkProgress = async () => {
      try {
        const data = await fetchAuditProgress();
        if (cancelled) return;
        const auditing = Boolean(data?.is_auditing);
        const total = data?.total_jobs || 0;
        const completed = data?.completed_jobs || 0;
        const fresh = backgroundAnalysisFresh();
        setIsAuditing(auditing);
        setCompletedJobs(completed);
        setTotalJobs(total);
        setFailedJobs(data?.failed_jobs || 0);
        setNoActionJobs(data?.no_action_jobs || 0);
        setAuditError(data?.last_error || "");
        // Audit settled with zero cards: drop latch so empty/no-action UI can show
        if (!auditing && total > 0 && completed >= total) {
          clearBackgroundAnalysis();
          setBgAnalysisFresh(false);
        } else {
          setBgAnalysisFresh(fresh);
        }
        // Refresh while jobs run so cards appear one-by-one; also once when pool finishes
        if (auditing || wasAuditing || fresh) {
          fetchMatters(false);
        }
        // Stuck state: monitored chats exist but audit was never queued
        if (!auditing && total === 0 && !bootstrapAttempted) {
          bootstrapAttempted = true;
          try {
            const boot = await bootstrapAuditFromMonitored();
            if (cancelled) return;
            if (boot?.queued_jobs > 0) {
              setIsAuditing(true);
              setBgAnalysisFresh(true);
              setTotalJobs(boot.queued_jobs);
              setCompletedJobs(0);
              fetchMatters(false);
            } else if (!fresh) {
              setBgAnalysisFresh(false);
            }
          } catch (bootErr) {
            console.error("[TodayDesk] bootstrap audit failed:", bootErr);
          }
        }
        wasAuditing = auditing;
      } catch (e) {
        console.error("Progress check error", e);
        if (!cancelled) setBgAnalysisFresh(backgroundAnalysisFresh());
      }
    };
    checkProgress();
    // Poll every 2s so cards stream in as audit_single_chat finishes each chat
    const interval = setInterval(checkProgress, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchMatters]);

  useEffect(() => {
    fetchMatters(false);
  }, [fetchMatters]);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      // Re-queue idle monitored chats, then refresh cards
      try {
        await bootstrapAuditFromMonitored();
      } catch (e) {
        console.error("[TodayDesk] Sync bootstrap failed:", e);
      }
      await fetchMatters(true);
    } finally {
      setTimeout(() => setIsSyncing(false), 400);
    }
  };

  // Reset draft/menu when switching matters
  useEffect(() => {
    setOpenDraftId(null);
    setDraftText("");
    setMenuOpen(false);
    setDraftSending(false);
  }, [selectedMatter?.matter_id]);

  // Live WhatsApp mirror for selected matter's JID
  useEffect(() => {
    const jid = selectedMatter?.jid;
    selectedChatJidRef.current = jid || null;
    setFailedTranscriptIds(new Set());
    if (!jid) {
      setChatMessages([]);
      return undefined;
    }
    let cancelled = false;
    const load = async (silent = false) => {
      if (!silent) setChatLoading(true);
      try {
        const res = await fetchInboxMessages(jid, 100);
        if (cancelled || selectedChatJidRef.current !== jid) return;
        const items = Array.isArray(res?.messages)
          ? res.messages
          : Array.isArray(res?.data)
            ? res.data
            : Array.isArray(res)
              ? res
              : [];
        setChatMessages(items);
      } catch (err) {
        console.error("Chat load failed", err);
        if (!cancelled && selectedChatJidRef.current === jid) setChatMessages([]);
      } finally {
        if (!cancelled && selectedChatJidRef.current === jid) setChatLoading(false);
      }
    };
    load(false);
    const poll = setInterval(() => load(true), 12000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [selectedMatter?.jid]);

  // Auto-transcribe voice notes for the mirrored chat (same as Inbox)
  useEffect(() => {
    const jid = selectedMatter?.jid;
    if (!jid || chatLoading) return;
    const needs = chatMessages.filter(
      (m) =>
        m?.media_type === "audio" &&
        m?.media_path &&
        !/^\[voice note\]:/i.test(String(m?.text || "").trim())
    );
    const pendingIds = needs
      .map((m) => m.id)
      .filter((id) => id != null && !failedTranscriptIds.has(id));
    if (!pendingIds.length || transcribeInflight.current === jid) return;

    const chatJid = jid;
    transcribeInflight.current = chatJid;
    const applyUpdates = (updated) => {
      const byId = new Map((updated || []).map((row) => [row.id, row.text]));
      if (!byId.size) return;
      setChatMessages((prev) =>
        prev.map((message) =>
          byId.has(message.id) ? { ...message, text: byId.get(message.id) } : message
        )
      );
    };

    (async () => {
      const failed = new Set();
      try {
        let guard = 0;
        let remaining = 1;
        while (remaining > 0 && guard < 4 && selectedChatJidRef.current === chatJid) {
          guard += 1;
          const res = await transcribeInboxAudio(chatJid);
          if (selectedChatJidRef.current !== chatJid) return;
          applyUpdates(res?.updated);
          (res?.failed || []).forEach((id) => failed.add(id));
          remaining = Number(res?.remaining || 0);
          if (!(res?.updated || []).length && !(res?.failed || []).length) break;
        }
      } catch (err) {
        console.error("Voice note transcription failed:", err);
        pendingIds.forEach((id) => failed.add(id));
      } finally {
        if (transcribeInflight.current === chatJid) transcribeInflight.current = null;
        if (selectedChatJidRef.current === chatJid && failed.size) {
          setFailedTranscriptIds((prev) => {
            const next = new Set(prev);
            failed.forEach((id) => next.add(id));
            return next;
          });
        }
      }
    })();
  }, [selectedMatter?.jid, chatMessages, chatLoading, failedTranscriptIds]);

  const timeline = useMemo(() => buildTimeline(selectedMatter), [selectedMatter]);

  const toggleChecklist = async (index) => {
    if (!selectedMatter) return;
    const checklist = Array.isArray(selectedMatter.action_checklist)
      ? selectedMatter.action_checklist
      : [];
    const item = checklist[index];
    if (!item) return;
    const nextDone = !item.done;

    const optimistic = {
      ...selectedMatter,
      action_checklist: checklist.map((row, i) =>
        i === index ? { ...row, done: nextDone } : row
      ),
    };
    setSelectedMatter(optimistic);
    setMatters((prev) =>
      prev.map((m) => (m.matter_id === optimistic.matter_id ? optimistic : m))
    );

    try {
      const res = await matterCardAction(selectedMatter.matter_id, {
        checklist_item: { index, done: nextDone },
      });
      if (res?.matter) {
        setSelectedMatter(res.matter);
        setMatters((prev) =>
          prev.map((m) => (m.matter_id === res.matter.matter_id ? res.matter : m))
        );
      }
    } catch (err) {
      console.error("Checklist update failed", err);
      fetchMatters(false);
    }
  };

  const setStatus = async (newStatus) => {
    if (!selectedMatter || statusBusy) return;
    if (selectedMatter.status_filter === newStatus) {
      push(`Already marked ${newStatus}`);
      return;
    }
    setStatusBusy(true);
    try {
      await updateMatterCardStatus(selectedMatter.matter_id, newStatus);
      const updated = { ...selectedMatter, status_filter: newStatus };
      setSelectedMatter(updated);
      setMatters((prev) =>
        prev.map((m) => (m.matter_id === updated.matter_id ? updated : m))
      );
      push(`Moved to ${newStatus}`);
    } catch (err) {
      console.error("Status update failed", err);
      push("Could not update status");
    } finally {
      setStatusBusy(false);
    }
  };

  const callContact = () => {
    const tel = String(phoneFromJid(selectedMatter?.jid) || "").replace(/[^\d+]/g, "");
    if (!tel) {
      push("No number on this contact");
      return;
    }
    push(`Calling ${selectedMatter?.source_label || tel}…`);
    window.location.href = `tel:${tel}`;
  };

  const copySummary = async () => {
    if (!selectedMatter) return;
    const blob = [
      selectedMatter.headline,
      selectedMatter.summary,
      selectedMatter.context_note,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await copyText(blob);
      push("Matter summary copied");
    } catch {
      push("Could not copy the summary");
    }
  };

  const handleQuickAction = (item) => {
    if (!selectedMatter || draftSending) return;
    if (item.action === "keep it open") {
      if (/call|myself/i.test(item.label) || item.actionType === "CALL") {
        callContact();
        return;
      }
      push("Kept open — you'll handle this yourself");
      return;
    }
    if (openDraftId === item.id) {
      setOpenDraftId(null);
      return;
    }
    setOpenDraftId(item.id);
    setDraftText(seedDraftText(item.label, selectedMatter, item.draftText));
  };

  const handleSendDraft = async (item) => {
    const text = String(draftText || "").trim();
    const jid = selectedMatter?.jid;
    if (!selectedMatter || !text || draftSending) return;
    setDraftSending(true);
    try {
      if (item.legacyDraft && selectedMatter.id != null) {
        const payload =
          item.id != null && text === String(item.draftText || "").trim()
            ? { draft_id: item.id }
            : { custom_text: text, draft_id: item.id };
        await sendMatterDraft(selectedMatter.id, payload);
      } else {
        if (!jid) {
          push("No WhatsApp chat linked to this matter");
          return;
        }
        await sendInboxMessage(jid, text);
        const res = await fetchInboxMessages(jid, 100);
        const items = Array.isArray(res?.messages)
          ? res.messages
          : Array.isArray(res?.data)
            ? res.data
            : Array.isArray(res)
              ? res
              : [];
        if (selectedChatJidRef.current === jid) setChatMessages(items);
      }
      setOpenDraftId(null);
      setDraftText("");
      if (selectedMatter.status_filter !== "Waiting") {
        try {
          await updateMatterCardStatus(selectedMatter.matter_id, "Waiting");
          const updated = { ...selectedMatter, status_filter: "Waiting" };
          setSelectedMatter(updated);
          setMatters((prev) =>
            prev.map((m) => (m.matter_id === updated.matter_id ? updated : m))
          );
        } catch (statusErr) {
          console.error("Post-send status update failed", statusErr);
        }
      }
      push("Reply sent on WhatsApp");
    } catch (err) {
      console.error("Draft send failed", err);
      push("WhatsApp did not send that reply");
    } finally {
      setDraftSending(false);
    }
  };

  const handleSendChat = async (text) => {
    const jid = selectedMatter?.jid;
    const value = String(text || "").trim();
    if (!jid || !value || chatSending) return;
    setChatSending(true);
    try {
      await sendInboxMessage(jid, value);
      const res = await fetchInboxMessages(jid, 100);
      const items = Array.isArray(res?.messages)
        ? res.messages
        : Array.isArray(res?.data)
          ? res.data
          : Array.isArray(res)
            ? res
            : [];
      if (selectedChatJidRef.current === jid) setChatMessages(items);
      push("Message sent");
    } catch (err) {
      console.error("Send failed", err);
      push("WhatsApp did not send that message");
      throw err;
    } finally {
      setChatSending(false);
    }
  };

  const deskDate = formatDeskDate(new Date());
  const quickActions = useMemo(
    () => buildQuickActions(selectedMatter),
    [selectedMatter]
  );
  const MOVE_OPTIONS = ["Needs you", "Waiting", "Later", "Done"];

  return (
    <div className="flex h-full w-full gap-2 overflow-hidden bg-transparent text-slate-900 antialiased select-none md:gap-2.5">
      {/* Left Matters Stream — floating card */}
      <section className="flex h-full w-[22rem] shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04),0_4px_16px_rgba(15,23,42,0.04)] lg:w-[24rem]">
        <div className="flex items-center justify-between border-b border-slate-100 p-4 pb-3">
          <div>
            <h1 className="font-serif text-xl font-bold tracking-tight text-slate-900">Today</h1>
            <p className="text-xs font-medium text-slate-400">{deskDate}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSync}
              disabled={isSyncing}
              className={cn(
                "flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50",
                isSyncing && "opacity-60"
              )}
            >
              <RotateCw className={cn("h-3 w-3", isSyncing && "animate-spin text-orange-600")} />
              Sync
            </button>
            <button
              type="button"
              className="flex items-center gap-1 rounded-md bg-slate-950 px-2.5 py-1.5 text-xs font-medium text-white shadow-xs transition hover:bg-slate-800"
            >
              <Plus className="h-3 w-3" />
              New
            </button>
          </div>
        </div>

        <div className="px-3.5 py-2.5">
          <div className="relative">
            <Search className="absolute top-2.5 left-3 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search matters or chats"
              className="w-full rounded-md border border-slate-200 bg-slate-50/80 py-1.5 pr-3 pl-8 text-xs placeholder-slate-400 transition focus:bg-white focus:ring-1 focus:ring-slate-900 focus:outline-none"
            />
          </div>
        </div>

        <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto border-b border-slate-100 px-3.5 pb-2.5">
          {TABS.map((tab) => {
            const isActive = activeTab === tab;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "flex items-center gap-1 whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-all",
                  isActive
                    ? "bg-slate-950 text-white shadow-xs"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200/70"
                )}
              >
                {tab}
                {tab === "Needs you" && needsYouCount > 0 && (
                  <span
                    className={cn(
                      "ml-0.5 text-[10px]",
                      isActive ? "font-bold text-orange-300" : "text-slate-500"
                    )}
                  >
                    {needsYouCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {isActivelyProcessing && (
            <div className="flex items-center justify-between border-b border-amber-200/50 bg-amber-50/70 p-2.5 text-[11px] text-amber-800">
              <span className="flex animate-pulse items-center gap-1.5 font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                Analyzing selected conversations…
                {totalJobs > 0 ? ` (${completedJobs}/${totalJobs})` : ""}
              </span>
              {totalJobs > 0 && (
                <span className="font-semibold">
                  {Math.round((completedJobs / (totalJobs || 1)) * 100)}%
                </span>
              )}
            </div>
          )}

          {/* SKELETON: loading or background audit with nothing loaded yet */}
          {showMatterSkeleton && (
            <div className="divide-y divide-slate-100">
              {isActivelyProcessing && matters.length === 0 && (
                <p className="px-3.5 py-3 text-center text-[11px] font-medium text-slate-500">
                  Analyzing selected conversations…
                </p>
              )}
              <div className="animate-pulse divide-y divide-slate-100">
                {[1, 2, 3, 4, 5].map((n) => (
                  <MatterSkeleton key={n} />
                ))}
              </div>
            </div>
          )}

          {/* REAL MATTERS — hide while skeleton-only (audit still warming up) */}
          {!showMatterSkeleton &&
            matters.map((m) => {
              const isSelected = selectedMatter?.matter_id === m.matter_id;
              return (
                <button
                  key={m.matter_id}
                  type="button"
                  onClick={() => setSelectedMatter(m)}
                  className={cn(
                    "relative flex w-full items-start justify-between gap-2.5 border-b border-slate-100 p-3.5 text-left transition-all",
                    isSelected
                      ? "border-l-[3px] border-l-orange-500 bg-slate-100/70"
                      : "hover:bg-slate-50/70"
                  )}
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <MatterAvatar
                      name={m.source_label}
                      avatarUrl={m.avatar_url}
                      className="h-9 w-9"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <h3
                          className={cn(
                            "truncate text-sm font-semibold",
                            isSelected ? "font-bold text-slate-950" : "text-slate-800"
                          )}
                        >
                          {m.headline}
                        </h3>
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            priorityClass(m.priority_dot)
                          )}
                        />
                      </div>
                      <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-slate-500">
                        {m.summary}
                      </p>
                      <div className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-slate-500">
                        <MessageSquare className="h-3 w-3 text-emerald-600" />
                        <span className="max-w-36 truncate">{m.source_label}</span>
                      </div>
                    </div>
                  </div>
                  <span className="mt-0.5 shrink-0 text-[11px] font-medium text-slate-400">
                    {m.timestamp_display}
                  </span>
                </button>
              );
            })}

          {/* EMPTY STATE: only when not loading / not actively processing — never during bg analysis */}
          {!showMatterSkeleton && !isActivelyProcessing && matters.length === 0 && (
            <div className="space-y-2 p-8 text-center text-xs text-slate-400">
              {noActionJobs > 0 && totalJobs > 0 && failedJobs === 0 ? (
                <>
                  <p className="font-medium text-slate-500">
                    Audit finished — no actionable matters found.
                  </p>
                  <p>
                    Selected chats were reviewed over the last 10 days, but nothing
                    needed follow-up. Try Sync after new messages arrive.
                  </p>
                </>
              ) : (
                <p>No matters in this filter yet.</p>
              )}
              {failedJobs > 0 && (
                <p className="text-rose-500">
                  {failedJobs} chat audit{failedJobs === 1 ? "" : "s"} failed
                  {/credits|429/i.test(auditError)
                    ? " — OpenAI credits exhausted. Add billing, then hit Sync."
                    : auditError
                      ? ` — ${String(auditError).slice(0, 120)}`
                      : ". Try Sync."}
                </p>
              )}
              <button
                type="button"
                onClick={handleSync}
                className="mt-1 text-[11px] font-semibold text-orange-600 hover:underline"
              >
                Sync monitored chats
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Center Core Canvas — floating card */}
      <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04),0_4px_16px_rgba(15,23,42,0.04)]">
        {selectedMatter ? (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-start justify-between border-b border-slate-100 p-5">
              <div className="flex min-w-0 items-center gap-3">
                <h2 className="truncate text-base font-bold tracking-tight text-slate-900">
                  {selectedMatter.headline}
                </h2>
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-semibold",
                    STATUS_PILL[selectedMatter.status_filter] || STATUS_PILL["Needs you"]
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      selectedMatter.status_filter === "Needs you"
                        ? "bg-rose-500"
                        : selectedMatter.status_filter === "Waiting"
                          ? "bg-amber-500"
                          : selectedMatter.status_filter === "Done"
                            ? "bg-emerald-500"
                            : "bg-slate-400"
                    )}
                  />
                  {selectedMatter.status_filter}
                </span>
              </div>
              <div className="relative flex items-center gap-1.5 text-slate-400">
                <button
                  type="button"
                  onClick={() => setStatus("Later")}
                  disabled={statusBusy}
                  className={cn(
                    "rounded-lg border border-transparent p-1.5 transition",
                    "hover:border-slate-200 hover:bg-slate-100 hover:text-slate-700",
                    "active:scale-95 active:bg-slate-200",
                    "disabled:opacity-50",
                    selectedMatter.status_filter === "Later" &&
                      "border-slate-200 bg-slate-100 text-slate-700"
                  )}
                  title="Snooze / Later"
                  aria-label="Snooze / Later"
                >
                  <Clock className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setStatus("Done")}
                  disabled={statusBusy}
                  className={cn(
                    "rounded-lg border border-transparent p-1.5 transition",
                    "hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-600",
                    "active:scale-95 active:bg-emerald-100",
                    "disabled:opacity-50",
                    selectedMatter.status_filter === "Done" &&
                      "border-emerald-200 bg-emerald-50 text-emerald-600"
                  )}
                  title="Mark Done"
                  aria-label="Mark Done"
                >
                  <Check className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={callContact}
                  className="rounded-lg border border-transparent p-1.5 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600 active:scale-95 active:bg-orange-100"
                  title="Call Contact"
                  aria-label="Call Contact"
                >
                  <Phone className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setMenuOpen((open) => !open)}
                  aria-expanded={menuOpen}
                  className={cn(
                    "rounded-lg border border-transparent p-1.5 transition",
                    "hover:border-slate-200 hover:bg-slate-100 hover:text-slate-700",
                    "active:scale-95 active:bg-slate-200",
                    menuOpen && "border-slate-200 bg-slate-100 text-slate-700"
                  )}
                  title="More actions"
                  aria-label="More actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {menuOpen && (
                  <>
                    <button
                      type="button"
                      aria-label="Close menu"
                      className="fixed inset-0 z-20 cursor-default"
                      onClick={() => setMenuOpen(false)}
                    />
                    <div className="absolute right-0 top-9 z-30 w-44 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          copySummary();
                        }}
                        className="block w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 active:bg-slate-100"
                      >
                        Copy summary
                      </button>
                      {MOVE_OPTIONS.map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => {
                            setMenuOpen(false);
                            setStatus(option);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-orange-50 active:bg-orange-100",
                            selectedMatter.status_filter === option && "bg-slate-50"
                          )}
                        >
                          <span
                            className={cn(
                              "h-1.5 w-1.5 rounded-full",
                              option === "Needs you"
                                ? "bg-rose-500"
                                : option === "Waiting"
                                  ? "bg-amber-500"
                                  : option === "Done"
                                    ? "bg-emerald-500"
                                    : "bg-slate-400"
                            )}
                          />
                          {option}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto p-6">
              <div className="space-y-1">
                <h3 className="text-sm leading-snug font-bold text-slate-900">
                  {selectedMatter.summary}
                </h3>
                <p className="text-xs text-slate-500">
                  {selectedMatter.context_note ||
                    `${selectedMatter.source_label} asked earlier today; only you know.`}
                </p>
              </div>

              <div className="space-y-3">
                <span className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                  YOUR NEXT STEP
                </span>
                <div className="space-y-2">
                  {(selectedMatter.action_checklist || []).map((item, idx) => (
                    <button
                      key={`${selectedMatter.matter_id}-step-${idx}`}
                      type="button"
                      onClick={() => toggleChecklist(idx)}
                      className="group flex w-full items-start gap-2.5 text-left"
                    >
                      <div
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition",
                          item.done
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-300 bg-white group-hover:border-slate-600"
                        )}
                      >
                        {item.done && <Check className="h-2.5 w-2.5" />}
                      </div>
                      <span
                        className={cn(
                          "text-xs leading-relaxed text-slate-800",
                          item.done && "text-slate-400 line-through"
                        )}
                      >
                        {item.text}
                      </span>
                    </button>
                  ))}
                  {(selectedMatter.action_checklist || []).length === 0 && (
                    <p className="text-xs text-slate-400">No next steps extracted yet.</p>
                  )}
                </div>
              </div>

              <div className="space-y-2.5 pt-2">
                <span className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                  PERISCLAW CAN
                </span>
                <div className="space-y-2">
                  {quickActions.map((item) => {
                    const highlight = item.action === "keep it open";
                    const open = openDraftId === item.id;
                    const title = stripActionSuffix(item.label) || item.label;
                    return (
                      <div key={`${selectedMatter.matter_id}-${item.id}`}>
                        <button
                          type="button"
                          disabled={draftSending}
                          onClick={() => handleQuickAction(item)}
                          className={cn(
                            "group flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition",
                            "active:scale-[0.99]",
                            highlight
                              ? "border-sky-200 bg-sky-50/80 hover:bg-sky-50"
                              : open
                                ? "border-orange-300 bg-orange-50/70"
                                : "border-slate-200/80 bg-slate-50/70 hover:border-orange-200 hover:bg-orange-50/50",
                            draftSending && "opacity-60"
                          )}
                        >
                          <div className="flex min-w-0 items-center gap-2 pr-2">
                            <span className="text-xs text-sky-500">✧</span>
                            <span className="truncate text-xs font-medium text-slate-700 group-hover:text-slate-950">
                              {title}
                              <span className="ml-1 font-semibold text-slate-500">
                                — {item.action}
                              </span>
                              {item.isUsed && (
                                <span className="ml-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-600">
                                  · Sent
                                </span>
                              )}
                            </span>
                          </div>
                          {draftSending && open ? (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-orange-500" />
                          ) : (
                            <ArrowRight
                              className={cn(
                                "h-3.5 w-3.5 shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-orange-600",
                                open && "rotate-90 text-orange-600"
                              )}
                            />
                          )}
                        </button>
                        {open && item.action === "draft reply" && (
                          <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                            <textarea
                              value={draftText}
                              onChange={(event) => setDraftText(event.target.value)}
                              rows={3}
                              className="w-full resize-none rounded-lg border border-slate-200 bg-white p-2.5 text-xs leading-relaxed text-slate-800 outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
                              placeholder="Edit the reply before sending…"
                            />
                            <div className="mt-2 flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setOpenDraftId(null)}
                                className="rounded-lg px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-100 active:bg-slate-200"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                disabled={draftSending || !draftText.trim()}
                                onClick={() => handleSendDraft(item)}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-1 text-xs font-semibold text-white shadow-sm transition hover:bg-orange-600 active:scale-95 disabled:opacity-50"
                              >
                                {draftSending && (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                )}
                                Send Reply
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {quickActions.length === 0 && (
                    <p className="text-xs text-slate-400">No draft actions yet.</p>
                  )}
                </div>
              </div>

              <div className="border-t border-slate-100 pt-2">
                <button
                  type="button"
                  onClick={() => setIsTimelineOpen((v) => !v)}
                  className="flex w-full items-center justify-between py-1 text-left text-slate-700"
                >
                  <span className="text-xs font-semibold">How we got here</span>
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 text-slate-400 transition-transform",
                      isTimelineOpen && "rotate-180"
                    )}
                  />
                </button>
                {isTimelineOpen && (
                  <div className="mt-2 space-y-1.5 border-l-2 border-slate-200 pl-2 text-xs text-slate-600">
                    {timeline.map((t, idx) => (
                      <div key={`${t.date}-${idx}`} className="leading-relaxed">
                        <strong className="font-semibold text-slate-800">{t.date}: </strong>
                        <span>{t.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-slate-100 bg-white p-4">
              <div className="relative flex items-center">
                <span className="absolute left-3 text-xs text-orange-500">✧</span>
                <input
                  type="text"
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="Ask Perisclaw about this..."
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2.5 pr-10 pl-7 text-xs placeholder-slate-400 transition focus:bg-white focus:ring-1 focus:ring-slate-900 focus:outline-none"
                />
                <button
                  type="button"
                  className="absolute right-2.5 p-1 text-slate-400 transition hover:text-slate-800"
                >
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-xs text-slate-400">
            <p>Select a matter from the left to inspect action steps.</p>
          </div>
        )}
      </main>

      {/* Right WhatsApp Chat Mirror — floating card */}
      <aside className="hidden h-full w-80 shrink-0 overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04),0_4px_16px_rgba(15,23,42,0.04)] lg:flex lg:w-[26rem]">
        {selectedMatter?.jid ? (
          <RightChatStream
            contactName={selectedMatter.source_label || "WhatsApp"}
            phone={phoneFromJid(selectedMatter.jid)}
            senderJid={selectedMatter.jid}
            avatarUrl={selectedMatter.avatar_url}
            messages={chatMessages}
            loading={chatLoading}
            pending={chatSending}
            onSend={handleSendChat}
            failedTranscriptIds={failedTranscriptIds}
            onRetryTranscript={() => {
              transcribeInflight.current = null;
              setFailedTranscriptIds(new Set());
            }}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center rounded-xl bg-[#efeae2] px-6 text-center text-xs text-slate-500">
            <p>Select a matter to mirror its WhatsApp chat.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
