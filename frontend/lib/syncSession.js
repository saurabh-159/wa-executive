const STORAGE_KEY = "perisclaw-bg-analysis";

/** How long Inbox + Today treat an empty desk as "still generating". */
export const BACKGROUND_ANALYSIS_WINDOW_MS = 180000;

export function markBackgroundAnalysis() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    /* storage unavailable */
  }
}

export function backgroundAnalysisFresh() {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const started = Number(raw);
    if (!Number.isFinite(started)) return false;
    return Date.now() - started < BACKGROUND_ANALYSIS_WINDOW_MS;
  } catch {
    return false;
  }
}

export function clearBackgroundAnalysis() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}
