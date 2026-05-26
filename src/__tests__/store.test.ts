import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore, TRIAGE_PROMPT } from "../store";
import type { ViewKey } from "../components/pane/ViewTabs";

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
  paneViews: [] as ViewKey[],
  paneNames: {} as Record<number, Record<number, string>>,
  paneCwds: {} as Record<string, string>,
  paneInitCmds: {} as Record<string, string>,
  paneGitInfo: {} as Record<string, { repo: string; branch: string; dirty: boolean } | null>,
  disabledPanes: {} as Record<string, boolean>,
  kbBlocks: [],
  schedules: [],
  commands: [],
  allowedCommands: [] as string[],
  projectAllowedCommands: {} as Record<string, string[]>,
  repoAllowedCommands: {} as Record<string, string[]>,
  paneAllowedCommands: {} as Record<string, string[]>,
  autoFocusOnInterrupt: true,
  focusedAgentName: "",
  githubConnected: false,
  githubToken: "",
  githubUser: null,
  githubRepos: [],
  activeRepoName: "",
  projectsView: "list" as "list" | "board" | "planning",
  activeProjectId: null as string | null,
  activeProjectName: "",
  activeProjectRepo: "",
  activeProjectRepos: [] as string[],
  activeProjectNumber: 0,
  projectsBoardTab: "board" as "board" | "roadmap" | "issues" | "insights",
  projectsDrawerIssue: null as number | null,
  planningPitch: "",
  planningRepo: "",
  projectLocalRepos: {} as Record<string, string[]>,
  configProfiles: [] as import("../store").ConfigProfile[],
  paneStartupPromptDocs: {} as Record<string, string>,
  paneStartupPromptText: {} as Record<string, string>,
  bscBaseDir: "",
  tabStartedAt: {} as Record<number, number>,
  defaultStartupPromptDoc: null as string | null,
  projectStartupPromptDoc: {} as Record<string, string | null>,
  repoStartupPromptDoc: {} as Record<string, string | null>,
  repoTriagePromptDoc: {} as Record<string, string | null>,
  kbProjectScope: null as { keys: string[]; label: string } | null,
};

