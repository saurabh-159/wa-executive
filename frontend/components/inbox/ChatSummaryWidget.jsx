"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Sparkles, X } from "lucide-react";
import { fetchChatSummary, generateChatSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function ChatSummaryWidget({ jid }) {
  const [state, setState] = useState("loading"); // loading | not_generated | ready | error
  const [summary, setSummary] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef(null);
  const jidRef = useRef(jid);
  jidRef.current = jid;

  const applyPayload = useCallback((payload) => {
    if (!payload || payload.status === "not_generated") {
      setSummary(null);
      setState("not_generated");
      setExpanded(false);
      return;
    }
    setSummary(payload);
    setState("ready");
  }, []);

  const load = useCallback(
    async (silent = false) => {
      const current = jidRef.current;
      if (!current) {
        setSummary(null);
        setState("not_generated");
        return;
      }
      if (!silent) {
        setState("loading");
        setError("");
      }
      try {
        const data = await fetchChatSummary(current);
        if (jidRef.current !== current) return;
        applyPayload(data);
      } catch (err) {
        if (jidRef.current !== current) return;
        if (!silent) {
          setState("error");
          setError("Could not load summary");
        }
        console.error("Chat summary fetch failed:", err);
      }
    },
    [applyPayload]
  );

  useEffect(() => {
    setExpanded(false);
    setError("");
    setSummary(null);
    load(false);
  }, [jid, load]);

  // Soft re-check dirty flag when the open chat stays selected
  useEffect(() => {
    if (!jid) return undefined;
    const timer = window.setInterval(() => {
      if (busy) return;
      load(true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [jid, busy, load]);

  useEffect(() => {
    if (!expanded) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setExpanded(false);
      }
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setExpanded(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded]);

  const runGenerate = async () => {
    const current = jidRef.current;
    if (!current || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await generateChatSummary(current);
      if (jidRef.current !== current) return;
      applyPayload(data);
      setExpanded(true);
    } catch (err) {
      if (jidRef.current !== current) return;
      const detail = err?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Summary generation failed");
      console.error("Chat summary generate failed:", err);
    } finally {
      if (jidRef.current === current) setBusy(false);
    }
  };

  if (!jid) return null;

  const keyPoints = Array.isArray(summary?.key_points) ? summary.key_points : [];
  const isDirty = Boolean(summary?.is_dirty);
  const newCount = Number(summary?.new_messages_count || 0);

  return (
    <div ref={rootRef} className="relative z-20 shrink-0 border-b border-[#e9edef]/70 bg-transparent px-3 py-2 sm:px-4">
      {state === "loading" && !summary ? (
        <div className="flex items-center gap-2 rounded-2xl border border-[#e9edef]/80 bg-white/90 px-3 py-2 text-xs text-[#667781] shadow-[0_8px_24px_rgba(17,27,33,0.06)] backdrop-blur-sm">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking summary…
        </div>
      ) : null}

      {state === "not_generated" || (state === "error" && !summary) ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[#e9edef]/80 bg-white/95 px-3 py-2 shadow-[0_10px_28px_rgba(17,27,33,0.08)] backdrop-blur-sm">
          <p className="text-xs text-[#667781]">
            {error || "Get a 10-day brief of this chat."}
          </p>
          <button
            type="button"
            onClick={runGenerate}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#111b21] px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-[#202c33] disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            Summarize 10 Days
          </button>
        </div>
      ) : null}

      {summary && state !== "not_generated" ? (
        <>
          <div
            className={cn(
              "flex items-start gap-2 rounded-2xl border border-[#e9edef]/90 bg-white/95 px-3 py-2 shadow-[0_10px_28px_rgba(17,27,33,0.08)] backdrop-blur-sm transition",
              expanded && "border-[#ffd6b0] shadow-[0_14px_36px_rgba(17,27,33,0.12)]"
            )}
          >
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
              className="min-w-0 flex-1 text-left"
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#fff4eb] text-[#ff7a1a]">
                  <Sparkles className="h-3.5 w-3.5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#a1a8ae]">
                    10-day brief
                  </p>
                  <p className="line-clamp-2 text-[13px] leading-snug text-[#111b21]">
                    {summary.summary_text || "Summary ready."}
                  </p>
                </div>
                <ChevronDown
                  className={cn(
                    "mt-1 h-4 w-4 shrink-0 text-[#667781] transition duration-200",
                    expanded && "rotate-180 text-[#ff7a1a]"
                  )}
                />
              </div>
            </button>

            {isDirty ? (
              <button
                type="button"
                onClick={runGenerate}
                disabled={busy}
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 shadow-sm transition hover:bg-amber-100 disabled:opacity-60"
                title="Refresh summary with new messages"
              >
                {busy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <>
                    +{newCount || "?"} new msgs
                    <span className="font-bold">(Update)</span>
                  </>
                )}
              </button>
            ) : null}
          </div>

          {expanded ? (
            <div className="pointer-events-none absolute inset-x-3 top-[calc(100%-0.35rem)] z-30 sm:inset-x-4">
              <div className="pointer-events-auto origin-top rounded-2xl border border-[#eadfce] bg-[#fffdf9] p-3.5 shadow-[0_18px_48px_rgba(17,27,33,0.18)] ring-1 ring-black/5 transition duration-200 ease-out">
                <div className="mb-2.5 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#b08968]">
                      Catch-up brief
                    </p>
                    <p className="mt-0.5 text-sm font-medium leading-snug text-[#111b21]">
                      Last 10 days at a glance
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    className="grid h-7 w-7 place-items-center rounded-full text-[#667781] transition hover:bg-black/5"
                    aria-label="Close summary"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                <p className="rounded-xl bg-white/80 px-3 py-2.5 text-[13px] leading-relaxed text-[#1f2c34] shadow-[inset_0_0_0_1px_rgba(17,27,33,0.04)]">
                  {summary.summary_text || "Summary ready."}
                </p>

                {keyPoints.length > 0 ? (
                  <ul className="mt-3 space-y-2">
                    {keyPoints.map((point, index) => (
                      <li
                        key={`${index}-${point.slice(0, 24)}`}
                        className="flex gap-2.5 rounded-xl bg-white/70 px-3 py-2 text-xs leading-relaxed text-[#54656f] shadow-[0_1px_0_rgba(17,27,33,0.04)]"
                      >
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#ff7a1a]" />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-xs text-[#667781]">No key takeaways stored yet.</p>
                )}

                {error ? <p className="mt-2 text-[11px] text-rose-600">{error}</p> : null}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
