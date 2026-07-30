/** One loop left `open` by a crash — enough to name it in the banner (#3961). */
export interface InterruptedLoop { id: number; a: string; b: string; seed?: string }

// Console domain — navigation + the tabs/panes/focus core app state, plus the pane-lifecycle
// value types (warden quarantine, auto-ended workers). Split from store/types (#1634).
import type { Workspace } from "@/app/chrome/Rail";
import type { NavLoc } from "@/app/navigate";
import type { Tab } from "@/app/chrome/Tabstrip";
import type { ViewKey } from "@/app/console/panes/viewDefs";
import type { ReaperConfig } from "@/app/console/lib/idleReaper";
import type { QueuedPane, FocusTarget } from "@/app/console/lib/focusQueue";
import type { SessionRole } from "@/shared/lib/session/sessionRoles";
import type { AgentFlow } from "@/features/planner/fleet/agentFlow";
import type { AgentProfile } from "@/features/security/lib/agentProfiles";
import type { DirectorMode } from "@/features/planner/lib/integrationStrategy";
import type { DirectorDrive } from "@/features/planner/fleet/directorDrive";
import type { TtsVerbosity } from "@/shared/lib/a11y/speech";

/** A worker the warden quarantined (#1102): why it tripped + when, for the user-facing surface. */
export interface QuarantineInfo {
  /** The stream the quarantined pane belonged to. */
  streamId: string;
  /** One-line deterministic trip summary (out-of-lane file / denied command). */
  summary: string;
  /** Epoch ms when it was quarantined. */
  at: number;
  /** Dismissed from the banner: the user acknowledged it. The banner hides, but the pane STAYS
   *  quarantined (its PTY is already dead, so it's paused) and the warden keeps skipping it — so a
   *  still-present out-of-lane edit in its diff can't re-trip and re-show the banner. Cleared for
   *  real only on relaunch / completion. */
  acknowledged?: boolean;
}

/** The resting state a finished fleet worker lands in, classified from plan.db owned-issue
 *  status (#920): every owned issue terminal-good ⇒ `done`; some still open ⇒ `needs-attention`
 *  (stopped early); any blocked/failed ⇒ `blocked`. */
export type WorkerEndState = "done" | "needs-attention" | "blocked";

/** A fleet worker auto-ended after its PTY exited (#920). Persisted so a restart never
 *  re-opens/relaunches a finished worker; the view renders a resting card with a reopen action. */
export interface EndedInfo {
  /** Done / needs-attention / blocked, from the owned-issue status (not the worker's say-so). */
  state: WorkerEndState;
  /** The stream the worker owned. */
  streamId: string;
  /** One-line completeness summary (e.g. "3/3 complete · 2/3 landed"). */
  summary: string;
  /** Epoch ms when it ended. */
  at: number;
}

/** Console domain slice of {@link AppStore}: navigation + the tabs/panes/focus core app state. */
export interface ConsoleState {
  // Navigation
  activeWorkspace: Workspace;
  setWorkspace: (screen: Workspace) => void;
  /** Navigate to a location — switch the workspace AND set its page/entity in one call (#3602), so a
   *  cross-workspace jump can never forget the page. Prefer this over a bare `setWorkspace` whenever the
   *  target page matters (which is nearly always, except the page-less console). */
  navigate: (loc: NavLoc) => void;
  // True once the async persisted state has rehydrated (transient — NOT persisted).
  // The app shell holds its first paint until this flips, to avoid a defaults flash.
  hasHydrated: boolean;
  setHasHydrated: (v: boolean) => void;

