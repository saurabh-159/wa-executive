"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Copy, Loader2, Quote, Sparkles, X } from "lucide-react";
import Badge from "@/components/ui/Badge";
import PriorityIndicator from "@/components/ui/PriorityIndicator";
import { buildWhatsAppReminder, copyText, formatDeadline } from "@/lib/utils";

function useDesktop() {
  const [desktop, setDesktop] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return desktop;
}

export default function TaskDetailModal({
  task,
  completing,
  onClose,
  onComplete,
  onCopied,
  onCopyFailed,
}) {
  const desktop = useDesktop();
  const [mounted, setMounted] = useState(false);
  const [copying, setCopying] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!task) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [task, onClose]);

  if (!mounted) return null;

  const slide = desktop
    ? { initial: { x: "100%" }, animate: { x: 0 }, exit: { x: "100%" } }
    : { initial: { y: "100%" }, animate: { y: 0 }, exit: { y: "100%" } };

  return createPortal(
    <AnimatePresence>
      {task && (
        <>
          <motion.button
            type="button"
            aria-label="Close task details"
            className="fixed inset-0 z-40 bg-ink/35 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-detail-title"
            className="fixed z-50 flex flex-col border-line bg-surface/95 backdrop-blur-xl inset-x-0 bottom-0 max-h-[min(88vh,760px)] rounded-t-3xl border-t md:inset-y-0 md:left-auto md:right-0 md:h-full md:max-h-none md:w-[440px] md:rounded-none md:border-l md:border-t-0"
            initial={slide.initial}
            animate={slide.animate}
            exit={slide.exit}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
          >
            <div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-line md:hidden" />
            <div className="flex items-start justify-between gap-3 px-5 pb-4 pt-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <PriorityIndicator priority={task.priority} />
                  <Badge category={task.category} />
                </div>
                <h2 id="task-detail-title" className="mt-3 text-lg font-semibold tracking-tight text-ink">
                  {task.task_heading}
                </h2>
                <p className="mt-1 text-sm text-muted">
                  {task.counterparty_name} · {formatDeadline(task.due_date_time)}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line text-muted hover:text-ink"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 overflow-y-auto px-5 pb-4">
              <section className="rounded-2xl border border-saffron/25 bg-saffron-soft p-4">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-saffron-deep">
                  <Quote className="h-3.5 w-3.5" />
                  Their message
                </p>
                <p className="mt-2 text-sm italic leading-relaxed text-ink">
                  “{task.context_their_message || "No quote was captured from their side."}”
                </p>
              </section>

              <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-700">
                  <Quote className="h-3.5 w-3.5" />
                  Your reply
                </p>
                <p className="mt-2 text-sm italic leading-relaxed text-ink">
                  “{task.context_your_reply || "No reply quote was captured."}”
                </p>
              </section>

              <section className="rounded-2xl border border-saffron/30 bg-gradient-to-br from-saffron-soft to-surface p-4">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-saffron-deep">
                  <Sparkles className="h-3.5 w-3.5" />
                  AI executive summary
                </p>
                <p className="mt-2 text-sm leading-relaxed text-ink">
                  {task.full_thread_summary || "No summary has been written for this thread yet."}
                </p>
              </section>
            </div>

            <div className="mt-auto grid gap-2 border-t border-line p-4">
              <button
                type="button"
                disabled={completing}
                onClick={() => onComplete(task)}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-saffron px-4 text-sm font-semibold text-on-saffron shadow-glow-saffron disabled:opacity-60"
              >
                {completing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Mark Done
              </button>
              <button
                type="button"
                disabled={copying}
                onClick={async () => {
                  setCopying(true);
                  try {
                    await copyText(buildWhatsAppReminder(task));
                    onCopied();
                  } catch {
                    onCopyFailed?.();
                  } finally {
                    setCopying(false);
                  }
                }}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-line bg-canvas px-4 text-sm font-semibold text-ink hover:border-saffron"
              >
                <Copy className="h-4 w-4" />
                Copy WhatsApp Reminder
              </button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}
