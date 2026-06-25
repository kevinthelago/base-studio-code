// Unified frontend logger.
//
// Routes app logs to BOTH the devtools console (immediate, in-window) and the
// backend log sink via tauri-plugin-log (the `tauri dev` terminal + the rotating
// log file) — so frontend and Rust logs land in the same place. The backend hop
// is best-effort: if the plugin isn't available (e.g. in tests), we still log to
// the console and never throw.
//
// The backend hop is also DEFERRED (#1033): the `invoke` no longer fires synchronously inside the
// logging call (which could land in a render or PTY hot path during the cold-start window). Calls are
// queued and drained in order on a short debounced timer, off the caller's stack. Console output stays
// immediate so devtools is unaffected.

import { info as ptInfo, warn as ptWarn, error as ptError, debug as ptDebug } from "@tauri-apps/plugin-log";

type Sink = (message: string) => Promise<void>;

/** How long (ms) to coalesce queued backend-sink writes before draining them. */
const FLUSH_MS = 250;

const queue: { sink: Sink; message: string }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function drain(): void {
  flushTimer = null;
  const batch = queue.splice(0, queue.length);
  // Fire-and-forget, in order; swallow failures so logging never breaks flow.
  for (const { sink, message } of batch) sink(message).catch(() => { /* plugin unavailable */ });
}

function scheduleFlush(): void {
  if (flushTimer === null) flushTimer = setTimeout(drain, FLUSH_MS);
}

function route(sink: Sink, consoleFn: (...args: unknown[]) => void, message: string): void {
  consoleFn(message);                 // immediate, in-window
  queue.push({ sink, message });      // deferred backend hop (drained off the hot path)
  scheduleFlush();
}

export const log = {
  debug: (message: string) => route(ptDebug, console.debug, message),
  info:  (message: string) => route(ptInfo,  console.info,  message),
  warn:  (message: string) => route(ptWarn,  console.warn,  message),
  error: (message: string) => route(ptError, console.error, message),
};
