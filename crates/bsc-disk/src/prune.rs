//! Pure selection logic for pruning orphaned incremental-compilation directories (#3821).
//!
//! Ported from `scripts/incremental-prune-plan.mjs`. Side-effect-free: no filesystem, no clock —
//! `now` is a parameter — so the decision of WHAT to delete is testable without a build tree.
//!
//! ## What these directories are
//!
//! `target/<profile>/incremental/` holds one directory per `<crate_name>-<stable-crate-id>`. The
//! suffix is a hash of the crate name plus the `-C metadata` cargo passes, which folds in the
//! package id, the enabled FEATURE SET, the PROFILE settings, target triple, rustc version, and
//! whether it is a lib or a test harness. Change any of those and cargo emits a NEW directory; the
//! old one is orphaned permanently.
//!
//! Nothing reclaims them. rustc's own GC runs inside the directory for the crate being compiled,
//! pruning superseded sessions there (which is why each holds only 1-2), but a sibling directory
//! for another crate-id is, to rustc, a different crate. Cargo's `-Zgc` covers the global caches
//! under `~/.cargo`, not build output.
//!
//! ## Why deleting is safe
//!
//! Incremental state is a PURE CACHE. Removing any of it can only cost rebuild time, never
//! correctness — which is what lets this run unattended before a dev launch.

/// How many trailing `[0-9a-z]` characters a stable-crate-id must have for a directory name to be
/// recognized as `<crate_name>-<id>`. Real ids observed are 13 chars; the floor is deliberately
/// loose but long enough that a hyphenated word cannot be mistaken for one.
const MIN_CRATE_ID_LEN: usize = 10;

/// One directory (or, for `sweep`, one compilation unit) as the planner sees it: a name and when it
/// was last touched. Nothing else about it can affect the decision.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub name: String,
    pub mtime_ms: f64,
}

impl Entry {
    pub fn new(name: impl Into<String>, mtime_ms: f64) -> Self {
        Self { name: name.into(), mtime_ms }
    }
}

/// What a sweep would do: `prune` OLDEST-FIRST so a truncated log shows the stalest first.
#[derive(Debug, Default, PartialEq)]
pub struct PrunePlan {
    pub prune: Vec<String>,
    pub keep: Vec<String>,
}

/// Split an incremental directory name into its crate name, or `None` when the name does not have
/// the `<crate_name>-<stable-crate-id>` shape.
///
/// Cargo renders crate names with underscores here (`base-studio-code` → `base_studio_code`), so
/// the crate-name half never contains a hyphen and the LAST hyphen is unambiguously the split.
/// `None` means "unrecognized" and the caller must keep the directory — being wrong about the shape
/// should cost disk, never someone else's cache.
pub fn crate_name_of(dir_name: &str) -> Option<&str> {
    let cut = dir_name.rfind('-')?;
    if cut == 0 {
        return None; // empty crate name
    }
    let id = &dir_name[cut + 1..];
    if id.len() < MIN_CRATE_ID_LEN {
        return None;
    }
    if !id.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase()) {
        return None;
    }
    Some(&dir_name[..cut])
}

/// Decide which incremental directories to delete.
///
/// Two independent guards, and an entry survives if EITHER spares it:
///   1. **Keep the newest `keep` per crate name.** The live cache for each crate survives even if
///      the whole tree is older than the cutoff (e.g. a crate nobody has rebuilt in months) — so a
///      sweep never forces a from-scratch rebuild of something that was working.
///   2. **Age cutoff.** Only directories untouched for `days` are eligible. An in-flight build
///      stamps its directory's mtime to now, so a concurrent `cargo build` can never have its cache
///      pulled out from under it.
///
/// THE FLOOR IS NOT A FLOOR — it is a blanket exemption for everything younger than it, because the
/// two guards are OR-ed. That is correct (both clauses are safety conditions) and it is why the
/// DEFAULT matters so much: at the old three-day default a tree built today had nothing eligible at
/// all. MEASURED 2026-09-01: 0 of 266 dirs, on a repo holding 310 GB of incremental.
///
/// Unrecognized names (per [`crate_name_of`]) are always kept.
pub fn plan_prune(entries: &[Entry], days: f64, keep: usize, now_ms: f64) -> PrunePlan {
    let cutoff = now_ms - days * 86_400_000.0;

    // Insertion-ordered grouping: the JavaScript used a Map, whose iteration order is insertion
    // order, and the `keep` list's order is asserted in the ported tests.
    let mut order: Vec<String> = Vec::new();
    let mut by_crate: std::collections::HashMap<String, Vec<Entry>> = std::collections::HashMap::new();
    let mut kept: Vec<String> = Vec::new();

    for entry in entries {
        match crate_name_of(&entry.name) {
            None => kept.push(entry.name.clone()), // unrecognized shape — not ours to delete
            Some(crate_name) => {
                let group = by_crate.entry(crate_name.to_string()).or_insert_with(|| {
                    order.push(crate_name.to_string());
                    Vec::new()
                });
                group.push(entry.clone());
            }
        }
    }

    let mut pruned: Vec<Entry> = Vec::new();
    for crate_name in &order {
        let group = by_crate.get_mut(crate_name).expect("every ordered key was inserted");
        // Newest first, so the `keep` survivors are the freshest caches for that crate.
        group.sort_by(|a, b| b.mtime_ms.total_cmp(&a.mtime_ms));
        for (i, entry) in group.iter().enumerate() {
            if i < keep || entry.mtime_ms >= cutoff {
                kept.push(entry.name.clone());
            } else {
                pruned.push(entry.clone());
            }
        }
    }

    pruned.sort_by(|a, b| a.mtime_ms.total_cmp(&b.mtime_ms));
    PrunePlan { prune: pruned.into_iter().map(|e| e.name).collect(), keep: kept }
}

