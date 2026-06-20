// The store's shape — the AppStore interface + the public value/config types it composes.
// Extracted from store/index.ts (store split, stage 1) so the 2800-line store splits into a
// declarations file (here) + the implementation (index.ts) + per-domain slices.

import type { Screen } from "../components/chrome/Rail";
import type { Tab } from "../components/chrome/Tabstrip";
import type { ViewKey } from "../components/pane/ViewTabs";
import type { ModelId } from "../components/pane/PaneMenu";
import type { KbBlock, Schedule, Command } from "../data/mock";
import type { ReaperConfig } from "../lib/console/idleReaper";
import type { QueuedPane, FocusTarget, ConsoleAutoFocusMode } from "../lib/console/focusQueue";
import type { SessionRole } from "../lib/session/sessionRoles";
import type { AgentFlow } from "../screens/planner/fleet/agentFlow";
import type { WorkflowRun } from "../lib/fleet/conductor";
import type { AgentProfile } from "../screens/agents/agentProfiles";
import type { FleetPlan, AgentStream } from "../screens/planner/stages/planSections";
import type { Topology } from "../screens/planner/relationship/relationshipGraph";
import type { StageConfig, StageId } from "../screens/planner/stages/planStages";
import type { PipelineRunState } from "../screens/planner/grading/pipelineRuntime";
import type { GradeResult } from "../screens/planner/grading/grading";
import type { Blueprint, BlueprintSection } from "../screens/planner/stages/blueprints";
import type { DeployConfig } from "../screens/planner/shared/deployConfig";
import type { DataModel } from "../screens/planner/data/dataModel";
import type { PaneDescriptor } from "../lib/tunnel/tunnel";
import type { DirectorMode, IntegrationStrategy } from "../screens/planner/shared/integrationStrategy";
import type { DirectorDrive } from "../screens/planner/fleet/directorDrive";
import type { McpServer } from "../lib/session/mcpServers";
import type { Hook } from "../lib/session/hooks";
import type { SkillDef } from "../lib/session/skills";
import type { Automation, AutomationRun } from "../lib/automations/scheduler";
import type { SkillPayload } from "../screens/planner/blueprints/blueprintSkills";

export interface GithubUser {
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface PerfConfig {
  enabled: boolean;
  /** Sampling cadence in seconds (0 = off). */
  intervalSecs: number;
  /** Retain samples for N hours (0 = unlimited). */
  retentionHours: number;
  /** Max SQLite DB size in MB (0 = no limit). */
  maxDbMb: number;
  trackProcess: boolean;
  trackFrontend: boolean;
}

export const DEFAULT_PERF_CONFIG: PerfConfig = {
  enabled: true,
  intervalSecs: 2,
  retentionHours: 24,
  maxDbMb: 50,
  trackProcess: true,
  trackFrontend: true,
};

export interface ToolPermissions {
  allow: string[];
  deny: string[];
}

export interface ConfigProfile {
  id: string;
  name: string;
  instructions: string;
  tools: ToolPermissions;
  kbBlockIds: string[];
}

export interface AutomationSuggestion {
  name: string;
  command: string;
  schedule?: string;
  description?: string;
}

export interface GithubRepo {
  full_name: string;
  private: boolean;
  language: string | null;
  open_issues_count: number;
  default_branch: string;
  description: string | null;
  pushed_at: string;
  stargazers_count: number;
}

export interface AppStore {
  // Navigation
  activeScreen: Screen;
  setScreen: (screen: Screen) => void;
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
  // ConsoleScreen sees idle transitions for all panes and routes them here (#77).
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
  // Session pipelines (#220): in-flight runs keyed by work item. Register-only here;
  // launching a stage as a role-scoped pane + auto-advance is the live-wiring slice.
  workflowRuns: Record<string, WorkflowRun>;
  workflowStart: (presetKey: string, item: string) => void;
  workflowClear: (item: string) => void;
  workflowMount: (item: string) => void;
  workflowSetRuns: (runs: Record<string, WorkflowRun>) => void;
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
  // Resolved REFERENCE-CONTEXT documents per pane (transient — NOT persisted).
  // paneId → list of unified-store relpaths to inject as background context at
  // launch (#326). TerminalView reads + composes their content onto the startup
  // prompt. Distinct from the startup prompt itself (paneStartupPromptDocs).
  paneReferenceDocs: Record<string, string[]>;
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

