import { create } from "zustand";
import { unlock } from "../lib/achievements";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Screen } from "../components/chrome/Rail";
import type { Tab } from "../components/chrome/Tabstrip";
import type { ViewKey } from "../components/pane/ViewTabs";
import type { KbBlock, Schedule, Command } from "../data/mock";
import { persistStorage } from "../lib/storage";
import { clampFontSize, DEFAULT_TERMINAL_FONT_SIZE } from "../lib/terminal";
import { enqueue as enqueueFocusQueue, removeFromQueue, nextInCycle, reconcileQueue, type QueuedPane } from "../lib/focusQueue";
import { resolveStartupPromptDoc, repoPromptKey } from "./../lib/startupPrompt";
import { projectRepoCwd, projectHubCwd, agentWorktreeCwd, sanitizeProjectKey } from "../lib/projectPaths";
import { checkpointDocRelpath, agentCheckpointDocRelpath } from "../lib/checkpoint";
import { computeNextRun, appendRun, suggestionToAutomation, type Automation, type AutomationRun } from "../lib/scheduler";
import { resolveAllowedCommands } from "../lib/allowedCommands";
import type { SessionRole } from "../lib/sessionRoles";
import type { AgentFlow } from "../screens/projects/agentFlow";
import { normalizeFlow, resolveFlow } from "../screens/projects/agentFlow";
import { flowKickoffText } from "../screens/projects/flowKickoff";
import { PIPELINE_PRESETS } from "../lib/pipeline";
import { startRun, currentLaunch, type PipelineRun } from "../lib/conductor";
import { generateAgentProfile } from "../lib/profileGen";
import { stagePrompt } from "../lib/pipelineDriver";
import type { AgentProfile } from "../screens/agents/agentProfiles";
import { PROFILES } from "../screens/agents/agentProfiles";
import { scriptDocRelpath } from "../screens/projects/planningSession";
import { emptyFleet, type FleetPlan, type AgentStream } from "../screens/projects/planSections";
import { type IntegrationStrategy, type DirectorMode, DEFAULT_STRATEGY, strategySettings, resolveStrategy } from "../screens/projects/integrationStrategy";
import { type DirectorDrive, resolveDirectorDrive } from "../screens/projects/directorDrive";
import { worktreeSlug } from "../lib/projectPaths";
import { resolveExtensions, type ExtensionDef } from "../lib/extensions";
import { resolveSkills, seedSkills, type SkillDef } from "../lib/skills";

// Sent as the first message to each console when a project tab is opened, so the
// session starts by reading and executing the laid-out plan. Plain text only — no
// double quotes / $ / backticks — so it's safe to pass as `claude "<prompt>"`.
export const PROJECT_INIT_PROMPT =
  "You are starting work in this repository as part of a planned project. The full " +
  "project plan is in CLAUDE.local.md — goal, scope, stack, architecture, schema, api, " +
  "testing, ci/cd, phases, and risks. Read it first, then begin executing the plan for " +
  "this repo: identify the current phase and its in-scope work, lay out the first concrete " +
  "steps, and get started. Keep everything aligned with the plan's goal, architecture, " +
  "stack, and conventions, and check in before deviating from it.";

// Sent verbatim as the first message to each triage console. Drives an issue
// triage pass over the pane's repo. Plain text only (no double quotes / $ /
// backticks) so it is safe to type into the PTY as a single line.
export const TRIAGE_PROMPT =
  "You are triaging the open issues in this repository. Use the gh CLI (GH_TOKEN is " +
  "preloaded). Run gh issue list --state open --limit 100 to fetch every open issue. " +
  "For each issue, assess severity and assign a priority label from P0 to P3: " +
  "P0 = critical or production-breaking, fix immediately; P1 = high, important and " +
  "time-sensitive; P2 = medium, should be addressed soon; P3 = low, nice to have. " +
  "Apply the matching priority label with gh issue edit <number> --add-label P0|P1|P2|P3 " +
  "(create the label first with gh label create if it does not exist). Finally, flag any " +
  "P3 issue with no activity in the last 90 days as stale by adding a stale label, and " +
  "summarize the triage results grouped by priority when done. " +
  "When you finish this pass, save where you left off for next time: pipe a short " +
  "plain-text summary (what you completed, what is in progress, and the single next " +
  "step to take) into the bsc-checkpoint command on stdin. The next triage pass for " +
  "this repo will begin with that summary.";

// Fallback first message for a fleet worker whose stream has no planner-authored
// kickoff script. Plain text only (no double quotes / $ / backticks) so it is safe
// to pass as claude's initial-message arg. The authoritative plan lives in
// CLAUDE.local.md; this points the session at its lane and the autonomy rules.
function buildStreamPrompt(stream: AgentStream, strategy?: IntegrationStrategy): string {
  const owns   = stream.owns.length   ? stream.owns.join(", ")   : "the files for your area";
  const issues = stream.issues.length ? stream.issues.join(", ") : "the issues assigned to your area";
  const strat = strategy ?? DEFAULT_STRATEGY;
  const effPush = strategySettings(strat).integrate;
  const effFlow = { ...resolveFlow(stream.flow), push: stream.flow?.push ?? effPush };
  const kick = flowKickoffText(effFlow, stream.id);
  return (
    `You are the ${stream.name} work stream, one of several Claude sessions building this project in parallel. ` +
    `The full project plan is in CLAUDE.local.md — read it first; it is authoritative. ` +
    `You are working in your own git worktree on branch ${stream.id}; do not switch branches or touch other worktrees. ` +
    `Your lane: you own ${owns}. Do not modify files outside your owned paths — another session owns them; ` +
    `coordinate through the plan instead. Your issues: ${issues}. ` +
    `${kick.autonomy} ` +
    `${kick.push} ` +
    `When you pause or finish a work session, pipe a short note of where you left off and the next step into bsc-checkpoint on stdin so your next session resumes there. ` +
    `Verify your work against the repo tests and CI rather than asking whether it is correct.`
  );
}

export interface GithubUser {
  login: string;
  name: string | null;
  avatar_url: string;
}

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

interface AppStore {
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
  /** Wake a parked pane (#199): seed it with `prompt` as a FRESH claude session and
   *  remount its tab (runId bump). Returns false if the pane/tab is gone or disabled.
   *  The caller `pty_kill`s the pane first so the remount spawns fresh, not reconnect. */
  wakePane: (paneId: string, prompt: string) => boolean;
  // Session pipelines (#220): in-flight runs keyed by work item. Register-only here;
  // launching a stage as a role-scoped pane + auto-advance is the live-wiring slice.
  pipelineRuns: Record<string, PipelineRun>;
  pipelineStart: (presetKey: string, item: string) => void;
  pipelineClear: (item: string) => void;
  pipelineMount: (item: string) => void;
  pipelineSetRuns: (runs: Record<string, PipelineRun>) => void;
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
  paneViews: ViewKey[];
  paneNames: Record<number, Record<number, string>>;
  paneCwds: Record<string, string>;  // keyed by "t{tabIdx}p{paneIdx}"
  setPaneCwd: (paneId: string, cwd: string) => void;
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
  setPaneProfile: (paneId: string, profileId: string | null) => void;
  setActiveTab: (idx: number) => void;
  addTab: (tab: Tab) => void;
  closeTab: (idx: number) => void;
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
  githubPageMode: "summary" | "repos";
  setGithubPageMode: (v: "summary" | "repos") => void;
  githubActiveTab: "overview" | "actions";
  setGithubTab: (tab: AppStore["githubActiveTab"]) => void;
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

  // Settings
  settingsSection: string;
  setSettingsSection: (section: string) => void;

  // Mobile tunnel (#243). The relay Worker URL is persisted (the user's BYO relay);
  // `tunnelRunning` mirrors the Rust client's connected state (transient — NOT
  // persisted) so ConsoleScreen knows whether to push live pane metadata.
  tunnelRelayUrl: string;
  setTunnelRelayUrl: (url: string) => void;
  tunnelRunning: boolean;
  setTunnelRunning: (v: boolean) => void;

