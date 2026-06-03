// detachWindow -- open a console tab in its own OS window (tab tear-off, #430).
//
// A detached window loads the same app with `?detachTab=<idx>`; App reads that
// (via detachedTabIndex) and renders just that tab's console. State comes from
// the shared persisted store (the new window hydrates the same snapshot); PTY
// sessions are backend-owned by paneId, so the detached panes re-attach to the
// same sessions rather than forking them.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

let seq = 0;

/**
 * The detached tab index encoded in a window's URL, or null for the main window.
 * Pure (search is injectable) so it's unit-testable.
 */
export function detachedTabIndex(search: string = window.location.search): number | null {
  const v = new URLSearchParams(search).get("detachTab");
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Open tab `idx` in its own OS window. Best-effort: logs and swallows failures
 * so a denied/edge case never breaks the drag gesture.
 */
export function openDetachedTab(idx: number, title?: string): void {
  seq += 1;
  const label = `tab-${idx}-${seq}`;
  // Load the SAME app this window is already running, just with the detach marker.
  // Deriving from window.location is robust across dev (http://localhost:1420) and
  // prod (the asset protocol) — a bare relative "index.html" doesn't reliably
  // resolve under the dev server and yields a blank window.
  const u = new URL(window.location.href);
  u.hash = "";
  u.search = `?detachTab=${idx}`;
  try {
    new WebviewWindow(label, {
      url: u.href,
      title: title || `Console — tab ${idx + 1}`,
      width: 960,
      height: 720,
    });
  } catch (e) {
    console.error("openDetachedTab failed:", e);
  }
}
