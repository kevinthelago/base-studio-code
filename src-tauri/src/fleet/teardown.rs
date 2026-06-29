//! Fleet worktree teardown + disk reclamation (#1080).
//!
//! The fleet creates one git worktree per agent (`ensure_worktree`) at
//! `~/.base-studio-code/worktrees/<key>/<repo>--<slug>/`. Each worktree builds independently, so
//! each accumulates its own `target/` (and `node_modules`, etc.). Cargo never garbage-collects
//! `target/`, and — until now — the app created these worktrees but NEVER removed them, so a user
//! who runs fleets silently fills their disk (a real fleet produced ~34 worktrees → hundreds of GB).
//!
//! This module is the missing teardown path that mirrors `ensure_worktree`:
//!   * [`remove_worktree`] / [`remove_worktree_at`] — `git worktree remove --force` the directory
//!     **and** the owning repo's worktree admin record, junction-safe.
//!   * [`reclaim_project_worktrees`] — sweep every worktree of a project (project close / reap).
//!   * [`project_disk_usage`] / [`worktrees_disk_usage`] — the inventory backing the Settings disk
//!     surface (size of each worktree + its `target/`) so the user can see and reclaim the space.
//!
//! ## The `node_modules` junction hazard (memory: worktree-junction-hazard)
//! A worktree's `node_modules` may be a Windows **junction** to the main clone's `node_modules`.
//! `git worktree remove` / `remove_dir_all` follow that junction and would delete the SHARED
//! `node_modules` (including `.bin`). So every removal first detaches the junction with a
//! non-recursive `rmdir` (which removes the reparse point WITHOUT touching its target) before any
//! recursive delete runs.

use std::path::Path;

use crate::platform::process::no_window;
use crate::{repo_dir, worktree_slug, worktrees_dir};

/// Directories that a build leaks into a worktree and that must be kept out of the worker's git
/// status (and are dropped wholesale on teardown). Excluded via the worktree's `info/exclude` so the
/// warden never quarantines a worker for a `target/` it never authored, and so the build artifacts
/// are unambiguously app-owned scratch (#1080).
pub(crate) const WORKTREE_BUILD_EXCLUDES: &[&str] = &["/target/", "/node_modules/", "/.venv/", "/dist/"];

/// Add the heavy build-output dirs (`target/`, `node_modules/`, …) to a worktree's git
/// `info/exclude` so they never enter the worker's diff and are unambiguously app-owned scratch
/// (#1080). Resolved through git (`git_exclude`) so it works in a linked worktree where `.git` is a
/// file. Idempotent; a no-op when `wt` is not a git worktree. Called from `ensure_worktree`.
pub(crate) fn exclude_build_artifacts(wt: &Path) {
    for entry in WORKTREE_BUILD_EXCLUDES {
        crate::git_exclude(wt, entry);
    }
}

/// Detach a `node_modules` junction inside `wt` (Windows) WITHOUT deleting its target, so a later
/// recursive delete of the worktree can't follow it into the shared main-clone `node_modules`
/// (memory: worktree-junction-hazard). A non-recursive `rmdir` removes a junction's reparse point
/// but errors on a real directory — so this only ever affects an actual junction; a plain
/// `node_modules` directory is left for the normal recursive delete to handle. No-op off Windows
/// (Unix worktrees use symlinks/copies, and `remove_dir_all` does not traverse symlinks).
pub(crate) fn detach_node_modules_junction(wt: &Path) {
    let nm = wt.join("node_modules");
    // A junction reports as a symlink/reparse point via `symlink_metadata`; a real dir does not.
    let is_reparse = std::fs::symlink_metadata(&nm)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if !is_reparse {
        return;
    }
    #[cfg(windows)]
    {
        // `cmd /c rmdir <path>` (NON-recursive) removes a junction's link only, never its target.
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/c", "rmdir", &nm.to_string_lossy()]);
        let _ = no_window(&mut cmd).status();
    }
    #[cfg(not(windows))]
    {
        // A symlinked node_modules on Unix: unlink the link, never its target.
        let _ = std::fs::remove_file(&nm);
    }
}

