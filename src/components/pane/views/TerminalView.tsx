import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { log } from "../../../lib/core/log";
import { resolveLlmConfig, bscAgentEnv } from "../../../lib/core/llmConfig";
import { recordPtyData, bumpTerminals } from "../../../lib/core/perf";
import { gateClaudeLaunch } from "../../../lib/fleet/launchGate";
import { scrollbackForPaneCount, totalMountedPaneCount } from "../../../lib/console/terminal";
import { nudgeSizes } from "../../../lib/console/terminalNudge";
import { probeJumble } from "../../../lib/console/jumbleProbe";
import { composeStartupPrompt } from "../../../lib/session/checkpoint";
import { composeReferenceContext } from "../../../lib/session/assignments";
import { resolveMcpServers, toBscAgentMcp } from "../../../lib/session/mcpServers";
import { resolveHooks } from "../../../lib/session/hooks";
import { toSessionPayloads } from "../../../lib/session/sessionConfig";
import { effectiveSessionSkills, expandGroups, toSkillCfgs } from "@/features/skills/lib/skills";
import { PendingPtyData } from "../../../lib/console/pendingPtyData";
import { resolveInitCmd } from "../../../lib/console/resumeClaude";
import { isManualPaneId } from "../../../lib/console/paneIdentity";
import { roleCapability, roleDeniedCommands, roleWriteRules, roleDeniedTools, bscAgentPerms } from "../../../lib/session/sessionRoles";
import { resolveProfileSettings } from "../../../screens/agents/profileEnforcement";
import { flowPermissionRules, flowGrantedPushCommands } from "../../../screens/planner/fleet/flowPermissions";
import { useAppStore, PROJECT_INIT_PROMPT } from "../../../store";
import { interpretDiagnostics, sessionVerdictFromReport, type PrereqStatus, type SessionVerdict } from "../../../lib/core/diagnostics";
import { SessionReadinessBanner } from "../../SessionReadinessBanner";
import { SessionFailure } from "../../SessionFailure";
import { tokenForRepo } from "../../../lib/github/repoCredentials";
import { getProvider } from "../../../lib/console/providers";

// Background-pane buffer cap. While a pane is hidden we skip xterm.write
// entirely and accumulate the PTY bytes here; on becoming visible we flush
// them in one go. 256 KB ≈ a few thousand lines of dense output — generous for
// realistic switch-away durations and far above what's likely useful before
// xterm's own scrollback truncates it anyway.
const PENDING_BYTES_CAP = 256 * 1024;

// Grace before the automatic post-launch redraw nudge (#1221) — long enough for Claude's TUI to
// finish its first paint, so the nudge repaints a fully-drawn (and possibly jumbled) screen rather
// than an empty one. The nudge is idempotent + non-destructive, so an imprecise delay is harmless.
const AUTO_NUDGE_DELAY_MS = 700;

