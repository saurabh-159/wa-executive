// frontend/components/Sidebar.js
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  CheckSquare,
  Clock3,
  History,
  ShieldCheck,
  WifiOff,
  LogOut,
  Loader2,
} from "lucide-react";
import { fetchAuthStatus, logoutWhatsApp } from "@/lib/api";

export default function Sidebar() {
  const pathname = usePathname();
  const [waConnected, setWaConnected] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const checkConnection = async () => {
    try {
      const data = await fetchAuthStatus();
      setWaConnected(
        Boolean(
          data?.connected ||
            data?.status === "ready" ||
            data?.status === "syncing" ||
            data?.status === "connected"
        )
      );
    } catch {
      setWaConnected(false);
    }
  };

  useEffect(() => {
    checkConnection();
    const timer = setInterval(checkConnection, 5000);
    return () => clearInterval(timer);
  }, []);

  const handleLogout = async () => {
    if (loggingOut) return;
    const ok = window.confirm(
      "WhatsApp se logout karein?\n\n• Session / auth files clear\n• Saved tasks & messages wipe\n• Dubara QR scan karna hoga"
    );
    if (!ok) return;

    setLoggingOut(true);
    try {
      await logoutWhatsApp();
      setWaConnected(false);
      // Desk / other pages ko turant empty state dikhao
      window.dispatchEvent(new CustomEvent("wa-logout"));
      setTimeout(checkConnection, 1500);
      setTimeout(checkConnection, 3500);
    } catch (err) {
      console.error("Logout failed:", err);
      window.alert("Logout fail ho gaya. Worker online hai? Phir try karein.");
    } finally {
      setLoggingOut(false);
    }
  };

  const links = [
    { name: "Executive Desk", href: "/", icon: LayoutDashboard },
    { name: "What You Owe", href: "/you-owe", icon: Clock3 },
    { name: "Waiting On", href: "/waiting-on", icon: CheckSquare },
    { name: "Archive History", href: "/history", icon: History },
  ];

  return (
    <aside className="flex min-h-screen w-64 flex-col justify-between border-r border-zinc-200 bg-white p-4">
      <div className="space-y-6">
        <div className="flex items-center space-x-2.5 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 text-sm font-bold text-white">
            EA
          </div>
          <div>
            <h2 className="text-sm font-semibold leading-tight text-zinc-900">
              Assistant Desk
            </h2>
            <p className="text-[11px] text-zinc-400">WhatsApp Brain</p>
          </div>
        </div>

        <nav className="space-y-1">
          {links.map((link) => {
            const Icon = link.icon;
            const isActive = pathname === link.href;

            return (
              <Link
                key={link.href}
                href={link.href}
                className={`flex items-center space-x-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-zinc-100 text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
                }`}
              >
                <Icon
                  className={`h-4 w-4 ${
                    isActive ? "text-zinc-900" : "text-zinc-400"
                  }`}
                />
                <span>{link.name}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="space-y-2">
        <div className="flex items-center space-x-2.5 rounded-xl border border-zinc-100 bg-zinc-50 p-3">
          <span className="relative flex h-2 w-2">
            {waConnected && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
            )}
            <span
              className={`relative inline-flex h-2 w-2 rounded-full ${
                waConnected ? "bg-emerald-500" : "bg-amber-500"
              }`}
            ></span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-zinc-800">Baileys Worker</p>
            <p className="text-[10px] text-zinc-500">
              {waConnected ? "WhatsApp linked" : "Scan QR to link"}
            </p>
          </div>
          {waConnected ? (
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
          ) : (
            <WifiOff className="h-4 w-4 text-amber-600" />
          )}
        </div>

        <button
          type="button"
          onClick={handleLogout}
          disabled={loggingOut}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-xs font-semibold text-zinc-700 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loggingOut ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <LogOut className="h-3.5 w-3.5" />
          )}
          <span>{loggingOut ? "Logging out…" : "Logout WhatsApp"}</span>
        </button>
      </div>
    </aside>
  );
}
