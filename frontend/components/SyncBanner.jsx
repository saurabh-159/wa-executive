"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";

/**
 * Top banner while WhatsApp history sync is running.
 * Fades out smoothly when isSyncing becomes false after having been true.
 */
export default function SyncBanner({ isSyncing, totalProcessed = 0 }) {
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (isSyncing) {
      setFading(false);
      setVisible(true);
      return;
    }

    if (!visible) return;

    setFading(true);
    const t = setTimeout(() => {
      setVisible(false);
      setFading(false);
    }, 500);
    return () => clearTimeout(t);
  }, [isSyncing, visible]);

  if (!visible) return null;

  return (
    <div
      className={`overflow-hidden transition-all duration-500 ease-out ${
        fading ? "opacity-0 -translate-y-1 max-h-0 mb-0" : "opacity-100 translate-y-0 max-h-24 mb-0"
      }`}
    >
      <div className="relative rounded-xl border border-sky-200/80 bg-gradient-to-r from-sky-50 via-white to-emerald-50 px-4 py-3 shadow-sm">
        <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden rounded-t-xl">
          <div className="sync-progress-bar h-full w-1/3 bg-gradient-to-r from-sky-400 via-emerald-400 to-sky-400" />
        </div>

        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-700">
            <RefreshCw className="h-4 w-4 animate-spin" />
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-zinc-900 tracking-tight">
              Syncing your WhatsApp history
              <span className="font-medium text-zinc-500">
                {" "}
                ({Number(totalProcessed).toLocaleString()} messages processed)...
              </span>
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-emerald-700">
              <Sparkles className="h-3.5 w-3.5 text-emerald-600" />
              AI is actively extracting commitments...
            </p>
          </div>
        </div>
      </div>

      <style jsx>{`
        .sync-progress-bar {
          animation: syncbar 1.4s ease-in-out infinite;
        }
        @keyframes syncbar {
          0% {
            transform: translateX(-100%);
          }
          100% {
            transform: translateX(400%);
          }
        }
      `}</style>
    </div>
  );
}
