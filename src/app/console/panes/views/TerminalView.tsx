import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fireInvoke, safeInvoke } from "@/shared/lib/core/safeInvoke";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { attachTerminalClipboard } from "@/shared/lib/session/terminalClipboard";
import "@xterm/xterm/css/xterm.css";
import { log } from "@/shared/lib/core/log";
import { recordPtyData, bumpTerminals } from "@/shared/lib/core/perf";
import { gateClaudeLaunch } from "@/shared/lib/fleet/launchGate";
import { scrollbackForPaneCount, totalMountedPaneCount } from "@/app/console/lib/terminal";
import { nudgeSizes } from "@/app/console/lib/terminalNudge";
import { probeJumble } from "@/app/console/lib/jumbleProbe";
import { paneCwdRecovery, isManualPaneId, sandboxUserIdentity } from "@/app/console/lib/paneIdentity";
import { composeStartupPrompt } from "@/shared/lib/session/checkpoint";
import { PendingPtyData } from "@/app/console/lib/pendingPtyData";
import { buildAgentEnv, buildSessionSettings, resolveEffectiveInitCmd, resolveStartupPromptFreshOnly } from "@/app/console/lib/sessionLaunch";
import {
  PENDING_BYTES_CAP,
  AUTO_NUDGE_DELAY_MS,
  JUMBLE_CHROME_ROWS,
  JUMBLE_STRIKES,
  JUMBLE_RECHECK_MS,
  TERM_THEME,
} from "@/app/console/lib/terminalConstants";
import { useTerminalSession } from "@/app/console/useTerminalSession";
import { useAppStore, PROJECT_INIT_PROMPT } from "@/store";
import { interpretDiagnostics, sessionVerdictFromReport, type PrereqStatus } from "@/shared/lib/core/diagnostics";
import { TerminalBanners } from "@/app/console/panes/views/TerminalBanners";
import { tokenForRepo } from "@/shared/lib/github/repoCredentials";
import { getProvider } from "@/app/console/lib/providers";
import { isTurnOpenDebounced, paneActivityFor } from "@/app/console/lib/paneActivity";
import { admitTerminal } from "@/app/console/lib/terminalAdmission";
import { usePaneActivity } from "@/app/console/lib/usePaneActivityFeed";

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
  // Session readiness (#564): verdict-derived critical/warning lists + the manual retry. The mount
  // effect's preflight probe sets the verdict via setReadinessVerdict (after the GH token resolves).
  const { setReadinessVerdict, criticalChecks, warningChecks, retryReadiness } = useTerminalSession(paneId, initialCwd);
  const [warnDismissed, setWarnDismissed] = useState(false);
  // #799 — true when this console's assigned profile was edited while it's running, so it
  // shows a "relaunch to apply" nudge (settings.json is read at session start).
  const permsStale = useAppStore((s) => !!s.panePermsStale[paneId]);
  // Resize-nudge redraw (#1221): the pane menu / hotkey bumps this counter to force a TUI repaint.
  const redrawNonce = useAppStore((s) => s.paneRedrawNonce[paneId] ?? 0);
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
  // #3975: the focus effect below runs on a rAF and skips while `openedRef` is false. Now that open()
  // waits for an admission slot, that effect can fire BEFORE the terminal exists and silently drop the
  // focus. So `openIfReady` focuses on open when this pane is the focused one — the two orderings are
  // now both handled, whichever wins the race. A ref because the mount effect's closure is stale.
  const wantFocusRef = useRef(false);
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
  // Turn-open gate (#1184): true while this pane's latest Claude-Code hook event is a
  // UserPromptSubmit with no following Stop — i.e. the agent is working, even if SILENT. Fed by the
  // activity poller below; read by the silence-timer callback to AVOID a wrongful mid-turn idle.
  // Authoritative idle still comes only from a real Stop (which flips this back via the poll) or,
  // for non-bash / never-launched panes that emit no activity, from the silence timer unchanged.
  const turnOpenRef = useRef(false);
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // resize-nudge restore (#1221)
  const autoNudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // post-launch auto-redraw (#1221)
  const jumbleStrikesRef = useRef(0); // consecutive malformed probes (#1250)
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // jumble re-check (#1250)
  // A Claude session is the running program in this pane. Lifted to the store (transient) so
  // PaneShell can read it to drive the model-pill "running" indicator (#1181); the OSC/reconnect
  // handlers below set it via setPaneClaudeActive. TerminalView itself no longer consumes it — the
  // native input overlay it used to gate (#1158) was reverted in #1239 so Claude's own TUI input
  // shows instead.
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
    useAppStore.getState().bumpLiveAgents(1);

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
    let disposeClipboard: (() => void) | null = null; // copy-on-select + paste (#3157), armed once on open
    // #3975: `term.open()` allocates the renderer and touches the DOM — the expensive part. A tab with
    // 29 panes ran 29 of them in ONE frame, on the thread that paints the window: measured as a
    // 6-second gap in the 2s perf sampler (nothing ran at all), with only ONE React render in the same
    // window — so the cost is entirely outside React. Admission spreads them across frames.
    //
    // Hooked HERE rather than around the whole effect because this function is already the "not ready
    // yet, open later" path (hidden panes defer to the ResizeObserver below), so the retry machinery
    // and its cleanup are already correct and exercised. Gating admission is one more not-ready reason.
    function openIfReady(): boolean {
      if (openedRef.current) return true;
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return false;
      term.open(el);
      openedRef.current = true;
      disposeClipboard = attachTerminalClipboard(term, paneId);
      fitAddon.fit();
      if (pendingRef.current.size() > 0) term.write(pendingRef.current.flush());
      term.scrollToBottom(); // show the latest output on (re)mount, no scrolling (#68)
      // #3975: the focus effect may already have run and skipped (no terminal yet) — honour it now.
      if (wantFocusRef.current) term.focus();
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
      // Focus is decided by ConsoleWorkspace — handleStatusChange enqueues this
      // pane on idle and the user steps through with Ctrl+Shift+N (or auto-
      // advance-on-reply). Only first-idle ever enqueues a pane, so a cold-
      // starting grid can't yank the cursor around. We don't focus here.

      // Output has settled, so we're looking at a stable frame — probe it for a jumbled redraw
      // and self-heal mid-session (#1250).
      probeForJumble();
    }

    // Detect a jumbled Claude CLI TUI by inspecting the input-box chrome at the bottom of the
    // viewport, and auto-nudge (the #1221 resize repaint) when it's shattered (#1250). Gated hard on
    // the **Claude CLI** provider — an API / bsc-agent session renders its own UI, not this box
    // chrome, and would need a different signal, so we never probe (or nudge) it here.
    function probeForJumble() {
      const providerId = useAppStore.getState().paneProviders[paneId] ?? "claude";
      if (getProvider(providerId)?.isClaude !== true) return;
      if (!openedRef.current) return;
      const t = termRef.current;
      if (!t) return;
      const buf = t.buffer.active;
      const bottom = buf.baseY + t.rows; // exclusive index past the last viewport row
      const rows: string[] = [];
      for (let y = Math.max(0, bottom - JUMBLE_CHROME_ROWS); y < bottom; y++) {
        const line = buf.getLine(y);
        if (line) rows.push(line.translateToString(true));
      }
      if (probeJumble(rows, t.cols) !== "malformed") {
        jumbleStrikesRef.current = 0; // a healthy/unknown frame clears the streak
        return;
      }
      jumbleStrikesRef.current += 1;
      if (jumbleStrikesRef.current >= JUMBLE_STRIKES) {
        jumbleStrikesRef.current = 0;
        useAppStore.getState().requestPaneRedraw(paneId); // same nudge path as the manual control
        return;
      }
      // Persisted? Re-check shortly so two strikes accrue within one settle (prompt fix), not across
      // separate turns — and a one-off mid-draw frame resets on the healthy re-check.
      if (probeTimerRef.current) clearTimeout(probeTimerRef.current);
      probeTimerRef.current = setTimeout(() => { probeTimerRef.current = null; probeForJumble(); }, JUMBLE_RECHECK_MS);
    }

    function armQuietTimer() {
      if (quietTimerRef.current) clearTimeout(quietTimerRef.current);
      quietTimerRef.current = setTimeout(() => {
        quietTimerRef.current = null;
        if (inClaudeRef.current && claudeActiveRef.current === "run") {
          // Turn-open gate (#1184): if the agent's turn is still OPEN per the activity hooks
          // (a UserPromptSubmit with no Stop yet), it's working-but-silent — thinking, a long
          // silent tool call, backoff — so DON'T false-idle. Re-arm and keep watching; idle only
          // lands once the real Stop closes the turn (turnOpenRef flips false) or the quiet timer
          // fires for a pane with no activity signal at all (non-bash / never-launched — unchanged).
          if (turnOpenRef.current) { armQuietTimer(); return; }
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
        useAppStore.getState().setPaneClaudeActive(paneId, true); // claude running → show the native input (#1158)
        armQuietTimer();
        // Mark this pane as a claude pane so the next app launch can resume
        // it with `claude --continue` (#36). The setter no-ops when the
        // flag is already on, so repeated OSC 100 "run" emissions during a
        // session don't churn the store.
        useAppStore.getState().setPaneWasClaude(paneId, true);
      } else if (data === "idle") {
        inClaudeRef.current = false;
        useAppStore.getState().setPaneClaudeActive(paneId, false); // claude exited → restore the status footer
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
      fireInvoke("pty_write", { paneId, data }, console.error);
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
      // #3992: ONE admission slot gates the whole heavy sequence — open + fit + pty_create — not just
      // `term.open()`. #3975 gated the open alone, which inverted the ordering this path depends on:
      // `pty_create` is called with `term.cols/term.rows`, and those are xterm's 80x24 DEFAULTS until
      // the terminal has been opened and fitted. Every PTY came up 80x24 while the pane rendered at
      // its real size. Gating here restores open-then-size AND bounds the pty_create burst, which is
      // the concurrency limit deferred in #3991.
      await admitTerminal();
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
            const docText = await safeInvoke<string>("read_document", { relpath: doc }, PROJECT_INIT_PROMPT);
            startupPrompt = docText.trim() || PROJECT_INIT_PROMPT;
          }
        }
      }
      // Triage continuity: if this pane has a checkpoint doc, fold the prior
      // session's "where we left off" note onto the prompt. The doc is handed to
      // the backend below so the `bsc-checkpoint` helper can update it for next time.
      const checkpointDoc = useAppStore.getState().paneCheckpointDocs[paneId];
      if (startupPrompt !== undefined && checkpointDoc) {
        const note = await safeInvoke<string>("read_document", { relpath: checkpointDoc }, "");
        startupPrompt = composeStartupPrompt(startupPrompt, note);
      }
      if (destroyed) return;

      // Resolve which provider this pane is running (default: Claude).
      const providerId = useAppStore.getState().paneProviders[paneId] ?? "claude";
      const provider = getProvider(providerId) ?? getProvider("claude")!;
      const isClaudeProvider = provider.isClaude === true;
      // The bsc-agent harness also bakes the startup prompt (via BscAgentAdapter in pty_create),
      // so it keeps startupPrompt like Claude; other bare-shell providers don't (#1078 P3b).
      const bakesPrompt = isClaudeProvider || providerId === "bsc-agent";

      // Non-baking providers don't hand pty_create a startupPrompt (only Claude / bsc-agent bake it
      // via the backend harness). Aider (#1172) instead consumes the prompt in its OWN launch command
      // (`aider --message …`, built in resolveEffectiveInitCmd), so keep `startupPrompt` populated
      // here; pty_create still receives it only for `bakesPrompt` providers (guarded below).

      // Serialize `claude` cold-starts so simultaneously-mounted panes don't
      // stampede the shared OAuth credential store and log every session out. A
      // pane launches claude if its initCmd says so, or it has a startup prompt
      // (which the backend turns into a claude launch), or the provider is Claude.
      // Non-claude shells and tab-switch reconnects pass through instantly.
      const launchesClaude = isClaudeProvider && ((initCmd ?? "").includes("claude") || startupPrompt !== undefined);
      if (launchesClaude) {
        await gateClaudeLaunch(paneId);
        if (destroyed) return;
      }

      // Configure this session's shell permissions before launch: Bash is allowed
      // broadly (start-and-go) with a curated deny-list, so claude never blocks on
      // a permission prompt mid-task. Allowed commands are the resolved
      // global+project+repo set; denied are the user's global blocks (the backend
      // always adds its dangerous defaults).
      // Authenticate gh / git-over-https in the agent shell: export a GitHub token as
      // GH_TOKEN into the PTY (and the readiness probe), so a worker can push its branch
      // and open a PR. Without it gh is unauthenticated and gh pr create / https push
      // fail (#362). Repo-scoped credentials (#158): when this pane is bound to a repo
      // with an assigned fine-grained token, use THAT token (not the global PAT), so the
      // session's gh/git is scoped to its repo and can't act on sibling repos; otherwise
      // fall back to the global token (director / ad-hoc console / un-scoped repo).
      const ghToken = tokenForRepo(
        useAppStore.getState().paneRepos[paneId],
        useAppStore.getState().repoGithubTokens,
        useAppStore.getState().githubToken,
      );
      // Base session env (GH_TOKEN for gh/git). For a bsc-agent session, also inject the selected
      // LLM provider/model/key, role-derived perms, and resolved MCP servers (BSC_AGENT_* env, #1078
      // P3b). Composed in sessionLaunch.buildAgentEnv from the current store snapshot.
      const agentEnv = buildAgentEnv(useAppStore.getState(), paneId, providerId, ghToken);
      // #1819 hardening — never launch claude permission-less. If the pane's configured cwd came back
      // empty (the async bscBaseDir mirror wasn't loaded when its cwd was set), recover an authoritative
      // dir from Rust by the pane's identity (triage → repo dir, director → hub) so the role gate +
      // shell allow-list are always written where claude actually launches.
      let launchCwd = initialCwd ?? "";
      if (launchesClaude && !launchCwd) {
        const recovery = paneCwdRecovery(paneId);
        if (recovery) {
          launchCwd = await safeInvoke<string>(recovery.cmd, recovery.args, "");
          if (destroyed) return;
          if (launchCwd) log.warn(`console[${paneId}] recovered an empty launch cwd from Rust (#1819): ${launchCwd}`);
        }
      }
      if (launchesClaude && launchCwd !== "") {
        // Compose the role gate (#219) + profile (#255) + flow (#297/#304) + MCP/hooks + skills (#636)
        // + audit/confine/scope/taint/defer/skill/activity hooks into the permission payload. Pure
        // composition lives in sessionLaunch.buildSessionSettings; read from the current snapshot.
        const settings = buildSessionSettings(useAppStore.getState(), paneId);
        await safeInvoke("ensure_session_settings", {
          cwd: launchCwd,
          ...settings,
          // Replace (not merge) the permission block so a relaunch reflects the CURRENT
          // role+profile exactly — incl. permissions the user removed from the profile (#799).
          replacePermissions: true,
        }, undefined, (e) => log.error(`console[${paneId}] ensure_session_settings failed: ${e}`));
        // Launch (re)wrote the current role+profile permissions — clear any "stale" nudge (#799).
        useAppStore.getState().clearPanePermsStale(paneId);
        if (destroyed) return;
        // Preflight probe (#564): check all host prerequisites (Git Bash, claude,
        // git, gh, gh-auth) using the same env (GH_TOKEN) the session will have.
        // Runs AFTER agentEnv is resolved so gh-auth uses the real token.
        try {
          const prereqs = await invoke<PrereqStatus[]>("preflight", {
            cwd: launchCwd, env: agentEnv ?? null,
          });
          if (!destroyed) setReadinessVerdict(sessionVerdictFromReport(interpretDiagnostics(prereqs)));
        } catch (e) {
          log.error(`console[${paneId}] preflight probe failed: ${e}`);
        }
        if (destroyed) return;
      } else if (launchesClaude) {
        // #1819: a claude-launching pane with an EMPTY cwd means we can't (and don't) write its
        // settings.json — the role gate + shell allowlist are skipped and the session runs
        // permission-less, prompting for everything. We still skip the write (never write to ""),
        // but make it LOUD so a backend-resolved cwd regression can never silently drop perms again.
        log.error(`console[${paneId}] launching claude with an EMPTY cwd — skipping ensure_session_settings; no role gate / shell allowlist written, session will prompt for everything (#1819)`);
      }

      // Resolve the effective init_cmd (Claude resume logic / non-Claude launch cmd) from the current
      // snapshot — see sessionLaunch.resolveEffectiveInitCmd.
      const st = useAppStore.getState();
      const effectiveInitCmd = resolveEffectiveInitCmd(st, paneId, isClaudeProvider, initCmd, startupPrompt, provider);
      // The model new claude launches use (per-pane override, else the global
      // default). The backend maps it to `claude --model <alias>`; an unknown id
      // is a no-op (Claude Code's own default). Only meaningful when this pane
      // launches claude.
      const paneModel = st.paneModels[paneId] ?? st.defaultModel;
      // #1988: opt-in — run a MANUAL console INSIDE the sealed WSL2 sandbox distro: a clean bash at the
      // distro home (no agent launch / startup prompt / Windows cwd — repos aren't mounted in the cage).
      // Gated to manual (`man:`) panes ONLY — an identity pane (triage/fleet) carries a real kickoff +
      // repo cwd that this scratch-shell behavior would wrongly blank (the bug where sandboxed triage
      // agents got no start command). The planner's own sandbox path lives in usePlannerTerminal (#1999).
      const sandboxed = st.sandboxConsoles === true && isManualPaneId(paneId);
      // #1988: an IDENTITY pane (fleet/triage) launched into the cage carries a distro in `paneWslDistro`
      // (set by fleetStartProject). Unlike the manual scratch shell above, it keeps its FULL launch —
      // its cwd is already a distro-native path (the in-distro worktree/hub), initCmd is the bsc-agent
      // runtime, and its kickoff prompt is baked — so we only wrap the spawn in `wsl -d <distro>`.
      const paneDistro = st.paneWslDistro[paneId];
      // The sealed distro this pane spawns into (if any): the manual scratch shell, else an identity
      // pane's cage distro (paneWslDistro), else undefined for the normal host shell.
      const effectiveDistro = sandboxed ? "bsc-agent-sandbox" : (paneDistro || undefined);
      // #1994: a sandboxed WORKER pane runs as its OWN provisioned Linux user — a locked-down (700)
      // home isolates it from co-located agents (raw Bash can't cross Unix perms). Derive+provision the
      // user (idempotent; a relaunch reuses the same home) and pass it to pty_create's `-u`. The
      // director, non-worker panes, and non-sandboxed panes keep the distro's shared default user.
      // A provisioning failure must NOT wedge the launch — log and fall back to the shared user.
      // NOTE (remaining #1994 work): the worker's worktree is still created by the DEFAULT `agent`
      // user under `/home/agent/...` (ensure_sandbox_worktree), so a per-agent user can read/traverse
      // but not WRITE it. Full end-to-end isolation needs that worktree/clone owned by (or group-
      // writable to) this user — the follow-on boundary decision (issue option a vs b).
      let wslUser: string | undefined;
      const sandboxIdentity = sandboxUserIdentity(paneId, effectiveDistro);
      if (sandboxIdentity) {
        try {
          wslUser = await invoke<string>("ensure_sandbox_user", { identity: sandboxIdentity });
        } catch (e) {
          log.error(`console[${paneId}] ensure_sandbox_user failed — launching as the shared distro user (#1994): ${e}`);
        }
        if (destroyed) return;
      }
      // #3614: a fleet worker whose worktree was reclaimed by the boot-GC is marked ended by the boot
      // reconciliation (useAppBoot). PaneAt renders its resting card instead of this view — but if this
      // mount effect was already in flight when `endedPanes` flipped, bail here so we NEVER spawn a PTY
      // into a deleted worktree (the burst of doomed sessions that jams the backend on boot).
      if (useAppStore.getState().endedPanes[paneId]) return;
      const isNew = await safeInvoke<boolean>("pty_create", {
        paneId,
        cols: term.cols,
        rows: term.rows,
        cwd:     sandboxed ? "/home/agent" : launchCwd,
        initCmd: sandboxed ? undefined : effectiveInitCmd,
        // Only pass startupPrompt for Claude panes — the backend bakes it as
        // `claude --initial-message`, which would be wrong for other providers.
        startupPrompt: sandboxed ? undefined : (bakesPrompt ? startupPrompt : undefined),
        // #2052: on a crash-restore remount, suppress re-submitting the baked startup prompt /
        // checkpoint note into the resumed (`--continue`) conversation — otherwise Claude submits
        // it into the restored session, re-running or (if it was a `/clear`) wiping its history.
        // Only true on the crash-recovery relaunch (restoreRequested); normal launches deliver.
        startupPromptFreshOnly: resolveStartupPromptFreshOnly(st, paneId, isClaudeProvider),
        model:   paneModel,
        // Triage panes resume the repo's prior conversation (claude --continue).
        continueSession: useAppStore.getState().paneContinue[paneId] ?? false,
        // Per-repo triage checkpoint doc, so the bsc-checkpoint helper can write it.
        checkpointDoc,
        env: agentEnv,
        providerId,
        // The sealed distro to spawn into (#1988): the manual scratch shell, else an identity pane's
        // cage distro (paneWslDistro), else undefined for the normal host shell.
        wslDistro: effectiveDistro,
        // #1994: the per-agent Linux user to run the distro session as (sandboxed workers only) — its
        // private 700 home isolates it from co-located agents. Undefined ⇒ the distro's shared default.
        wslUser,
      }, true, (e) => log.error(`console[${paneId}] pty_create failed: ${e}`));

      // Show the native input as soon as we LAUNCH a Claude session — don't wait for the OSC-100
      // "run" signal, which can be missed on a cold start, leaving Claude's own (legacy) input
      // visible and ours hidden (#1158). OSC-100 "idle" (process exit) still clears it.
      if (launchesClaude) {
        useAppStore.getState().setPaneClaudeActive(paneId, true);
        // Auto-redraw (#1221): Claude's TUI sometimes paints jumbled on its first draw (and on a
        // reconnect — this block runs for both). Request one resize-nudge after it's had a moment to
        // render, so it self-heals without the user invoking "redraw / fix display" by hand. Keyed
        // off the launch (which is reliable) rather than the OSC-100 "run" marker (which can be
        // missed). Routes through the same requestPaneRedraw path as the manual trigger; the nudge
        // is openedRef-guarded + debounced, so an early/duplicate request no-ops.
        if (autoNudgeTimerRef.current) clearTimeout(autoNudgeTimerRef.current);
        autoNudgeTimerRef.current = setTimeout(() => {
          autoNudgeTimerRef.current = null;
          useAppStore.getState().requestPaneRedraw(paneId);
        }, AUTO_NUDGE_DELAY_MS);
      }

      if (!isNew) {
        // Reconnecting — Ctrl+L repaints the prompt without submitting a command
        fireInvoke("pty_write", { paneId, data: "\x0c" }, (e) => log.error(`console[${paneId}] repaint write failed: ${e}`));
        // A reconnected Claude pane is already running its REPL (no fresh OSC-100 "run" to catch),
        // so re-show the native input for it (#1149).
        if (isClaudeProvider && useAppStore.getState().paneWasClaude[paneId]) useAppStore.getState().setPaneClaudeActive(paneId, true);
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
        fireInvoke("pty_resize", { paneId, cols: term.cols, rows: term.rows }, console.error);
      }
    });
    ro.observe(el);

    return () => {
      destroyed = true;
      if (quietTimerRef.current) { clearTimeout(quietTimerRef.current); quietTimerRef.current = null; }
      if (nudgeTimerRef.current) { clearTimeout(nudgeTimerRef.current); nudgeTimerRef.current = null; }
      if (autoNudgeTimerRef.current) { clearTimeout(autoNudgeTimerRef.current); autoNudgeTimerRef.current = null; }
      if (probeTimerRef.current) { clearTimeout(probeTimerRef.current); probeTimerRef.current = null; }
      el.removeEventListener("focusin", onFocusIn);
      disposeOnData.dispose();
      disposeClipboard?.();
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
      useAppStore.getState().bumpLiveAgents(-1);
      // PTY session intentionally kept alive — reconnects on remount (tab switch).
      // Sessions are cleaned up explicitly when a tab is closed (pty_kill).
    };
  }, [paneId]);

  // Keep visibleRef in sync with the prop so the PTY listener reads the latest
  // value synchronously. Declared before the [visible] effect below so it runs
  // first per React's effect-ordering rules: by the time the buffer-flush /
  // fit / resize logic below runs, visibleRef already reflects the new value.
  useEffect(() => { visibleRef.current = visible; }, [visible]);

  // Turn-open gating poller (#1184): poll the `bsc-activity` hook log for THIS pane's latest
  // turn-boundary state and keep `turnOpenRef` in sync, so the silence-timer callback above can
  // tell "working but silent" from "done". `bsc logs pane-activity` returns every pane's latest state;
  // we read off our own. Empty/missing (a non-bash session, or a pane that hasn't taken a turn)
  // leaves the ref false — the silence timer stays authoritative, so there's no regression. Polled
  // every 1s (faster than the 4s token poll) so the gate re-arms promptly when a new turn opens.
  // Debounced (#1184): a worker's blocked Stop records `idle` for the gap before its next turn's
  // UserPromptSubmit reopens `run`; the grace window keeps the gate closed across that gap so the
  // dot doesn't blink idle→run.
  // Event-driven (#3638): re-check this pane's turn state only when the activity log changes (plus
  // mount + a slow backstop), instead of polling every 1s. The debounce in `isTurnOpenDebounced` still
  // smooths the idle→run gap between turns.
  // #3944: reads the SHARED table instead of invoking per pane. `logs_pane_activity` returns every
  // pane's row, so a per-pane subscription meant N identical full-table reads per activity-log write —
  // 24% of all invoke time, and 16 reads per write at the 16-pane fleet, for one row each.
  usePaneActivity((rows) => {
    turnOpenRef.current = isTurnOpenDebounced(paneActivityFor(rows, paneId), Date.now());
  });

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
        // Snap to the latest output so a pane returning to view shows the most
        // recent claude response without the user scrolling down (#68).
        t.scrollToBottom();
        fireInvoke("pty_resize", { paneId, cols: t.cols, rows: t.rows }, console.error);
        // Don't steal focus on becoming visible — the focused-pane effect below
        // focuses only the active pane. Stealing here made every pane in a grid
        // grab focus on mount.
      });
    }
  }, [visible, paneId]);

  // Call term.focus() whenever this pane becomes the focused one. focus() reaches
  // into xterm's textarea, which only exists after open() — skip until opened.
  // We focus even while a Claude session is active (#1239): keystrokes go straight to
  // Claude's own TUI input now that the native overlay is gone.
  useEffect(() => {
    wantFocusRef.current = !!(focused && visible);
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

  // Resize-nudge redraw (#1221): force the Claude CLI's TUI to repaint by transiently shrinking the
  // PTY by one COLUMN — a guaranteed SIGWINCH — then settling back to the true fitted size on the
  // next tick. This reproduces, per-pane, the recompute a window resize triggers (the manual
  // workaround for the CLI's jumbled-redraw bug) without touching the OS window. A column delta (not
  // rows) avoids interacting with the #1158 growing-host input clip box. Non-destructive: a resize
  // preserves typed input + scrollback. Debounced: while a cycle is in flight (`nudgeTimerRef`),
  // extra triggers coalesce so rapid taps don't thrash the PTY. The restore re-fits and resizes to
  // the real dims, so the net size — and the #586 pane_size streamed to mobile — settles correct.
  function nudgeResize() {
    const term = termRef.current;
    if (!term || !openedRef.current || nudgeTimerRef.current) return;
    fitRef.current?.fit();
    const sizes = nudgeSizes(term.cols, term.rows);
    if (!sizes) return; // nothing safe to shrink
    fireInvoke("pty_resize", { paneId, ...sizes.transient }, console.error);
    nudgeTimerRef.current = setTimeout(() => {
      nudgeTimerRef.current = null;
      const t = termRef.current;
      if (!t || !openedRef.current) return;
      fitRef.current?.fit();
      invoke("pty_resize", { paneId, cols: t.cols, rows: t.rows }).catch(console.error);
    }, 60);
  }

  // Fire a nudge whenever the pane menu / hotkey bumps this pane's redraw counter (#1221). Skip the
  // initial 0 so a freshly-mounted pane isn't nudged.
  useEffect(() => {
    if (redrawNonce === 0) return;
    nudgeResize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redrawNonce]);

  return (
    // eslint-disable-next-line no-restricted-syntax -- terminal region with conditional display (flex/none)
    <div
      style={{
        flex: 1, minHeight: 0, position: "relative",
        background: TERM_THEME.background as string,
        display: visible ? "flex" : "none",
        flexDirection: "column",
      }}
    >
      <TerminalBanners
        paneId={paneId}
        criticalChecks={criticalChecks}
        warningChecks={warningChecks}
        onRetry={retryReadiness}
        warnDismissed={warnDismissed}
        onDismissWarn={() => setWarnDismissed(true)}
        permsStale={permsStale}
      />
      {/* Terminal host. Normal height (#1239): Claude's own TUI input renders inside the visible
          box — the #1158 grow-taller-than-the-clip-box hack (to push Claude's input out of view
          beneath our native overlay) was reverted along with the overlay. */}
      {/* eslint-disable-next-line no-restricted-syntax -- xterm/PTY terminal mount region (measured) */}
      <div style={{
        flex: 1, minHeight: 0, overflow: "hidden",
        background: TERM_THEME.background as string,
        display: criticalChecks.length > 0 ? "none" : undefined,
      }}>
        {/* eslint-disable-next-line no-restricted-syntax -- xterm/PTY terminal mount ref */}
        <div
          ref={containerRef}
          style={{ height: "100%", padding: "6px 4px" }}
        />
      </div>
    </div>
  );
}
