import { describe, it, expect } from "vitest";
import { locationCrumb, titleCasePageId, type CrumbState } from "@/app/chrome/locationCrumb";

const base: CrumbState = {
  activeWorkspace: "glance",
  activePageTab: {},
  crumbEntity: {},
  projectsPageMode: "projects",
  projectsView: "list",
  githubTab: "summary",
  githubBoardOpen: false,
  githubBoardTab: "board",
  activeRepoName: undefined,
  settingsSection: "github",
  consoleTab: undefined,
  focusedAgentName: undefined,
};
const crumb = (o: Partial<CrumbState>) => locationCrumb({ ...base, ...o });

describe("locationCrumb (#3036) — every page shows in the titlebar", () => {
  it("Glance reflects Network/Fleet (and the default first tab before any selection)", () => {
    expect(crumb({ activeWorkspace: "glance" })).toBe("Glance — Network"); // default first tab, activePageTab empty
    expect(crumb({ activeWorkspace: "glance", activePageTab: { glance: "fleet" } })).toBe("Glance — Fleet");
  });

  it("Planner reflects EVERY sub-page mode — not just planning (the main gap)", () => {
    expect(crumb({ activeWorkspace: "projects", projectsPageMode: "designs" })).toBe("Planner — Components");
    expect(crumb({ activeWorkspace: "projects", projectsPageMode: "teams" })).toBe("Planner — Teams");
    expect(crumb({ activeWorkspace: "projects", projectsPageMode: "algorithms" })).toBe("Planner — Algorithms");
    expect(crumb({ activeWorkspace: "projects", projectsPageMode: "sounds" })).toBe("Planner — Sounds");
    expect(crumb({ activeWorkspace: "projects", projectsPageMode: "projects" })).toBe("Planner — Projects");
    expect(crumb({ activeWorkspace: "projects", projectsPageMode: "projects", projectsView: "planning" }))
      .toBe("Planner — Projects — Planning");
  });

  // The Automations case was here. That workspace is retired
  // (hooks-and-schedules-belong-to-the-persona): its config is carried by the persona and read on
  // Teams, and its history is the Logs -> Automations tab. A persisted `activeWorkspace:
  // "automation"` redirects, which `retiredWorkspaces.test.ts` covers.

  it("MCP and Security reflect their tabs", () => {
    // Skills was here too, until it stopped being a rail Workspace and moved onto the Teams page
    // (skills-move-to-teams-and-pair-with-personas). Its crumb is now the Planner's Teams tab.
    // MCP followed it there for the same reason (mcp-moves-to-teams) — a server is agent capability.
    expect(crumb({ activeWorkspace: "logs", activePageTab: { logs: "activity" } })).toBe("Logs — Activity");
    expect(crumb({ activeWorkspace: "logs", activePageTab: { logs: "waiting" } })).toBe("Logs — Waiting");
    expect(crumb({ activeWorkspace: "logs", activePageTab: { logs: "skills" } })).toBe("Logs — Skills");
    expect(crumb({ activeWorkspace: "logs", activePageTab: { logs: "sessions" } })).toBe("Logs — Sessions");
    expect(crumb({ activeWorkspace: "logs", activePageTab: { logs: "cost" } })).toBe("Logs — Cost");
    expect(crumb({ activeWorkspace: "logs", activePageTab: { logs: "streams" } })).toBe("Logs — Streams");
    // Every tab a Logs page ships needs an entry here. An unmapped id Title-Cases gracefully, so the
    // crumb is never BLANK -- but the fallback is a safety net, not the label, and it silently starts
    // deciding the name the moment a curated one is forgotten.
  });

  it("GitHub reflects the tab, the board drill, and the active repo", () => {
    expect(crumb({ activeWorkspace: "github", githubTab: "repos" })).toBe("GitHub — Repositories");
    expect(crumb({ activeWorkspace: "github", githubTab: "repos", activeRepoName: "base-studio-code" }))
      .toBe("GitHub — Repositories — base-studio-code");
    expect(crumb({ activeWorkspace: "github", githubBoardOpen: true, githubBoardTab: "roadmap" }))
      .toBe("GitHub — Roadmap");
  });

  it("Settings shows the section LABEL, not the raw key", () => {
    expect(crumb({ activeWorkspace: "settings", settingsSection: "github" })).toBe("Settings — GitHub");
    expect(crumb({ activeWorkspace: "settings", settingsSection: "mcp" })).toBe("Settings — MCP");
  });

  it("Console shows the tab name + focused agent", () => {
    expect(crumb({ activeWorkspace: "console", consoleTab: "Build", focusedAgentName: "worker-1" }))
      .toBe("Console — Build — worker-1");
    expect(crumb({ activeWorkspace: "console" })).toBe("Console");
  });

  it("names the navigated ENTITY inside each graph — project/team/kit/language (#3041)", () => {
    // Glance → the drilled project (empty on the un-drilled network overview).
    expect(crumb({ activeWorkspace: "glance", activePageTab: { glance: "network" }, crumbEntity: { glance: "cli-typer" } }))
      .toBe("Glance — Network — cli-typer");
    expect(crumb({ activeWorkspace: "glance", crumbEntity: {} })).toBe("Glance — Network"); // not drilled
    // Planner graphs → the entered team, active kit, active language.
    expect(crumb({ activeWorkspace: "projects", projectsPageMode: "designs", crumbEntity: { designs: "react-ui" } }))
      .toBe("Planner — Components — react-ui");
    expect(crumb({ activeWorkspace: "projects", projectsPageMode: "teams", crumbEntity: { teams: "Fleet Alpha" } }))
      .toBe("Planner — Teams — Fleet Alpha");
    expect(crumb({ activeWorkspace: "projects", projectsPageMode: "algorithms", crumbEntity: { algorithms: "Rust" } }))
      .toBe("Planner — Algorithms — Rust");
    // The Projects tab keeps its planning detail, not an entity.
    expect(crumb({ activeWorkspace: "projects", projectsPageMode: "projects", projectsView: "planning", crumbEntity: { designs: "stale" } }))
      .toBe("Planner — Projects — Planning");
  });

  it("an unmapped page id Title-Cases gracefully (a newly-added tab is never blank)", () => {
    expect(titleCasePageId("hook-analytics")).toBe("Hook Analytics");
    expect(crumb({ activeWorkspace: "logs", activePageTab: { logs: "brand-new-tab" } })).toBe("Logs — Brand New Tab");
  });
});

