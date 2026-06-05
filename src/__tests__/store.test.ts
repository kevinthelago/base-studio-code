import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore, TRIAGE_PROMPT } from "../store";
import type { ViewKey } from "../components/pane/ViewTabs";
import type { QueuedPane } from "../lib/focusQueue";
import type { FleetPlan } from "../screens/projects/planSections";
import type { ExtensionDef } from "../lib/extensions";
import { defaultStageConfig } from "../screens/projects/planStages";
import { makeBlueprints } from "../screens/projects/blueprints";

const RESET_STATE = {
  tabs: [
    { name: "orchestrator", layout: "3×3", state: "run" as const },
    { name: "feat/tunnel",  layout: "2×2", state: "on"  as const },
    { name: "scratch",      layout: "1×1", state: "idle" as const },
  ],
  activeTabIdx: 0,
  paneMenuOpenIdx: -1,
  focusedPaneIdx: -1,
  fullscreenPaneIdx: -1,
  focusQueue: [] as QueuedPane[],
  paneViews: [] as ViewKey[],
  paneNames: {} as Record<number, Record<number, string>>,
  paneCwds: {} as Record<string, string>,
  paneInitCmds: {} as Record<string, string>,
  disabledPanes: {} as Record<string, boolean>,
  kbBlocks: [],
  schedules: [],
  commands: [],
  allowedCommands: [] as string[],
  deniedCommands: [] as string[],
  projectAllowedCommands: {} as Record<string, string[]>,
  repoAllowedCommands: {} as Record<string, string[]>,
  paneAllowedCommands: {} as Record<string, string[]>,
  autoAdvanceOnReply: true,
  terminalFontSize: 12,
  focusedAgentName: "",
  githubConnected: false,
  githubToken: "",
  githubUser: null,
  githubRepos: [],
  activeRepoName: "",
  projectsView: "list" as "list" | "planning",
  activeProjectId: null as string | null,
  activeProjectName: "",
  activeProjectRepo: "",
  activeProjectRepos: [] as string[],
  activeProjectNumber: 0,
  projectsDrawerIssue: null as number | null,
  planningPitch: "",
  planningRepo: "",
  projectLocalRepos: {} as Record<string, string[]>,
  issueLinks: {} as Record<string, Record<string, { number: number; url: string }>>,
  hiddenProjectIds: [] as string[],
  configProfiles: [] as import("../store").ConfigProfile[],
  paneStartupPromptDocs: {} as Record<string, string>,
  paneStartupPromptText: {} as Record<string, string>,
  paneCheckpointDocs: {} as Record<string, string>,
  paneContinue: {} as Record<string, boolean>,
  bscBaseDir: "",
  defaultStartupPromptDoc: null as string | null,
  projectStartupPromptDoc: {} as Record<string, string | null>,
  repoStartupPromptDoc: {} as Record<string, string | null>,
  repoTriagePromptDoc: {} as Record<string, string | null>,
  kbProjectScope: null as { keys: string[]; label: string } | null,
};

beforeEach(() => {
  useAppStore.setState(RESET_STATE);
});

// ── Hydration gate ──────────────────────────────────────────────────────────────

describe("hydration", () => {
  it("setHasHydrated flips the flag (gates the first paint until persisted state loads)", () => {
    useAppStore.setState({ hasHydrated: false });
    expect(useAppStore.getState().hasHydrated).toBe(false);
    useAppStore.getState().setHasHydrated(true);
    expect(useAppStore.getState().hasHydrated).toBe(true);
  });
});

// ── Terminal font zoom ──────────────────────────────────────────────────────────

describe("terminal font zoom", () => {
  it("defaults to the baseline font size", () => {
    expect(useAppStore.getState().terminalFontSize).toBe(12);
  });

  it("setTerminalFontSize stores an in-range value", () => {
    useAppStore.getState().setTerminalFontSize(16);
    expect(useAppStore.getState().terminalFontSize).toBe(16);
  });

  it("setTerminalFontSize clamps out-of-range values", () => {
    useAppStore.getState().setTerminalFontSize(2);
    expect(useAppStore.getState().terminalFontSize).toBe(8);
    useAppStore.getState().setTerminalFontSize(99);
    expect(useAppStore.getState().terminalFontSize).toBe(28);
  });
});

// ── Focus queue ─────────────────────────────────────────────────────────────────

describe("focus queue", () => {
  it("enqueueFocus appends (deduped) waiting panes — explicitly per-tab (#77)", () => {
    const s = useAppStore.getState();
    s.enqueueFocus(0, 2);
    s.enqueueFocus(0, 2);            // dup ignored
    s.enqueueFocus(0, 4);
    // Same pane index on a different tab is a distinct entry — the queue is
    // global across tabs (a background-tab idle still joins).
    s.enqueueFocus(1, 2);
    expect(useAppStore.getState().focusQueue).toEqual([
      { tab: 0, pane: 2 }, { tab: 0, pane: 4 }, { tab: 1, pane: 2 },
    ]);
  });

  it("removeFocus targets the (tab, pane) you name — not the active tab implicitly", () => {
    useAppStore.setState({ focusQueue: [{ tab: 0, pane: 2 }, { tab: 1, pane: 2 }] });
    useAppStore.getState().removeFocus(1, 2);
    expect(useAppStore.getState().focusQueue).toEqual([{ tab: 0, pane: 2 }]);
  });

  it("advanceFocus cycles to the next waiting pane WITHOUT dequeuing", () => {
    useAppStore.setState({ focusQueue: [{ tab: 0, pane: 5 }, { tab: 0, pane: 6 }, { tab: 0, pane: 7 }], focusedPaneIdx: 5, fullscreenPaneIdx: -1 });
    useAppStore.getState().advanceFocus();
    expect(useAppStore.getState().focusedPaneIdx).toBe(6);
    expect(useAppStore.getState().focusQueue).toEqual([{ tab: 0, pane: 5 }, { tab: 0, pane: 6 }, { tab: 0, pane: 7 }]); // stays queued until you respond
    expect(useAppStore.getState().fullscreenPaneIdx).toBe(-1);
  });

  it("advanceFocus starts at the front when you're not on a queued pane", () => {
    useAppStore.setState({ focusQueue: [{ tab: 0, pane: 5 }, { tab: 0, pane: 6 }], focusedPaneIdx: 0, fullscreenPaneIdx: -1 });
    useAppStore.getState().advanceFocus();
    expect(useAppStore.getState().focusedPaneIdx).toBe(5);
  });

  it("advanceFocus swaps the maximized pane, relative to the maximized one", () => {
    useAppStore.setState({ focusQueue: [{ tab: 0, pane: 5 }, { tab: 0, pane: 6 }, { tab: 0, pane: 7 }], focusedPaneIdx: 5, fullscreenPaneIdx: 5 });
    useAppStore.getState().advanceFocus();
    expect(useAppStore.getState().focusedPaneIdx).toBe(6);
    expect(useAppStore.getState().fullscreenPaneIdx).toBe(6);
    expect(useAppStore.getState().focusQueue).toEqual([{ tab: 0, pane: 5 }, { tab: 0, pane: 6 }, { tab: 0, pane: 7 }]); // not dequeued
  });

  it("advanceFocus switches tabs when the next waiting pane is on another tab", () => {
    useAppStore.setState({ activeTabIdx: 0, focusQueue: [{ tab: 0, pane: 5 }, { tab: 1, pane: 2 }], focusedPaneIdx: 5, fullscreenPaneIdx: -1 });
    useAppStore.getState().advanceFocus();
    expect(useAppStore.getState().activeTabIdx).toBe(1);
    expect(useAppStore.getState().focusedPaneIdx).toBe(2);
    expect(useAppStore.getState().fullscreenPaneIdx).toBe(-1);
  });

  it("advanceFocus carries maximize across a tab switch", () => {
    useAppStore.setState({ activeTabIdx: 0, focusQueue: [{ tab: 0, pane: 5 }, { tab: 1, pane: 2 }], focusedPaneIdx: 5, fullscreenPaneIdx: 5 });
    useAppStore.getState().advanceFocus();
    expect(useAppStore.getState().activeTabIdx).toBe(1);
    expect(useAppStore.getState().focusedPaneIdx).toBe(2);
    expect(useAppStore.getState().fullscreenPaneIdx).toBe(2);
  });

  it("advanceFocus is a no-op when there's nowhere else to go", () => {
    useAppStore.setState({ focusQueue: [{ tab: 0, pane: 5 }], focusedPaneIdx: 5, fullscreenPaneIdx: -1 });
    useAppStore.getState().advanceFocus();
    expect(useAppStore.getState().focusedPaneIdx).toBe(5); // only queued pane is current
    useAppStore.setState({ focusQueue: [], focusedPaneIdx: 2 });
    useAppStore.getState().advanceFocus();
    expect(useAppStore.getState().focusedPaneIdx).toBe(2);
  });

  it("setActiveTab preserves the cross-tab queue", () => {
    useAppStore.setState({ focusQueue: [{ tab: 0, pane: 1 }, { tab: 0, pane: 2 }] });
    useAppStore.getState().setActiveTab(1);
    expect(useAppStore.getState().focusQueue).toEqual([{ tab: 0, pane: 1 }, { tab: 0, pane: 2 }]);
    expect(useAppStore.getState().focusedPaneIdx).toBe(-1); // focus still resets
  });

  it("setAutoAdvanceOnReply toggles the setting", () => {
    expect(useAppStore.getState().autoAdvanceOnReply).toBe(true);
    useAppStore.getState().setAutoAdvanceOnReply(false);
    expect(useAppStore.getState().autoAdvanceOnReply).toBe(false);
  });

  it("reconcileFocusQueue prunes panes across every tab whose waiting set is supplied (#77)", () => {
    useAppStore.setState({ focusQueue: [
      { tab: 0, pane: 1 }, { tab: 0, pane: 2 }, { tab: 0, pane: 3 },
      { tab: 1, pane: 5 }, { tab: 1, pane: 7 },
    ] });
    useAppStore.getState().reconcileFocusQueue(new Map([
      [0, new Set([1, 3])],
      [1, new Set([5])],
    ]));
    expect(useAppStore.getState().focusQueue).toEqual([
      { tab: 0, pane: 1 }, { tab: 0, pane: 3 }, { tab: 1, pane: 5 },
    ]);
  });

  it("reconcileFocusQueue leaves tabs absent from the map alone (no live data → no assumption)", () => {
    useAppStore.setState({ focusQueue: [{ tab: 0, pane: 1 }, { tab: 1, pane: 2 }] });
    useAppStore.getState().reconcileFocusQueue(new Map([[0, new Set<number>()]]));
    // Tab 0 has no waiting panes → its entries pruned. Tab 1 absent from map → kept.
    expect(useAppStore.getState().focusQueue).toEqual([{ tab: 1, pane: 2 }]);
  });
});

