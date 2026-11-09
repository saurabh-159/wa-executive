"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  CheckCircle,
  Clock,
  AlertCircle,
  ArrowUpRight,
  ArrowDownLeft,
  Send,
  Sparkles,
  Loader2,
} from "lucide-react";
import { draftFollowUp, sendWhatsAppMessage } from "@/lib/api";

export default function TaskCard({ task, onStatusChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentSuccess, setSentSuccess] = useState(false);
  const [justCompleted, setJustCompleted] = useState(false);

  const isYouOwe = task.category === "I_OWE_THEM";

  const handleGenerateFollowUp = async () => {
    setLoadingDraft(true);
    try {
      const res = await draftFollowUp(task.id);
      setDraft(res.draft_message);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingDraft(false);
    }
  };

  const handleSendMessage = async () => {
    if (!draft) return;
    setSending(true);
    try {
      await sendWhatsAppMessage(task.sender_jid, draft);
      setSentSuccess(true);
      setTimeout(() => setSentSuccess(false), 3000);
    } catch (err) {
      console.error(err);
    } finally {
      setSending(false);
    }
  };

  const handleComplete = (e) => {
    e.stopPropagation();
    setJustCompleted(true);
    setTimeout(() => {
      onStatusChange(task.id, "COMPLETED");
    }, 220);
  };

  return (
    <div
      className={`overflow-hidden rounded-xl border border-zinc-200/90 bg-white transition-all duration-200 hover:border-zinc-300 hover:shadow-md ${
        justCompleted ? "scale-[0.98] opacity-60" : "scale-100 opacity-100"
      }`}
    >
      {/* Collapsed header — glance: due, category, sender */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="flex cursor-pointer select-none items-center justify-between gap-3 p-4"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={`flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
              isYouOwe
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-blue-200 bg-blue-50 text-blue-900"
            }`}
          >
            {isYouOwe ? (
              <ArrowUpRight className="h-3 w-3" />
            ) : (
              <ArrowDownLeft className="h-3 w-3" />
            )}
            {isYouOwe ? "You Owe" : "Waiting On"}
          </span>

          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold tracking-tight text-zinc-900">
              {task.task_heading}
            </h3>
            <p className="mt-0.5 truncate text-xs text-zinc-500">
              {task.counterparty_name}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          {task.due_date_time && (
            <div className="hidden items-center gap-1 rounded-md border border-zinc-100 bg-zinc-50 px-2 py-1 text-xs text-zinc-600 sm:flex">
              <Clock className="h-3.5 w-3.5 text-zinc-400" />
              <span className="max-w-[9rem] truncate">{task.due_date_time}</span>
            </div>
          )}

          {task.status === "PENDING" && (
            <button
              onClick={handleComplete}
              title="Mark as done"
              className="rounded-lg p-1.5 text-zinc-400 transition-transform duration-200 hover:scale-110 hover:bg-emerald-50 hover:text-emerald-600 active:scale-95"
            >
              <CheckCircle className="h-5 w-5" />
            </button>
          )}

          {isOpen ? (
            <ChevronUp className="h-4 w-4 text-zinc-400" />
          ) : (
            <ChevronDown className="h-4 w-4 text-zinc-400" />
          )}
        </div>
      </div>

      {/* Expanded — left = their demand (blue), right = your reply (emerald) */}
      {isOpen && (
        <div className="space-y-3 border-t border-zinc-100 bg-zinc-50/50 px-4 pb-4 pt-3">
          {task.full_thread_summary && (
            <div className="rounded-lg border border-zinc-200/80 bg-white p-3">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                AI Executive Summary
              </span>
              <p className="mt-1 text-xs leading-relaxed text-zinc-700">
                {task.full_thread_summary}
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-blue-100 bg-blue-50/70 p-3">
              <span className="flex items-center gap-1 text-[11px] font-semibold text-blue-900">
                <AlertCircle className="h-3.5 w-3.5 text-blue-600" />
                Their Demand
              </span>
              <p className="mt-1.5 text-xs italic leading-relaxed text-zinc-700">
                {task.context_their_message
                  ? `"${task.context_their_message}"`
                  : "No direct message quote"}
              </p>
            </div>

            <div className="rounded-lg border border-emerald-100 bg-emerald-50/70 p-3">
              <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-900">
                <CheckCircle className="h-3.5 w-3.5 text-emerald-600" />
                Your Reply
              </span>
              <p className="mt-1.5 text-xs italic leading-relaxed text-zinc-700">
                {task.context_your_reply
                  ? `"${task.context_your_reply}"`
                  : "Awaiting user confirmation"}
              </p>
            </div>
          </div>

          {!isYouOwe && task.status === "PENDING" && (
            <div className="mt-1 space-y-2 rounded-lg border border-zinc-200 bg-white p-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 text-xs font-semibold text-zinc-800">
                  <Sparkles className="h-3.5 w-3.5 text-indigo-600" />
                  AI Follow-up Dispatch
                </span>

                {!draft && (
                  <button
                    onClick={handleGenerateFollowUp}
                    disabled={loadingDraft}
                    className="flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium text-indigo-700 transition hover:bg-indigo-50 disabled:opacity-60"
                  >
                    {loadingDraft && <Loader2 className="h-3 w-3 animate-spin" />}
                    <span>Generate Draft</span>
                  </button>
                )}
              </div>

              {draft && (
                <div className="space-y-2 pt-1">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-zinc-200 bg-zinc-50/50 p-2 text-xs text-zinc-800 focus:border-zinc-400 focus:outline-none"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={handleSendMessage}
                      disabled={sending}
                      className="flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-zinc-800 disabled:opacity-60"
                    >
                      {sending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Send className="h-3 w-3" />
                      )}
                      <span>
                        {sentSuccess ? "Sent on WhatsApp! ✓" : "Send on WhatsApp"}
                      </span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
