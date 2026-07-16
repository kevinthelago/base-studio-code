// useScreenSession (#2707) — the shared xterm.js + PTY lifecycle behind the app's dedicated,
// app-owned terminal sessions (the planner, `usePlannerTerminal`; the designer,
// `useDesignerTerminal`). Both hooks were near-verbatim copies of the same skeleton:
//   • mount — create the `Terminal` (the shared theme/font/scrollback literal) + `FitAddon`, wire
//     `onData → pty_write`, then in a `requestAnimationFrame`: fit, subscribe `pty_data_<id>` /
//     `pty_exit_<id>` BEFORE spawning the PTY (so no early output is missed), and run the caller's
//     divergent launch path (workspace resolve → `ensure_session_settings` → `pty_create`).
//   • re-fit — re-measure when the surface becomes visible (hidden → shown), after a short delay, and
//     once the mono font loads (cell metrics are wrong until then).
//   • cleanup — unlisten×2, disconnect the ResizeObserver, dispose the term, null the refs, and
//     `pty_kill` the session.
// The LAUNCH path itself is deliberately NOT shared — the planner and designer differ in their
// workspace command, role gate, MCP/sandbox wiring, and env — so it stays a `launch` callback each
// wrapper owns, keeping every invoke/pty_create arg byte-identical to the pre-extraction hooks.
//
// TERM_THEME is passed IN as a param (never imported here): pulling the planner's theme leaf into
// `shared/` would invert the dependency direction (shared must stay feature-agnostic, #1626).
import { useEffect, useRef, type RefObject, type MutableRefObject } from "react";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { attachTerminalClipboard } from "./terminalClipboard";
import "@xterm/xterm/css/xterm.css";

export interface ScreenSessionConfig<S = void> {
  /** Stable pane id — the pty_* event channel + write/resize/kill key. */
  paneId: string;
  /** xterm theme (passed in so `shared/` never imports a feature's theme leaf). */
  termTheme: ITheme;
  /** Whether the surface is on-screen — drives the re-fit effect. */
  visible: boolean;
  /** Text written to the terminal on `pty_exit` (include the leading/trailing CRLF + ANSI reset). */
  exitBanner: string;
  /** Called with each raw `pty_data` payload AFTER it is written to the term (e.g. tag parsing). */
  onData?: (payload: string) => void;
  /** Runs SYNCHRONOUSLY in the mount effect body (before the RAF), so callers can snapshot store /
   *  prop state at exactly mount time. Its return value is handed to `launch`. */
  snapshot?: () => S;
  /** Owns the divergent launch path — workspace resolve → session settings → `pty_create` (+ any
   *  post-launch registration). Runs inside the mount RAF, AFTER `pty_data`/`pty_exit` are
   *  subscribed. `term` gives `cols`/`rows`; `snap` is the `snapshot()` return. */
  launch: (term: Terminal, snap: S) => Promise<void>;
  /** Runs in cleanup, just before `pty_kill` (e.g. deregister a tunnel roster). */
  onUnmount?: () => void;
}

export interface ScreenSessionHandle {
  /** Host element for the xterm canvas — attach to the terminal container div. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** The live xterm instance (null before mount / after unmount). */
  termRef: MutableRefObject<Terminal | null>;
}