// ── Local project deletion ──────────────────────────────────────────────────────

describe("deleteLocalProject", () => {
  it("prunes per-project and repo-scoped state and resets active meta", () => {
    useAppStore.setState({
      planSections: { "My App": { goal: "x" }, Other: { goal: "y" } },
      planConfirmedSections: { "My App": ["goal"] },
      projectStartupPromptDoc: { "My App": "doc", Other: "z" },
      projectLocalRepos: { "My App": ["o/a"] },
      repoStartupPromptDoc: { "My App::o/a": "d", "Other::o/b": "e" },
      repoTriagePromptDoc: { "My App::o/a": "t" },
      repoAllowedCommands: { "My App::o/a": ["gh"] },
      activeProjectId: "PVT_id1",
      activeProjectName: "My App",
      projectsView: "planning",
    });
    // Pass both the session key (title) and the GitHub id.
    useAppStore.getState().deleteLocalProject(["My App", "PVT_id1"]);
    const s = useAppStore.getState();
    expect(s.planSections["My App"]).toBeUndefined();
    expect(s.planSections.Other).toBeDefined();          // other project untouched
    expect(s.planConfirmedSections["My App"]).toBeUndefined();
    expect(s.projectStartupPromptDoc["My App"]).toBeUndefined();
    expect(s.projectStartupPromptDoc.Other).toBe("z");
    expect(s.projectLocalRepos["My App"]).toBeUndefined();
    expect(s.repoStartupPromptDoc["My App::o/a"]).toBeUndefined();
    expect(s.repoStartupPromptDoc["Other::o/b"]).toBe("e"); // other project's repo kept
    expect(s.repoTriagePromptDoc["My App::o/a"]).toBeUndefined();
    expect(s.repoAllowedCommands["My App::o/a"]).toBeUndefined();
    // Active project meta cleared and view sent back to the list.
    expect(s.activeProjectId).toBeNull();
    expect(s.activeProjectName).toBe("");
    expect(s.projectsView).toBe("list");
  });

  it("leaves active meta alone when a different project is deleted", () => {
    useAppStore.setState({ activeProjectId: "keep", activeProjectName: "Keep", projectsView: "planning" });
    useAppStore.getState().deleteLocalProject(["Gone", "PVT_gone"]);
    expect(useAppStore.getState().activeProjectId).toBe("keep");
    expect(useAppStore.getState().projectsView).toBe("planning");
  });

  it("dismissProject records the id once (deduped) so syncs stay filtered", () => {
    useAppStore.getState().dismissProject("PVT_x");
    useAppStore.getState().dismissProject("PVT_x"); // dup ignored
    useAppStore.getState().dismissProject("PVT_y");
    useAppStore.getState().dismissProject("");      // empty ignored
    expect(useAppStore.getState().hiddenProjectIds).toEqual(["PVT_x", "PVT_y"]);
  });
});

// ── Project key alias ───────────────────────────────────────

describe("projectKeyAlias", () => {
  it("setActiveProjectMeta binds the GitHub node id to the title key (first-write-wins)", () => {
    useAppStore.setState({ projectKeyAlias: {} });
    useAppStore.getState().setActiveProjectMeta("PVT_n1", "studio-code", "o/r", 16, ["o/r"]);
    expect(useAppStore.getState().projectKeyAlias["PVT_n1"]).toBe("studio-code");
    // A later sighting under a renamed title must NOT clobber the working alias.
    useAppStore.getState().setActiveProjectMeta("PVT_n1", "Studio Code Redux", "o/r", 16, ["o/r"]);
    expect(useAppStore.getState().projectKeyAlias["PVT_n1"]).toBe("studio-code");
  });

  it("does not record an alias when there is no node id (unpublished draft)", () => {
    useAppStore.setState({ projectKeyAlias: {} });
    useAppStore.getState().setActiveProjectMeta(null, "", "", 0);
    expect(useAppStore.getState().projectKeyAlias).toEqual({});
  });

  it("setProjectKeyAlias records when absent and ignores empties / overwrites", () => {
    useAppStore.setState({ projectKeyAlias: {} });
    useAppStore.getState().setProjectKeyAlias("PVT_a", "my-app");
    useAppStore.getState().setProjectKeyAlias("PVT_a", "renamed"); // ignored, already set
    useAppStore.getState().setProjectKeyAlias("", "x");           // ignored, empty id
    expect(useAppStore.getState().projectKeyAlias).toEqual({ "PVT_a": "my-app" });
  });

  it("deleteLocalProject prunes the alias entry for the removed project", () => {
    useAppStore.setState({ projectKeyAlias: { "PVT_gone": "gone", "PVT_keep": "keep" } });
    useAppStore.getState().deleteLocalProject(["gone", "PVT_gone"]);
    const a = useAppStore.getState().projectKeyAlias;
    expect(a["PVT_gone"]).toBeUndefined();
    expect(a["PVT_keep"]).toBe("keep");
  });
});

// ── Dev reset ─────────────────────────

describe("resetProjectData", () => {
  it("clears project/plan state but keeps credentials", () => {
    useAppStore.setState({
      planSections: { P: { goal: "x" } },
      planConfirmedSections: { P: ["goal"] },
      projectLocalRepos: { P: ["o/r"] },
      hiddenProjectIds: ["PVT_x"],
      projectKeyAlias: { PVT_x: "P" },
      activeProjectId: "PVT_x", activeProjectName: "P",
      planningSessionKey: "P", projectsView: "planning",
      githubToken: "tok", claudeApiKey: "key",
    });
    useAppStore.getState().resetProjectData();
    const s = useAppStore.getState();
    expect(s.planSections).toEqual({});
    expect(s.planConfirmedSections).toEqual({});
    expect(s.projectLocalRepos).toEqual({});
    expect(s.hiddenProjectIds).toEqual([]);
    expect(s.projectKeyAlias).toEqual({});
    expect(s.activeProjectId).toBeNull();
    expect(s.planningSessionKey).toBe("");
    expect(s.projectsView).toBe("list");
    // credentials are NOT a project concern -> preserved
    expect(s.githubToken).toBe("tok");
    expect(s.claudeApiKey).toBe("key");
  });
});

// ── Tab management ────────────────────────────────────────────────────────────

describe("tab management", () => {
  it("starts with 3 default tabs", () => {
    expect(useAppStore.getState().tabs).toHaveLength(3);
    expect(useAppStore.getState().activeTabIdx).toBe(0);
  });

  it("addTab appends and activates the new tab", () => {
    useAppStore.getState().addTab({ name: "new-tab", layout: "1×1", state: "idle" });
    const { tabs, activeTabIdx } = useAppStore.getState();
    expect(tabs).toHaveLength(4);
    expect(tabs[3].name).toBe("new-tab");
    expect(activeTabIdx).toBe(3);
  });

  it("setActiveTab updates activeTabIdx", () => {
    useAppStore.getState().setActiveTab(2);
    expect(useAppStore.getState().activeTabIdx).toBe(2);
  });

  it("closeTab removes the tab", () => {
    useAppStore.getState().closeTab(1);
    const { tabs } = useAppStore.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs.map(t => t.name)).toEqual(["orchestrator", "scratch"]);
  });

  it("closeTab adjusts activeTabIdx when closing a tab before the active one", () => {
    useAppStore.getState().setActiveTab(2);
    useAppStore.getState().closeTab(0);
    expect(useAppStore.getState().activeTabIdx).toBe(1);
  });

  it("closeTab clamps activeTabIdx when closing the last tab", () => {
    useAppStore.getState().setActiveTab(2);
    useAppStore.getState().closeTab(2);
    expect(useAppStore.getState().activeTabIdx).toBe(1);
  });

  it("closeTab allows closing the last tab, resulting in empty state", () => {
    useAppStore.setState({ tabs: [{ name: "only", layout: "1×1", state: "idle" }], activeTabIdx: 0 });
    useAppStore.getState().closeTab(0);
    expect(useAppStore.getState().tabs).toHaveLength(0);
    expect(useAppStore.getState().activeTabIdx).toBe(0);
  });

  it("setTabState updates a tab's state", () => {
    useAppStore.getState().setTabState(0, "run");
    expect(useAppStore.getState().tabs[0].state).toBe("run");
    useAppStore.getState().setTabState(0, "idle");
    expect(useAppStore.getState().tabs[0].state).toBe("idle");
  });

  it("setTabState does not affect other tabs", () => {
    useAppStore.getState().setTabState(1, "run");
    expect(useAppStore.getState().tabs[0].state).toBe("run");  // orchestrator starts as "run"
    expect(useAppStore.getState().tabs[1].state).toBe("run");
    expect(useAppStore.getState().tabs[2].state).toBe("idle");
  });

  it("moveTab reorders tabs and remaps all index-keyed pane state (#461)", () => {
    useAppStore.setState({
      tabs: [
        { name: "A", layout: "1×1", state: "idle" },
        { name: "B", layout: "1×1", state: "idle" },
        { name: "C", layout: "1×1", state: "idle" },
      ],
      activeTabIdx: 0,
      paneNames: { 0: { 0: "a0" }, 1: { 0: "b0" }, 2: { 0: "c0" } },
      paneCwds: { "t0p0": "/a", "t1p0": "/b", "t2p0": "/c" },
      paneStatus: { "t0p0": "run", "t2p0": "idle" },
      disabledPanes: { "t1p0": true },
      focusQueue: [{ tab: 2, pane: 0 }],
    });
    // Move A (0) to position 2 → order becomes [B, C, A].
    useAppStore.getState().moveTab(0, 2);
    const s = useAppStore.getState();
    expect(s.tabs.map(t => t.name)).toEqual(["B", "C", "A"]);
    // Active tab A followed its move to index 2.
    expect(s.activeTabIdx).toBe(2);
    // Pane state followed: A's pane is now t2, B's is t0, C's is t1.
    expect(s.paneNames[2][0]).toBe("a0");
    expect(s.paneNames[0][0]).toBe("b0");
    expect(s.paneCwds["t2p0"]).toBe("/a");
    expect(s.paneCwds["t0p0"]).toBe("/b");
    expect(s.paneStatus["t2p0"]).toBe("run");
    expect(s.disabledPanes["t0p0"]).toBe(true); // B (was t1) → t0
    expect(s.focusQueue).toEqual([{ tab: 1, pane: 0 }]); // C (was tab 2) → tab 1
  });

  it("moveTab is a no-op for from===to or out-of-range", () => {
    useAppStore.setState({
      tabs: [{ name: "A", layout: "1×1", state: "idle" }, { name: "B", layout: "1×1", state: "idle" }],
      activeTabIdx: 0,
    });
    useAppStore.getState().moveTab(1, 1);
    expect(useAppStore.getState().tabs.map(t => t.name)).toEqual(["A", "B"]);
    useAppStore.getState().moveTab(0, 9);
    expect(useAppStore.getState().tabs.map(t => t.name)).toEqual(["A", "B"]);
  });
});

