//! The filesystem drivers for `bsc disk prune` and `bsc disk sweep`.
//!
//! Ported from `scripts/prune-incremental.mjs` and `scripts/sweep-target.mjs`. The decision of WHAT
//! to delete lives in [`crate::prune`] and [`crate::unit`]; this module only walks, deletes and
//! measures.
//!
//! ## FAIL-SAFE BY CONTRACT
//!
//! Both run from the gate and from `build:plan`, i.e. ahead of every `npm run tauri -- dev`. Every
//! failure path here is swallowed: an unreadable directory yields no entries (which makes its
//! contents un-sweepable, the conservative direction), and a file that will not unlink is skipped so
//! the rest of its family still goes. The worst outcome of a bug in this module is that nothing is
//! swept.
//!
//! ## The degradation, stated rather than discovered
//!
//! An `incremental/` dir is stamped whenever its crate builds, so mtime tracks liveness there. An
//! rlib is NOT touched when merely LINKED — so a stable live dependency keeps an old mtime and can
//! be swept, costing one rebuild of that unit. Bounded and never incorrect: cargo notices the
//! missing output and regenerates it. `keep` means the victim is almost always a dead variant. This
//! trade was made deliberately; do not "fix" it by dropping the age floor to zero.
//!
//! ## `.fingerprint/` is deliberately NOT swept — measured, not assumed
//!
//! The first version swept it too, on the theory that it accumulates the same way. It does: 6939
//! dirs, 57 for `libduckdb-sys` alone, back to June 22. But it is **22 MB**, against 24 GB in
//! `deps/` — and deleting 5408 of those dirs made cargo treat their units as never-built and
//! recompile **328 crates in 2m24s**. All cost, no benefit. Leave it alone.

use crate::prune::{plan_prune, Entry};
use crate::unit::group_units;
use std::path::{Path, PathBuf};

/// Six hours, and the unit is why the sweeps were a no-op for so long.
///
/// [`plan_prune`] keeps a directory that is newest-per-crate OR newer than the floor, so the floor
/// is not a floor: it is a blanket exemption for everything younger than it. At three days, every
/// directory in a tree built today qualified, `keep` could never bind, and the sweep collected
/// nothing on exactly the trees that grow. MEASURED 2026-09-01: 0 of 266 dirs at the 3-day default;
/// 1,936 of 6,482 and 72 GB at one day, on a repo holding 310 GB of incremental across 17 worktrees.
///
/// Six hours is chosen from how long a session actually holds a tree — 30 minutes to 4 hours — with
/// margin over the longest. A session that outruns it recompiles the crates it had not touched in
/// six hours, which the maintainer accepted explicitly as the cheaper side of the trade. The newest
/// cache per crate is spared regardless of age, so the directory a live build is writing is never a
/// candidate.
pub const DEFAULT_DAYS: f64 = 6.0 / 24.0;

/// `incremental/` keeps the newest 1 per crate; `deps/` keeps 3. Measured: `keep` never bound on
/// `incremental` at any window tested, so the age floor is that sweep's whole policy.
pub const DEFAULT_KEEP_INCREMENTAL: usize = 1;
pub const DEFAULT_KEEP_DEPS: usize = 3;

/// What one sweep did, so the caller reports a MEASURED number rather than an estimate.
#[derive(Debug, Default, PartialEq)]
pub struct SweepReport {
    pub removed: usize,
    pub scanned: usize,
    pub bytes: u64,
    /// Locked by a live build, or already gone — try again next sweep.
    pub failed: usize,
}

/// Every `target/<profile>/<leaf>` that exists, for each build profile present.
fn profile_dirs(root: &Path, leaf: &str) -> Vec<PathBuf> {
    let target = root.join("target");
    let Ok(profiles) = std::fs::read_dir(&target) else {
        return Vec::new(); // no target/ yet — a fresh checkout has nothing to sweep
    };
    let mut found = Vec::new();
    for profile in profiles.flatten() {
        if !profile.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let dir = profile.path().join(leaf);
        if dir.is_dir() {
            found.push(dir);
        }
    }
    found.sort();
    found
}

