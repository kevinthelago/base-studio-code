// Session-behavior domain — denied shell commands + the console-behavior toggles (auto-focus,
// auto-resume, gate overrides, default/per-pane model, fleet harness). Split from store/types (#1634).
import type { ConsoleAutoFocusMode } from "@/app/console/lib/focusQueue";
import type { ModelId } from "@/app/console/panes/PaneMenu";
import type { StudioTarget } from "@/shared/lib/fleet/studioNetworkDrive";

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
  /** #3298: whether the DEBUG session's window is open — a full-capability Claude session in the
   *  base-studio-code SOURCE tree that works the `bsc request` improvement queue (fixing `bsc ui`).
   *  SESSION-ONLY (not persisted): the OS window is session-only, so this defaults off each start and
   *  the toggle opens/closes the window. */
  debugSession: boolean;
  setDebugSession: (v: boolean) => void;
  /** #3498: may a session be started AUTOMATICALLY (by the `bsc request` intake), without a human
   *  asking? OFF by default and the outer gate of the auto-spawn boundary — the inner one being that
   *  ONLY the `debugger` role is ever auto-spawnable (`shared/lib/session/autoSpawn.ts`, the single
   *  authoriser). Auto-spawn is the highest-consequence capability in the app — a session that starts
   *  itself runs a real model against a real repo — so it is opt-in, per-machine, and fails closed:
   *  anything that is not literally `true` reads as off. */
  autoSpawnDebugSessions: boolean;
  setAutoSpawnDebugSessions: (v: boolean) => void;
  /** #3498: the request ids that currently have a spawned debug session. Lives in the STORE, not in the
   *  mount's local state, because the Glance graph must render a node per live session — an auto-spawned
   *  session that appears nowhere is one the user cannot open, supervise or stop. Session-only. */
  activeRequestSessions: number[];
  setActiveRequestSessions: (ids: number[]) => void;
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
   *  {@link defaultModel}. Applied to `claude --model` at the pane's next launch. */
  paneModels: Record<string, ModelId>;
  setPaneModel: (paneId: string, m: ModelId) => void;
}