  // GitHub
  githubConnected: boolean;
  githubToken: string;
  // Repo-scoped GitHub credentials (#158): per-`owner/name` fine-grained token. When
  // set, a request targeting that repo uses it instead of the global PAT, so a session
  // can't act on other repos via the proxy. Persisted (Tauri store), never logged.
  repoGithubTokens: Record<string, string>;
  setRepoGithubToken: (repo: string, token: string | null) => void;
  githubUser: GithubUser | null;
  githubRepos: GithubRepo[];
  activeRepoName: string;
  githubPageMode: "summary" | "projects" | "repos";
  setGithubPageMode: (v: "summary" | "projects" | "repos") => void;
  setGithubToken: (token: string) => void;
  setGithubUser: (user: GithubUser | null) => void;
  setGithubRepos: (repos: GithubRepo[]) => void;
  setActiveRepo: (name: string) => void;
  setGithubConnected: (connected: boolean) => void;
  disconnectGithub: () => void;
  markGithubTokenInvalid: () => void;

  // Automations
  automationsTab: "schedules" | "history";
  setAutomationsTab: (tab: AppStore["automationsTab"]) => void;
  /** Persisted, user-arranged tab order per page (keyed by page id). A page opens
   *  whatever tab the user dragged to the front, so the order IS the preference
   *  (#463). Unknown/new tabs append; stale ids are ignored. */
  pageTabOrder: Record<string, string[]>;
  setPageTabOrder: (page: string, order: string[]) => void;
  /** Console tab ids currently shown in their own window (#430). Session-only
   *  (NOT persisted): hidden from this window's tab bar while detached, cleared
   *  on re-dock or app restart — so the tab returns to its persisted place. */
  detachedTabIds: string[];
  setTabDetached: (id: string, detached: boolean) => void;
  /** Per-page section ids currently shown in their own window (#430). Session-only
   *  (NOT persisted), like detachedTabIds — hidden from the page's tab bar while
   *  detached, returned on re-dock/restart to their persisted place. */
  detachedSections: Record<string, string[]>;
  setSectionDetached: (page: string, id: string, detached: boolean) => void;

  // Settings
  settingsSection: string;
  setSettingsSection: (section: string) => void;

  // Performance monitoring (#569)
  perfConfig: PerfConfig;
  setPerfConfig: (config: PerfConfig) => void;

  // Mobile tunnel (#243). The relay Worker URL is persisted (the user's BYO relay);
  // `tunnelRunning` mirrors the Rust client's connected state (transient — NOT
  // persisted) so ConsoleScreen knows whether to push live pane metadata.
  tunnelRelayUrl: string;
  setTunnelRelayUrl: (url: string) => void;
  tunnelRunning: boolean;
  setTunnelRunning: (v: boolean) => void;
  /** Ad-hoc panes (e.g. the active planner pane) mirrored over the relay alongside the
   *  Console panes (#801). Transient — not persisted. */
  tunnelExtraPanes: PaneDescriptor[];
  setTunnelExtraPanes: (panes: PaneDescriptor[]) => void;

  // Knowledge Store
  kbBlocks: KbBlock[];
  claudeApiKey: string;
  setClaudeApiKey: (key: string) => void;

  // Automations
  schedules: Schedule[];
  addSchedule: () => void;
  updateSchedule: (id: string, patch: Partial<Schedule>) => void;
  removeSchedule: (id: string) => void;
  commands: Command[];
  addCommand: () => void;
  updateCommand: (id: string, patch: Partial<Command>) => void;
  removeCommand: (id: string) => void;

  // Scheduled automations (#142) — the real, fired-on-a-tick model (a frontend
  // scheduler ticks and dispatches via pty_write). Distinct from the legacy
  // `schedules`/`commands` above, which are planner-suggested and read by Planning.
  automations: Automation[];
  addAutomation: (input: Omit<Automation, "id" | "lastRunAt" | "nextRunAt" | "runs">) => void;
  updateAutomation: (id: string, patch: Partial<Automation>) => void;
  removeAutomation: (id: string) => void;
  setAutomationArmed: (id: string, armed: boolean) => void;
  recordAutomationRun: (id: string, run: AutomationRun) => void;

