"use client";

import { Loader2, LogOut, RefreshCw } from "lucide-react";

export default function Navbar({
  activeCount,
  connected,
  syncing,
  refreshing,
  usingMock,
  loggingOut,
  onRefresh,
  onLogout,
}) {
  const live = connected || usingMock;

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-saffron text-sm font-bold text-on-saffron shadow-glow-saffron">
            P
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight text-ink sm:text-base">
              Perisclaw Executive AI
            </h1>
            <p className="mt-0.5 flex items-center gap-2 text-xs text-muted">
              <span className="relative flex h-2.5 w-2.5">
                {live && (
                  <span className="live-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
                )}
                <span
                  className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                    live ? "bg-emerald-400" : "bg-amber-400"
                  }`}
                />
              </span>
              <span>{live ? "WhatsApp Live" : "WhatsApp offline"}</span>
              {usingMock && (
                <span className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">
                  Sample
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface/80 px-4 text-sm text-ink backdrop-blur-xl">
            <span className="font-semibold tabular-nums text-saffron-deep">{activeCount}</span>
            <span className="ml-1.5 text-muted">active</span>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface/80 px-4 text-sm font-medium text-ink transition hover:border-saffron hover:text-saffron-deep"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing || syncing ? "animate-spin" : ""}`} />
            Refresh
          </button>
          {connected && (
            <button
              type="button"
              onClick={onLogout}
              disabled={loggingOut}
              title="Unlink WhatsApp"
              className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-line text-muted transition hover:border-rose-300 hover:text-rose-600 disabled:opacity-60"
            >
              {loggingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
            </button>
          )}
        </div>
      </div>
      {syncing && (
        <div className="border-t border-saffron/25 bg-saffron-soft px-4 py-2 text-center text-xs text-saffron-deep">
          Syncing WhatsApp history into the desk…
        </div>
      )}
    </header>
  );
}