/// Remove one fleet worktree at `wt` owned by the clone at `clone`: detach any `node_modules`
/// junction, then `git worktree remove --force` so BOTH the directory and the owning repo's worktree
/// admin record (`.git/worktrees/<id>`) are dropped — leaving no leak. Falls back to a manual
/// recursive delete + `git worktree prune` when the repo clone is gone (so an orphaned worktree dir
/// is still reclaimed). Best-effort and idempotent: a missing worktree is `Ok(())`.
pub(crate) fn remove_worktree_at(clone: &Path, wt: &Path) -> Result<(), String> {
    if !wt.exists() {
        return Ok(());
    }
    // ALWAYS detach the junction first — before git or any recursive delete can traverse it.
    detach_node_modules_junction(wt);

    let wt_str = wt.to_string_lossy().into_owned();

    // Preferred path: let git remove the dir AND its admin record in one shot.
    if clone.join(".git").exists() {
        let clone_str = clone.to_string_lossy().into_owned();
        let ok = crate::git_ok(&clone_str, &["worktree", "remove", "--force", &wt_str]);
        if ok && !wt.exists() {
            log::info!("teardown: removed worktree {wt_str}");
            return Ok(());
        }
        // git refused (e.g. unmerged dir state) — fall through to a forced filesystem delete, then
        // prune the now-dangling admin record so it isn't left registered.
    }

    // Fallback: forcibly delete the directory (read-only git packs need clearing on Windows), then
    // prune the dangling worktree record from whichever clone owns it.
    #[cfg(windows)]
    crate::platform::fsx::clear_readonly_recursive(wt);
    std::fs::remove_dir_all(wt).map_err(|e| format!("remove_worktree: {e}"))?;
    if clone.join(".git").exists() {
        let clone_str = clone.to_string_lossy().into_owned();
        let _ = crate::git_ok(&clone_str, &["worktree", "prune"]);
    }
    log::info!("teardown: removed worktree (fallback) {wt_str}");
    Ok(())
}

/// Resolve a fleet worker's worktree path the same way `ensure_worktree` does, then remove it
/// (`remove_worktree_at`). Idempotent: a worker that was never launched (no worktree) is `Ok(())`.
pub(crate) fn remove_worktree(project_key: &str, repo: &str, agent_id: &str) -> Result<(), String> {
    let clone = repo_dir(project_key, repo);
    let short = repo.rsplit('/').next().unwrap_or(repo);
    let wt = worktrees_dir(project_key).join(format!("{short}--{}", worktree_slug(agent_id)));
    remove_worktree_at(&clone, &wt)
}

/// Recursive byte size of `dir` (best-effort; unreadable entries contribute 0). Used by the disk
/// surface to report per-worktree + per-`target/` footprint.
pub(crate) fn dir_size(dir: &Path) -> u64 {
    fn walk(dir: &Path) -> u64 {
        let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
        let mut total = 0u64;
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            // Never traverse a symlink/junction — its bytes belong to the target, not this worktree.
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                total += walk(&entry.path());
            } else if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
        total
    }
    walk(dir)
}

/// One fleet worktree's disk footprint, for the Settings reclaim surface (#1080).
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeUsage {
    /// Sanitized project key the worktree belongs to.
    pub project_key: String,
    /// The `<repo>--<slug>` directory name.
    pub name: String,
    /// Absolute worktree path.
    pub path: String,
    /// Total bytes under the worktree (excluding symlinked/junctioned dirs).
    pub size_bytes: u64,
    /// Bytes under the worktree's own `target/` (the dominant, Cargo-leaked component).
    pub target_bytes: u64,
}