  // Knowledge Store
  kbBlocks: KbBlock[];
  claudeApiKey: string;
  setClaudeApiKey: (key: string) => void;
  applyKbTag: (blockId: string, tag: string) => void;
  removeKbTag: (blockId: string, tag: string) => void;
  renameKbBlock: (blockId: string, title: string) => void;
  updateKbBlockContent: (blockId: string, content: string) => void;
  addKbBlock: () => void;
  removeKbBlock: (blockId: string) => void;

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
  projectsPageMode: "summary" | "projects";
  setProjectsPageMode: (v: "summary" | "projects") => void;
  projectsView: "list" | "board" | "planning";
  setProjectsView: (v: "list" | "board" | "planning") => void;
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
  // Per-repo TRIAGE starting script (persisted). relpath of a unified-store doc,
  // or null. Used by triageStartProject for that repo's triage pane; falls back
  // to the verbatim TRIAGE_PROMPT when unset. Keyed by repoPromptKey.
  repoTriagePromptDoc: Record<string, string | null>;
  setRepoTriagePromptDoc: (projectId: string, repo: string, doc: string | null) => void;
  // When set, the Knowledge Base screen shows only this project's documents
  // (its `keys` are the candidate folder keys — title- and id-derived). Set when
  // navigating from a project's "documents" button. Transient — NOT persisted.
  kbProjectScope: { keys: string[]; label: string } | null;
  setKbProjectScope: (scope: { keys: string[]; label: string } | null) => void;
  projectsBoardTab: "board" | "roadmap" | "issues" | "insights" | "hooks" | "coordination" | "pipelines";
  setProjectsBoardTab: (t: "board" | "roadmap" | "issues" | "insights" | "hooks" | "coordination" | "pipelines") => void;
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
  findTriageTabIdx: (projectName: string) => number;
  // Launch the agent fleet: a "· build" tab with the director (if enabled) at the
  // project root and one worker pane per launched stream in its repo clone. Path
  // keys off projectKey (the planning session key — where repos/prompts live).
  fleetStartProject: (projectName: string, fleet: FleetPlan, projectKey: string) => void;
  findFleetTabIdx: (projectName: string) => number;
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
  planKbAssignments:    Record<string, string[]>;
  addPlanKbAssignment:  (projectId: string, blockId: string) => void;
  removePlanKbAssignment: (projectId: string, blockId: string) => void;
  planAutomations:    Record<string, AutomationSuggestion[]>;
  addPlanAutomation:  (projectId: string, a: AutomationSuggestion) => void;
  clearPlanAutomations: (projectId: string) => void;
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
  setPlanDirector:       (projectId: string, enabled: boolean, role?: string) => void;
  setPlanDirectorDrive:  (projectId: string, drive: DirectorDrive) => void;
  clearPlanFleet:        (projectId: string) => void;

  // Extensions — MCP servers + hooks the user configures, each scoped via its
  // `projects` ([] = global). Written into a launched session's .mcp.json /
  // .claude/settings.json so the agent actually gets them. Persisted.
  extensions: ExtensionDef[];
  addExtension:          (def: Omit<ExtensionDef, "id">) => void;
  updateExtension:       (id: string, patch: Partial<ExtensionDef>) => void;
  removeExtension:       (id: string) => void;
  toggleExtension:       (id: string) => void;
  setExtensionProjects:  (id: string, projects: string[]) => void;
  // Resolved per-pane extensions (transient): set at session creation, read by
  // TerminalView before launch (mirrors paneAllowedCommands).
  paneExtensions: Record<string, ExtensionDef[]>;

  // Skills — reusable capability bundles (prompt + bundled tools + profile
  // guardrails) the fleet can invoke, each scoped via its `projects` ([] = global).
  // Written into a launched session's .claude/skills/<slug>/SKILL.md so agents
  // actually get them. Seeded from the sample library; persisted. (#404)
  skills: SkillDef[];
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
  // When a response is sent to the active console, cycle focus to the next pane
  // waiting in the focus queue (persisted; configured in Settings → Integrations).
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
}

// (Re)mount a pipeline run's pane for its CURRENT stage (#220): a single-pane
// `pipeline · <item>` tab whose pane is a fresh, role-scoped claude session seeded
// with the stage prompt. A runId bump remounts it; the caller pty_kills first on a
// relaunch so it spawns fresh. Terminal runs (done/escalated) just persist.
// #174: promote a project's planning-assigned automations into the real scheduler on
// launch. Idempotent (skips ones already present by name+command); scheduled (cron)
// suggestions arm, on-demand ones are saved unarmed. Each fires into `targetTab`.
function activateAutomations(s: AppStore, projectId: string, targetTab: string): Automation[] {
  const suggestions = projectId ? s.planAutomations[projectId] ?? [] : [];
  if (suggestions.length === 0) return [];
  const have = new Set(s.automations.map((a) => `${a.name} ${a.command ?? ""}`));
  const added: Automation[] = [];
  for (const sug of suggestions) {
    const k = `${sug.name} ${sug.command}`;
    if (have.has(k)) continue;
    have.add(k);
    const input = suggestionToAutomation(sug, targetTab);
    added.push({
      ...input,
      id: `auto_${Math.random().toString(36).slice(2, 8)}`,
      lastRunAt: null,
      nextRunAt: input.armed ? computeNextRun(input.when, Date.now()) : null,
      runs: [],
    });
  }
  return added;
}

