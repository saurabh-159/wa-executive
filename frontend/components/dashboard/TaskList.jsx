"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Inbox } from "lucide-react";
import TaskCard from "@/components/dashboard/TaskCard";
import SkeletonLoader from "@/components/ui/SkeletonLoader";
import { cn } from "@/lib/utils";

const FILTERS = [
  { id: "ALL", label: "All" },
  { id: "HIGH", label: "High" },
  { id: "MEDIUM", label: "Medium" },
  { id: "LOW", label: "Low" },
];

export default function TaskList({ tasks, loading, priority, onPriorityChange, onOpen, lane }) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{lane}</h2>
          <p className="mt-0.5 text-xs text-muted">
            {loading ? "Pulling commitments…" : `${tasks.length} showing`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => {
            const selected = priority === filter.id;
            return (
              <button
                key={filter.id}
                type="button"
                onClick={() => onPriorityChange(filter.id)}
                className={cn(
                  "relative min-h-11 rounded-full px-4 text-sm font-medium",
                  selected ? "text-on-saffron" : "text-muted hover:text-ink"
                )}
              >
                {selected && (
                  <motion.span
                    layoutId="priorityPill"
                    className="absolute inset-0 rounded-full border border-saffron bg-saffron"
                    transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  />
                )}
                <span className="relative z-10">{filter.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <SkeletonLoader count={4} />
      ) : tasks.length === 0 ? (
        <div className="glass-card rounded-3xl border-dashed px-6 py-16 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-saffron-soft text-saffron-deep">
            <Inbox className="h-6 w-6" />
          </div>
          <p className="mt-4 text-base font-semibold text-ink">Nothing in this lane</p>
          <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-muted">
            New WhatsApp commitments show up here as soon as they are extracted.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          <AnimatePresence mode="popLayout">
            {tasks.map((task) => (
              <TaskCard key={task.id} task={task} onOpen={onOpen} />
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}
