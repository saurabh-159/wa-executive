"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import AuditTimeline from "@/components/audit/AuditTimeline";
import SkeletonLoader from "@/components/ui/SkeletonLoader";
import { useAudit } from "@/hooks/useAudit";

const SUGGESTIONS = [
  "Payment update with Rahul",
  "Pitch deck deadline",
  "Customs hold with Neha",
  "Q3 invoice from Vikram",
];

export default function ContactAuditSearch() {
  const { loading, notice, result, search } = useAudit();
  const [query, setQuery] = useState("Payment update with Rahul");
  const timer = useRef(null);

  useEffect(() => {
    search("Payment update with Rahul");
    return () => window.clearTimeout(timer.current);
  }, [search]);

  const queueSearch = (value, immediate = false) => {
    window.clearTimeout(timer.current);
    if (value.trim().length < 2) return;
    if (immediate) {
      search(value);
      return;
    }
    timer.current = window.setTimeout(() => search(value), 450);
  };

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-ink">Contact Intelligence</h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
          Ask the desk about a person or a promise. Retrieved WhatsApp excerpts line up below an executive synthesis.
        </p>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          queueSearch(query, true);
        }}
        className="glass-card flex items-center gap-2 rounded-2xl p-2"
      >
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search conversations</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(event) => {
              const next = event.target.value;
              setQuery(next);
              queueSearch(next);
            }}
            placeholder="Payment update with Rahul"
            className="h-12 w-full rounded-xl bg-transparent pl-10 pr-3 text-sm text-ink outline-none placeholder:text-muted"
          />
        </label>
        <button
          type="submit"
          className="inline-flex h-12 min-w-11 items-center justify-center gap-2 rounded-xl bg-saffron px-4 text-sm font-semibold text-on-saffron shadow-glow-saffron"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          <span className="hidden sm:inline">Search</span>
        </button>
      </form>

      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => {
              setQuery(suggestion);
              queueSearch(suggestion, true);
            }}
            className="min-h-11 rounded-full border border-line bg-surface/80 px-4 text-sm text-muted transition hover:border-saffron hover:text-saffron-deep"
          >
            {suggestion}
          </button>
        ))}
      </div>

      {loading && (
        <div className="h-1 overflow-hidden rounded-full bg-saffron-soft">
          <div className="loading-bar h-full w-1/3 rounded-full bg-saffron" />
        </div>
      )}

      {notice && (
        <p className="rounded-xl border border-line bg-saffron-soft px-4 py-3 text-xs leading-relaxed text-muted">
          {notice}
        </p>
      )}

      {loading && !result ? (
        <SkeletonLoader count={3} />
      ) : (
        <div className={loading ? "opacity-60 transition" : "transition"}>
          <AuditTimeline summary={result.summary} chunks={result.chunks} />
        </div>
      )}
    </section>
  );
}
