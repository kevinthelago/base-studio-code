// Pure selection logic for capping the PARKED worktree pool
// (#worktree-pool-has-no-cap-so-parked-trees-hold-160gb).
//
// Side-effect-free and import-free, like `incremental-prune-plan.mjs` and `target-units.mjs` beside
// it, so the decision of WHICH tree to remove is unit-testable without git or a filesystem
// (`scripts/worktree-pool-plan.test.ts`).
//
// ## What a parked tree is for, and what it costs
//
// A parked worktree exists ONLY to keep a warm `target/`. CLAUDE.md measures that as worth about two
// minutes — a fresh worktree cold-builds `bsc` in 1m59s against 0.41-5.11s recycled. Each tree costs
// ~18-21 GB (wt-flake, 21G: incremental 8.8G · deps 7.4G · build 2.9G · a 1.4G static lib), so eight
// parked trees hold roughly 160 GB to save at most ~16 minutes.
//
// Nothing INSIDE a worktree is reclaimable — the deps GC measured 0 orphaned units on every one of
// them, because they are too young to have any. ~21 GB is simply what one warm tree weighs. The only
// lever is how many exist, which is what this plans.

/** A branch is parked when it is literally named `parked-<something>` — the convention CLAUDE.md's
 *  recycle-don't-recreate step uses (`git checkout -B parked-<short> develop`). Anything else is a
 *  claimed ref and must never be a candidate. */
export function isParked(branch) {
  return typeof branch === "string" && /^parked-.+/.test(branch);
}

/**
 * Decide which parked worktrees to remove.
 *
 * Three outcomes, and the middle one is the reason this is not just a sort:
 *   - **keep** — the main tree, every ACTIVE ref, and the `keep` most recently built parked trees.
 *   - **refused** — a tree that is a candidate by policy but carries a hazard. Reported, never
 *     silently skipped and never removed anyway: a caller that cannot tell "nothing to do" from
 *     "I declined to touch this" will assume the pool is capped when it is not.
 *   - **remove** — the rest, oldest first.
 *
 * Recency is "last built", not last committed: the whole value of a parked tree is its warm
 * `target/`, so the tree most recently compiled in is the one most likely to be worth keeping.
 *
 * @param {Array<{name: string, branch: string|null, lastBuiltMs: number, blocked?: string|null}>} trees
 * @param {{keep?: number}} [opts] `keep` parked trees to spare, newest first (default 2)
 * @returns {{remove: string[], keep: string[], refused: Array<{name: string, why: string}>}}
 */
export function planCap(trees, opts = {}) {
  const keep = opts.keep ?? 2;
  const kept = [];
  const refused = [];
  const candidates = [];

  for (const tree of trees) {
    if (!isParked(tree.branch)) {
      kept.push(tree.name); // main tree or a claimed ref — never a candidate
      continue;
    }
    if (tree.blocked) {
      refused.push({ name: tree.name, why: tree.blocked });
      continue;
    }
    candidates.push(tree);
  }

  // Newest build first, so the survivors are the warmest caches.
  candidates.sort((a, b) => b.lastBuiltMs - a.lastBuiltMs);
  const remove = [];
  candidates.forEach((tree, i) => {
    if (i < keep) kept.push(tree.name);
    else remove.push(tree);
  });

  // Oldest first, so a partial run removes the least valuable trees.
  remove.sort((a, b) => a.lastBuiltMs - b.lastBuiltMs);
  return { remove: remove.map((t) => t.name), keep: kept, refused };
}