#[cfg(test)]
mod tests {
    //! Carried over from `scripts/incremental-prune-plan.test.ts` (#3821), assertion for assertion.
    //! These cover the two guards that decide what a sweep may delete — keep-newest-per-crate and
    //! the age cutoff — plus the name parsing, without touching a filesystem.
    use super::*;

    const DAY: f64 = 86_400_000.0;
    const NOW: f64 = 1_700_000_000_000.0;

    /// `n` days before `NOW`.
    fn days_ago(n: f64) -> f64 {
        NOW - n * DAY
    }

    fn e(name: &str, mtime_ms: f64) -> Entry {
        Entry::new(name, mtime_ms)
    }

    #[test]
    fn crate_name_of_splits_real_cargo_incremental_dir_names() {
        assert_eq!(crate_name_of("base_studio_code_lib-0n9p2yhrm5isb"), Some("base_studio_code_lib"));
        assert_eq!(crate_name_of("bsc-00d9fsk2cry13"), Some("bsc"));
        assert_eq!(crate_name_of("bsc_data-161fe4604e2c47b0"), Some("bsc_data"));
    }

    #[test]
    fn crate_name_of_keeps_the_crate_name_intact() {
        // `base-studio-code` is rendered `base_studio_code` here, so the name half has no hyphens
        // and the LAST hyphen is the split.
        assert_eq!(crate_name_of("base_studio_code-2gjyo5q5fykho"), Some("base_studio_code"));
    }

    #[test]
    fn crate_name_of_returns_none_for_anything_not_shaped_like_crate_id() {
        assert_eq!(crate_name_of("no-id"), None); // suffix too short to be a crate id
        assert_eq!(crate_name_of("nohyphenatall"), None);
        assert_eq!(crate_name_of("-0n9p2yhrm5isb"), None); // empty crate name
        assert_eq!(crate_name_of("crate-NOTLOWERCASE1"), None); // ids are [0-9a-z]
    }

    #[test]
    fn prunes_only_what_is_older_than_the_cutoff() {
        let plan = plan_prune(
            &[
                e("bsc-aaaaaaaaaaaaa", days_ago(0.0)),
                e("bsc-bbbbbbbbbbbbb", days_ago(20.0)),
                e("bsc-ccccccccccccc", days_ago(30.0)),
            ],
            14.0,
            1,
            NOW,
        );
        // Newest is spared by keep=1; the other two are both past the cutoff.
        assert_eq!(plan.prune, vec!["bsc-ccccccccccccc", "bsc-bbbbbbbbbbbbb"]);
    }

    #[test]
    fn prunes_nothing_when_everything_is_recent() {
        let plan = plan_prune(
            &[e("bsc-aaaaaaaaaaaaa", days_ago(1.0)), e("bsc-bbbbbbbbbbbbb", days_ago(2.0))],
            14.0,
            1,
            NOW,
        );
        assert!(plan.prune.is_empty(), "a busy tree is left alone");
    }

    #[test]
    fn never_touches_a_directory_an_in_flight_build_just_stamped() {
        // The concurrency guarantee: a live `cargo build` sets mtime to now, so however old the rest
        // of the tree is, the directory being written cannot be swept out from under it.
        let plan = plan_prune(
            &[
                e("bsc-aaaaaaaaaaaaa", NOW),
                e("bsc-bbbbbbbbbbbbb", days_ago(400.0)),
                e("bsc-ccccccccccccc", days_ago(500.0)),
            ],
            14.0,
            1,
            NOW,
        );
        assert!(!plan.prune.contains(&"bsc-aaaaaaaaaaaaa".to_string()));
        assert!(plan.keep.contains(&"bsc-aaaaaaaaaaaaa".to_string()));
    }

    #[test]
    fn spares_the_newest_per_crate_even_past_the_cutoff() {
        // A crate nobody has rebuilt in months keeps a working cache — a sweep must not force a
        // from-scratch rebuild of something that was fine.
        let plan = plan_prune(
            &[e("llm-aaaaaaaaaaaaa", days_ago(100.0)), e("llm-bbbbbbbbbbbbb", days_ago(200.0))],
            14.0,
            1,
            NOW,
        );
        assert_eq!(plan.prune, vec!["llm-bbbbbbbbbbbbb"]);
        assert_eq!(plan.keep, vec!["llm-aaaaaaaaaaaaa"]);
    }

