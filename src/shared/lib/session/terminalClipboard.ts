// Terminal clipboard (#3157) — copy-on-select + paste for the app's xterm terminals (both the console
// panes, `TerminalView`, and the app-owned screen sessions, `useScreenSession`). The terminals had NO
// clipboard handling: Ctrl+C is SIGINT (can't be copy), and Ctrl+Shift+C — the usual terminal copy chord —
// is claimed by the WebView2 DevTools "inspect" accelerator AND the app's broadcast-toggle. So:
//   • COPY-ON-SELECT — selecting text auto-copies (writeText, already proven in this app). No key needed,
//     which sidesteps the Ctrl+Shift+C conflict entirely.
//   • PASTE — Ctrl+Shift+V / Shift+Insert / right-click read the clipboard and `pty_write` it (these chords
//     don't collide with the DevTools accelerator, so paste works standalone).
// Feature-agnostic (shared/), so both terminal sites wire the identical behavior. Must be called AFTER
// `term.open()` — it needs `term.element` for the mouse listeners.
import type { Terminal } from "@xterm/xterm";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";

/**
 * Wire copy-on-select + paste onto an open xterm `term`, sending pasted text to the PTY `paneId`.
 * Returns a disposer to call on terminal teardown (removes the DOM listeners; xterm keeps a single custom
 * key handler that goes away when the terminal is disposed).
 */
export function attachTerminalClipboard(term: Terminal, paneId: string): () => void {
  const el = term.element;
  const disposers: Array<() => void> = [];

  // ── COPY-ON-SELECT ── on mouse-up, copy the current selection (one write per finished selection, vs
  // `onSelectionChange` which fires continuously during a drag). A no-selection mouse-up (a plain click,
  // or a click that clears a selection) writes nothing, so it never clobbers the clipboard with "".
  const onMouseUp = () => {
    const sel = term.getSelection();
    if (sel) void navigator.clipboard?.writeText(sel).catch(() => {});
  };
  el?.addEventListener("mouseup", onMouseUp);
  if (el) disposers.push(() => el.removeEventListener("mouseup", onMouseUp));

  // ── PASTE ── read the clipboard and send it to the PTY (the shell / TUI echoes it back). A blocked/denied
  // read is a silent no-op (the caller can escalate to a native clipboard plugin if a webview ever refuses).
  const paste = () => {
    const read = navigator.clipboard?.readText?.();
    if (!read) return;
    void read
      .then((text) => { if (text) fireInvoke("pty_write", { paneId, data: text }, console.error); })
      .catch(() => {});
  };

  // Right-click pastes (terminal convention); suppress the browser context menu so it doesn't also open.
  const onContextMenu = (e: MouseEvent) => { e.preventDefault(); paste(); };
  el?.addEventListener("contextmenu", onContextMenu);
  if (el) disposers.push(() => el.removeEventListener("contextmenu", onContextMenu));

  // Ctrl+Shift+V / Shift+Insert paste. Returning FALSE stops xterm from ALSO sending the keys to the PTY,
  // and `preventDefault` stops a native paste event from double-firing. Ctrl+Shift+C copy is deliberately
  // NOT bound here — copy-on-select covers it, and on Windows that chord is eaten by the DevTools
  // accelerator until the separate layer-1 fix disables the WebView2 browser accelerator keys.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const paste_v = e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "V" || e.key === "v");
    const paste_ins = e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key === "Insert";
    if (paste_v || paste_ins) {
      e.preventDefault();
      paste();
      return false;
    }
    return true;
  });

  return () => { for (const d of disposers) d(); };
}
