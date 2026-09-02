//! The ONE garbage-collection entry point for a build tree.
//!
//! Ported from `scripts/gc.mjs`.
//!
//! ## The bug this exists to fix
//!
//! The two sweeps were correct and tested, and they never ran. Both hung off `build:plan`, which is
//! invoked only by `beforeDevCommand` in tauri.conf.json — that is, by `npm run tauri -- dev`. A
//! worktree agent runs the gate and `cargo`; it never runs `tauri dev`. So the ONLY tree ever swept
//! was the one where the app gets launched, which is exactly the tree that accumulated two months of
//! orphans (75 GB, 8 copies of libduckdb_sys, fingerprint dirs back to June 22). The worktrees — the
//! trees the fleet actually works in — had never been swept once. They audited clean only because
//! they were young.
//!
//! The policy was never the problem. WHERE IT WAS ATTACHED was.
//!
//! ## Why one entry point
//!
//! There were three janitor scripts with three flag sets and three report formats. A caller should
//! not have to know which of them covers which directory. `gc` is the name the gate and `build:plan`
//! both call; the individual verbs remain and stay runnable on their own for targeted work
//! (`--root` against another tree, for instance).
//!
//! The DESTRUCTIVE worktree cap is deliberately not part of this. These sweeps' worst outcome is a
//! rebuild; removing a working tree is a different kind of act and stays an explicit command.
//!
//! ## The stamp
//!
//! The gate runs constantly during iteration, and ~1.5s of sweeping on every run is a tax for
//! nothing — a tree cannot accrue meaningful garbage in the minutes between two gate runs. So a
//! stamp file records the last sweep and the run is skipped inside the window. It lives in `target/`
//! because it describes that tree's build output: per-tree, disposable, and destroyed by
//! `cargo clean` along with the thing it describes.

use crate::sweep::{prune_incremental, sweep_deps, SweepReport, DEFAULT_DAYS, DEFAULT_KEEP_DEPS, DEFAULT_KEEP_INCREMENTAL};
use std::path::{Path, PathBuf};

/// How long a sweep counts as recent.
///
/// THE INVARIANT IS THAT THIS STAYS UNDER THE AGE FLOOR the sweeps use, so nothing can become
/// eligible and sit unswept for longer than the floor plus this. It held at a 1-day window against a
/// 3-day floor; when the floor came down to six hours a 1-day window would have INVERTED it — the
/// sweep would have been skipped for four times longer than a directory takes to become eligible,
/// and the collection this exists to do would have happened once a day at best.
///
/// One hour: frequent enough that eligibility never outlives it, and the sweep costs ~1.5s, so the
/// tax on a gate that runs constantly during iteration stays negligible.
pub const STAMP_WINDOW_MS: f64 = 60.0 * 60.0 * 1000.0;

/// What `gc` did, or why it did nothing.
#[derive(Debug, PartialEq)]
pub enum GcOutcome {
    /// Swept inside the stamp window; `since_ms` is how long ago.
    Skipped { since_ms: f64 },
    Swept { incremental: SweepReport, deps: SweepReport },
}

fn stamp_path(root: &Path) -> PathBuf {
    root.join("target").join(".bsc-gc-stamp")
}

/// Milliseconds since this tree was last swept, or `None` when it never has been.
pub fn since_last_sweep(root: &Path, now_ms: f64) -> Option<f64> {
    let raw = std::fs::read_to_string(stamp_path(root)).ok()?;
    let at: f64 = raw.trim().parse().ok()?;
    if !at.is_finite() {
        return None;
    }
    Some(now_ms - at)
}

fn write_stamp(root: &Path, now_ms: f64) {
    let path = stamp_path(root);
    if let Some(parent) = path.parent() {
        // No target/ yet, or read-only — the only cost is sweeping again next time.
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, format!("{}", now_ms as i64));
}

