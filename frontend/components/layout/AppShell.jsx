"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { getContactsConfiguredFlag, signOutApp } from "@/lib/api";
import { completeAppSignOutRedirect } from "@/lib/sessionCleanup";
import { Inbox, LayoutDashboard, LogOut, Settings, User } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/today", label: "Today", icon: LayoutDashboard },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/settings", label: "Settings", icon: Settings },
];

const SETUP_LOCK_MSG =
  "Select chats to monitor in Settings before leaving setup.";

function isSetupQueryActive() {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("setup") === "true") {
      return true;
    }
    return sessionStorage.getItem("perisclaw_setup_banner") === "1";
  } catch {
    return false;
  }
}

export default function AppShell({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const [userProfile, setUserProfile] = useState({ name: "", email: "", avatar: "" });
  const [isGuarded, setIsGuarded] = useState(false);

  const refreshGuard = useCallback(() => {
    if (pathname === "/login") {
      setIsGuarded(false);
      return;
    }
    setIsGuarded(isSetupQueryActive() || !getContactsConfiguredFlag());
  }, [pathname]);

  useEffect(() => {
    if (!auth) return undefined;
    return onAuthStateChanged(auth, (user) => {
      setUserProfile({
        name: user?.displayName || "User",
        email: user?.email || "",
        avatar: user?.photoURL || "",
      });
      refreshGuard();
    });
  }, [refreshGuard]);

  useEffect(() => {
    refreshGuard();
    const onConfigured = () => setIsGuarded(false);
    const onLogout = () => setIsGuarded(true);
    window.addEventListener("contacts-configured", onConfigured);
    window.addEventListener("wa-logout", onLogout);
    window.addEventListener("focus", refreshGuard);
    return () => {
      window.removeEventListener("contacts-configured", onConfigured);
      window.removeEventListener("wa-logout", onLogout);
      window.removeEventListener("focus", refreshGuard);
    };
  }, [refreshGuard]);

  /** Hard-block desk routes until monitored contacts are saved. */
  useEffect(() => {
    if (pathname === "/login" || pathname === "/settings") return;
    if (!isGuarded) return;
    router.replace("/settings?setup=true");
  }, [isGuarded, pathname, router]);

  /** Tier 1: dashboard sign-out only — WhatsApp pairing stays on the server. */
  const handleGlobalLogout = async () => {
    try {
      await signOutApp();
    } catch {
      /* storage still cleared below */
    }
    completeAppSignOutRedirect("/login");
  };

  const handleGuardedNav = (event) => {
    if (!isGuarded) return;
    event.preventDefault();
  };

  // Login page par sidebar nahi dikhana
  if (pathname === "/login") {
    return <main className="h-full w-full">{children}</main>;
  }

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-[#F1F3F5]">
      {/* Thin premium top bar — frames the floating workspace below */}
      <header className="z-20 flex h-11 shrink-0 items-center justify-between border-b border-slate-200/70 bg-white px-4 shadow-[0_1px_0_rgba(15,23,42,0.03)]">
        <div className="flex items-center gap-2.5">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-orange-500 text-[11px] font-bold text-white shadow-sm shadow-orange-500/25">
            P
          </div>
          <div className="leading-tight">
            <p className="text-[13px] font-semibold tracking-tight text-slate-900">Perisclaw</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-medium text-slate-500">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
              isGuarded
                ? "border-amber-200 bg-amber-50 text-amber-700"
                : "border-slate-200 bg-slate-50 text-slate-600"
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                isGuarded ? "bg-amber-500" : "bg-emerald-500"
              )}
            />
            {isGuarded ? "Setup required" : "Desk online"}
          </span>
        </div>
      </header>

      {/* Padded workspace — gray canvas peeks through gaps */}
      <div className="flex min-h-0 flex-1 gap-2 p-2 md:gap-2.5 md:p-2.5">
        {/* Desktop Sidebar — icon upar, label neeche */}
        <aside
          aria-label="App"
          className={cn(
            "hidden h-full w-[4.5rem] shrink-0 flex-col items-center justify-between rounded-xl border border-slate-200/80 bg-white px-1.5 py-3 shadow-[0_1px_3px_rgba(15,23,42,0.04),0_4px_16px_rgba(15,23,42,0.04)] select-none md:flex",
            isGuarded && "pointer-events-none opacity-40 filter blur-[0.5px]"
          )}
        >
          <nav className="flex w-full flex-col items-center gap-1.5" aria-disabled={isGuarded || undefined}>
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.href;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={isGuarded ? SETUP_LOCK_MSG : item.label}
                  aria-disabled={isGuarded || undefined}
                  onClick={handleGuardedNav}
                  className={cn(
                    "relative flex w-full flex-col items-center justify-center gap-1 rounded-xl px-1 py-2.5 transition",
                    active
                      ? "bg-orange-50 text-orange-600 shadow-xs"
                      : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                  )}
                >
                  {active && (
                    <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-orange-500" />
                  )}
                  <Icon
                    className={cn("h-5 w-5 shrink-0", active ? "text-orange-500" : "text-slate-400")}
                    strokeWidth={active ? 2.25 : 1.9}
                  />
                  <span className="text-[9px] font-semibold leading-none">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="flex w-full flex-col items-center gap-2 border-t border-slate-100 pt-3">
            <div
              className="flex w-full flex-col items-center gap-1 px-1 py-1"
              title={userProfile.email || userProfile.name}
            >
              {userProfile.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={userProfile.avatar}
                  alt={userProfile.name}
                  className="h-8 w-8 shrink-0 rounded-full border border-slate-200 object-cover"
                />
              ) : (
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-600">
                  <User className="h-4 w-4" />
                </div>
              )}
              <p className="max-w-full truncate px-0.5 text-center text-[9px] font-bold leading-none text-slate-800">
                {userProfile.name}
              </p>
            </div>

            <button
              type="button"
              onClick={handleGlobalLogout}
              title="Log Out (keeps WhatsApp linked)"
              className="flex w-full flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-rose-600 transition hover:bg-rose-50"
            >
              <LogOut className="h-4 w-4 shrink-0 text-rose-500" />
              <span className="text-[9px] font-semibold leading-none">Log Out</span>
            </button>
          </div>
        </aside>

        {/* Main content — children own their floating panels */}
        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
