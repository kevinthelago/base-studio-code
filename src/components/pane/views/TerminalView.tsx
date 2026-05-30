import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { log } from "../../../lib/log";
import { recordPtyData, bumpTerminals } from "../../../lib/perf";
import { gateClaudeLaunch } from "../../../lib/launchGate";
import { scrollbackForPaneCount, totalMountedPaneCount } from "../../../lib/terminal";
import { composeStartupPrompt } from "../../../lib/checkpoint";
import { resolveExtensions, toSessionPayloads } from "../../../lib/extensions";
import { PendingPtyData } from "../../../lib/pendingPtyData";
import { resolveInitCmd } from "../../../lib/resumeClaude";
import { roleCapability, roleDeniedCommands, roleWriteRules } from "../../../lib/sessionRoles";
import { useAppStore, PROJECT_INIT_PROMPT } from "../../../store";

// Background-pane buffer cap. While a pane is hidden we skip xterm.write
// entirely and accumulate the PTY bytes here; on becoming visible we flush
// them in one go. 256 KB ≈ a few thousand lines of dense output — generous for
// realistic switch-away durations and far above what's likely useful before
// xterm's own scrollback truncates it anyway.
const PENDING_BYTES_CAP = 256 * 1024;

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
  // Visibility flag for the PTY listener: while false we buffer rather than
  // calling term.write, so a hidden pane (different view, fullscreen-of-other-
  // pane, etc.) pays no render cost. The ref mirrors the `visible` prop and is
  // updated by a tiny effect below; the listener reads it synchronously.
  const visibleRef = useRef(visible);
  const pendingRef = useRef(new PendingPtyData(PENDING_BYTES_CAP));
  // Whether term.open() has run. We defer opening until the container has real
  // dimensions: the DOM renderer measures and CACHES character cell metrics at
  // open() time, and opening inside a display:none (zero-size) container — which
  // #187 now does for every background tab's panes at mount — caches garbage
  // metrics that a later fit() never re-measures, so rows are miscomputed and
  // the top lines render out of frame (#190). Until opened, output is buffered
  // (like a hidden pane) and flushed once we open at a real size.
  const openedRef = useRef(false);
  // Skips the first font-zoom effect run per (re)mount — the terminal is already
  // created at the current size, so we must not pty_resize before pty_create.
  const fontReadyRef = useRef(false);

  // Global terminal font size (Ctrl++ / Ctrl+-). Subscribed so a zoom change
  // re-renders this view; the effect below resizes the already-mounted terminal.
  const terminalFontSize = useAppStore((s) => s.terminalFontSize);

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
  // ms of silence after last printable output → claude is back at its prompt (idle).
  // Kept generous: Claude pauses mid-turn (thinking, tool calls, API waits) often
  // exceed a second, and reading those as "idle" would wrongly enqueue a pane that
  // is still working. The cursor no longer moves on idle (the focus queue governs
  // it), so a slightly later idle only delays when a finished agent joins the queue.
  const QUIET_MS = 1500;

  // Mount terminal + spawn PTY once per paneId
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Scale scrollback down on heavier workspaces — every mounted pane keeps
    // its buffer in renderer memory, and after #187 EVERY tab's panes stay
    // mounted (not just the active tab's), so a 2-tab × 16-pane setup is 32
    // live buffers. Use the workspace-wide total — not just this tab's grid —
    // to keep total scrollback bounded as tabs accumulate.
    const scrollback = scrollbackForPaneCount(
      totalMountedPaneCount(useAppStore.getState().tabs),
    );

    // (Re)mounting: re-arm the skip so the font-zoom effect doesn't fire against
    // a terminal whose PTY hasn't been created yet.
    fontReadyRef.current = false;

    const term = new Terminal({
      theme: TERM_THEME,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: useAppStore.getState().terminalFontSize,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    termRef.current = term;
    fitRef.current  = fitAddon;
    bumpTerminals(1);

    // Renderer is xterm's default (DOM/canvas). The WebGL addon was tried
    // (PR #182, toward #52) but produced ghost-cursor flickering with claude's
    // TUI — the renderer's glyph cache didn't always invalidate cells the
    // cursor had moved out of, leaving stale yellow cursors painted across
    // the screen on rapid TUI updates (#190). Canvas is the safe default;
    // re-enabling WebGL would want to be opt-in behind a setting, and only
    // after a stable upstream addon version that handles claude's cursor
    // patterns cleanly.

    // Open the terminal only once its container has real dimensions, so the DOM
    // renderer measures correct cell metrics (see openedRef). Opening at zero
    // size (a background tab mounted display:none by #187) caches bad metrics
    // and pushes the top lines out of frame. Returns true once opened. After
    // opening, fit to the real size and flush anything buffered while we waited.
    function openIfReady(): boolean {
      if (openedRef.current) return true;
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return false;
      term.open(el);
      openedRef.current = true;
      fitAddon.fit();
      if (pendingRef.current.size() > 0) term.write(pendingRef.current.flush());
      return true;
    }
    // Visible/active tab: the container is already sized, so open right away.
    // Hidden panes defer to the ResizeObserver / visible effect below.
    openIfReady();

    // Called whenever claude finishes responding (or its process exits).
    function onClaudeIdle() {
      // Report idle status only. The startup prompt is delivered by claude itself
      // (baked as its initial-message arg in pty_create), so there is nothing to
      // type here and no startup race to manage.
      claudeActiveRef.current = "idle";
      onStatusChangeRef.current?.("idle");
      // Focus is decided by ConsoleScreen — handleStatusChange enqueues this
      // pane on idle and the user steps through with Ctrl+Shift+N (or auto-
      // advance-on-reply). Only first-idle ever enqueues a pane, so a cold-
      // starting grid can't yank the cursor around. We don't focus here.
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
        // Mark this pane as a claude pane so the next app launch can resume
        // it with `claude --continue` (#36). The setter no-ops when the
        // flag is already on, so repeated OSC 100 "run" emissions during a
        // session don't churn the store.
        useAppStore.getState().setPaneWasClaude(paneId, true);
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
      // Open now if the pane became sizable between mount and this frame.
      openIfReady();
      const unlisten = await listen<string>(`pty_data_${paneId}`, (ev) => {
        const t0 = performance.now();
        // Render path: skip xterm.write while the pane is hidden OR not yet
        // opened — the canvas paint is the dominant render cost and an unseen
        // pane shouldn't pay it (#52), and writing before open() (deferred until
        // the container is sized, #190) would render against bad metrics. Bytes
        // accumulate in pendingRef and flush in one term.write when we open /
        // become visible (here or in the [visible] effect below). Flush-before-
        // write here keeps ordering correct even if the flip and the next PTY
        // event race.
        if (visibleRef.current && openedRef.current) {
          if (pendingRef.current.size() > 0) {
            term.write(pendingRef.current.flush());
          }
          term.write(ev.payload);
        } else {
          pendingRef.current.push(ev.payload);
        }
        // Status detection runs regardless of visibility — a background pane
        // finishing should still emit "idle" / join the focus queue.
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

      // Resolve this pane's startup prompt (triage / console kickoff), if any, so
      // it can be baked into the claude launch (see pty_create). Verbatim text
      // (paneStartupPromptText) wins; otherwise the doc path: "" = built-in
      // default, a relpath is read from the unified document store. Delivering it
      // as claude's initial-message arg is reliable — claude submits it itself, so
      // there is no PTY-typing race against the animated TUI.
      let startupPrompt: string | undefined;
      const text = useAppStore.getState().paneStartupPromptText[paneId];
      if (text !== undefined) {
        startupPrompt = text;
      } else {
        const doc = useAppStore.getState().paneStartupPromptDocs[paneId];
        if (doc !== undefined) {
          if (doc === "") {
            startupPrompt = PROJECT_INIT_PROMPT;
          } else {
            const docText = await invoke<string>("read_document", { relpath: doc }).catch(() => PROJECT_INIT_PROMPT);
            startupPrompt = docText.trim() || PROJECT_INIT_PROMPT;
          }
        }
      }
      // Triage continuity: if this pane has a checkpoint doc, fold the prior
      // session's "where we left off" note onto the prompt. The doc is handed to
      // the backend below so the `bsc-checkpoint` helper can update it for next time.
      const checkpointDoc = useAppStore.getState().paneCheckpointDocs[paneId];
      if (startupPrompt !== undefined && checkpointDoc) {
        const note = await invoke<string>("read_document", { relpath: checkpointDoc }).catch(() => "");
        startupPrompt = composeStartupPrompt(startupPrompt, note);
      }
      if (destroyed) return;

      // Serialize `claude` cold-starts so simultaneously-mounted panes don't
      // stampede the shared OAuth credential store and log every session out. A
      // pane launches claude if its initCmd says so or it has a startup prompt
      // (which the backend turns into a claude launch). Non-claude shells and
      // tab-switch reconnects pass through instantly.
      const launchesClaude = (initCmd ?? "").includes("claude") || startupPrompt !== undefined;
      if (launchesClaude) {
        await gateClaudeLaunch(paneId);
        if (destroyed) return;
      }

      // Configure this session's shell permissions before launch: Bash is allowed
      // broadly (start-and-go) with a curated deny-list, so claude never blocks on
      // a permission prompt mid-task. Allowed commands are the resolved
      // global+project+repo set; denied are the user's global blocks (the backend
      // always adds its dangerous defaults).
      if (launchesClaude && (initialCwd ?? "") !== "") {
        const cmds = useAppStore.getState().paneAllowedCommands[paneId]
          ?? useAppStore.getState().allowedCommands;
        // Role gate (#219): a planner/worker/triage session has its mutating git/gh
        // commands denied at launch (deny > the broad gh/git allow), plus a write-tool
        // guard (#238) that denies Write/Edit for no-code roles and scopes a worker to
        // its boundary globs. Absent role ⇒ unrestricted.
        const role = useAppStore.getState().paneRoles[paneId];
        const cap = role ? roleCapability(role) : null;
        const denied = cap
          ? [...useAppStore.getState().deniedCommands, ...roleDeniedCommands(cap)]
          : useAppStore.getState().deniedCommands;
        const write = cap ? roleWriteRules(cap) : { allow: [], deny: [] };
        // Extensions (MCP servers + hooks) resolved for this session — pre-resolved
        // per pane at tab creation; fall back to globals for ad-hoc consoles.
        const exts = useAppStore.getState().paneExtensions[paneId]
          ?? resolveExtensions(useAppStore.getState().extensions, "");
        const { mcp, hooks } = toSessionPayloads(exts);
        await invoke("ensure_session_settings", {
          cwd: initialCwd, allowedCommands: cmds, deniedCommands: denied,
          mcpServers: mcp, hooks,
          allowToolRules: write.allow, denyToolRules: write.deny,
        }).catch((e) => log.error(`console[${paneId}] ensure_session_settings failed: ${e}`));
        if (destroyed) return;
      }

      // Resolve the effective init_cmd: an explicit `initCmd` prop wins,
      // then a triage/fleet `startupPrompt` (handled by pty_create's
      // prompt-baking path — must NOT also inject a parallel init_cmd),
      // then the ad-hoc resume (#36): if this pane had claude running at
      // last shutdown and auto-resume is on, mount straight into
      // `claude --continue`.
      const st = useAppStore.getState();
      const effectiveInitCmd = resolveInitCmd({
        explicit: initCmd,
        startupPrompt,
        paneWasClaude: !!st.paneWasClaude[paneId],
        autoResumeClaude: st.autoResumeClaude,
      });
      const isNew = await invoke<boolean>("pty_create", {
        paneId,
        cols: term.cols,
        rows: term.rows,
        cwd:     initialCwd ?? "",
        initCmd: effectiveInitCmd,
        startupPrompt,
        // Triage panes resume the repo's prior conversation (claude --continue).
        continueSession: useAppStore.getState().paneContinue[paneId] ?? false,
        // Per-repo triage checkpoint doc, so the bsc-checkpoint helper can write it.
        checkpointDoc,
        env: undefined,
      }).catch((e) => { log.error(`console[${paneId}] pty_create failed: ${e}`); return true; });

      if (!isNew) {
        // Reconnecting — Ctrl+L repaints the prompt without submitting a command
        invoke("pty_write", { paneId, data: "\x0c" }).catch((e) => log.error(`console[${paneId}] repaint write failed: ${e}`));
      }
    });

    // Auto-resize. Guard against zero-dimension callbacks that fire when the
    // console screen is hidden via display:none — fitting a zero-size terminal
    // would corrupt the PTY dimensions until it becomes visible again. This is
    // also the primary trigger that opens a pane first mounted while hidden:
    // the display:none → grid transition fires the observer with real
    // dimensions, so openIfReady() runs with correct cell metrics.
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        if (!openIfReady()) return;   // still couldn't open (raced back to 0 size)
        // Opened-or-already-open: fit to the current size and tell the backend.
        // (When this call is the one that opened, openIfReady already fit once;
        // a second fit is idempotent, and the resize propagates the dims.)
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
      // Reset the open flag so a re-run of this effect opens its FRESH terminal.
      // Without this, the next mount's openIfReady() sees a stale `true` and skips
      // term.open() entirely — leaving a blank pane. This fires on every genuine
      // remount (triage rebuild, app restart) and, critically, on React
      // StrictMode's mount→cleanup→mount double-invoke in dev, where the second
      // (live) terminal would otherwise never open (#190 regression follow-up).
      openedRef.current = false;
      bumpTerminals(-1);
      // PTY session intentionally kept alive — reconnects on remount (tab switch).
      // Sessions are cleaned up explicitly when a tab is closed (pty_kill).
    };
  }, [paneId]);

  // Keep visibleRef in sync with the prop so the PTY listener reads the latest
  // value synchronously. Declared before the [visible] effect below so it runs
  // first per React's effect-ordering rules: by the time the buffer-flush /
  // fit / resize logic below runs, visibleRef already reflects the new value.
  useEffect(() => { visibleRef.current = visible; }, [visible]);

  // Re-fit when this view becomes visible again (e.g. switching back from
  // files view, or coming back to a background tab). Also flush anything the
  // listener buffered while we were hidden, in one xterm.write so the user
  // sees what streamed in their absence. The listener already flush-before-
  // writes on the next event after visibility flips, but if no further event
  // arrives the user would otherwise stare at a frozen screen; this effect is
  // the safety net for that case.
  //
  // Ordering matters: fit FIRST, then flush. Buffered output (especially from
  // claude's TUI) is dense with cursor-positioning ANSI escapes (`\x1b[r;cH`
  // etc.); writing it into a terminal that's about to resize causes the just-
  // placed cursor moves to be reapplied against a reflowed grid, landing the
  // cursor in unexpected positions (#190). Doing the fit first means the
  // buffer is replayed against the dimensions claude assumed when it
  // generated the bytes — no jump.
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        // If this pane first mounted while hidden it may not be opened yet;
        // fit() throws on an unopened terminal. The ResizeObserver opens it
        // (and fits + flushes) on the display:none → grid transition, so just
        // skip here — this effect is only the re-fit path for an already-open
        // terminal becoming visible again.
        if (!openedRef.current) return;
        const t = termRef.current;
        if (!t) return;
        fitRef.current?.fit();
        if (pendingRef.current.size() > 0) {
          t.write(pendingRef.current.flush());
        }
        invoke("pty_resize", { paneId, cols: t.cols, rows: t.rows }).catch(console.error);
        // Don't steal focus on becoming visible — the focused-pane effect below
        // focuses only the active pane. Stealing here made every pane in a grid
        // grab focus on mount.
      });
    }
  }, [visible, paneId]);

  // Call term.focus() whenever this pane becomes the focused one. focus() reaches
  // into xterm's textarea, which only exists after open() — skip until opened.
  useEffect(() => {
    if (focused && visible) {
      requestAnimationFrame(() => { if (openedRef.current) termRef.current?.focus(); });
    }
  }, [focused, visible]);

  // Apply global font-zoom changes to the live terminal, re-fitting so rows/cols
  // recompute for the new cell size and the PTY is resized to match. The skip on
  // first run avoids resizing a session that pty_create hasn't established yet.
  useEffect(() => {
    if (!fontReadyRef.current) { fontReadyRef.current = true; return; }
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = terminalFontSize;
    // Defer a frame so xterm remeasures the new glyph size before we fit, then
    // resize the PTY to the recomputed rows/cols. fit() throws on an unopened
    // terminal, so skip the geometry work until it's been opened (#190).
    requestAnimationFrame(() => {
      if (!termRef.current || !openedRef.current) return;
      fitRef.current?.fit();
      invoke("pty_resize", { paneId, cols: term.cols, rows: term.rows }).catch(console.error);
    });
  }, [terminalFontSize, paneId]);

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
