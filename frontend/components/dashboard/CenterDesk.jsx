"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  Clock,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Phone,
} from "lucide-react";
import { STATUS_META, phoneFromJid } from "@/lib/matters";
import { copyText, cn } from "@/lib/utils";
import { useToast } from "@/components/ui/ToastProvider";

const MOVE_OPTIONS = ["NEEDS_YOU", "WAITING", "LATER", "DONE"];

export default function CenterDesk({
  matter,
  loading,
  notes,
  pendingDraftId,
  onToggleStep,
  onSendDraft,
  onAsk,
  onStatus,
  onOpenChat,
  onBack,
}) {
  const { push } = useToast();
  const [timelineOpen, setTimelineOpen] = useState(true);
  const [openDraftId, setOpenDraftId] = useState(null);
  const [draftText, setDraftText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [ask, setAsk] = useState("");

  useEffect(() => {
    setTimelineOpen(true);
    setOpenDraftId(null);
    setDraftText("");
    setMenuOpen(false);
    setAsk("");
  }, [matter?.id]);

  if (loading && !matter) {
    return (
      <section className="flex h-full min-h-0 flex-col bg-white p-6">
        <div className="h-7 w-1/3 animate-pulse rounded-lg bg-slate-100" />
        <div className="mt-5 h-72 animate-pulse rounded-2xl bg-slate-50" />
      </section>
    );
  }

  if (!matter) {
    return (
      <section className="flex h-full items-center justify-center bg-white px-6 text-center">
        <div>
          <p className="text-sm font-semibold text-slate-800">Select a matter</p>
          <p className="mt-1 text-sm text-slate-500">The action desk opens here.</p>
        </div>
      </section>
    );
  }

  const meta = STATUS_META[matter.status] || STATUS_META.LATER;
  const phone = matter.phone || phoneFromJid(matter.sender_jid);
  const steps = matter.next_steps || [];
  const drafts = matter.draft_options || [];
  const events = matter.timeline_events || [];
  const detailLoading = Boolean(loading);

  const callContact = () => {
    const tel = String(phone || "").replace(/[^\d+]/g, "");
    if (!tel) {
      push("No number on this contact");
      return;
    }
    window.location.href = `tel:${tel}`;
  };

  const title = String(matter.title || "Matter").trim();
  const headline = String(
    matter.headline || matter.core_problem || matter.summary || title
  ).trim();
  const situation = String(matter.situation || "").trim();

  const copySummary = async () => {
    try {
      await copyText([headline, situation].filter(Boolean).join("\n"));
      push("Matter summary copied");
    } catch {
      push("Could not copy the summary");
    }
  };

  const renderFormattedDescription = (text) => {
    if (!text) return null;
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRegex);

    return parts.map((part, index) => {
      if (part.match(urlRegex)) {
        return (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-sky-600 underline decoration-sky-300 underline-offset-2 hover:text-sky-700"
            onClick={(e) => e.stopPropagation()}
          >
            {part}
          </a>
        );
      }
      return <span key={index}>{part}</span>;
    });
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-white">
      {/* ── TOP HEADER BAR ── */}
      <header className="flex shrink-0 items-center justify-between border-b border-slate-100 bg-white px-5 py-3.5 lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to today"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-500 hover:bg-slate-100 lg:hidden"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[17px] font-bold tracking-tight text-slate-900">
              {title}
            </h1>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-tight",
                meta.pill || "bg-orange-50 text-orange-700 border-orange-200/60"
              )}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot || "bg-orange-500")} />
              {meta.label}
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            title="Snooze"
            onClick={() => onStatus("LATER")}
            className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200/80 text-slate-500 transition hover:bg-slate-50 hover:text-slate-800"
          >
            <Clock className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Done"
            onClick={() => onStatus("DONE")}
            className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200/80 text-slate-500 transition hover:bg-emerald-50 hover:text-emerald-600"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Call"
            onClick={callContact}
            className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200/80 text-slate-500 transition hover:bg-orange-50 hover:text-orange-600"
          >
            <Phone className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Open WhatsApp Chat"
            onClick={onOpenChat}
            className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200/80 text-slate-500 transition hover:bg-orange-50 hover:text-orange-600 lg:hidden"
          >
            <MessageCircle className="h-3.5 w-3.5" />
          </button>

          <div className="relative">
            <button
              type="button"
              title="More"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200/80 text-slate-500 transition hover:bg-slate-50 hover:text-slate-800"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            <AnimatePresence>
              {menuOpen && (
                <>
                  <button
                    type="button"
                    aria-label="Close menu"
                    className="fixed inset-0 z-20 cursor-default"
                    onClick={() => setMenuOpen(false)}
                  />
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    className="absolute right-0 top-9 z-30 w-44 rounded-xl border border-slate-200 bg-white p-1 shadow-lg"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        copySummary();
                      }}
                      className="block w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Copy summary
                    </button>
                    {MOVE_OPTIONS.map((option) => {
                      const item = STATUS_META[option];
                      return (
                        <button
                          key={option}
                          type="button"
                          onClick={() => {
                            setMenuOpen(false);
                            onStatus(option);
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-orange-50"
                        >
                          <span className={cn("h-1.5 w-1.5 rounded-full", item.dot)} />
                          {item.label}
                        </button>
                      );
                    })}
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        </div>
      </header>

      {/* ── SCROLLABLE ACTION BODY ── */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 lg:px-7">
        <div className="mx-auto w-full max-w-2xl space-y-6">
          {detailLoading ? (
            <div className="h-72 animate-pulse rounded-2xl bg-slate-50" />
          ) : (
            <>
              {/* Hero Narrative Question & Sub-caption */}
              <div>
                <h2 className="text-[17px] font-bold leading-snug tracking-tight text-slate-900">
                  {headline}
                </h2>
                {situation ? (
                  <p className="mt-1 text-[13.5px] leading-relaxed text-slate-500">
                    {situation}
                  </p>
                ) : null}
              </div>

              {/* YOUR NEXT STEP */}
              {steps.length > 0 && (
                <div>
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400 mb-2.5">
                    Your next step
                  </h3>
                  <ul className="space-y-2.5">
                    {steps.map((step) => {
                      const done = Boolean(step.is_completed);
                      return (
                        <li key={step.id}>
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={done}
                            onClick={() => onToggleStep(step)}
                            className="group flex w-full items-start gap-3 text-left"
                          >
                            <span
                              className={cn(
                                "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border transition",
                                done
                                  ? "border-orange-500 bg-orange-500 text-white"
                                  : "border-slate-300 bg-white group-hover:border-slate-400"
                              )}
                            >
                              {done && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                            </span>
                            <div className="min-w-0 flex-1">
                              <span
                                className={cn(
                                  "text-[13.5px] font-medium leading-snug transition-colors",
                                  done
                                    ? "text-slate-400 line-through"
                                    : "text-slate-800 group-hover:text-slate-900"
                                )}
                              >
                                {step.step_text}
                              </span>
                              {step.due_date && (
                                <p className="mt-0.5 text-[12px] text-slate-400">
                                  {step.due_date}
                                </p>
                              )}
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* PERISCLAW CAN (Scenario Rows) */}
              {drafts.length > 0 && (
                <div>
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400 mb-2">
                    Perisclaw can
                  </h3>
                  <ul className="divide-y divide-slate-100">
                    {drafts.map((draft) => {
                      const open = openDraftId === draft.id;
                      const sending = pendingDraftId === draft.id;
                      const kind = String(draft.action_type || "REPLY").toUpperCase();
                      const isCall = kind === "CALL";
                      const isHold = kind === "HOLD" || kind === "ARCHIVE";
                      const keepsOpen = isCall || isHold;

                      return (
                        <li key={draft.id} className="py-1 first:pt-0 last:pb-0">
                          <button
                            type="button"
                            disabled={sending}
                            onClick={() => {
                              if (isCall) {
                                callContact();
                                return;
                              }
                              if (isHold) {
                                push("Kept open — you'll handle this yourself");
                                return;
                              }
                              if (open) {
                                setOpenDraftId(null);
                                return;
                              }
                              setOpenDraftId(draft.id);
                              setDraftText(draft.draft_text || "");
                            }}
                            className="group flex w-full items-center justify-between rounded-lg px-2 py-2 text-left transition hover:bg-slate-50"
                          >
                            <div className="flex min-w-0 items-center gap-2.5">
                              <span className="text-[13px] leading-none text-sky-500" aria-hidden>
                                ✧
                              </span>
                              <span className="truncate text-[13.5px] font-medium text-slate-700 group-hover:text-slate-900">
                                {draft.action_label}
                              </span>
                              {draft.is_used && (
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600">
                                  · Sent
                                </span>
                              )}
                            </div>
                            <div className="ml-3 shrink-0">
                              {sending ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-500" />
                              ) : (
                                <ArrowRight className="h-3.5 w-3.5 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-slate-500" />
                              )}
                            </div>
                          </button>

                          {/* Quick Edit Accordion Box */}
                          {open && !keepsOpen && (
                            <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                              <textarea
                                value={draftText}
                                onChange={(event) => setDraftText(event.target.value)}
                                rows={3}
                                className="w-full resize-none rounded-lg border border-slate-200 bg-white p-2.5 text-xs leading-relaxed text-slate-800 outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
                              />
                              <div className="mt-2 flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => setOpenDraftId(null)}
                                  className="rounded-lg px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-100"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={sending || !draftText.trim()}
                                  onClick={async () => {
                                    try {
                                      await onSendDraft({ draft, text: draftText.trim() });
                                      setOpenDraftId(null);
                                    } catch {}
                                  }}
                                  className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-1 text-xs font-semibold text-white shadow-sm transition hover:bg-orange-600 disabled:opacity-50"
                                >
                                  {sending && <Loader2 className="h-3 w-3 animate-spin" />}
                                  Send Reply
                                </button>
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* How We Got Here Accordion */}
              <div className="border-t border-slate-100 pt-5">
                <button
                  type="button"
                  onClick={() => setTimelineOpen((open) => !open)}
                  aria-expanded={timelineOpen}
                  className="flex w-full items-center justify-between text-left"
                >
                  <span className="text-[13px] font-semibold text-slate-700">
                    How we got here
                  </span>
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 text-slate-400 transition-transform duration-200",
                      timelineOpen && "rotate-180"
                    )}
                  />
                </button>

                <AnimatePresence initial={false}>
                  {timelineOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      {events.length === 0 ? (
                        <p className="mt-2 text-xs text-slate-400">
                          No prior history on this matter.
                        </p>
                      ) : (
                        <ul className="mt-3 space-y-2">
                          {events.map((event) => (
                            <li
                              key={event.id}
                              className="flex items-start gap-2.5 text-[13px] leading-relaxed text-slate-600"
                            >
                              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-300" />
                              <div className="min-w-0 flex-1">
                                {event.date_label && event.date_label !== "Recent" && (
                                  <span className="font-semibold text-slate-800">
                                    {event.date_label}:{" "}
                                  </span>
                                )}
                                {renderFormattedDescription(event.event_description)}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {notes?.length > 0 && (
                <div className="space-y-2 border-t border-slate-100 pt-4">
                  {notes.map((note) => (
                    <div
                      key={note.id}
                      className="rounded-xl border border-orange-100 bg-orange-50/70 p-3"
                    >
                      <p className="text-xs font-semibold text-orange-700">{note.question}</p>
                      <p className="mt-1 text-xs leading-relaxed text-slate-700">{note.answer}</p>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── BOTTOM CHAT BAR ── */}
      <footer className="shrink-0 border-t border-slate-100 bg-white px-5 py-3">
        <form
          className="mx-auto flex w-full max-w-2xl items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-1.5 shadow-sm focus-within:border-orange-500 focus-within:bg-white focus-within:ring-1 focus-within:ring-orange-500 transition-all"
          onSubmit={(event) => {
            event.preventDefault();
            const question = ask.trim();
            if (!question) return;
            onAsk(question);
            setAsk("");
          }}
        >
          <span className="text-sm text-sky-500 select-none" aria-hidden>
            ✧
          </span>
          <input
            type="text"
            value={ask}
            onChange={(event) => setAsk(event.target.value)}
            placeholder="Ask Perisclaw about this..."
            className="flex-1 bg-transparent py-1 text-xs text-slate-800 outline-none placeholder:text-slate-400"
          />
          <button
            type="submit"
            disabled={!ask.trim()}
            className="grid h-7 w-7 place-items-center rounded-lg bg-orange-500 text-white transition hover:bg-orange-600 disabled:bg-slate-200 disabled:text-slate-400"
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </form>
      </footer>
    </section>
  );
}