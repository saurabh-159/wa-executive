"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { fetchSyncStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

const OVERLAY_TIMEOUT_MS = 45000;

/**
 * Full-screen sync experience after QR link / while isSyncing.
 * Leaves as soon as WhatsApp is connected (routes to /settings for contacts),
 * with a hard timeout so the spinner never freezes forever.
 */
export default function SyncLoadingOverlay({
  open,
  connected = false,
  processed = 0,
  onComplete,
  className,
}) {
  const router = useRouter();
  const [localProcessed, setLocalProcessed] = useState(processed);
  const [stillSyncing, setStillSyncing] = useState(true);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    setLocalProcessed(processed);
  }, [processed]);

  useEffect(() => {
    if (!open) return undefined;
    setStillSyncing(true);
    setTimedOut(false);

    let cancelled = false;

    const finish = (path = "/settings") => {
      if (cancelled) return;
      onComplete?.();
      router.push(path);
    };

    const tick = async () => {
      try {
        const sync = await fetchSyncStatus();
        if (cancelled) return;
        const syncing = Boolean(sync?.isSyncing);
        const count = Number(sync?.totalProcessed || 0);
        const historyDone = Boolean(sync?.historyCompleted);
        const isConnected = Boolean(sync?.connected || connected);
        setLocalProcessed(count);
        setStillSyncing(syncing || (!historyDone && isConnected));

        // Connected → leave overlay for settings / contacts gate (don't wait forever)
        if (isConnected) {
          finish("/settings");
        }
      } catch {
        /* keep overlay; next poll retries */
      }
    };

    tick();
    const poll = window.setInterval(tick, 1500);
    const timeout = window.setTimeout(() => {
      if (cancelled) return;
      setTimedOut(true);
      setStillSyncing(false);
    }, OVERLAY_TIMEOUT_MS);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearTimeout(timeout);
    };
  }, [open, connected, onComplete, router]);

  if (!open) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/55 backdrop-blur-sm",
        className
      )}
      role="status"
      aria-live="polite"
      aria-busy={!timedOut}
    >
      <div className="relative mx-4 w-full max-w-sm overflow-hidden rounded-3xl border border-white/10 bg-white px-8 py-10 text-center shadow-2xl">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(249,115,22,0.12),transparent_55%)]" />

        <div className="relative mx-auto mb-6 grid h-20 w-20 place-items-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-orange-400/30" />
          <span className="absolute inset-2 animate-pulse rounded-full bg-gradient-to-br from-orange-500 to-amber-400 opacity-90" />
          <span className="relative grid h-14 w-14 place-items-center rounded-full bg-white text-lg font-bold tracking-tight text-orange-600 shadow-sm">
            P
          </span>
        </div>

        <p className="relative text-[10px] font-semibold uppercase tracking-[0.2em] text-orange-600">
          Perisclaw
        </p>
        <h2 className="relative mt-2 text-xl font-bold tracking-tight text-slate-900">
          {timedOut ? "Taking longer than usual" : stillSyncing ? "Syncing your desk" : "Almost ready"}
        </h2>
        <p className="relative mt-3 min-h-[2.5rem] text-sm leading-relaxed text-slate-500">
          {timedOut
            ? "You can continue to settings and choose contacts while sync finishes in the background."
            : `Syncing last 3 days of conversations…${
                localProcessed > 0 ? ` ${localProcessed} messages processed` : ""
              }`}
        </p>

        {!timedOut ? (
          <div className="relative mt-6 flex items-center justify-center gap-2 text-xs font-medium text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-500" />
            <span className="tabular-nums">
              {localProcessed > 0
                ? `${localProcessed.toLocaleString()} messages processed`
                : "Waiting for history…"}
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              onComplete?.();
              router.push("/settings");
            }}
            className="relative mt-6 inline-flex w-full items-center justify-center rounded-2xl bg-orange-500 px-4 py-3 text-sm font-bold text-white transition hover:bg-orange-600"
          >
            Continue to settings
          </button>
        )}

        <div className="relative mx-auto mt-6 h-1.5 w-full max-w-[200px] overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full animate-pulse rounded-full bg-gradient-to-r from-orange-400 via-amber-400 to-orange-500 transition-all duration-500"
            style={{
              width: localProcessed > 0 ? `${Math.min(92, 18 + Math.log10(localProcessed + 1) * 28)}%` : "28%",
            }}
          />
        </div>
      </div>
    </div>
  );
}
