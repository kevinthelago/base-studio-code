// Startup timing trace (#perf). Lightweight Performance-API marks across the boot path so we can
// see where the ~1s startup goes: bundle eval → React render → store rehydration → first paint.
//
// Mark `startTime` is ms from the document's navigation start (performance.timeOrigin) — i.e. when
// the WebView began loading our page, which is AFTER the native process + WebView2 init. That
// native portion is logged separately on the Rust side (process → window-created), so the two
// together give the full cold-start picture.

import { log } from "./log";

let logged = false;

/** Record a boot milestone. Safe; no-op if the Performance API is missing. */
export function markBoot(name: string): void {
  try { performance.mark(`boot:${name}`); } catch { /* no Performance API */ }
}

/** Log the assembled startup timeline once (after first paint). Idempotent. */
export function logStartupTrace(): void {
  if (logged) return;
  logged = true;
  try {
    const at = (n: string) => performance.getEntriesByName(`boot:${n}`)[0]?.startTime ?? NaN;
    const evalT = at("eval"), render = at("render"), mounted = at("mounted"), hydrated = at("hydrated"), painted = at("painted");
    const ms = (n: number) => (Number.isFinite(n) ? String(Math.round(n)) : "?");
    const span = (a: number, b: number) => (Number.isFinite(a) && Number.isFinite(b) ? `+${Math.round(b - a)}` : "+?");
    // WARN, not INFO: the log plugin filters the `webview` target to warn-and-above (the same
    // reason the perf monitor logs at warn), so a one-shot startup trace must use warn to reach
    // the persisted log file rather than only the devtools console.
    log.warn(
      `[startup] doc→eval ${ms(evalT)}ms · eval→render ${span(evalT, render)} · render→mounted ${span(render, mounted)} · ` +
      `mounted→hydrated ${span(mounted, hydrated)} · hydrated→painted ${span(hydrated, painted)} · total-from-doc ${ms(painted)}ms`,
    );
  } catch { /* never let tracing break the app */ }
}
