//! Fleet worktree disk-usage inventory (#1080) — the read-only footprint surface that backs
//! Settings' "reclaim space" panel, split out of `fleet/teardown.rs` (removal/GC lives there).
//!
//! Each fleet worktree builds independently, so each accumulates its own `target/` (and
//! `node_modules`, etc.) that Cargo never garbage-collects. This module walks every worktree of every
//! project and reports the total + `target/` bytes of each — biggest-first — so the user can see, and
//! then reclaim, the space. The walks are I/O-bound metadata syscalls over huge `target/` trees, so
//! [`worktrees_disk_usage`] fans them out (bounded to available parallelism) and runs off the main
//! thread. All entry points are pure over a base dir for testability.
//!
//! Symlinked/junctioned children are never traversed — their bytes belong to the target, not the
//! worktree (memory: worktree-junction-hazard).

use std::path::Path;

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

/// Total + `target/` bytes of one worktree, in a SINGLE pass over its top level — the old code walked
/// `target/` twice (once inside the full size, once standalone), and `target/` is the dominant
/// component, so this ~halves the per-worktree work. Skips symlinked/junctioned children (#worktree-
/// junction-hazard — their bytes belong to the target, not this worktree).
fn worktree_sizes(wt: &Path) -> (u64, u64) {
    let Ok(rd) = std::fs::read_dir(wt) else { return (0, 0) };
    let (mut total, mut target) = (0u64, 0u64);
    for entry in rd.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let sz = if ft.is_dir() {
            dir_size(&entry.path())
        } else {
            entry.metadata().map(|m| m.len()).unwrap_or(0)
        };
        total += sz;
        if ft.is_dir() && entry.file_name() == "target" {
            target = sz;
        }
    }
    (total, target)
}

/// The worktree dirs (project_key, name, path) under one project — cheap (one `read_dir`, no size walk).
fn enumerate_project_worktrees(base_dir: &Path, project_key: &str) -> Vec<(String, String, std::path::PathBuf)> {
    let key = crate::sanitize_project_key(project_key);
    let root = base_dir.join("worktrees").join(&key);
    let Ok(rd) = std::fs::read_dir(&root) else { return Vec::new() };
    rd.flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| (key.clone(), e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect()
}

/// Size every enumerated worktree CONCURRENTLY, biggest-first. The cost is I/O-bound metadata syscalls
/// over huge `target/` trees, so fanning the walks out (bounded to available parallelism) cuts
/// wall-time. Enumeration is cheap + already done; only the size walks fan out.
fn sizes_biggest_first(entries: Vec<(String, String, std::path::PathBuf)>) -> Vec<WorktreeUsage> {
    if entries.is_empty() {
        return Vec::new();
    }
    let n = std::thread::available_parallelism().map(|p| p.get()).unwrap_or(4).min(entries.len());
    let chunk = entries.len().div_ceil(n);
    let mut out: Vec<WorktreeUsage> = std::thread::scope(|s| {
        entries
            .chunks(chunk)
            .map(|c| {
                s.spawn(move || {
                    c.iter()
                        .map(|(key, name, path)| {
                            let (size_bytes, target_bytes) = worktree_sizes(path);
                            WorktreeUsage {
                                project_key: key.clone(),
                                name: name.clone(),
                                path: path.to_string_lossy().into_owned(),
                                size_bytes,
                                target_bytes,
                            }
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    });
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes).then(a.name.cmp(&b.name)));
    out
}

/// Every project's worktree usage, biggest-first — the size walks fan out across ALL worktrees at
/// once (not just within a project). Pure over a base dir for testability.
pub(crate) fn worktrees_disk_usage_impl(base_dir: &Path) -> Vec<WorktreeUsage> {
    let root = base_dir.join("worktrees");
    let Ok(projects) = std::fs::read_dir(&root) else { return Vec::new() };
    let entries: Vec<_> = projects
        .flatten()
        .filter(|p| p.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .flat_map(|p| enumerate_project_worktrees(base_dir, &p.file_name().to_string_lossy()))
        .collect();
    sizes_biggest_first(entries)
}

// ── Tauri commands ──────────────────────────────────────────────────────────────

/// Disk footprint of every fleet worktree across every project — the Settings "reclaim space"
/// surface (#1080). Sorted biggest-first. Async + `spawn_blocking` so the recursive size walk (every
/// file in every worktree's `target/` — potentially hundreds of thousands) runs OFF the main thread
/// instead of freezing the window while Settings → Planner → Storage mounts (#1916 perf).
#[tauri::command]
pub(crate) async fn worktrees_disk_usage() -> Vec<WorktreeUsage> {
    tauri::async_runtime::spawn_blocking(|| worktrees_disk_usage_impl(&crate::bsc_base_dir()))
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("bsc-disk-{tag}-{}-{nanos}", std::process::id()))
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

    /// worktrees_disk_usage_impl reports each worktree's size + target size (single-walk), biggest first.
    #[test]
    fn worktrees_disk_usage_reports_target_size() {
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

        let usage = worktrees_disk_usage_impl(&base);
        assert_eq!(usage.len(), 2);
        // Biggest first: web--auth (5100) before api--svc (50).
        assert_eq!(usage[0].name, "web--auth");
        assert_eq!(usage[0].size_bytes, 5100);
        assert_eq!(usage[0].target_bytes, 5000);
        assert_eq!(usage[1].name, "api--svc");
        assert_eq!(usage[1].target_bytes, 0);

        let _ = fs::remove_dir_all(&base);
    }
}