// ── The five graphs as rail Workspaces (`five-graphs-become-rail-workspaces`) ──

describe("locationCrumb — the graph workspaces", () => {
  const base = {
    activePageTab: {}, crumbEntity: {}, projectsPageMode: "projects", projectsView: "list",
    githubTab: "summary", githubBoardOpen: false, githubBoardTab: "board", settingsSection: "general",
  };

  it("names each graph workspace", () => {
    for (const [w, label] of [
      ["components", "Components"], ["teams", "Teams"], ["algorithms", "Algorithms"],
      ["data", "Data"], ["sounds", "Sounds"],
    ] as const) {
      expect(locationCrumb({ ...base, activeWorkspace: w })).toBe(label);
    }
  });

  it("appends the navigated entity, mapping Components to the key its page reports under", () => {
    // The near-miss worth pinning: the Design Studio reports its entity under `designs` (the old tab
    // id) while its Workspace key is `components`. Reading crumbEntity[workspace] would work for the
    // other four and silently show nothing here.
    expect(locationCrumb({
      ...base, activeWorkspace: "components", crumbEntity: { designs: "base-studio-code" },
    })).toBe("Components — base-studio-code");

    expect(locationCrumb({
      ...base, activeWorkspace: "algorithms", crumbEntity: { algorithms: "Rust" },
    })).toBe("Algorithms — Rust");

    expect(locationCrumb({
      ...base, activeWorkspace: "teams", crumbEntity: { teams: "Fleet Alpha" },
    })).toBe("Teams — Fleet Alpha");
  });

  it("shows the workspace alone when the page reports no entity", () => {
    // Data reports none today. The crumb must degrade to the name, never to a dangling separator.
    expect(locationCrumb({ ...base, activeWorkspace: "data" })).toBe("Data");
    expect(locationCrumb({ ...base, activeWorkspace: "sounds", crumbEntity: {} })).toBe("Sounds");
  });

  it("does not read a STALE entity from another graph", () => {
    // crumbEntity is keyed per graph and persists across navigation, so a user who visited Algorithms
    // and then opened Sounds must not see the language they left behind.
    expect(locationCrumb({
      ...base, activeWorkspace: "sounds", crumbEntity: { algorithms: "Rust" },
    })).toBe("Sounds");
  });
});

describe("locationCrumb — the graph workspaces name their active TAB", () => {
  const base = {
    activePageTab: {}, crumbEntity: {}, projectsPageMode: "projects", projectsView: "list",
    githubTab: "summary", githubBoardOpen: false, githubBoardTab: "board", settingsSection: "general",
  };

  it("appends the tab, then the entity", () => {
    // Workspace — Tab — Entity. The tab is the technology/team/kit; the entity is what the page reports
    // for it. Both, in that order, so the crumb reads as a path.
    expect(locationCrumb({
      ...base, activeWorkspace: "algorithms",
      activePageTab: { algorithms: "rust" }, crumbEntity: { algorithms: "Rust" },
    })).toBe("Algorithms — Rust — Rust");

    expect(locationCrumb({
      ...base, activeWorkspace: "sounds", activePageTab: { sounds: "signal" },
    })).toBe("Sounds — Signal");
  });

  it("Title-Cases a data-derived tab id rather than mapping it", () => {
    // These vocabularies come from DATA — the languages the graph holds, the sound kits, the teams — so
    // a curated label map would be a second copy that goes stale the moment the data changes. A stale
    // map shows the WRONG name, which is worse than an unpolished one.
    expect(locationCrumb({
      ...base, activeWorkspace: "data", activePageTab: { data: "typescript" },
    })).toBe("Data — Typescript");
    expect(locationCrumb({
      ...base, activeWorkspace: "teams", activePageTab: { teams: "org-default-fleet" },
    })).toBe("Teams — Org Default Fleet");
  });

  it("does not render the Teams overview tab as a repeated word", () => {
    // The overview's tab id is `teams`, so a naive append gives "Teams — Teams".
    expect(locationCrumb({ ...base, activeWorkspace: "teams", activePageTab: { teams: "teams" } })).toBe("Teams");
  });

  it("shows the workspace alone before any tab has been chosen", () => {
    // `activePageTab` is empty until the first selection; the crumb must degrade to the name, never to
    // a dangling separator.
    expect(locationCrumb({ ...base, activeWorkspace: "components" })).toBe("Components");
  });
});
