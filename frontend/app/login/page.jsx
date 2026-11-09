"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";
import { auth, googleProvider, isFirebaseConfigured } from "@/lib/firebase";
import {
  setActiveTenantId,
  storeGoogleAccessToken,
  syncGoogleContacts,
} from "@/lib/api";
import { Loader2 } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleGoogleLogin = async () => {
    if (!isFirebaseConfigured() || !auth || !googleProvider) {
      setError("Google sign-in is not configured. Add the Firebase web keys to frontend/.env.local and restart.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const user = result.user;
      const usedGoogle = user?.providerData?.some((provider) => provider.providerId === "google.com");

      if (!user?.uid || !usedGoogle) {
        await signOut(auth);
        throw new Error("This sign-in did not use a Google account.");
      }
      if (!user.emailVerified) {
        await signOut(auth);
        throw new Error("This Google account does not have a verified email.");
      }

      await user.getIdToken(true);
      setActiveTenantId(user.uid);
      localStorage.setItem("user_email", user.email || "");
      localStorage.setItem("user_name", user.displayName || "");
      if (user.photoURL) {
        localStorage.setItem("user_avatar", user.photoURL);
      }

      // Capture OAuth access token for People API contacts sync
      const credential = GoogleAuthProvider.credentialFromResult(result);
      const googleAccessToken = credential?.accessToken || "";
      if (googleAccessToken) {
        storeGoogleAccessToken(googleAccessToken);
        // Fire-and-forget — Selection Desk can refresh names when ready
        syncGoogleContacts(googleAccessToken).catch((syncErr) => {
          console.warn("[Google Contacts] post-login sync:", syncErr?.message || syncErr);
        });
      }

      router.replace("/settings");
    } catch (err) {
      const code = err?.code || "";
      console.error("Google Login Error:", code || err?.message || "unknown");
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        setError(null);
      } else if (code === "auth/unauthorized-domain") {
        setError("This site is not an authorized domain in Firebase Authentication.");
      } else if (code === "auth/popup-blocked") {
        setError("The browser blocked the Google window. Allow popups and try again.");
      } else if (code === "auth/operation-not-allowed") {
        setError("Turn on the Google provider in Firebase Authentication, then try again.");
      } else if (err?.message && !code) {
        setError(err.message);
      } else {
        setError("Google sign-in failed. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-[#F1F3F5] px-4">
      <div className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-8 shadow-sm text-center">
        {/* Brand Icon */}
        <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-orange-500 text-xl font-bold text-white shadow-md shadow-orange-500/20">
          P
        </div>

        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-orange-600">
          Perisclaw Executive AI
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
          Sign In
        </h1>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          Connect your Google account to access your personal AI desk & linked WhatsApp sessions.
        </p>

        {error && (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-600">
            {error}
          </div>
        )}

        {/* Google Sign In Button */}
        <button
          type="button"
          onClick={handleGoogleLogin}
          disabled={loading}
          className="mt-6 flex w-full items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 active:scale-[0.99] disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
          ) : (
            <svg className="h-5 w-5" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
          )}
          <span>{loading ? "Authenticating..." : "Continue with Google"}</span>
        </button>

        <p className="mt-6 text-[11px] text-slate-400">
          Secured by Firebase Google Identity
        </p>
      </div>
    </div>
  );
}