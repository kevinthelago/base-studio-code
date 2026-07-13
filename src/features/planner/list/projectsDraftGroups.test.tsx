// #2998 — the single drafts chip row is split into two lifecycle groups by the durable projects.db
// state: DRAFTS (a bare `drafted`/absent idea, accent dot) then IN PROGRESS (a `created`/`planning`
// project whose hub + plan already exist, violet dot). Each group renders only when non-empty, and
// the per-chip state label is dropped (the group header conveys it).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ProjectsList } from "./ProjectsList";
import { useAppStore } from "@/store";
import type { DbProject } from "./projectsDbBridge";

// projects.db rows: `building_app` is CREATED, `mid_plan` is PLANNING → both are "in progress".
// `bare_idea` is intentionally absent from the DB → a bare draft.
const DB_ROWS: DbProject[] = [
  { key: "building_app", title: "Building App", pitch: "", blueprint: null, category: null, state: "created", createdAt: 0, updatedAt: 0 },
  { key: "mid_plan", title: "Mid Plan", pitch: "", blueprint: null, category: null, state: "planning", createdAt: 0, updatedAt: 0 },
];

function routeInvoke() {
  vi.mocked(invoke).mockImplementation(((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "list_local_projects") return Promise.resolve([]);
    if (cmd === "github_graphql") return Promise.resolve({ viewer: { projectsV2: { nodes: [] } } });
    if (cmd === "bsc") {
      const a = (args as { args?: string[] } | undefined)?.args ?? [];
      // `bsc project db list --json` returns the raw stdout STRING the bridge JSON-parses.
      if (a[0] === "project" && a[1] === "db" && a[2] === "list") return Promise.resolve(JSON.stringify(DB_ROWS));
      return Promise.resolve("");
    }
    return Promise.resolve(null);
  }) as unknown as typeof invoke);
}

describe("ProjectsList — Drafts vs In progress split (#2998)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useAppStore.setState({
      activeWorkspace: "projects",
      githubToken: "gho_test",
      hiddenProjectIds: [],
      githubState: null,
      // `bare_idea` (no DB row) + `building_app` (DB row = created) come from the store draft map;
      // `mid_plan` (DB row = planning) is surfaced by mergeDbDrafts.
      localDraftProjects: {
        bare_idea: { title: "Bare Idea", pitch: "", createdAt: 3 },
        building_app: { title: "Building App", pitch: "", createdAt: 2 },
      },
    });
  });

  it("groups drafted/absent under a drafts header and created/planning under an in-progress header", async () => {
    routeInvoke();
    render(<ProjectsList />);

    // The in-progress group only forms once the DB rows load (async) — wait for its header.
    const inProgHeader = await screen.findByText("2 in progress");
    const inProgRow = inProgHeader.parentElement!;
    // created + planning chips live under IN PROGRESS…
    expect(within(inProgRow).getByText("Building App")).toBeTruthy();
    expect(within(inProgRow).getByText("Mid Plan")).toBeTruthy();
    expect(within(inProgRow).queryByText("Bare Idea")).toBeNull();

    // …and the bare idea lives under DRAFTS (its own row), with none of the in-progress chips.
    const draftsHeader = screen.getByText("1 draft");
    const draftsRow = draftsHeader.parentElement!;
    expect(within(draftsRow).getByText("Bare Idea")).toBeTruthy();
    expect(within(draftsRow).queryByText("Building App")).toBeNull();
    expect(within(draftsRow).queryByText("Mid Plan")).toBeNull();
  });

  it("renders only the drafts group when nothing is in progress", async () => {
    // No DB rows → every draft is a bare `drafted`/absent idea; the in-progress group must not render.
    vi.mocked(invoke).mockImplementation(((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_local_projects") return Promise.resolve([]);
      if (cmd === "github_graphql") return Promise.resolve({ viewer: { projectsV2: { nodes: [] } } });
      if (cmd === "bsc") {
        const a = (args as { args?: string[] } | undefined)?.args ?? [];
        if (a[0] === "project" && a[1] === "db" && a[2] === "list") return Promise.resolve("[]");
        return Promise.resolve("");
      }
      return Promise.resolve(null);
    }) as unknown as typeof invoke);
    render(<ProjectsList />);

    await screen.findByText("Bare Idea");
    // Both store-map drafts fall into the drafts group; no in-progress header.
    expect(screen.getByText("2 drafts")).toBeTruthy();
    expect(screen.queryByText(/in progress/i)).toBeNull();
  });
});