export function useScreenSession<S = void>(config: ScreenSessionConfig<S>): ScreenSessionHandle {
  const { paneId, termTheme, visible, exitBanner } = config;

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef      = useRef<Terminal | null>(null);
  const fitRef       = useRef<FitAddon | null>(null);
  const unlistenData = useRef<UnlistenFn | null>(null);
  const unlistenExit = useRef<UnlistenFn | null>(null);

  // Mount xterm.js and spawn the PTY (once per surface lifecycle). pty_kill runs only in this
  // cleanup so tearing the session down is tied to the surface unmounting.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      theme: termTheme,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    termRef.current = term;
    fitRef.current  = fitAddon;
    const disposeClipboard = attachTerminalClipboard(term, paneId); // copy-on-select + paste (#3157)

    term.onData((data) => {
      fireInvoke("pty_write", { paneId, data }, console.error);
    });

    // Snapshot mount-time state synchronously (before the RAF), so callers capture the same instant
    // the pre-extraction hooks did.
    const snap = (config.snapshot?.() as S);

    requestAnimationFrame(async () => {
      // Only fit when the host has real dimensions. Fitting a 0-size host — a KeptMountedPage surface
      // mounted before layout, or a collapsed/zero-height dock — sets the terminal to 0 rows, and the
      // first `pty_data` write to a 0-row terminal dereferences a non-existent buffer line and crashes
      // xterm ("Cannot set properties of undefined (setting 'isWrapped')"), taking the page down via the
      // ErrorBoundary (#2832). A fresh xterm defaults to 80×24, so skipping the fit keeps a valid buffer;
      // the ResizeObserver below fits it once the host is actually sized (e.g. when KeptMountedPage flips
      // it to display:flex). Same guard the ResizeObserver already applies.
      if (el.clientWidth > 0 && el.clientHeight > 0) fitAddon.fit();

      // Subscribe before creating the PTY so we never miss early output.
      unlistenData.current = await listen<string>(`pty_data_${paneId}`, (ev) => {
        term.write(ev.payload);
        config.onData?.(ev.payload);
      });
      unlistenExit.current = await listen<unknown>(`pty_exit_${paneId}`, () => {
        term.write(exitBanner);
      });

      // The divergent launch path (workspace → settings → pty_create) is owned by the caller.
      await config.launch(term, snap);
    });

    // DEBOUNCED refit (#2832): a resize DRAG fires the observer dozens of times per second. Calling
    // `fit()` — which resizes the terminal and REFLOWS its buffer — on every frame while the PTY is
    // streaming output races xterm's async write loop and corrupts the buffer, throwing
    // "Cannot set properties of undefined (setting 'isWrapped')" from a later write (an UNCAUGHT error
    // that takes the page down). Coalescing to a single fit ~90ms after the drag settles reflows once,
    // off the streaming path. A hidden (display:none) host is 0-size → skipped.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const t = termRef.current;
        if (!t || el.clientWidth === 0 || el.clientHeight === 0) return;
        fitAddon.fit();
        fireInvoke("pty_resize", { paneId, cols: t.cols, rows: t.rows }, console.error);
        t.refresh?.(0, t.rows - 1); // repaint the buffer cleanly at the settled size (#2837)
      }, 90);
    });
    ro.observe(el);

    // The dock's ENTRANCE GROW (#2905, `useDockEntrance`) animates the panel's REAL height up into place,
    // so the ResizeObserver above fires as it grows and its debounced fit lands the authoritative size
    // once the grow settles — no separate post-animation "settle fit" needed (that was the transform-only
    // slide's workaround, #2837, now removed).

    return () => {
      clearTimeout(resizeTimer);
      unlistenData.current?.();
      unlistenExit.current?.();
      ro.disconnect();
      disposeClipboard();
      term.dispose();
      termRef.current = null;
      fitRef.current  = null;
      config.onUnmount?.();
      fireInvoke("pty_kill", { paneId }, console.error);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit when the surface becomes visible (hidden → shown): the collapsed host is display:none, so
  // the mount-time fit measured nothing. Re-fit on the frame, after a short delay, and once the mono
  // font loads (cell metrics are wrong until then) so it reliably fills the available space.
  useEffect(() => {
    if (!visible) return;
    const refit = (focusToo: boolean) => {
      const fit = fitRef.current, term = termRef.current, el = containerRef.current;
      if (!fit || !term || !el || el.clientWidth === 0 || el.clientHeight === 0) return;
      fit.fit();
      fireInvoke("pty_resize", { paneId, cols: term.cols, rows: term.rows }, console.error);
      term.refresh?.(0, term.rows - 1); // repaint cleanly at the shown size (#2837)
      if (focusToo) term.focus();
    };
    let cancelled = false;
    const raf = requestAnimationFrame(() => refit(true));
    const delayed = setTimeout(() => refit(false), 120);
    document.fonts?.ready?.then(() => { if (!cancelled) refit(false); }).catch(() => {});
    return () => { cancelled = true; cancelAnimationFrame(raf); clearTimeout(delayed); };
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  return { containerRef, termRef };
}