// ── Pane state ────────────────────────────────────────────────────────────────

describe("pane state", () => {
  it("setPaneName stores name by tab+pane index", () => {
    useAppStore.getState().setPaneName(0, 2, "my-agent");
    expect(useAppStore.getState().paneNames[0][2]).toBe("my-agent");
  });

  it("setPaneName preserves existing names in the same tab", () => {
    useAppStore.getState().setPaneName(0, 0, "agent-a");
    useAppStore.getState().setPaneName(0, 1, "agent-b");
    const names = useAppStore.getState().paneNames[0];
    expect(names[0]).toBe("agent-a");
    expect(names[1]).toBe("agent-b");
  });

  it("setPaneCwd stores working directory by pane ID", () => {
    useAppStore.getState().setPaneCwd("t0p0", "/home/user/project");
    expect(useAppStore.getState().paneCwds["t0p0"]).toBe("/home/user/project");
  });

  it("setPaneMenu tracks which pane has the menu open", () => {
    useAppStore.getState().setPaneMenu(3);
    expect(useAppStore.getState().paneMenuOpenIdx).toBe(3);
    useAppStore.getState().setPaneMenu(-1);
    expect(useAppStore.getState().paneMenuOpenIdx).toBe(-1);
  });

  it("setFocusedPane tracks focused pane index", () => {
    useAppStore.getState().setFocusedPane(1);
    expect(useAppStore.getState().focusedPaneIdx).toBe(1);
  });

  it("setFullscreenPane tracks fullscreen pane index", () => {
    useAppStore.getState().setFullscreenPane(2);
    expect(useAppStore.getState().fullscreenPaneIdx).toBe(2);
  });

  it("setPaneDisabled marks a pane disabled and clears it on enable", () => {
    useAppStore.getState().setPaneDisabled("t0p1", true);
    expect(useAppStore.getState().disabledPanes["t0p1"]).toBe(true);
    useAppStore.getState().setPaneDisabled("t0p1", false);
    expect(useAppStore.getState().disabledPanes["t0p1"]).toBeUndefined();
  });

  it("setPaneDisabled keeps other panes untouched", () => {
    useAppStore.getState().setPaneDisabled("t0p0", true);
    useAppStore.getState().setPaneDisabled("t0p2", true);
    expect(Object.keys(useAppStore.getState().disabledPanes).sort()).toEqual(["t0p0", "t0p2"]);
  });

  it("setPaneView updates a single pane's view", () => {
    useAppStore.setState({ paneViews: ["console", "console", "console"] });
    useAppStore.getState().setPaneView(1, "files");
    const { paneViews } = useAppStore.getState();
    expect(paneViews[0]).toBe("console");
    expect(paneViews[1]).toBe("files");
    expect(paneViews[2]).toBe("console");
  });

  it("setAllPanesView sets every pane to the same view", () => {
    useAppStore.setState({ paneViews: ["console", "files", "branches"] });
    useAppStore.getState().setAllPanesView("log");
    expect(useAppStore.getState().paneViews).toEqual(["log", "log", "log"]);
  });

  it("setFocusedAgentName updates breadcrumb label", () => {
    useAppStore.getState().setFocusedAgentName("my-agent");
    expect(useAppStore.getState().focusedAgentName).toBe("my-agent");
  });
});

// ── Knowledge blocks ──────────────────────────────────────────────────────────

describe("knowledge blocks", () => {
  it("addKbBlock appends a block with a unique id", () => {
    useAppStore.getState().addKbBlock();
    useAppStore.getState().addKbBlock();
    const { kbBlocks } = useAppStore.getState();
    expect(kbBlocks).toHaveLength(2);
    expect(kbBlocks[0].id).not.toBe(kbBlocks[1].id);
  });

  it("addKbBlock creates block with default title and empty content", () => {
    useAppStore.getState().addKbBlock();
    const block = useAppStore.getState().kbBlocks[0];
    expect(block.title).toBe("Untitled block");
    expect(block.content).toBe("");
    expect(block.tags).toEqual([]);
  });

  it("removeKbBlock removes by id", () => {
    useAppStore.getState().addKbBlock();
    useAppStore.getState().addKbBlock();
    const id = useAppStore.getState().kbBlocks[0].id;
    useAppStore.getState().removeKbBlock(id);
    expect(useAppStore.getState().kbBlocks).toHaveLength(1);
    expect(useAppStore.getState().kbBlocks[0].id).not.toBe(id);
  });

  it("renameKbBlock updates the title", () => {
    useAppStore.getState().addKbBlock();
    const { id } = useAppStore.getState().kbBlocks[0];
    useAppStore.getState().renameKbBlock(id, "My Block");
    expect(useAppStore.getState().kbBlocks[0].title).toBe("My Block");
  });

  it("updateKbBlockContent updates content and recounts lines", () => {
    useAppStore.getState().addKbBlock();
    const { id } = useAppStore.getState().kbBlocks[0];
    useAppStore.getState().updateKbBlockContent(id, "line 1\nline 2\nline 3");
    const block = useAppStore.getState().kbBlocks[0];
    expect(block.content).toBe("line 1\nline 2\nline 3");
    expect(block.lines).toBe(3);
  });

  it("applyKbTag adds a tag to a block", () => {
    useAppStore.getState().addKbBlock();
    const { id } = useAppStore.getState().kbBlocks[0];
    useAppStore.getState().applyKbTag(id, "rust");
    expect(useAppStore.getState().kbBlocks[0].tags).toContain("rust");
  });

  it("applyKbTag does not add duplicate tags", () => {
    useAppStore.getState().addKbBlock();
    const { id } = useAppStore.getState().kbBlocks[0];
    useAppStore.getState().applyKbTag(id, "rust");
    useAppStore.getState().applyKbTag(id, "rust");
    expect(useAppStore.getState().kbBlocks[0].tags).toHaveLength(1);
  });

  it("removeKbTag removes a specific tag", () => {
    useAppStore.getState().addKbBlock();
    const { id } = useAppStore.getState().kbBlocks[0];
    useAppStore.getState().applyKbTag(id, "rust");
    useAppStore.getState().applyKbTag(id, "react");
    useAppStore.getState().removeKbTag(id, "rust");
    const { tags } = useAppStore.getState().kbBlocks[0];
    expect(tags).not.toContain("rust");
    expect(tags).toContain("react");
  });
});

// ── Allowed commands ──────────────────────────────────────────────────────────

describe("allowed commands", () => {
  it("addAllowedCommand appends a command", () => {
    useAppStore.getState().addAllowedCommand("git status");
    expect(useAppStore.getState().allowedCommands).toContain("git status");
  });

  it("addAllowedCommand ignores duplicates", () => {
    useAppStore.getState().addAllowedCommand("cargo test");
    useAppStore.getState().addAllowedCommand("cargo test");
    expect(useAppStore.getState().allowedCommands).toHaveLength(1);
  });

  it("removeAllowedCommand removes a specific command", () => {
    useAppStore.getState().addAllowedCommand("npm run dev");
    useAppStore.getState().addAllowedCommand("cargo build");
    useAppStore.getState().removeAllowedCommand("npm run dev");
    const { allowedCommands } = useAppStore.getState();
    expect(allowedCommands).not.toContain("npm run dev");
    expect(allowedCommands).toContain("cargo build");
  });

  it("setAllowedCommands replaces the full list", () => {
    useAppStore.getState().addAllowedCommand("old");
    useAppStore.getState().setAllowedCommands(["new-a", "new-b"]);
    expect(useAppStore.getState().allowedCommands).toEqual(["new-a", "new-b"]);
  });

  it("add/removeDeniedCommand manages the global block list (lowercased, deduped)", () => {
    useAppStore.getState().addDeniedCommand("SCP");
    useAppStore.getState().addDeniedCommand("scp"); // dup ignored
    expect(useAppStore.getState().deniedCommands).toEqual(["scp"]);
    useAppStore.getState().removeDeniedCommand("scp");
    expect(useAppStore.getState().deniedCommands).toEqual([]);
  });

  it("add/removeProjectAllowedCommand scopes to a project and lowercases", () => {
    useAppStore.getState().addProjectAllowedCommand("P1", "Cargo");
    expect(useAppStore.getState().projectAllowedCommands["P1"]).toEqual(["cargo"]);
    useAppStore.getState().addProjectAllowedCommand("P1", "cargo"); // dup ignored
    expect(useAppStore.getState().projectAllowedCommands["P1"]).toEqual(["cargo"]);
    useAppStore.getState().removeProjectAllowedCommand("P1", "cargo");
    expect(useAppStore.getState().projectAllowedCommands["P1"]).toEqual([]);
  });

  it("addRepoAllowedCommand scopes to a project::repo key", () => {
    useAppStore.getState().addRepoAllowedCommand("P1", "acme/web", "npm");
    expect(useAppStore.getState().repoAllowedCommands["P1::acme/web"]).toEqual(["npm"]);
  });
});

