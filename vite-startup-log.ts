// Dev-only startup diagnostics for the Vite-server half of the cold start (#1031).
//
// `doc→eval` in the app's startup trace is opaque — the WebView only ever sees a module as a slow
// RESPONSE, never WHY. This plugin records the SERVER side to `.vite-dev.log` (truncated per
// dev-server start) so a stalled `npm run tauri -- dev` is diagnosable instead of theorised:
//   • lifecycle marks (config resolved, server listening, first module request)
//   • every module request whose server-side serve time (read + transform) crosses the threshold
//   • a "load settled" summary (count + total serve ms + slowest 5) after each load quiesces
//   • the timestamped Vite logger messages — crucially the optimizeDeps re-bundle + full-reload
//     events that a cold start can spend tens of seconds in (the client only sees them as a gap)
//
// Read `.vite-dev.log` right after a slow launch. Dev-only (serve); never runs for `vite build`.

import fs from "node:fs";
import path from "node:path";
import { createLogger, type Logger, type Plugin } from "vite";

const LOG_FILE = path.resolve(process.cwd(), ".vite-dev.log");
/** Module requests whose server-side serve time meets this (ms) get their own line. */
const SLOW_REQUEST_MS = 150;
/** Emit the per-load summary this many ms after the last module request (load quiesced). */
const SETTLE_MS = 3000;
// ESC (U+001B) is the ANSI escape introducer; stripping colour codes out of Vite's logger
// output requires matching that control char literally. Written as the \u001b escape rather
// than the raw ESC byte this line used to embed, so the source stays plain ASCII.
// eslint-disable-next-line no-control-regex -- intentional, see above: matching ESC is the point.
const ANSI = /\u001b\[[0-9;]*m/g;

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function append(line: string): void {
  try { fs.appendFileSync(LOG_FILE, `${stamp()} ${line}\n`); } catch { /* dev log is best-effort */ }
}

/** A short, readable module name from a request URL (drop the query + leading path). */
function shortName(url: string): string {
  return url.split("?")[0].replace(/^.*\//, "") || url;
}

/**
 * A Vite logger that timestamps every message and tees it to the dev log. This is what captures the
 * `optimized dependencies changed. reloading` / `new dependencies optimized` / `page reload` lines —
 * the re-bundle + reload stalls a cold start spends its time in (the client sees them only as a gap).
 */
export function teeLogger(): Logger {
  const base = createLogger();
  const tee = (level: string, msg: unknown) => {
    if (typeof msg === "string") append(`[vite:${level}] ${msg.replace(ANSI, "")}`);
  };
  return {
    ...base,
    info(msg, opts) { tee("info", msg); base.info(msg, opts); },
    warn(msg, opts) { tee("warn", msg); base.warn(msg, opts); },
    warnOnce(msg, opts) { tee("warn", msg); base.warnOnce(msg, opts); },
    error(msg, opts) { tee("error", msg); base.error(msg, opts); },
  };
}

/** The dev-server timing plugin (serve-only). */
export function startupLog(): Plugin {
  let firstReq = false;
  let count = 0;
  let totalMs = 0;
  let slowest: { name: string; ms: number }[] = [];
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const flushSummary = () => {
    if (count === 0) return;
    const slow = slowest.map((s) => `${Math.round(s.ms)}ms ${s.name}`).join(", ");
    append(`[vite] load settled: ${count} module reqs · ${Math.round(totalMs)}ms total serve · slowest: ${slow}`);
    count = 0; totalMs = 0; slowest = [];
  };

  return {
    name: "bsc-startup-log",
    apply: "serve",
    configResolved() {
      // Fresh log per dev-server start (truncate).
      try {
        fs.writeFileSync(LOG_FILE, `${stamp()} [vite] -- dev server starting (pid ${process.pid}) --\n`);
      } catch { /* best-effort */ }
    },
    configureServer(server) {
      server.httpServer?.once("listening", () => append("[vite] server listening on :1420"));
      server.middlewares.use((req, res, next) => {
        const url = req.url || "";
        // Only time module-ish requests (skip html, css, assets, HMR pings).
        if (!/\.[tj]sx?(\?|$)|\/@|\.vite\/deps/.test(url)) return next();
        if (!firstReq) { firstReq = true; append(`[vite] first module request: ${url}`); }
        const t0 = performance.now();
        res.once("finish", () => {
          const ms = performance.now() - t0;
          count += 1;
          totalMs += ms;
          if (ms >= SLOW_REQUEST_MS) append(`[vite] ${Math.round(ms)}ms serve  ${shortName(url)}`);
          // Maintain the top-5 slowest overall for the per-load summary.
          slowest.push({ name: shortName(url), ms });
          slowest.sort((a, b) => b.ms - a.ms);
          if (slowest.length > 5) slowest.length = 5;
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(flushSummary, SETTLE_MS);
        });
        next();
      });
    },
  };
}