/// `{name, mtime_ms}` for each direct child of `dir` of the wanted kind. Unreadable entries are
/// DROPPED, which makes them un-sweepable — the conservative direction.
pub fn entries_of(dir: &Path, want_dir: bool) -> Vec<Entry> {
    let Ok(listing) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut found = Vec::new();
    for entry in listing.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if want_dir != kind.is_dir() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue }; // vanished mid-sweep, or denied
        let Some(mtime) = mtime_ms(&meta) else { continue };
        found.push(Entry::new(entry.file_name().to_string_lossy().into_owned(), mtime));
    }
    found
}

/// Epoch milliseconds, or `None` for a platform/filesystem that cannot say.
fn mtime_ms(meta: &std::fs::Metadata) -> Option<f64> {
    let t = meta.modified().ok()?;
    Some(match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs_f64() * 1000.0,
        // Before the epoch: legal, and it must read as ANCIENT rather than as a huge positive.
        Err(e) => -(e.duration().as_secs_f64() * 1000.0),
    })
}

/// Sweep orphaned incremental-compilation directories out of `target/*/incremental/`.
pub fn prune_incremental(root: &Path, days: f64, keep: usize, dry_run: bool, now_ms: f64) -> SweepReport {
    let mut report = SweepReport::default();
    for dir in profile_dirs(root, "incremental") {
        let entries = entries_of(&dir, true);
        report.scanned += entries.len();
        for name in plan_prune(&entries, days, keep, now_ms).prune {
            let path = dir.join(&name);
            report.bytes += dir_size(&path);
            if dry_run {
                report.removed += 1;
                continue;
            }
            match std::fs::remove_dir_all(&path) {
                Ok(()) => report.removed += 1,
                Err(_) => report.failed += 1, // locked by a live build — try again next sweep
            }
        }
    }
    report
}

/// Sweep orphaned dependency UNITS out of `target/*/deps/`.
///
/// A unit is a whole file family sharing one metadata hash. Deleting some of a family and not the
/// rest is pointless (cargo rebuilds the unit either way) and makes the reclaimed-bytes number a
/// lie, so the family is the atom — see [`crate::unit`].
pub fn sweep_deps(root: &Path, days: f64, keep: usize, dry_run: bool, now_ms: f64) -> SweepReport {
    let mut report = SweepReport::default();
    for dir in profile_dirs(root, "deps") {
        let units = group_units(&entries_of(&dir, false));
        report.scanned += units.len();
        let by_key: std::collections::HashMap<&str, &crate::unit::Unit> =
            units.iter().map(|u| (u.key.as_str(), u)).collect();
        let keys: Vec<Entry> = units.iter().map(|u| Entry::new(u.key.clone(), u.mtime_ms)).collect();
        for key in plan_prune(&keys, days, keep, now_ms).prune {
            let Some(unit) = by_key.get(key.as_str()) else { continue };
            for file in &unit.files {
                report.bytes += std::fs::metadata(dir.join(file)).map(|m| m.len()).unwrap_or(0);
            }
            if dry_run {
                report.removed += 1;
                continue;
            }
            for file in &unit.files {
                // Locked by a running process or already gone — the rest of the family still goes.
                let _ = std::fs::remove_file(dir.join(file));
            }
            report.removed += 1;
        }
    }
    report
}