  // Projects (transient)
  projectsPageMode: "projects" | "fleet" | "blueprints" | "dataModels";
  setProjectsPageMode: (v: "projects" | "fleet" | "blueprints" | "dataModels") => void;
  // The Projects page is list ↔ planning (#499): the board moved to the GitHub
  // page (#498) and the execution tabs were removed.
  projectsView: "list" | "planning";
  setProjectsView: (v: "list" | "planning") => void;
  activeProjectId: string | null;
  activeProjectName: string;
  activeProjectRepo: string;
  activeProjectRepos: string[];
  activeProjectNumber: number;
  setActiveProject: (id: string | null) => void;
  setActiveProjectMeta: (id: string | null, name: string, repo: string, number: number, repos?: string[]) => void;
  setActiveProjectRepos: (repos: string[]) => void;
  // Purge a project's local footprint from the store: the per-project plan/config
  // maps and repo-scoped (`<key>::<repo>`) maps for every key in `keys` (pass the
  // planning session key — the title — and the GitHub id), plus the active-project
  // meta if it matches. Pairs with the backend delete_project_dir for the on-disk hub.
  deleteLocalProject: (keys: string[]) => void;
  /** New, not-yet-published projects (drafts, #379). Keyed by the planning session key
   *  (a unique `sanitize(title)-<id>` so a re-used title never inherits stale files). */
  localDraftProjects: Record<string, { title: string; pitch: string; createdAt: number }>;
  addDraftProject: (key: string, draft: { title: string; pitch: string; createdAt: number }) => void;
  removeDraftProject: (key: string) => void;
  // Dev reset: clears all project/plan-scoped state (keeps auth, profiles, UI).
  resetProjectData: () => void;
  // GitHub project ids the user removed in-app (persisted). The Projects list is
  // re-fetched from GitHub on every sync, so without this a deleted-but-still-
  // returned project (closed, delete denied, or stale) would reappear. The list
  // is filtered against this set so removal sticks.
  hiddenProjectIds: string[];
  dismissProject: (id: string) => void;
  // Startup-prompt assignment (persisted). Values are unified-store document
  // relpaths, or null = inherit. Resolution: repo → project → global default →
  // built-in. See lib/startupPrompt.ts.
  defaultStartupPromptDoc: string | null;
  setDefaultStartupPromptDoc: (doc: string | null) => void;
  projectStartupPromptDoc: Record<string, string | null>;
  setProjectStartupPromptDoc: (projectId: string, doc: string | null) => void;
  repoStartupPromptDoc: Record<string, string | null>;
  setRepoStartupPromptDoc: (projectId: string, repo: string, doc: string | null) => void;
  // Reference-context assignment (persisted) — the SECOND assignment field from
  // lib/assignments.ts, distinct from the startup prompt above. These are the
  // documents injected as background context for a session. Unlike the startup
  // prompt (one doc, override cascade), reference context ACCUMULATES across the
  // default → project → repo levels. Stored as plain add-lists of relpaths; the
  // launch resolver (#326) lifts them into the assignments-module cascade.
  refContextDefault: string[];
  refContextProject: Record<string, string[]>;            // keyed by projectId
  refContextRepo: Record<string, string[]>;               // keyed by repoPromptKey
  /** Toggle a document into/out of the reference-context set at one scope.
   *  level "default" ignores the key; "project" keys by projectId; "repo" by
   *  repoPromptKey(projectId, repo). */
  toggleReferenceContext: (level: "default" | "project" | "repo", key: string | null, doc: string) => void;
  // Per-repo TRIAGE starting script (persisted). relpath of a unified-store doc,
  // or null. Used by triageStartProject for that repo's triage pane; falls back
  // to the verbatim TRIAGE_PROMPT when unset. Keyed by repoPromptKey.
  repoTriagePromptDoc: Record<string, string | null>;
  setRepoTriagePromptDoc: (projectId: string, repo: string, doc: string | null) => void;
  // When set, the Knowledge Base screen shows only this project's documents
  // (its `keys` are the candidate folder keys — title- and id-derived). Set when
  // navigating from a project's "documents" button. Transient — NOT persisted.
  // The GitHub page's active top tab (summary | projects | repos), store-controlled
  // so other screens can deep-link to it (e.g. the Projects list signpost → projects).
  githubTab: string;
  setGithubTab: (t: string) => void;
  // The GitHub Projects v2 board now lives on the GitHub page (#498). When a project
  // is opened from the GitHub portfolio, this flips on and its board renders there
  // with `githubBoardTab` selecting the sub-view. Session-only (not persisted).
  githubBoardOpen: boolean;
  githubBoardTab: "board" | "roadmap" | "issues" | "insights";
  /** Open the GitHub-page board for the active project at a given sub-tab. */
  openGithubBoard: (tab?: "board" | "roadmap" | "issues" | "insights") => void;
  setGithubBoardTab: (t: "board" | "roadmap" | "issues" | "insights") => void;
  closeGithubBoard: () => void;
  projectsDrawerIssue: number | null;
  setProjectsDrawerIssue: (n: number | null) => void;
  planningPitch: string;
  planningRepo: string;
  planningTitle: string;
  setPlanningContext: (pitch: string, repo: string) => void;
  setPlanningTitle: (title: string) => void;
  // Stable per-session key for the planning directory, PTY slot, and plan
  // buckets. Frozen the moment a planning session begins so that neither the
  // publish flow assigning a GitHub Project id, nor the user editing the title,
  // can move the working directory out from under an active session.
  planningSessionKey: string;
  setPlanningSession: (key: string) => void;
  /** A prompt queued for the live planner session of a project, keyed by project key.
   *  Planning.tsx writes it into the planner PTY (a deliberate, user-triggered inject —
   *  e.g. the file-intake "Route" action) and clears it. (#604) */
  pendingPlannerPrompt: Record<string, string>;
  requestPlannerPrompt: (projectKey: string, text: string) => void;
  clearPlannerPrompt: (projectKey: string) => void;
  // Links a GitHub Project node id to the stable folder/data key (the title
  // slug the plan files were written under). A project opened from the board
  // only sets `activeProjectId` (the node id); this lets the planning resolver
  // find where the plan data actually lives instead of falling through to the
  // node id and rendering an empty pane. First-write-wins (see setActiveProjectMeta).
  projectKeyAlias: Record<string, string>;
  setProjectKeyAlias: (nodeId: string, key: string) => void;
  // project key -> structure node id -> linked GitHub issue (#393).
  issueLinks: Record<string, Record<string, { number: number; url: string }>>;
  // Merge links for a project (idempotent upsert; never drops existing entries).
  setIssueLinks: (projectKey: string, links: Record<string, { number: number; url: string }>) => void;
  // Repository resolution — base dir is `~/.base-studio-code` (the base); repo
  // clone paths are derived as `<base>/projects/<key>/<repo>`.
  bscBaseDir: string;
  setBscBaseDir: (dir: string) => void;
  projectLocalRepos: Record<string, string[]>;
  addProjectRepo: (projectId: string, fullName: string) => void;
  triageStartProject: (projectName: string, repos: string[], projectId?: string) => void;
  // Index of this project's triage tab, matched on its STABLE projectKey (#457) — not
  // the derived "· triage" name — so a rename never forks a duplicate. Pass the same
  // (projectName, projectId) used to launch it. -1 when none.
  findTriageTabIdx: (projectName: string, projectId?: string) => number;
  // Launch the agent fleet: a "· build" tab with the director (if enabled) at the
  // project root and one worker pane per launched stream in its repo clone. Path
  // keys off projectKey (the planning session key — where repos/prompts live).
  /** Launches the fleet; returns the fleet roster rows (paneId/stream/repo/branch/role TSV,
   *  one per live session) for the caller to persist via publishFleetRoster (#734). */
  fleetStartProject: (
    projectName: string,
    fleet: FleetPlan,
    projectKey: string,
    /** Authoritative absolute cwds from the Rust backend (#905): the hub dir
     *  (`project_dir_path`) for the director and each stream's worktree path
     *  (`ensure_worktree`) for its worker. Used verbatim so the launch never
     *  depends on the async-loaded `bscBaseDir` mirror; falls back to the
     *  `bscBaseDir`-derived path per pane when an entry is absent. */
    paths?: { hubPath?: string; worktreePaths?: Record<string, string> },
  ) => string[];
  // Index of this project's primary "· build" tab, matched on its STABLE projectKey
  // (#457) — pass the same projectKey used to launch the fleet. -1 when none.
  findFleetTabIdx: (projectKey: string) => number;
  // Coordination (#199 AC#7): paneId ("t{tab}p{pane}") → the AgentStream launched into
  // it. The coordination log keys waiters/producers by PANE id (BSC_AUDIT_PANE), but a
  // stream's produced contracts/issues/owned globs live on the stream by its slug. This
  // map bridges the two so the inbox can build a producer resolver (buildProducerOf) and
  // light up file/issue wait-for cycles. Written at fleet launch, persisted, global
  // (pane ids are unique across all tabs). Only worker panes are recorded.
  fleetPaneStreams: Record<string, AgentStream>;