// ── Automations ───────────────────────────────────────────────────────────────

describe("schedules", () => {
  it("addSchedule appends a new schedule with default values", () => {
    useAppStore.getState().addSchedule();
    const { schedules } = useAppStore.getState();
    expect(schedules).toHaveLength(1);
    expect(schedules[0].name).toBe("New schedule");
    expect(schedules[0].on).toBe(false);
  });

  it("updateSchedule patches an existing schedule", () => {
    useAppStore.getState().addSchedule();
    const { id } = useAppStore.getState().schedules[0];
    useAppStore.getState().updateSchedule(id, { name: "Nightly build", on: true });
    const schedule = useAppStore.getState().schedules[0];
    expect(schedule.name).toBe("Nightly build");
    expect(schedule.on).toBe(true);
  });

  it("removeSchedule deletes by id", () => {
    useAppStore.getState().addSchedule();
    useAppStore.getState().addSchedule();
    const { id } = useAppStore.getState().schedules[0];
    useAppStore.getState().removeSchedule(id);
    expect(useAppStore.getState().schedules).toHaveLength(1);
    expect(useAppStore.getState().schedules[0].id).not.toBe(id);
  });
});

describe("commands", () => {
  it("addCommand appends a new command with empty cmd", () => {
    useAppStore.getState().addCommand();
    const { commands } = useAppStore.getState();
    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe("New command");
    expect(commands[0].cmd).toBe("");
  });

  it("updateCommand patches fields", () => {
    useAppStore.getState().addCommand();
    const { id } = useAppStore.getState().commands[0];
    useAppStore.getState().updateCommand(id, { name: "Deploy", cmd: "cargo tauri build" });
    const cmd = useAppStore.getState().commands[0];
    expect(cmd.name).toBe("Deploy");
    expect(cmd.cmd).toBe("cargo tauri build");
  });

  it("removeCommand deletes by id", () => {
    useAppStore.getState().addCommand();
    const { id } = useAppStore.getState().commands[0];
    useAppStore.getState().removeCommand(id);
    expect(useAppStore.getState().commands).toHaveLength(0);
  });
});

// ── Projects navigation ───────────────────────────────────────────────────────

describe("projects navigation", () => {
  it("defaults to list view", () => {
    expect(useAppStore.getState().projectsView).toBe("list");
  });

  it("setProjectsView switches to planning", () => {
    useAppStore.getState().setProjectsView("planning");
    expect(useAppStore.getState().projectsView).toBe("planning");
  });

  it("setActiveProject stores a project id", () => {
    useAppStore.getState().setActiveProject("prj_31a");
    expect(useAppStore.getState().activeProjectId).toBe("prj_31a");
  });

  it("setActiveProject(null) clears selection", () => {
    useAppStore.getState().setActiveProject("prj_31a");
    useAppStore.getState().setActiveProject(null);
    expect(useAppStore.getState().activeProjectId).toBeNull();
  });


  it("setProjectsDrawerIssue opens the drawer", () => {
    useAppStore.getState().setProjectsDrawerIssue(418);
    expect(useAppStore.getState().projectsDrawerIssue).toBe(418);
  });

  it("setProjectsDrawerIssue(null) closes the drawer", () => {
    useAppStore.getState().setProjectsDrawerIssue(418);
    useAppStore.getState().setProjectsDrawerIssue(null);
    expect(useAppStore.getState().projectsDrawerIssue).toBeNull();
  });

  it("setActiveProjectMeta stores id, name, repo, and number together", () => {
    useAppStore.getState().setActiveProjectMeta("PVT_kwAbc123", "Settlement webhooks v2", "acme/payments", 14);
    const { activeProjectId, activeProjectName, activeProjectRepo, activeProjectNumber } = useAppStore.getState();
    expect(activeProjectId).toBe("PVT_kwAbc123");
    expect(activeProjectName).toBe("Settlement webhooks v2");
    expect(activeProjectRepo).toBe("acme/payments");
    expect(activeProjectNumber).toBe(14);
  });

  it("setActiveProjectMeta stores all repos when provided", () => {
    const repos = ["acme/api", "acme/ui"];
    useAppStore.getState().setActiveProjectMeta("PVT_kwAbc123", "My project", "acme/api", 3, repos);
    expect(useAppStore.getState().activeProjectRepos).toEqual(repos);
  });

  it("setActiveProjectMeta defaults repos to empty array when omitted", () => {
    useAppStore.getState().setActiveProjectMeta("PVT_kwAbc123", "My project", "acme/api", 3);
    expect(useAppStore.getState().activeProjectRepos).toEqual([]);
  });

  it("setActiveProjectMeta(null) clears the active project", () => {
    useAppStore.getState().setActiveProjectMeta("PVT_kwAbc123", "My project", "org/repo", 5);
    useAppStore.getState().setActiveProjectMeta(null, "", "", 0);
    const { activeProjectId, activeProjectName, activeProjectRepo, activeProjectNumber } = useAppStore.getState();
    expect(activeProjectId).toBeNull();
    expect(activeProjectName).toBe("");
    expect(activeProjectRepo).toBe("");
    expect(activeProjectNumber).toBe(0);
  });

  it("setPlanningContext stores pitch and repo", () => {
    useAppStore.getState().setPlanningContext("Build a mobile auth SDK", "acme/mobile");
    expect(useAppStore.getState().planningPitch).toBe("Build a mobile auth SDK");
    expect(useAppStore.getState().planningRepo).toBe("acme/mobile");
  });

  it("setPlanningContext can clear the context", () => {
    useAppStore.getState().setPlanningContext("something", "org/repo");
    useAppStore.getState().setPlanningContext("", "");
    expect(useAppStore.getState().planningPitch).toBe("");
    expect(useAppStore.getState().planningRepo).toBe("");
  });
});

// ── Repository resolution ─────────────────────────────────────────────────────

describe("repository resolution", () => {
  it("addProjectRepo stores a full_name under the project id", () => {
    useAppStore.getState().addProjectRepo("prj_1", "acme/api");
    expect(useAppStore.getState().projectLocalRepos["prj_1"]).toEqual(["acme/api"]);
  });

  it("addProjectRepo is idempotent: duplicate full_names are ignored", () => {
    useAppStore.getState().addProjectRepo("prj_1", "acme/api");
    useAppStore.getState().addProjectRepo("prj_1", "acme/api");
    expect(useAppStore.getState().projectLocalRepos["prj_1"]).toHaveLength(1);
  });

  it("addProjectRepo keeps existing repos for the same project", () => {
    useAppStore.getState().addProjectRepo("prj_1", "acme/api");
    useAppStore.getState().addProjectRepo("prj_1", "acme/ui");
    expect(useAppStore.getState().projectLocalRepos["prj_1"]).toHaveLength(2);
  });

  it("addProjectRepo keeps other projects untouched", () => {
    useAppStore.getState().addProjectRepo("prj_1", "acme/api");
    useAppStore.getState().addProjectRepo("prj_2", "other/repo");
    expect(useAppStore.getState().projectLocalRepos["prj_1"]).toHaveLength(1);
    expect(useAppStore.getState().projectLocalRepos["prj_2"]).toHaveLength(1);
  });
});

// ── Triage ────────────────────────────────────────────────────────────────────

