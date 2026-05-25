import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { log } from "../../../lib/log";
import { recordPtyData, bumpTerminals } from "../../../lib/perf";
import { gateClaudeLaunch } from "../../../lib/launchGate";
import { scrollbackForPaneCount } from "../../../lib/terminal";
import { useAppStore, PROJECT_INIT_PROMPT } from "../../../store";

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
  initCmd?: string;
  onCwdChange?: (path: string) => void;
  onStatusChange?: (status: "run" | "idle") => void;
  onFocus?: () => void;
}

export function TerminalView({ paneId, visible = true, focused, initialCwd, initCmd, onCwdChange, onStatusChange, onFocus }: TerminalViewProps) {
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

  // Startup prompt queued for a fresh session (triage/project panes). Sent once,
  // the first time Claude reaches its prompt, then cleared. See the pty_create
  // block below and onClaudeIdle.
  const pendingStartupRef = useRef<string | null>(null);

  // Mount terminal + spawn PTY once per paneId
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Scale scrollback down on larger grids — 16 panes × deep buffers is a major
    // renderer-memory cost. Derive the grid size from this pane's tab layout.
    const tabIdx = Number(/^t(\d+)p\d+$/.exec(paneId)?.[1] ?? -1);
    const layout = useAppStore.getState().tabs[tabIdx]?.layout ?? "1×1";
    const [lc, lr] = layout.split("×").map(Number);
    const scrollback = scrollbackForPaneCount((lc || 1) * (lr || 1));

    const term = new Terminal({
      theme: TERM_THEME,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    termRef.current = term;
    fitRef.current  = fitAddon;
    bumpTerminals(1);

    // Called whenever claude finishes responding (or its process exits).
    function onClaudeIdle() {
      // First time Claude reaches its prompt on a fresh session with a queued
      // startup prompt: send it and stay "run" (Claude will respond) rather than
      // reporting idle. The next quiet period reports idle normally. Gated on
      // inClaudeRef so a process-exit idle (claude died) never types into bash.
      if (pendingStartupRef.current && inClaudeRef.current) {
        const prompt = pendingStartupRef.current;
        pendingStartupRef.current = null;
        invoke("pty_write", { paneId, data: prompt + "\r" }).catch(console.error);
        armQuietTimer();
        return;
      }
      claudeActiveRef.current = "idle";
      onStatusChangeRef.current?.("idle");
      // Focus is decided by ConsoleScreen (which pane to auto-focus, with a
      // startup grace) and actuated by the focused-pane effect below — we don't
      // focus here, so a pane finishing never steals the cursor on its own.
    }

    function armQuietTimer() {
      if (quietTimerRef.current) clearTimeout(quietTimerRef.current);
      quietTimerRef.current = setTimeout(() => {
        quietTimerRef.current = null;
        if (inClaudeRef.current && claudeActiveRef.current === "run") {
          onClaudeIdle();
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
        inClaudeRef.current = false;
        if (quietTimerRef.current) { clearTimeout(quietTimerRef.current); quietTimerRef.current = null; }
        onClaudeIdle();
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

    // Guard for the RAF: if the component unmounts before the frame fires
    // (rapid navigation), bail out so we don't register a listener that can
    // never be cleaned up.
    let destroyed = false;

    // Await the listener before creating the PTY so we never miss early output.
    // pty_create returns true for a new session, false when reconnecting to an
    // existing one (e.g. after a tab switch). On reconnect we send \n so bash
    // re-prints its prompt in the fresh terminal.
    requestAnimationFrame(async () => {
      if (destroyed) return;
      fitAddon.fit();
      const unlisten = await listen<string>(`pty_data_${paneId}`, (ev) => {
        const t0 = performance.now();
        term.write(ev.payload);
        // Reset quiet timer only for printable output — pure ANSI control sequences
        // (cursor moves, color resets after the last response line) don't count,
        // so Claude's trailing formatting doesn't keep pushing the timer out.
        // eslint-disable-next-line no-control-regex -- intentional: detect printable vs control bytes
        if (inClaudeRef.current && claudeActiveRef.current === "run" && /[^\x00-\x1f\x7f-\x9f]/.test(ev.payload)) {
          armQuietTimer();
        }
        // Synchronous handler cost only (xterm's actual render is deferred and
        // shows up in the jank tally instead).
        recordPtyData(ev.payload.length, performance.now() - t0);
      });
      if (destroyed) { unlisten(); return; }
      unlistenRef.current = unlisten;

      // Serialize `claude` cold-starts so simultaneously-mounted panes don't
      // stampede the shared OAuth credential store and log every session out.
      // Non-claude shells and tab-switch reconnects pass through instantly.
      if ((initCmd ?? "").includes("claude")) {
        await gateClaudeLaunch(paneId);
        if (destroyed) return;
      }

      const isNew = await invoke<boolean>("pty_create", {
        paneId,
        cols: term.cols,
        rows: term.rows,
        cwd:     initialCwd ?? "",
        initCmd: initCmd ?? "",
        env: undefined,
      }).catch((e) => { log.error(`console[${paneId}] pty_create failed: ${e}`); return true; });

      if (isNew) {
        // Seed a startup prompt if this pane has one assigned (triage sessions).
        // Verbatim text (paneStartupPromptText) wins and is sent as-is. Otherwise
        // fall back to the doc-based path: "" = built-in default; a relpath is
        // read from the unified doc store. Queued here, delivered by onClaudeIdle
        // once Claude is at its prompt.
        const text = useAppStore.getState().paneStartupPromptText[paneId];
        if (text !== undefined && !destroyed) {
          pendingStartupRef.current = text;
        } else {
          const doc = useAppStore.getState().paneStartupPromptDocs[paneId];
          if (doc !== undefined && !destroyed) {
            if (doc === "") {
              pendingStartupRef.current = PROJECT_INIT_PROMPT;
            } else {
              const docText = await invoke<string>("read_document", { relpath: doc })
                .catch(() => PROJECT_INIT_PROMPT);
              if (!destroyed) pendingStartupRef.current = docText.trim() || PROJECT_INIT_PROMPT;
            }
          }
        }
      } else {
        // Reconnecting — Ctrl+L repaints the prompt without submitting a command
        invoke("pty_write", { paneId, data: "\x0c" }).catch((e) => log.error(`console[${paneId}] repaint write failed: ${e}`));
      }
    });

    // Auto-resize. Guard against zero-dimension callbacks that fire when the
    // console screen is hidden via display:none — fitting a zero-size terminal
    // would corrupt the PTY dimensions until it becomes visible again.
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        fitAddon.fit();
        invoke("pty_resize", { paneId, cols: term.cols, rows: term.rows }).catch(console.error);
      }
    });
    ro.observe(el);

    return () => {
      destroyed = true;
      if (quietTimerRef.current) { clearTimeout(quietTimerRef.current); quietTimerRef.current = null; }
      el.removeEventListener("focusin", onFocusIn);
      disposeOnData.dispose();
      unlistenRef.current?.();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current  = null;
      bumpTerminals(-1);
      // PTY session intentionally kept alive — reconnects on remount (tab switch).
      // Sessions are cleaned up explicitly when a tab is closed (pty_kill).
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
          // Don't steal focus on becoming visible — the focused-pane effect below
          // focuses only the active pane. Stealing here made every pane in a grid
          // grab focus on mount.
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