/// Enumerate every worktree of ONE project with its on-disk size + `target/` size. Pure over a base
/// dir so it's testable; the command wraps it with `bsc_base_dir()`.
pub(crate) fn project_disk_usage_impl(base_dir: &Path, project_key: &str) -> Vec<WorktreeUsage> {
    let key = crate::sanitize_project_key(project_key);
    let root = base_dir.join("worktrees").join(&key);
    let Ok(rd) = std::fs::read_dir(&root) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        out.push(WorktreeUsage {
            project_key: key.clone(),
            name,
            path: path.to_string_lossy().into_owned(),
            size_bytes: dir_size(&path),
            target_bytes: dir_size(&path.join("target")),
        });
    }
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes).then(a.name.cmp(&b.name)));
    out
}

/// Every project's worktree usage, newest/biggest first. Pure over a base dir for testability.
pub(crate) fn worktrees_disk_usage_impl(base_dir: &Path) -> Vec<WorktreeUsage> {
    let root = base_dir.join("worktrees");
    let Ok(rd) = std::fs::read_dir(&root) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let key = entry.file_name().to_string_lossy().into_owned();
        out.extend(project_disk_usage_impl(base_dir, &key));
    }
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes).then(a.name.cmp(&b.name)));
    out
}

/// Remove every worktree of a project (project close / session reap / explicit reclaim), junction-
/// safe, then drop the now-empty `worktrees/<key>/` dir. Each worktree is removed via its owning
/// clone so the git admin records go too. Best-effort: a missing dir is `Ok(())`; a single failure
/// is logged and the sweep continues. Returns the number of worktree dirs removed.
pub(crate) fn reclaim_project_worktrees(project_key: &str) -> usize {
    let root = worktrees_dir(project_key);
    let Ok(rd) = std::fs::read_dir(&root) else { return 0 };
    let mut removed = 0usize;
    for entry in rd.flatten() {
        let wt = entry.path();
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        // The dir name is `<repoShort>--<slug>`; the owning clone is repo_dir(key, <repoShort>).
        // worktree_slug never produces `--`, and a repo short name can't contain `--` (it's the
        // part after the last `/`), so the FIRST `--` is the boundary.
        let name = entry.file_name().to_string_lossy().into_owned();
        let clone = match name.split_once("--") {
            Some((repo_short, _)) => repo_dir(project_key, repo_short),
            // No boundary (shouldn't happen) — remove the dir without an owning clone.
            None => std::path::PathBuf::new(),
        };
        match remove_worktree_at(&clone, &wt) {
            Ok(()) => removed += 1,
            Err(e) => log::warn!("reclaim: {}: {e}", wt.display()),
        }
    }
    // Drop the (now hopefully empty) per-project worktrees root.
    let _ = std::fs::remove_dir(&root);
    removed
}

/// Is `wt` a worktree that's SAFE to reclaim at boot? Only when it's a real git worktree, its tree
/// is clean (no uncommitted/untracked work — build artifacts are git-excluded so don't count), AND
/// its branch is already merged into the owning clone's current branch (its work is landed; the
/// progress-gated relaunch skips it anyway). A DIRTY worktree is NEVER disposable. Conservative on
/// purpose — a worktree merged only on the remote (the local clone hasn't pulled) reads as not-merged
/// and is kept, which is the safe direction.
pub(crate) fn worktree_is_disposable(clone: &Path, wt: &Path) -> bool {
    if !wt.join(".git").exists() || !clone.join(".git").exists() {
        return false;
    }
    let wt_str = wt.to_string_lossy();
    let clone_str = clone.to_string_lossy();
    // Clean tree: `status --porcelain` prints nothing. Untracked source files block reclaim;
    // node_modules/target are git-excluded (ensure_worktree) so they never appear here.
    let mut st = std::process::Command::new("git");
    st.args(["-C", &wt_str, "status", "--porcelain"]);
    let clean = no_window(&mut st).output().map(|o| o.stdout.is_empty()).unwrap_or(false);
    if !clean {
        return false;
    }
    // Merged: the worktree's HEAD is an ancestor of the clone's current HEAD (local merge).
    let Ok(sha) = crate::git_run(&wt_str, &["rev-parse", "HEAD"]) else { return false };
    if sha.is_empty() {
        return false;
    }
    crate::git_ok(&clone_str, &["merge-base", "--is-ancestor", &sha, "HEAD"])
}

