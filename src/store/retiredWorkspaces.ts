// Where a RETIRED rail Workspace sends a user who was last on it.
//
// `activeWorkspace` is persisted, so removing a Workspace strands anyone whose last session ended
// there: they reopen the app pointed at a key the shell can no longer render. Every removal therefore
// owes a redirect, and this is the one place they live.
//
// Extracted from the `onRehydrateStorage` closure in `store/index.ts` (skills-move-to-teams-and-pair-
// with-personas). Inline, they could not be tested — which is why `design`, `algorithms` and `agents`
// had shipped without a single assertion between them, each one a silent landing-on-nothing away from
// a bug nobody would attribute to a rehydrate. Pulling them into a pure function costs one export and
// makes the whole set provable at once.
//
// PAGE-MODE migrations (`org` → `teams`, `design` → `designs`, …) deliberately stay in `index.ts`:
// those rename a tab WITHIN a surviving Workspace, which is a different failure (a wrong tab, not a
// blank screen) and they do not compose with these.

/** The subset of persisted state a workspace redirect reads and writes. */
export interface RetiredWorkspaceState {
  activeWorkspace?: string;
  projectsPageMode?: string;
}

/**
 * Retired Workspace → where it went.
 *
 * `page` is set only when the surface survived as a Planner TAB, so the user lands on the thing they
 * were looking at rather than merely on the workspace that now contains it. `agents` has none because
 * it was a pure rename: the screen did not move.
 */
const RETIRED: Record<string, { workspace: string; page?: string }> = {
  // Design Studio → a Planner tab (#move-to-planner).
  design: { workspace: "projects", page: "designs" },
  // The Algorithms knowledge graph → a Planner tab (#2785).
  algorithms: { workspace: "projects", page: "algorithms" },
  // Skills → the TEAMS page (skills-move-to-teams-and-pair-with-personas). A skill is injectable agent
  // CONTEXT, so its home is the agent library beside the personas that carry it.
  skills: { workspace: "projects", page: "teams" },
  // A pure rename, not a move (#2702): "agents" became "security".
  agents: { workspace: "security" },
};

/**
 * Rewrite a persisted `activeWorkspace` that names a Workspace which no longer exists.
 *
 * Mutates in place and returns the same object, matching how `onRehydrateStorage` hands state around.
 * A state that names a LIVE workspace — or none at all — is left exactly as it is: this must never
 * "helpfully" redirect someone away from a screen that still works.
 */
export function migrateRetiredWorkspace<T extends RetiredWorkspaceState>(state: T | null | undefined): T | null | undefined {
  if (!state) return state;
  const moved = RETIRED[state.activeWorkspace ?? ""];
  if (!moved) return state;
  state.activeWorkspace = moved.workspace;
  if (moved.page) state.projectsPageMode = moved.page;
  return state;
}

/** The retired keys, for tests and for anything that wants to report what was dropped. */
export const RETIRED_WORKSPACE_KEYS = Object.keys(RETIRED);
