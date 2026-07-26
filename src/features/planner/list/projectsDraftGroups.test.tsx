// #2998 — a draft's durable projects.db state splits DRAFTS (a bare `drafted`/absent idea) from
// IN PROGRESS (a `created`/`planning` project whose hub + plan already exist).
//
// #3802 rebuilt the Projects tab in the Skills-tab style, so that split is no longer expressed as
// two chip ROWS under counted headers ("2 in progress" / "1 draft") — every project is now a card
// in ONE grid, carrying its own status chip, with the same distinction available as a status facet.
// The GUARANTEE is unchanged and still worth a test at this level: the async `bsc project db list`
// rows have to reach the rendered card as the right status. `projectsFilter.test.ts` covers the
// pure derivation; this covers the wiring — the DB read, the merge with the store draft map, and
// what actually lands on screen.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
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

function routeInvoke(dbRows: DbProject[]) {
  vi.mocked(invoke).mockImplementation(((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "list_local_projects") return Promise.resolve([]);
    if (cmd === "github_graphql") return Promise.resolve({ viewer: { projectsV2: { nodes: [] } } });
    if (cmd === "bsc") {
      const a = (args as { args?: string[] } | undefined)?.args ?? [];
      // `bsc project db list --json` returns the raw stdout STRING the bridge JSON-parses.
      if (a[0] === "project" && a[1] === "db" && a[2] === "list") return Promise.resolve(JSON.stringify(dbRows));
      return Promise.resolve("");
    }
    return Promise.resolve(null);
  }) as unknown as typeof invoke);
}

/** The status chip text on the card carrying `title` — the per-project surface that replaced the
 *  group headers. Scoped to the card so a chip on a sibling card can't satisfy the assertion. */
function statusOf(title: string): string {
  const card = screen.getByText(title).closest(".project-card, .project-row");
  expect(card, `a card for ${title}`).toBeTruthy();
  const chip = within(card as HTMLElement).getByText(/^(in progress|draft|active|shipped)$/);
  return chip.textContent ?? "";
}

describe("ProjectsList — Drafts vs In progress split (#2998, per-card since #3802)", () => {
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

  it("marks created/planning projects in-progress and a bare idea a draft", async () => {
    routeInvoke(DB_ROWS);
    render(<ProjectsList />);

    // `mid_plan` exists ONLY in the DB, so its card appearing proves the async read + merge ran.
    await screen.findByText("Mid Plan");

    await waitFor(() => expect(statusOf("Building App")).toBe("in progress")); // DB state = created
    expect(statusOf("Mid Plan")).toBe("in progress");                          // DB state = planning
    expect(statusOf("Bare Idea")).toBe("draft");                               // no DB row
  });

  it("leaves every draft a draft when the DB has no rows", async () => {
    routeInvoke([]);
    render(<ProjectsList />);

    await screen.findByText("Bare Idea");
    // Both store-map drafts stay bare; nothing is promoted to in-progress without a DB state.
    expect(statusOf("Bare Idea")).toBe("draft");
    expect(statusOf("Building App")).toBe("draft");
    expect(screen.queryByText("Mid Plan")).toBeNull();
  });
});
