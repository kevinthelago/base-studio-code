import { describe, it, expect } from "vitest";
import { locationCrumb, titleCasePageId, type CrumbState } from "./locationCrumb";

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

  it("Automations reads the LIVE page (activePageTab), not the stale automationsTab field", () => {
    expect(crumb({ activeWorkspace: "automation", activePageTab: { automations: "analytics" } }))
      .toBe("Automations — Hook Analytics");
    expect(crumb({ activeWorkspace: "automation", activePageTab: { automations: "hooks" } }))
      .toBe("Automations — Hooks");
    expect(crumb({ activeWorkspace: "automation" })).toBe("Automations — Schedules"); // default first tab
  });

  it("MCP, Skills, Security reflect their tabs", () => {
    expect(crumb({ activeWorkspace: "mcp", activePageTab: { mcp: "catalog" } })).toBe("MCP — Catalog");
    expect(crumb({ activeWorkspace: "skills", activePageTab: { skills: "lessons" } })).toBe("Skills — Lessons");
    expect(crumb({ activeWorkspace: "security", activePageTab: { security: "flow" } })).toBe("Security — Flow");
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
    expect(crumb({ activeWorkspace: "mcp", activePageTab: { mcp: "brand-new-tab" } })).toBe("MCP — Brand New Tab");
  });
});
