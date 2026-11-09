"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

function useCountUp(target) {
  const [value, setValue] = useState(0);
  const previous = useRef(0);

  useEffect(() => {
    const end = Number(target) || 0;
    const start = previous.current;
    if (start === end) {
      setValue(end);
      return;
    }

    const startTs = performance.now();
    let frame;
    const tick = (now) => {
      const progress = Math.min(1, (now - startTs) / 500);
      const eased = 1 - (1 - progress) ** 3;
      setValue(Math.round(start + (end - start) * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
      else previous.current = end;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return value;
}

const tones = {
  saffron: "from-saffron/50 to-transparent shadow-glow-saffron",
  amber: "from-amber-400/50 to-transparent shadow-glow-amber",
  emerald: "from-emerald-400/45 to-transparent shadow-glow-emerald",
  rose: "from-rose-400/45 to-transparent shadow-glow-rose",
};

const iconTones = {
  saffron: "bg-saffron-soft text-saffron-deep",
  amber: "bg-amber-50 text-amber-700",
  emerald: "bg-emerald-50 text-emerald-700",
  rose: "bg-rose-50 text-rose-700",
};

export default function StatCard({ label, value, hint, icon: Icon, tone = "saffron" }) {
  const shown = useCountUp(value);

  return (
    <article className={cn("rounded-2xl bg-gradient-to-br p-px", tones[tone])}>
      <div className="glass-card h-full rounded-2xl p-4">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
            {label}
          </p>
          <span className={cn("grid h-9 w-9 place-items-center rounded-xl", iconTones[tone])}>
            <Icon className="h-4 w-4" />
          </span>
        </div>
        <p className="mt-3 text-3xl font-semibold tabular-nums tracking-tight text-ink">{shown}</p>
        <p className="mt-1 text-xs text-muted">{hint}</p>
      </div>
    </article>
  );
}
