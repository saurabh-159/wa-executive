"use client";

import { motion } from "framer-motion";
import {
  ArrowDownLeft,
  ArrowUpRight,
  LayoutDashboard,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const DASHBOARD_TABS = [
  { id: "overview", label: "Overview", short: "Overview", icon: LayoutDashboard },
  { id: "outgoing", label: "You Owe (Outgoing)", short: "You Owe", icon: ArrowUpRight },
  { id: "incoming", label: "They Owe (Incoming)", short: "They Owe", icon: ArrowDownLeft },
  { id: "audit", label: "Contact Intelligence (RAG)", short: "Intel", icon: Search },
];

export default function TabNavigation({ active, onChange }) {
  return (
    <nav
      aria-label="Desk sections"
      className="hidden rounded-full border border-line bg-surface/80 p-1 backdrop-blur-xl md:flex"
    >
      {DASHBOARD_TABS.map((tab) => {
        const selected = active === tab.id;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={cn(
              "relative min-h-11 flex-1 rounded-full px-3 text-sm font-medium transition-colors",
              selected ? "text-on-saffron" : "text-muted hover:text-ink"
            )}
            aria-current={selected ? "page" : undefined}
          >
            {selected && (
              <motion.span
                layoutId="activePill"
                className="absolute inset-0 rounded-full bg-saffron shadow-glow-saffron"
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
              />
            )}
            <span className="relative z-10 inline-flex items-center justify-center gap-2">
              <Icon className="h-4 w-4" />
              <span className="truncate">{tab.label}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
