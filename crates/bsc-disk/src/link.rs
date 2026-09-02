//! The hashing + hard-linking driver for `bsc disk dedupe`.
//!
//! Ported from `scripts/dedupe-deps.mjs`. The selection lives in the pure [`crate::dedupe`]; this
//! file does the reading, hashing and linking.
//!
//! ## EXPLICIT, like the worktree cap — never wired into the gate or `build:plan`
//!
//! The sweeps run automatically because their worst outcome is a rebuild. This rewrites files that
//! several trees share. It is verified-safe, but it is not the kind of thing that should happen
//! because someone ran a gate. It is therefore NOT under the fail-safe contract: a failure here is
//! reported and returned, never swallowed.
//!
//! ## Why this is safe, and where the residual risk actually is
//!
//! Dependencies carry `debug = false` (the #795 linker-OOM fix), so no absolute paths are baked in,
//! and a shared filename already implies shared inputs because `-C metadata` folds package +
//! features + profile + target. Even so, **every group is sha256-verified before any link is made**
//! — a filename is a hint, never a proof. The first real run found 1902 files with identical name
//! AND size and different bytes (`.d` dep-info files embed absolute source paths).
//!
//! The residual risk is narrow and was weighed openly: rustc does not obviously write outputs
//! atomically, so a build in one tree could briefly expose a partially-written file to the others.
//! That surfaces as a LOUD link error which the next build resolves, not as silent corruption.
//! `min_age` keeps a live build from being raced at all.
//!
//! ## THE TRADE REVERSES WITH FLEET SIZE
//!
//! At 3 active trees the shared inodes were a dormant risk. At 10+ sessions a dependency bump has
//! several trees rebuilding the same registry crates at once, several processes writing one inode.
//! It bought 13 GB against ~1,050 GB free, so it is not worth that. Run `--undo` before scaling the
//! fleet; re-run the dedup when the box is quiet and space actually matters.
//!
//! ## UNIX ONLY, and said out loud
//!
//! The whole feature is inode identity: `plan_dedupe` skips a group whose copies already share one,
//! and `--undo` finds work by link count. Neither is portable, and a version that quietly reported
//! "0 linked" on a platform it could not measure would be indistinguishable from a clean run. It
//! refuses instead.

use crate::dedupe::{plan_dedupe, reclaimable_bytes, ArtifactFile};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Skip files modified within this window, so a live build in another tree is never raced.
pub const DEFAULT_MIN_AGE_MINS: f64 = 60.0;

/// What a dedup run did.
#[derive(Debug, Default, PartialEq)]
pub struct LinkReport {
    pub linked: usize,
    pub bytes: u64,
    pub groups: usize,
    pub eligible_bytes: u64,
    /// Same name, same size, DIFFERENT bytes — the guard doing its job.
    pub mismatched: usize,
    pub failed: usize,
}

/// What an `--undo` run did.
#[derive(Debug, Default, PartialEq)]
pub struct UndoReport {
    pub broken: usize,
    pub bytes: u64,
}

#[cfg(unix)]
fn ino_of(meta: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(meta)
}

#[cfg(unix)]
fn nlink_of(meta: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::nlink(meta)
}