    #[test]
    fn counts_the_survivors_per_crate_not_across_the_tree() {
        let plan = plan_prune(
            &[
                e("llm-aaaaaaaaaaaaa", days_ago(100.0)),
                e("llm-bbbbbbbbbbbbb", days_ago(200.0)),
                e("plandb-ccccccccccccc", days_ago(100.0)),
                e("plandb-ddddddddddddd", days_ago(200.0)),
            ],
            14.0,
            1,
            NOW,
        );
        let mut got = plan.prune.clone();
        got.sort();
        // One survivor EACH, not one overall.
        assert_eq!(got, vec!["llm-bbbbbbbbbbbbb", "plandb-ddddddddddddd"]);
    }

    #[test]
    fn honours_a_larger_keep() {
        let plan = plan_prune(
            &[
                e("llm-aaaaaaaaaaaaa", days_ago(100.0)),
                e("llm-bbbbbbbbbbbbb", days_ago(200.0)),
                e("llm-ccccccccccccc", days_ago(300.0)),
            ],
            14.0,
            2,
            NOW,
        );
        assert_eq!(plan.prune, vec!["llm-ccccccccccccc"]);
    }

    #[test]
    fn never_prunes_a_directory_whose_name_it_does_not_recognize() {
        let plan = plan_prune(
            &[e("something-else", days_ago(500.0)), e("s-hkrbnw6c7i-0hz9snw.lock", days_ago(500.0))],
            14.0,
            1,
            NOW,
        );
        assert!(plan.prune.is_empty());
        let mut kept = plan.keep.clone();
        kept.sort();
        assert_eq!(kept, vec!["s-hkrbnw6c7i-0hz9snw.lock", "something-else"]);
    }

    #[test]
    fn returns_an_empty_plan_for_an_empty_tree() {
        assert_eq!(plan_prune(&[], 3.0, 1, NOW), PrunePlan::default());
    }

    #[test]
    fn reports_prune_oldest_first() {
        // So a truncated log shows the stalest first.
        let plan = plan_prune(
            &[
                e("bsc-aaaaaaaaaaaaa", days_ago(0.0)),
                e("bsc-bbbbbbbbbbbbb", days_ago(50.0)),
                e("bsc-ccccccccccccc", days_ago(500.0)),
                e("bsc-ddddddddddddd", days_ago(100.0)),
            ],
            14.0,
            1,
            NOW,
        );
        assert_eq!(plan.prune, vec!["bsc-ccccccccccccc", "bsc-ddddddddddddd", "bsc-bbbbbbbbbbbbb"]);
    }

    // ── the age cutoff has to be shorter than a working session ──────────────────────────────────
    //
    // `plan_prune` keeps an entry when it is newest-per-crate OR newer than the cutoff. The OR is
    // correct but it means every directory younger than the cutoff survives regardless of `keep`.
    // These pin the SHAPE, so a future edit cannot restore a cutoff that exempts a working day.

    /// 2026-09-01T18:00:00Z in epoch ms — the day the six-hour floor was measured.
    const SESSION_NOW: f64 = 1_788_026_400_000.0;

    fn hours_ago(name: &str, hours: f64) -> Entry {
        Entry::new(name, SESSION_NOW - hours * 3_600_000.0)
    }

    #[test]
    fn collects_a_cache_untouched_for_a_working_day() {
        let entries = [
            hours_ago("bsc_graph-1aaaaaaaaaaaa", 0.1), // the live cache for this crate
            hours_ago("bsc_graph-2bbbbbbbbbbbb", 8.0),
            hours_ago("bsc_graph-3ccccccccccc", 30.0),
        ];
        let plan = plan_prune(&entries, 6.0 / 24.0, 1, SESSION_NOW);
        assert!(plan.keep.contains(&"bsc_graph-1aaaaaaaaaaaa".to_string()));
        assert_eq!(plan.prune, vec!["bsc_graph-3ccccccccccc", "bsc_graph-2bbbbbbbbbbbb"]); // oldest-first
    }

    #[test]
    fn spares_everything_at_the_old_three_day_cutoff() {
        // The no-op this default replaced.
        let entries =
            [hours_ago("s-aaa-1", 0.1), hours_ago("bsc_graph-2bbbbbbbbbbbb", 8.0), hours_ago("s-aaa-3", 30.0)];
        assert!(plan_prune(&entries, 3.0, 1, SESSION_NOW).prune.is_empty());
    }

    #[test]
    fn never_prunes_the_newest_cache_for_a_crate_even_when_older_than_the_cutoff() {
        // The live cache is spared by IDENTITY, not by age, so a build writing right now is never a
        // candidate however short the cutoff gets. That is what makes a six-hour floor safe.
        let entries = [hours_ago("bsc_data-1ddddddddddd", 100.0), hours_ago("bsc_data-2eeeeeeeeeee", 200.0)];
        let plan = plan_prune(&entries, 6.0 / 24.0, 1, SESSION_NOW);
        assert_eq!(plan.keep, vec!["bsc_data-1ddddddddddd"]);
        assert_eq!(plan.prune, vec!["bsc_data-2eeeeeeeeeee"]);
    }
}
