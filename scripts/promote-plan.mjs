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
 * `aheadContent` and `treesMatch` are what separate a REAL divergence from BOOKKEEPING — see the
 * `ahead > 0` arm. Both default to the pessimistic answer, so a caller that cannot supply them gets
 * exactly the old refusal rather than an accidental reconcile.
 *
 * @param {{treeExists: boolean, branch: string|null, dirty: string[], ahead: number, behind: number,
 *          aheadContent?: number, treesMatch?: boolean}} state
 * @returns {{action: "fail"|"noop"|"promote"|"reconcile", reason: string}}
 */
export function planPromote(state) {
  const {
    treeExists,
    branch,
    dirty = [],
    ahead = 0,
    behind = 0,
    // How many of the ahead commits carry CONTENT (i.e. are not merges). Defaulting to `ahead`
    // means "assume every one is real", which is the old behaviour exactly.
    aheadContent = ahead,
    treesMatch = false,
  } = state ?? {};

  if (!treeExists) {
    return { action: "fail", reason: "no-app-tree" };
  }
  // A detached HEAD has no branch to fast-forward, and guessing which ref was meant is exactly the
  // kind of helpfulness that moves the running app somewhere nobody chose.
  if (!branch || branch === "HEAD") {
    return { action: "fail", reason: "detached-head" };
  }
  // Someone edited the RUNNING copy. `dirty` is deliberately TRACKED modifications only: a
  // fast-forward cannot destroy an untracked file — git leaves it alone, and at worst refuses the
  // merge itself with "untracked working tree file would be overwritten", which is a clearer error
  // than anything this could invent. Counting untracked files here made every promote refuse over
  // 0-byte editor/shell dotfiles that a tooling sandbox materialises at the repo root.
  if (dirty.length > 0) {
    return { action: "fail", reason: "dirty-app-tree" };
  }
  // The app ref holds history develop does not, so a fast-forward is impossible.
  //
  // THERE ARE TWO WAYS TO GET HERE AND THEY WANT OPPOSITE ANSWERS. Measured 2026-08-30: `main` was 17
  // commits ahead, every single one a MERGE commit titled "merge: develop into main", and the trees
  // were byte-identical. Nothing had been committed straight to main — the refusal's own accusation
  // was false, and it sent the reader at `git log develop..main` for a fault that was not there.
  //
  // It is a doom loop, not a one-off: a hand-run `git merge --no-ff develop` puts a commit on main
  // that develop lacks, which makes the NEXT `--ff-only` impossible, which forces the next promotion
  // to be done by hand too. Seventeen times. The guard was firing on a condition its own workflow
  // created. (The script has never produced this state: `--ff-only` moves the ref and writes no
  // commit at all.)
  //
  // So split the case on evidence rather than weakening the guard:
  //
  //   BOOKKEEPING — no ahead commit carries content AND the trees are identical. The app ref is then
  //   develop's history plus merge commits that say nothing, so develop can FAST-FORWARD onto it: no
  //   new commits, no content change, and afterwards the two refs are equal and `--ff-only` works
  //   again. Provable from git, which is what makes it safe to automate rather than a judgement call.
  //
  //   REAL — anything else. A content commit on main, or trees that genuinely differ, is the fault
  //   this refusal was written for, and it still refuses with the same reason. The guard is not
  //   relaxed here; it is made precise, so from now on it only fires when it is telling the truth.
  if (ahead > 0) {
    if (aheadContent === 0 && treesMatch) {
      return { action: "reconcile", reason: "app-tree-ahead-by-merges-only" };
    }
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
