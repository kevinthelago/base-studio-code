// detachWindow -- open a console tab in its own OS window (tab tear-off, #430).
//
// A detached window loads the SAME plain `index.html` the main window loads (so the
// bundle loads and React mounts identically) and learns which tab/section to render
// from `window.__BSC_DETACH__`, a global the Rust `open_detached_window` command
// injects via an init script before any page script runs (#1870). State comes from
// the shared persisted store (the new window hydrates the same snapshot); PTY
// sessions are backend-owned by paneId, so the detached panes re-attach to the same
// sessions rather than forking them.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";

let seq = 0;

/** The detach marker the Rust command injects as `window.__BSC_DETACH__` before page
 *  scripts run. A console tab tear-off, a page-section tear-off, or absent (main window). */
export type DetachMarker =
  | { kind: "tab"; tabId: string }
  | { kind: "section"; page: string; section: string };

/** Read the injected detach marker (`window.__BSC_DETACH__`), or null in the main
 *  window. Injectable for tests. NOT derived from the URL: an app page loaded via the
 *  custom/dev-proxy protocol can't carry a reliable query string (#1870). */
export function detachMarker(m: unknown = (window as unknown as { __BSC_DETACH__?: unknown }).__BSC_DETACH__): DetachMarker | null {
  if (!m || typeof m !== "object") return null;
  const v = m as Record<string, unknown>;
  if (v.kind === "tab" && typeof v.tabId === "string") return { kind: "tab", tabId: v.tabId };
  if (v.kind === "section" && typeof v.page === "string" && typeof v.section === "string") {
    return { kind: "section", page: v.page, section: v.section };
  }
  return null;
}

/** The detached console tab's stable id, or null for the main / section windows.
 *  Id-based so the window pins to the tab across reorders. Pure. */
export function detachedTabId(m?: unknown): string | null {
  const d = detachMarker(m);
  return d?.kind === "tab" ? d.tabId : null;
}

/** A detached page-section window's target, or null for the main / console-tab
 *  windows. Pure. */
export function detachedSection(m?: unknown): { page: string; section: string } | null {
  const d = detachMarker(m);
  return d?.kind === "section" ? { page: d.page, section: d.section } : null;
}

// openDetachedSection (page-section tear-off) moved to shared/ (#1703): it's a
// generic webview helper used by shared/hooks/usePageTabs + the projects feature,
// none of which should reach into app/console. See shared/lib/core/detachSection.

/**
 * Open tab `tabId` in its own OS window. Best-effort: logs and swallows failures so a
 * denied/edge case never breaks the drag gesture.
 *
 * Built via the Rust `open_detached_window` command, NOT `new WebviewWindow()`: on
 * Windows every webview sharing the app's user-data dir must launch with the same
 * WebView2 args as the main window (the JS API can't set them), and the page must be
 * the same plain `index.html` the main window loads — the detach target rides along
 * as a `marker` the command injects as a global, not as a URL query (#1870).
 */
export function openDetachedTab(tabId: string, title?: string, onClose?: () => void): void {
  seq += 1;
  const label = `tab-${tabId}-${seq}`.replace(/[^A-Za-z0-9/:_-]/g, "_");
  const marker = JSON.stringify({ kind: "tab", tabId } satisfies DetachMarker);
  invoke("open_detached_window", { label, marker, title: title || "Console", width: 960, height: 720 })
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