  // Console — tabs & panes
  tabs: Tab[];
  activeTabIdx: number;
  paneMenuOpenIdx: number;   // transient — NOT persisted
  focusedPaneIdx: number;    // transient — NOT persisted
  fullscreenPaneIdx: number; // transient — NOT persisted
  consoleBroadcast: boolean; // transient — NOT persisted
  setConsoleBroadcast: (v: boolean) => void;
  // Focus queue (transient — NOT persisted): panes (across all tabs) that finished
  // a turn and await attention, FIFO. Stepped through with Ctrl+Shift+N
  // (advanceFocus), which switches tabs when the next pane lives on another tab.
  // Persists across tab switches; enqueue/remove/reconcile target the active tab.
  focusQueue: QueuedPane[];
  // Enqueue / remove take (tab, pane) so background-tab status changes can
  // participate too — every tab's TerminalView is mounted after #187, so
  // ConsoleWorkspace sees idle transitions for all panes and routes them here (#77).
  enqueueFocus: (tab: number, pane: number) => void;
  removeFocus: (tab: number, pane: number) => void;
  // Role-aware focus targeting (#392, persisted). Which panes the autofocus queue
  // surfaces — by default only the director (workers run dark, escalating via
  // bsc-ask). enqueueFocus is gated by it; changing it re-gates the live queue.
  focusTarget: FocusTarget;
  setFocusTarget: (target: FocusTarget) => void;
  /** Wake a parked pane (#199): seed it with `prompt` as a FRESH claude session and
   *  remount its tab (runId bump). Returns false if the pane/tab is gone or disabled.
   *  The caller `pty_kill`s the pane first so the remount spawns fresh, not reconnect. */
  wakePane: (paneId: string, prompt: string) => boolean;
  clearFocusQueue: () => void;
  advanceFocus: () => void;
  // Prune queued panes across every tab whose live status the caller has —
  // dropped if their pane index isn't in that tab's waiting set. Tabs absent
  // from the map (no live data) keep their entries, so a transient missing-tab
  // moment can't silently drop queued panes.
  reconcileFocusQueue: (waitingByTab: ReadonlyMap<number, ReadonlySet<number>>) => void;
  // Global terminal font size (px), shared by every console pane (persisted).
  // Adjusted via Ctrl++ / Ctrl+- / Ctrl+0; clamped to the legible range.
  terminalFontSize: number;
  setTerminalFontSize: (size: number) => void;
  // Accent color preset id (persisted; configured in Settings → Appearance).
  // Applied to the --accent / --accent-dim CSS tokens at the document root.
  accent: string;
  setAccent: (id: string) => void;
  // Kit theme id (#1852 Phase 3; persisted; configured in Settings → Appearance). A theme is a map
  // of semantic component-token overrides (--card-*/--btn-*/--field-*/--chip-*) applied to :root at
  // boot (like the accent). "default" = the base look. Registry: src/shared/ui/kit/theme.ts.
  kitTheme: string;
  setKitTheme: (id: string) => void;
  // Opt-in notification sounds (#3082; persisted, default OFF; toggled in Settings → Appearance).
  // When on, useNotificationSounds() plays a Signal-kit cue on fleet coord events (landing/merge →
  // success, failure → error, a worker pausing → notify).
  soundNotifications: boolean;
  setSoundNotifications: (on: boolean) => void;
  // App-owned text-to-speech (#3804, a11y epic #2725 Tier 1; persisted, default OFF; Settings →
  // Accessibility). When on, useCoordSpeaker() speaks NEW fleet coordination events via speechSynthesis
  // (paused / question / landed / …), distinct from #3770's ARIA live region for the user's own reader.
  ttsEnabled: boolean;
  setTtsEnabled: (on: boolean) => void;
  ttsRate: number;                       // speechSynthesis rate multiplier
  setTtsRate: (rate: number) => void;
  ttsVoice: string;                      // selected SpeechSynthesisVoice.voiceURI ("" = platform default)
  setTtsVoice: (voiceURI: string) => void;
  ttsVerbosity: TtsVerbosity;            // "terse" (needs-you only) | "verbose" (adds progress)
  setTtsVerbosity: (v: TtsVerbosity) => void;
  // Custom keyboard shortcut overrides (#771): rebindable-shortcut id → chord
  // string (e.g. "Ctrl+Shift+KeyC"). Only overrides are stored; useHotkeys falls
  // back to DEFAULT_BINDINGS for any id absent here. Persisted; edited in
  // Settings → Keyboard.
  keybindings: Record<string, string>;
  setKeybinding: (id: string, chord: string) => void;
  resetKeybinding: (id: string) => void;
  resetAllKeybindings: () => void;
  paneViews: ViewKey[];
  paneNames: Record<number, Record<number, string>>;
  paneCwds: Record<string, string>;  // keyed by "t{tabIdx}p{paneIdx}"
  setPaneCwd: (paneId: string, cwd: string) => void;
  // Live per-pane run status (transient — NOT persisted), keyed by "t{tab}p{pane}".
  // Mirrors Console's local pane-status map into the store so other screens (the
  // Fleet board, #412) can read whether a worker pane is actively running. "run" =
  // claude is mid-turn, "on" = shell up / claude idle, "idle" = at rest.
  paneStatus: Record<string, "run" | "on" | "idle">;
  // Record a pane's live status AND re-roll its tab's state in one step (#435) — the
  // store is the single source of truth for both the pane dot and the tab rollup.
  setPaneStatus: (paneId: string, status: "run" | "on" | "idle") => void;
  // ── Warden quarantine (#1102) ──
  /** Panes the warden hard-paused (PTY killed) for drifting off their plan — possible prompt
   *  injection / hijack. Keyed by pane id; surfaced to the user, who clears it explicitly. */
  quarantinedPanes: Record<string, QuarantineInfo>;
  markQuarantine: (paneId: string, info: QuarantineInfo) => void;
  clearQuarantine: (paneId: string) => void;
  /** Dismiss the banner WITHOUT un-quarantining the pane (the worker stays paused, the warden keeps
   *  skipping it). Distinct from clearQuarantine, which fully removes it (relaunch / completion). */
  acknowledgeQuarantine: (paneId: string) => void;
  /** Per-pane warden "since" floor (epoch ms): the warden ignores `bsc-audit` commands logged BEFORE
   *  this, so a denied command from a PRIOR run can't re-quarantine a relaunched worker. Triage stamps
   *  it; persisted alongside quarantinedPanes. */
  wardenSince: Record<string, number>;
  /** Pressing triage: clear EVERY quarantine under a project's `<projectKey>:` pane-id prefix and
   *  stamp `since` as the warden floor for each relaunching pane — so the relaunch starts clean and a
   *  stale denied command (still in the persisted bsc-audit log) can't immediately re-pause the worker. */
  clearProjectQuarantine: (projectKey: string, panes: string[], since: number) => void;
  // ── Auto-end finished workers (#920) ──
  /** Fleet workers auto-ended after their PTY exited, classified from plan.db owned-issue
   *  status. PERSISTED + recovery-gated so a restart never re-opens a finished worker; the view
   *  renders a resting card with a reopen action. Keyed by pane id. */
  endedPanes: Record<string, EndedInfo>;
  /** Mark a worker pane ended (done/needs-attention/blocked); drops its live status. */
  markPaneEnded: (paneId: string, info: EndedInfo) => void;
  /** Clear a pane's ended state so the user can relaunch it (reopen). */
  reopenPane: (paneId: string) => void;
  // ── Idle session reaping (#849) ──
  /** Panes whose PTY has been reaped for idleness; the view renders a dormant placeholder
   *  and resumes on focus. Transient (not persisted) — panes relaunch on next app start. */
  dormantPanes: Record<string, boolean>;
  /** Epoch ms of each pane's last status change — the reaper's idle clock. Transient. */
  paneLastActivity: Record<string, number>;
  /** Idle-reaper config (enabled + thresholds). Persisted. */
  idleReaper: ReaperConfig;
  /** Mark a pane dormant after its PTY was reaped (the hook calls pty_kill alongside). */
  reapPane: (paneId: string) => void;
  /** Clear a pane's dormant state so the view relaunches it (resume on focus). */
  resumePane: (paneId: string) => void;
  /** Resume a single dormant fleet/agent session in place (#glance-resume): clears the pane's
   *  ended / disabled / dormant flags and stamps `restoreRequested` so its remounted terminal
   *  relaunches with `claude --continue`. Non-disruptive — it touches ONLY this pane, so live
   *  siblings in the same build tab keep running. Returns false (a no-op) when no open tab hosts
   *  the pane id, so the caller can fall back to a full fleet relaunch. */
  /** Drop the ENDED flag for a set of panes about to be relaunched (#3916). */
  clearEndedPanes: (paneIds: string[]) => void;
  resumePaneSession: (paneId: string) => boolean;
  /** Update the idle-reaper config (Settings). */
  setIdleReaperConfig: (cfg: Partial<ReaperConfig>) => void;
  // Recompute one tab's rolled-up state from the current pane statuses + layout +
  // disabled set (#435). Called whenever a rollup input changes that isn't itself a
  // status event — a layout change or a pane enable/disable — so the tab dot never
  // goes stale (e.g. shows "run" after the only running pane was disabled).
  recomputeTabState: (tabIdx: number) => void;
  // Drop a tab's pane statuses on close / remount so a prior session's "run"/"on"
  // can't strand a stale activity dot on the fresh panes (#435).
  clearTabStatuses: (tabIdx: number) => void;
  // Per-pane flag: this pane has had `claude` running at some point this
  // session. Persisted so that on next launch the pane can auto-resume the
  // CLI (with `--continue`) instead of dropping the user back at a bare
  // bash prompt (#36). Set by TerminalView when OSC 100 "run" fires.
  paneWasClaude: Record<string, boolean>;
  /** Crash recovery (#1041): the previous shutdown was unclean (set once at boot from the
   *  `was_unclean_shutdown` command). Transient — NOT persisted. Gates session auto-resume (a clean
   *  quit leaves sessions dormant) + the restore banner. */
  uncleanShutdown: boolean;
  setUncleanShutdown: (v: boolean) => void;
  /** Loops an unclean shutdown stranded (#3961) — counted at boot, cleared when the user acts.
   *  Empty on a clean quit: an open loop is then legitimately dormant, not interrupted. */
  interruptedLoops: InterruptedLoop[];
  /** Count the stranded loops WITHOUT writing (`bsc loop reap --dry-run`). Boot-only, crash-gated. */
  probeInterruptedLoops: () => Promise<void>;
  /** Close them for real (`bsc loop reap`), recording `ended_by=interrupted`. */
  reapInterruptedLoops: () => Promise<void>;
  /** Dismiss the banner without writing — the loops stay open and reappear next crash. */
  dismissInterruptedLoops: () => void;
  /** Crash recovery (#1041): panes the user clicked "restore" for — resume with `claude --continue`
   *  on remount, regardless of the autoResumeClaude setting. Transient. */
  restoreRequested: Record<string, boolean>;
  /** Relaunch every `paneWasClaude` pane with `claude --continue`, staggered. Returns the count. */
  restoreSessionsFromCrash: () => number;
  /** Live agent/terminal pane count (transient, not persisted) — drives the >10 easter egg (#365). */
  liveAgents: number;
  bumpLiveAgents: (delta: number) => void;
  /** Unlocked achievements: id -> unlockedAt epoch ms (persisted). */
  achievements: Record<string, number>;
  /** Unlock an achievement once, ever. Returns true only on the FIRST unlock
   *  (so the caller fires its toast exactly once); false if already unlocked. */
  unlockAchievement: (id: string) => boolean;
  setPaneWasClaude: (paneId: string, on: boolean) => void;
  paneInitCmds: Record<string, string>; // transient — NOT persisted
  setPaneInitCmd: (paneId: string, cmd: string) => void;
  // Resolved startup-prompt document per pane (transient — NOT persisted).
  // paneId → document relpath; "" means the built-in default prompt; absent
  // means no startup prompt (a plain console pane). Read by TerminalView.
  paneStartupPromptDocs: Record<string, string>;
  // Verbatim startup-prompt text per pane (transient — NOT persisted). Takes
  // precedence over paneStartupPromptDocs in TerminalView: when present, the
  // exact text is sent to the session once Claude reaches its prompt. Used by
  // triage panes (see TRIAGE_PROMPT).
  paneStartupPromptText: Record<string, string>;
  // paneId → unified-store relpath of the triage CHECKPOINT doc (transient — NOT
  // persisted). The session overwrites it via the `bsc-checkpoint` shell helper;
  // TerminalView composes its content onto the next triage launch's prompt so the
  // pass resumes where it left off. Set for triage panes (see triageStartProject).
  paneCheckpointDocs: Record<string, string>;
  // Per-pane flag (transient — NOT persisted): launch claude with --continue to
  // resume the repo's prior conversation rather than starting fresh. Set for
  // triage panes (see triageStartProject); read by TerminalView.
  paneContinue: Record<string, boolean>;
  // Disabled panes (keyed by "t{tabIdx}p{paneIdx}") — terminal unmounted + PTY killed.
  disabledPanes: Record<string, boolean>;
  setPaneDisabled: (paneId: string, disabled: boolean) => void;
  // Role-scoped capability per pane (#219) — transient. When set, the session's
  // command allowlist is narrowed at launch (a planner can't run git/gh writes).
  // Absent ⇒ unrestricted (current behavior). Set by the planning/fleet assignment.
  paneRoles: Record<string, SessionRole>;
  /** Drive mode for each launched director pane (#366) — read by useDirectorPump. */
  paneDirectorDrive: Record<string, DirectorDrive>;
  /** Integration mode (watchdog/integrator) for each launched director pane (#378) — read by useCiWatcher. */
  paneDirectorMode: Record<string, DirectorMode>;
  /** Each worker pane's repo + branch (#373) — lets useCiWatcher map a PR back to it. */
  paneStream: Record<string, { repo: string; branch: string }>;
  setPaneRole: (paneId: string, role: SessionRole) => void;
  // Agents (#255) — editable permission profiles + their per-pane assignment, both
  // persisted. A pane's assigned profile is applied to its session at launch (the
  // same gate as paneRoles). Absent ⇒ no profile (unrestricted beyond the role gate).
  agentProfiles: AgentProfile[];
  setAgentProfiles: (profiles: AgentProfile[]) => void;
  updateAgentProfile: (id: string, patch: Partial<AgentProfile>) => void;
  paneProfiles: Record<string, string>;
  /** Panes whose assigned profile was edited while running — drives a "relaunch to apply"
   *  nudge (Claude Code reads settings.json at session start). Transient; cleared on relaunch (#799). */
  panePermsStale: Record<string, boolean>;
  clearPanePermsStale: (paneId: string) => void;
  /** Monotonic per-pane counter that drives the resize-nudge redraw (#1221) — a SIGWINCH that
   *  un-jumbles the Claude CLI's TUI the way a window resize does. Bumped by `requestPaneRedraw`
   *  (the pane menu / hotkey); the pane's terminal watches its own count and nudges on each bump. */
  paneRedrawNonce: Record<string, number>;
  requestPaneRedraw: (paneId: string) => void;
  // Worker write boundary: the stream's owned globs, fed to the role gate as
  // writeGlobs so a worker auto-approves edits within its lane (bsc-confine bounds the repo).
  paneRoleGlobs: Record<string, string[]>;
  // Per-pane `owner/name` repo binding (#158), set at fleet/triage launch. TerminalView
  // resolves the pane's GH_TOKEN from this via tokenForRepo: a repo with an assigned
  // fine-grained credential gets that token (scoping its gh/git to that repo), otherwise
  // the global PAT. Absent (director, ad-hoc console) ⇒ global token. Persisted so a
  // restored session keeps its scope.
  paneRepos: Record<string, string>;
  /** Per-agent flow (#297) for each pane, seeded at fleet launch from the stream. */
  paneFlows: Record<string, AgentFlow>;
  /** Console provider id per pane (persisted). Absent ⇒ "claude" (default). */
  paneProviders: Record<string, string>;
  setPaneProvider: (paneId: string, providerId: string) => void;
  /** WSL2 sandbox distro a pane spawns INTO (#1988). Set at fleet/triage launch when the sandbox is
   *  on and the harness is bsc-agent — its cwd is a distro-native path + the session runs in the cage.
   *  Absent ⇒ the normal host shell. Persisted so a restored sandboxed pane reconnects into the cage. */
  paneWslDistro: Record<string, string>;
  /** Whether a Claude session is the running program in each pane (#1158) — transient. Drives the
   *  native console input (which replaces Claude's prompt) and hides the pane's status footer. */
  /** Panes STOPPED waiting on the USER (#4005) — Claude Code fired `Notification`: a permission
   *  prompt, or a long input idle. Fed from the ONE shared pane-activity read in ConsoleWorkspace, so
   *  Glance can raise the `attention` health without importing the console shell (features must not
   *  import `app/`). Transient — not persisted; it is re-derived from activity.log on every read. */
  /** Panes that DECLARED maintenance (#4025) — `bsc-maintain`: everything they own is done and they
   *  are standing by. Projected from `CoordState.maintaining` by the coordinator (the one reader that
   *  already computes it) so the idle reaper and Glance can both see it without a second log poll.
   *  Transient — re-derived from coord.log on every read. */
  paneMaintaining: Record<string, boolean>;
  setPaneMaintaining: (panes: Record<string, boolean>) => void;
  paneAttention: Record<string, boolean>;
  setPaneAttention: (panes: Record<string, boolean>) => void;
  paneClaudeActive: Record<string, boolean>;
  setPaneClaudeActive: (paneId: string, active: boolean) => void;
  setPaneProfile: (paneId: string, profileId: string | null) => void;
  setActiveTab: (idx: number) => void;
  addTab: (tab: Tab) => void;
  closeTab: (idx: number) => void;
  /** Reorder a tab from index `from` to `to`, remapping all index-keyed pane
   *  state (names/cwds/status/disabled/extensions/allowed-commands/focus queue)
   *  so nothing bleeds onto the wrong tab (#461). */
  moveTab: (from: number, to: number) => void;
  renameTab: (idx: number, name: string) => void;
  setTabLayout: (tabIdx: number, layout: string) => void;
  setTabState: (tabIdx: number, state: Tab["state"]) => void;
  setPaneMenu: (idx: number) => void;
  setFocusedPane: (idx: number) => void;
  setFullscreenPane: (idx: number) => void;
  focusedAgentName: string;
  setFocusedAgentName: (name: string) => void;
  setPaneView: (idx: number, view: ViewKey) => void;
  setAllPanesView: (view: ViewKey) => void;
  setPaneName: (tabIdx: number, paneIdx: number, name: string) => void;
}
