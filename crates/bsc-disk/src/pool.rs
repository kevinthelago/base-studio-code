//! Pure selection logic for capping the PARKED worktree pool.
//!
//! Ported from `scripts/worktree-pool-plan.mjs`. Side-effect-free — no git, no filesystem — so the
//! decision of WHICH tree to remove is testable without a repository.
//!
//! ## What a parked tree is for, and what it costs
//!
//! A parked worktree exists ONLY to keep a warm `target/`. CLAUDE.md measures that as worth about
//! two minutes — a fresh worktree cold-builds `bsc` in 1m59s against 0.41-5.11s recycled. Each tree
//! costs ~18-21 GB, so eight parked trees hold roughly 160 GB to save at most ~16 minutes.
//!
//! Nothing INSIDE a worktree is reclaimable — the deps GC measured 0 orphaned units on every one of
//! them, because they are too young to have any. ~21 GB is simply what one warm tree weighs. The
//! only lever is how many exist, which is what this plans.

/// How long a tree must sit untouched before it may be collected (6h).
///
/// The guard exists because MERGED IS NOT IDLE. A session merges its branch and keeps working in the
/// same tree — the tree this janitor's own fix was written in was on a merged branch at the time —
/// so without this, "collect merged trees" would delete a working tree out from under a live agent.
/// Build recency cannot stand in for it: a tree can be actively edited for an hour without a compile.
///
/// WAS 12 HOURS, WHICH NO TREE HERE EVER REACHED. A parked tree is reclaimed by the next session
/// that wants one, measured at ~20 minutes, so the pool never contained a 12-hour-idle tree and this
/// janitor reported "nothing to remove" while 227 GB sat in eight parked trees (2026-09-01). Six
/// hours is taken from how long a session actually holds a tree — 30 minutes to 4 hours — with
/// margin over the longest, and the cost of being wrong is bounded: a collected tree is `parked-*`
/// or already merged, so the loss is a warm `target/` worth about two minutes, never work.
pub const DEFAULT_MIN_IDLE_MS: f64 = 6.0 * 60.0 * 60.0 * 1000.0;

/// Branches that are never collectable however they compare to the integration branch.
pub const INTEGRATION_BRANCHES: [&str; 3] = ["develop", "main", "master"];

/// How many collectable trees survive a cap, newest-built first.
///
/// THE DEFAULT LIVES HERE, not in the argument parser, which is the one shape change from the
/// JavaScript. There, `planPrune` and `planCap` each carried their own defaults AND the runner
/// always passed an explicit value — so editing the pure module's default was dead code, and an
/// earlier pass did exactly that (the sweep kept running at 14 days while the docs claimed 3). Every
/// `plan_*` function here takes its policy as a required argument and the default is a named const
/// the CLI reads, so there is only one place to change and no way to change the wrong one.
pub const DEFAULT_KEEP: usize = 2;

/// One worktree as the planner sees it. Everything here is measured by the driver
/// ([`crate::worktree`]); nothing in this module reads git or the filesystem.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tree {
    /// The tree's path — the name every outcome is reported by.
    pub name: String,
    /// `None` for a detached HEAD: we cannot name what it holds, so it is never collectable.
    pub branch: Option<String>,
    /// When this tree was last COMPILED IN — the warm `target/` is the only thing it is for.
    pub last_built_ms: f64,
    /// When anyone last WORKED in it, as opposed to last compiled in it.
    pub last_active_ms: f64,
    /// Already contained in the integration branch, so it holds no unlanded work.
    pub merged: bool,
    /// A hazard that makes removal destructive. `Some(why)` is REPORTED, never removed.
    pub blocked: Option<String>,
    /// The repository's own main worktree.
    pub is_main: bool,
}

