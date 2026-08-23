// Every retired rail Workspace redirects somewhere real.
//
// These assertions did not exist before `skills` was retired, and the gap was not cosmetic: `design`,
// `algorithms` and `agents` had each shipped a persisted-state redirect with nothing checking it. The
// failure they guard against is quiet and hard to attribute — a user whose last session ended on a
// removed screen reopens the app pointed at a key the shell cannot render, and the cause is a
// rehydrate that ran once, at boot, days after the change that caused it.
import { describe, it, expect } from "vitest";
import { migrateRetiredWorkspace, migrateGraphPage, RETIRED_WORKSPACE_KEYS, GRAPH_PAGE_KEYS,
         type RetiredWorkspaceState } from "@/store/retiredWorkspaces";
import { WORKSPACES, type Workspace } from "@/app/registry";

const live = new Set(WORKSPACES.map((w) => w.key));

describe("retired workspaces redirect to something that exists", () => {
  it.each(RETIRED_WORKSPACE_KEYS)("%s lands on a LIVE workspace", (key) => {
    const state = migrateRetiredWorkspace({ activeWorkspace: key } as RetiredWorkspaceState)!;
    expect(live.has(state.activeWorkspace as Workspace), `${key} → ${state.activeWorkspace}`).toBe(true);
  });

  it("skills lands on the Teams WORKSPACE, where skills now live", () => {
    // Teams stopped being a Planner tab and became a rail destination
    // (`five-graphs-become-rail-workspaces`), so this redirect names a workspace and carries no page.
    const state = migrateRetiredWorkspace({ activeWorkspace: "skills" } as RetiredWorkspaceState)!;
    expect(state.activeWorkspace).toBe("teams");
    expect(state.projectsPageMode).toBeUndefined();
  });

  it("design lands on Components, and every reversed redirect names a workspace not a Planner page", () => {
    // These five redirects were REVERSED, not extended: each used to point at `projects` plus a page,
    // and every one of those pages is gone. A redirect left as `{workspace: "projects", page: "designs"}`
    // would land on a Planner tab that no longer exists — the blank screen this table exists to prevent,
    // arriving by the very mechanism meant to stop it.
    expect(migrateRetiredWorkspace({ activeWorkspace: "design" } as RetiredWorkspaceState)!.activeWorkspace).toBe("components");
    for (const key of ["design", "skills", "mcp", "automation"]) {
      const state = migrateRetiredWorkspace({ activeWorkspace: key } as RetiredWorkspaceState)!;
      expect(state.activeWorkspace, `${key} must not redirect to the Planner`).not.toBe("projects");
      expect(state.projectsPageMode, `${key} must not carry a Planner page`).toBeUndefined();
    }
  });

  it("algorithms is NO LONGER retired — a live workspace must never be redirected", () => {
    // It was `{workspace: "projects", page: "algorithms"}`. It is a rail destination again, so leaving
    // it in the table would move someone off a screen that works, on every boot. (The general form is
    // asserted by "no LIVE workspace is also listed as retired" below; this pins the specific one that
    // changed sides.)
    expect(RETIRED_WORKSPACE_KEYS).not.toContain("algorithms");
    const state = migrateRetiredWorkspace({ activeWorkspace: "algorithms" } as RetiredWorkspaceState)!;
    expect(state.activeWorkspace).toBe("algorithms");
  });

  it("agents carries no page, and points at the FINAL destination rather than chaining", () => {
    // `agents` was renamed to `security` (#2702) and `security` has since become `logs`. The
    // migration runs ONCE, so an entry pointing at another retired key would land the user on a
    // workspace the shell can no longer render -- the exact blank screen this table prevents.
    const state = migrateRetiredWorkspace({ activeWorkspace: "agents", projectsPageMode: "projects" })!;
    expect(state.activeWorkspace).toBe("logs");
    expect(state.projectsPageMode).toBe("projects");   // untouched
  });

  it("every redirect lands on a LIVE workspace, not on another retired one", () => {
    // The general form of the bug above: a redirect table can point at itself. Checked against the
    // registry rather than a hand-written list, so a workspace retired later cannot quietly become
    // some other entry's destination.
    const liveKeys = new Set(WORKSPACES.map((w) => w.key as string));
    for (const key of RETIRED_WORKSPACE_KEYS) {
      const to = migrateRetiredWorkspace({ activeWorkspace: key })!.activeWorkspace!;
      expect(liveKeys.has(to), `${key} redirects to ${to}, which is not a live workspace`).toBe(true);
      expect(RETIRED_WORKSPACE_KEYS, `${key} redirects to another RETIRED key`).not.toContain(to);
    }
  });

  it("leaves a LIVE workspace completely alone", () => {
    // The dangerous inverse: a redirect that fires too eagerly moves someone off a screen that works.
    for (const w of live) {
      const state = migrateRetiredWorkspace({ activeWorkspace: w, projectsPageMode: "sounds" })!;
      expect(state.activeWorkspace, `${w} must not be redirected`).toBe(w);
      expect(state.projectsPageMode).toBe("sounds");
    }
  });

  it("tolerates absent state and an unknown key rather than throwing at boot", () => {
    // This runs inside `onRehydrateStorage`; anything it throws happens before the app can render.
    expect(migrateRetiredWorkspace(null)).toBeNull();
    expect(migrateRetiredWorkspace(undefined)).toBeUndefined();
    expect(migrateRetiredWorkspace({})).toEqual({});
    expect(migrateRetiredWorkspace({ activeWorkspace: "invented" } as RetiredWorkspaceState)!.activeWorkspace).toBe("invented");
  });

  it("no LIVE workspace is also listed as retired", () => {
    // A key in both tables would redirect a working screen away from itself on every boot.
    const overlap = RETIRED_WORKSPACE_KEYS.filter((k) => live.has(k as Workspace));
    expect(overlap).toEqual([]);
  });
});

