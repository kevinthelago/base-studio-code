import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../store";
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
  paneGitInfo: {} as Record<string, { repo: string; branch: string; dirty: boolean } | null>,
  kbBlocks: [],
  schedules: [],
  commands: [],
  allowedCommands: [] as string[],
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
  projectLocalRepos: {} as Record<string, import("../store").ResolvedRepo[]>,
  configProfiles: [] as import("../store").ConfigProfile[],
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
  it("addProjectLocalRepo stores a resolved repo under the project id", () => {
    const repo = { full_name: "acme/api", local_path: "/home/user/code/api", source: "found" as const };
    useAppStore.getState().addProjectLocalRepo("prj_1", repo);
    expect(useAppStore.getState().projectLocalRepos["prj_1"]).toHaveLength(1);
    expect(useAppStore.getState().projectLocalRepos["prj_1"][0]).toEqual(repo);
  });

  it("addProjectLocalRepo upserts: same full_name replaces the old entry", () => {
    useAppStore.getState().addProjectLocalRepo("prj_1", { full_name: "acme/api", local_path: "/old", source: "found" });
    useAppStore.getState().addProjectLocalRepo("prj_1", { full_name: "acme/api", local_path: "/new", source: "cloned" });
    const repos = useAppStore.getState().projectLocalRepos["prj_1"];
    expect(repos).toHaveLength(1);
    expect(repos[0].local_path).toBe("/new");
    expect(repos[0].source).toBe("cloned");
  });

  it("addProjectLocalRepo keeps existing repos for the same project", () => {
    useAppStore.getState().addProjectLocalRepo("prj_1", { full_name: "acme/api", local_path: "/api", source: "found" });
    useAppStore.getState().addProjectLocalRepo("prj_1", { full_name: "acme/ui",  local_path: "/ui",  source: "found" });
    expect(useAppStore.getState().projectLocalRepos["prj_1"]).toHaveLength(2);
  });

  it("addProjectLocalRepo keeps other projects untouched", () => {
    useAppStore.getState().addProjectLocalRepo("prj_1", { full_name: "acme/api", local_path: "/api", source: "found" });
    useAppStore.getState().addProjectLocalRepo("prj_2", { full_name: "other/repo", local_path: "/other", source: "found" });
    expect(useAppStore.getState().projectLocalRepos["prj_1"]).toHaveLength(1);
    expect(useAppStore.getState().projectLocalRepos["prj_2"]).toHaveLength(1);
  });
});

// ── Quick start ───────────────────────────────────────────────────────────────

describe("quickStartProject", () => {
  const makeRepo = (name: string, path: string) => ({
    full_name: `acme/${name}`,
    local_path: path,
    source: "found" as const,
  });

  it("creates a new tab named after the project", () => {
    useAppStore.getState().quickStartProject("my-project", [makeRepo("api", "/api")]);
    const { tabs } = useAppStore.getState();
    expect(tabs[tabs.length - 1].name).toBe("my-project");
  });

  it("switches activeScreen to console", () => {
    useAppStore.getState().quickStartProject("p", [makeRepo("api", "/api")]);
    expect(useAppStore.getState().activeScreen).toBe("console");
  });

  it("activates the new tab", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().quickStartProject("p", [makeRepo("api", "/api")]);
    expect(useAppStore.getState().activeTabIdx).toBe(before);
  });

  it("uses 1×1 layout for 1 repo", () => {
    useAppStore.getState().quickStartProject("p", [makeRepo("api", "/api")]);
    const { tabs, activeTabIdx } = useAppStore.getState();
    expect(tabs[activeTabIdx].layout).toBe("1×1");
  });

  it("uses 2×1 layout for 2 repos", () => {
    useAppStore.getState().quickStartProject("p", [makeRepo("api", "/api"), makeRepo("ui", "/ui")]);
    const { tabs, activeTabIdx } = useAppStore.getState();
    expect(tabs[activeTabIdx].layout).toBe("2×1");
  });

  it("uses 2×2 layout for 3+ repos", () => {
    useAppStore.getState().quickStartProject("p", [
      makeRepo("api", "/api"), makeRepo("ui", "/ui"), makeRepo("sdk", "/sdk"),
    ]);
    const { tabs, activeTabIdx } = useAppStore.getState();
    expect(tabs[activeTabIdx].layout).toBe("2×2");
  });

  it("pre-seeds paneCwds with repo paths", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().quickStartProject("p", [makeRepo("api", "/api"), makeRepo("ui", "/ui")]);
    const { paneCwds } = useAppStore.getState();
    expect(paneCwds[`t${before}p0`]).toBe("/api");
    expect(paneCwds[`t${before}p1`]).toBe("/ui");
  });

  it("pre-seeds paneNames with repo short names", () => {
    const before = useAppStore.getState().tabs.length;
    useAppStore.getState().quickStartProject("p", [makeRepo("api", "/api"), makeRepo("ui", "/ui")]);
    const { paneNames } = useAppStore.getState();
    expect(paneNames[before][0]).toBe("api");
    expect(paneNames[before][1]).toBe("ui");
  });

  it("caps layout at 2×2 even with 5+ repos", () => {
    const repos = Array.from({ length: 5 }, (_, i) => makeRepo(`repo${i}`, `/r${i}`));
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
