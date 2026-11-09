/**
 * Client-side session wipe helpers for dual-tier logout.
 */

export function clearBrowserStorage() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.clear();
  } catch {
    /* storage unavailable */
  }
  try {
    window.sessionStorage.clear();
  } catch {
    /* storage unavailable */
  }
}

/** Notify all pages/hooks listening for `wa-logout` to drop in-memory caches. */
export function broadcastLogout() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("wa-logout"));
  } catch {
    /* ignore */
  }
}

/**
 * Tier 1 — App sign-out redirect.
 * Clears local desk caches but does NOT imply WhatsApp was unpaired.
 */
export function completeAppSignOutRedirect(path = "/login") {
  clearBrowserStorage();
  if (typeof window === "undefined") return;
  window.location.href = path;
}

/**
 * Tier 2 — Full client cleanup after WhatsApp disconnect.
 * Hard navigation so React state trees cannot keep stale desk data.
 */
export function completeLogoutRedirect(path = "/login") {
  clearBrowserStorage();
  broadcastLogout();
  if (typeof window === "undefined") return;
  window.location.href = path;
}
