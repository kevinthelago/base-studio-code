// detachWindow -- open a console tab in its own OS window (tab tear-off, #430).
//
// A detached window loads the same app with `?detachTab=<idx>`; App reads that
// (via detachedTabIndex) and renders just that tab's console. State comes from
// the shared persisted store (the new window hydrates the same snapshot); PTY
// sessions are backend-owned by paneId, so the detached panes re-attach to the
// same sessions rather than forking them.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";

let seq = 0;

/**
 * The detached tab index encoded in a window's URL, or null for the main window.
 * Pure (search is injectable) so it's unit-testable.
 */
/** The detached console tab's stable id (`?detachTab=<id>`), or null for the
 *  main / section windows. Id-based so the window pins to the tab across
 *  reorders. Pure. */
export function detachedTabId(search: string = window.location.search): string | null {
  return new URLSearchParams(search).get("detachTab");
}

/** A detached page-section window's target (`?detach=<page>&section=<id>`), or
 *  null for the main / console-tab windows. Pure. */
export function detachedSection(search: string = window.location.search): { page: string; section: string } | null {
  const p = new URLSearchParams(search);
  const page = p.get("detach");
  const section = p.get("section");
  return page && section ? { page, section } : null;
}

// openDetachedSection (page-section tear-off) moved to shared/ (#1703): it's a
// generic webview helper used by shared/hooks/usePageTabs + the projects feature,
// none of which should reach into app/console. See shared/lib/core/detachSection.

/**
 * Open tab `idx` in its own OS window. Best-effort: logs and swallows failures
 * so a denied/edge case never breaks the drag gesture.
 *
 * Built via the Rust `open_detached_window` command, NOT `new WebviewWindow()`:
 * on Windows every webview sharing the app's user-data dir must launch with the
 * same WebView2 args as the main window, and the JS API can't set them — a
 * mismatch crashes the torn-off window before any JS runs (#1870).
 */
export function openDetachedTab(tabId: string, title?: string, onClose?: () => void): void {
  seq += 1;
  const label = `tab-${tabId}-${seq}`.replace(/[^A-Za-z0-9/:_-]/g, "_");
  // Load the SAME app this window is already running, just with the detach marker.
  // Deriving from window.location is robust across dev (http://localhost:1420) and
  // prod (the asset protocol) — a bare relative "index.html" doesn't reliably
  // resolve under the dev server and yields a blank window.
  const u = new URL(window.location.href);
  u.hash = "";
  u.search = `?detachTab=${encodeURIComponent(tabId)}`;
  invoke("open_detached_window", { label, url: u.href, title: title || "Console", width: 960, height: 720 })
    // Re-dock when the detached window closes (best-effort; restart recovers it
    // regardless, since the detached set is session-only). The Rust command has
    // created the window by the time this resolves, so the handle is findable.
    .then(() => { if (onClose) attachRedock(label, onClose); })
    .catch((e) => console.error("openDetachedTab failed:", e));
}

/** Best-effort re-dock: fire `onClose` when the detached window with `label` is
 *  destroyed. Swallows lookup/listen failures (the detached set is session-only). */
function attachRedock(label: string, onClose: () => void): void {
  WebviewWindow.getByLabel(label)
    .then((w) => { void w?.once("tauri://destroyed", () => onClose()); })
    .catch((e) => console.error("openDetachedTab re-dock listener failed:", e));
}