describe("triageStartProject", () => {
  it("launches a pane per repo (cwd under projects/<key>) and disables the empty grid cells", () => {
    useAppStore.setState({ bscBaseDir: "/base" });
    const before = useAppStore.getState().tabs.length;
    // 5 repos → 3×2 grid = 6 cells, so the 6th cell (index 5) is empty.
    const repos = ["o/a", "o/b", "o/c", "o/d", "o/e"];
    useAppStore.getState().triageStartProject("proj", repos);

    const { tabs, activeTabIdx, paneCwds, paneInitCmds, disabledPanes } = useAppStore.getState();
    expect(tabs[activeTabIdx].layout).toBe("3×2");

    const { paneRepos } = useAppStore.getState();
    // The 5 real repos are wired up (clone path) and left enabled.
    for (let i = 0; i < repos.length; i++) {
      const key = `t${before}p${i}`;
      expect(paneCwds[key]).toBe(`/base/projects/proj/${repos[i].split("/")[1]}`);
      expect(paneInitCmds[key]).toContain("claude");
      expect(disabledPanes[key]).toBeUndefined();
      // Bound to its repo so the triage session's GH_TOKEN is repo-scoped (#158).
      expect(paneRepos[key]).toBe(repos[i]);
    }
    // The single empty cell starts disabled (no shell spawned).
    expect(disabledPanes[`t${before}p5`]).toBe(true);
    expect(paneCwds[`t${before}p5`]).toBeUndefined();
    expect(paneRepos[`t${before}p5`]).toBeUndefined();
  });

  it("marks each real-repo pane to resume its prior conversation (--continue)", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().triageStartProject("cont", ["o/a", "o/b"]);
    const { paneContinue } = useAppStore.getState();
    expect(paneContinue[`t${before}p0`]).toBe(true);
    expect(paneContinue[`t${before}p1`]).toBe(true);
  });

  it("assigns a per-repo triage checkpoint doc to each real-repo pane", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().triageStartProject("ckpt", ["o/web", "o/api"]);
    const { paneCheckpointDocs } = useAppStore.getState();
    expect(paneCheckpointDocs[`t${before}p0`]).toBe("projects/ckpt/prompts/web-checkpoint.md");
    expect(paneCheckpointDocs[`t${before}p1`]).toBe("projects/ckpt/prompts/api-checkpoint.md");
  });

  it("re-runs in place: reuses the existing triage tab and bumps its runId", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().triageStartProject("rerun", ["o/a", "o/b"]);
    const idx = useAppStore.getState().tabs.length - 1;
    expect(idx).toBe(before);
    expect(useAppStore.getState().tabs[idx].runId).toBe(0);

    // Pressing triage again rebuilds the SAME tab (no new tab) with a bumped runId,
    // which remounts the panes so killed sessions relaunch.
    useAppStore.getState().triageStartProject("rerun", ["o/a", "o/b"]);
    expect(useAppStore.getState().tabs.length).toBe(before + 1); // no new tab added
    expect(useAppStore.getState().tabs[idx].runId).toBe(1);
    expect(useAppStore.getState().activeTabIdx).toBe(idx);
  });

  it("disables no cells when the grid is exactly filled", () => {
    const before = useAppStore.getState().tabs.length;
    // 4 repos → 2×2 grid = 4 cells, no empties.
    useAppStore.getState().triageStartProject("full", ["o/a", "o/b", "o/c", "o/d"]);

    const { disabledPanes } = useAppStore.getState();
    for (let i = 0; i < 4; i++) {
      expect(disabledPanes[`t${before}p${i}`]).toBeUndefined();
    }
  });

  it("clears stale disabled state on the reused tab index for real repos", () => {
    const before = useAppStore.getState().tabs.length;
    // Simulate a leftover disabled flag on a pane id this triage tab will reuse.
    useAppStore.setState({ disabledPanes: { [`t${before}p0`]: true } });
    useAppStore.getState().triageStartProject("reuse", ["o/a", "o/b"]);

    expect(useAppStore.getState().disabledPanes[`t${before}p0`]).toBeUndefined();
  });

  it("sets the verbatim triage prompt text on every triage pane", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().triageStartProject("proj", ["o/a", "o/b"], "P1");
    const { paneStartupPromptText } = useAppStore.getState();
    expect(paneStartupPromptText[`t${before}p0`]).toBe(TRIAGE_PROMPT);
    expect(paneStartupPromptText[`t${before}p1`]).toBe(TRIAGE_PROMPT);
  });

  it("defaults every triage pane's doc prompt to the built-in default ('')", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().triageStartProject("proj", ["o/a", "o/b"], "P1");
    const { paneStartupPromptDocs } = useAppStore.getState();
    expect(paneStartupPromptDocs[`t${before}p0`]).toBe("");
    expect(paneStartupPromptDocs[`t${before}p1`]).toBe("");
  });

  it("resolves each pane's doc startup prompt (repo override > project default)", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.setState({
      projectStartupPromptDoc: { P1: "user/p1.md" },
      repoStartupPromptDoc: { "P1::o/b": "user/b.md" },
    });
    useAppStore.getState().triageStartProject("proj", ["o/a", "o/b"], "P1");
    const { paneStartupPromptDocs } = useAppStore.getState();
    // o/a → project default; o/b → its repo override.
    expect(paneStartupPromptDocs[`t${before}p0`]).toBe("user/p1.md");
    expect(paneStartupPromptDocs[`t${before}p1`]).toBe("user/b.md");
  });

  it("uses a per-repo triage script (doc) and skips the verbatim prompt for that pane", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.setState({
      repoTriagePromptDoc: { "P1::o/b": "projects/P1/prompts/b-triage.md" },
    });
    useAppStore.getState().triageStartProject("proj", ["o/a", "o/b"], "P1");
    const { paneStartupPromptDocs, paneStartupPromptText } = useAppStore.getState();
    // o/a has no triage doc → verbatim prompt; o/b → its triage doc, no verbatim text.
    expect(paneStartupPromptText[`t${before}p0`]).toBe(TRIAGE_PROMPT);
    expect(paneStartupPromptDocs[`t${before}p1`]).toBe("projects/P1/prompts/b-triage.md");
    expect(paneStartupPromptText[`t${before}p1`]).toBeUndefined();
  });

  it("resolves each triage pane's allowed commands as global ∪ project ∪ repo", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.setState({
      allowedCommands: ["docker"],
      projectAllowedCommands: { P1: ["cargo"] },
      repoAllowedCommands: { "P1::o/b": ["npm"] },
    });
    useAppStore.getState().triageStartProject("proj", ["o/a", "o/b"], "P1");
    const { paneAllowedCommands } = useAppStore.getState();
    // o/a: global + project; o/b: global + project + its own repo command.
    expect(paneAllowedCommands[`t${before}p0`]).toEqual(["docker", "cargo"]);
    expect(paneAllowedCommands[`t${before}p1`]).toEqual(["docker", "cargo", "npm"]);
  });
});

describe("startup prompt assignment setters", () => {
  it("store a relpath at each level, keyed for the resolver", () => {
    const s = useAppStore.getState();
    s.setDefaultStartupPromptDoc("user/g.md");
    s.setProjectStartupPromptDoc("P1", "user/p.md");
    s.setRepoStartupPromptDoc("P1", "o/a", "user/r.md");
    const st = useAppStore.getState();
    expect(st.defaultStartupPromptDoc).toBe("user/g.md");
    expect(st.projectStartupPromptDoc["P1"]).toBe("user/p.md");
    expect(st.repoStartupPromptDoc["P1::o/a"]).toBe("user/r.md");
  });

  it("stores a per-repo triage script relpath keyed for the resolver", () => {
    useAppStore.getState().setRepoTriagePromptDoc("P1", "o/a", "projects/P1/prompts/a-triage.md");
    expect(useAppStore.getState().repoTriagePromptDoc["P1::o/a"]).toBe("projects/P1/prompts/a-triage.md");
  });

  it("null clears an override (inherit)", () => {
    useAppStore.getState().setProjectStartupPromptDoc("P1", "user/p.md");
    useAppStore.getState().setProjectStartupPromptDoc("P1", null);
    expect(useAppStore.getState().projectStartupPromptDoc["P1"]).toBeNull();
  });
});

// ── Config profiles ───────────────────────────────────────────────────────────

describe("config profiles", () => {
  const makeProfile = (name: string) => ({
    name,
    instructions: `# ${name}`,
    tools: { allow: ["Read"], deny: ["Bash"] },
    kbBlockIds: [],
  });

  it("addConfigProfile appends with a unique id", () => {
    useAppStore.getState().addConfigProfile(makeProfile("review-mode"));
    useAppStore.getState().addConfigProfile(makeProfile("full-access"));
    const { configProfiles } = useAppStore.getState();
    expect(configProfiles).toHaveLength(2);
    expect(configProfiles[0].id).not.toBe(configProfiles[1].id);
    expect(configProfiles[0].name).toBe("review-mode");
  });

  it("addConfigProfile stores instructions and tools", () => {
    useAppStore.getState().addConfigProfile(makeProfile("my-profile"));
    const p = useAppStore.getState().configProfiles[0];
    expect(p.instructions).toBe("# my-profile");
    expect(p.tools.allow).toEqual(["Read"]);
    expect(p.tools.deny).toEqual(["Bash"]);
  });

  it("updateConfigProfile patches the matching profile", () => {
    useAppStore.getState().addConfigProfile(makeProfile("original"));
    const { id } = useAppStore.getState().configProfiles[0];
    useAppStore.getState().updateConfigProfile(id, { name: "updated", tools: { allow: [], deny: [] } });
    const p = useAppStore.getState().configProfiles[0];
    expect(p.name).toBe("updated");
    expect(p.tools.allow).toEqual([]);
    expect(p.instructions).toBe("# original"); // unpatched fields preserved
  });

  it("updateConfigProfile does not affect other profiles", () => {
    useAppStore.getState().addConfigProfile(makeProfile("a"));
    useAppStore.getState().addConfigProfile(makeProfile("b"));
    const idA = useAppStore.getState().configProfiles[0].id;
    useAppStore.getState().updateConfigProfile(idA, { name: "a-updated" });
    expect(useAppStore.getState().configProfiles[1].name).toBe("b");
  });

  it("removeConfigProfile deletes by id", () => {
    useAppStore.getState().addConfigProfile(makeProfile("keep"));
    useAppStore.getState().addConfigProfile(makeProfile("delete-me"));
    const { id } = useAppStore.getState().configProfiles[1];
    useAppStore.getState().removeConfigProfile(id);
    const { configProfiles } = useAppStore.getState();
    expect(configProfiles).toHaveLength(1);
    expect(configProfiles[0].name).toBe("keep");
  });

  it("addConfigProfile stores kbBlockIds", () => {
    useAppStore.getState().addConfigProfile({ ...makeProfile("p"), kbBlockIds: ["blk_1", "blk_2"] });
    const p = useAppStore.getState().configProfiles[0];
    expect(p.kbBlockIds).toEqual(["blk_1", "blk_2"]);
  });
});

// ── GitHub ────────────────────────────────────────────────────────────────────

describe("github state", () => {
  it("setGithubToken stores the token", () => {
    useAppStore.getState().setGithubToken("ghp_abc123");
    expect(useAppStore.getState().githubToken).toBe("ghp_abc123");
  });

  it("setGithubConnected marks as connected", () => {
    useAppStore.getState().setGithubConnected(true);
    expect(useAppStore.getState().githubConnected).toBe(true);
  });

  it("disconnectGithub clears all github state", () => {
    useAppStore.getState().setGithubToken("tok");
    useAppStore.getState().setGithubConnected(true);
    useAppStore.getState().setGithubUser({ login: "kevin", name: "Kevin", avatar_url: "x" });
    useAppStore.getState().disconnectGithub();
    const { githubConnected, githubToken, githubUser, githubRepos } = useAppStore.getState();
    expect(githubConnected).toBe(false);
    expect(githubToken).toBe("");
    expect(githubUser).toBeNull();
    expect(githubRepos).toHaveLength(0);
  });

  it("setActiveRepo stores the selected repo name", () => {
    useAppStore.getState().setActiveRepo("kevinthelago/base-studio-code");
    expect(useAppStore.getState().activeRepoName).toBe("kevinthelago/base-studio-code");
  });
});