beforeEach(() => {
  useAppStore.setState(RESET_STATE);
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

  it("setPaneGitInfo stores git metadata by pane ID", () => {
    const info = { repo: "my-repo", branch: "main", dirty: true };
    useAppStore.getState().setPaneGitInfo("t0p1", info);
    expect(useAppStore.getState().paneGitInfo["t0p1"]).toEqual(info);
  });

  it("setPaneGitInfo accepts null to clear git context", () => {
    useAppStore.getState().setPaneGitInfo("t0p0", { repo: "r", branch: "b", dirty: false });
    useAppStore.getState().setPaneGitInfo("t0p0", null);
    expect(useAppStore.getState().paneGitInfo["t0p0"]).toBeNull();
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

  it("setAutoFocusOnInterrupt toggles the setting", () => {
    expect(useAppStore.getState().autoFocusOnInterrupt).toBe(true);
    useAppStore.getState().setAutoFocusOnInterrupt(false);
    expect(useAppStore.getState().autoFocusOnInterrupt).toBe(false);
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

  it("setProjectsView switches to board", () => {
    useAppStore.getState().setProjectsView("board");
    expect(useAppStore.getState().projectsView).toBe("board");
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

  it("setProjectsBoardTab updates the active tab", () => {
    useAppStore.getState().setProjectsBoardTab("roadmap");
    expect(useAppStore.getState().projectsBoardTab).toBe("roadmap");
    useAppStore.getState().setProjectsBoardTab("board");
    expect(useAppStore.getState().projectsBoardTab).toBe("board");
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

// ── Quick start ───────────────────────────────────────────────────────────────

describe("quickStartProject", () => {
  it("creates a new tab named after the project", () => {
    useAppStore.getState().quickStartProject("my-project", ["acme/api"]);
    const { tabs } = useAppStore.getState();
    expect(tabs[tabs.length - 1].name).toBe("my-project");
  });

  it("switches activeScreen to console", () => {
    useAppStore.getState().quickStartProject("p", ["acme/api"]);
    expect(useAppStore.getState().activeScreen).toBe("console");
  });

  it("activates the new tab", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().quickStartProject("p", ["acme/api"]);
    expect(useAppStore.getState().activeTabIdx).toBe(before);
  });

  it("uses 1×1 layout for 1 repo", () => {
    useAppStore.getState().quickStartProject("p", ["acme/api"]);
    const { tabs, activeTabIdx } = useAppStore.getState();
    expect(tabs[activeTabIdx].layout).toBe("1×1");
  });

  it("uses 2×1 layout for 2 repos", () => {
    useAppStore.getState().quickStartProject("p", ["acme/api", "acme/ui"]);
    const { tabs, activeTabIdx } = useAppStore.getState();
    expect(tabs[activeTabIdx].layout).toBe("2×1");
  });

  it("uses 2×2 layout for 3+ repos", () => {
    useAppStore.getState().quickStartProject("p", ["acme/api", "acme/ui", "acme/sdk"]);
    const { tabs, activeTabIdx } = useAppStore.getState();
    expect(tabs[activeTabIdx].layout).toBe("2×2");
  });

  it("disables the empty grid cell when 3 repos fill a 2×2", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().quickStartProject("p", ["acme/api", "acme/ui", "acme/sdk"]);
    const { disabledPanes } = useAppStore.getState();
    // 3 real panes enabled, the 4th cell starts disabled.
    expect(disabledPanes[`t${before}p0`]).toBeUndefined();
    expect(disabledPanes[`t${before}p2`]).toBeUndefined();
    expect(disabledPanes[`t${before}p3`]).toBe(true);
  });

  it("disables no cells when repos exactly fill the grid", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().quickStartProject("p", ["acme/api", "acme/ui", "acme/sdk", "acme/cli"]);
    const { disabledPanes } = useAppStore.getState();
    for (let i = 0; i < 4; i++) expect(disabledPanes[`t${before}p${i}`]).toBeUndefined();
  });

  it("pre-seeds paneCwds with computed repo paths under projects/<key>", () => {
    useAppStore.setState({ bscBaseDir: "/base" });
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().quickStartProject("p", ["acme/api", "acme/ui"]);
    const { paneCwds } = useAppStore.getState();
    expect(paneCwds[`t${before}p0`]).toBe("/base/projects/p/api");
    expect(paneCwds[`t${before}p1`]).toBe("/base/projects/p/ui");
  });

  it("pre-seeds paneNames with repo short names", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().quickStartProject("p", ["acme/api", "acme/ui"]);
    const { paneNames } = useAppStore.getState();
    expect(paneNames[before][0]).toBe("api");
    expect(paneNames[before][1]).toBe("ui");
  });

  it("launches a claude pane per repo, defaulting to the built-in plan prompt", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().quickStartProject("p", ["acme/api", "acme/ui"]);
    const { paneInitCmds, paneStartupPromptDocs } = useAppStore.getState();
    // initCmd marks a claude pane; the backend bakes the resolved prompt in.
    expect(paneInitCmds[`t${before}p0`]).toBe("claude");
    expect(paneInitCmds[`t${before}p1`]).toBe("claude");
    // "" = the built-in plan prompt (PROJECT_INIT_PROMPT) when nothing assigned.
    expect(paneStartupPromptDocs[`t${before}p0`]).toBe("");
    expect(paneStartupPromptDocs[`t${before}p1`]).toBe("");
  });

  it("assigns each repo's resolved kickoff doc (repo override; built-in when unset)", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.setState({
      repoStartupPromptDoc: { "P1::acme/api": "projects/P1/prompts/api-kickoff.md" },
    });
    useAppStore.getState().quickStartProject("p", ["acme/api", "acme/ui"], "P1");
    const { paneInitCmds, paneStartupPromptDocs } = useAppStore.getState();
    expect(paneInitCmds[`t${before}p0`]).toBe("claude");
    expect(paneStartupPromptDocs[`t${before}p0`]).toBe("projects/P1/prompts/api-kickoff.md");
    // acme/ui has no assignment → "" = built-in plan prompt.
    expect(paneStartupPromptDocs[`t${before}p1`]).toBe("");
  });

  it("caps layout at 2×2 even with 5+ repos", () => {
    const repos = Array.from({ length: 5 }, (_, i) => `acme/repo${i}`);
    useAppStore.getState().quickStartProject("p", repos);
    const { tabs, activeTabIdx } = useAppStore.getState();
    expect(tabs[activeTabIdx].layout).toBe("2×2");
  });

  it("does nothing but switch screen when called with empty repos", () => {
    const tabsBefore = useAppStore.getState().tabs.length;
    useAppStore.getState().quickStartProject("p", []);
    expect(useAppStore.getState().tabs).toHaveLength(tabsBefore);
    expect(useAppStore.getState().activeScreen).toBe("console");
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

    // The 5 real repos are wired up (clone path) and left enabled.
    for (let i = 0; i < repos.length; i++) {
      const key = `t${before}p${i}`;
      expect(paneCwds[key]).toBe(`/base/projects/proj/${repos[i].split("/")[1]}`);
      expect(paneInitCmds[key]).toContain("claude");
      expect(disabledPanes[key]).toBeUndefined();
    }
    // The single empty cell starts disabled (no shell spawned).
    expect(disabledPanes[`t${before}p5`]).toBe(true);
    expect(paneCwds[`t${before}p5`]).toBeUndefined();
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
