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
import { invoke } from "@tauri-apps/api/core";

let seq = 0;

/** Open a page's section (e.g. github → repos) in its own window (tear-off).
 *  `onClose` fires when that window is destroyed (best-effort re-dock).
 *
 *  Built via the Rust `open_detached_window` command, NOT `new WebviewWindow()`:
 *  on Windows every webview sharing the app's user-data dir must launch with the
 *  same WebView2 args as the main window, and the JS API can't set them — a
 *  mismatch crashes the torn-off window before any JS runs (#1870). */
export function openDetachedSection(page: string, section: string, title?: string, onClose?: () => void): void {
  seq += 1;
  const label = `tab-${page}-${section}-${seq}`.replace(/[^A-Za-z0-9/:_-]/g, "_");
  // App-RELATIVE path so Rust loads it via `WebviewUrl::App` (IPC injected + query
  // preserved), not an absolute `External` URL that Tauri rewrites to
  // `tauri://localhost`, dropping the `?detach=`/`?section=` marker (#1870).
  const path = `index.html?detach=${encodeURIComponent(page)}&section=${encodeURIComponent(section)}`;
  invoke("open_detached_window", { label, path, title: title || section, width: 1100, height: 800 })
    .then(() => {
      // Re-dock when the detached window closes (best-effort). The Rust command has
      // created the window by the time this resolves, so the handle is findable.
      if (onClose) {
        WebviewWindow.getByLabel(label)
          .then((w) => { void w?.once("tauri://destroyed", () => onClose()); })
          .catch((e) => console.error("openDetachedSection re-dock listener failed:", e));
      }
    })
    .catch((e) => console.error("openDetachedSection failed:", e));
}