  // Claude config profiles (persisted)
  configProfiles: ConfigProfile[];
  addConfigProfile: (profile: Omit<ConfigProfile, "id">) => void;
  updateConfigProfile: (id: string, patch: Partial<Omit<ConfigProfile, "id">>) => void;
  removeConfigProfile: (id: string) => void;

  // Plan session data — persisted per project so navigation away doesn't lose state.
  planSections:    Record<string, Record<string, string>>;
  setPlanSection:  (projectId: string, key: string, content: string) => void;
  planConfirmedSections: Record<string, string[]>;
  confirmPlanSection:   (projectId: string, key: string) => void;
  unconfirmPlanSection: (projectId: string, key: string) => void;
  /** The in-progress blueprint an AUTHORING project (#923) is designing — emitted by the planner's
   *  <blueprint> tag, rendered in the focused pane, and published to a gist at the Review stage. */
  planAuthoredBlueprint: Record<string, Blueprint>;
  setAuthoredBlueprint: (projectId: string, bp: Blueprint) => void;
  /** Per-project deployment & infrastructure config (#919) — edited by the planner's Deploy
   *  stage pane; the `deploymentDefined` gate signal derives from it. */
  planDeployConfig: Record<string, DeployConfig>;
  setPlanDeployConfig: (projectId: string, cfg: DeployConfig) => void;
  /** Optional stages the user deliberately SKIPPED (#921). The flow stops on every optional stage;
   *  skipping marks it resolved (frontier advances, never blocks completion) but renders distinctly. */
  planSkippedSections:  Record<string, string[]>;
  skipPlanSection:      (projectId: string, key: string) => void;
  unskipPlanSection:    (projectId: string, key: string) => void;
  /** Collapse non-canonical section keys (e.g. "Tech stack" → "stack") for a project,
   *  merging content into the canonical key (and deduping confirmed keys) — repairs a gate
   *  stuck on a stale title-named section (#803). */
  canonicalizePlanSections: (projectId: string) => void;
  planKbAssignments:    Record<string, string[]>;
  addPlanKbAssignment:  (projectId: string, blockId: string) => void;
  removePlanKbAssignment: (projectId: string, blockId: string) => void;
  planAutomations:    Record<string, AutomationSuggestion[]>;
  addPlanAutomation:  (projectId: string, a: AutomationSuggestion) => void;
  clearPlanAutomations: (projectId: string) => void;
  // Modular planning stages (#512): per-project on/off + ordering of the planning
  // stages. Defaults (all-on, registry order) are resolved lazily via
  // defaultStageConfig, so an unset project behaves exactly as today.
  planStageConfig:    Record<string, StageConfig>;
  setStageEnabled:    (projectId: string, stageId: StageId, enabled: boolean) => void;
  reorderStages:      (projectId: string, order: StageId[]) => void;
  /** Wholesale-set a project's stage config (used to seed it from a blueprint). */
  setProjectStageConfig: (projectId: string, config: StageConfig) => void;
  // Blueprints (#513/#514): named, reusable configs — an ordered list of planning
  // sections, each owning its prompt module + pipelines. The active one seeds new
  // projects. Seeded with the starter library; persisted. Section/pipeline edits go
  // through setBlueprintSections (the component computes the new sections array).
  blueprints:         Blueprint[];
  activeBlueprintId:  string;
  setActiveBlueprint: (id: string) => void;
  // Canonical Data Models (#780) — the schema library the data blueprints map into and
  // the build side later generates over. Seeded with a starter CRM model; persisted.
  dataModels:         DataModel[];
  activeDataModelId:  string;
  setActiveDataModel: (id: string) => void;
  /** Add a new empty Data Model; returns its id. */
  addDataModel:       () => string;
  /** Replace a model wholesale (the editor computes the next model from the pure transforms). */
  setDataModel:       (id: string, model: DataModel) => void;
  /** Delete a model; if it was active, the active id falls back to the first remaining. */
  removeDataModel:    (id: string) => void;
  /** Per-project, per-entity load verification (#ls-reconcile-ui).
   *  projectKey → entityKey → verified. A verified load has passed the quality gate and
   *  is ready for cutover; persisted so it survives app restarts. */
  loadVerified:       Record<string, Record<string, boolean>>;
  setLoadVerified:    (projectKey: string, entity: string, verified: boolean) => void;
  // Which blueprint each project was last seeded/reset from (#647), keyed by project key.
  // Lets the planner detect when the selected blueprint differs from the project's and
  // offer to reset. Set on first seed + on an explicit blueprint switch.
  projectBlueprintId: Record<string, string>;
  setProjectBlueprintId: (projectId: string, blueprintId: string) => void;
  /** Re-seed a project's plan from a blueprint and CLEAR its progress (grades, screen
   *  approvals, preview, pipeline runs) — the destructive "reset plan to blueprint" (#647).
   *  The planner restarts the session separately. No-op if the blueprint is unknown. */
  applyBlueprintToProject: (projectId: string, blueprintId: string) => void;
  addBlueprint:       () => string;
  duplicateBlueprint: (id: string) => string;
  updateBlueprintMeta: (id: string, patch: Partial<Omit<Blueprint, "id" | "sections">>) => void;
  setBlueprintSections: (id: string, sections: BlueprintSection[]) => void;
  /** Delete a blueprint; if it was active, the active id falls back to the first
   *  remaining (or the default). */
  removeBlueprint: (id: string) => void;
  /** Add an imported blueprint under a fresh id + fresh section uids (never overwrites
   *  an existing one). Returns the new id. */
  importBlueprint: (bp: Blueprint) => string;
  // Stage-pipeline run state (#528/#529): per-project, per-pipeline run status, keyed
  // projectKey -> pipelineUid -> state. Distinct from the fleet conductor's
  // `workflowRuns` (#220). Session-only (not persisted).
  stagePipelineRuns: Record<string, Record<string, PipelineRunState>>;
  setStagePipelineRun: (projectKey: string, pipelineUid: string, state: PipelineRunState) => void;
  // The current UI preview per project (#531): the render-preview pipeline writes the
  // bundled iframe srcdoc here; PlanPreviewPane renders it. `screen` names which screen
  // is showing (#546), so its approve button targets the right one. Session-only.
  stagePreview: Record<string, { srcDoc: string; mode: "2d" | "3d"; screen?: string } | null>;
  setStagePreview: (projectKey: string, value: { srcDoc: string; mode: "2d" | "3d"; screen?: string } | null) => void;
  // Per-section grades (#615): project → section key → one GradeResult per grader id.
  // A section can carry MULTIPLE graders; setSectionGrade upserts by graderId. The
  // report-card pipeline screen renders these. Session-only.
  sectionGrades: Record<string, Record<string, GradeResult[]>>;
  setSectionGrade: (projectKey: string, sectionKey: string, result: GradeResult) => void;
  // Per-screen UI approval (#544/#546). `uiScreens` is the set of screens the planner
  // has declared via <ui_preview> tags (the denominator); `uiApproved` is the names the
  // user has signed off in the preview pane (the numerator). The UI stage completes only
  // when every declared screen is approved. Both persisted — real approval signals.
  uiScreens: Record<string, string[]>;
  addUiScreen: (projectKey: string, screen: string) => void;
  uiApproved: Record<string, string[]>;
  setUiScreenApproved: (projectKey: string, screen: string, approved: boolean) => void;
  // Agent fleet — the parallel-execution plan (work streams + optional director +
  // the optimal concurrent session count). Persisted per project.
  planFleet:             Record<string, FleetPlan>;
  setPlanFleet:          (projectId: string, fleet: FleetPlan) => void;       // wholesale (from fleet.json poll)
  /** Per-project set of context-file names pinned in the project pane (overrides the
   *  confirmed-section default). projectId -> pinned file names. */
  pinnedContext:         Record<string, string[]>;
  togglePinnedContext:   (projectId: string, name: string) => void;
  addPlanAgentStream:    (projectId: string, stream: AgentStream) => void;    // merge-by-id (from inline tag)
  removePlanAgentStream: (projectId: string, id: string) => void;
  /** #289: assign an AgentProfile id to a stream (null clears). */
  setPlanAgentStreamProfile: (projectId: string, streamId: string, profileId: string | null) => void;
  /** #297: set one or more flow fields on a stream (merged into its resolved flow). */
  setPlanAgentStreamFlow: (projectId: string, streamId: string, patch: Partial<AgentFlow>) => void;
  /** #378: set a stream's per-stream integration-strategy override (undefined clears
   *  it so the stream inherits the fleet default). */
  setPlanAgentStreamStrategy: (projectId: string, streamId: string, strategy: IntegrationStrategy | undefined) => void;
  /** Set a stream's per-capability permission posture from the project pane's agent
   *  editor; also marks the stream's preset as "custom" (a hand-tuned posture). */
  setPlanAgentStreamPerm: (projectId: string, streamId: string, perm: Record<string, "allow" | "ask" | "deny">) => void;
  /** Apply a named permission preset to a stream from the project pane: sets both
   *  the preset name and the full per-capability posture it implies. */
  setPlanAgentStreamPreset: (projectId: string, streamId: string, preset: string, perm: Record<string, "allow" | "ask" | "deny">) => void;
  /** #289: generate + assign a least-privilege profile for each unassigned stream,
   *  scoped to that stream's resolved toolchain. Idempotent. */
  generateFleetProfiles: (projectId: string) => void;
  setPlanFleetMeta:      (projectId: string, recommended: number, reasoning: string, strategy?: IntegrationStrategy) => void;
  /** Per-project coordination-topology override (#…), set in the Permissions pane. Wins
   *  over the planner's fleet.json topology and survives a fleet re-poll. */
  planFleetTopology:     Record<string, Topology>;
  setPlanFleetTopology:  (projectId: string, topology: Topology) => void;
  /** Per-project director-drive override (#…), set in the Permissions pane alongside the
   *  topology. Wins over fleet.json's `director.drive` and survives a fleet re-poll. */
  planFleetDirectorDrive:    Record<string, DirectorDrive>;
  setPlanFleetDirectorDrive: (projectId: string, drive: DirectorDrive) => void;
  setPlanDirector:       (projectId: string, enabled: boolean, role?: string) => void;
  setPlanDirectorDrive:  (projectId: string, drive: DirectorDrive) => void;
  clearPlanFleet:        (projectId: string) => void;
  clearPlan:             (key: string) => void;

