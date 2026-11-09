/**
 * Baileys registers a companion with group history off and no day limit.
 * WhatsApp then never sends @g.us history. Apply this before the worker boots
 * so the next QR link asks for 10 days of chats, including groups.
 */
import fs from "fs";
import path from "path";

const target = path.join(
  process.cwd(),
  "node_modules",
  "@whiskeysockets",
  "baileys",
  "lib",
  "Utils",
  "validate-connection.js"
);

if (!fs.existsSync(target)) {
  process.exit(0);
}

const source = fs.readFileSync(target, "utf8");
// Force 10-day history + on-demand backfill (rewrite prior 3-day / undefined values).
const next = source
  .replace(/recentSyncDaysLimit:\s*(?:undefined|\d+)\s*,/, "recentSyncDaysLimit: 10,")
  .replace("supportGroupHistory: false,", "supportGroupHistory: true,")
  .replace(/onDemandReady:\s*undefined\s*,/, "onDemandReady: true,");

if (next !== source) {
  fs.writeFileSync(target, next);
  console.log(
    "[Baileys] Next QR link will sync 10 days + on-demand history (groups included)."
  );
} else if (
  /recentSyncDaysLimit:\s*10\s*,/.test(source) &&
  /onDemandReady:\s*true\s*,/.test(source)
) {
  console.log("[Baileys] Already patched for 10-day + on-demand history.");
} else {
  console.log("[Baileys] Patch markers not found — check baileys version.");
}
