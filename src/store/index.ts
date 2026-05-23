import { create } from "zustand";
import type { Screen } from "../components/chrome/Rail";
import type { Tab } from "../components/chrome/Tabstrip";
import type { ViewKey } from "../components/pane/ViewTabs";

interface AppStore {
  // Navigation
  activeScreen: Screen;
  setScreen: (screen: Screen) => void;

  // Console
  tabs: Tab[];
  activeTabIdx: number;
  paneMenuOpenIdx: number;
  focusedPaneIdx: number;
  fullscreenPaneIdx: number;
  paneViews: ViewKey[];
  setActiveTab: (idx: number) => void;
  setPaneMenu: (idx: number) => void;
  setFocusedPane: (idx: number) => void;
  setFullscreenPane: (idx: number) => void;
  setPaneView: (idx: number, view: ViewKey) => void;
  setAllPanesView: (view: ViewKey) => void;

  // GitHub
  githubConnected: boolean;
  githubActiveTab: "overview" | "actions" | "hooks";
  setGithubTab: (tab: AppStore["githubActiveTab"]) => void;

  // Automations
  automationsTab: "schedules" | "commands" | "history";
  setAutomationsTab: (tab: AppStore["automationsTab"]) => void;

  // Settings
  settingsSection: string;
  setSettingsSection: (section: string) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  activeScreen: "console",
  setScreen: (screen) => set({ activeScreen: screen }),

  tabs: [
    { name: "orchestrator", layout: "3×3", state: "run" },
    { name: "feat/tunnel",  layout: "2×2", state: "on"  },
    { name: "scratch",      layout: "1×1", state: "idle" },
  ],
  activeTabIdx: 0,
  paneMenuOpenIdx: -1,
  focusedPaneIdx: -1,
  fullscreenPaneIdx: -1,
  // Initial views match CELLS order: console,files,changes,branches,console,console,log,console,console
  paneViews: ["console", "files", "changes", "branches", "console", "console", "log", "console", "console"],
  setActiveTab:      (idx) => set({ activeTabIdx: idx }),
  setPaneMenu:       (idx) => set({ paneMenuOpenIdx: idx }),
  setFocusedPane:    (idx) => set({ focusedPaneIdx: idx }),
  setFullscreenPane: (idx) => set({ fullscreenPaneIdx: idx }),
  setPaneView: (idx, view) =>
    set((s) => { const v = [...s.paneViews]; v[idx] = view; return { paneViews: v }; }),
  setAllPanesView: (view) =>
    set((s) => ({ paneViews: s.paneViews.map(() => view) })),

  githubConnected: true,
  githubActiveTab: "overview",
  setGithubTab: (tab) => set({ githubActiveTab: tab }),

  automationsTab: "schedules",
  setAutomationsTab: (tab) => set({ automationsTab: tab }),

  settingsSection: "github",
  setSettingsSection: (section) => set({ settingsSection: section }),
}));