  // MCP servers the user configures, each scoped via its `projects` ([] = global).
  // Written into a launched session's .mcp.json so the agent actually gets them. Persisted.
  mcpServers: McpServer[];
  addMcpServer:          (def: Omit<McpServer, "id">) => void;
  updateMcpServer:       (id: string, patch: Partial<McpServer>) => void;
  removeMcpServer:       (id: string) => void;
  toggleMcpServer:       (id: string) => void;
  setMcpServerProjects:  (id: string, projects: string[]) => void;
  // Lifecycle hooks the user configures, each scoped via its `projects` ([] = global).
  // Written into a launched session's .claude/settings.json so the agent gets them. Persisted.
  hooks: Hook[];
  addHook:          (def: Omit<Hook, "id">) => void;
  updateHook:       (id: string, patch: Partial<Hook>) => void;
  removeHook:       (id: string) => void;
  toggleHook:       (id: string) => void;
  setHookProjects:  (id: string, projects: string[]) => void;
  // Resolved per-pane servers + hooks (transient): set at session creation, read by
  // TerminalView before launch (mirrors paneAllowedCommands).
  paneMcpServers: Record<string, McpServer[]>;
  paneHooks: Record<string, Hook[]>;

  // Skills — reusable capability bundles (prompt + bundled tools + profile
  // guardrails) the fleet can invoke, each scoped via its `projects` ([] = global).
  // Written into a launched session's .claude/skills/<slug>/SKILL.md so agents
  // actually get them. Seeded from the sample library; persisted. (#404)
  skills: SkillDef[];
  /** Reconstitute a shared blueprint's embedded skills/KB into the libraries (#897 Phase 5b),
   *  upserting by id (skip an id already present) so the blueprint's refs resolve. */
  installBundledSkills: (payloads: SkillPayload[]) => void;
  addSkill:        (def: Omit<SkillDef, "id">) => string;
  updateSkill:     (id: string, patch: Partial<SkillDef>) => void;
  removeSkill:     (id: string) => void;
  toggleSkill:     (id: string) => void;
  toggleSkillPin:  (id: string) => void;
  setSkillProjects: (id: string, projects: string[]) => void;
  /** Upsert planner-authored skills (from skills.json) into the global library,
   *  keyed by id then by name-slug, so re-emitted definitions refine in place
   *  rather than duplicating. */
  upsertSkills:    (defs: Array<Omit<SkillDef, "id"> & { id?: string }>) => void;
  // Resolved per-pane skills (transient): set at session creation, read by
  // TerminalView before launch (mirrors paneExtensions).
  paneSkills: Record<string, SkillDef[]>;