// Mid-session jumble probe (#1250): at each Claude settle, sample the bottom input-box rows and
// auto-nudge when the box chrome is shattered. Hysteresis — two malformed samples (the settle + one
// quick re-check) before firing — so a lone mid-draw frame doesn't trigger a needless repaint.
// (#1239 reverted the input overlay/clip box, so these now guard Claude's own native input box.)
const JUMBLE_CHROME_ROWS = 10; // bottom viewport rows that hold Claude's input box + hint lines
const JUMBLE_STRIKES = 2;
const JUMBLE_RECHECK_MS = 250;

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
  // Session readiness verdict (#564). Set after the preflight probe runs in the
  // mount effect (after the GH token is resolved so gh-auth uses the right env).
  const [readinessVerdict, setReadinessVerdict] = useState<SessionVerdict | null>(null);
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
    function openIfReady(): boolean {
      if (openedRef.current) return true;
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return false;
      term.open(el);
      openedRef.current = true;
      fitAddon.fit();
      if (pendingRef.current.size() > 0) term.write(pendingRef.current.flush());
      term.scrollToBottom(); // show the latest output on (re)mount, no scrolling (#68)
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
      // Reference context (#326): documents assigned as background knowledge for
      // this session (resolved at launch into paneReferenceDocs). Read each and
      // fold their content onto the startup prompt under a clear heading, so the
      // session starts with the assigned context in its first message.
      const refRelpaths = useAppStore.getState().paneReferenceDocs[paneId];
      if (refRelpaths && refRelpaths.length > 0) {
        const contents = await Promise.all(
          refRelpaths.map((rp) => invoke<string>("read_document", { relpath: rp }).catch(() => "")),
        );
        if (destroyed) return;
        startupPrompt = composeReferenceContext(startupPrompt, contents);
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

      // Resolve which provider this pane is running (default: Claude).
      const providerId = useAppStore.getState().paneProviders[paneId] ?? "claude";
      const provider = getProvider(providerId) ?? getProvider("claude")!;
      const isClaudeProvider = provider.isClaude === true;
      // The bsc-agent harness also bakes the startup prompt (via BscAgentAdapter in pty_create),
      // so it keeps startupPrompt like Claude; other bare-shell providers don't (#1078 P3b).
      const bakesPrompt = isClaudeProvider || providerId === "bsc-agent";

      // Providers that don't bake a startup prompt launch as plain shell commands.
      if (!bakesPrompt) startupPrompt = undefined;

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
      // LLM provider/model/key (+ base URL for local) so the runtime talks to the chosen model;
      // bsc-agent reads these from BSC_AGENT_* env (#1078 P3b). Permissions (BSC_AGENT_PERMS from
      // the session role) are a follow-up — bsc-agent runs permissive without them.
      const agentEnv: Record<string, string> | undefined = (() => {
        const e: Record<string, string> = {};
        if (ghToken) e.GH_TOKEN = ghToken;
        if (providerId === "bsc-agent") {
          const st = useAppStore.getState();
          Object.assign(e, bscAgentEnv(resolveLlmConfig(st)));
          // Gate the runtime by the pane's role (same least-privilege model as Claude); bsc-agent
          // enforces this natively from $BSC_AGENT_PERMS. No role ⇒ permissive (unset).
          const bscRole = st.paneRoles[paneId];
          if (bscRole) {
            const cap = roleCapability(bscRole, { writeGlobs: st.paneRoleGlobs[paneId] ?? [] });
            // Reconcile role ↔ flow (#304, parity with the Claude path): the pane's flow owns
            // git push / gh pr create, so lift them from the role denies when it permits pushing/
            // PRing — otherwise an auto-pr worker (github:read) couldn't open its own PR.
            const granted = flowGrantedPushCommands(st.paneFlows[paneId]);
            e.BSC_AGENT_PERMS = JSON.stringify(bscAgentPerms(cap, granted));
          }
          // MCP: pass the resolved stdio servers so bsc-agent's client connects them ($BSC_AGENT_MCP).
          const { mcp } = toSessionPayloads(st.paneMcpServers[paneId] ?? resolveMcpServers(st.mcpServers, ""), []);
          const bscMcp = toBscAgentMcp(mcp);
          if (bscMcp.length > 0) e.BSC_AGENT_MCP = JSON.stringify(bscMcp);
        }
        return Object.keys(e).length > 0 ? e : undefined;
      })();
      if (launchesClaude && (initialCwd ?? "") !== "") {
        const cmds = useAppStore.getState().paneAllowedCommands[paneId]
          ?? useAppStore.getState().allowedCommands;
        // Role gate (#219): a planner/worker/triage session has its mutating git/gh
        // commands denied at launch (deny > the broad gh/git allow), plus a write-tool
        // guard (#238) that denies Write/Edit for no-code roles and scopes a worker to
        // its boundary globs. Absent role ⇒ unrestricted.
        const role = useAppStore.getState().paneRoles[paneId];
        // The worker's write boundary (its owned globs, set at fleet launch) makes
        // roleWriteRules auto-approve Edit/Write within its lane; without it a
        // worker (code:write, empty writeGlobs) prompts on every edit.
        const roleGlobs = useAppStore.getState().paneRoleGlobs[paneId] ?? [];
        const cap = role ? roleCapability(role, { writeGlobs: roleGlobs }) : null;
        const write = cap ? roleWriteRules(cap) : { allow: [], deny: [] };
        // Agents gate (#255): the profile assigned to this pane adds its command
        // allowlist + per-tool/path rules on top of the role gate (deny wins for both).
        const profileId = useAppStore.getState().paneProfiles[paneId];
        const profile = profileId
          ? useAppStore.getState().agentProfiles.find((p) => p.id === profileId)
          : undefined;
        const prof = profile ? resolveProfileSettings(profile) : null;
        // Per-agent flow (#297): narrow the GitHub-propagation writes per the
        // stream's push policy + gate — a hard push-confirm asks before push/PR,
        // commit-only/none deny them, auto-pr adds nothing (broad allow permits).
        const paneFlow = useAppStore.getState().paneFlows[paneId];
        const flowRules = flowPermissionRules(paneFlow);
        const allowedCommands = prof ? [...cmds, ...prof.allowedCommands] : cmds;
        // Reconcile role gate + flow (#304): the flow owns the two GitHub-propagation
        // writes, so lift them from the role denies when the flow permits pushing/PRing
        // (a worker is github:read and would otherwise be blocked from opening its PR).
        // Everything else the role denies (gh pr merge, repo delete, …) stays denied.
        const granted = flowGrantedPushCommands(paneFlow);
        const roleDenies = (cap ? roleDeniedCommands(cap) : []).filter((d) => !granted.includes(d));
        const denied = [
          ...useAppStore.getState().deniedCommands,
          ...roleDenies,
          ...(prof?.deniedCommands ?? []),
        ];
        const allowToolRules = [...write.allow, ...(prof?.allowToolRules ?? [])];
        // Worker sub-agent block (#1036): deny the Task tool for workers so they can't spin up their
        // own sub-agents (which floods the coordinator with wake requests). Deny wins over any
        // profile allow.
        const denyToolRules = [...write.deny, ...(cap ? roleDeniedTools(cap) : []), ...(prof?.denyToolRules ?? []), ...flowRules.denyToolRules];
        const askToolRules = flowRules.askToolRules;
        // MCP servers + hooks resolved for this session — pre-resolved per pane at tab
        // creation; fall back to globals for ad-hoc consoles.
        const mcpServers = useAppStore.getState().paneMcpServers[paneId]
          ?? resolveMcpServers(useAppStore.getState().mcpServers, "");
        const hookDefs = useAppStore.getState().paneHooks[paneId]
          ?? resolveHooks(useAppStore.getState().hooks, "");
        const { mcp, hooks } = toSessionPayloads(mcpServers, hookDefs);
        // Skills (reusable capability bundles) resolved for this session — like
        // extensions, pre-resolved per pane at tab creation (the fleet/triage snapshot,
        // already override-aware). Fall back to the global set for an ad-hoc console, still
        // honoring this pane's per-session override (#1056). Written as .claude/skills/<slug>/SKILL.md.
        const skillState = useAppStore.getState();
        const skillDefs = skillState.paneSkills[paneId]
          ?? effectiveSessionSkills(
               skillState.skills, "", skillState.sessionSkillOverrides[paneId],
               new Set(expandGroups(skillState.sessionSkillGroups[paneId] ?? [], skillState.skillGroups)),
             );
        const skills = toSkillCfgs(skillDefs);
        // Agents audit (#257): on a gated pane (role or profile assigned), install a
        // PreToolUse hooks: log each tool attempt for the Activity feed (bsc-audit),
        // and confine the file tools to the session's repo root (bsc-confine, #158).
        const gatedHooks = (cap || prof)
          ? [...hooks,
             { event: "PreToolUse", matcher: "", command: "bsc-audit" },
             // MCP-call telemetry (#879 PR 2): time each MCP tool call (Pre stamps start,
             // Post logs round-trip ms + outcome) → mcp.log for the MCP Analytics tab.
             { event: "PreToolUse", matcher: "mcp__.*", command: "bsc-mcp" },
             { event: "PostToolUse", matcher: "mcp__.*", command: "bsc-mcp" },
             { event: "PreToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit|Read", command: "bsc-confine" },
             // Tainted-turn gate (#1167): marks the session tainted after it ingests untrusted
             // input (WebFetch / curl / gh view) and blocks an outward/destructive command (exfil,
             // force-push, repo-delete) that runs within the taint window — injection can't act in
             // the turn it was read. Conservative: only the dangerous set is gated; normal work passes.
             { event: "PreToolUse", matcher: "", command: "bsc-taint" },
             // Worker-only Stop hook (#369): when a worker tries to end its turn, bounce it
             // once toward continuing / deferring to the director via bsc-ask instead of
             // stopping to ask the user. `stop_hook_active` prevents an infinite loop.
             ...(role === "worker" ? [{ event: "Stop", matcher: "", command: "bsc-defer" }] : [])]
          : hooks;
        // Skill telemetry (#406) follows the SKILLS, not the role gate: any session that has
        // skills written invokes them, so install the bsc-skill Pre/Post hooks whenever skills
        // are present — incl. an ungated console with a per-session skill (#1056). Without this,
        // skill runs on a non-role/profile pane were never tallied in the Skills "Runs" view.
        const sessionHooks = skills.length > 0
          ? [...gatedHooks,
             // one PreToolUse line per invocation + one PostToolUse line per success → skills.log
             { event: "PreToolUse", matcher: "Skill", command: "bsc-skill" },
             { event: "PostToolUse", matcher: "Skill", command: "bsc-skill" }]
          : gatedHooks;
        await invoke("ensure_session_settings", {
          cwd: initialCwd, allowedCommands, deniedCommands: denied,
          mcpServers: mcp, hooks: sessionHooks,
          allowToolRules, denyToolRules, askToolRules,
          skills,
          // Replace (not merge) the permission block so a relaunch reflects the CURRENT
          // role+profile exactly — incl. permissions the user removed from the profile (#799).
          replacePermissions: true,
        }).catch((e) => log.error(`console[${paneId}] ensure_session_settings failed: ${e}`));
        // Launch (re)wrote the current role+profile permissions — clear any "stale" nudge (#799).
        useAppStore.getState().clearPanePermsStale(paneId);
        if (destroyed) return;
        // Preflight probe (#564): check all host prerequisites (Git Bash, claude,
        // git, gh, gh-auth) using the same env (GH_TOKEN) the session will have.
        // Runs AFTER agentEnv is resolved so gh-auth uses the real token.
        try {
          const prereqs = await invoke<PrereqStatus[]>("preflight", {
            cwd: initialCwd, env: agentEnv ?? null,
          });
          if (!destroyed) setReadinessVerdict(sessionVerdictFromReport(interpretDiagnostics(prereqs)));
        } catch (e) {
          log.error(`console[${paneId}] preflight probe failed: ${e}`);
        }
        if (destroyed) return;
      }

      // Resolve the effective init_cmd.
      // For Claude panes: explicit initCmd wins, then the startup-prompt baking
      // path (pty_create handles it — don't also inject an init_cmd), then ad-hoc
      // auto-resume (`claude --continue` when the pane previously ran Claude).
      // For non-Claude providers: explicit initCmd wins; otherwise fall back to the
      // provider's own launch command so the CLI auto-starts on mount.
      const st = useAppStore.getState();
      // Manual consoles are never auto-recovered (#1176): suppress the crash-resume signals so a
      // fresh "+" pane can't inherit a prior session's `claude --continue` even with auto-resume on.
      const manual = isManualPaneId(paneId);
      const effectiveInitCmd = isClaudeProvider
        ? resolveInitCmd({
            explicit: initCmd,
            startupPrompt,
            paneWasClaude: !!st.paneWasClaude[paneId],
            autoResumeClaude: manual ? false : st.autoResumeClaude,
            // Crash recovery (#1041): resume only after an unclean shutdown (silent, if opted in) or
            // a banner "restore" click — never on a clean restart, and never for a manual console.
            wasUncleanShutdown: st.uncleanShutdown,
            restoreRequested: manual ? false : !!st.restoreRequested[paneId],
          })
        : (initCmd && initCmd.length > 0 ? initCmd : provider.buildLaunchCmd());
      // The model new claude launches use (per-pane override, else the global
      // default). The backend maps it to `claude --model <alias>`; an unknown id
      // is a no-op (Claude Code's own default). Only meaningful when this pane
      // launches claude.
      const paneModel = st.paneModels[paneId] ?? st.defaultModel;
      const isNew = await invoke<boolean>("pty_create", {
        paneId,
        cols: term.cols,
        rows: term.rows,
        cwd:     initialCwd ?? "",
        initCmd: effectiveInitCmd,
        // Only pass startupPrompt for Claude panes — the backend bakes it as
        // `claude --initial-message`, which would be wrong for other providers.
        startupPrompt: bakesPrompt ? startupPrompt : undefined,
        model:   paneModel,
        // Triage panes resume the repo's prior conversation (claude --continue).
        continueSession: useAppStore.getState().paneContinue[paneId] ?? false,
        // Per-repo triage checkpoint doc, so the bsc-checkpoint helper can write it.
        checkpointDoc,
        env: agentEnv,
        providerId,
      }).catch((e) => { log.error(`console[${paneId}] pty_create failed: ${e}`); return true; });

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
        invoke("pty_write", { paneId, data: "\x0c" }).catch((e) => log.error(`console[${paneId}] repaint write failed: ${e}`));
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
        invoke("pty_resize", { paneId, cols: term.cols, rows: term.rows }).catch(console.error);
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
        invoke("pty_resize", { paneId, cols: t.cols, rows: t.rows }).catch(console.error);
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
    invoke("pty_resize", { paneId, ...sizes.transient }).catch(console.error);
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

  // Derive critical + warning lists from the verdict for rendering.
  const criticalChecks = readinessVerdict?.failed.filter((c) => c.severity === "critical") ?? [];
  const warningChecks  = readinessVerdict?.failed.filter((c) => c.severity === "warning")  ?? [];

  function retryReadiness() {
    const cwd = initialCwd ?? "";
    if (!cwd) return;
    const ghToken = tokenForRepo(
      useAppStore.getState().paneRepos[paneId],
      useAppStore.getState().repoGithubTokens,
      useAppStore.getState().githubToken,
    );
    const env = ghToken ? { GH_TOKEN: ghToken } : null;
    invoke<PrereqStatus[]>("preflight", { cwd, env })
      .then((prereqs) => setReadinessVerdict(sessionVerdictFromReport(interpretDiagnostics(prereqs))))
      .catch((e) => log.error(`console[${paneId}] preflight retry failed: ${e}`));
  }

  return (
    <div
      style={{
        flex: 1, minHeight: 0, position: "relative",
        background: TERM_THEME.background as string,
        display: visible ? "flex" : "none",
        flexDirection: "column",
      }}
    >
      {criticalChecks.length > 0 && (
        <SessionFailure critical={criticalChecks} onRetry={retryReadiness} />
      )}
      {criticalChecks.length === 0 && !warnDismissed && warningChecks.length > 0 && (
        <SessionReadinessBanner
          warnings={warningChecks}
          onDismiss={() => setWarnDismissed(true)}
          onSignInGitHub={
            warningChecks.some((c) => c.id === "gh-auth")
              ? () => { useAppStore.getState().setScreen("settings"); }
              : undefined
          }
        />
      )}
      {permsStale && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "6px 12px",
          fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)",
          background: "color-mix(in oklch, var(--accent), transparent 90%)",
          borderBottom: "1px solid color-mix(in oklch, var(--accent), transparent 70%)",
        }}>
          <span>⟳</span>
          <span style={{ flex: 1, color: "var(--fg-muted)" }}>
            Permissions changed on the Agents page — <b style={{ color: "var(--fg)" }}>relaunch this console</b> to apply.
          </span>
          <span
            onClick={() => useAppStore.getState().clearPanePermsStale(paneId)}
            style={{ cursor: "pointer", color: "var(--fg-dim)" }}
            title="Dismiss"
          >✕</span>
        </div>
      )}
      {/* Terminal host. Normal height (#1239): Claude's own TUI input renders inside the visible
          box — the #1158 grow-taller-than-the-clip-box hack (to push Claude's input out of view
          beneath our native overlay) was reverted along with the overlay. */}
      <div style={{
        flex: 1, minHeight: 0, overflow: "hidden",
        background: TERM_THEME.background as string,
        display: criticalChecks.length > 0 ? "none" : undefined,
      }}>
        <div
          ref={containerRef}
          style={{ height: "100%", padding: "6px 4px" }}
        />
      </div>
    </div>
  );
}
