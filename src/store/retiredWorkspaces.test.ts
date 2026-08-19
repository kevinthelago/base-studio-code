// Every retired rail Workspace redirects somewhere real.
//
// These assertions did not exist before `skills` was retired, and the gap was not cosmetic: `design`,
// `algorithms` and `agents` had each shipped a persisted-state redirect with nothing checking it. The
// failure they guard against is quiet and hard to attribute — a user whose last session ended on a
// removed screen reopens the app pointed at a key the shell cannot render, and the cause is a
// rehydrate that ran once, at boot, days after the change that caused it.
import { describe, it, expect } from "vitest";
import { migrateRetiredWorkspace, RETIRED_WORKSPACE_KEYS,
         type RetiredWorkspaceState } from "@/store/retiredWorkspaces";
import { WORKSPACES, type Workspace } from "@/app/registry";

const live = new Set(WORKSPACES.map((w) => w.key));

describe("retired workspaces redirect to something that exists", () => {
  it.each(RETIRED_WORKSPACE_KEYS)("%s lands on a LIVE workspace", (key) => {
    const state = migrateRetiredWorkspace({ activeWorkspace: key } as RetiredWorkspaceState)!;
    expect(live.has(state.activeWorkspace as Workspace), `${key} → ${state.activeWorkspace}`).toBe(true);
  });

  it("skills lands on the Teams page, where skills now live", () => {
    const state = migrateRetiredWorkspace({ activeWorkspace: "skills" } as RetiredWorkspaceState)!;
    expect(state.activeWorkspace).toBe("projects");
    expect(state.projectsPageMode).toBe("teams");
  });

  it("design and algorithms land on their own Planner tabs, not merely on Planner", () => {
    // Landing on the workspace but the WRONG tab is its own small betrayal — the user was looking at
    // something specific. The redirect carries the page for exactly that reason.
    expect(migrateRetiredWorkspace({ activeWorkspace: "design" } as RetiredWorkspaceState)!.projectsPageMode).toBe("designs");
    expect(migrateRetiredWorkspace({ activeWorkspace: "algorithms" } as RetiredWorkspaceState)!.projectsPageMode).toBe("algorithms");
  });

  it("agents is a RENAME, so it carries no page — the screen did not move", () => {
    const state = migrateRetiredWorkspace({ activeWorkspace: "agents", projectsPageMode: "projects" })!;
    expect(state.activeWorkspace).toBe("security");
    expect(state.projectsPageMode).toBe("projects");   // untouched
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