/// Best-effort recursive byte count, so the report is measured rather than estimated. Anything
/// unreadable contributes nothing.
fn dir_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    if !meta.is_dir() {
        return meta.len();
    }
    let Ok(listing) = std::fs::read_dir(path) else { return 0 };
    listing.flatten().map(|e| dir_size(&e.path())).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bsc-disk-sweep-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// Give `path` an mtime `hours` in the past, so the age floor can be exercised without waiting.
    fn age(path: &Path, hours: f64) {
        let when = std::time::SystemTime::now() - std::time::Duration::from_secs_f64(hours * 3600.0);
        filetime::set_file_mtime(path, filetime::FileTime::from_system_time(when)).expect("set mtime");
    }

    fn now() -> f64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("after the epoch")
            .as_secs_f64()
            * 1000.0
    }

    #[test]
    fn a_tree_with_no_target_dir_is_swept_without_error() {
        // The fresh-checkout case, and the first half of the fail-safe contract.
        let root = scratch("notarget");
        assert_eq!(prune_incremental(&root, DEFAULT_DAYS, 1, true, now()), SweepReport::default());
        assert_eq!(sweep_deps(&root, DEFAULT_DAYS, 3, true, now()), SweepReport::default());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prunes_a_stale_incremental_dir_and_spares_the_newest_per_crate() {
        let root = scratch("prune");
        let inc = root.join("target").join("debug").join("incremental");
        std::fs::create_dir_all(inc.join("bsc_graph-1aaaaaaaaaaaa")).unwrap();
        std::fs::create_dir_all(inc.join("bsc_graph-2bbbbbbbbbbbb")).unwrap();
        std::fs::create_dir_all(inc.join("bsc_graph-3ccccccccccc")).unwrap();
        std::fs::write(inc.join("bsc_graph-3ccccccccccc").join("blob"), vec![0u8; 4096]).unwrap();
        age(&inc.join("bsc_graph-1aaaaaaaaaaaa"), 0.1); // the live cache
        age(&inc.join("bsc_graph-2bbbbbbbbbbbb"), 8.0);
        age(&inc.join("bsc_graph-3ccccccccccc"), 30.0);

        let dry = prune_incremental(&root, DEFAULT_DAYS, 1, true, now());
        assert_eq!((dry.removed, dry.scanned, dry.failed), (2, 3, 0));
        assert!(dry.bytes >= 4096, "a dry run still MEASURES, it just does not delete");
        assert!(inc.join("bsc_graph-3ccccccccccc").exists(), "dry run deleted something");

        let wet = prune_incremental(&root, DEFAULT_DAYS, 1, false, now());
        assert_eq!(wet.removed, 2);
        assert!(inc.join("bsc_graph-1aaaaaaaaaaaa").exists(), "the live cache must survive");
        assert!(!inc.join("bsc_graph-2bbbbbbbbbbbb").exists());
        assert!(!inc.join("bsc_graph-3ccccccccccc").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn sweeps_a_dep_unit_as_a_whole_family_and_never_the_un_hashed_copies() {
        let root = scratch("sweep");
        let deps = root.join("target").join("debug").join("deps");
        std::fs::create_dir_all(&deps).unwrap();
        // Four variants of one crate; keep = 1 so exactly the three oldest go.
        for (hash, hours) in [("1111111111111111", 0.1), ("2222222222222222", 9.0), ("3333333333333333", 20.0)] {
            for name in [format!("libserde-{hash}.rlib"), format!("serde-{hash}.d"), format!("serde-{hash}.rmeta")] {
                let p = deps.join(&name);
                std::fs::write(&p, vec![0u8; 1024]).unwrap();
                age(&p, hours);
            }
        }
        // The names `$BSC_BIN` and humans resolve BY. Sweeping these would break resolution.
        for name in ["bsc", "libserde.rlib"] {
            let p = deps.join(name);
            std::fs::write(&p, b"x").unwrap();
            age(&p, 999.0); // ancient, so only the parser is keeping it alive
        }

        let report = sweep_deps(&root, DEFAULT_DAYS, 1, false, now());
        assert_eq!(report.removed, 2, "two whole units, not six files");
        assert_eq!(report.scanned, 3, "three units were seen");
        assert_eq!(report.bytes, 6 * 1024, "the family is the atom the bytes are counted over");
        // The whole family went, or none of it.
        for hash in ["2222222222222222", "3333333333333333"] {
            for name in [format!("libserde-{hash}.rlib"), format!("serde-{hash}.d"), format!("serde-{hash}.rmeta")] {
                assert!(!deps.join(&name).exists(), "{name} survived a swept unit");
            }
        }
        assert!(deps.join("libserde-1111111111111111.rlib").exists(), "the newest unit must survive");
        assert!(deps.join("bsc").exists(), "an un-hashed copy is NEVER sweepable");
        assert!(deps.join("libserde.rlib").exists(), "an un-hashed copy is NEVER sweepable");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_unreadable_directory_yields_no_entries_rather_than_an_error() {
        // The conservative direction: what cannot be read cannot be swept.
        let root = scratch("unreadable");
        assert!(entries_of(&root.join("nope"), true).is_empty());
        std::fs::remove_dir_all(&root).ok();
    }
}