/// Sweep this tree's build garbage, unless it was swept inside [`STAMP_WINDOW_MS`].
///
/// THE INVARIANT [`crate::sweep::DEFAULT_DAYS`] DEPENDS ON is pinned by
/// [`tests::the_stamp_window_stays_under_the_age_floor`]: a window longer than the floor means a
/// directory becomes eligible and then sits unswept, which is the state this whole entry point
/// exists to end.
pub fn gc(root: &Path, days: f64, keep_incremental: usize, keep_deps: usize, force: bool, dry_run: bool, now_ms: f64) -> GcOutcome {
    if !force {
        if let Some(since) = since_last_sweep(root, now_ms) {
            if since < STAMP_WINDOW_MS {
                return GcOutcome::Skipped { since_ms: since };
            }
        }
    }
    let incremental = prune_incremental(root, days, keep_incremental, dry_run, now_ms);
    let deps = sweep_deps(root, days, keep_deps, dry_run, now_ms);
    if !dry_run {
        write_stamp(root, now_ms);
    }
    GcOutcome::Swept { incremental, deps }
}

/// `gc` with the defaults the gate and `build:plan` use.
pub fn gc_default(root: &Path, force: bool, dry_run: bool, now_ms: f64) -> GcOutcome {
    gc(root, DEFAULT_DAYS, DEFAULT_KEEP_INCREMENTAL, DEFAULT_KEEP_DEPS, force, dry_run, now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bsc-disk-gc-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    const NOW: f64 = 1_700_000_000_000.0;

    #[test]
    fn the_stamp_window_stays_under_the_age_floor() {
        // THE INVARIANT, and it has been inverted once already. When the floor came down from three
        // days to six hours, a one-day window would have meant skipping the sweep for four times
        // longer than a directory takes to become eligible.
        let floor_ms = DEFAULT_DAYS * 86_400_000.0;
        assert!(
            STAMP_WINDOW_MS < floor_ms,
            "the stamp window ({STAMP_WINDOW_MS} ms) must stay under the age floor ({floor_ms} ms), \
             or a directory can become eligible and sit unswept"
        );
    }

    #[test]
    fn a_never_swept_tree_has_no_stamp_and_is_swept() {
        // The case this whole entry point is about: no worktree had ever been swept once.
        let root = scratch("nostamp");
        assert_eq!(since_last_sweep(&root, NOW), None);
        assert!(matches!(gc_default(&root, false, false, NOW), GcOutcome::Swept { .. }));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_sweep_stamps_the_tree_and_the_next_run_inside_the_window_is_skipped() {
        let root = scratch("stamp");
        std::fs::create_dir_all(root.join("target")).unwrap();
        assert!(matches!(gc_default(&root, false, false, NOW), GcOutcome::Swept { .. }));

        // Half an hour later — inside the window.
        let soon = NOW + STAMP_WINDOW_MS / 2.0;
        match gc_default(&root, false, false, soon) {
            GcOutcome::Skipped { since_ms } => assert!((since_ms - STAMP_WINDOW_MS / 2.0).abs() < 1000.0),
            other => panic!("expected a skip inside the window, got {other:?}"),
        }
        // ...and two hours later, outside it.
        let later = NOW + STAMP_WINDOW_MS * 2.0;
        assert!(matches!(gc_default(&root, false, false, later), GcOutcome::Swept { .. }));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn force_sweeps_inside_the_window() {
        let root = scratch("force");
        std::fs::create_dir_all(root.join("target")).unwrap();
        gc_default(&root, false, false, NOW);
        let soon = NOW + STAMP_WINDOW_MS / 2.0;
        assert!(matches!(gc_default(&root, false, false, soon), GcOutcome::Skipped { .. }));
        assert!(matches!(gc_default(&root, true, false, soon), GcOutcome::Swept { .. }));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_dry_run_never_stamps_so_it_cannot_suppress_a_real_sweep() {
        let root = scratch("drystamp");
        std::fs::create_dir_all(root.join("target")).unwrap();
        assert!(matches!(gc_default(&root, true, true, NOW), GcOutcome::Swept { .. }));
        assert_eq!(since_last_sweep(&root, NOW), None, "a dry run must leave no stamp");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_corrupt_stamp_reads_as_never_swept_rather_than_as_a_huge_age() {
        // Fail-safe: the worst outcome must be sweeping again, never skipping forever.
        let root = scratch("corrupt");
        std::fs::create_dir_all(root.join("target")).unwrap();
        for junk in ["", "not-a-number", "NaN", "   "] {
            std::fs::write(stamp_path(&root), junk).unwrap();
            assert_eq!(since_last_sweep(&root, NOW), None, "junk stamp {junk:?} must read as never-swept");
        }
        std::fs::remove_dir_all(&root).ok();
    }
}
