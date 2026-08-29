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

/** How long a tree must sit untouched before it may be collected (12h).
 *
 *  The guard exists because MERGED IS NOT IDLE. A session merges its branch and keeps working in the
 *  same tree — the tree this janitor's own fix was written in was on a merged branch at the time —
 *  so without this, "collect merged trees" would delete a working tree out from under a live agent.
 *  Build recency cannot stand in for it: a tree can be actively edited for an hour without a compile. */
export const DEFAULT_MIN_IDLE_MS = 12 * 60 * 60 * 1000;

/** A tree may be collected when its branch is parked OR already merged into the integration branch.
 *
 *  The original policy was `parked-*` only, and that is why the pool grew to 64 trees holding 631 GB:
 *  CLAUDE.md's step 7 offers "recycle onto the next ref OR park", and in practice an agent merges and
 *  simply stops — leaving the tree on its own WORK branch. Measured 2026-08-29: of 23 merged trees
 *  only 3 were on a `parked-*` branch, so 20 of them (~380 GB) were invisible to this janitor
 *  forever. A merged branch is not a claimed ref; its tree is worth exactly what a parked one is,
 *  a warm `target/`, and should be capped the same way. */
export function isCollectable(tree) {
  // NEVER the main tree, and never an integration branch. This is explicit rather than incidental:
  // the old `parked-*`-only rule excluded `develop` as a side effect of its naming test, and widening
  // to "merged" silently removed that cover — `git merge-base --is-ancestor develop develop` is TRUE,
  // so the main worktree became a deletion candidate. Caught by running the widened janitor with its
  // idle guard disabled, which proposed removing the repository itself.
  if (tree?.isMain) return false;
  if (INTEGRATION_BRANCHES.has(tree?.branch)) return false;
  return isParked(tree?.branch) || tree?.merged === true;
}

/** Branches that are never collectable however they compare to the integration branch. */
export const INTEGRATION_BRANCHES = new Set(["develop", "main", "master"]);

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
 * @param {Array<{name: string, branch: string|null, lastBuiltMs: number, lastActiveMs?: number,
 *   merged?: boolean, blocked?: string|null}>} trees
 * @param {{keep?: number, minIdleMs?: number, now?: number}} [opts] `keep` trees to spare, newest
 *   first (default 2); `minIdleMs` the activity guard (default [`DEFAULT_MIN_IDLE_MS`])
 * @returns {{remove: string[], keep: string[], refused: Array<{name: string, why: string}>}}
 */
export function planCap(trees, opts = {}) {
  const keep = opts.keep ?? 2;
  const minIdleMs = opts.minIdleMs ?? DEFAULT_MIN_IDLE_MS;
  const now = opts.now ?? Date.now();
  const kept = [];
  const refused = [];
  const candidates = [];

  for (const tree of trees) {
    if (!isCollectable(tree)) {
      kept.push(tree.name); // main tree, or a ref whose work has not landed — never a candidate
      continue;
    }
    // MERGED IS NOT IDLE: a live session keeps working in a tree after merging its branch. Kept,
    // not refused — there is no hazard here, the tree is simply still in use.
    // MAX, not `??`: a caller that reports an explicit `lastActiveMs: 0` (no index yet) would defeat
    // a nullish fallback, and a tree that has been COMPILING for an hour is in use whatever its index
    // says. Either signal counting as activity is the safe direction.
    const idleFor = now - Math.max(tree.lastActiveMs ?? 0, tree.lastBuiltMs ?? 0);
    if (idleFor < minIdleMs) {
      kept.push(tree.name);
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
