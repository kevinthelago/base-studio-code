import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Screen } from "../components/chrome/Rail";
import type { Tab } from "../components/chrome/Tabstrip";
import type { ViewKey } from "../components/pane/ViewTabs";
import type { KbBlock, Schedule, Command } from "../data/mock";
import { persistStorage } from "../lib/storage";

export interface GithubUser {
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface ResolvedRepo {
  full_name: string;
  local_path: string;
  source: "found" | "cloned";
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
  paneViews: ViewKey[];
  paneNames: Record<number, Record<number, string>>;
  paneCwds: Record<string, string>;  // keyed by "t{tabIdx}p{paneIdx}"
  setPaneCwd: (paneId: string, cwd: string) => void;
  paneGitInfo: Record<string, { repo: string; branch: string; dirty: boolean } | null>;
  setPaneGitInfo: (paneId: string, info: { repo: string; branch: string; dirty: boolean } | null) => void;
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
  projectsView: "list" | "board" | "planning";
  setProjectsView: (v: "list" | "board" | "planning") => void;
  activeProjectId: string | null;
  activeProjectName: string;
  activeProjectRepo: string;
  activeProjectRepos: string[];
  activeProjectNumber: number;
  setActiveProject: (id: string | null) => void;
  setActiveProjectMeta: (id: string | null, name: string, repo: string, number: number, repos?: string[]) => void;
  projectsBoardTab: "board" | "roadmap" | "issues" | "insights";
  setProjectsBoardTab: (t: "board" | "roadmap" | "issues" | "insights") => void;
  projectsDrawerIssue: number | null;
  setProjectsDrawerIssue: (n: number | null) => void;
  planningPitch: string;
  planningRepo: string;
  setPlanningContext: (pitch: string, repo: string) => void;
  // Repository resolution (persisted)
  projectLocalRepos: Record<string, ResolvedRepo[]>;
  addProjectLocalRepo: (projectId: string, repo: ResolvedRepo) => void;
  quickStartProject: (projectName: string, repos: ResolvedRepo[]) => void;

  // Agent settings
  allowedCommands: string[];
  addAllowedCommand: (cmd: string) => void;
  removeAllowedCommand: (cmd: string) => void;
  setAllowedCommands: (commands: string[]) => void;

  // Console behavior
  autoFocusOnInterrupt: boolean;
  setAutoFocusOnInterrupt: (v: boolean) => void;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      activeScreen: "console",
      setScreen: (screen) => set({ activeScreen: screen }),

      tabs: [],
      activeTabIdx: 0,
      paneMenuOpenIdx: -1,
      focusedPaneIdx: -1,
      fullscreenPaneIdx: -1,
      paneViews: [],
      paneNames: {},
      paneCwds: {},
      setPaneCwd: (paneId, cwd) =>
        set((s) => ({ paneCwds: { ...s.paneCwds, [paneId]: cwd } })),
      paneGitInfo: {},
      setPaneGitInfo: (paneId, info) =>
        set((s) => ({ paneGitInfo: { ...s.paneGitInfo, [paneId]: info } })),
      setActiveTab: (idx) => set({ activeTabIdx: idx }),
      addTab: (tab) =>
        set((s) => ({
          tabs: [...s.tabs, tab],
          activeTabIdx: s.tabs.length,
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
      projectsBoardTab: "board",
      setProjectsBoardTab: (t) => set({ projectsBoardTab: t }),
      projectsDrawerIssue: null,
      setProjectsDrawerIssue: (n) => set({ projectsDrawerIssue: n }),
      planningPitch: "",
      planningRepo: "",
      setPlanningContext: (pitch, repo) => set({ planningPitch: pitch, planningRepo: repo }),
      projectLocalRepos: {},
      addProjectLocalRepo: (projectId, repo) =>
        set((s) => {
          const existing = s.projectLocalRepos[projectId] ?? [];
          const updated = [...existing.filter((r) => r.full_name !== repo.full_name), repo];
          return { projectLocalRepos: { ...s.projectLocalRepos, [projectId]: updated } };
        }),
      quickStartProject: (projectName, repos) =>
        set((s) => {
          if (repos.length === 0) return { activeScreen: "console" as Screen };
          const newTabIdx = s.tabs.length;
          const count = Math.min(repos.length, 4);
          const layout = count <= 1 ? "1×1" : count === 2 ? "2×1" : "2×2";
          const newPaneCwds = { ...s.paneCwds };
          const tabPaneNames: Record<number, string> = {};
          repos.slice(0, 4).forEach((repo, i) => {
            newPaneCwds[`t${newTabIdx}p${i}`] = repo.local_path;
            tabPaneNames[i] = repo.full_name.split("/")[1] ?? repo.full_name;
          });
          const newTab: Tab = { name: projectName, layout, state: "idle" };
          return {
            tabs: [...s.tabs, newTab],
            activeTabIdx: newTabIdx,
            paneCwds: newPaneCwds,
            paneNames: { ...s.paneNames, [newTabIdx]: tabPaneNames },
            activeScreen: "console" as Screen,
          };
        }),

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
        paneViews:       s.paneViews,
        paneNames:       s.paneNames,
        paneCwds:        s.paneCwds,
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
        autoFocusOnInterrupt: s.autoFocusOnInterrupt,
        projectLocalRepos:    s.projectLocalRepos,
      }),
    }
  )
);
