//! Filesystem path resolution (#1300) — every `~/.base-studio-code` location the app reads or
//! writes: the base dir, the document library, project hubs, repo clones, fleet worktrees, plan +
//! context dirs, and the published marker. Pure path construction (no I/O except the marker probe).
//! Extracted verbatim from `lib.rs`.

use crate::platform::fsx::sanitize_project_key;

/// The user's home directory. Delegates to the shared [`bsc_util::home_dir`] (#1646) so the app
/// and every `bsc-*` CLI resolve the SAME directory; an unset home falls back to the empty path
/// (the historical behavior — callers join `.base-studio-code` onto it). The precedence
/// (`USERPROFILE`-then-`HOME` on Windows, `HOME` on Unix) lives there.
pub(crate) fn home_dir() -> std::path::PathBuf {
    bsc_util::home_dir().unwrap_or_default()
}

pub(crate) fn bsc_base_dir() -> std::path::PathBuf {
    bsc_util::bsc_base_dir().unwrap_or_else(|| std::path::PathBuf::from(".base-studio-code"))
}

/// The project hub directory and the planner session's CWD: `~/.base-studio-code/projects/<key>`.
/// Holds the project's `CLAUDE.md` (ancestor-loaded context for repo sessions), plan sections
/// (`goal.md`…), control files, `prompts/`, and the cloned repos as subdirectories.
///
/// ONE location for the life of the project — published or draft (#922). The hub NEVER moves, so
/// the planner's cwd (and Claude's cwd-keyed `--continue` history) stays stable. Published-ness is
/// an in-place marker file (`.published`), NOT the directory's location — see [`is_published`] /
/// [`crate::mark_published`]. This replaces the #904 draft/ vs projects/ split, whose publish-time
/// rename fought the Windows cwd lock (a live process can't have its cwd renamed), orphaned Claude
/// history, and wedged into a permanent split-brain when the rename half-failed.
pub(crate) fn project_dir(project_key: &str) -> std::path::PathBuf {
    bsc_base_dir().join("projects").join(sanitize_project_key(project_key))
}

/// The published-marker file inside a project hub (#922): `projects/<key>/.published`. Its presence
/// means the project has been published to GitHub; absence = draft. The source of published-ness,
/// replacing directory location.
///
/// Delegates the path to `bsc_project::published_marker` (#1761) so the `.published` marker logic is
/// single-sourced with the `bsc project` session CLI; the key is sanitized here (the app boundary,
/// since the crate treats keys as opaque), and an unresolvable home falls back to the app's relative
/// base (matching [`bsc_base_dir`]'s historical behavior).
pub(crate) fn published_marker(project_key: &str) -> std::path::PathBuf {
    let key = sanitize_project_key(project_key);
    bsc_project::published_marker(&key)
        .unwrap_or_else(|| bsc_base_dir().join("projects").join(key).join(".published"))
}

/// Whether a project hub carries the published marker (#922).
pub(crate) fn is_published(project_key: &str) -> bool {
    published_marker(project_key).is_file()
}

/// The legacy unpublished-hub location from the #904 split: `~/.base-studio-code/draft/<key>`.
/// Retained ONLY for the one-time migration that consolidates these back under `projects/` (#922)
/// and for defensive cleanup in `delete_project_dir`.
pub(crate) fn legacy_draft_dir(project_key: &str) -> std::path::PathBuf {
    bsc_base_dir().join("draft").join(sanitize_project_key(project_key))
}

/// The on-disk clone location of a repo within its project hub:
/// `projects/<sanitized-project-key>/<short-repo-name>`, where the short name is
/// the part of `owner/name` after the `/`. Each repo clone is a repo session's CWD.
pub(crate) fn repo_dir(project_key: &str, repo_full_name: &str) -> std::path::PathBuf {
    let short = repo_full_name.rsplit('/').next().unwrap_or(repo_full_name);
    project_dir(project_key).join(short)
}

/// The fleet's git worktrees live OUTSIDE the project hub, at
/// `~/.base-studio-code/worktrees/<sanitized-project-key>/`, so the hub's `CLAUDE.md`
/// (the planner spec) is NOT an ancestor of a worker's CWD. Claude Code loads `CLAUDE.md`
/// from the cwd and every parent directory, and that walk can't be suppressed per-directory
/// — keeping worktrees under the hub leaked the full ~52KB planning spec into every worker
/// session (pulling workers toward planning and inflating per-turn input tokens), and made
/// the hub-rooted director believe it launches the fleet. Relocating them here makes each
/// worker load only its own scoped `CLAUDE.local.md` + the repo's tracked `CLAUDE.md` (#844).
pub(crate) fn worktrees_dir(project_key: &str) -> std::path::PathBuf {
    bsc_base_dir()
        .join("worktrees")
        .join(sanitize_project_key(project_key))
}

/// Absolute on-disk location of a project's plan section files, which live FLAT
/// in the project hub: `~/.base-studio-code/projects/<sanitized-project-key>`.
/// Plan sections sit alongside the control files (CLAUDE.md, automations.md, …) in
/// the planner's CWD.
pub(crate) fn plan_dir_for(project_key: &str) -> std::path::PathBuf {
    project_dir(project_key)
}

/// The Discovery-stage sections live in their own subdir of the hub (#807):
/// `projects/<sanitized-key>/discovery/`. Keeps the discovery topics easy to find (and the
/// hub uncluttered) for larger / off-script plans. Created only when the blueprint has a
/// discovery stage; read alongside the flat root so pre-existing projects still resolve.
pub(crate) fn discovery_dir_for(project_key: &str) -> std::path::PathBuf {
    project_dir(project_key).join("discovery")
}

/// The nearest existing ancestor directory of `path` (native form), or "" if none
/// exists. Used by `pty_create` to avoid the silent $HOME fallback when a session's
/// configured cwd is missing — we land in the closest real directory instead (#367).
pub(crate) fn nearest_existing_ancestor(path: &str) -> String {
    let mut p = std::path::Path::new(path);
    loop {
        if p.as_os_str().is_empty() { return String::new(); }
        if p.is_dir() { return p.to_string_lossy().into_owned(); }
        match p.parent() {
            Some(parent) => p = parent,
            None => return String::new(),
        }
    }
}