/// Reclaim worktrees that are safe to drop, at boot, so they don't accumulate (#worktree-disk):
///   * **orphans** — the project hub `projects/<key>` is gone (a deleted/abandoned project whose
///     reclaim didn't fully run): remove the entire `worktrees/<key>/`.
///   * **merged + clean** — a live project's worktree whose branch is integrated and tree is clean
///     ({@link worktree_is_disposable}).
///
/// Best-effort, pure over `base_dir` for testability; never removes a dirty worktree. Returns the
/// number of worktree directories reclaimed.
pub(crate) fn gc_worktrees_impl(base_dir: &Path) -> usize {
    let root = base_dir.join("worktrees");
    let Ok(rd) = std::fs::read_dir(&root) else { return 0 };
    let mut removed = 0usize;
    for entry in rd.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let key = entry.file_name().to_string_lossy().into_owned();
        let hub_gone = !base_dir.join("projects").join(&key).exists();
        let Ok(wts) = std::fs::read_dir(entry.path()) else { continue };
        for w in wts.flatten() {
            let wt = w.path();
            if !w.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = w.file_name().to_string_lossy().into_owned();
            // `<repoShort>--<slug>` → the owning clone (first `--` is the boundary).
            let clone = match name.split_once("--") {
                Some((repo_short, _)) => base_dir.join("projects").join(&key).join(repo_short),
                None => std::path::PathBuf::new(),
            };
            let disposable = hub_gone || worktree_is_disposable(&clone, &wt);
            if disposable && remove_worktree_at(&clone, &wt).is_ok() {
                removed += 1;
            }
        }
        // Drop the per-project root if the whole project is gone (and now emptied).
        if hub_gone {
            let _ = std::fs::remove_dir(entry.path());
        }
    }
    if removed > 0 {
        log::info!("boot-gc: reclaimed {removed} stale fleet worktree(s)");
    }
    removed
}

/// Boot entry point: GC stale worktrees against the real base dir (#worktree-disk). Off the
/// synchronous boot path.
pub(crate) fn gc_worktrees_on_boot() -> usize {
    gc_worktrees_impl(&crate::bsc_base_dir())
}

// ── Tauri commands ──────────────────────────────────────────────────────────────

/// Tear down ONE fleet worker's worktree (stream complete / reap), junction-safe, removing both the
/// directory and the owning repo's worktree admin record (#1080). Idempotent.
#[tauri::command]
pub(crate) fn teardown_worktree(project_key: String, repo: String, agent_id: String) -> Result<(), String> {
    remove_worktree(&project_key, &repo, &agent_id)
}

/// Reclaim ALL of a project's fleet worktrees + their build artifacts (#1080). Returns how many
/// worktree directories were removed. Best-effort; safe to call when none exist.
#[tauri::command]
pub(crate) fn reclaim_worktrees(project_key: String) -> usize {
    reclaim_project_worktrees(&project_key)
}