function mountState(s: AppStore, item: string, run: PipelineRun) {
  const launch = currentLaunch(run);
  if (!launch) return { pipelineRuns: { ...s.pipelineRuns, [item]: run } };
  const tabName = `pipeline · ${item}`;
  const existingIdx = s.tabs.findIndex((tb) => tb.name === tabName);
  const tabIdx = existingIdx >= 0 ? existingIdx : s.tabs.length;
  const runId = existingIdx >= 0 ? (s.tabs[existingIdx].runId ?? 0) + 1 : 0;
  const key = `t${tabIdx}p0`;
  const cwd = s.activeProjectName ? projectHubCwd(s.bscBaseDir, s.activeProjectName) : "";
  const newTab: Tab = { name: tabName, layout: "1×1", state: "idle", runId };
  const tabs = existingIdx >= 0 ? s.tabs.map((tb, i) => (i === existingIdx ? newTab : tb)) : [...s.tabs, newTab];
  const disabledPanes = { ...s.disabledPanes };
  delete disabledPanes[key];
  return {
    tabs,
    activeTabIdx: tabIdx,
    activeScreen: "console" as Screen,
    focusedPaneIdx: -1,
    paneCwds: { ...s.paneCwds, [key]: cwd },
    paneInitCmds: { ...s.paneInitCmds, [key]: "claude" },
    paneStartupPromptText: { ...s.paneStartupPromptText, [key]: stagePrompt(launch, item) },
    paneContinue: { ...s.paneContinue, [key]: false },
    paneRoles: { ...s.paneRoles, [key]: launch.role },
    paneNames: { ...s.paneNames, [tabIdx]: { 0: launch.stage } },
    disabledPanes,
    pipelineRuns: { ...s.pipelineRuns, [item]: run },
  };
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      activeScreen: "console",
      setScreen: (screen) => set({ activeScreen: screen }),
      hasHydrated: false,
      setHasHydrated: (v) => set({ hasHydrated: v }),

      tabs: [],
      activeTabIdx: 0,
      paneMenuOpenIdx: -1,
      focusedPaneIdx: -1,
      fullscreenPaneIdx: -1,
      consoleBroadcast: false,
      setConsoleBroadcast: (v) => set({ consoleBroadcast: v }),
      focusQueue: [],
      enqueueFocus: (tab, pane) =>
        set((s) => ({ focusQueue: enqueueFocusQueue(s.focusQueue, { tab, pane }) })),
      removeFocus: (tab, pane) =>
        set((s) => ({ focusQueue: removeFromQueue(s.focusQueue, { tab, pane }) })),
      clearFocusQueue: () => set({ focusQueue: [] }),
      reconcileFocusQueue: (waitingByTab) =>
        set((s) => ({ focusQueue: reconcileQueue(s.focusQueue, waitingByTab) })),
      // Cycle to the next waiting pane relative to the one you're on (maximized
      // pane if maximized, else focused). Focuses it — switching to its tab first
      // when it lives on another tab — and swaps the maximized pane to it so you
      // stay full-screen. Does NOT dequeue: a pane leaves the queue only when you
      // respond to it (see Console.handleStatusChange).
      advanceFocus: () =>
        set((s) => {
          const pane = s.fullscreenPaneIdx >= 0 ? s.fullscreenPaneIdx : s.focusedPaneIdx;
          const next = nextInCycle(s.focusQueue, { tab: s.activeTabIdx, pane });
          if (next === null) return {};
          const maximized = s.fullscreenPaneIdx >= 0;
          if (next.tab !== s.activeTabIdx) {
            // Hop to the tab holding the waiting console, focusing (and re-maximizing) it.
            return {
              activeTabIdx: next.tab,
              focusedPaneIdx: next.pane,
              fullscreenPaneIdx: maximized ? next.pane : -1,
              paneMenuOpenIdx: -1,
            };
          }
          return maximized
            ? { focusedPaneIdx: next.pane, fullscreenPaneIdx: next.pane }
            : { focusedPaneIdx: next.pane };
        }),
      terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
      setTerminalFontSize: (size) => set({ terminalFontSize: clampFontSize(size) }),
      paneViews: [],
      paneNames: {},
      paneCwds: {},
      paneWasClaude: {},
  liveAgents: 0,
  bumpLiveAgents: (delta) => set((s) => ({ liveAgents: Math.max(0, s.liveAgents + delta) })),
      achievements: {},
      unlockAchievement: (id) => {
        const next = unlock(get().achievements, id, Date.now());
        if (!next) return false;            // already unlocked — once ever
        set({ achievements: next });
        return true;
      },
      setPaneWasClaude: (paneId, on) =>
        set((s) => {
          const cur = s.paneWasClaude[paneId];
          // Avoid producing a new object reference when nothing changed —
          // OSC 100 "run" can fire many times in a session.
          if (cur === on) return s;
          const next = { ...s.paneWasClaude };
          if (on) next[paneId] = true; else delete next[paneId];
          return { paneWasClaude: next };
        }),
      setPaneCwd: (paneId, cwd) =>
        set((s) => ({ paneCwds: { ...s.paneCwds, [paneId]: cwd } })),
      paneInitCmds: {},
      setPaneInitCmd: (paneId, cmd) =>
        set((s) => ({ paneInitCmds: { ...s.paneInitCmds, [paneId]: cmd } })),
      paneStartupPromptDocs: {},
      paneCheckpointDocs: {},
      paneStartupPromptText: {},
      paneContinue: {},
      disabledPanes: {},
      setPaneDisabled: (paneId, disabled) =>
        set((s) => {
          const next = { ...s.disabledPanes };
          if (disabled) next[paneId] = true; else delete next[paneId];
          return { disabledPanes: next };
        }),
      paneRoles: {},
    paneDirectorDrive: {},
    paneDirectorMode: {},
    paneStream: {},
      setPaneRole: (paneId, role) =>
        set((s) => ({ paneRoles: { ...s.paneRoles, [paneId]: role } })),

      // Agents (#255): seed the editable profiles from the built-in defaults; persisted
      // edits replace this on rehydrate. Deep-cloned so edits never mutate the defaults.
      agentProfiles: JSON.parse(JSON.stringify(PROFILES)) as AgentProfile[],
      setAgentProfiles: (profiles) => set({ agentProfiles: profiles }),
      updateAgentProfile: (id, patch) =>
        set((s) => ({
          agentProfiles: s.agentProfiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        })),
      paneProfiles: {},
      paneRoleGlobs: {},
      paneRepos: {},
      paneFlows: {},
      setPaneProfile: (paneId, profileId) =>
        set((s) => {
          const next = { ...s.paneProfiles };
          if (profileId === null) delete next[paneId];
          else next[paneId] = profileId;
          return { paneProfiles: next };
        }),
      // Switching tabs clears focus/fullscreen/menu — these are positional and
      // global, so a stale index from the previous tab would mis-target features
      // like broadcast (excluding a console that isn't actually focused). The focus
      // queue is NOT cleared: it spans tabs now, so waiting consoles left behind on
      // this tab stay reachable via Ctrl+Shift+N (which hops back to them).
      setActiveTab: (idx) => set({ activeTabIdx: idx, focusedPaneIdx: -1, fullscreenPaneIdx: -1, paneMenuOpenIdx: -1 }),
      addTab: (tab) =>
        set((s) => ({
          tabs: [...s.tabs, tab],
          activeTabIdx: s.tabs.length,
          focusedPaneIdx: -1,
          fullscreenPaneIdx: -1,
          paneMenuOpenIdx: -1,
        })),
      closeTab: (idx) =>
        set((s) => {
          const tabs = s.tabs.filter((_, i) => i !== idx);
          if (tabs.length === 0) return { tabs, activeTabIdx: 0, focusQueue: [] };
          let activeTabIdx = s.activeTabIdx;
          if (idx < s.activeTabIdx) activeTabIdx -= 1;
          else if (idx === s.activeTabIdx) activeTabIdx = Math.min(activeTabIdx, tabs.length - 1);
          return { tabs, activeTabIdx, focusQueue: [] };
        }),
      renameTab: (idx, name) =>
        set((s) => {
          const tabs = [...s.tabs];
          tabs[idx] = { ...tabs[idx], name };
          return { tabs };
        }),
      setTabState: (tabIdx, state) =>
        set((s) => {
          const tabs = [...s.tabs];
          tabs[tabIdx] = { ...tabs[tabIdx], state };
          return { tabs };
        }),
      setTabLayout: (tabIdx, layout) =>
        set((s) => {
          const [newCols, newRows] = layout.split("×").map(Number);
          const newCount = newCols * newRows;
          const tabs = [...s.tabs];
          tabs[tabIdx] = { ...tabs[tabIdx], layout };
          // Trim pane names for this tab to only surviving indices
          const tabPaneNames = { ...(s.paneNames[tabIdx] ?? {}) };
          (Object.keys(tabPaneNames) as unknown as number[]).forEach((k) => {
            if (Number(k) >= newCount) delete tabPaneNames[Number(k)];
          });
          // Trim cwds keyed by "t{tabIdx}p{n}"
          const paneCwds = { ...s.paneCwds };
          const isExcess = (key: string) => {
            const m = key.match(/^t(\d+)p(\d+)$/);
            return m && Number(m[1]) === tabIdx && Number(m[2]) >= newCount;
          };
          Object.keys(paneCwds).forEach((key) => { if (isExcess(key)) delete paneCwds[key]; });
          return {
            tabs,
            paneNames: { ...s.paneNames, [tabIdx]: tabPaneNames },
            paneCwds,
          };
        }),
      setPaneMenu:       (idx) => set({ paneMenuOpenIdx: idx }),
      setFocusedPane:    (idx) => set({ focusedPaneIdx: idx }),
      setFullscreenPane: (idx) => set({ fullscreenPaneIdx: idx }),
      focusedAgentName: "",
      setFocusedAgentName: (name) => set({ focusedAgentName: name }),
      setPaneView: (idx, view) =>
        set((s) => { const v = [...s.paneViews]; v[idx] = view; return { paneViews: v }; }),
      setAllPanesView: (view) =>
        set((s) => ({ paneViews: s.paneViews.map(() => view) })),
      setPaneName: (tabIdx, paneIdx, name) =>
        set((s) => ({
          paneNames: {
            ...s.paneNames,
            [tabIdx]: { ...s.paneNames[tabIdx], [paneIdx]: name },
          },
        })),

      githubConnected: false,
      githubToken: "",
      repoGithubTokens: {},
      setRepoGithubToken: (repo, token) =>
        set((s) => {
          const next = { ...s.repoGithubTokens };
          if (token && token.trim()) next[repo] = token.trim();
          else delete next[repo];
          return { repoGithubTokens: next };
        }),
      githubUser: null,
      githubRepos: [],
      activeRepoName: "",
      githubPageMode: "summary",
      setGithubPageMode: (v) => set({ githubPageMode: v }),
      githubActiveTab: "overview",
      setGithubTab: (tab) => set({ githubActiveTab: tab }),
      setGithubToken: (token) => set({ githubToken: token }),
      setGithubUser: (user) => set({ githubUser: user }),
      setGithubRepos: (repos) => set({ githubRepos: repos }),
      setActiveRepo: (name) => set({ activeRepoName: name }),
      setGithubConnected: (connected) => set({ githubConnected: connected }),
      disconnectGithub: () => set({
        githubConnected: false,
        githubToken: "",
        repoGithubTokens: {},
        githubUser: null,
        githubRepos: [],
        activeRepoName: "",
      }),
      // A request returned 401 (the stored token expired/was revoked). Flip to
      // disconnected so the UI prompts a reconnect instead of silently 401-looping;
      // the cached user/repos stay for context until the user reconnects.
      markGithubTokenInvalid: () => set((s) => (s.githubConnected ? { githubConnected: false } : {})),

      automationsTab: "schedules",
      setAutomationsTab: (tab) => set({ automationsTab: tab }),

      settingsSection: "github",
      setSettingsSection: (section) => set({ settingsSection: section }),

      tunnelRelayUrl: "",
      setTunnelRelayUrl: (url) => set({ tunnelRelayUrl: url }),
      tunnelRunning: false,
      setTunnelRunning: (v) => set({ tunnelRunning: v }),

      kbBlocks: [],
      claudeApiKey: "",
      setClaudeApiKey: (key) => set({ claudeApiKey: key }),
      applyKbTag: (blockId, tag) =>
        set((s) => ({
          kbBlocks: s.kbBlocks.map((b) =>
            b.id === blockId && !b.tags.includes(tag)
              ? { ...b, tags: [...b.tags, tag] }
              : b
          ),
        })),
      removeKbTag: (blockId, tag) =>
        set((s) => ({
          kbBlocks: s.kbBlocks.map((b) =>
            b.id === blockId ? { ...b, tags: b.tags.filter((t) => t !== tag) } : b
          ),
        })),
      renameKbBlock: (blockId, title) =>
        set((s) => ({
          kbBlocks: s.kbBlocks.map((b) => (b.id === blockId ? { ...b, title } : b)),
        })),
      updateKbBlockContent: (blockId, content) =>
        set((s) => ({
          kbBlocks: s.kbBlocks.map((b) =>
            b.id === blockId
              ? { ...b, content, lines: content.split("\n").length }
              : b
          ),
        })),
      addKbBlock: () =>
        set((s) => {
          const id = `blk_${Math.random().toString(36).slice(2, 6)}`;
          const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const block: KbBlock = { id, title: "Untitled block", tags: [], updated: now, lines: 1, content: "" };
          return { kbBlocks: [...s.kbBlocks, block] };
        }),
      removeKbBlock: (blockId) =>
        set((s) => ({ kbBlocks: s.kbBlocks.filter((b) => b.id !== blockId) })),

      schedules: [],
      addSchedule: () =>
        set((s) => {
          const id = `S-${String(s.schedules.length + 1).padStart(2, "0")}`;
          const newSched: Schedule = {
            id, name: "New schedule", on: false,
            when: "every day · 02:00", target: "",
            action: "command", detail: "",
            lastRun: "—", nextRun: "—",
          };
          return { schedules: [...s.schedules, newSched] };
        }),
      updateSchedule: (id, patch) =>
        set((s) => ({ schedules: s.schedules.map(sc => sc.id === id ? { ...sc, ...patch } : sc) })),
      removeSchedule: (id) =>
        set((s) => ({ schedules: s.schedules.filter(sc => sc.id !== id) })),

      commands: [],
      addCommand: () =>
        set((s) => {
          const id = `cmd_${Math.random().toString(36).slice(2, 8)}`;
          const newCmd: Command = { id, name: "New command", cmd: "", used: 0, tags: [] };
          return { commands: [...s.commands, newCmd] };
        }),
      updateCommand: (id, patch) =>
        set((s) => ({ commands: s.commands.map(c => c.id === id ? { ...c, ...patch } : c) })),
      removeCommand: (id) =>
        set((s) => ({ commands: s.commands.filter(c => c.id !== id) })),

      automations: [],
      addAutomation: (input) =>
        set((s) => {
          const id = `auto_${Math.random().toString(36).slice(2, 8)}`;
          const nextRunAt = input.armed ? computeNextRun(input.when, Date.now()) : null;
          const a: Automation = { ...input, id, lastRunAt: null, nextRunAt, runs: [] };
          return { automations: [...s.automations, a] };
        }),
      updateAutomation: (id, patch) =>
        set((s) => ({
          automations: s.automations.map(a => {
            if (a.id !== id) return a;
            const next = { ...a, ...patch };
            // Editing the trigger or arming re-derives the next fire time.
            if ("when" in patch || "armed" in patch) {
              next.nextRunAt = next.armed ? computeNextRun(next.when, Date.now()) : null;
            }
            return next;
          }),
        })),
      removeAutomation: (id) =>
        set((s) => ({ automations: s.automations.filter(a => a.id !== id) })),
      setAutomationArmed: (id, armed) =>
        set((s) => ({
          automations: s.automations.map(a =>
            a.id === id
              ? { ...a, armed, nextRunAt: armed ? computeNextRun(a.when, Date.now()) : null }
              : a),
        })),
      recordAutomationRun: (id, run) =>
        set((s) => ({
          automations: s.automations.map(a =>
            a.id === id
              ? { ...a, runs: appendRun(a.runs, run), lastRunAt: run.at, nextRunAt: computeNextRun(a.when, run.at) }
              : a),
        })),

      projectsPageMode: "summary",
      setProjectsPageMode: (v) => set({ projectsPageMode: v }),
      projectsView: "list",
      setProjectsView: (v) => set({ projectsView: v }),
      activeProjectId: null,
      activeProjectName: "",
      activeProjectRepo: "",
      activeProjectRepos: [],
      activeProjectNumber: 0,
      setActiveProject: (id) => set({ activeProjectId: id }),
      setActiveProjectMeta: (id, name, repo, number, repos = []) =>
        set((s) => ({
          activeProjectId: id, activeProjectName: name, activeProjectRepo: repo, activeProjectNumber: number, activeProjectRepos: repos,
          // First-write-wins: bind the GitHub node id to the folder/data key (the
          // title slug the plan files live under) so a board-path open resolves to
          // real data, not the empty node-id key. Frozen on first sighting so a
          // later GitHub rename can't clobber a working alias.
          projectKeyAlias: id && name && !s.projectKeyAlias[id]
            ? { ...s.projectKeyAlias, [id]: name }
            : s.projectKeyAlias,
        })),
      hiddenProjectIds: [],
      dismissProject: (id) =>
        set((s) => (!id || s.hiddenProjectIds.includes(id) ? {} : { hiddenProjectIds: [...s.hiddenProjectIds, id] })),
      addDraftProject: (key, draft) =>
        set((s) => ({ localDraftProjects: { ...s.localDraftProjects, [key]: draft } })),
      removeDraftProject: (key) =>
        set((s) => {
          const next = { ...s.localDraftProjects };
          delete next[key];
          return { localDraftProjects: next };
        }),
      deleteLocalProject: (keys) =>
        set((s) => {
          const keySet = new Set(keys.filter(Boolean));
          // Drop entries whose key is the project key.
          const byKey = <T,>(m: Record<string, T>): Record<string, T> =>
            Object.fromEntries(Object.entries(m).filter(([k]) => !keySet.has(k)));
          // Drop repo-scoped entries (`<projectKey>::<repo>`) for this project.
          const byRepoKey = <T,>(m: Record<string, T>): Record<string, T> =>
            Object.fromEntries(Object.entries(m).filter(([k]) => !keySet.has(k.split("::")[0])));
          const clearActive = s.activeProjectId != null && keySet.has(s.activeProjectId);
          return {
            planSections:           byKey(s.planSections),
            planConfirmedSections:  byKey(s.planConfirmedSections),
            planKbAssignments:      byKey(s.planKbAssignments),
            planAutomations:        byKey(s.planAutomations),
            planFleet:              byKey(s.planFleet),
            pinnedContext:          byKey(s.pinnedContext),
            projectKeyAlias:        byKey(s.projectKeyAlias),
            issueLinks:             byKey(s.issueLinks),
            // Drop the deleted project id from every extension's scope list.
            extensions:             s.extensions.map((e) => ({ ...e, projects: e.projects.filter((p) => !keySet.has(p)) })),
            // …and from every skill's scope list.
            skills:                 s.skills.map((sk) => ({ ...sk, projects: sk.projects.filter((p) => !keySet.has(p)) })),
            projectStartupPromptDoc: byKey(s.projectStartupPromptDoc),
            projectLocalRepos:      byKey(s.projectLocalRepos),
        localDraftProjects:     byKey(s.localDraftProjects),
            projectAllowedCommands: byKey(s.projectAllowedCommands),
            repoStartupPromptDoc:   byRepoKey(s.repoStartupPromptDoc),
            repoTriagePromptDoc:    byRepoKey(s.repoTriagePromptDoc),
            repoAllowedCommands:    byRepoKey(s.repoAllowedCommands),
            ...(clearActive
              ? { activeProjectId: null, activeProjectName: "", activeProjectRepo: "", activeProjectNumber: 0, activeProjectRepos: [], projectsView: "list" as const }
              : {}),
          };
        }),
      resetProjectData: () =>
        set({
          planSections: {}, planConfirmedSections: {}, planKbAssignments: {},
          planAutomations: {}, planFleet: {}, pinnedContext: {},
          projectLocalRepos: {}, localDraftProjects: {}, projectAllowedCommands: {},
          projectKeyAlias: {}, issueLinks: {}, repoAllowedCommands: {}, projectStartupPromptDoc: {},
          repoStartupPromptDoc: {}, repoTriagePromptDoc: {}, hiddenProjectIds: [],
          activeProjectId: null, activeProjectName: "", activeProjectRepo: "",
          activeProjectNumber: 0, activeProjectRepos: [],
          planningSessionKey: "", planningTitle: "", planningPitch: "",
          planningRepo: "", projectsView: "list",
        }),
      setActiveProjectRepos: (repos) =>
        set((s) => ({ activeProjectRepos: repos, activeProjectRepo: repos[0] ?? s.activeProjectRepo })),
      defaultStartupPromptDoc: null,
      setDefaultStartupPromptDoc: (doc) => set({ defaultStartupPromptDoc: doc }),
      projectStartupPromptDoc: {},
      setProjectStartupPromptDoc: (projectId, doc) =>
        set((s) => ({ projectStartupPromptDoc: { ...s.projectStartupPromptDoc, [projectId]: doc } })),
      repoStartupPromptDoc: {},
      setRepoStartupPromptDoc: (projectId, repo, doc) =>
        set((s) => ({ repoStartupPromptDoc: { ...s.repoStartupPromptDoc, [repoPromptKey(projectId, repo)]: doc } })),
      repoTriagePromptDoc: {},
      setRepoTriagePromptDoc: (projectId, repo, doc) =>
        set((s) => ({ repoTriagePromptDoc: { ...s.repoTriagePromptDoc, [repoPromptKey(projectId, repo)]: doc } })),
      kbProjectScope: null,
      setKbProjectScope: (scope) => set({ kbProjectScope: scope }),
      projectsBoardTab: "board",
      setProjectsBoardTab: (t) => set({ projectsBoardTab: t }),
      wakePane: (paneId, prompt) => {
        const m = /^t(\d+)p\d+$/.exec(paneId);
        if (!m) return false;
        const tabIdx = Number(m[1]);
        let ok = false;
        set((st) => {
          if (tabIdx < 0 || tabIdx >= st.tabs.length || st.disabledPanes[paneId]) return {};
          ok = true;
          return {
            paneStartupPromptText: { ...st.paneStartupPromptText, [paneId]: prompt },
            paneContinue: { ...st.paneContinue, [paneId]: false },
            tabs: st.tabs.map((t, i) => (i === tabIdx ? { ...t, runId: (t.runId ?? 0) + 1 } : t)),
          };
        });
        return ok;
      },
      fleetPaneStreams: {},
      pipelineRuns: {},
      pipelineStart: (presetKey, item) =>
        set((s) => {
          const pipeline = PIPELINE_PRESETS[presetKey];
          const id = item.trim();
          if (!pipeline || !id) return {};
          return mountState(s, id, startRun(pipeline, id).run);
        }),
      pipelineClear: (item) =>
        set((s) => {
          const runs = { ...s.pipelineRuns };
          delete runs[item];
          return { pipelineRuns: runs };
        }),
      pipelineMount: (item) =>
        set((s) => {
          const run = s.pipelineRuns[item];
          return run ? mountState(s, item, run) : {};
        }),
      pipelineSetRuns: (runs) => set({ pipelineRuns: runs }),
      projectsDrawerIssue: null,
      setProjectsDrawerIssue: (n) => set({ projectsDrawerIssue: n }),
      planningPitch: "",
      planningRepo: "",
      planningTitle: "",
      setPlanningContext: (pitch, repo) => set({ planningPitch: pitch, planningRepo: repo }),
      setPlanningTitle: (title) => set({ planningTitle: title }),
      planningSessionKey: "",
      setPlanningSession: (key) => set({ planningSessionKey: key }),
      projectKeyAlias: {},
      setProjectKeyAlias: (nodeId, key) =>
        set((s) => (nodeId && key && !s.projectKeyAlias[nodeId]
          ? { projectKeyAlias: { ...s.projectKeyAlias, [nodeId]: key } }
          : {})),
      issueLinks: {},
      setIssueLinks: (projectKey, links) =>
        set((s) => ({ issueLinks: { ...s.issueLinks, [projectKey]: { ...(s.issueLinks[projectKey] ?? {}), ...links } } })),
      bscBaseDir: "",
      setBscBaseDir: (dir) => set({ bscBaseDir: dir }),
      projectLocalRepos: {},
      localDraftProjects: {},
      addProjectRepo: (projectId, fullName) =>
        set((s) => {
          const existing = s.projectLocalRepos[projectId] ?? [];
          if (existing.includes(fullName)) return {};
          return { projectLocalRepos: { ...s.projectLocalRepos, [projectId]: [...existing, fullName] } };
        }),
      findTriageTabIdx: (projectName) => {
        const tabName = `${projectName} · triage`;
        return get().tabs.findIndex((t) => t.name === tabName);
      },
      triageStartProject: (projectName, repos, projectId = "") =>
        set((s) => {
          // A triage tab for this project may already exist (re-run): rebuild it in
          // place at the same index. The caller kills the old panes' sessions first
          // and the bumped runId remounts them, so pty_create launches fresh
          // (resuming via --continue + the checkpoint) instead of reconnecting.
          const tabName = `${projectName} · triage`;
          const existingIdx = s.tabs.findIndex((t) => t.name === tabName);
          if (repos.length === 0) return {};
          const newTabIdx = existingIdx >= 0 ? existingIdx : s.tabs.length;
          const runId = existingIdx >= 0 ? (s.tabs[existingIdx].runId ?? 0) + 1 : 0;
          const addedAutos = activateAutomations(s, projectId, tabName);
          const count = Math.min(repos.length, 16);
          const cols = count <= 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
          const rows = Math.ceil(count / cols);
          const layout = `${cols}×${rows}`;
          const newPaneCwds     = { ...s.paneCwds };
          const newPaneInitCmds = { ...s.paneInitCmds };
          const newPaneStartupPromptDocs = { ...s.paneStartupPromptDocs };
          const newPaneStartupPromptText = { ...s.paneStartupPromptText };
          const newPaneCheckpointDocs    = { ...s.paneCheckpointDocs };
          const newPaneContinue          = { ...s.paneContinue };
          const newPaneAllowedCommands   = { ...s.paneAllowedCommands };
          const newPaneExtensions        = { ...s.paneExtensions };
          const newPaneSkills            = { ...s.paneSkills };
          const newPaneRoles             = { ...s.paneRoles };
          const newPaneRepos             = { ...s.paneRepos };
          const triageExts               = resolveExtensions(s.extensions, projectId);
          const triageSkills             = resolveSkills(s.skills, projectId);
          // Checkpoint docs live beside the repo clones, under the project-name
          // key (always present; projectId defaults to "" for ad-hoc triage).
          const projKey = sanitizeProjectKey(projectName);
          const newDisabledPanes = { ...s.disabledPanes };
          const tabPaneNames: Record<number, string> = {};
          const paneCount = cols * rows;
          const assignments = {
            defaultStartupPromptDoc: s.defaultStartupPromptDoc,
            projectStartupPromptDoc: s.projectStartupPromptDoc,
            repoStartupPromptDoc: s.repoStartupPromptDoc,
          };
          for (let i = 0; i < paneCount; i++) {
            const key = `t${newTabIdx}p${i}`;
            if (i < count) {
              const fullName = repos[i];
              // A real repo — launch claude in its clone, ensure it's enabled.
              newPaneCwds[key]     = projectRepoCwd(s.bscBaseDir, projectName, fullName);
              newPaneInitCmds[key] = "claude";
              tabPaneNames[i]      = fullName?.split("/")[1] ?? `pane-${i + 1}`;
              // The startup prompt is baked into the claude launch by the backend
              // (reliable). A per-repo triage script (planner-authored,
              // auto-assigned) wins as a document; otherwise the verbatim shared
              // TRIAGE_PROMPT text (which TerminalView prefers over the dev doc
              // chain), with a doc-based fallback (repo→project→global→built-in;
              // "" = built-in default) for if the text is later cleared.
              const triageDoc = s.repoTriagePromptDoc[repoPromptKey(projectId, fullName ?? "")];
              if (triageDoc) {
                newPaneStartupPromptDocs[key] = triageDoc;
              } else {
                newPaneStartupPromptText[key] = TRIAGE_PROMPT;
                const doc = resolveStartupPromptDoc(assignments, projectId, fullName ?? "");
                newPaneStartupPromptDocs[key] = doc ?? "";
              }
              newPaneAllowedCommands[key] = resolveAllowedCommands(
                s.allowedCommands,
                s.projectAllowedCommands[projectId],
                s.repoAllowedCommands[repoPromptKey(projectId, fullName ?? "")],
              );
              // Triage resumes the repo's prior conversation (claude --continue)
              // so each pass builds on the last instead of starting cold.
              newPaneContinue[key] = true;
              // Per-repo checkpoint doc: the session writes "where we left off" to
              // it via bsc-checkpoint; the next triage launch composes it onto the
              // prompt. Stable per (project, repo) so successive passes accumulate.
              newPaneCheckpointDocs[key] = checkpointDocRelpath(projKey, fullName ?? "");
              newPaneExtensions[key] = triageExts;
              newPaneSkills[key] = triageSkills;
              newPaneRoles[key] = "triage";
              // Bind the triage pane to its repo so its session GH_TOKEN is scoped to it
              // (#158); a repo with an assigned credential triages with that token only.
              if (fullName) newPaneRepos[key] = fullName;
              delete newDisabledPanes[key];
            } else {
              // Empty grid cell (more cells than repos) — start it disabled so it
              // doesn't spawn an idle shell or add rendering load.
              newDisabledPanes[key] = true;
              delete newPaneRepos[key];
            }
          }
          const newTab: Tab = { name: `${projectName} · triage`, layout, state: "idle", runId };
          return {
            tabs: existingIdx >= 0
              ? s.tabs.map((t, i) => (i === existingIdx ? newTab : t))
              : [...s.tabs, newTab],
            activeTabIdx: newTabIdx,
            focusedPaneIdx: -1,
            fullscreenPaneIdx: -1,
            paneMenuOpenIdx: -1,
            paneCwds:     newPaneCwds,
            paneInitCmds: newPaneInitCmds,
            paneStartupPromptDocs: newPaneStartupPromptDocs,
            paneStartupPromptText: newPaneStartupPromptText,
            paneCheckpointDocs: newPaneCheckpointDocs,
            paneContinue: newPaneContinue,
            paneAllowedCommands: newPaneAllowedCommands,
            paneExtensions: newPaneExtensions,
            paneSkills: newPaneSkills,
            paneRoles: newPaneRoles,
            paneRepos: newPaneRepos,
            disabledPanes: newDisabledPanes,
            paneNames: { ...s.paneNames, [newTabIdx]: tabPaneNames },
            automations: [...s.automations, ...addedAutos],
            activeScreen: "console" as Screen,
          };
        }),

      findFleetTabIdx: (projectName) => {
        const tabName = `${projectName} · build`;
        return get().tabs.findIndex((t) => t.name === tabName);
      },
      fleetStartProject: (projectName, fleet, projectKey) =>
        set((s) => {
          // The fleet launches into "· build" tabs (plus "· build 2", "· build 3"…
          // when it overflows a tab). A tab holds up to 16 panes (the 4×4 layout
          // limit); there is no fleet-wide cap, so larger fleets spill into more tabs.
          // Each (re-)launch rebuilds its tab(s) in place with a bumped runId (the
          // caller kills the old panes first), like triageStartProject.
          const baseTabName = `${projectName} · build`;
          const hasDirector = fleet.director.enabled;
          const newPaneDirectorDrive     = { ...s.paneDirectorDrive };
          const newPaneDirectorMode      = { ...s.paneDirectorMode };
          const newPaneStream            = { ...s.paneStream };

          // Independents first so the launched wave is what can run now; the
          // recommended count caps how many workers start (no 16 cap — we go multi-tab).
          const ordered = [...fleet.streams].sort(
            (a, b) => (a.dependsOn.length ? 1 : 0) - (b.dependsOn.length ? 1 : 0),
          );
          const rec = fleet.recommended > 0 ? fleet.recommended : ordered.length;
          const workerCount = Math.min(ordered.length, Math.max(ordered.length ? 1 : 0, rec));
          const workers = ordered.slice(0, workerCount);

          // Flat session list, chunked into tabs of ≤16. `null` marks the director slot.
          const sessions: (AgentStream | null)[] = [...(hasDirector ? [null] : []), ...workers];
          if (sessions.length === 0) return {};

          const CAP = 16;
          const numTabs = Math.ceil(sessions.length / CAP);

          const newPaneCwds              = { ...s.paneCwds };
          const newPaneInitCmds          = { ...s.paneInitCmds };
          const newPaneStartupPromptDocs = { ...s.paneStartupPromptDocs };
          const newPaneStartupPromptText = { ...s.paneStartupPromptText };
          const newPaneContinue          = { ...s.paneContinue };
          const newPaneCheckpointDocs    = { ...s.paneCheckpointDocs };
          const newPaneAllowedCommands   = { ...s.paneAllowedCommands };
          const newPaneExtensions        = { ...s.paneExtensions };
          const newPaneSkills            = { ...s.paneSkills };
          const newDisabledPanes         = { ...s.disabledPanes };
          const newPaneNames             = { ...s.paneNames };
          const newPaneRoles             = { ...s.paneRoles };
          const newPaneProfiles             = { ...s.paneProfiles };
          const newFleetPaneStreams      = { ...s.fleetPaneStreams };
          const newPaneRoleGlobs            = { ...s.paneRoleGlobs };
          const newPaneRepos                = { ...s.paneRepos };
          const newPaneFlows                = { ...s.paneFlows };

          const safeKey = sanitizeProjectKey(projectKey);
          const projectCmds = resolveAllowedCommands(s.allowedCommands, s.projectAllowedCommands[projectKey], undefined);
          // Same resolved extensions for every pane — they share the project scope.
          const fleetExts = resolveExtensions(s.extensions, projectKey);
          const fleetSkills = resolveSkills(s.skills, projectKey);

          let tabs = s.tabs;
          let firstTabIdx = -1;

          for (let t = 0; t < numTabs; t++) {
            const chunk = sessions.slice(t * CAP, t * CAP + CAP);
            const tabName = t === 0 ? baseTabName : `${baseTabName} ${t + 1}`;
            const existingIdx = tabs.findIndex((tb) => tb.name === tabName);
            const tabIdx = existingIdx >= 0 ? existingIdx : tabs.length;
            if (firstTabIdx < 0) firstTabIdx = tabIdx;
            const runId = existingIdx >= 0 ? (tabs[existingIdx].runId ?? 0) + 1 : 0;
            // Resume only on re-run. Each worker has its OWN worktree (a distinct
            // cwd), so `claude --continue` is unambiguous even for several agents in
            // one repo — the old shared-cwd hazard is gone.
            const resume = existingIdx >= 0;
            const count = chunk.length;
            const cols = count <= 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
            const rows = Math.ceil(count / cols);
            const layout = `${cols}×${rows}`;
            const paneCount = cols * rows;
            const tabPaneNames: Record<number, string> = {};

            for (let i = 0; i < paneCount; i++) {
              const key = `t${tabIdx}p${i}`;
              // Clear any stale wiring from a prior run of this slot.
              delete newPaneStartupPromptText[key];
              delete newPaneStartupPromptDocs[key];
              delete newPaneCheckpointDocs[key];
              delete newPaneExtensions[key];
              delete newPaneRoles[key];
              delete newPaneProfiles[key];
              delete newFleetPaneStreams[key];
              delete newPaneRoleGlobs[key];
              delete newPaneRepos[key];
              delete newPaneFlows[key];
              delete newPaneDirectorDrive[key];
              delete newPaneDirectorMode[key];
              delete newPaneStream[key];
              if (i < count) {
                const sess = chunk[i];
                if (sess === null) {
                  // Director session at the project root — sees every repo + worktree.
                  newPaneCwds[key]     = projectHubCwd(s.bscBaseDir, projectKey);
                  newPaneInitCmds[key] = "claude";
                  newPaneStartupPromptDocs[key] = scriptDocRelpath(safeKey, "prompts/director-kickoff.md");
                  newPaneAllowedCommands[key] = projectCmds;
                  newPaneCheckpointDocs[key] = agentCheckpointDocRelpath(safeKey, "director");
                  tabPaneNames[i] = "director";
                  newPaneDirectorDrive[key] = resolveDirectorDrive(fleet.director.drive);
                  newPaneDirectorMode[key] = strategySettings(resolveStrategy(undefined, fleet.strategy)).director;
                } else {
                  // Worker runs in its own git worktree on its own branch.
                  newPaneCwds[key]     = agentWorktreeCwd(s.bscBaseDir, projectKey, sess.repo, sess.id);
                  newPaneInitCmds[key] = "claude";
                  if (sess.prompt) {
                    newPaneStartupPromptDocs[key] = scriptDocRelpath(safeKey, sess.prompt);
                  } else {
                    newPaneStartupPromptText[key] = buildStreamPrompt(sess, resolveStrategy(sess.strategy, fleet.strategy));
                  }
                  newPaneAllowedCommands[key] = resolveAllowedCommands(
                    s.allowedCommands,
                    s.projectAllowedCommands[projectKey],
                    s.repoAllowedCommands[repoPromptKey(projectKey, sess.repo)],
                  );
                  // Per-agent checkpoint doc (keyed by stream id) so each agent keeps
                  // its own "where we left off" note.
                  newPaneCheckpointDocs[key] = agentCheckpointDocRelpath(safeKey, sess.id);
                  newPaneStream[key] = { repo: sess.repo, branch: worktreeSlug(sess.id) };
                  tabPaneNames[i] = sess.name;
                  // Bridge pane id → stream so the coordinator can resolve which pane
                  // produces a contract/issue/file (#199 AC#7).
                  newFleetPaneStreams[key] = sess;
                }
                newPaneContinue[key] = resume;
                newPaneExtensions[key] = fleetExts;
                newPaneSkills[key] = fleetSkills;
                newPaneRoles[key] = sess === null ? "director" : "worker";
                // Bind the worker pane to its repo so its session GH_TOKEN is scoped to
                // it (#158). The director spans every repo, so it keeps the global token.
                if (sess && sess.repo) newPaneRepos[key] = sess.repo;
                if (sess && sess.profile) newPaneProfiles[key] = sess.profile;
                // The worker's owned paths become its role write boundary so edits in
                // its lane auto-approve (dir/ -> dir/** so the subtree matches).
                if (sess && sess.owns.length) newPaneRoleGlobs[key] = sess.owns.map((g) => (g.endsWith("/") ? g + "**" : g));
                if (sess && sess.flow) newPaneFlows[key] = sess.flow;
                delete newDisabledPanes[key];
              } else {
                // Empty grid cell — start disabled so it doesn't spawn an idle shell.
                newDisabledPanes[key] = true;
              }
            }

            const newTab: Tab = { name: tabName, layout, state: "idle", runId };
            tabs = existingIdx >= 0
              ? tabs.map((tb, i) => (i === existingIdx ? newTab : tb))
              : [...tabs, newTab];
            newPaneNames[tabIdx] = tabPaneNames;
          }

          const addedAutos = activateAutomations(s, s.activeProjectId ?? "", baseTabName);
          return {
            tabs,
            activeTabIdx: firstTabIdx,
            automations: [...s.automations, ...addedAutos],
            focusedPaneIdx: -1,
            fullscreenPaneIdx: -1,
            paneMenuOpenIdx: -1,
            paneCwds: newPaneCwds,
            paneInitCmds: newPaneInitCmds,
            paneStartupPromptDocs: newPaneStartupPromptDocs,
            paneStartupPromptText: newPaneStartupPromptText,
            paneContinue: newPaneContinue,
            paneCheckpointDocs: newPaneCheckpointDocs,
            paneAllowedCommands: newPaneAllowedCommands,
            paneExtensions: newPaneExtensions,
            paneSkills: newPaneSkills,
            paneRoles: newPaneRoles,
            paneProfiles: newPaneProfiles,
            fleetPaneStreams: newFleetPaneStreams,
            paneRoleGlobs: newPaneRoleGlobs,
            paneRepos: newPaneRepos,
            paneFlows: newPaneFlows,
            paneDirectorDrive: newPaneDirectorDrive,
            paneDirectorMode: newPaneDirectorMode,
            paneStream: newPaneStream,
            disabledPanes: newDisabledPanes,
            paneNames: newPaneNames,
            activeScreen: "console" as Screen,
          };
        }),

      configProfiles: [],
      addConfigProfile: (profile) =>
        set((s) => ({
          configProfiles: [
            ...s.configProfiles,
            { ...profile, id: `cfg_${Math.random().toString(36).slice(2, 8)}` },
          ],
        })),
      updateConfigProfile: (id, patch) =>
        set((s) => ({
          configProfiles: s.configProfiles.map((p) =>
            p.id === id ? { ...p, ...patch } : p,
          ),
        })),
      removeConfigProfile: (id) =>
        set((s) => ({ configProfiles: s.configProfiles.filter((p) => p.id !== id) })),

      planSections: {},
      setPlanSection: (projectId, key, content) =>
        set((s) => ({
          planSections: {
            ...s.planSections,
            [projectId]: { ...(s.planSections[projectId] ?? {}), [key]: content },
          },
        })),
      planConfirmedSections: {},
      confirmPlanSection: (projectId, key) =>
        set((s) => {
          const existing = s.planConfirmedSections[projectId] ?? [];
          if (existing.includes(key)) return {};
          return { planConfirmedSections: { ...s.planConfirmedSections, [projectId]: [...existing, key] } };
        }),
      unconfirmPlanSection: (projectId, key) =>
        set((s) => ({
          planConfirmedSections: {
            ...s.planConfirmedSections,
            [projectId]: (s.planConfirmedSections[projectId] ?? []).filter((k) => k !== key),
          },
        })),
      planKbAssignments: {},
      addPlanKbAssignment: (projectId, blockId) =>
        set((s) => {
          const existing = s.planKbAssignments[projectId] ?? [];
          if (existing.includes(blockId)) return {};
          return { planKbAssignments: { ...s.planKbAssignments, [projectId]: [...existing, blockId] } };
        }),
      removePlanKbAssignment: (projectId, blockId) =>
        set((s) => ({
          planKbAssignments: {
            ...s.planKbAssignments,
            [projectId]: (s.planKbAssignments[projectId] ?? []).filter((id) => id !== blockId),
          },
        })),
      planAutomations: {},
      addPlanAutomation: (projectId, a) =>
        set((s) => {
          const existing = s.planAutomations[projectId] ?? [];
          if (existing.some((x) => x.name === a.name && x.command === a.command)) return {};
          return { planAutomations: { ...s.planAutomations, [projectId]: [...existing, a] } };
        }),
      clearPlanAutomations: (projectId) =>
        set((s) => ({ planAutomations: { ...s.planAutomations, [projectId]: [] } })),

      planFleet: {},
      pinnedContext: {},
      togglePinnedContext: (projectId, name) =>
        set((s) => {
          const cur = s.pinnedContext[projectId] ?? [];
          const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
          return { pinnedContext: { ...s.pinnedContext, [projectId]: next } };
        }),
      setPlanFleet: (projectId, fleet) =>
        set((s) => ({ planFleet: { ...s.planFleet, [projectId]: fleet } })),
      addPlanAgentStream: (projectId, stream) =>
        set((s) => {
          const cur = s.planFleet[projectId] ?? emptyFleet();
          // Merge by id so re-emitted tags refine an existing stream in place.
          const streams = cur.streams.some((x) => x.id === stream.id)
            ? cur.streams.map((x) => (x.id === stream.id ? stream : x))
            : [...cur.streams, stream];
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, streams } } };
        }),
      removePlanAgentStream: (projectId, id) =>
        set((s) => {
          const cur = s.planFleet[projectId];
          if (!cur) return {};
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, streams: cur.streams.filter((x) => x.id !== id) } } };
        }),
      setPlanAgentStreamProfile: (projectId, streamId, profileId) =>
        set((s) => {
          const cur = s.planFleet[projectId];
          if (!cur) return {};
          const streams = cur.streams.map((x) => (x.id === streamId ? { ...x, profile: profileId ?? undefined } : x));
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, streams } } };
        }),
      setPlanAgentStreamFlow: (projectId, streamId, patch) =>
        set((s) => {
          const cur = s.planFleet[projectId];
          if (!cur) return {};
          const streams = cur.streams.map((x) =>
            x.id === streamId ? { ...x, flow: normalizeFlow({ ...resolveFlow(x.flow), ...patch }) } : x);
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, streams } } };
        }),
      setPlanAgentStreamStrategy: (projectId, streamId, strategy) =>
        set((s) => {
          const cur = s.planFleet[projectId];
          if (!cur) return {};
          const streams = cur.streams.map((x) =>
            x.id === streamId ? { ...x, strategy } : x);
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, streams } } };
        }),
      setPlanAgentStreamPerm: (projectId, streamId, perm) =>
        set((s) => {
          const cur = s.planFleet[projectId];
          if (!cur) return {};
          const streams = cur.streams.map((x) =>
            x.id === streamId ? { ...x, perm: { ...perm }, preset: "custom" } : x);
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, streams } } };
        }),
      setPlanAgentStreamPreset: (projectId, streamId, preset, perm) =>
        set((s) => {
          const cur = s.planFleet[projectId];
          if (!cur) return {};
          const streams = cur.streams.map((x) =>
            x.id === streamId ? { ...x, preset, perm: { ...perm } } : x);
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, streams } } };
        }),
      generateFleetProfiles: (projectId) =>
        set((s) => {
          const fleet = s.planFleet[projectId];
          if (!fleet) return {};
          const profiles = [...s.agentProfiles];
          const byId = new Set(profiles.map((pr) => pr.id));
          const streams = fleet.streams.map((stream) => {
            // Skip only if the stream already points at a profile that EXISTS. A
            // dangling reference (the planner assigned an id we never created) is
            // materialized here, keeping the assigned id so the reference stays stable.
            if (stream.profile && byId.has(stream.profile)) return stream;
            const commands = resolveAllowedCommands(
              s.allowedCommands,
              s.projectAllowedCommands[projectId],
              s.repoAllowedCommands[repoPromptKey(projectId, stream.repo)],
            );
            const gen = generateAgentProfile(stream, "worker", commands);
            const id = stream.profile || gen.id;
            if (!byId.has(id)) { profiles.push({ ...gen, id }); byId.add(id); }
            return { ...stream, profile: id };
          });
          return { agentProfiles: profiles, planFleet: { ...s.planFleet, [projectId]: { ...fleet, streams } } };
        }),
      setPlanFleetMeta: (projectId, recommended, reasoning, strategy) =>
        set((s) => {
          const cur = s.planFleet[projectId] ?? emptyFleet();
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, recommended, reasoning, strategy: strategy ?? cur.strategy } } };
        }),
      setPlanDirector: (projectId, enabled, role) =>
        set((s) => {
          const cur = s.planFleet[projectId] ?? emptyFleet();
          return {
            planFleet: {
              ...s.planFleet,
              [projectId]: { ...cur, director: { enabled, role: role ?? cur.director.role, drive: cur.director.drive } },
            },
          };
        }),
      setPlanDirectorDrive: (projectId, drive) =>
        set((s) => {
          const cur = s.planFleet[projectId] ?? emptyFleet();
          return {
            planFleet: {
              ...s.planFleet,
              [projectId]: { ...cur, director: { ...cur.director, drive } },
            },
          };
        }),
      clearPlanFleet: (projectId) =>
        set((s) => ({ planFleet: { ...s.planFleet, [projectId]: emptyFleet() } })),

      extensions: [],
      addExtension: (def) =>
        set((s) => ({
          extensions: [...s.extensions, { ...def, id: `ext_${Math.random().toString(36).slice(2, 8)}` }],
        })),
      updateExtension: (id, patch) =>
        set((s) => ({ extensions: s.extensions.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),
      removeExtension: (id) =>
        set((s) => ({ extensions: s.extensions.filter((e) => e.id !== id) })),
      toggleExtension: (id) =>
        set((s) => ({ extensions: s.extensions.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)) })),
      setExtensionProjects: (id, projects) =>
        set((s) => ({ extensions: s.extensions.map((e) => (e.id === id ? { ...e, projects } : e)) })),
      paneExtensions: {},

      skills: seedSkills(),
      addSkill: (def) => {
        const id = `skill_${Math.random().toString(36).slice(2, 8)}`;
        set((s) => ({ skills: [...s.skills, { ...def, id }] }));
        return id;
      },
      updateSkill: (id, patch) =>
        set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? { ...sk, ...patch } : sk)) })),
      removeSkill: (id) =>
        set((s) => ({ skills: s.skills.filter((sk) => sk.id !== id) })),
      toggleSkill: (id) =>
        set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? { ...sk, enabled: !sk.enabled } : sk)) })),
      toggleSkillPin: (id) =>
        set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? { ...sk, pinned: !sk.pinned } : sk)) })),
      setSkillProjects: (id, projects) =>
        set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? { ...sk, projects } : sk)) })),
      upsertSkills: (defs) =>
        set((s) => {
          const skills = [...s.skills];
          for (const def of defs) {
            // Match by explicit id first, then by name-slug, so a re-emitted
            // definition refines the existing skill in place.
            const slug = def.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
            const idx = skills.findIndex(
              (sk) => (def.id && sk.id === def.id) ||
                sk.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") === slug,
            );
            if (idx >= 0) {
              const rest = { ...def };
              delete rest.id;
              skills[idx] = { ...skills[idx], ...rest };
            } else {
              skills.push({ ...def, id: def.id ?? `skill_${Math.random().toString(36).slice(2, 8)}` });
            }
          }
          return { skills };
        }),
      paneSkills: {},

      allowedCommands: [],
      addAllowedCommand: (cmd) =>
        set((s) => ({
          allowedCommands: s.allowedCommands.includes(cmd)
            ? s.allowedCommands
            : [...s.allowedCommands, cmd],
        })),
      removeAllowedCommand: (cmd) =>
        set((s) => ({ allowedCommands: s.allowedCommands.filter((c) => c !== cmd) })),
      setAllowedCommands: (commands) => set({ allowedCommands: commands }),

      deniedCommands: [],
      addDeniedCommand: (cmd) =>
        set((s) => {
          const c = cmd.trim().toLowerCase();
          if (!c || s.deniedCommands.includes(c)) return {};
          return { deniedCommands: [...s.deniedCommands, c] };
        }),
      removeDeniedCommand: (cmd) =>
        set((s) => ({ deniedCommands: s.deniedCommands.filter((c) => c !== cmd) })),
      setDeniedCommands: (commands) => set({ deniedCommands: commands }),

      projectAllowedCommands: {},
      addProjectAllowedCommand: (projectId, cmd) =>
        set((s) => {
          const c = cmd.trim().toLowerCase();
          const cur = s.projectAllowedCommands[projectId] ?? [];
          if (!c || cur.includes(c)) return {};
          return { projectAllowedCommands: { ...s.projectAllowedCommands, [projectId]: [...cur, c] } };
        }),
      removeProjectAllowedCommand: (projectId, cmd) =>
        set((s) => ({
          projectAllowedCommands: {
            ...s.projectAllowedCommands,
            [projectId]: (s.projectAllowedCommands[projectId] ?? []).filter((x) => x !== cmd),
          },
        })),
      repoAllowedCommands: {},
      addRepoAllowedCommand: (projectId, repo, cmd) =>
        set((s) => {
          const key = repoPromptKey(projectId, repo);
          const c = cmd.trim().toLowerCase();
          const cur = s.repoAllowedCommands[key] ?? [];
          if (!c || cur.includes(c)) return {};
          return { repoAllowedCommands: { ...s.repoAllowedCommands, [key]: [...cur, c] } };
        }),
      removeRepoAllowedCommand: (projectId, repo, cmd) =>
        set((s) => {
          const key = repoPromptKey(projectId, repo);
          return {
            repoAllowedCommands: {
              ...s.repoAllowedCommands,
              [key]: (s.repoAllowedCommands[key] ?? []).filter((x) => x !== cmd),
            },
          };
        }),
      paneAllowedCommands: {},

      autoAdvanceOnReply: true,
      setAutoAdvanceOnReply: (v) => set({ autoAdvanceOnReply: v }),

      autoResumeClaude: true,
      setAutoResumeClaude: (v) => set({ autoResumeClaude: v }),
      coordAutoWake: false,
      setCoordAutoWake: (v) => set({ coordAutoWake: v }),
    }),
    {
      name: "app-state",
      storage: createJSONStorage(() => persistStorage),
      // Exclude transient UI-only state from the persisted snapshot.
      partialize: (s) => ({
        activeScreen:    s.activeScreen,
        tabs:            s.tabs,
        activeTabIdx:    s.activeTabIdx,
        terminalFontSize: s.terminalFontSize,
        paneViews:       s.paneViews,
        paneNames:       s.paneNames,
        paneCwds:        s.paneCwds,
        paneWasClaude:   s.paneWasClaude,
        paneDirectorDrive: s.paneDirectorDrive,
        paneDirectorMode: s.paneDirectorMode,
        paneStream: s.paneStream,
        disabledPanes:   s.disabledPanes,
        githubConnected: s.githubConnected,
        githubToken:     s.githubToken,
        repoGithubTokens: s.repoGithubTokens,
        githubUser:      s.githubUser,
        githubRepos:     s.githubRepos,
        activeRepoName:  s.activeRepoName,
        githubActiveTab: s.githubActiveTab,
        automationsTab:  s.automationsTab,
        settingsSection: s.settingsSection,
        tunnelRelayUrl:  s.tunnelRelayUrl,
        agentProfiles:   s.agentProfiles,
        paneProfiles:    s.paneProfiles,
        paneRoleGlobs:   s.paneRoleGlobs,
        paneRepos:       s.paneRepos,
        paneFlows:       s.paneFlows,
        kbBlocks:        s.kbBlocks,
        claudeApiKey:    s.claudeApiKey,
        schedules:            s.schedules,
        commands:             s.commands,
        automations:          s.automations,
        allowedCommands:      s.allowedCommands,
        deniedCommands:       s.deniedCommands,
        projectAllowedCommands: s.projectAllowedCommands,
        repoAllowedCommands:    s.repoAllowedCommands,
        autoAdvanceOnReply:   s.autoAdvanceOnReply,
        autoResumeClaude:     s.autoResumeClaude,
        coordAutoWake:        s.coordAutoWake,
        fleetPaneStreams:     s.fleetPaneStreams,
        pipelineRuns:         s.pipelineRuns,
        projectLocalRepos:    s.projectLocalRepos,
        localDraftProjects:   s.localDraftProjects,
        projectKeyAlias:      s.projectKeyAlias,
        issueLinks:           s.issueLinks,
        achievements:         s.achievements,
        hiddenProjectIds:     s.hiddenProjectIds,
        defaultStartupPromptDoc: s.defaultStartupPromptDoc,
        projectStartupPromptDoc: s.projectStartupPromptDoc,
        repoStartupPromptDoc:    s.repoStartupPromptDoc,
        repoTriagePromptDoc:     s.repoTriagePromptDoc,
        configProfiles:       s.configProfiles,
        planSections:          s.planSections,
        planConfirmedSections: s.planConfirmedSections,
        planKbAssignments:     s.planKbAssignments,
        planAutomations:       s.planAutomations,
        planFleet:             s.planFleet,
        pinnedContext:         s.pinnedContext,
        extensions:            s.extensions,
        skills:                s.skills,
      }),
      // Storage is async (Tauri plugin-store), so hydration finishes AFTER the
      // first render. Flip hasHydrated here so the shell can hold its first paint
      // until the persisted state is in — otherwise screens flash from defaults
      // (e.g. GitHub "not connected" → connected) on every load.
      onRehydrateStorage: () => (state) => {
        // Release the gate once hydration settles — on success or error — so the
        // shell never hangs on a blank canvas (on error the store keeps defaults).
        (state ?? useAppStore.getState()).setHasHydrated(true);
      },
    }
  )
);
