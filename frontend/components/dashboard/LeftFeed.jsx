"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, Plus, Search, X } from "lucide-react";
import {
  FEED_TABS,
  STATUS_META,
  avatarTone,
  formatCardDate,
  initials,
} from "@/lib/matters";
import { cn } from "@/lib/utils";

function FeedAvatar({ name, avatarUrl, size = "md" }) {
  const [failed, setFailed] = useState(false);
  const dim = size === "sm" ? "h-4 w-4 text-[8px]" : "h-9 w-9 text-xs";
  if (avatarUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt={name || ""}
        referrerPolicy="no-referrer"
        className={cn("shrink-0 rounded-full object-cover", dim)}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-semibold",
        dim,
        avatarTone(name)
      )}
    >
      {initials(name)}
    </span>
  );
}

function StatusDot({ status }) {
  const meta = STATUS_META[status] || STATUS_META.LATER;
  if (status === "DONE" || status === "LATER") return null;
  return (
    <span
      className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)}
      title={meta.label}
      aria-label={meta.label}
    />
  );
}

function WhatsAppMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-3 w-3 shrink-0 text-[#25D366]"
      fill="currentColor"
    >
      <path d="M20.52 3.48A11.86 11.86 0 0 0 12.06 0C5.5 0 .16 5.33.16 11.89c0 2.1.55 4.15 1.6 5.96L0 24l6.3-1.65a11.9 11.9 0 0 0 5.76 1.47h.01c6.56 0 11.9-5.34 11.9-11.9 0-3.18-1.24-6.16-3.45-8.44zM12.07 21.8h-.01a9.88 9.88 0 0 1-5.03-1.38l-.36-.21-3.74.98 1-3.64-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.89 9.9-9.89 2.64 0 5.12 1.03 6.99 2.9a9.82 9.82 0 0 1 2.89 6.98c0 5.45-4.44 9.89-9.89 9.89zm5.42-7.4c-.3-.15-1.76-.87-2.03-.96-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.64.07-.3-.15-1.25-.46-2.38-1.47-.88-.78-1.47-1.75-1.64-2.05-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.22 3.08c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.08 1.76-.72 2.01-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35z" />
    </svg>
  );
}

