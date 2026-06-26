//! `bsc-project` (#1720) — the cross-project hub-lifecycle view, the pure half shared by the
//! `bsc-project` CLI. Unlike `bsc-plan` (which is scoped to ONE project's `plan.db` via
//! `$BSC_PLAN_DB`), this walks **every** project hub under `~/.base-studio-code/projects/<key>/`
//! and reads/writes the in-place `.published` marker (#922).
//!
//! It mirrors the desktop app's `project/hub.rs` listing (`list_local_projects`) + its
//! `is_published`/`mark_published` markers, but stays Tauri-free (std + `bsc_util` only) so it
//! links into the lean session CLI. Both sides resolve the base dir through the ONE shared
//! `bsc_util::bsc_base_dir()` (#1646), so the app and the CLI always agree on which `projects/`
//! tree they read.

use std::path::PathBuf;

/// One on-disk project hub: its directory key, whether it has been published, and its absolute path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    /// The hub directory name (the sanitized project key).
    pub key: String,
    /// True when the hub carries the in-place `.published` marker (#922).
    pub published: bool,
    /// Absolute path to the hub directory.
    pub path: PathBuf,
}

/// The projects root: `~/.base-studio-code/projects`. `None` when no home dir is resolvable.
pub fn projects_root() -> Option<PathBuf> {
    bsc_util::bsc_base_dir().map(|b| b.join("projects"))
}

/// The hub directory for one project key (`projects/<key>/`). `None` when no home dir is resolvable.
pub fn project_dir(key: &str) -> Option<PathBuf> {
    projects_root().map(|r| r.join(key))
}

/// The path of a project's `.published` marker file. `None` when no home dir is resolvable.
pub fn published_marker(key: &str) -> Option<PathBuf> {
    project_dir(key).map(|d| d.join(".published"))
}

/// Whether a project has been published — its hub carries the in-place `.published` marker (#922).
pub fn is_published(key: &str) -> bool {
    published_marker(key).map(|m| m.exists()).unwrap_or(false)
}

/// Mark a project published (#922): create the hub dir if needed and write `.published`. Idempotent
/// — mirrors the desktop `mark_published` command (`project/hub.rs`). Errors on an empty key (so it
/// can never stamp the `projects/` root) or when no home dir is resolvable.
pub fn mark_published(key: &str) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("mark_published: empty project key".into());
    }
    let dir = project_dir(key).ok_or("mark_published: no home dir ($HOME / $USERPROFILE unset)")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mark_published: {e}"))?;
    std::fs::write(dir.join(".published"), b"published\n").map_err(|e| format!("mark_published: {e}"))
}

/// List the on-disk projects — the `projects/<key>/` directories — each with its published status
/// and absolute path, sorted by key. Mirrors `project/hub.rs::list_local_projects` (without the
/// title/has_plan/mtime derivation the desktop UI needs): dot-prefixed dirs and stray files are
/// skipped. Empty when the projects root is missing or unreadable.
pub fn list_projects() -> Vec<Project> {
    let Some(root) = projects_root() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&root) else { return Vec::new() };
    let mut out: Vec<Project> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if !path.is_dir() {
                return None;
            }
            let key = path.file_name().and_then(|n| n.to_str())?.to_string();
            if key.starts_with('.') {
                return None;
            }
            let published = path.join(".published").exists();
            Some(Project { key, published, path })
        })
        .collect();
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // The listing reads $HOME / $USERPROFILE (via bsc_util); serialize the tests that override them.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Run `f` with the home dir pointed at a fresh temp dir, restoring the prior value after. The
    /// key matches `bsc_util::home_dir` precedence (USERPROFILE on Windows, HOME on Unix).
    fn with_home<T>(f: impl FnOnce(&std::path::Path) -> T) -> T {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let prev = std::env::var_os(key);
        let dir = std::env::temp_dir().join(format!("bsc-project-test-{}-{}", std::process::id(), bsc_util::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var(key, &dir);
        let out = f(&dir);
        match prev {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    #[test]
    fn lists_projects_skipping_dotdirs_and_files_sorted_by_key() {
        with_home(|home| {
            let projects = home.join(".base-studio-code").join("projects");
            std::fs::create_dir_all(projects.join("beta")).unwrap();
            std::fs::create_dir_all(projects.join("alpha")).unwrap();
            std::fs::create_dir_all(projects.join(".hidden")).unwrap(); // dot-dir → skipped
            std::fs::write(projects.join("stray.txt"), "x").unwrap(); // file → skipped

            let list = list_projects();
            let keys: Vec<&str> = list.iter().map(|p| p.key.as_str()).collect();
            assert_eq!(keys, vec!["alpha", "beta"], "sorted by key; dot-dirs + files skipped");
            assert!(list.iter().all(|p| !p.published), "nothing published yet");
            assert_eq!(list[0].path, projects.join("alpha"), "path is the absolute hub dir");
        });
    }

    #[test]
    fn published_marker_round_trips_and_reflects_in_the_list() {
        with_home(|home| {
            let projects = home.join(".base-studio-code").join("projects");
            std::fs::create_dir_all(projects.join("alpha")).unwrap();
            std::fs::create_dir_all(projects.join("beta")).unwrap();

            assert!(!is_published("alpha"));
            mark_published("alpha").unwrap();
            assert!(is_published("alpha"));
            assert!(projects.join("alpha").join(".published").is_file());

            let list = list_projects();
            assert!(list.iter().find(|p| p.key == "alpha").unwrap().published);
            assert!(!list.iter().find(|p| p.key == "beta").unwrap().published);
        });
    }

    #[test]
    fn mark_published_creates_a_missing_hub_dir_and_refuses_empty_key() {
        with_home(|_home| {
            // No pre-existing dir → mark_published still creates the hub + marker.
            mark_published("fresh").unwrap();
            assert!(is_published("fresh"));
            assert!(project_dir("fresh").unwrap().is_dir());
            // An empty key is refused so it can never stamp the projects/ root.
            assert!(mark_published("   ").is_err());
        });
    }

    #[test]
    fn empty_projects_root_lists_nothing() {
        with_home(|_home| {
            // projects/ never created → an empty list, not an error.
            assert!(list_projects().is_empty());
            assert!(!is_published("whatever"));
        });
    }
}