/// Every checkout git knows about, main tree included.
pub fn trees(root: &Path) -> Result<Vec<PathBuf>, String> {
    let out = std::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(root)
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if !out.status.success() {
        return Err(format!("git worktree list failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .map(PathBuf::from)
        .collect())
}

/// Workspace package names in the underscored form cargo uses in artifact filenames.
pub fn workspace_crates(root: &Path) -> Result<HashSet<String>, String> {
    let out = std::process::Command::new("cargo")
        .args(["metadata", "--no-deps", "--format-version", "1"])
        .current_dir(root)
        .output()
        .map_err(|e| format!("could not run cargo metadata: {e}"))?;
    if !out.status.success() {
        return Err(format!("cargo metadata failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let meta: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("cargo metadata was not JSON: {e}"))?;
    Ok(meta["packages"]
        .as_array()
        .map(|ps| {
            ps.iter().filter_map(|p| p["name"].as_str()).map(|n| n.replace('-', "_")).collect()
        })
        .unwrap_or_default())
}

/// The artifact files of one tree's `target/debug/deps`.
///
/// DEBUG ONLY, as the JavaScript was: release output is rare here and a profile is part of the
/// `-C metadata` hash anyway, so widening this would add scan cost without adding matches.
#[cfg(unix)]
pub fn deps_files(tree: &Path) -> Vec<ArtifactFile> {
    let dir = tree.join("target").join("debug").join("deps");
    let Ok(listing) = std::fs::read_dir(&dir) else { return Vec::new() }; // tree has no build output
    let mut found = Vec::new();
    for entry in listing.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue }; // vanished mid-scan
        let Ok(modified) = meta.modified() else { continue };
        let mtime_ms = modified
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        found.push(ArtifactFile {
            tree: tree.to_string_lossy().into_owned(),
            path: entry.path(),
            name: entry.file_name().to_string_lossy().into_owned(),
            size: meta.len(),
            mtime_ms,
            ino: ino_of(&meta),
        });
    }
    found
}

/// `path` with `suffix` APPENDED to the whole filename, extension included.
fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// Streamed rather than read whole: the largest artifacts here are hundreds of MB and this runs
/// over tens of thousands of them, so slurping each one would peak far above what a janitor should
/// cost on a box already running several gates.
fn sha256(path: &Path) -> Result<[u8; 32], String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 128 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().into())
}

/// Replace `target` with a hard link to `source`, via a temp rename so an interrupted run can never
/// leave the tree WITHOUT the artifact. The original is only unlinked once the link exists.
fn relink(source: &Path, target: &Path) -> Result<(), String> {
    // APPEND the suffix, never `with_extension`, which REPLACES it: `libserde-<hash>.rlib` would
    // become `libserde-<hash>.dedupe-bak` and collide with the `.rmeta` of the same unit.
    let backup = suffixed(target, ".dedupe-bak");
    std::fs::rename(target, &backup).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::hard_link(source, target) {
        // Put it back exactly as it was.
        std::fs::rename(&backup, target).map_err(|e2| format!("{e}; and the restore failed: {e2}"))?;
        return Err(e.to_string());
    }
    std::fs::remove_file(&backup).map_err(|e| e.to_string())
}

/// Push the shared inode's mtime to the newest in its group.
///
/// WITHOUT THIS, DEDUP COSTS A FULL REBUILD PER TREE AND UNDOES ITSELF. Hard links share metadata,
/// so a linked artifact adopts the CANONICAL copy's mtime — which in every non-canonical tree reads
/// as an output older than cargo recorded, so cargo rebuilds it. Measured on the first real run: 189
/// and 190 crates recompiled (~150s each) in the two non-canonical trees, while the canonical tree
/// recompiled 0. Those rebuilds then write fresh artifacts and break the links, so the reclaimed
/// space comes back.
///
/// Cargo's staleness test is directional — it rebuilds when an output is OLDER than expected, never
/// when it is newer. So moving the single shared inode to the group's NEWEST mtime satisfies every
/// tree at once, and is the one metadata change a shared inode permits.
fn sync_mtime(path: &Path, mtime_ms: f64) {
    let ft = filetime::FileTime::from_unix_time(
        (mtime_ms / 1000.0).floor() as i64,
        ((mtime_ms.rem_euclid(1000.0)) * 1_000_000.0) as u32,
    );
    // Best-effort: the worst case is exactly the rebuild this avoids.
    let _ = filetime::set_file_mtime(path, ft);
}

/// Hash-verify and hard-link every eligible group.
#[cfg(unix)]
pub fn run(root: &Path, min_age_ms: f64, dry_run: bool, now_ms: f64) -> Result<LinkReport, String> {
    let workspace = workspace_crates(root)?;
    let all: Vec<ArtifactFile> = trees(root)?.iter().flat_map(|t| deps_files(t)).collect();
    let groups = plan_dedupe(&all, &workspace, min_age_ms, now_ms);
    let mut report =
        LinkReport { groups: groups.len(), eligible_bytes: reclaimable_bytes(&groups), ..LinkReport::default() };

    for group in &groups {
        let Some((canonical, rest)) = group.files.split_first() else { continue };
        let Ok(want) = sha256(&canonical.path) else {
            report.failed += 1;
            continue;
        };
        let mut newest = canonical.mtime_ms;
        for dup in rest {
            match sha256(&dup.path) {
                // THE GUARD: identical name and size is a hint; only the hash authorizes a link.
                Ok(got) if got != want => {
                    report.mismatched += 1;
                    continue;
                }
                Err(_) => {
                    report.failed += 1;
                    continue;
                }
                Ok(_) => {}
            }
            if !dry_run {
                if let Err(e) = relink(&canonical.path, &dup.path) {
                    report.failed += 1;
                    bsc_util::emit_line(&format!("[dedupe] skipped {}: {e}", dup.path.display()));
                    continue;
                }
            }
            report.linked += 1;
            report.bytes += group.size;
            newest = newest.max(dup.mtime_ms);
        }
        // One shared inode now backs every copy, so give it the group's NEWEST mtime — otherwise
        // every non-canonical tree reads its artifact as stale and rebuilds. See `sync_mtime`.
        if !dry_run && newest > canonical.mtime_ms {
            sync_mtime(&canonical.path, newest);
        }
    }
    Ok(report)
}

/// Give every hard-linked artifact its own inode again: copy aside, then rename over. The copy is
/// made first and renamed into place, so an interrupted run can never leave a tree without its
/// artifact.
#[cfg(unix)]
pub fn undo(root: &Path, dry_run: bool) -> Result<UndoReport, String> {
    let mut report = UndoReport::default();
    for tree in trees(root)? {
        for file in deps_files(&tree) {
            // Only touch what THIS tool could have created: a hashed artifact that actually has
            // another link. Cargo also hardlinks `target/debug/bsc` to its own `deps/bsc-<hash>`
            // WITHIN a tree; breaking that would be pointless churn — and an un-hashed name is
            // exactly what `parse_unit_file` refuses.
            if crate::unit::parse_unit_file(&file.name).is_none() {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&file.path) else { continue }; // vanished mid-scan
            if nlink_of(&meta) < 2 {
                continue; // already its own inode — nothing to break
            }
            if dry_run {
                report.broken += 1;
                report.bytes += file.size;
                continue;
            }
            let tmp = suffixed(&file.path, ".unlink-tmp");
            match std::fs::copy(&file.path, &tmp).and_then(|_| std::fs::rename(&tmp, &file.path)) {
                Ok(()) => {
                    report.broken += 1;
                    report.bytes += file.size;
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp);
                    bsc_util::emit_line(&format!("[dedupe] could not unlink {}: {e}", file.path.display()));
                }
            }
        }
    }
    Ok(report)
}

