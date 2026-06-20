// Unified frontend logger.
//
// Routes app logs to BOTH the devtools console (immediate, in-window) and the
// backend log sink via tauri-plugin-log (the `tauri dev` terminal + the rotating
// log file) — so frontend and Rust logs land in the same place. The backend hop
// is best-effort: if the plugin isn't available (e.g. in tests), we still log to
// the console and never throw.

import { info as ptInfo, warn as ptWarn, error as ptError, debug as ptDebug } from "@tauri-apps/plugin-log";

type Sink = (message: string) => Promise<void>;

function route(sink: Sink, consoleFn: (...args: unknown[]) => void, message: string): void {
  consoleFn(message);
  // Fire-and-forget to the backend; swallow failures so logging never breaks flow.
  sink(message).catch(() => { /* plugin unavailable — console already has it */ });
}

export const log = {
  debug: (message: string) => route(ptDebug, console.debug, message),
  info:  (message: string) => route(ptInfo,  console.info,  message),
  warn:  (message: string) => route(ptWarn,  console.warn,  message),
  error: (message: string) => route(ptError, console.error, message),
};
