"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  Search,
  Send,
  CheckCheck,
  Phone,
  RefreshCw,
  MessageSquare,
  ArrowLeft,
  Mic,
} from "lucide-react";
import ChatSummaryWidget from "@/components/inbox/ChatSummaryWidget";
import {
  fetchInboxChats,
  fetchInboxMessages,
  fetchMatters,
  fetchSyncStatus,
  sendInboxMessage,
  transcribeInboxAudio,
} from "@/lib/api";
import {
  backgroundAnalysisFresh,
  clearBackgroundAnalysis,
  markBackgroundAnalysis,
} from "@/lib/syncSession";
import { cn } from "@/lib/utils";

const MEDIA_BASE = (process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000").replace(
  /\/$/,
  ""
);

const WA_CHAT_BG = {
  backgroundColor: "#efeae2",
  backgroundImage: "url('/wa-doodle.png')",
  backgroundRepeat: "repeat",
  backgroundSize: "412px 732px",
  backgroundPosition: "center",
};

const AVATAR_COLORS = [
  "bg-[#ff7a1a]",
  "bg-[#00a884]",
  "bg-[#53bdeb]",
  "bg-[#7f66ff]",
  "bg-[#e05d5d]",
  "bg-[#e6a23c]",
  "bg-[#128c7e]",
  "bg-[#a855f7]",
];

function avatarColor(seed) {
  const key = String(seed || "");
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash + key.charCodeAt(i) * (i + 1)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[hash];
}

function formatPhone(phone) {
  if (phone == null || phone === "") return "";
  const raw = String(phone);
  if (/@(lid|g\.us|broadcast|hosted\.lid)$/i.test(raw)) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  if (digits.length === 10) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  // LIDs are 14+ digits. Never present one as an international number.
  if (digits.length >= 14) return "";
  if (digits.length >= 11 && digits.length <= 13) return `+${digits}`;
  return "";
}

function displayName(chat) {
  const name = (chat?.name || "").trim();
  if (/^\d{14,}$/.test(name)) return formatPhone(chat?.phone) || "Unknown";
  const isGroup = Boolean(chat?.is_group) || String(chat?.jid || "").endsWith("@g.us");
  if (/^(you \(self\)|note to self)/i.test(name)) return name;
  if (isGroup) {
    if (name && !/^(group|whatsapp group|you|unknown|unknown contact|user)$/i.test(name)) return name;
    return name || "WhatsApp Group";
  }
  const generic = !name || /^(user|you|unknown|unknown contact|group|whatsapp group)$/i.test(name);
  if (!generic) return name;
  return formatPhone(chat?.phone) || "Unknown";
}

function avatarLetter(label) {
  const text = String(label || "").trim();
  const letter = text.match(/[A-Za-z]/);
  if (letter) return letter[0].toUpperCase();
  const digits = text.replace(/\D/g, "");
  return digits.slice(-2) || "?";
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function listTime(ts) {
  if (!ts) return "";
  const date = new Date(ts * 1000);
  const diff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (diff === 0) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diff === 1) return "Yesterday";
  if (diff < 7) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { day: "2-digit", month: "short" });
}

function dayLabel(ts) {
  if (!ts) return "";
  const date = new Date(ts * 1000);
  const diff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

function clockTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function voiceTranscript(text) {
  const raw = String(text || "").trim();
  if (!raw.toLowerCase().startsWith("[voice note]:")) return "";
  return raw.replace(/^\[voice note\]:\s*/i, "").trim();
}

function previewText(chat) {
  const transcript = voiceTranscript(chat?.last_message);
  const raw = String(chat?.last_message || "").replace(/\s+/g, " ").trim();
  if (transcript) return transcript.replace(/\s+/g, " ");
  if (raw === "[Photo]" || raw === "[Voice Note]" || raw === "[Video]") return raw;
  if (raw && raw !== "[Media]") return raw;
  if (chat?.media_type === "image") return "[Photo]";
  if (chat?.media_type === "audio") return "[Voice Note]";
  if (chat?.media_type === "video") return "[Video]";
  return "No messages yet";
}

function messageBody(message) {
  if (message?.text) return message.text;
  if (message?.media_type === "image") return "Photo";
  if (message?.media_type === "audio") return "Audio";
  if (message?.media_type === "video") return "Video";
  if (message?.media_type) return "Attachment";
  return "";
}

function dedupeChats(list) {
  const seen = new Set();
  const unique = [];
  for (const chat of list || []) {
    if (!chat?.jid || seen.has(chat.jid)) continue;
    seen.add(chat.jid);
    unique.push(chat);
  }
  return unique;
}

function Avatar({ label, seed, avatarUrl, className }) {
  const [imgFailed, setImgFailed] = useState(false);
  const text = avatarLetter(label);

  if (avatarUrl && !imgFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt={label || ""}
        referrerPolicy="no-referrer"
        className={cn("shrink-0 rounded-full object-cover", className)}
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <div
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-semibold text-white",
        avatarColor(seed),
        text.length > 1 ? "text-[11px]" : "text-base",
        className
      )}
    >
      {text}
    </div>
  );
}