  // Agent settings — the GLOBAL allowed-command tier (auto-approved in every
  // session). Per-project / per-repo tiers below combine additively with it.
  allowedCommands: string[];
  addAllowedCommand: (cmd: string) => void;
  removeAllowedCommand: (cmd: string) => void;
  setAllowedCommands: (commands: string[]) => void;

  // Per-project / per-repo allowed-command lists, configured during planning and
  // combined additively with the global list (see resolveAllowedCommands). gh/git
  // are always added by the backend, so they need not be listed here.
  projectAllowedCommands: Record<string, string[]>;
  addProjectAllowedCommand: (projectId: string, cmd: string) => void;
  removeProjectAllowedCommand: (projectId: string, cmd: string) => void;
  repoAllowedCommands: Record<string, string[]>;
  addRepoAllowedCommand: (projectId: string, repo: string, cmd: string) => void;
  removeRepoAllowedCommand: (projectId: string, repo: string, cmd: string) => void;
  // Resolved per-pane allowlist (transient): set when a project/triage tab is
  // created; TerminalView passes it to ensure_session_settings before launch.
  paneAllowedCommands: Record<string, string[]>;

  // Blocked shell commands. Sessions allow Bash broadly (start-and-go); the
  // backend always denies a curated dangerous set, and these are the user's
  // additional global denies (edited in Knowledge Base → Commands). Deny wins
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
  /** #199: auto-relaunch a parked pane when its deps land (opt-in; off by default). */
  coordAutoWake: boolean;
  setCoordAutoWake: (v: boolean) => void;
  setAutoResumeClaude: (v: boolean) => void;
  /** #682: let Claude auto-drive the planning phase from a pitch (opt-in; off by default).
   *  Enables the "Auto-plan" control on the planner page. */
  autoPlanWithClaude: boolean;
  setAutoPlanWithClaude: (v: boolean) => void;
  /** #738 (security): restrict agents that pull live GitHub issues (triage) to issues
   *  base-studio-code authored — the `bsc-generated` label. ON by default so a hand-created
   *  or injected issue isn't acted on; off works every open issue. */
  restrictToBscIssues: boolean;
  setRestrictToBscIssues: (v: boolean) => void;
  /** Default Claude model new console panes open with (persisted; configured in
   *  Settings → General). Per-pane override lives in the pane hamburger menu. */
  defaultModel: ModelId;
  setDefaultModel: (m: ModelId) => void;
  /** Per-pane model override, keyed by paneId. A pane with no entry falls back to
   *  {@link defaultModel}. Applied to `claude --model` at the pane's next launch. */
  paneModels: Record<string, ModelId>;
  setPaneModel: (paneId: string, m: ModelId) => void;
}
