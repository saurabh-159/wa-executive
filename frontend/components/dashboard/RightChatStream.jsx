"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCheck,
  ChevronLeft,
  Loader2,
  Mic,
  Paperclip,
  Phone,
  Send,
  Smile,
} from "lucide-react";
import {
  avatarTone,
  formatClock,
  formatDayChip,
  initials,
  messageBody,
  normalizeTs,
  phoneFromJid,
} from "@/lib/matters";
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

const EMOJIS = ["👍", "🙏", "✅", "📄", "⏰", "🤝", "👋", "✨"];
const EMPTY_MESSAGES = [];

function messageKey(message) {
  return message?.id ?? message?.message_id ?? null;
}

function voiceTranscript(text) {
  const raw = String(text || "").trim();
  if (!raw.toLowerCase().startsWith("[voice note]:")) return "";
  return raw.replace(/^\[voice note\]:\s*/i, "").trim();
}

function isPlaceholderCaption(text) {
  const raw = String(text || "").trim().toLowerCase();
  return !raw || raw === "[photo]" || raw === "[voice note]" || raw === "[video]" || raw === "[media]";
}

function MessageMedia({ message, transcriptFailed, onRetryTranscript }) {
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
            className="max-h-72 w-full max-w-[15rem] rounded-lg object-cover transition hover:opacity-95"
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

  if (message.media_type === "video" && src) {
    return (
      <video
        controls
        preload="metadata"
        src={src}
        className="mb-1 max-h-72 w-full max-w-[15rem] rounded-lg bg-black"
      />
    );
  }

  if (message.media_type === "audio") {
    return (
      <div className="mb-1 w-64 max-w-full space-y-1.5">
        {src ? (
          <audio controls preload="metadata" src={src} className="h-9 w-60 max-w-full" />
        ) : null}
        <div className="flex items-start gap-1.5 rounded-lg bg-black/[0.04] px-2.5 py-2">
          <Mic className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#667781]" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[#667781]">
              Voice note
            </p>
            <p
              className={cn(
                "mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed",
                transcript ? "text-[#111b21]" : "text-[#667781]"
              )}
            >
              {transcript ||
                (transcriptFailed
                  ? "Transcript unavailable — tap Retry"
                  : "Transcribing…")}
            </p>
            {transcriptFailed && !transcript && onRetryTranscript ? (
              <button
                type="button"
                onClick={onRetryTranscript}
                className="mt-1 text-[11px] font-semibold text-orange-600 hover:underline"
              >
                Retry transcript
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

function ChatAvatar({ name, avatarUrl }) {
  const [failed, setFailed] = useState(false);
  if (avatarUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt={name || ""}
        referrerPolicy="no-referrer"
        className="h-10 w-10 rounded-full object-cover"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div
      className={cn(
        "grid h-10 w-10 place-items-center rounded-full text-sm font-semibold",
        avatarTone(name)
      )}
    >
      {initials(name || "?")}
    </div>
  );
}

export default function RightChatStream({
  contactName,
  phone,
  senderJid,
  avatarUrl,
  messages,
  loading,
  pending,
  onSend,
  onBack,
  failedTranscriptIds,
  onRetryTranscript,
}) {
  const scrollerRef = useRef(null);
  const messagesEndRef = useRef(null);
  const scrollMetaRef = useRef({ jid: null, lastId: null, len: 0, initial: true });
  const fileRef = useRef(null);
  const [text, setText] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const isGroup = String(senderJid || "").endsWith("@g.us");
  const displayPhone = isGroup ? "" : phone || phoneFromJid(senderJid);
  const thread = messages || EMPTY_MESSAGES;

  const online = useMemo(() => {
    const last = thread[thread.length - 1];
    const ms = normalizeTs(last?.timestamp);
    if (Number.isNaN(ms)) return false;
    return Date.now() - ms < 6 * 60 * 60 * 1000;
  }, [thread]);

  const groups = useMemo(() => {
    const buckets = [];
    thread.forEach((message) => {
      const label = formatDayChip(message.timestamp) || "Earlier";
      const key = label;
      const last = buckets[buckets.length - 1];
      if (!last || last.key !== key) buckets.push({ key, label, items: [message] });
      else last.items.push(message);
    });
    return buckets;
  }, [thread]);

  useEffect(() => {
    scrollMetaRef.current = { jid: senderJid, lastId: null, len: 0, initial: true };
  }, [senderJid]);

  useEffect(() => {
    const container = scrollerRef.current;
    if (!container || loading) return;

    const lastId = messageKey(thread[thread.length - 1]);
    const prev = scrollMetaRef.current;
    const chatChanged = prev.jid !== senderJid || prev.initial;

    if (chatChanged) {
      scrollMetaRef.current = {
        jid: senderJid,
        lastId,
        len: thread.length,
        initial: false,
      };
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
      return;
    }

    const appended =
      thread.length > prev.len || (lastId != null && lastId !== prev.lastId);
    scrollMetaRef.current = {
      jid: senderJid,
      lastId,
      len: thread.length,
      initial: false,
    };

    if (!appended) return;

    const isAtBottom =
      container.scrollHeight - container.scrollTop <= container.clientHeight + 100;
    if (isAtBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [thread, loading, senderJid]);

  useEffect(() => {
    setText("");
    setEmojiOpen(false);
  }, [contactName, senderJid]);

  useEffect(() => {
    if (!emojiOpen) return undefined;
    const close = () => setEmojiOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [emojiOpen]);

  const submit = async (event) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || pending) return;
    setText("");
    setEmojiOpen(false);
    try {
      await onSend(value);
    } catch {
      setText(value);
    }
  };

  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-[#F0F2F5]">
      <header className="flex shrink-0 items-center gap-3 bg-white px-3 py-3 shadow-sm">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to today"
          className="grid h-8 w-8 place-items-center rounded-full text-slate-500 hover:bg-slate-100 lg:hidden"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="relative">
          <ChatAvatar name={contactName} avatarUrl={avatarUrl} />
          {online && (
            <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">
            {contactName || "WhatsApp"}
          </p>
          <p className="flex items-center gap-1.5 truncate text-xs text-slate-500">
            <span>{isGroup ? "WhatsApp group" : displayPhone || "No number"}</span>
            {online && (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span className="font-medium text-emerald-600">online</span>
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          title="Call"
          onClick={() => {
            const tel = String(displayPhone || "").replace(/[^\d+]/g, "");
            if (tel) window.location.href = `tel:${tel}`;
          }}
          className="grid h-9 w-9 place-items-center rounded-full text-slate-500 hover:bg-slate-100"
        >
          <Phone className="h-4 w-4" />
        </button>
      </header>

      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4"
        style={WA_CHAT_BG}
      >
        {loading ? (
          <div className="space-y-3">
            <div className="h-12 w-3/5 animate-pulse rounded-2xl rounded-tl-none bg-white" />
            <div className="ml-auto h-12 w-2/3 animate-pulse rounded-2xl rounded-tr-none bg-[#d9fdd3]" />
            <div className="h-16 w-4/5 animate-pulse rounded-2xl rounded-tl-none bg-white" />
          </div>
        ) : thread.length === 0 ? (
          <div className="mx-auto mt-8 max-w-[240px] rounded-xl bg-white/80 px-3 py-2 text-center text-xs leading-relaxed text-[#667781] shadow-sm">
            No messages in this chat yet. A reply from the desk will land here.
          </div>
        ) : (
          <>
            {groups.map((group) => (
              <div key={group.key} className="mb-2">
                <div className="sticky top-1 z-[1] mx-auto mb-3 w-fit rounded-lg bg-white px-2 py-1 text-xs font-medium text-[#54656f] shadow-sm">
                  {group.label}
                </div>
                <div className="space-y-1.5">
                  {group.items.map((message, idx) => {
                    const mine = Boolean(message.is_from_me);
                    const isAudio = message.media_type === "audio";
                    const isImage = message.media_type === "image";
                    const isVideo = message.media_type === "video";
                    const hasMedia =
                      (Boolean(message?.media_path) && (isImage || isAudio || isVideo)) ||
                      isAudio;
                    const caption = String(message?.text || "").trim();
                    const showCaption =
                      hasMedia && !isAudio && caption && !isPlaceholderCaption(caption);
                    const body = hasMedia
                      ? showCaption
                        ? caption
                        : ""
                      : messageBody(message);
                    const sender =
                      message.participant_name || message.sender_name || message.sender || null;
                    const bubbleKey =
                      message.id || message.message_id || `${group.key}-${idx}`;
                    return (
                      <div
                        key={bubbleKey}
                        className={cn("flex", mine ? "justify-end" : "justify-start")}
                      >
                        <div
                          className={cn(
                            "relative w-fit max-w-[88%] px-2.5 pb-1.5 pt-1.5 text-[13.5px] leading-snug text-[#111b21] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]",
                            mine
                              ? "rounded-lg rounded-tr-none bg-[#d9fdd3]"
                              : "rounded-lg rounded-tl-none bg-white"
                          )}
                        >
                          <span
                            className={cn(
                              "absolute top-0 h-3 w-3",
                              mine
                                ? "-right-1.5 bg-[#d9fdd3] [clip-path:polygon(0_0,100%_0,0_100%)]"
                                : "-left-1.5 bg-white [clip-path:polygon(100%_0,0_0,100%_100%)]"
                            )}
                          />
                          {!mine && isGroup && sender ? (
                            <span className="mb-0.5 block px-0.5 text-[11px] font-semibold text-[#7f66ff]">
                              {sender}
                            </span>
                          ) : null}
                          <MessageMedia
                            message={message}
                            transcriptFailed={Boolean(
                              message?.id != null &&
                                failedTranscriptIds?.has?.(message.id)
                            )}
                            onRetryTranscript={onRetryTranscript}
                          />
                          {body ? (
                            <p className="whitespace-pre-wrap break-words px-0.5 [overflow-wrap:anywhere]">
                              {body}
                            </p>
                          ) : null}
                          <div className="mt-0.5 flex items-center justify-end gap-1 pl-6 text-[10px] leading-none text-[#667781]">
                            <span>{formatClock(message.timestamp)}</span>
                            {mine &&
                              (message.pending ? (
                                <Check className="h-3.5 w-3.5 text-slate-400" />
                              ) : (
                                <CheckCheck className="h-3.5 w-3.5 text-[#53bdeb]" />
                              ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} aria-hidden className="h-px w-full shrink-0" />
          </>
        )}
      </div>

      <form onSubmit={submit} className="relative flex shrink-0 items-end gap-2 bg-white px-3 py-2.5">
        {emojiOpen && (
          <div
            className="absolute bottom-16 left-3 z-10 flex gap-1 rounded-2xl border border-slate-200 bg-white p-2 shadow-md"
            onClick={(event) => event.stopPropagation()}
          >
            {EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  setText((current) => `${current}${emoji}`);
                  setEmojiOpen(false);
                }}
                className="grid h-8 w-8 place-items-center rounded-full text-base hover:bg-orange-50"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          aria-label="Emoji"
          onClick={(event) => {
            event.stopPropagation();
            setEmojiOpen((open) => !open);
          }}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-slate-500 hover:bg-slate-100"
        >
          <Smile className="h-5 w-5" />
        </button>
        <button
          type="button"
          aria-label="Attach a file"
          onClick={() => fileRef.current?.click()}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-slate-500 hover:bg-slate-100"
        >
          <Paperclip className="h-5 w-5" />
        </button>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            setText((current) => `${current}${current ? " " : ""}[${file.name}]`);
          }}
        />
        <textarea
          value={text}
          rows={1}
          onChange={(event) => {
            setText(event.target.value);
            const node = event.target;
            node.style.height = "auto";
            node.style.height = `${Math.min(node.scrollHeight, 112)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Message"
          aria-label="Message"
          className="max-h-28 min-h-[40px] flex-1 resize-none rounded-3xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!text.trim() || pending}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </form>
    </section>
  );
}
