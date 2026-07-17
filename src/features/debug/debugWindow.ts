// debugWindow (#3298, epic #3260) — open/close the DEBUG session's own OS window.
//
// The debug window loads the SAME app with `?debug=1`; App reads that (isDetachedWindow → DetachedWindow)
// and renders JUST the debug terminal (no rail/tabstrip). Like a tab tear-off (#430), the PTY is
// backend-owned by paneId (DEBUG_STUDIO_SESSION_ID), so a reopened window re-attaches to the same
// session rather than forking it. One window at a time — a fixed label so reopening reuses it.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/** The fixed OS-window label — one debug window at a time. MUST stay in sync with a `windows` entry in
 *  `src-tauri/capabilities/default.json` (#3313) — otherwise Tauri denies the window `event.listen`
 *  (the terminal's PTY listeners), the store, and the titlebar's window controls. */
export const DEBUG_WINDOW_LABEL = "debug-session";

/** True in the window opened with `?debug=1` (the debug session's host window). Pure (search injectable
 *  so it's unit-testable). */
export function detachedDebug(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get("debug") === "1";
}

/**
 * Open the debug session in its own OS window. Best-effort: logs and swallows failures so a toggle
 * flip never throws. `onClose` fires when the window is closed (the native X) so the Settings toggle
 * can reflect it (flip back off).
 */
export function openDebugWindow(onClose?: () => void): void {
  // Load the SAME app this window runs, just with the debug marker. Deriving from window.location is
  // robust across dev (http://localhost:1420) and prod (the asset protocol).
  const u = new URL(window.location.href);
  u.hash = "";
  u.search = "?debug=1";
  try {
    const w = new WebviewWindow(DEBUG_WINDOW_LABEL, {
      url: u.href,
      title: "Debug session",
      width: 1100,
      height: 800,
      decorations: false, // the app's custom titlebar, not the native OS frame
    });
    if (onClose) w.once("tauri://destroyed", () => onClose());
  } catch (e) {
    console.error("openDebugWindow failed:", e);
  }
}

/** Close the debug window if it's open (best-effort — a no-op when it isn't). */
export async function closeDebugWindow(): Promise<void> {
  try {
    const w = await WebviewWindow.getByLabel(DEBUG_WINDOW_LABEL);
    if (w) await w.close();
  } catch (e) {
    console.error("closeDebugWindow failed:", e);
  }
}