describe("agent fleet store", () => {
  const fleet: FleetPlan = {
    recommended: 2,
    reasoning: "r",
    director: { enabled: true, role: "integrator" },
    streams: [
      { id: "auth-ui", name: "Auth UI", repo: "own/web", owns: ["src/auth/**"], issues: ["#1"], dependsOn: [], prompt: "prompts/auth-ui-kickoff.md" },
      { id: "api", name: "API", repo: "own/api", owns: [], issues: [], dependsOn: [] },
    ],
  };

  it("setPlanFleet / add (merge by id) / remove / setPlanDirector manage the per-project fleet", () => {
    const s = useAppStore.getState();
    s.setPlanFleet("p", fleet);
    expect(useAppStore.getState().planFleet["p"].streams).toHaveLength(2);

    s.addPlanAgentStream("p", { id: "auth-ui", name: "Auth UI v2", repo: "own/web", owns: [], issues: [], dependsOn: [] });
    expect(useAppStore.getState().planFleet["p"].streams).toHaveLength(2);
    expect(useAppStore.getState().planFleet["p"].streams.find(x => x.id === "auth-ui")!.name).toBe("Auth UI v2");

    s.removePlanAgentStream("p", "api");
    expect(useAppStore.getState().planFleet["p"].streams.map(x => x.id)).toEqual(["auth-ui"]);

    s.setPlanDirector("p", false);
    expect(useAppStore.getState().planFleet["p"].director.enabled).toBe(false);
    expect(useAppStore.getState().planFleet["p"].director.role).toBe("integrator");
  });

  it("fleetStartProject opens a build tab with the director and worker panes", () => {
    useAppStore.setState({ bscBaseDir: "/base" });
    useAppStore.getState().fleetStartProject("Proj", fleet, "proj-key");
    const st = useAppStore.getState();
    const idx = st.findFleetTabIdx("proj-key"); // found by stable projectKey, not name (#457)
    expect(idx).toBe(3);
    expect(st.tabs[idx].name).toBe("Proj · build");
    expect(st.tabs[idx].projectKey).toBe("proj-key");
    expect(st.tabs[idx].kind).toBe("build");
    expect(st.tabs[idx].layout).toBe("2×2"); // director + 2 workers = 3 panes

    // pane 0 = director at the project hub, doc-based kickoff
    expect(st.paneCwds["t3p0"]).toBe("/base/projects/proj-key");
    expect(st.paneStartupPromptDocs["t3p0"]).toBe("projects/proj-key/prompts/director-kickoff.md");
    expect(st.paneNames[idx][0]).toBe("director");

    // pane 1 = first worker in its OWN git worktree, planner-authored kickoff doc
    expect(st.paneCwds["t3p1"]).toBe("/base/projects/proj-key/.worktrees/web--auth-ui");
    expect(st.paneStartupPromptDocs["t3p1"]).toBe("projects/proj-key/prompts/auth-ui-kickoff.md");
    expect(st.paneNames[idx][1]).toBe("Auth UI");

    // pane 2 = second worker (own worktree) with no kickoff doc → generated text
    expect(st.paneCwds["t3p2"]).toBe("/base/projects/proj-key/.worktrees/api--api");
    expect(st.paneStartupPromptText["t3p2"]).toContain("API");

    // worker write boundary (#354): the stream's owned globs feed the role gate so
    // edits in its lane auto-approve; the director (code:none) gets none.
    expect(st.paneRoleGlobs["t3p1"]).toEqual(["src/auth/**"]);
    expect(st.paneRoleGlobs["t3p0"]).toBeUndefined();
    expect(st.paneRoleGlobs["t3p2"]).toBeUndefined();

    // repo-scoped session credentials (#158): each worker pane is bound to its repo
    // so TerminalView scopes its GH_TOKEN to that repo; the director spans every repo
    // and stays on the global token (no binding).
    expect(st.paneRepos["t3p1"]).toBe("own/web");
    expect(st.paneRepos["t3p2"]).toBe("own/api");
    expect(st.paneRepos["t3p0"]).toBeUndefined();

    // per-agent checkpoint docs, keyed by stream id (director gets its own)
    expect(st.paneCheckpointDocs["t3p0"]).toBe("projects/proj-key/prompts/director-checkpoint.md");
    expect(st.paneCheckpointDocs["t3p1"]).toBe("projects/proj-key/prompts/auth-ui-checkpoint.md");
    expect(st.paneCheckpointDocs["t3p2"]).toBe("projects/proj-key/prompts/api-checkpoint.md");
    // first launch starts fresh — no --continue
    expect(st.paneContinue["t3p1"]).toBe(false);

    // empty grid cell starts disabled
    expect(st.disabledPanes["t3p3"]).toBe(true);

    // fleetPaneStreams bridges pane id → stream for the coordinator (#199 AC#7):
    // worker panes are recorded by their stream; the director + empty cells are not.
    expect(st.fleetPaneStreams["t3p1"].id).toBe("auth-ui");
    expect(st.fleetPaneStreams["t3p1"].owns).toEqual(["src/auth/**"]);
    expect(st.fleetPaneStreams["t3p2"].id).toBe("api");
    expect(st.fleetPaneStreams["t3p0"]).toBeUndefined(); // director pane
    expect(st.fleetPaneStreams["t3p3"]).toBeUndefined(); // empty cell
  });

  it("fleetStartProject normalizes a worker's owned dirs into subtree write globs", () => {
    useAppStore.setState({ bscBaseDir: "/base" });
    const dirFleet: FleetPlan = {
      recommended: 1, reasoning: "", director: { enabled: false },
      streams: [{ id: "w", name: "W", repo: "o/r", owns: ["src/x/", "src/y.ts"], issues: [], dependsOn: [] }],
    };
    useAppStore.getState().fleetStartProject("DirN", dirFleet, "k");
    const st = useAppStore.getState();
    const idx = st.findFleetTabIdx("k");
    // trailing-slash dir -> subtree glob; a file path is left as-is
    expect(st.paneRoleGlobs[`t${idx}p0`]).toEqual(["src/x/**", "src/y.ts"]);
  });

  it("generateFleetProfiles materializes unassigned and dangling-reference profiles", () => {
    const f: FleetPlan = {
      recommended: 2, reasoning: "", director: { enabled: false },
      streams: [
        { id: "a", name: "A", repo: "o/r", owns: ["src/a/**"], issues: [], dependsOn: [] },
        { id: "b", name: "B", repo: "o/r", owns: ["src/b/**"], issues: [], dependsOn: [], profile: "b-dev" },
      ],
    };
    useAppStore.setState({ planFleet: { gp: f } });
    useAppStore.getState().generateFleetProfiles("gp");
    const st = useAppStore.getState();
    const streams = st.planFleet["gp"].streams;
    // unassigned -> generated id + a profile whose write paths are its owns
    expect(streams[0].profile).toBe("gen_a");
    expect(st.agentProfiles.find((p) => p.id === "gen_a")!.paths.allow).toEqual(["src/a/**"]);
    // dangling reference -> materialized, keeping the planner-assigned id stable
    expect(streams[1].profile).toBe("b-dev");
    expect(st.agentProfiles.find((p) => p.id === "b-dev")!.paths.allow).toEqual(["src/b/**"]);
  });

  it("isolates co-located agents in separate worktrees with distinct checkpoint docs", () => {
    useAppStore.setState({ bscBaseDir: "/base" });
    const coFleet: FleetPlan = {
      recommended: 3, reasoning: "", director: { enabled: false },
      streams: [
        { id: "web-a", name: "Web A", repo: "own/web", owns: [], issues: [], dependsOn: [] },
        { id: "web-b", name: "Web B", repo: "own/web", owns: [], issues: [], dependsOn: [] },
        { id: "api",   name: "API",   repo: "own/api", owns: [], issues: [], dependsOn: [] },
      ],
    };
    useAppStore.getState().fleetStartProject("Co", coFleet, "k");
    const idx = useAppStore.getState().findFleetTabIdx("k");
    const st1 = useAppStore.getState();
    // Two agents in own/web get separate worktree cwds — no shared working tree.
    expect(st1.paneCwds[`t${idx}p0`]).toBe("/base/projects/k/.worktrees/web--web-a");
    expect(st1.paneCwds[`t${idx}p1`]).toBe("/base/projects/k/.worktrees/web--web-b");
    expect(st1.paneCwds[`t${idx}p2`]).toBe("/base/projects/k/.worktrees/api--api");
    // …and distinct per-agent checkpoint docs.
    expect(st1.paneCheckpointDocs[`t${idx}p0`]).toBe("projects/k/prompts/web-a-checkpoint.md");
    expect(st1.paneCheckpointDocs[`t${idx}p1`]).toBe("projects/k/prompts/web-b-checkpoint.md");
    expect(st1.paneCheckpointDocs[`t${idx}p2`]).toBe("projects/k/prompts/api-checkpoint.md");

    // Re-run → resume. Distinct worktree cwds make --continue unambiguous, so even
    // co-located agents resume (no co-location exception needed any more).
    useAppStore.getState().fleetStartProject("Co", coFleet, "k");
    const st2 = useAppStore.getState();
    expect(st2.paneContinue[`t${idx}p0`]).toBe(true);
    expect(st2.paneContinue[`t${idx}p1`]).toBe(true);
    expect(st2.paneContinue[`t${idx}p2`]).toBe(true);
  });

  it("spreads a fleet larger than one tab across multiple build tabs", () => {
    useAppStore.setState({ bscBaseDir: "/base" });
    const streams = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`, name: `S${i}`, repo: "own/web", owns: [], issues: [], dependsOn: [],
    }));
    const bigFleet: FleetPlan = { recommended: 20, reasoning: "", director: { enabled: false }, streams };
    useAppStore.getState().fleetStartProject("Big", bigFleet, "big");
    const st = useAppStore.getState();
    const idx = st.findFleetTabIdx("big");
    // 20 workers → 16 in tab 1, 4 in tab 2.
    expect(st.tabs[idx].name).toBe("Big · build");
    expect(st.tabs[idx].layout).toBe("4×4");
    expect(st.tabs[idx + 1].name).toBe("Big · build 2");
    expect(st.tabs[idx + 1].layout).toBe("2×2");
    // tab 2's first pane is the 17th worker (s16), in its own worktree.
    expect(st.paneNames[idx + 1][0]).toBe("S16");
    expect(st.paneCwds[`t${idx + 1}p0`]).toBe("/base/projects/big/.worktrees/web--s16");
  });

  it("fleetStartProject caps launched workers at the recommended count", () => {
    useAppStore.setState({ bscBaseDir: "/base" });
    useAppStore.getState().fleetStartProject("Cap", { ...fleet, recommended: 1 }, "k");
    const st = useAppStore.getState();
    const idx = st.findFleetTabIdx("k");
    expect(st.tabs[idx].layout).toBe("2×1"); // 1 worker + director = 2 panes
    expect(st.paneNames[idx][0]).toBe("director");
    expect(st.paneNames[idx][1]).toBe("Auth UI");
    expect(st.paneNames[idx][2]).toBeUndefined();
  });

  // #457 — the "two directors" bug: a project rename froze tab.name, so the
  // reuse lookup (by name) missed the existing tab and forked a duplicate
  // "· build" tab with its own director. Matching on the stable projectKey fixes it.
  it("reuses the SAME build tab across a project rename (no duplicate director) and relabels it", () => {
    useAppStore.setState({ bscBaseDir: "/base" });
    const before = useAppStore.getState().tabs.length;
    // Launch for "Alpha" under a stable key.
    useAppStore.getState().fleetStartProject("Alpha", fleet, "stable-key");
    const idx = useAppStore.getState().findFleetTabIdx("stable-key");
    expect(useAppStore.getState().tabs.length).toBe(before + 1);
    expect(useAppStore.getState().tabs[idx].name).toBe("Alpha · build");
    expect(useAppStore.getState().tabs[idx].runId).toBe(0);

    // Rename the project (display name changes, key is stable) and relaunch.
    useAppStore.getState().fleetStartProject("Beta", fleet, "stable-key");
    const after = useAppStore.getState();
    // No new tab — same index reused, runId bumped so panes remount.
    expect(after.tabs.length).toBe(before + 1);
    expect(after.findFleetTabIdx("stable-key")).toBe(idx);
    expect(after.tabs[idx].runId).toBe(1);
    // Label tracks the current project name; key unchanged.
    expect(after.tabs[idx].name).toBe("Beta · build");
    expect(after.tabs[idx].projectKey).toBe("stable-key");
    // Exactly one director pane exists for this project (no fork).
    const buildTabs = after.tabs.filter(t => t.projectKey === "stable-key" && t.kind === "build");
    expect(buildTabs).toHaveLength(1);
  });

  it("reuses each overflow build tab by (projectKey, seq) across a rename", () => {
    useAppStore.setState({ bscBaseDir: "/base" });
    const streams = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`, name: `S${i}`, repo: "own/web", owns: [], issues: [], dependsOn: [],
    }));
    const big: FleetPlan = { recommended: 20, reasoning: "", director: { enabled: false }, streams };
    useAppStore.getState().fleetStartProject("Big", big, "bigkey");
    const lenAfterFirst = useAppStore.getState().tabs.length;
    const idx = useAppStore.getState().findFleetTabIdx("bigkey");
    expect(useAppStore.getState().tabs[idx + 1].seq).toBe(1);

    // Relaunch under a new display name, same key → both tabs reused in place.
    useAppStore.getState().fleetStartProject("Renamed", big, "bigkey");
    const st = useAppStore.getState();
    expect(st.tabs.length).toBe(lenAfterFirst);
    expect(st.tabs[idx].name).toBe("Renamed · build");
    expect(st.tabs[idx + 1].name).toBe("Renamed · build 2");
    expect(st.tabs.filter(t => t.projectKey === "bigkey" && t.kind === "build")).toHaveLength(2);
  });

  it("sets a stable projectKey + kind on triage tabs and reuses across a rename", () => {
    const before = useAppStore.getState().tabs.length;
    // projectId is the stable identity; the display name drifts.
    useAppStore.getState().triageStartProject("Alpha", ["o/a", "o/b"], "PID1");
    const idx = useAppStore.getState().findTriageTabIdx("Alpha", "PID1");
    expect(idx).toBe(before);
    expect(useAppStore.getState().tabs[idx].kind).toBe("triage");
    expect(useAppStore.getState().tabs[idx].projectKey).toBe("PID1");

    // Rename (name → "Beta", same projectId) reuses the tab in place.
    useAppStore.getState().triageStartProject("Beta", ["o/a", "o/b"], "PID1");
    const st = useAppStore.getState();
    expect(st.tabs.length).toBe(before + 1);
    expect(st.findTriageTabIdx("Beta", "PID1")).toBe(idx);
    expect(st.tabs[idx].name).toBe("Beta · triage");
    expect(st.tabs[idx].runId).toBe(1);
  });
});

