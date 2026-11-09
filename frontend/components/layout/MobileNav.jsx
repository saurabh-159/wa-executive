"use client";

import { motion } from "framer-motion";
import { DASHBOARD_TABS } from "@/components/layout/TabNavigation";
import { cn } from "@/lib/utils";

export default function MobileNav({ active, onChange }) {
  return (
    <nav
      aria-label="Mobile desk"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-canvas/95 backdrop-blur-xl md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="grid grid-cols-4">
        {DASHBOARD_TABS.map((tab) => {
          const selected = active === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className={cn(
                "relative flex min-h-14 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium",
                selected ? "text-on-saffron" : "text-muted"
              )}
              aria-current={selected ? "page" : undefined}
            >
              {selected && (
                <motion.span
                  layoutId="mobilePill"
                  className="absolute inset-1 rounded-2xl bg-saffron shadow-glow-saffron"
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                />
              )}
              <Icon className="relative z-10 h-4 w-4" />
              <span className="relative z-10">{tab.short}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