/// The three outcomes, and the middle one is the reason this is not just a sort.
#[derive(Debug, Default, PartialEq)]
pub struct CapPlan {
    /// Oldest-built first, so a partial run removes the least valuable trees.
    pub remove: Vec<String>,
    pub keep: Vec<String>,
    /// A candidate by policy that carries a hazard. Reported, never silently skipped and never
    /// removed anyway: a caller that cannot tell "nothing to do" from "I declined to touch this"
    /// will assume the pool is capped when it is not.
    pub refused: Vec<(String, String)>,
}

/// A branch is parked when it is literally named `parked-<something>` — the convention CLAUDE.md's
/// recycle-don't-recreate step uses (`git checkout -B parked-<short> develop`). Anything else is a
/// claimed ref and must never be a candidate.
pub fn is_parked(branch: Option<&str>) -> bool {
    branch.is_some_and(|b| b.strip_prefix("parked-").is_some_and(|rest| !rest.is_empty()))
}

/// A tree may be collected when its branch is parked OR already merged into the integration branch.
///
/// The original policy was `parked-*` only, and that is why the pool grew to 64 trees holding
/// 631 GB: CLAUDE.md's step 7 offers "recycle onto the next ref OR park", and in practice an agent
/// merges and simply stops — leaving the tree on its own WORK branch. Measured 2026-08-29: of 23
/// merged trees only 3 were on a `parked-*` branch, so 20 of them (~380 GB) were invisible to this
/// janitor forever. A merged branch is not a claimed ref; its tree is worth exactly what a parked
/// one is, a warm `target/`, and should be capped the same way.
pub fn is_collectable(tree: &Tree) -> bool {
    // NEVER the main tree, and never an integration branch. This is explicit rather than incidental:
    // the old `parked-*`-only rule excluded `develop` as a side effect of its naming test, and
    // widening to "merged" silently removed that cover — `git merge-base --is-ancestor develop
    // develop` is TRUE, so the main worktree became a deletion candidate. Caught by running the
    // widened janitor with its idle guard disabled, which proposed removing the repository itself.
    if tree.is_main {
        return false;
    }
    if tree.branch.as_deref().is_some_and(|b| INTEGRATION_BRANCHES.contains(&b)) {
        return false;
    }
    is_parked(tree.branch.as_deref()) || tree.merged
}

/// Decide which parked worktrees to remove.
///
/// Recency is "last built", not last committed: the whole value of a parked tree is its warm
/// `target/`, so the tree most recently compiled in is the one most likely to be worth keeping.
pub fn plan_cap(trees: &[Tree], keep: usize, min_idle_ms: f64, now_ms: f64) -> CapPlan {
    let mut kept: Vec<String> = Vec::new();
    let mut refused: Vec<(String, String)> = Vec::new();
    let mut candidates: Vec<&Tree> = Vec::new();

    for tree in trees {
        if !is_collectable(tree) {
            kept.push(tree.name.clone()); // main tree, or a ref whose work has not landed
            continue;
        }
        // MERGED IS NOT IDLE: a live session keeps working in a tree after merging its branch. Kept,
        // not refused — there is no hazard here, the tree is simply still in use.
        //
        // MAX, not a fallback: a tree that has been COMPILING for an hour is in use whatever its
        // index says, and a tree with no index yet reports 0. Either signal counting as activity is
        // the safe direction.
        let idle_for = now_ms - tree.last_active_ms.max(tree.last_built_ms);
        if idle_for < min_idle_ms {
            kept.push(tree.name.clone());
            continue;
        }
        if let Some(why) = &tree.blocked {
            refused.push((tree.name.clone(), why.clone()));
            continue;
        }
        candidates.push(tree);
    }

    // Newest build first, so the survivors are the warmest caches.
    candidates.sort_by(|a, b| b.last_built_ms.total_cmp(&a.last_built_ms));
    let mut remove: Vec<&Tree> = Vec::new();
    for (i, tree) in candidates.iter().enumerate() {
        if i < keep {
            kept.push(tree.name.clone());
        } else {
            remove.push(tree);
        }
    }

    // Oldest first, so a partial run removes the least valuable trees.
    remove.sort_by(|a, b| a.last_built_ms.total_cmp(&b.last_built_ms));
    CapPlan { remove: remove.into_iter().map(|t| t.name.clone()).collect(), keep: kept, refused }
}

