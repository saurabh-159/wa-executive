"use client";

import { MessageCircle } from "lucide-react";

export default function AuditTimeline({ summary, chunks }) {
  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-saffron/25 bg-gradient-to-br from-saffron-soft via-surface to-saffron-soft p-5 shadow-glow-saffron backdrop-blur-xl">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-saffron-deep">
          Executive synthesis
        </p>
        <p className="mt-2 text-sm leading-relaxed text-ink">{summary}</p>
      </section>

      {chunks.length === 0 ? (
        <p className="glass-card rounded-2xl px-4 py-8 text-center text-sm text-muted">
          No message excerpts came back for this query.
        </p>
      ) : (
        <ol className="relative space-y-4 pl-1">
        <span className="absolute bottom-3 left-[15px] top-3 w-px bg-line" aria-hidden />
        {chunks.map((chunk) => (
          <li key={chunk.id} className="relative pl-10">
            <span className="absolute left-2 top-5 h-2.5 w-2.5 rounded-full bg-saffron shadow-glow-saffron" />
            <article className="glass-card rounded-2xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-saffron/30 bg-saffron-soft px-2.5 py-1 text-[11px] font-semibold text-saffron-deep">
                  <MessageCircle className="h-3 w-3" />
                  {chunk.counterparty_name}
                </span>
                <time className="text-xs text-muted">{chunk.timestamp_label}</time>
              </div>
              <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-ink">
                {chunk.text}
              </p>
            </article>
          </li>
        ))}
      </ol>
      )}
    </div>
  );
}
