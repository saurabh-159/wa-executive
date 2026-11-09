"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  Inbox,
  Loader2,
  LogOut,
  Settings,
  Sparkles,
  UserRound,
} from "lucide-react";
import { fetchSyncStatus, getContactsConfiguredFlag, signOutApp } from "@/lib/api";
import { completeAppSignOutRedirect } from "@/lib/sessionCleanup";
import { useToast } from "@/components/ui/ToastProvider";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/today", id: "today", label: "Today", icon: Sparkles },
  { href: "/inbox", id: "inbox", label: "Inbox", icon: Inbox },
  { href: "/settings", id: "settings", label: "Settings", icon: Settings },
];

function isActive(pathname, href) {
  if (href === "/today") return pathname === "/today" || pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

const SYNC_BARRIER_MSG =
  "WhatsApp sync in progress. Please wait for initial setup.";
const SETUP_LOCK_MSG =
  "Select chats to monitor in Settings before leaving setup.";

export default function AppSidebar() {
  const pathname = usePathname();
  const { push } = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [setupGuarded, setSetupGuarded] = useState(false);
  const menuRef = useRef(null);
  const linkRequest = useRef(0);
  const toastCooldown = useRef(0);

  /** Setup gate locks whole nav; sync barrier only locks Today / Inbox. */
  const isGuarded = setupGuarded;
  const navLocked = syncing || setupGuarded;

  const refreshLink = useCallback(async () => {
    const requestId = ++linkRequest.current;
    let setupQuery = false;
    try {
      setupQuery =
        new URLSearchParams(window.location.search).get("setup") === "true" ||
        sessionStorage.getItem("perisclaw_setup_banner") === "1";
    } catch {
      setupQuery = false;
    }
    setSetupGuarded(setupQuery || !getContactsConfiguredFlag());
    const sync = await fetchSyncStatus();
    if (requestId !== linkRequest.current) return;
    setSyncing(Boolean(sync?.isSyncing));
  }, []);

  useEffect(() => {
    refreshLink();
    const onLogout = () => {
      linkRequest.current += 1;
      setSyncing(false);
      setSetupGuarded(true);
    };
    const onConfigured = () => setSetupGuarded(false);
    const onFocus = () => refreshLink();
    window.addEventListener("wa-logout", onLogout);
    window.addEventListener("contacts-configured", onConfigured);
    window.addEventListener("focus", onFocus);
    // Only poll while syncing; idle desk pages stay quiet
    const timer = syncing ? setInterval(refreshLink, 2000) : null;
    return () => {
      window.removeEventListener("wa-logout", onLogout);
      window.removeEventListener("contacts-configured", onConfigured);
      window.removeEventListener("focus", onFocus);
      if (timer) clearInterval(timer);
    };
  }, [refreshLink, syncing]);

  const notifySyncBarrier = useCallback(() => {
    const now = Date.now();
    if (now - toastCooldown.current < 2200) return;
    toastCooldown.current = now;
    push(setupGuarded ? SETUP_LOCK_MSG : SYNC_BARRIER_MSG);
  }, [push, setupGuarded]);

  const handleNavClick = useCallback(
    (event, href) => {
      if (setupGuarded) {
        event.preventDefault();
        notifySyncBarrier();
        return;
      }
      if (!navLocked) return;
      if (href !== "/" && href !== "/inbox") return;
      event.preventDefault();
      notifySyncBarrier();
    },
    [navLocked, notifySyncBarrier, setupGuarded]
  );

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointer = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  /** Tier 1: Log out of the desk — WhatsApp stays paired on the server. */
  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await signOutApp();
      setMenuOpen(false);
      push("Signed out — WhatsApp remains linked");
      completeAppSignOutRedirect("/login");
    } catch {
      setLoggingOut(false);
      push("Could not sign out");
    }
  };

  return (
    <aside
      aria-label="App"
      className={cn(
        "relative z-40 flex h-full w-16 shrink-0 flex-col items-center border-r border-slate-200 bg-white py-3 transition-all duration-300",
        isGuarded && "pointer-events-none opacity-40 select-none filter blur-[0.5px]"
      )}
    >
      <Link
        href="/"
        title={navLocked ? (setupGuarded ? SETUP_LOCK_MSG : SYNC_BARRIER_MSG) : "Perisclaw"}
        aria-disabled={navLocked || undefined}
        onClick={(event) => handleNavClick(event, "/")}
        className={cn(
          "mb-4 grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-orange-500 to-amber-500 text-sm font-bold text-white shadow-sm",
          navLocked && "cursor-not-allowed opacity-70"
        )}
      >
        P
      </Link>

      <nav className="flex flex-1 flex-col items-center gap-1.5">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = isActive(pathname, item.href);
          const lockedTab =
            setupGuarded ||
            (navLocked && (item.href === "/" || item.href === "/inbox"));
          return (
            <Link
              key={item.id}
              href={item.href}
              title={lockedTab ? (setupGuarded ? SETUP_LOCK_MSG : SYNC_BARRIER_MSG) : item.label}
              aria-current={active ? "page" : undefined}
              aria-disabled={lockedTab || undefined}
              onClick={(event) => handleNavClick(event, item.href)}
              className={cn(
                "group relative flex h-12 w-12 flex-col items-center justify-center rounded-xl transition",
                active
                  ? "bg-orange-50 text-orange-600"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-800",
                lockedTab && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-slate-500"
              )}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-orange-500" />
              )}
              <Icon className="h-5 w-5" strokeWidth={active ? 2.25 : 1.9} />
              <span className="mt-0.5 text-[9px] font-semibold leading-none">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="relative mt-auto" ref={menuRef}>
        <button
          type="button"
          title="Profile"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={() => {
            setMenuOpen((open) => !open);
            refreshLink();
          }}
          className={cn(
            "grid h-10 w-10 place-items-center rounded-full border text-sm font-semibold transition",
            menuOpen
              ? "border-orange-200 bg-orange-50 text-orange-700"
              : "border-slate-200 bg-slate-50 text-slate-700 hover:border-orange-200 hover:bg-orange-50"
          )}
        >
          <UserRound className="h-4 w-4" />
        </button>

        <AnimatePresence>
          {menuOpen && (
            <motion.div
              role="menu"
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98 }}
              transition={{ duration: 0.15 }}
              className="absolute bottom-0 left-14 z-50 w-52 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-md"
            >
              <div className="border-b border-slate-100 px-3 py-3">
                <p className="text-sm font-semibold text-slate-900">You</p>
                <p className="text-xs text-slate-500">WhatsApp executive desk</p>
              </div>
              <Link
                href="/settings"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                className="flex items-center gap-2 px-3 py-2.5 text-sm text-slate-700 transition hover:bg-orange-50 hover:text-orange-700"
              >
                <Settings className="h-4 w-4" />
                Settings
              </Link>
              <button
                type="button"
                role="menuitem"
                onClick={handleLogout}
                disabled={loggingOut}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-rose-600 transition hover:bg-rose-50 disabled:opacity-60"
              >
                {loggingOut ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogOut className="h-4 w-4" />
                )}
                Log Out
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </aside>
  );
}