#[cfg(test)]
mod tests {
    //! Carried over from `scripts/worktree-pool-plan.test.ts`, assertion for assertion. These cover
    //! the guards that decide what may be DELETED — a mistake here removes someone's working tree,
    //! so every exclusion is pinned.
    use super::*;

    /// The shape the first block of the TypeScript used: only `lastBuiltMs` is set, and
    /// `lastActiveMs` is absent (0), so the idle guard is switched off with `min_idle_ms = 0`.
    fn tree(name: &str, branch: Option<&str>, last_built_ms: f64, blocked: Option<&str>) -> Tree {
        Tree {
            name: name.to_string(),
            branch: branch.map(String::from),
            last_built_ms,
            last_active_ms: 0.0,
            merged: false,
            blocked: blocked.map(String::from),
            is_main: false,
        }
    }

    /// `plan_cap` with the idle guard disabled — the TypeScript's first block never passed
    /// `minIdleMs` and its trees had `lastBuiltMs` in the single digits against a `Date.now()`
    /// default, so every one of them read as idle.
    fn cap(trees: &[Tree], keep: usize) -> CapPlan {
        plan_cap(trees, keep, 0.0, f64::MAX)
    }

    #[test]
    fn is_parked_matches_only_the_parked_convention() {
        assert!(is_parked(Some("parked-ddbcache")));
        assert!(!is_parked(Some("develop")));
        assert!(!is_parked(Some("parked-"))); // needs a suffix
        assert!(!is_parked(Some("unparked-thing")));
        assert!(!is_parked(Some("feature/parked-thing"))); // must not match mid-name
        assert!(!is_parked(None)); // detached HEAD
    }

    #[test]
    fn never_removes_the_main_tree_or_an_active_ref_whatever_the_keep_count() {
        let mut main = tree("/repo", Some("develop"), 100.0, None);
        main.is_main = true;
        let plan = cap(
            &[
                main,
                tree("/repo/wt-order", Some("requestsessionsmount-is-order-dependent"), 50.0, None),
                tree("/repo/wt-a", Some("parked-a"), 10.0, None),
                tree("/repo/wt-b", Some("parked-b"), 20.0, None),
                tree("/repo/wt-c", Some("parked-c"), 30.0, None),
            ],
            0,
        );
        assert!(plan.keep.contains(&"/repo".to_string()));
        assert!(plan.keep.contains(&"/repo/wt-order".to_string()));
        assert_eq!(plan.remove, vec!["/repo/wt-a", "/repo/wt-b", "/repo/wt-c"]);
    }

    #[test]
    fn keeps_the_n_most_recently_built_parked_trees() {
        // Not the most recently committed — the warm target/ is the whole point.
        let plan = cap(
            &[
                tree("/wt-old", Some("parked-old"), 1.0, None),
                tree("/wt-mid", Some("parked-mid"), 5.0, None),
                tree("/wt-new", Some("parked-new"), 9.0, None),
            ],
            2,
        );
        assert_eq!(plan.keep, vec!["/wt-new", "/wt-mid"]);
        assert_eq!(plan.remove, vec!["/wt-old"]);
    }

    #[test]
    fn removes_oldest_first_so_a_partial_run_drops_the_least_valuable_trees() {
        let plan = cap(
            &[
                tree("/a", Some("parked-a"), 30.0, None),
                tree("/b", Some("parked-b"), 10.0, None),
                tree("/c", Some("parked-c"), 20.0, None),
            ],
            0,
        );
        assert_eq!(plan.remove, vec!["/b", "/c", "/a"]);
    }