/// Disk footprint of every fleet worktree across every project — the Settings "reclaim space"
/// surface (#1080). Sorted biggest-first.
#[tauri::command]
pub(crate) fn worktrees_disk_usage() -> Vec<WorktreeUsage> {
    worktrees_disk_usage_impl(&crate::bsc_base_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Stand up a real git clone with one commit, so `git worktree add/remove` work end to end.
    fn init_clone(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        let run = |args: &[&str]| {
            let mut c = std::process::Command::new("git");
            c.args(["-C", &dir.to_string_lossy()]).args(args);
            assert!(no_window(&mut c).status().unwrap().success(), "git {args:?} failed");
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@t.t"]);
        run(&["config", "user.name", "t"]);
        fs::write(dir.join("README.md"), "x").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);
    }

    fn unique_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("bsc-teardown-{tag}-{}-{nanos}", std::process::id()))
    }

    /// git worktree remove drops BOTH the directory AND the owning clone's admin record.
    #[test]
    fn remove_worktree_drops_dir_and_admin_record() {
        let base = unique_dir("rm");
        let clone = base.join("clone");
        init_clone(&clone);
        let wt = base.join("wt");
        // Add a worktree on a new branch.
        let mut add = std::process::Command::new("git");
        add.args(["-C", &clone.to_string_lossy(), "worktree", "add", "-b", "feat", &wt.to_string_lossy()]);
        assert!(no_window(&mut add).status().unwrap().success());
        assert!(wt.join(".git").exists(), "worktree created");
        // Build artifact present — teardown must reclaim it too.
        fs::create_dir_all(wt.join("target").join("debug")).unwrap();
        fs::write(wt.join("target").join("debug").join("big.bin"), vec![0u8; 4096]).unwrap();

        remove_worktree_at(&clone, &wt).unwrap();

        assert!(!wt.exists(), "worktree directory removed");
        // The admin record is gone: `git worktree list` no longer mentions the path.
        let mut list = std::process::Command::new("git");
        list.args(["-C", &clone.to_string_lossy(), "worktree", "list"]);
        let out = no_window(&mut list).output().unwrap();
        let listing = String::from_utf8_lossy(&out.stdout);
        assert!(!listing.contains("wt"), "admin record pruned: {listing}");

        let _ = fs::remove_dir_all(&base);
    }

    /// Tearing down a MISSING worktree is a no-op success (idempotent reap).
    #[test]
    fn remove_missing_worktree_is_ok() {
        let base = unique_dir("missing");
        let clone = base.join("clone");
        init_clone(&clone);
        let wt = base.join("never-made");
        assert!(remove_worktree_at(&clone, &wt).is_ok());
        let _ = fs::remove_dir_all(&base);
    }

    /// Boot-GC (#worktree-disk): reclaim merged-and-clean worktrees + orphans (project gone), but
    /// NEVER a dirty or unmerged-with-work worktree.
    #[test]
    fn gc_reclaims_merged_and_orphans_but_keeps_dirty_and_ahead() {
        let base = unique_dir("gc");
        let key = "projk";
        let clone = base.join("projects").join(key).join("web");
        init_clone(&clone);
        let wt_root = base.join("worktrees").join(key);
        fs::create_dir_all(&wt_root).unwrap();
        let git = |dir: &Path, args: &[&str]| {
            let mut c = std::process::Command::new("git");
            c.args(["-C", &dir.to_string_lossy()]).args(args);
            assert!(no_window(&mut c).status().unwrap().success(), "git {args:?}");
        };
        let add_wt = |name: &str, branch: &str| {
            let wt = wt_root.join(name);
            let mut c = std::process::Command::new("git");
            c.args(["-C", &clone.to_string_lossy(), "worktree", "add", "-b", branch, &wt.to_string_lossy()]);
            assert!(no_window(&mut c).status().unwrap().success(), "worktree add {branch}");
            wt
        };
        // (a) merged + clean — branch at the clone's HEAD, nothing changed → disposable.
        let merged = add_wt("web--merged", "merged");
        // (b) unmerged + clean — a committed change ahead of HEAD → keep (work not landed).
        let ahead = add_wt("web--ahead", "ahead");
        fs::write(ahead.join("new.txt"), "x").unwrap();
        git(&ahead, &["add", "."]);
        git(&ahead, &["commit", "-q", "-m", "ahead"]);
        // (c) merged but DIRTY — an untracked file → keep (never lose uncommitted work).
        let dirty = add_wt("web--dirty", "dirty");
        fs::write(dirty.join("scratch.txt"), "y").unwrap();
        // (d) orphan — a project whose hub is gone → reclaim regardless of git state.
        let orphan_clone = base.join("projects").join("gone").join("api");
        init_clone(&orphan_clone);
        let mut oc = std::process::Command::new("git");
        let orphan_wt = base.join("worktrees").join("gone").join("api--x");
        oc.args(["-C", &orphan_clone.to_string_lossy(), "worktree", "add", "-b", "x", &orphan_wt.to_string_lossy()]);
        assert!(no_window(&mut oc).status().unwrap().success());
        fs::remove_dir_all(base.join("projects").join("gone")).unwrap(); // hub gone

        let removed = gc_worktrees_impl(&base);

        assert!(!merged.exists(), "merged+clean worktree reclaimed");
        assert!(ahead.exists(), "unmerged worktree with work kept");
        assert!(dirty.exists(), "dirty worktree kept (no work lost)");
        assert!(!orphan_wt.exists(), "orphaned-project worktree reclaimed");
        assert!(removed >= 2, "reclaimed at least the merged + orphan worktrees (got {removed})");
        let _ = fs::remove_dir_all(&base);
    }

    /// detach_node_modules_junction removes ONLY the junction link, never the shared target's
    /// contents — the core of the junction hazard guard. (Windows-only: junctions don't exist
    /// elsewhere; on Unix this asserts the symlink case.)
    #[test]
    fn junction_detach_preserves_shared_target() {
        let base = unique_dir("junction");
        let shared = base.join("main-node_modules");
        fs::create_dir_all(shared.join(".bin")).unwrap();
        fs::write(shared.join(".bin").join("vite"), "binary").unwrap();
        let wt = base.join("wt");
        fs::create_dir_all(&wt).unwrap();
        let link = wt.join("node_modules");

        #[cfg(windows)]
        {
            let mut mk = std::process::Command::new("cmd");
            mk.args(["/c", "mklink", "/J", &link.to_string_lossy(), &shared.to_string_lossy()]);
            let made = no_window(&mut mk).status().map(|s| s.success()).unwrap_or(false);
            if !made {
                // Junction creation can be denied in some environments — skip rather than fail.
                let _ = fs::remove_dir_all(&base);
                return;
            }
        }
        #[cfg(not(windows))]
        {
            std::os::unix::fs::symlink(&shared, &link).unwrap();
        }
        assert!(link.exists(), "link in place");

        detach_node_modules_junction(&wt);

        assert!(!link.exists(), "junction link detached");
        assert!(shared.join(".bin").join("vite").exists(), "SHARED node_modules survived");

        let _ = fs::remove_dir_all(&base);
    }

    /// exclude_build_artifacts writes target/ (etc.) to the worktree's info/exclude, idempotently.
    #[test]
    fn exclude_writes_build_dirs_to_git_exclude() {
        let base = unique_dir("excl");
        let clone = base.join("clone");
        init_clone(&clone);
        let wt = base.join("wt");
        let mut add = std::process::Command::new("git");
        add.args(["-C", &clone.to_string_lossy(), "worktree", "add", "-b", "x", &wt.to_string_lossy()]);
        assert!(no_window(&mut add).status().unwrap().success());

        exclude_build_artifacts(&wt);
        exclude_build_artifacts(&wt); // idempotent

        // Resolve the worktree's exclude file through git and assert each entry once.
        let exclude = crate::platform::git::git_path(&wt, "info/exclude").expect("exclude path");
        let body = fs::read_to_string(&exclude).unwrap();
        for e in WORKTREE_BUILD_EXCLUDES {
            assert_eq!(body.matches(e).count(), 1, "{e} present exactly once: {body:?}");
        }
        // And git status no longer surfaces a target/ artifact.
        fs::create_dir_all(wt.join("target")).unwrap();
        fs::write(wt.join("target").join("x"), "y").unwrap();
        let mut st = std::process::Command::new("git");
        st.args(["-C", &wt.to_string_lossy(), "status", "--porcelain"]);
        let out = String::from_utf8_lossy(&no_window(&mut st).output().unwrap().stdout).into_owned();
        assert!(!out.contains("target"), "target/ excluded from status: {out:?}");

        let _ = fs::remove_dir_all(&base);
    }

    /// dir_size sums file bytes and does NOT follow symlinked/junctioned subdirs.
    #[test]
    fn dir_size_sums_files_and_skips_links() {
        let base = unique_dir("size");
        let d = base.join("d");
        fs::create_dir_all(d.join("sub")).unwrap();
        fs::write(d.join("a.bin"), vec![0u8; 1000]).unwrap();
        fs::write(d.join("sub").join("b.bin"), vec![0u8; 500]).unwrap();
        assert_eq!(dir_size(&d), 1500);
        let _ = fs::remove_dir_all(&base);
    }

    /// project_disk_usage_impl reports each worktree's size + target size, biggest first.
    #[test]
    fn project_disk_usage_reports_target_size() {
        let base = unique_dir("usage");
        let key = "proj";
        let root = base.join("worktrees").join(key);
        let wt_a = root.join("web--auth");
        let wt_b = root.join("api--svc");
        fs::create_dir_all(wt_a.join("target")).unwrap();
        fs::create_dir_all(&wt_b).unwrap();
        fs::write(wt_a.join("src.rs"), vec![0u8; 100]).unwrap();
        fs::write(wt_a.join("target").join("big.bin"), vec![0u8; 5000]).unwrap();
        fs::write(wt_b.join("only.rs"), vec![0u8; 50]).unwrap();

        let usage = project_disk_usage_impl(&base, key);
        assert_eq!(usage.len(), 2);
        // Biggest first: web--auth (5100) before api--svc (50).
        assert_eq!(usage[0].name, "web--auth");
        assert_eq!(usage[0].size_bytes, 5100);
        assert_eq!(usage[0].target_bytes, 5000);
        assert_eq!(usage[1].name, "api--svc");
        assert_eq!(usage[1].target_bytes, 0);

        let _ = fs::remove_dir_all(&base);
    }

    /// reclaim sweeps every worktree under a project and drops the per-project root, junction-safe.
    /// Uses real clones so the admin records are pruned too.
    #[test]
    fn reclaim_removes_all_project_worktrees() {
        let _guard = crate::testutil::ENV_LOCK.lock().unwrap();
        let home = crate::testutil::temp_home("reclaim");

        // Two repos cloned under the hub; one worktree each.
        let key = "proj";
        let hub = crate::project_dir(key);
        let web = hub.join("web");
        let api = hub.join("api");
        init_clone(&web);
        init_clone(&api);
        let wts = crate::worktrees_dir(key);
        let make_wt = |clone: &Path, name: &str, branch: &str| {
            let wt = wts.join(name);
            let mut add = std::process::Command::new("git");
            add.args(["-C", &clone.to_string_lossy(), "worktree", "add", "-b", branch, &wt.to_string_lossy()]);
            assert!(no_window(&mut add).status().unwrap().success());
            // Leak a target/ into each.
            fs::create_dir_all(wt.join("target")).unwrap();
            fs::write(wt.join("target").join("o"), vec![0u8; 2048]).unwrap();
        };
        make_wt(&web, "web--auth", "auth");
        make_wt(&api, "api--svc", "svc");
        assert!(wts.join("web--auth").exists() && wts.join("api--svc").exists());

        let removed = reclaim_project_worktrees(key);
        assert_eq!(removed, 2, "both worktrees removed");
        assert!(!wts.exists(), "per-project worktrees root dropped");

        // Both clones' admin records pruned.
        for clone in [&web, &api] {
            let mut list = std::process::Command::new("git");
            list.args(["-C", &clone.to_string_lossy(), "worktree", "list"]);
            let out = String::from_utf8_lossy(&no_window(&mut list).output().unwrap().stdout).into_owned();
            assert!(!out.contains("--"), "no worktree records remain: {out}");
        }

        let _ = fs::remove_dir_all(&home);
    }
}