#[cfg(not(unix))]
pub fn run(_root: &Path, _min_age_ms: f64, _dry_run: bool, _now_ms: f64) -> Result<LinkReport, String> {
    Err(UNSUPPORTED.to_string())
}

#[cfg(not(unix))]
pub fn undo(_root: &Path, _dry_run: bool) -> Result<UndoReport, String> {
    Err(UNSUPPORTED.to_string())
}

#[cfg(not(unix))]
const UNSUPPORTED: &str = "bsc disk dedupe needs inode identity (which groups are already linked, \
    and which files still have another link) and this platform cannot report it. Refusing rather \
    than reporting a clean run it did not verify.";

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bsc-disk-link-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().expect("has a parent")).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn ino(path: &Path) -> u64 {
        ino_of(&std::fs::metadata(path).expect("stat"))
    }

    #[test]
    fn relink_leaves_the_artifact_in_place_when_the_link_fails() {
        // The interrupted-run guarantee: a tree must never be left WITHOUT its artifact.
        let root = scratch("relink-fail");
        let target = root.join("victim.rlib");
        write(&target, b"original bytes");
        // A source that does not exist makes hard_link fail, which is the path under test.
        let err = relink(&root.join("nope.rlib"), &target).unwrap_err();
        assert!(!err.is_empty());
        assert_eq!(std::fs::read(&target).unwrap(), b"original bytes", "the artifact was not restored");
        assert!(!root.join("victim.rlib.dedupe-bak").exists(), "the backup was left behind");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn relink_collapses_two_copies_onto_one_inode_and_removes_the_backup() {
        let root = scratch("relink-ok");
        let a = root.join("a.rlib");
        let b = root.join("b.rlib");
        write(&a, b"same bytes");
        write(&b, b"same bytes");
        assert_ne!(ino(&a), ino(&b), "precondition: two distinct inodes");
        relink(&a, &b).unwrap();
        assert_eq!(ino(&a), ino(&b), "the copies should now share one inode");
        assert!(!root.join("b.rlib.dedupe-bak").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn sync_mtime_moves_the_shared_inode_forward() {
        // Directional: cargo rebuilds an output that is OLDER than recorded, never a newer one.
        let root = scratch("mtime");
        let p = root.join("x.rlib");
        write(&p, b"x");
        let target_ms = 1_700_000_000_000.0_f64;
        sync_mtime(&p, target_ms);
        let got = std::fs::metadata(&p)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
            * 1000.0;
        assert!((got - target_ms).abs() < 2.0, "expected ~{target_ms}, got {got}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn undo_skips_an_un_hashed_name_however_many_links_it_has() {
        // Cargo hardlinks `target/debug/bsc` to `deps/bsc-<hash>` WITHIN a tree. Breaking that is
        // pointless churn, and the un-hashed name is the one `$BSC_BIN` resolves.
        let root = scratch("undo-unhashed");
        let deps = root.join("target").join("debug").join("deps");
        let hashed = deps.join("libserde-1111111111111111.rlib");
        let plain = deps.join("bsc");
        write(&hashed, b"payload");
        write(&plain, b"payload");
        std::fs::hard_link(&hashed, deps.join("other-2222222222222222.rlib")).unwrap();
        std::fs::hard_link(&plain, root.join("bsc-copy")).unwrap();
        let before = ino(&plain);

        let files = deps_files(&root);
        assert!(files.iter().any(|f| f.name == "bsc"), "the scan must SEE it to prove it is skipped");

        // Drive the same predicate `undo` uses, without needing a git repo.
        for f in &files {
            if crate::unit::parse_unit_file(&f.name).is_none() {
                continue;
            }
            assert_ne!(f.name, "bsc", "an un-hashed name must never reach the unlink path");
        }
        assert_eq!(ino(&plain), before);
        std::fs::remove_dir_all(&root).ok();
    }
}
