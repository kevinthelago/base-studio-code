// Last-resort crash surface — self-installing on import. A detached/secondary window's logs may
// never reach the Tauri sink (the IPC/log bridge can be absent in a runtime-created window), so a
// crash there is otherwise invisible — blank window, no logs (#tab-tearoff). This is PURE DOM (no
// Tauri dependency) and registers its handlers at IMPORT time, so it surfaces the real error/stack
// even for module-eval and pre-React failures — provided this module is imported FIRST.

// Browser warnings that fire as window `error` events but are NOT real crashes — never overlay on
// these. "ResizeObserver loop …" is benign (a resize callback caused more layout; the browser just
// deferred a frame) and fires constantly on resizable/observed layouts like the planner split panes.
// "Script error." is the opaque cross-origin placeholder with no actionable detail.
const BENIGN = [
  "ResizeObserver loop limit exceeded",
  "ResizeObserver loop completed with undelivered notifications",
  "Script error.",
];
/** True for harmless browser warnings the overlay must ignore (exported for tests). */
export const isBenign = (msg: string) => BENIGN.some((b) => msg.includes(b));

let shown = false;
function show(title: string, detail: string) {
  if (shown) return; // first real fatal only — don't stack overlays on repeated errors
  shown = true;
  try {
    const el = document.createElement("pre");
    el.setAttribute("data-fatal-overlay", "");
    el.style.cssText =
      "position:fixed;inset:0;z-index:99999;margin:0;padding:16px;overflow:auto;" +
      "background:#181a1e;color:#ff6b6b;font:11px/1.55 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word;";
    el.textContent = `${title}\n\n${detail}`;
    (document.body || document.documentElement).appendChild(el);
  } catch { /* nothing more we can do */ }
}

window.addEventListener("error", (e) => {
  if (isBenign(e.message || "")) return;
  show("Uncaught error", (e.error && (e.error.stack || e.error.message)) || e.message || String(e));
});
window.addEventListener("unhandledrejection", (e) => {
  const r = (e as PromiseRejectionEvent).reason;
  const detail = (r && (r.stack || r.message)) || String(r);
  if (isBenign(detail)) return;
  show("Unhandled promise rejection", detail);
});
