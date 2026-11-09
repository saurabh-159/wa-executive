"use client";

import { motion } from "framer-motion";
import { CalendarClock, ChevronRight, MessageCircle } from "lucide-react";
import Badge from "@/components/ui/Badge";
import PriorityIndicator from "@/components/ui/PriorityIndicator";
import { deadlineIsTight, formatDeadline } from "@/lib/utils";

export default function TaskCard({ task, onOpen }) {
  const due = formatDeadline(task.due_date_time);
  const tight = deadlineIsTight(task.due_date_time);

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8, scale: 0.98 }}
      transition={{ duration: 0.28 }}
    >
      <article
        role="button"
        tabIndex={0}
        onClick={() => onOpen(task)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen(task);
          }
        }}
        className="glass-card group w-full cursor-pointer rounded-2xl p-4 text-left transition hover:border-saffron/40 hover:shadow-glow-saffron focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-saffron"
      >
        <div className="flex items-start gap-3">
          <PriorityIndicator priority={task.priority} className="mt-1.5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <Badge category={task.category} />
              <span
                className={`inline-flex items-center gap-1 text-xs ${
                  tight ? "text-rose-600" : "text-muted"
                }`}
              >
                <CalendarClock className="h-3.5 w-3.5" />
                <span className="max-w-[9.5rem] truncate sm:max-w-none">{due}</span>
              </span>
            </div>
            <h3 className="mt-3 text-base font-semibold tracking-tight text-ink">
              {task.task_heading}
            </h3>
            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="flex min-w-0 items-center gap-2 text-sm text-muted">
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-saffron-soft text-saffron-deep">
                  <MessageCircle className="h-3 w-3" />
                </span>
                <span className="truncate">{task.counterparty_name}</span>
              </p>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted/70 transition group-hover:translate-x-0.5 group-hover:text-saffron-deep" />
            </div>
          </div>
        </div>
      </article>
    </motion.li>
  );
}