describe("pane status — store single source of truth (#435)", () => {
  it("setPaneStatus records the status and rolls it up to tab.state", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().addTab({ name: "ps-a", layout: "2×2" });
    const idx = before;
    useAppStore.getState().clearTabStatuses(idx); // isolate from shared-store state
    useAppStore.getState().setPaneStatus(`t${idx}p0`, "on");
    expect(useAppStore.getState().paneStatus[`t${idx}p0`]).toBe("on");
    expect(useAppStore.getState().tabs[idx].state).toBe("on");
    // Any running pane dominates the rollup.
    useAppStore.getState().setPaneStatus(`t${idx}p1`, "run");
    expect(useAppStore.getState().tabs[idx].state).toBe("run");
    // Back to idle when every live pane is idle.
    useAppStore.getState().setPaneStatus(`t${idx}p0`, "idle");
    useAppStore.getState().setPaneStatus(`t${idx}p1`, "idle");
    expect(useAppStore.getState().tabs[idx].state).toBe("idle");
  });

  it("re-rolls the tab when a running pane is disabled (no stale 'run' dot)", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().addTab({ name: "ps-dis", layout: "2×2" });
    const idx = before;
    useAppStore.getState().clearTabStatuses(idx);
    useAppStore.getState().setPaneStatus(`t${idx}p0`, "run");
    expect(useAppStore.getState().tabs[idx].state).toBe("run");
    useAppStore.getState().setPaneDisabled(`t${idx}p0`, true);
    expect(useAppStore.getState().tabs[idx].state).toBe("idle");
  });

  it("re-rolls the tab on a layout shrink that trims a running pane", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().addTab({ name: "ps-layout", layout: "2×2" });
    const idx = before;
    useAppStore.getState().clearTabStatuses(idx);
    useAppStore.getState().setPaneStatus(`t${idx}p3`, "run");
    expect(useAppStore.getState().tabs[idx].state).toBe("run");
    useAppStore.getState().setTabLayout(idx, "1×1"); // trims pane 3 out of the grid
    expect(useAppStore.getState().tabs[idx].state).toBe("idle");
  });

  it("clearTabStatuses drops a tab's statuses and re-rolls it to idle (remount)", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().addTab({ name: "ps-clear", layout: "2×2" });
    const idx = before;
    useAppStore.getState().setPaneStatus(`t${idx}p0`, "run");
    useAppStore.getState().clearTabStatuses(idx);
    expect(useAppStore.getState().paneStatus[`t${idx}p0`]).toBeUndefined();
    expect(useAppStore.getState().tabs[idx].state).toBe("idle");
  });

  it("closeTab clears the closed tab's pane statuses", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().addTab({ name: "ps-close", layout: "2×2" });
    const idx = before;
    useAppStore.getState().setPaneStatus(`t${idx}p0`, "run");
    expect(useAppStore.getState().paneStatus[`t${idx}p0`]).toBe("run");
    useAppStore.getState().closeTab(idx);
    expect(useAppStore.getState().paneStatus[`t${idx}p0`]).toBeUndefined();
  });
});

describe("extensions store", () => {
  it("add (assigns id) / toggle / update / setProjects / remove", () => {
    useAppStore.setState({ extensions: [] });
    const s = useAppStore.getState();
    s.addExtension({ kind: "mcp", name: "fs", enabled: false, projects: [], transport: "stdio", command: "npx", args: "" });
    const id = useAppStore.getState().extensions[0].id;
    expect(useAppStore.getState().extensions).toHaveLength(1);
    expect(id).toMatch(/^ext_/);
    s.toggleExtension(id);
    expect(useAppStore.getState().extensions[0].enabled).toBe(true);
    s.updateExtension(id, { command: "node" });
    expect(useAppStore.getState().extensions[0].command).toBe("node");
    s.setExtensionProjects(id, ["P1"]);
    expect(useAppStore.getState().extensions[0].projects).toEqual(["P1"]);
    s.removeExtension(id);
    expect(useAppStore.getState().extensions).toHaveLength(0);
  });

  it("fleetStartProject resolves only enabled global + this-project extensions onto panes", () => {
    const exts: ExtensionDef[] = [
      { id: "g",     kind: "mcp", name: "g", enabled: true,  projects: [] },
      { id: "p",     kind: "mcp", name: "p", enabled: true,  projects: ["proj-key"] },
      { id: "off",   kind: "mcp", name: "x", enabled: false, projects: [] },
      { id: "other", kind: "mcp", name: "o", enabled: true,  projects: ["zzz"] },
    ];
    useAppStore.setState({ bscBaseDir: "/base", extensions: exts });
    const fleet: FleetPlan = {
      recommended: 1, reasoning: "", director: { enabled: false },
      streams: [{ id: "s0", name: "S0", repo: "own/web", owns: [], issues: [], dependsOn: [] }],
    };
    useAppStore.getState().fleetStartProject("ExtP", fleet, "proj-key");
    const idx = useAppStore.getState().findFleetTabIdx("proj-key");
    const ids = (useAppStore.getState().paneExtensions[`t${idx}p0`] ?? []).map(e => e.id);
    expect(ids).toEqual(["g", "p"]);
  });
});


