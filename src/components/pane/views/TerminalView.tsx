import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// Hex equivalents of the oklch design tokens so xterm can use them
const TERM_THEME: import("@xterm/xterm").ITheme = {
  background:          "#181a1f",
  foreground:          "#eeeae4",
  cursor:              "#c4923a",
  cursorAccent:        "#181a1f",
  selectionBackground: "#c4923a44",
  black:               "#181a1f", brightBlack:   "#44474f",
  red:                 "#d4554f", brightRed:     "#e06c75",
  green:               "#5fb467", brightGreen:   "#98c379",
  yellow:              "#c4923a", brightYellow:  "#e5c07b",
  blue:                "#5694c7", brightBlue:    "#61afef",
  magenta:             "#9b59b6", brightMagenta: "#c678dd",
  cyan:                "#4aabb5", brightCyan:    "#64d5e4",
  white:               "#939aa4", brightWhite:   "#eeeae4",
};

interface TerminalViewProps {
  paneId: string;
  visible?: boolean;
  focused?: boolean;
  initialCwd?: string;
  onCwdChange?: (path: string) => void;
  onStatusChange?: (status: "run" | "idle") => void;
  onFocus?: () => void;
}

export function TerminalView({ paneId, visible = true, focused, initialCwd, onCwdChange, onStatusChange, onFocus }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef    = useRef<Terminal | null>(null);
  const fitRef     = useRef<FitAddon | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Stable refs so handlers registered once always call the latest callback
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);
  const onFocusRef = useRef(onFocus);
  useEffect(() => { onFocusRef.current = onFocus; }, [onFocus]);

  // Session state for interactive claude REPL detection.
  // __bsc_state only fires on process start/exit, but in REPL mode claude
  // stays alive between turns. We use output silence to detect mid-session idle:
  // 1.5 s with no PTY output while a claude session is active → emit "idle".
  // When the user presses Enter, we re-emit "run" to re-arm.
  const inClaudeRef  = useRef(false);               // true between __bsc_state run/idle
  const claudeActiveRef = useRef<"run" | "idle">("idle"); // current within-session status
  const quietTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const QUIET_MS = 800; // ms of silence after last printable output → claude is at its prompt

  // Mount terminal + spawn PTY once per paneId
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      theme: TERM_THEME,
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

    // Called whenever claude finishes responding. Focuses the terminal directly
    // so there are no React render-timing races. The focusin listener on the
    // container div will fire and call setFocusedPane naturally when focus lands.
    function onClaudeIdle(autoFocus: boolean) {
      claudeActiveRef.current = "idle";
      onStatusChangeRef.current?.("idle");
      if (autoFocus) {
        term.focus();
      }
    }

    function armQuietTimer() {
      if (quietTimerRef.current) clearTimeout(quietTimerRef.current);
      quietTimerRef.current = setTimeout(() => {
        quietTimerRef.current = null;
        if (inClaudeRef.current && claudeActiveRef.current === "run") {
          onClaudeIdle(true);
        }
      }, QUIET_MS);
    }

    // OSC 7: bash reports cwd after every prompt via our injected PROMPT_COMMAND.
    // Format: ESC ] 7 ; file://localhost/path BEL
    term.parser.registerOscHandler(7, (data) => {
      const path = data.replace(/^file:\/\/[^/]*/, "");
      if (path) onCwdChange?.(path);
      return true;
    });

    // OSC 100: claude() wrapper signals process start ("run") and exit ("idle").
    // For interactive REPL sessions the process never exits mid-turn, so we
    // supplement with the quiet-timer approach to catch mid-session idle states.
    term.parser.registerOscHandler(100, (data) => {
      if (data === "run") {
        inClaudeRef.current = true;
        claudeActiveRef.current = "run";
        onStatusChangeRef.current?.("run");
        armQuietTimer();
      } else if (data === "idle") {
        const wasRun = claudeActiveRef.current === "run";
        inClaudeRef.current = false;
        if (quietTimerRef.current) { clearTimeout(quietTimerRef.current); quietTimerRef.current = null; }
        onClaudeIdle(wasRun);
      }
      return true;
    });

    // focusin bubbles from xterm's internal textarea up to the container div.
    // Covers clicks, Tab navigation, and programmatic focus — more reliable than
    // relying on click events propagating through xterm's canvas.
    const onFocusIn = () => onFocusRef.current?.();
    el.addEventListener("focusin", onFocusIn);

    // Terminal input → PTY.
    // Also handles two session-tracking concerns:
    //   • Output silence detection: reset the quiet timer on every byte received
    //   • Re-arm: when user presses Enter while claude is idle, switch back to "run"
    const disposeOnData = term.onData((data) => {
      invoke("pty_write", { paneId, data }).catch(console.error);
      if (inClaudeRef.current && claudeActiveRef.current === "idle" && data.includes("\r")) {
        claudeActiveRef.current = "run";
        onStatusChangeRef.current?.("run");
        armQuietTimer();
      }
    });

    // Await the listener before creating the PTY so we never miss early output.
    // pty_create returns true for a new session, false when reconnecting to an
    // existing one (e.g. after a tab switch). On reconnect we send \n so bash
    // re-prints its prompt in the fresh terminal.
    requestAnimationFrame(async () => {
      fitAddon.fit();
      const unlisten = await listen<string>(`pty_data_${paneId}`, (ev) => {
        term.write(ev.payload);
        // Reset quiet timer only for printable output — pure ANSI control sequences
        // (cursor moves, color resets after the last response line) don't count,
        // so Claude's trailing formatting doesn't keep pushing the timer out.
        if (inClaudeRef.current && claudeActiveRef.current === "run" && /[^\x00-\x1f\x7f-\x9f]/.test(ev.payload)) {
          armQuietTimer();
        }
      });
      unlistenRef.current = unlisten;

      const isNew = await invoke<boolean>("pty_create", {
        paneId,
        cols: term.cols,
        rows: term.rows,
        cwd: initialCwd ?? "",
      }).catch(() => true);

      if (!isNew) {
        // Reconnecting — Ctrl+L repaints the prompt without submitting a command
        invoke("pty_write", { paneId, data: "\x0c" }).catch(console.error);
      }
    });

    // Auto-resize
    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      invoke("pty_resize", { paneId, cols: term.cols, rows: term.rows }).catch(console.error);
    });
    ro.observe(el);

    return () => {
      if (quietTimerRef.current) { clearTimeout(quietTimerRef.current); quietTimerRef.current = null; }
      el.removeEventListener("focusin", onFocusIn);
      disposeOnData.dispose();
      unlistenRef.current?.();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current  = null;
      // PTY session intentionally kept alive — reconnects on remount (tab switch).
      // Sessions are cleaned up when the Tauri process exits.
    };
  }, [paneId]);

  // Re-fit when this view becomes visible again (e.g. switching back from files view)
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        const term = termRef.current;
        if (term) {
          invoke("pty_resize", { paneId, cols: term.cols, rows: term.rows }).catch(console.error);
          term.focus();
        }
      });
    }
  }, [visible, paneId]);

  // Call term.focus() whenever this pane becomes the focused one
  useEffect(() => {
    if (focused && visible) {
      requestAnimationFrame(() => termRef.current?.focus());
    }
  }, [focused, visible]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1, minHeight: 0, overflow: "hidden",
        background: TERM_THEME.background as string,
        display: visible ? "flex" : "none",
        padding: "6px 4px",
      }}
    />
  );
}