function oneLine(value, fallback) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function MatterShimmerCards() {
  return (
    <div className="space-y-0.5" aria-busy="true" aria-label="Loading matters">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="animate-pulse rounded-2xl px-3 py-3">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 shrink-0 rounded-full bg-slate-200" />
            <div className="h-3.5 min-w-0 flex-1 rounded bg-slate-200" />
            <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
          </div>
          <div className="ml-[46px] mt-0.5 h-3.5 w-[88%] rounded bg-slate-100" />
          <div className="ml-[46px] mt-1 flex items-center justify-between gap-3">
            <div className="h-5 w-24 rounded-full bg-slate-100" />
            <div className="h-3 w-16 rounded bg-slate-100" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function LeftFeed({
  matters,
  loading,
  generating = false,
  needsYouCount,
  status,
  onStatus,
  search,
  onSearch,
  selectedId,
  onSelect,
  onNew,
  refreshing,
  deskDate,
  onSync,
  syncing,
}) {
  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-[#F7F8FA]">
      <header className="shrink-0 space-y-3 border-b border-slate-200/80 bg-white px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-serif text-2xl font-medium tracking-tight text-slate-900">Today</h1>
              {(refreshing || syncing) && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
              )}
            </div>
            {deskDate ? (
              <p className="mt-0.5 text-xs text-slate-500">{deskDate}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {onSync && (
              <button
                type="button"
                onClick={onSync}
                disabled={syncing}
                className="inline-flex items-center rounded-full border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60"
              >
                Sync
              </button>
            )}
            <button
              type="button"
              onClick={onNew}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
            >
              <Plus className="h-3.5 w-3.5" />
              New
            </button>
          </div>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search matters or chats"
            aria-label="Search matters or chats"
            className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-9 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-slate-400 focus:bg-white focus:ring-1 focus:ring-slate-300"
          />
          {search && (
            <button
              type="button"
              onClick={() => onSearch("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div
          role="tablist"
          aria-label="Triage"
          className="flex gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {FEED_TABS.map((tab) => {
            const active = status === tab.id;
            const count = tab.id === "NEEDS_YOU" ? needsYouCount : 0;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onStatus(tab.id)}
                className={cn(
                  "inline-flex shrink-0 items-center rounded-full px-3.5 py-1 text-[13px] font-medium transition-colors duration-200",
                  active
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                )}
              >
                {tab.id === "NEEDS_YOU" && count > 0 ? `${tab.label} ${count}` : tab.label}
              </button>
            );
          })}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {loading || (generating && matters.length === 0) ? (
          <div>
            <MatterShimmerCards />
            {generating ? (
              <p className="px-1 pt-3 text-center text-[11px] text-slate-400">
                Synthesizing pending commitments with GPT-4o...
              </p>
            ) : null}
          </div>
        ) : matters.length === 0 ? (
          <div className="px-2 py-10 text-center">
            <p className="text-sm font-medium text-slate-700">Nothing in this lane</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              {search ? `No matches for “${search}”.` : "New matters from WhatsApp will land here."}
            </p>
          </div>
        ) : (
          <ul className="space-y-0.5" aria-label="Matters">
            {matters.map((matter, index) => {
              const selected = String(matter.id) === String(selectedId);
              return (
                <motion.li
                  key={matter.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, delay: Math.min(index, 8) * 0.02 }}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(matter.id)}
                    aria-current={selected ? "true" : undefined}
                    className={cn(
                      "w-full rounded-2xl px-3 py-3 text-left transition-colors duration-200",
                      selected ? "bg-[#f4f4f5]/80" : "hover:bg-slate-50/80"
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="mt-0.5">
                        <FeedAvatar
                          name={matter.contact_name}
                          avatarUrl={matter.avatar_url}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="min-w-0 flex-1 text-[14.5px] font-semibold leading-snug tracking-tight text-slate-900 line-clamp-1">
                            {oneLine(matter.title, "Untitled matter")}
                          </p>
                          <StatusDot status={matter.status} />
                        </div>
                        {oneLine(matter.headline || matter.summary, "") ? (
                          <p className="mt-0.5 text-[13px] font-normal text-slate-600 line-clamp-1">
                            {oneLine(matter.headline || matter.summary, "")}
                          </p>
                        ) : null}
                        <div className="mt-1 flex items-center justify-between gap-3">
                          <span className="inline-flex min-w-0 max-w-[70%] items-center gap-1 overflow-hidden rounded-full border border-slate-200/60 bg-slate-50 px-2 py-0.5 text-[12px] text-slate-500">
                            <WhatsAppMark />
                            <span className="truncate">
                              {oneLine(matter.contact_name, "Unknown")}
                            </span>
                          </span>
                          <span className="shrink-0 text-[12px] font-normal text-slate-400">
                            {formatCardDate(matter.last_activity_at)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                </motion.li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

export function NewMatterDialog({ open, onClose, onSubmit }) {
  const [contactName, setContactName] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return undefined;
    setContactName("");
    setTitle("");
    setSummary("");
    setPhone("");
    setError("");
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-900/30 p-4 sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.form
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 12, opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              if (!contactName.trim() || !title.trim()) {
                setError("Contact and title are required.");
                return;
              }
              onSubmit({ contactName, title, summary, phone });
            }}
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-md"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-orange-600">
                  New matter
                </p>
                <h2 className="mt-1 text-lg font-bold text-slate-900">Open a desk item</h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <label className="mt-4 block text-xs font-medium text-slate-500">
              Contact
              <input
                autoFocus
                value={contactName}
                onChange={(event) => setContactName(event.target.value)}
                placeholder="Akash Bhaiya"
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
              />
            </label>
            <label className="mt-3 block text-xs font-medium text-slate-500">
              Title
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Previous insurance and missed meet"
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
              />
            </label>
            <label className="mt-3 block text-xs font-medium text-slate-500">
              What’s going on
              <textarea
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                rows={3}
                placeholder="Two lines on the problem and the clock."
                className="mt-1 w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
              />
            </label>
            <label className="mt-3 block text-xs font-medium text-slate-500">
              WhatsApp number
              <input
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+91 88023 97177"
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
              />
            </label>
            {error && <p className="mt-3 text-xs text-rose-600">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-full px-3 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-full bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-95"
              >
                Open matter
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