    #[test]
    fn refuses_a_blocked_tree_instead_of_removing_or_silently_skipping_it() {
        // The hazard that justifies a THIRD outcome. Silently skipping a blocked tree would leave
        // the caller believing the pool was capped when it was not.
        let plan = cap(
            &[
                tree("/wt-junction", Some("parked-junction"), 1.0, Some("node_modules is a symlink/junction")),
                tree("/wt-fine", Some("parked-fine"), 2.0, None),
            ],
            0,
        );
        assert_eq!(plan.remove, vec!["/wt-fine"]);
        assert_eq!(
            plan.refused,
            vec![("/wt-junction".to_string(), "node_modules is a symlink/junction".to_string())]
        );
        // Reported, not quietly counted as kept.
        assert!(!plan.keep.contains(&"/wt-junction".to_string()));
    }

    #[test]
    fn the_default_keep_is_two() {
        // The TypeScript pinned this by calling `planCap` with no options; here the default is a
        // named const the CLI reads, so it is pinned directly.
        let plan = cap(
            &[
                tree("/a", Some("parked-a"), 1.0, None),
                tree("/b", Some("parked-b"), 2.0, None),
                tree("/c", Some("parked-c"), 3.0, None),
            ],
            DEFAULT_KEEP,
        );
        assert_eq!(plan.remove, vec!["/a"]);
    }

    #[test]
    fn removes_nothing_when_the_pool_is_already_at_or_under_the_cap() {
        let plan = cap(&[tree("/a", Some("parked-a"), 1.0, None), tree("/b", Some("parked-b"), 2.0, None)], 2);
        assert!(plan.remove.is_empty());
    }

    // ── Merged trees are collectable too (2026-08-29) ────────────────────────────────────────────
    //
    // The `parked-*`-only rule is why the pool reached 64 trees holding 631 GB. CLAUDE.md step 7
    // offers "recycle onto the next ref OR park", and in practice an agent merges its branch and
    // stops, leaving the tree on its own WORK branch. Measured that day: of 23 merged trees only 3
    // were on `parked-*`, so 20 (~380 GB) could never be seen by this janitor.

    fn t(branch: Option<&str>, merged: bool, is_main: bool) -> Tree {
        Tree { branch: branch.map(String::from), merged, is_main, ..Tree::default() }
    }

    #[test]
    fn accepts_a_parked_branch_or_a_merged_one_and_rejects_an_unlanded_ref() {
        assert!(is_collectable(&t(Some("parked-x"), false, false)));
        assert!(is_collectable(&t(Some("148-tests-set"), true, false)));
        assert!(!is_collectable(&t(Some("148-tests-set"), false, false)));
    }

    #[test]
    fn never_accepts_the_main_tree_or_an_integration_branch_however_merged_they_look() {
        // THE REGRESSION THIS EXISTS FOR. `git merge-base --is-ancestor develop develop` is TRUE, so
        // widening the rule from `parked-*` to "merged" made the MAIN WORKTREE a deletion candidate.
        // The old naming test had excluded it only as a side effect. Found by running the widened
        // janitor with its idle guard disabled, which proposed removing the repository itself.
        assert!(!is_collectable(&t(Some("develop"), true, false)));
        assert!(!is_collectable(&t(Some("main"), true, false)));
        assert!(!is_collectable(&t(Some("master"), true, false)));
        assert!(!is_collectable(&t(Some("parked-x"), false, true)));
        assert!(!is_collectable(&t(Some("anything"), true, true)));
    }

    const HOUR: f64 = 60.0 * 60.0 * 1000.0;

    /// The shape the activity-guard block used: every field explicit, defaults at 0.
    fn idle(name: &str, branch: &str, merged: bool, last_built_ms: f64, last_active_ms: f64) -> Tree {
        Tree {
            name: name.to_string(),
            branch: Some(branch.to_string()),
            last_built_ms,
            last_active_ms,
            merged,
            blocked: None,
            is_main: false,
        }
    }