// ── The Planner PAGES that became Workspaces ──────────────────────────────────

describe("migrateGraphPage — a Planner tab that became a rail Workspace", () => {
  it("forwards each departed page to the Workspace it became", () => {
    // `designs → components` is the one that is not identity: the tab id was the internal feature
    // name while its LABEL was "Components" (#2818), and the Workspace took the label.
    const cases: [string, string][] = [
      ["designs", "components"],
      ["teams", "teams"],
      ["algorithms", "algorithms"],
      ["sounds", "sounds"],
      ["data", "data"],
    ];
    for (const [page, workspace] of cases) {
      const state = migrateGraphPage({ activeWorkspace: "projects", projectsPageMode: page })!;
      expect(state.activeWorkspace, `${page} → ${state.activeWorkspace}`).toBe(workspace);
      // The page mode is reset, not left naming a tab the Planner no longer offers — otherwise a
      // later Planner visit reopens on a dead tab.
      expect(state.projectsPageMode).toBe("projects");
    }
  });

  it("every forwarded page lands on a LIVE workspace", () => {
    // Checked against the registry, not a hand-written list, so a workspace retired later cannot
    // quietly become one of these destinations.
    for (const page of GRAPH_PAGE_KEYS) {
      const to = migrateGraphPage({ activeWorkspace: "projects", projectsPageMode: page })!.activeWorkspace!;
      expect(live.has(to as Workspace), `${page} → ${to}, which is not a live workspace`).toBe(true);
    }
  });

  it("leaves the surviving Projects page alone", () => {
    // The Planner keeps Projects. Forwarding it would evict every planner user from the planner.
    const state = migrateGraphPage({ activeWorkspace: "projects", projectsPageMode: "projects" })!;
    expect(state.activeWorkspace).toBe("projects");
    expect(state.projectsPageMode).toBe("projects");
  });

  it("only fires when the workspace is projects", () => {
    // `projectsPageMode` is persisted independently of `activeWorkspace`, so a user sitting on Glance
    // can carry a stale page mode of "sounds". Forwarding on that would yank them to Sounds at boot
    // for a page they were not looking at.
    const state = migrateGraphPage({ activeWorkspace: "glance", projectsPageMode: "sounds" })!;
    expect(state.activeWorkspace).toBe("glance");
    expect(state.projectsPageMode).toBe("sounds");
  });

  it("tolerates absent state and an unknown page rather than throwing at boot", () => {
    // Runs inside `onRehydrateStorage`; anything it throws happens before the app can render.
    expect(migrateGraphPage(null)).toBeNull();
    expect(migrateGraphPage(undefined)).toBeUndefined();
    expect(migrateGraphPage({})).toEqual({});
    const unknown = migrateGraphPage({ activeWorkspace: "projects", projectsPageMode: "invented" })!;
    expect(unknown.activeWorkspace).toBe("projects");
  });

  it("composes with the retired-workspace table in the order the store applies them", () => {
    // Both run on rehydrate. A user last on the retired `mcp` workspace is moved to Teams by the
    // first; the second must then leave them there rather than re-reading a stale page mode.
    const state = migrateRetiredWorkspace({ activeWorkspace: "mcp", projectsPageMode: "designs" })!;
    expect(state.activeWorkspace).toBe("teams");
    const after = migrateGraphPage(state)!;
    expect(after.activeWorkspace, "the second pass must not override the first").toBe("teams");
  });
});
