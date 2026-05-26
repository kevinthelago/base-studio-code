import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Screen } from "../components/chrome/Rail";
import type { Tab } from "../components/chrome/Tabstrip";
import type { ViewKey } from "../components/pane/ViewTabs";
import type { KbBlock, Schedule, Command } from "../data/mock";
import { persistStorage } from "../lib/storage";
import { clampFontSize, DEFAULT_TERMINAL_FONT_SIZE } from "../lib/terminal";
import { resolveStartupPromptDoc, repoPromptKey } from "./../lib/startupPrompt";
import { projectRepoCwd } from "../lib/projectPaths";
import { resolveAllowedCommands } from "../lib/allowedCommands";

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
  "summarize the triage results grouped by priority when done.";

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

  // Console — tabs & panes
  tabs: Tab[];
  activeTabIdx: number;
  paneMenuOpenIdx: number;   // transient — NOT persisted
  focusedPaneIdx: number;    // transient — NOT persisted
  fullscreenPaneIdx: number; // transient — NOT persisted
  consoleBroadcast: boolean; // transient — NOT persisted
  setConsoleBroadcast: (v: boolean) => void;
  // Global terminal font size (px), shared by every console pane (persisted).
  // Adjusted via Ctrl++ / Ctrl+- / Ctrl+0; clamped to the legible range.
  terminalFontSize: number;
  setTerminalFontSize: (size: number) => void;
  paneViews: ViewKey[];
  paneNames: Record<number, Record<number, string>>;
  paneCwds: Record<string, string>;  // keyed by "t{tabIdx}p{paneIdx}"
  setPaneCwd: (paneId: string, cwd: string) => void;
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
  // Epoch ms when each tab's sessions launched (transient — NOT persisted), so
  // auto-focus can be suppressed during a grid's cold-start window.
  tabStartedAt: Record<number, number>;
  paneGitInfo: Record<string, { repo: string; branch: string; dirty: boolean } | null>;
  setPaneGitInfo: (paneId: string, info: { repo: string; branch: string; dirty: boolean } | null) => void;
  // Disabled panes (keyed by "t{tabIdx}p{paneIdx}") — terminal unmounted + PTY killed.
  disabledPanes: Record<string, boolean>;
  setPaneDisabled: (paneId: string, disabled: boolean) => void;
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
  githubUser: GithubUser | null;
  githubRepos: GithubRepo[];
  activeRepoName: string;
  githubPageMode: "summary" | "repos";
  setGithubPageMode: (v: "summary" | "repos") => void;
  githubActiveTab: "overview" | "actions" | "hooks";
  setGithubTab: (tab: AppStore["githubActiveTab"]) => void;
  setGithubToken: (token: string) => void;
  setGithubUser: (user: GithubUser | null) => void;
  setGithubRepos: (repos: GithubRepo[]) => void;
  setActiveRepo: (name: string) => void;
  setGithubConnected: (connected: boolean) => void;
  disconnectGithub: () => void;

  // Automations
  automationsTab: "schedules" | "commands" | "history";
  setAutomationsTab: (tab: AppStore["automationsTab"]) => void;

  // Settings
  settingsSection: string;
  setSettingsSection: (section: string) => void;

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
  projectsBoardTab: "board" | "roadmap" | "issues" | "insights";
  setProjectsBoardTab: (t: "board" | "roadmap" | "issues" | "insights") => void;
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
  // Repository resolution — base dir is `~/.base-studio-code` (the base); repo
  // clone paths are derived as `<base>/projects/<key>/<repo>`.
  bscBaseDir: string;
  setBscBaseDir: (dir: string) => void;
  projectLocalRepos: Record<string, string[]>;
  addProjectRepo: (projectId: string, fullName: string) => void;
  quickStartProject: (projectName: string, repos: string[], projectId?: string) => void;
  triageStartProject: (projectName: string, repos: string[], projectId?: string) => void;
  findTriageTabIdx: (projectName: string) => number;

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

  // Console behavior
  autoFocusOnInterrupt: boolean;
  setAutoFocusOnInterrupt: (v: boolean) => void;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      activeScreen: "console",
      setScreen: (screen) => set({ activeScreen: screen }),

      tabs: [],
      activeTabIdx: 0,
      paneMenuOpenIdx: -1,
      focusedPaneIdx: -1,
      fullscreenPaneIdx: -1,
      consoleBroadcast: false,
      setConsoleBroadcast: (v) => set({ consoleBroadcast: v }),
      terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
      setTerminalFontSize: (size) => set({ terminalFontSize: clampFontSize(size) }),
      paneViews: [],
      paneNames: {},
      paneCwds: {},
      setPaneCwd: (paneId, cwd) =>
        set((s) => ({ paneCwds: { ...s.paneCwds, [paneId]: cwd } })),
      paneInitCmds: {},
      setPaneInitCmd: (paneId, cmd) =>
        set((s) => ({ paneInitCmds: { ...s.paneInitCmds, [paneId]: cmd } })),
      paneStartupPromptDocs: {},
      paneStartupPromptText: {},
      tabStartedAt: {},
      paneGitInfo: {},
      setPaneGitInfo: (paneId, info) =>
        set((s) => ({ paneGitInfo: { ...s.paneGitInfo, [paneId]: info } })),
      disabledPanes: {},
      setPaneDisabled: (paneId, disabled) =>
        set((s) => {
          const next = { ...s.disabledPanes };
          if (disabled) next[paneId] = true; else delete next[paneId];
          return { disabledPanes: next };
        }),
      // Switching tabs clears focus/fullscreen/menu — these are positional and
      // global, so a stale index from the previous tab would mis-target features
      // like broadcast (excluding a console that isn't actually focused).
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
          if (tabs.length === 0) return { tabs, activeTabIdx: 0 };
          let activeTabIdx = s.activeTabIdx;
          if (idx < s.activeTabIdx) activeTabIdx -= 1;
          else if (idx === s.activeTabIdx) activeTabIdx = Math.min(activeTabIdx, tabs.length - 1);
          return { tabs, activeTabIdx };
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
          // Trim cwds and git info keyed by "t{tabIdx}p{n}"
          const paneCwds = { ...s.paneCwds };
          const paneGitInfo = { ...s.paneGitInfo };
          const isExcess = (key: string) => {
            const m = key.match(/^t(\d+)p(\d+)$/);
            return m && Number(m[1]) === tabIdx && Number(m[2]) >= newCount;
          };
          Object.keys(paneCwds).forEach((key) => { if (isExcess(key)) delete paneCwds[key]; });
          Object.keys(paneGitInfo).forEach((key) => { if (isExcess(key)) delete paneGitInfo[key]; });
          return {
            tabs,
            paneNames: { ...s.paneNames, [tabIdx]: tabPaneNames },
            paneCwds,
            paneGitInfo,
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
        githubUser: null,
        githubRepos: [],
        activeRepoName: "",
      }),

      automationsTab: "schedules",
      setAutomationsTab: (tab) => set({ automationsTab: tab }),

      settingsSection: "github",
      setSettingsSection: (section) => set({ settingsSection: section }),

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
        set({ activeProjectId: id, activeProjectName: name, activeProjectRepo: repo, activeProjectNumber: number, activeProjectRepos: repos }),
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
      projectsDrawerIssue: null,
      setProjectsDrawerIssue: (n) => set({ projectsDrawerIssue: n }),
      planningPitch: "",
      planningRepo: "",
      planningTitle: "",
      setPlanningContext: (pitch, repo) => set({ planningPitch: pitch, planningRepo: repo }),
      setPlanningTitle: (title) => set({ planningTitle: title }),
      planningSessionKey: "",
      setPlanningSession: (key) => set({ planningSessionKey: key }),
      bscBaseDir: "",
      setBscBaseDir: (dir) => set({ bscBaseDir: dir }),
      projectLocalRepos: {},
      addProjectRepo: (projectId, fullName) =>
        set((s) => {
          const existing = s.projectLocalRepos[projectId] ?? [];
          if (existing.includes(fullName)) return {};
          return { projectLocalRepos: { ...s.projectLocalRepos, [projectId]: [...existing, fullName] } };
        }),
      quickStartProject: (projectName, repos, projectId = "") =>
        set((s) => {
          if (repos.length === 0) return { activeScreen: "console" as Screen };
          const newTabIdx = s.tabs.length;
          const count = Math.min(repos.length, 4);
          const layout = count <= 1 ? "1×1" : count === 2 ? "2×1" : "2×2";
          const [cols, rows] = layout.split("×").map(Number);
          const paneCount = cols * rows;
          const newPaneCwds      = { ...s.paneCwds };
          const newPaneInitCmds  = { ...s.paneInitCmds };
          const newPaneStartupPromptDocs = { ...s.paneStartupPromptDocs };
          const newPaneAllowedCommands   = { ...s.paneAllowedCommands };
          const newDisabledPanes = { ...s.disabledPanes };
          const tabPaneNames: Record<number, string> = {};
          const assignments = {
            defaultStartupPromptDoc: s.defaultStartupPromptDoc,
            projectStartupPromptDoc: s.projectStartupPromptDoc,
            repoStartupPromptDoc:    s.repoStartupPromptDoc,
          };
          for (let i = 0; i < paneCount; i++) {
            const pid = `t${newTabIdx}p${i}`;
            if (i < count) {
              const fullName = repos[i];
              newPaneCwds[pid] = projectRepoCwd(s.bscBaseDir, projectName, fullName);
              tabPaneNames[i] = fullName.split("/")[1] ?? fullName;
              // claude launches with the resolved startup prompt baked in by the
              // backend (reliable: claude submits it itself). The doc assignment
              // is "" = the built-in plan prompt, or a relpath to a per-repo /
              // project kickoff script. initCmd just marks this a claude pane so
              // the launch gate engages.
              newPaneInitCmds[pid] = "claude";
              newPaneStartupPromptDocs[pid] = resolveStartupPromptDoc(assignments, projectId, fullName) ?? "";
              newPaneAllowedCommands[pid] = resolveAllowedCommands(
                s.allowedCommands,
                s.projectAllowedCommands[projectId],
                s.repoAllowedCommands[repoPromptKey(projectId, fullName)],
              );
              delete newDisabledPanes[pid];
            } else {
              // Empty grid cell (e.g. 3 repos in a 2×2) — start it disabled so it
              // doesn't spawn an idle shell or add rendering load.
              newDisabledPanes[pid] = true;
            }
          }
          const newTab: Tab = { name: projectName, layout, state: "idle" };
          return {
            tabs: [...s.tabs, newTab],
            activeTabIdx: newTabIdx,
            focusedPaneIdx: -1,
            fullscreenPaneIdx: -1,
            paneMenuOpenIdx: -1,
            paneCwds: newPaneCwds,
            paneInitCmds: newPaneInitCmds,
            paneStartupPromptDocs: newPaneStartupPromptDocs,
            paneAllowedCommands: newPaneAllowedCommands,
            tabStartedAt: { ...s.tabStartedAt, [newTabIdx]: Date.now() },
            disabledPanes: newDisabledPanes,
            paneNames: { ...s.paneNames, [newTabIdx]: tabPaneNames },
            activeScreen: "console" as Screen,
          };
        }),
      findTriageTabIdx: (projectName) => {
        const tabName = `${projectName} · triage`;
        return get().tabs.findIndex((t) => t.name === tabName);
      },
      triageStartProject: (projectName, repos, projectId = "") =>
        set((s) => {
          // If a triage tab for this project already exists, switch to it.
          const tabName = `${projectName} · triage`;
          const existingIdx = s.tabs.findIndex((t) => t.name === tabName);
          if (existingIdx >= 0) {
            return { activeTabIdx: existingIdx, focusedPaneIdx: -1, fullscreenPaneIdx: -1, paneMenuOpenIdx: -1, activeScreen: "console" as Screen };
          }
          if (repos.length === 0) return {};
          const newTabIdx = s.tabs.length;
          const count = Math.min(repos.length, 16);
          const cols = count <= 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
          const rows = Math.ceil(count / cols);
          const layout = `${cols}×${rows}`;
          const newPaneCwds     = { ...s.paneCwds };
          const newPaneInitCmds = { ...s.paneInitCmds };
          const newPaneStartupPromptDocs = { ...s.paneStartupPromptDocs };
          const newPaneStartupPromptText = { ...s.paneStartupPromptText };
          const newPaneAllowedCommands   = { ...s.paneAllowedCommands };
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
              delete newDisabledPanes[key];
            } else {
              // Empty grid cell (more cells than repos) — start it disabled so it
              // doesn't spawn an idle shell or add rendering load.
              newDisabledPanes[key] = true;
            }
          }
          const newTab: Tab = { name: `${projectName} · triage`, layout, state: "idle" };
          return {
            tabs: [...s.tabs, newTab],
            activeTabIdx: newTabIdx,
            focusedPaneIdx: -1,
            fullscreenPaneIdx: -1,
            paneMenuOpenIdx: -1,
            paneCwds:     newPaneCwds,
            paneInitCmds: newPaneInitCmds,
            paneStartupPromptDocs: newPaneStartupPromptDocs,
            paneStartupPromptText: newPaneStartupPromptText,
            paneAllowedCommands: newPaneAllowedCommands,
            tabStartedAt: { ...s.tabStartedAt, [newTabIdx]: Date.now() },
            disabledPanes: newDisabledPanes,
            paneNames: { ...s.paneNames, [newTabIdx]: tabPaneNames },
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

      autoFocusOnInterrupt: true,
      setAutoFocusOnInterrupt: (v) => set({ autoFocusOnInterrupt: v }),
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
        disabledPanes:   s.disabledPanes,
        githubConnected: s.githubConnected,
        githubToken:     s.githubToken,
        githubUser:      s.githubUser,
        githubRepos:     s.githubRepos,
        activeRepoName:  s.activeRepoName,
        githubActiveTab: s.githubActiveTab,
        automationsTab:  s.automationsTab,
        settingsSection: s.settingsSection,
        kbBlocks:        s.kbBlocks,
        claudeApiKey:    s.claudeApiKey,
        schedules:            s.schedules,
        commands:             s.commands,
        allowedCommands:      s.allowedCommands,
        projectAllowedCommands: s.projectAllowedCommands,
        repoAllowedCommands:    s.repoAllowedCommands,
        autoFocusOnInterrupt: s.autoFocusOnInterrupt,
        projectLocalRepos:    s.projectLocalRepos,
        defaultStartupPromptDoc: s.defaultStartupPromptDoc,
        projectStartupPromptDoc: s.projectStartupPromptDoc,
        repoStartupPromptDoc:    s.repoStartupPromptDoc,
        repoTriagePromptDoc:     s.repoTriagePromptDoc,
        configProfiles:       s.configProfiles,
        planSections:          s.planSections,
        planConfirmedSections: s.planConfirmedSections,
        planKbAssignments:     s.planKbAssignments,
        planAutomations:       s.planAutomations,
      }),
    }
  )
);
