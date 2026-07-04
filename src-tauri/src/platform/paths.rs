//! Filesystem path resolution (#1300) — every `~/.base-studio-code` location the app reads or
//! writes: the base dir, the document library, project hubs, repo clones, fleet worktrees, plan +
//! context dirs, and the published marker. Pure path construction (no I/O except the marker probe).
//! Extracted verbatim from `lib.rs`.

use crate::platform::fsx::{sanitize_project_key, worktree_slug};

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
/// The root that holds every project hub: `~/.base-studio-code/projects`. One source of truth for the
/// path so callers stop hand-rolling `bsc_base_dir().join("projects")` (#2081).
pub(crate) fn projects_root() -> std::path::PathBuf {
    bsc_base_dir().join("projects")
}

pub(crate) fn project_dir(project_key: &str) -> std::path::PathBuf {
    projects_root().join(sanitize_project_key(project_key))
}

/// The project hub's per-project SQLite plan store: `projects/<key>/plan.db` (#plan-db). The sole fleet
/// store (#1805). One helper so the path stops being spelled two ways — `project_dir(key).join("plan.db")`
/// vs `bsc_base_dir().join("projects").join(key).join("plan.db")` — which is exactly the drift this
/// module exists to prevent (#2081). Key sanitize is idempotent, so a cwd-derived (already-sanitized)
/// key resolves to the same path.
pub(crate) fn plan_db_path(project_key: &str) -> std::path::PathBuf {
    project_dir(project_key).join("plan.db")
}

/// The project hub's per-project SQLite **runtime-fault store**: `projects/<key>/error.db` (#2260).
/// Scoped at a live session by `$BSC_ERROR_DB`, cwd-derived exactly like `plan_db_path` — so the whole
/// fleet (director at the hub, workers in worktrees beneath it) shares one error.db per project.
pub(crate) fn error_db_path(project_key: &str) -> std::path::PathBuf {
    project_dir(project_key).join("error.db")
}

/// The project's canonical DuckDB **data store**: `~/.base-studio-code/data/<key>.duckdb` — the Data
/// Model + PlatformScan the planner reads via `bsc data` (#1446). Pure path construction (no `mkdir`);
/// callers that write create the parent themselves. Sanitizes the key (idempotent on a cwd-derived key).
pub(crate) fn data_db_path(project_key: &str) -> std::path::PathBuf {
    bsc_base_dir().join("data").join(format!("{}.duckdb", sanitize_project_key(project_key)))
}

/// The global skills store: `~/.base-studio-code/skills.db` (the `bsc skill` CLI's db). Not per-project.
pub(crate) fn skills_db() -> std::path::PathBuf {
    bsc_base_dir().join("skills.db")
}

/// The performance/cost metrics store: `~/.base-studio-code/perf.db` (#1607). Not per-project.
pub(crate) fn perf_db() -> std::path::PathBuf {
    bsc_base_dir().join("perf.db")
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
    project_dir(project_key).join(repo_short(repo_full_name))
}

