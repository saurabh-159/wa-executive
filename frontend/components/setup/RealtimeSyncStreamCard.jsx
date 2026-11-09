'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function RealtimeSyncStreamCard({
  contacts = [],
  currentCount = 8,
  totalCount = 15,
  complete = false,
}) {
  const [index, setIndex] = useState(0);

  const fallbackList = [
    'MadanGopal darshans Bgarh',
    'Giriraj Shyam Das',
    'BabaTillu Nath Developer',
    'Website Pranverse',
    '+91 98390 26529',
  ];

  const activeList =
    Array.isArray(contacts) && contacts.length > 0 ? contacts : fallbackList;
  const len = activeList.length;
  const listKey = activeList.join('|');

  useEffect(() => {
    if (len === 0 || complete) return undefined;
    setIndex((prev) => prev % len);
    const interval = setInterval(() => {
      setIndex((prev) => (prev + 1) % len);
    }, 1250);
    return () => clearInterval(interval);
  }, [len, listKey, complete]);

  const prevPrev = activeList[(index - 2 + len) % len];
  const prevContact = activeList[(index - 1 + len) % len];
  const activeContact = activeList[index];
  const nextContact = activeList[(index + 1) % len];
  const nextNext = activeList[(index + 2) % len];

  const displayIndex = String(
    Math.min(currentCount || index + 1, totalCount || 15)
  ).padStart(2, '0');
  const displayTotal = String(totalCount || 15).padStart(2, '0');

  return (
    <div className="w-full flex-1 min-h-[300px] bg-white rounded-2xl border border-zinc-200/80 shadow-xs p-6 flex flex-col justify-between select-none">
      {/* Header & Counter Badge */}
      <div>
        <h4 className="text-sm font-semibold text-zinc-700 tracking-tight mb-2.5">
          Real-time Sync Stream
        </h4>

        <div className="inline-flex items-center gap-2.5 px-3 py-1.5 bg-sky-50 border border-sky-100 rounded-full">
          {complete ? (
            <span className="w-3.5 h-3.5 rounded-full bg-emerald-500 shrink-0" />
          ) : (
            <div className="w-3.5 h-3.5 rounded-full border-2 border-sky-500 border-t-transparent animate-spin shrink-0" />
          )}
          <span className="text-xs font-bold text-sky-950 font-mono tracking-tight">
            {displayIndex} / {displayTotal}
          </span>
          <span className="text-[10px] font-semibold text-sky-600 uppercase tracking-wider">
            {complete ? "Sync Complete" : "Chats Audited"}
          </span>
        </div>
      </div>

      {/* Vertical Reel Viewport */}
      <div className="relative h-36 w-full flex flex-col items-center justify-center overflow-hidden my-auto pointer-events-none">
        {/* Furthest Top */}
        <span className="text-xs text-zinc-300 font-medium opacity-20 truncate max-w-[85%]">
          {prevPrev}
        </span>

        {/* Top Faded Item */}
        <motion.span
          key={`prev-${prevContact}`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 0.35, y: 0 }}
          transition={{ duration: 0.25 }}
          className="text-xs text-zinc-400 font-medium truncate max-w-[90%] my-0.5"
        >
          {prevContact}
        </motion.span>

        {/* Center Active Pill (Highlighted Focus) */}
        <div className="my-1.5 h-9 flex items-center justify-center w-full overflow-hidden">
          <AnimatePresence mode="popLayout">
            <motion.div
              key={`active-${activeContact}`}
              initial={{ opacity: 0, y: 12, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12, scale: 0.95 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="w-full flex items-center justify-between gap-2 px-3.5 py-1.5 bg-white border border-zinc-200/90 rounded-xl shadow-xs"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                <span className="text-sm font-semibold text-zinc-900 tracking-tight truncate">
                  {activeContact}
                </span>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-[10px] font-mono font-bold text-zinc-400 bg-zinc-100 px-1.5 py-0.5 rounded">
                  #{displayIndex}
                </span>
                <span className="text-[9px] font-bold text-emerald-600 tracking-wider">
                  {complete ? "DONE" : "SYNCING..."}
                </span>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Bottom Faded Item */}
        <motion.span
          key={`next-${nextContact}`}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 0.35, y: 0 }}
          transition={{ duration: 0.25 }}
          className="text-xs text-zinc-400 font-medium truncate max-w-[90%] my-0.5"
        >
          {nextContact}
        </motion.span>

        {/* Furthest Bottom */}
        <span className="text-xs text-zinc-300 font-medium opacity-20 truncate max-w-[85%]">
          {nextNext}
        </span>
      </div>

      <div className="text-[10px] text-zinc-400 text-center font-medium">
        Streaming unencrypted headers
      </div>
    </div>
  );
}