describe("draft projects (#379)", () => {
  it("adds, removes, and delete-purges a draft", () => {
    const st = () => useAppStore.getState();
    st().addDraftProject("acme-x1", { title: "Acme", pitch: "build it", createdAt: 1 });
    expect(st().localDraftProjects["acme-x1"]).toMatchObject({ title: "Acme", pitch: "build it" });
    st().addDraftProject("acme-x2", { title: "Acme 2", pitch: "", createdAt: 2 });
    st().removeDraftProject("acme-x1");
    expect(st().localDraftProjects["acme-x1"]).toBeUndefined();
    expect(st().localDraftProjects["acme-x2"]).toBeDefined();
    // deleteLocalProject also purges the draft entry (cleanup)
    st().deleteLocalProject(["acme-x2"]);
    expect(st().localDraftProjects["acme-x2"]).toBeUndefined();
  });
});


describe("issue links (#393 Layer 1)", () => {
  const st = () => useAppStore.getState();

  it("setIssueLinks stores a project's node->issue map", () => {
    st().setIssueLinks("proj-a", { "issue:acme/api:F1": { number: 7, url: "https://gh/7" } });
    expect(st().issueLinks["proj-a"]).toEqual({ "issue:acme/api:F1": { number: 7, url: "https://gh/7" } });
  });

  it("merges into an existing project map without dropping prior entries (idempotent upsert)", () => {
    st().setIssueLinks("proj-a", { "issue:acme/api:F1": { number: 7, url: "https://gh/7" } });
    st().setIssueLinks("proj-a", { "issue:acme/api:F2": { number: 8, url: "https://gh/8" } });
    expect(st().issueLinks["proj-a"]).toEqual({
      "issue:acme/api:F1": { number: 7, url: "https://gh/7" },
      "issue:acme/api:F2": { number: 8, url: "https://gh/8" },
    });
  });

  it("a later write for the same node id overwrites that entry only", () => {
    st().setIssueLinks("proj-a", { "issue:acme/api:F1": { number: 7, url: "https://gh/7" } });
    st().setIssueLinks("proj-a", { "issue:acme/api:F1": { number: 9, url: "https://gh/9" } });
    expect(st().issueLinks["proj-a"]).toEqual({ "issue:acme/api:F1": { number: 9, url: "https://gh/9" } });
  });

  it("keeps each project's map independent", () => {
    st().setIssueLinks("proj-a", { "issue:acme/api:F1": { number: 7, url: "https://gh/7" } });
    st().setIssueLinks("proj-b", { "issue:acme/web:W1": { number: 3, url: "https://gh/3" } });
    expect(st().issueLinks["proj-a"]).toEqual({ "issue:acme/api:F1": { number: 7, url: "https://gh/7" } });
    expect(st().issueLinks["proj-b"]).toEqual({ "issue:acme/web:W1": { number: 3, url: "https://gh/3" } });
  });
});

describe("model selection", () => {
  it("setDefaultModel updates the persisted global default", () => {
    useAppStore.setState({ defaultModel: "sonnet-4.5" });
    useAppStore.getState().setDefaultModel("opus-4.5");
    expect(useAppStore.getState().defaultModel).toBe("opus-4.5");
  });

  it("setPaneModel sets a per-pane override keyed by paneId, independently", () => {
    useAppStore.setState({ paneModels: {} });
    useAppStore.getState().setPaneModel("t0p0", "haiku-4.5");
    useAppStore.getState().setPaneModel("t0p1", "opus-4.5");
    expect(useAppStore.getState().paneModels["t0p0"]).toBe("haiku-4.5");
    expect(useAppStore.getState().paneModels["t0p1"]).toBe("opus-4.5");
    // A later write for the same pane overwrites only that entry.
    useAppStore.getState().setPaneModel("t0p0", "sonnet-4.5");
    expect(useAppStore.getState().paneModels["t0p0"]).toBe("sonnet-4.5");
    expect(useAppStore.getState().paneModels["t0p1"]).toBe("opus-4.5");
  });
});

describe("appearance", () => {
  it("setAccent updates the persisted accent id", () => {
    useAppStore.setState({ accent: "amber" });
    useAppStore.getState().setAccent("purple");
    expect(useAppStore.getState().accent).toBe("purple");
  });

  it("setTerminalFontSize clamps to the legible range", () => {
    useAppStore.getState().setTerminalFontSize(999);
    expect(useAppStore.getState().terminalFontSize).toBe(28);
    useAppStore.getState().setTerminalFontSize(1);
    expect(useAppStore.getState().terminalFontSize).toBe(8);
  });
});

describe("github board routing (#498)", () => {
  it("openGithubBoard flips the board open at a sub-tab; closeGithubBoard resets", () => {
    useAppStore.setState({ githubBoardOpen: false, githubBoardTab: "board" });
    useAppStore.getState().openGithubBoard("issues");
    expect(useAppStore.getState().githubBoardOpen).toBe(true);
    expect(useAppStore.getState().githubBoardTab).toBe("issues");

    useAppStore.getState().setGithubBoardTab("roadmap");
    expect(useAppStore.getState().githubBoardTab).toBe("roadmap");

    useAppStore.getState().closeGithubBoard();
    expect(useAppStore.getState().githubBoardOpen).toBe(false);
  });

  it("openGithubBoard defaults to the overview sub-tab (#523)", () => {
    useAppStore.setState({ githubBoardOpen: false, githubBoardTab: "issues" });
    useAppStore.getState().openGithubBoard();
    expect(useAppStore.getState().githubBoardTab).toBe("overview");
  });
});

describe("plan stage config (#512)", () => {
  beforeEach(() => useAppStore.setState({ planStageConfig: {} }));

  it("setStageEnabled seeds from defaults (all-on) then flips one stage", () => {
    useAppStore.getState().setStageEnabled("proj", "automations", false);
    const cfg = useAppStore.getState().planStageConfig["proj"];
    expect(cfg.enabled.automations).toBe(false);
    // other stages keep their default-on value
    expect(cfg.enabled.context).toBe(true);
    expect(cfg.enabled.structure).toBe(true);
  });

  it("reorderStages stores the new order without touching enabled flags", () => {
    useAppStore.getState().setStageEnabled("proj", "ui", false);
    const order = ["repos", "context", "ui", "structure", "permissions", "automations", "skills"] as const;
    useAppStore.getState().reorderStages("proj", [...order]);
    const cfg = useAppStore.getState().planStageConfig["proj"];
    expect(cfg.order).toEqual([...order]);
    expect(cfg.enabled.ui).toBe(false);
  });

  it("config is per-project", () => {
    useAppStore.getState().setStageEnabled("a", "skills", false);
    expect(useAppStore.getState().planStageConfig["b"]).toBeUndefined();
    expect(useAppStore.getState().planStageConfig["a"].enabled.skills).toBe(false);
  });

  it("setProjectStageConfig wholesale-seeds a project's config", () => {
    const d = defaultStageConfig();
    const order = ["repos", "context", "ui", "structure", "permissions", "automations", "skills"] as const;
    useAppStore.getState().setProjectStageConfig("seed", { enabled: d.enabled, order: [...order] });
    expect(useAppStore.getState().planStageConfig["seed"].order[0]).toBe("repos");
  });
});

describe("blueprints library (#513/#514)", () => {
  beforeEach(() => {
    useAppStore.setState({ blueprints: makeBlueprints(), activeBlueprintId: "default" });
  });

  it("seeds the starter library with a default active", () => {
    expect(useAppStore.getState().blueprints.length).toBeGreaterThanOrEqual(4);
    expect(useAppStore.getState().activeBlueprintId).toBe("default");
  });

  it("addBlueprint appends an untitled blueprint with a seed section and returns its id", () => {
    const before = useAppStore.getState().blueprints.length;
    const id = useAppStore.getState().addBlueprint();
    const bp = useAppStore.getState().blueprints.find((b) => b.id === id)!;
    expect(useAppStore.getState().blueprints.length).toBe(before + 1);
    expect(bp.sections.length).toBeGreaterThan(0);
  });

  it("setActiveBlueprint switches the active id", () => {
    useAppStore.getState().setActiveBlueprint("api");
    expect(useAppStore.getState().activeBlueprintId).toBe("api");
  });

  it("duplicateBlueprint inserts an independent copy after the source", () => {
    const id = useAppStore.getState().duplicateBlueprint("default");
    const copy = useAppStore.getState().blueprints.find((b) => b.id === id)!;
    expect(copy.name).toMatch(/copy/);
    // editing the copy doesn't touch the source
    const edited = copy.sections.map((s, i) => (i === 0 ? { ...s, enabled: false } : s));
    useAppStore.getState().setBlueprintSections(id, edited);
    const src = useAppStore.getState().blueprints.find((b) => b.id === "default")!;
    expect(src.sections[0].enabled).toBe(true);
  });

  it("setBlueprintSections persists the new sections for that blueprint only", () => {
    const def = useAppStore.getState().blueprints.find((b) => b.id === "default")!;
    const flipped = def.sections.map((s) => (s.key === "context" ? { ...s, enabled: false } : s));
    useAppStore.getState().setBlueprintSections("default", flipped);
    expect(useAppStore.getState().blueprints.find((b) => b.id === "default")!.sections.find((s) => s.key === "context")!.enabled).toBe(false);
    // a sibling blueprint is untouched
    expect(useAppStore.getState().blueprints.find((b) => b.id === "fullstack")!.sections.find((s) => s.key === "context")!.enabled).toBe(true);
  });

  it("updateBlueprintMeta edits name/desc", () => {
    useAppStore.getState().updateBlueprintMeta("default", { name: "Renamed", desc: "New desc" });
    const bp = useAppStore.getState().blueprints.find((b) => b.id === "default")!;
    expect(bp.name).toBe("Renamed");
    expect(bp.desc).toBe("New desc");
  });
});