/// The SHORT repo name: the segment of a GitHub `owner/name` after the last `/` (or the
/// whole string when there's no `/`). Every on-disk path derived from a repo uses this short
/// form — the clone dir under the hub ([`repo_dir`]) and the worktree dir name
/// ([`worktree_dir_name`]) — so this is the single source of that idiom (#2061), replacing the
/// hand-rolled `repo.rsplit('/').next().unwrap_or(repo)` scattered across the fleet.
pub(crate) fn repo_short(repo_full_name: &str) -> &str {
    repo_full_name.rsplit('/').next().unwrap_or(repo_full_name)
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

/// The on-disk directory NAME of a fleet worker's worktree: `<repoShort>--<slug>`, where
/// `slug` = [`worktree_slug`]`(agent_id)`. Join it onto [`worktrees_dir`] for the absolute path.
/// The SINGLE builder for that name (#2061) — create ([`crate::fleet::worktree::ensure_worktree`]),
/// discover (`console::discovery`), and teardown (`fleet::teardown`) all route through this + its
/// inverse [`parse_worktree_dir_name`] so the paths can never silently disagree.
pub(crate) fn worktree_dir_name(repo: &str, agent_id: &str) -> String {
    format!("{}--{}", repo_short(repo), worktree_slug(agent_id))
}

/// Inverse of [`worktree_dir_name`]: split a worktree dir name into `(repo_short, slug)`, returning
/// `None` when there is no `--` boundary.
///
/// The FIRST `--` is the boundary: [`worktree_slug`] never emits `--` (it maps every non-`[A-Za-z0-9._-]`
/// char to a single `-`, so a doubled dash can only come from the literal separator), so the only way
/// the round-trip could mis-split is a repo SHORT name that itself contains `--`. GitHub repo names can
/// technically contain consecutive hyphens, so that is the documented guard: `worktree_dir_name` →
/// `parse_worktree_dir_name` round-trips exactly for any repo short name WITHOUT `--`; a `--`-containing
/// short name would be truncated at its first `--` (matching the pre-existing `split_once("--")` callers
/// this consolidates). In practice no linked repo short name has ever contained `--`.
pub(crate) fn parse_worktree_dir_name(name: &str) -> Option<(&str, &str)> {
    name.split_once("--")
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

#[cfg(test)]
mod relocated_tests {
    #![allow(unused_imports)]
    use super::*;
    use crate::testutil::prelude::*;

    #[test]
    fn well_known_locations_compose_off_the_base_and_project_dirs() {
        // #2081: the named location helpers replace ~20 ad-hoc `bsc_base_dir().join(...)` joins.
        assert_eq!(projects_root(), bsc_base_dir().join("projects"));
        assert_eq!(project_dir("k"), projects_root().join("k"));
        assert_eq!(skills_db(), bsc_base_dir().join("skills.db"));
        assert_eq!(perf_db(), bsc_base_dir().join("perf.db"));
        assert_eq!(data_db_path("k"), bsc_base_dir().join("data").join("k.duckdb"));
        // The runtime-fault store sits beside plan.db in the hub (#2260).
        assert_eq!(error_db_path("k"), project_dir("k").join("error.db"));
    }

    #[test]
    fn plan_db_path_collapses_the_two_former_spellings() {
        // #2081 regression: plan.db was spelled `project_dir(k).join("plan.db")` in one place and
        // `bsc_base_dir().join("projects").join(k).join("plan.db")` in another. Both must resolve to
        // the SAME path so the drift can't recur. Key sanitize is idempotent, so an already-sanitized
        // (cwd-derived) key resolves identically.
        assert_eq!(plan_db_path("my-app"), project_dir("my-app").join("plan.db"));
        assert_eq!(plan_db_path("my-app"), projects_root().join("my-app").join("plan.db"));
        // sanitize is applied and idempotent.
        assert_eq!(plan_db_path("a/b"), plan_db_path("a_b"));
    }

    #[test]
    fn project_dir_places_the_sanitized_key_directly_under_projects() {
        // Every hub lives at projects/<key> for life (#922) — no draft/ root, no documents/ prefix.
        let p = project_dir("studio-code").to_string_lossy().replace('\\', "/");
        assert!(p.ends_with("/projects/studio-code"), "got {p}");
        assert!(!p.contains("/documents/"), "got {p}");
        let s = project_dir("acme/api project").to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("/projects/acme_api_project"), "got {s}");
    }
    #[test]
    fn repo_dir_places_the_repo_short_name_under_the_project_hub() {
        // Backs the `repo_dir_path` command (#1819): triage resolves each repo's absolute clone
        // dir from Rust so a launch never depends on the async `bscBaseDir` mirror. The path is
        // projects/<sanitized-key>/<short-repo-name> and mirrors the frontend `projectRepoCwd`.
        let p = repo_dir("studio-code", "acme/wotos-ui").to_string_lossy().replace('\\', "/");
        assert!(p.ends_with("/projects/studio-code/wotos-ui"), "got {p}");
        // The key is sanitized; the repo collapses to its segment after the last '/'.
        let s = repo_dir("acme/api project", "owner/api").to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("/projects/acme_api_project/api"), "got {s}");
    }
    #[test]
    fn repo_short_takes_the_segment_after_the_last_slash() {
        assert_eq!(repo_short("acme/wotos-ui"), "wotos-ui");
        assert_eq!(repo_short("owner/api"), "api");
        // No '/' → the whole string.
        assert_eq!(repo_short("localrepo"), "localrepo");
        // Only the LAST '/' matters (defensive — full names are owner/name).
        assert_eq!(repo_short("a/b/c"), "c");
    }
    #[test]
    fn worktree_dir_name_builds_and_round_trips_through_parse() {
        // Build: <repoShort>--<slug(agent)>; the agent id is slugified, the repo collapses to its short name.
        let name = worktree_dir_name("acme/wotos-ui", "feat/login");
        assert_eq!(name, "wotos-ui--feat-login");
        // Round-trip: parse recovers (repo_short, slug) for a name WITHOUT '--' in the repo short.
        assert_eq!(parse_worktree_dir_name(&name), Some(("wotos-ui", "feat-login")));
        // A dir name with no boundary parses to None (no owning clone).
        assert_eq!(parse_worktree_dir_name("nodashes"), None);
    }
    #[test]
    fn parse_worktree_dir_name_splits_at_the_first_dash_pair() {
        // The documented guard: a repo short name containing '--' truncates at its FIRST '--'
        // (matches the pre-existing split_once("--") behavior this consolidates). worktree_slug
        // itself never emits '--', so a well-formed name always round-trips.
        let name = worktree_dir_name("owner/a--b", "s1");
        assert_eq!(name, "a--b--s1");
        // First '--' is the boundary → repo short truncates to "a", slug is the remainder.
        assert_eq!(parse_worktree_dir_name(&name), Some(("a", "b--s1")));
    }
    #[test]
    fn worktrees_dir_is_outside_the_project_hub() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("wtdir");
        let key = "my-proj";
        let wts = worktrees_dir(key);
        let hub = project_dir(key);
        // The whole point of #844: a worker's worktree is NOT under the hub, so the hub's
        // planner CLAUDE.md is not an ancestor of the worker's cwd.
        assert!(wts.starts_with(bsc_base_dir().join("worktrees")), "got {wts:?}");
        assert!(!wts.starts_with(&hub), "worktrees must not be under the hub: {wts:?} ⊄ {hub:?}");
        std::fs::remove_dir_all(&home).ok();
    }
}
