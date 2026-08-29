// Pure decision logic for promoting `develop` into the tree the app RUNS from
// (#the-app-runs-from-its-own-tree-so-a-merge-never-restarts-it).
//
// Side-effect-free and import-free, like `worktree-pool-plan.mjs` beside it, so every refusal is
// unit-testable without git or a filesystem (`scripts/promote-plan.test.ts`).
//
// Each refusal below exists because the alternative is worse than stopping, and the whole point of the
// feature is that the user's session is never disturbed by surprise.

/**
 * Decide what a promote run should do.
 *
 * @param {{treeExists: boolean, branch: string|null, dirty: string[], ahead: number, behind: number}} state
 * @returns {{action: "fail"|"noop"|"promote", reason: string}}
 */
export function planPromote(state) {
  const { treeExists, branch, dirty = [], ahead = 0, behind = 0 } = state ?? {};

  if (!treeExists) {
    return { action: "fail", reason: "no-app-tree" };
  }
  // A detached HEAD has no branch to fast-forward, and guessing which ref was meant is exactly the
  // kind of helpfulness that moves the running app somewhere nobody chose.
  if (!branch || branch === "HEAD") {
    return { action: "fail", reason: "detached-head" };
  }
  // Someone edited the RUNNING copy. Promoting would either fail or carry those edits forward silently.
  if (dirty.length > 0) {
    return { action: "fail", reason: "dirty-app-tree" };
  }
  // The app ref holds history develop does not, so a fast-forward is impossible. That means something
  // committed straight to it — a fault to look at, never one to paper over with a merge commit.
  if (ahead > 0) {
    return { action: "fail", reason: "app-tree-ahead" };
  }
  if (behind === 0) {
    return { action: "noop", reason: "already-current" };
  }
  return { action: "promote", reason: "behind" };
}

/** Precedence is deliberate and pinned by tests: a dirty tree is reported even when it is also ahead,
 *  because the uncommitted work is the thing at risk and the thing the user can still lose. */
export const REFUSAL_ORDER = ["no-app-tree", "detached-head", "dirty-app-tree", "app-tree-ahead"];