function messageKey(message) {
  return message?.id ?? message?.message_id ?? null;
}

function messagesFingerprint(list) {
  return (list || [])
    .map((m) => `${messageKey(m)}:${m?.text || ""}:${m?.media_path || ""}`)
    .join("|");
}

function needsTranscript(message) {
  return message?.media_type === "audio" && Boolean(message?.media_path) && !voiceTranscript(message?.text);
}

function MessageMedia({ message, transcriptFailed }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  if (!message?.media_path && message?.media_type !== "audio") return null;
  const src = message?.media_path ? `${MEDIA_BASE}/media/${message.media_path}` : null;
  const transcript = voiceTranscript(message?.text);

  if (message.media_type === "image" && src) {
    return (
      <>
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          className="mb-1 block overflow-hidden rounded-lg text-left"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt=""
            className="my-1 max-h-64 w-full max-w-xs cursor-pointer rounded-lg object-cover transition hover:opacity-95"
          />
        </button>
        {previewOpen && (
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4"
            onClick={() => setPreviewOpen(false)}
            role="dialog"
            aria-modal="true"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt=""
              className="max-h-[90vh] max-w-full rounded-lg object-contain"
              onClick={(event) => event.stopPropagation()}
            />
          </div>
        )}
      </>
    );
  }

  if (message.media_type === "audio") {
    return (
      <div className="mb-1 w-full min-w-[240px] max-w-sm space-y-1.5">
        {src ? (
          <audio controls preload="metadata" src={src} className="h-8 w-full max-w-full" />
        ) : null}
        <div className="flex items-start gap-1.5 rounded-lg bg-black/[0.04] px-2.5 py-2">
          <Mic className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#667781]" aria-hidden />
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[#667781]">Transcript</p>
            <p
              className={cn(
                "mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed",
                transcript ? "text-[#111b21]" : "text-[#667781]"
              )}
            >
              {transcript || (transcriptFailed ? "Transcript unavailable" : "Transcribing…")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

export default function InboxPage() {
  const [chats, setChats] = useState([]);
  const [selectedJid, setSelectedJid] = useState(null);
  const [activeChat, setActiveChat] = useState(null);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [inputText, setInputText] = useState("");
  const [loadingChats, setLoadingChats] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [failedTranscriptIds, setFailedTranscriptIds] = useState(() => new Set());

  const scrollerRef = useRef(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const selectedRef = useRef(null);
  const messagesFpRef = useRef("");
  const scrollMetaRef = useRef({ jid: null, lastId: null, len: 0, initial: true });
  const transcribeInflight = useRef(null);
  selectedRef.current = selectedJid;

  const loadChats = async (silent = false) => {
    if (!silent) setLoadingChats(true);
    try {
      const res = await fetchInboxChats(searchQuery);
      if (res.status === "success") {
        const unique = dedupeChats(res.data);
        setChats(unique);
        const desktop = window.matchMedia("(min-width: 768px)").matches;
        if (!selectedRef.current && unique.length > 0 && desktop) {
          setSelectedJid(unique[0].jid);
        }
      }
    } catch (err) {
      console.error("Failed to load inbox chats:", err);
    } finally {
      if (!silent) setLoadingChats(false);
    }
  };

  useEffect(() => {
    loadChats();
  }, [searchQuery]);

  const loadMessages = async (jid, silent = false) => {
    if (!silent) setLoadingMessages(true);
    try {
      const res = await fetchInboxMessages(jid);
      if (res.status === "success") {
        const next = res.data || [];
        const fp = messagesFingerprint(next);
        if (silent && fp === messagesFpRef.current) return;
        messagesFpRef.current = fp;
        setMessages(next);
        return res;
      }
    } catch (err) {
      console.error("Failed to load messages:", err);
    } finally {
      if (!silent) setLoadingMessages(false);
    }
    return null;
  };

  useEffect(() => {
    messagesFpRef.current = "";
    scrollMetaRef.current = { jid: selectedJid, lastId: null, len: 0, initial: true };
    setFailedTranscriptIds(new Set());
    if (!selectedJid) {
      setMessages([]);
      return undefined;
    }

    let cancelled = false;
    let reloadTimer = null;
    (async () => {
      const res = await loadMessages(selectedJid);
      if (cancelled) return;
      // If WhatsApp on-demand backfill was requested, refresh once after ingest.
      const bf = res?.history_backfill;
      if (bf?.ok && !bf?.skipped) {
        reloadTimer = window.setTimeout(() => {
          if (!cancelled) loadMessages(selectedJid, true);
        }, 7000);
      }
    })();

    return () => {
      cancelled = true;
      if (reloadTimer) window.clearTimeout(reloadTimer);
    };
  }, [selectedJid]);

  useEffect(() => {
    if (!selectedJid || loadingMessages) return;
    const pendingIds = messages.filter(needsTranscript).map((message) => message.id).filter((id) => id != null);
    const stillPending = pendingIds.filter((id) => !failedTranscriptIds.has(id));
    if (!stillPending.length || transcribeInflight.current === selectedJid) return;

    const chatJid = selectedJid;
    transcribeInflight.current = chatJid;

    const applyUpdates = (updated) => {
      const byId = new Map((updated || []).map((row) => [row.id, row.text]));
      if (!byId.size) return;
      setMessages((prev) => prev.map((message) => (byId.has(message.id) ? { ...message, text: byId.get(message.id) } : message)));
    };

    (async () => {
      const failed = new Set();
      try {
        let guard = 0;
        let remaining = 1;
        while (remaining > 0 && guard < 4 && selectedRef.current === chatJid) {
          guard += 1;
          const res = await transcribeInboxAudio(chatJid);
          if (selectedRef.current !== chatJid) return;
          applyUpdates(res?.updated);
          (res?.failed || []).forEach((id) => failed.add(id));
          remaining = Number(res?.remaining || 0);
          if (!(res?.updated || []).length && !(res?.failed || []).length) break;
        }
      } catch (err) {
        console.error("Voice note transcription failed:", err);
        stillPending.forEach((id) => failed.add(id));
      } finally {
        if (transcribeInflight.current === chatJid) transcribeInflight.current = null;
        if (selectedRef.current === chatJid && failed.size) {
          setFailedTranscriptIds((prev) => {
            const next = new Set(prev);
            failed.forEach((id) => next.add(id));
            return next;
          });
        }
      }
    })();
  }, [selectedJid, messages, loadingMessages, failedTranscriptIds]);

  useEffect(() => {
    const found = chats.find((chat) => chat.jid === selectedJid);
    if (found) setActiveChat(found);
  }, [chats, selectedJid]);

  useEffect(() => {
    const container = scrollerRef.current;
    if (!container || loadingMessages) return;

    const lastId = messageKey(messages[messages.length - 1]);
    const prev = scrollMetaRef.current;
    const chatChanged = prev.jid !== selectedJid || prev.initial;

    if (chatChanged) {
      scrollMetaRef.current = {
        jid: selectedJid,
        lastId,
        len: messages.length,
        initial: false,
      };
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
      return;
    }

    const appended =
      messages.length > prev.len || (lastId != null && lastId !== prev.lastId);
    scrollMetaRef.current = {
      jid: selectedJid,
      lastId,
      len: messages.length,
      initial: false,
    };

    if (!appended) return;

    const isAtBottom =
      container.scrollHeight - container.scrollTop <= container.clientHeight + 100;
    if (isAtBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, selectedJid, loadingMessages]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [inputText]);

  // No background chats/messages interval — load on search/select/send/manual refresh only

  useEffect(() => {
    const onLogout = () => {
      setChats([]);
      setSelectedJid(null);
      setActiveChat(null);
      setMessages([]);
      setMobileChatOpen(false);
      setInputText("");
      setLoadingChats(false);
      setLoadingMessages(false);
      setAnalyzing(false);
      clearBackgroundAnalysis();
    };
    window.addEventListener("wa-logout", onLogout);
    return () => window.removeEventListener("wa-logout", onLogout);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const stop = () => {
      if (timer) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const tick = async () => {
      const sync = await fetchSyncStatus();
      if (cancelled) return;

      const connectedNow = Boolean(sync?.connected);
      const syncingNow = Boolean(sync?.isSyncing);
      const historyDone = Boolean(
        sync?.historyCompleted || sync?.isHistorySyncComplete
      );
      const historyBusy = syncingNow || (connectedNow && !historyDone);

      if (historyBusy) {
        markBackgroundAnalysis();
        setAnalyzing(true);
        return;
      }

      if (connectedNow && historyDone && backgroundAnalysisFresh()) {
        try {
          const res = await fetchMatters();
          if (cancelled) return;
          const rows = Array.isArray(res?.data) ? res.data : [];
          if (rows.length > 0) {
            clearBackgroundAnalysis();
            setAnalyzing(false);
            stop();
          } else {
            setAnalyzing(true);
          }
        } catch {
          if (!cancelled) setAnalyzing(true);
        }
        return;
      }

      setAnalyzing(false);
      // History sync complete — stop sync-status polling on the desk
      stop();
    };

    tick();
    timer = window.setInterval(tick, 2500);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  const openChat = (jid) => {
    setSelectedJid(jid);
    setMobileChatOpen(true);
  };

  const handleSendMessage = async (event) => {
    event?.preventDefault();
    if (!inputText.trim() || !selectedJid || sending) return;

    const textToSend = inputText.trim();
    setInputText("");
    setSending(true);

    try {
      await sendInboxMessage(selectedJid, textToSend);
      await loadMessages(selectedJid, true);
      await loadChats(true);
    } catch (err) {
      console.error("Send message error:", err);
      setInputText(textToSend);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const onComposerKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSendMessage(event);
    }
  };

  const selectedContact = activeChat?.jid === selectedJid ? activeChat : chats.find((chat) => chat.jid === selectedJid);
  const contactTitle = selectedContact ? displayName(selectedContact) : "";
  const contactPhone = selectedContact?.is_group ? "" : formatPhone(selectedContact?.phone);
  const canCall = Boolean(contactPhone);

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-slate-200/80 bg-white text-slate-900 shadow-[0_1px_3px_rgba(15,23,42,0.04),0_4px_16px_rgba(15,23,42,0.04)]">
      {analyzing ? (
        <div
          className="flex shrink-0 items-center justify-center gap-2 border-b border-sky-100 bg-sky-50/95 px-3 py-2 text-xs text-slate-700"
          role="status"
          aria-live="polite"
        >
          <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
          </span>
          <p className="min-w-0 truncate">
            ⚡ Perisclaw AI is analyzing priority matters in the background...
          </p>
          <Link
            href="/"
            className="shrink-0 font-semibold text-sky-700 underline-offset-2 hover:underline"
          >
            Today Desk
          </Link>
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <aside
        className={cn(
          "h-full min-h-0 w-full shrink-0 flex-col border-[#e9edef] bg-white md:flex md:w-[340px] md:border-r lg:w-[390px] xl:w-[420px]",
          mobileChatOpen ? "hidden" : "flex"
        )}
      >
        <div className="flex items-center justify-between bg-[#f0f2f5] px-4 py-3">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-[#111b21]">Chats</h1>
            <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-[#667781]">
              {chats.length}
            </span>
          </div>
          <button
            type="button"
            onClick={() => loadChats()}
            title="Refresh chats"
            className="grid h-9 w-9 place-items-center rounded-full text-[#54656f] transition hover:bg-white"
          >
            <RefreshCw className={cn("h-4 w-4", loadingChats && "animate-spin")} />
          </button>
        </div>

        <div className="bg-white px-3 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#667781]" />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search or start a new chat"
              className="h-9 w-full rounded-lg bg-[#f0f2f5] pl-9 pr-3 text-sm text-[#111b21] outline-none placeholder:text-[#667781] focus:ring-2 focus:ring-[#ff7a1a]/30"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {loadingChats ? (
            <div className="space-y-1 px-2 py-2">
              {Array.from({ length: 8 }).map((_, index) => (
                <div key={index} className="flex items-center gap-3 px-2 py-2.5">
                  <div className="h-12 w-12 shrink-0 rounded-full bg-[#f0f2f5]" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="h-3 w-1/2 rounded bg-[#f0f2f5]" />
                    <div className="h-2.5 w-4/5 rounded bg-[#f5f6f6]" />
                  </div>
                </div>
              ))}
            </div>
          ) : chats.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-[#667781]">
              No chats found. Link WhatsApp from Settings.
            </div>
          ) : (
            chats.map((chat) => {
              const title = displayName(chat);
              const isSelected = selectedJid === chat.jid;
              return (
                <button
                  key={chat.jid}
                  type="button"
                  onClick={() => openChat(chat.jid)}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2.5 text-left transition",
                    isSelected ? "bg-[#f0f2f5]" : "hover:bg-[#f5f6f6]"
                  )}
                >
                  <Avatar
                    label={title}
                    seed={chat.jid}
                    avatarUrl={chat.avatar_url}
                    className="h-12 w-12"
                  />
                  <div className="min-w-0 flex-1 border-b border-[#f0f2f5] py-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <h2 className="truncate text-[15px] font-medium text-[#111b21]">{title}</h2>
                      <span
                        className={cn(
                          "shrink-0 text-[11px]",
                          isSelected ? "text-[#ff7a1a]" : "text-[#667781]"
                        )}
                      >
                        {chat.last_message_time || listTime(chat.last_timestamp)}
                      </span>
                    </div>
                    <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[13px] text-[#667781]">
                      {chat.is_from_me && (
                        <CheckCheck className="h-4 w-4 shrink-0 text-[#53bdeb]" />
                      )}
                      <span className="truncate">{previewText(chat)}</span>
                    </p>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <main
        className={cn(
          "h-full min-h-0 min-w-0 flex-1 flex-col bg-[#efeae2]",
          mobileChatOpen ? "flex" : "hidden md:flex"
        )}
      >
        {selectedContact ? (
          <>
            <header className="z-10 flex items-center gap-1 bg-[#f0f2f5] px-2 py-2 sm:gap-2 sm:px-3">
              <button
                type="button"
                onClick={() => setMobileChatOpen(false)}
                className="grid h-10 w-10 place-items-center rounded-full text-[#54656f] hover:bg-black/5 md:hidden"
                aria-label="Back to chats"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <Avatar
                label={contactTitle}
                seed={selectedContact.jid}
                avatarUrl={selectedContact.avatar_url}
                className="h-10 w-10 text-sm"
              />
              <div className="min-w-0 flex-1 px-1">
                <h2 className="truncate text-[16px] font-medium leading-tight text-[#111b21]">
                  {contactTitle}
                </h2>
                {contactPhone && contactPhone !== contactTitle && (
                  <p className="truncate text-xs text-[#667781]">{contactPhone}</p>
                )}
              </div>
              {canCall ? (
                <a
                  href={`tel:+${String(selectedContact.phone).replace(/\D/g, "")}`}
                  className="grid h-10 w-10 place-items-center rounded-full text-[#54656f] hover:bg-black/5"
                  title="Call"
                >
                  <Phone className="h-5 w-5" />
                </a>
              ) : null}
            </header>

            <ChatSummaryWidget jid={selectedJid} />

            <div
              ref={scrollerRef}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-6 md:px-8 lg:px-16"
              style={WA_CHAT_BG}
            >
              {loadingMessages ? (
                <p className="py-10 text-center text-sm text-[#667781]">Loading conversation...</p>
              ) : messages.length === 0 ? (
                <p className="py-10 text-center text-sm text-[#667781]">No messages in this chat yet.</p>
              ) : (
                <div className="mx-auto flex w-full max-w-4xl flex-col gap-1.5">
                  {messages.map((message, index) => {
                    const isMe = message.is_from_me;
                    const previous = messages[index - 1];
                    const showDay =
                      !previous || dayLabel(previous.timestamp) !== dayLabel(message.timestamp);
                    const caption = String(message?.text || "").trim();
                    const isAudio = message.media_type === "audio";
                    const hasMedia =
                      (Boolean(message?.media_path) &&
                        (message.media_type === "image" || isAudio)) ||
                      isAudio;
                    const body = hasMedia
                      ? isAudio
                        ? ""
                        : caption
                      : messageBody(message);
                    return (
                      <React.Fragment key={message.id || `${message.timestamp}-${index}`}>
                        {showDay && message.timestamp ? (
                          <div className="my-2 flex justify-center">
                            <span className="rounded-lg bg-white px-3 py-1 text-xs text-[#54656f] shadow-sm">
                              {dayLabel(message.timestamp)}
                            </span>
                          </div>
                        ) : null}
                        <div className={cn("flex", isMe ? "justify-end" : "justify-start")}>
                          <div
                            className={cn(
                              "relative w-fit max-w-[88%] px-2.5 pb-1.5 pt-1.5 text-[14.5px] leading-snug text-[#111b21] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] sm:max-w-[75%] lg:max-w-[68%]",
                              isMe
                                ? "rounded-lg rounded-tr-none bg-[#d9fdd3]"
                                : "rounded-lg rounded-tl-none bg-white"
                            )}
                          >
                            <span
                              className={cn(
                                "absolute top-0 h-3 w-3",
                                isMe
                                  ? "-right-1.5 bg-[#d9fdd3] [clip-path:polygon(0_0,100%_0,0_100%)]"
                                  : "-left-1.5 bg-white [clip-path:polygon(100%_0,0_0,100%_100%)]"
                              )}
                            />
                            <MessageMedia
                              message={message}
                              transcriptFailed={failedTranscriptIds.has(message.id)}
                            />
                            {body ? (
                              <p className="whitespace-pre-wrap break-words px-0.5 [overflow-wrap:anywhere]">
                                {body}
                              </p>
                            ) : null}
                            <span className="mt-0.5 flex items-center justify-end gap-1 pl-6 text-[11px] leading-none text-[#667781]">
                              {clockTime(message.timestamp)}
                              {isMe && <CheckCheck className="h-3.5 w-3.5 text-[#53bdeb]" />}
                            </span>
                          </div>
                        </div>
                      </React.Fragment>
                    );
                  })}
                  <div ref={messagesEndRef} aria-hidden className="h-px w-full shrink-0" />
                </div>
              )}
            </div>

            <form
              onSubmit={handleSendMessage}
              className="flex items-end gap-2 bg-[#f0f2f5] px-2 py-2 sm:px-3"
            >
              <textarea
                ref={inputRef}
                rows={1}
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                onKeyDown={onComposerKeyDown}
                placeholder="Type a message"
                disabled={sending}
                className="max-h-32 min-h-11 flex-1 resize-none rounded-3xl bg-white px-4 py-2.5 text-sm leading-5 text-[#111b21] outline-none placeholder:text-[#667781] disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={!inputText.trim() || sending}
                aria-label="Send message"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#ff7a1a] text-white transition hover:bg-[#f0680a] disabled:opacity-40"
              >
                <Send className="h-[18px] w-[18px]" />
              </button>
            </form>
          </>
        ) : (
          <div
            className="hidden h-full flex-1 flex-col items-center justify-center px-6 text-center md:flex"
            style={WA_CHAT_BG}
          >
            <div className="mb-4 grid h-24 w-24 place-items-center rounded-full bg-white/80 text-[#ff7a1a] shadow-sm">
              <MessageSquare className="h-11 w-11" />
            </div>
            <h2 className="text-2xl font-light text-[#41525d]">WhatsApp inbox</h2>
            <p className="mt-2 max-w-sm text-sm text-[#667781]">
              Pick a chat to read the thread and reply from here.
            </p>
          </div>
        )}
      </main>
      </div>
    </div>
  );
}