    #[test]
    fn keeps_a_merged_tree_that_someone_is_still_working_in() {
        // MERGED IS NOT IDLE. A session merges its branch and keeps working in the same tree — the
        // tree this fix was written in was on a merged branch while it was being written. Without
        // this guard, collecting merged trees deletes a working tree out from under a live agent.
        let now = 100.0 * HOUR;
        let plan = plan_cap(
            &[
                idle("/wt-live", "landed-an-hour-ago", true, 0.0, now - HOUR),
                idle("/wt-cold", "landed-last-week", true, 0.0, now - 90.0 * HOUR),
            ],
            0,
            DEFAULT_MIN_IDLE_MS,
            now,
        );
        assert_eq!(plan.remove, vec!["/wt-cold"]);
        assert!(plan.keep.contains(&"/wt-live".to_string()));
    }

    #[test]
    fn counts_a_long_compile_as_activity_so_a_building_tree_is_not_collected() {
        let now = 100.0 * HOUR;
        let plan = plan_cap(
            &[idle("/wt-building", "landed", true, now - HOUR, 0.0)],
            0,
            DEFAULT_MIN_IDLE_MS,
            now,
        );
        assert!(plan.remove.is_empty());
    }

    #[test]
    fn keeps_an_in_use_tree_rather_than_refusing_it() {
        // Being busy is not a hazard.
        let now = 100.0 * HOUR;
        let mut live = idle("/wt-live", "landed", true, 0.0, now);
        live.blocked = Some("junction".to_string());
        let plan = plan_cap(&[live], 0, DEFAULT_MIN_IDLE_MS, now);
        assert!(plan.refused.is_empty(), "never even reaches the hazard check");
        assert!(plan.keep.contains(&"/wt-live".to_string()));
    }

    #[test]
    fn still_spares_the_keep_newest_among_collectable_idle_trees() {
        let now = 1000.0 * HOUR;
        let plan = plan_cap(
            &[
                idle("/a", "x", true, 1.0, 1.0),
                idle("/b", "y", true, 2.0, 2.0),
                idle("/c", "parked-c", false, 3.0, 3.0),
            ],
            1,
            DEFAULT_MIN_IDLE_MS,
            now,
        );
        // Oldest first; /c is the warmest and survives.
        assert_eq!(plan.remove, vec!["/a", "/b"]);
    }

    // ── the idle guard is scaled to a session, not to a day ──────────────────────────────────────
    //
    // MEASURED 2026-09-01: at the previous 12 hours nothing here was ever eligible — a parked tree is
    // reclaimed by the next session that wants one, at roughly 20 minutes — so `cap-worktrees`
    // reported "nothing to remove" while 227 GB sat in eight parked trees. Sessions run 30 minutes to
    // 4 hours, so the guard is pinned BETWEEN the longest session and half a day.

    #[test]
    fn the_idle_guard_is_longer_than_the_longest_session_and_well_under_half_a_day() {
        let hours = DEFAULT_MIN_IDLE_MS / 3_600_000.0;
        assert!(hours > 4.0, "shorter than a session would take a working tree");
        assert!(hours <= 8.0, "longer than this and the janitor is a no-op");
    }

    #[test]
    fn would_have_spared_a_tree_touched_inside_a_session_and_collected_one_left_overnight() {
        // 2026-09-01T18:00:00Z.
        let now = 1_788_285_600_000.0_f64;
        let at = |name: &str, hours_ago: f64| Tree {
            name: format!("/repo/{name}"),
            branch: Some(format!("parked-{name}")),
            last_built_ms: now - hours_ago * HOUR,
            last_active_ms: now - hours_ago * HOUR,
            ..Tree::default()
        };
        // keep = 0 so the age guard is the only thing deciding.
        let plan = plan_cap(&[at("fresh", 1.0), at("stale", 9.0)], 0, DEFAULT_MIN_IDLE_MS, now);
        assert!(plan.remove.contains(&"/repo/stale".to_string()));
        assert!(!plan.remove.contains(&"/repo/fresh".to_string()));
    }
}
