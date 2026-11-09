"use client";

import { CloudOff, Loader2, RefreshCw } from "lucide-react";

export function DeskServerError({ onRetry, retrying }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center bg-[#F8FAFC] px-6 text-center">
      <div className="mb-4 grid h-20 w-20 place-items-center rounded-full border border-slate-200 bg-white shadow-sm">
        <span className="text-4xl" aria-hidden>
          ☁️
        </span>
      </div>
      <CloudOff className="mb-3 h-5 w-5 text-slate-400" aria-hidden />
      <h2 className="text-lg font-bold text-slate-900">Server error</h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-slate-500">
        API reach nahi ho paayi. FastAPI / worker check karo, phir dubara try karo.
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="mt-5 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-orange-500 to-amber-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-95 disabled:opacity-60"
      >
        {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Retry
      </button>
    </div>
  );
}

export function DeskEmptySync({ syncing, connected, qrImage, onSync, syncingClick }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center bg-[#F8FAFC] px-6 text-center">
      <div className="mb-4 grid h-20 w-20 place-items-center rounded-full border border-orange-100 bg-orange-50 shadow-sm">
        <span className="text-4xl" aria-hidden>
          {syncing ? "⏳" : connected ? "📭" : "📱"}
        </span>
      </div>
      <h2 className="text-lg font-bold text-slate-900">
        {syncing ? "Syncing WhatsApp…" : connected ? "No matters yet" : "WhatsApp sync pending"}
      </h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-slate-500">
        {syncing
          ? "History aa rahi hai. Matters desk pe land karenge jaise hi AI unhe process kare."
          : connected
            ? "WhatsApp linked hai, lekin abhi koi matter nahi. Sync dabao ya naye chats ka wait karo."
            : "Pehle WhatsApp link karo, phir Sync dabao taaki chats desk pe aayein."}
      </p>

      {!connected && qrImage && (
        <img
          src={qrImage}
          alt="WhatsApp QR code"
          className="mt-5 h-44 w-44 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm"
        />
      )}

      <button
        type="button"
        onClick={onSync}
        disabled={syncingClick || syncing}
        className="mt-5 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-orange-500 to-amber-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-95 disabled:opacity-60"
      >
        {syncingClick || syncing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        {syncing ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}
