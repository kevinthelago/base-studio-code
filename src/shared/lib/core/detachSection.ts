// detachSection -- open a page's section (e.g. github → repos, the projects
// board) in its own OS window (section tear-off, #430).
//
// Lives in shared/ (#1703) because it's a generic, feature/app-agnostic window
// helper: it depends only on the Tauri webview API + window.location, not on any
// app/ or feature/ module. Both the per-page tab model (shared/hooks/usePageTabs)
// and the projects summary (a feature) drive section tear-off through it.
//
// The detached window loads the same app with `?detach=<page>&section=<id>`;
// the shell reads that (via detachedSection) and renders just that section.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

let seq = 0;

/** Open a page's section (e.g. github → repos) in its own window (tear-off).
 *  `onClose` fires when that window is destroyed (best-effort re-dock). */
export function openDetachedSection(page: string, section: string, title?: string, onClose?: () => void): void {
  seq += 1;
  const label = `tab-${page}-${section}-${seq}`.replace(/[^A-Za-z0-9/:_-]/g, "_");
  const u = new URL(window.location.href);
  u.hash = "";
  u.search = `?detach=${encodeURIComponent(page)}&section=${encodeURIComponent(section)}`;
  try {
    // `dragDropEnabled: false` is NOT optional (#3925). Tauri's WebView captures drag/drop for OS
    // file-drop by default and swallows `dragstart`/`dragover`/`drop` before the DOM sees them — the bug
    // #461 fixed for the main window via tauri.conf.json. A RUNTIME window does not inherit that config,
    // so without this the torn-off window's tab cannot be dragged at all, and dock-back can never fire.
    const w = new WebviewWindow(label, {
      url: u.href, title: title || section, width: 1100, height: 800,
      decorations: false, dragDropEnabled: false,
    });
    if (onClose) w.once("tauri://destroyed", () => onClose());
  } catch (e) {
    console.error("openDetachedSection failed:", e);
  }
}
