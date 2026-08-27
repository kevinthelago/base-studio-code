// Session-behavior domain — denied shell commands + the console-behavior toggles (auto-focus,
// auto-resume, gate overrides, default/per-pane model, fleet harness). Split from store/types (#1634).
import type { ConsoleAutoFocusMode } from "@/app/console/lib/focusQueue";
import type { ModelId } from "@/app/console/panes/PaneMenu";
import type { SessionModel } from "@/app/console/lib/models";
import type { StudioTarget } from "@/shared/lib/fleet/studioNetworkDrive";
import type { RequestNodeSpec } from "@/features/teams";

/** Session-behavior slice of {@link AppStore}. */
export interface SessionState {
  // Blocked shell commands. Sessions allow Bash broadly (start-and-go); the
  // backend always denies a curated dangerous set, and these are the user's
  // additional global denies. Deny wins
  // over allow.
  deniedCommands: string[];
  addDeniedCommand: (cmd: string) => void;
  removeDeniedCommand: (cmd: string) => void;
  setDeniedCommands: (commands: string[]) => void;

  // Console behavior
  // Selectable auto-focus mode (#434): controls whether and when focus advances
  // after you reply. Persisted; configured in Settings → Integrations.
  // Replaces the old boolean; autoAdvanceOnReply is kept for Console.tsx back-compat.
  autoFocusMode: ConsoleAutoFocusMode;
  setAutoFocusMode: (mode: ConsoleAutoFocusMode) => void;
  // Back-compat derived field: true when autoFocusMode is not "off".
  autoAdvanceOnReply: boolean;
  setAutoAdvanceOnReply: (v: boolean) => void;
  // When true, panes that had claude running at last shutdown auto-relaunch
  // it with --continue on next mount (persisted; configured in Settings →
  // Integrations). Gated per pane by paneWasClaude — off by default for
  // panes that never used claude (#36).
  autoResumeClaude: boolean;
  /** #1107: hard-gate plan publishing on detected prompt-injection markers. ON ⇒ a flagged plan
   *  cannot publish until the marker is removed; OFF (default) ⇒ acknowledge-to-clear. */
  injectionHardGate: boolean;
  setInjectionHardGate: (v: boolean) => void;
  /** Permission posture (#1916): true ⇒ agents (and manual consoles) auto-run and the PreToolUse hooks
   *  do the gating (the deny-list); false ⇒ Claude's `default` mode enforces the enumerated allow-list
   *  (require approval). Default true. Threaded to `write_session_settings` via `buildSessionSettings`. */
  bypassPermissions: boolean;
  setBypassPermissions: (v: boolean) => void;
  /** #1988: launch console panes INSIDE the sealed WSL2 sandbox distro (`bsc-agent-sandbox`) — a clean
   *  bash at the distro home. Opt-in; off by default. Your Windows repos aren't mounted in (the seal),
   *  so it's a scratch/verification shell until project files are relocated into the distro. */
  sandboxConsoles: boolean;
  setSandboxConsoles: (v: boolean) => void;
  // BOTH DEBUG TOGGLES ARE GONE (#debug-nodes-hang-off-the-session-that-filed-them).
  //
  // `debugSession` gated the standing `debugger` node, and that node is gone with it — a stand-in
  // earns its place by showing an element that exists but is not yet active, and every request now
  // draws its own labelled node instead.
  //
  // `autoSpawnDebugSessions` gated the per-request sessions, off by default, which shipped the whole
  // 1:1 request→session machinery switched off. A filed request is worked now. The remaining gate is
  // NOT a preference: `debug_repo_root` must resolve, because a shipped binary with no source tree
  // cannot run these at all.
  /** #3498: the requests that currently have a spawned debug session. Lives in the STORE, not in the
   *  mount's local state, because the Glance graph must render a node per live session — a session that
   *  appears nowhere is one the user cannot open, supervise or stop. Session-only.
   *
   *  Carries each request's ORIGIN and TITLE, not just its id
   *  (#debug-nodes-hang-off-the-session-that-filed-them): the node is labelled `debug - <title>` and
   *  edged to the session that FILED it, and a bare id can express neither. (The old name said "slots"
   *  — pool slot indices, #3535 — which it had already stopped holding when assignment replaced the
   *  pool; a field whose name contradicts its doc comment is one nobody can reason about.) */
  activeDebugRequests: RequestNodeSpec[];
  setActiveDebugRequests: (requests: RequestNodeSpec[]) => void;
  /** #3509: the base-studio-code source tree this app was built from, or null on a shipped binary.
   *  Resolved ONCE at boot so a launch can turn a role's symbolic `app-repo` harvest root into a real
   *  path synchronously. Session-only — it is a property of the machine, not of the user's state. */
  appRepoRoot: string | null;
  setAppRepoRoot: (p: string | null) => void;
  /** #2372: show the legacy Console page as a rail destination. OFF by default — the graph (Glance)
   *  is the execution surface; the console page is being retired. When off, its rail entry is hidden
   *  and a console-active workspace falls back to Glance (derived in App). */
  showConsolePage: boolean;
  setShowConsolePage: (v: boolean) => void;
  /** #2940 (studio network): the app-owned studio sessions the pump currently wants reachable —
   *  targets ("designer"/"librarian") with at least one open commission. Written by
   *  `useStudioNetworkPump` each tick; read by ConsoleWorkspace's lazy-mount hosts, which launch the
   *  target session on demand and tear it down when the list empties. SESSION-ONLY (not persisted). */
  activeStudioTargets: StudioTarget[];
  setActiveStudioTargets: (t: StudioTarget[]) => void;
  /** #199: auto-relaunch a parked pane when its deps land (opt-in; off by default). */
  coordAutoWake: boolean;
  setCoordAutoWake: (v: boolean) => void;
  setAutoResumeClaude: (v: boolean) => void;
  /** #682: let Claude auto-drive the planning phase from a pitch (opt-in; off by default).
   *  Enables the "Auto-plan" control on the planner page. */
  autoPlanWithClaude: boolean;
  setAutoPlanWithClaude: (v: boolean) => void;
  /** #1068: auto-advance planner gates — when a stage's sections are ready, confirm them without
   *  the manual "approve & continue" click (opt-in; off by default). One global flag every gate
   *  follows; steps aside while the planning autopilot is running (it owns confirmation then). */
  autoCompleteGates: boolean;
  setAutoCompleteGates: (v: boolean) => void;
  /** Allow the user to override a blocking planner stage gate and advance anyway (#1285). Off by
   *  default; surfaces a cautionary "override gate & continue" action in the planner footer. */
  allowGateOverride: boolean;
  setAllowGateOverride: (v: boolean) => void;
  /** #738 (security): restrict agents that pull live GitHub issues (triage) to issues
   *  base-studio-code authored — the `bsc-generated` label. ON by default so a hand-created
   *  or injected issue isn't acted on; off works every open issue. */
  restrictToBscIssues: boolean;
  setRestrictToBscIssues: (v: boolean) => void;
  /** Default Claude model new console panes open with (persisted; configured in
   *  Settings → General). Per-pane override lives in the pane hamburger menu. */
  defaultModel: ModelId;
  setDefaultModel: (m: ModelId) => void;
  /** Which harness the agent fleet launches on (#1078 P5): "claude" (default) or
   *  "bsc-agent" — our model-agnostic runtime, on the provider configured in
   *  Settings → Integrations. Persisted. */
  fleetHarness: "claude" | "bsc-agent";
  setFleetHarness: (h: "claude" | "bsc-agent") => void;
  /** Per-pane model override, keyed by paneId. A pane with no entry falls back to
   *  {@link defaultModel}.
   *
   *  Where the whole model precedence chain LANDS — a fleet stream's model, else a team placement's,
   *  else the persona's default (`streamPaneWiring`). The harness decides what to do with it: Claude
   *  Code takes `claude --model <tier>`, a local (bsc-agent) session takes `$BSC_AGENT_MODEL`.
   *
   *  {@link SessionModel}, not {@link ModelId}: a director may point a local worker at an installed
   *  model by name, and `qwen3.5:9b` is not a tier. The narrow type never actually constrained this —
   *  the value arrives from plan.db as untyped JSON — it only asserted something false. */
  paneModels: Record<string, SessionModel>;
  setPaneModel: (paneId: string, m: SessionModel) => void;
}
