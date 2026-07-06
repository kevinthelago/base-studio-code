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
//!
//! The agent-facing CLI lives in [`cli`] (`bsc project …`), dispatched by the unified `bsc` binary
//! (#1877) and by the legacy `bsc-project` shim.

pub mod cli;

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

// ── Project relationships (#2253) — the edges of the Glance L1 network ──────────────────────────────
//
// A GLOBAL, cross-project link store (not scoped to one hub): `~/.base-studio-code/project-links.json`,
// a flat JSON array of `{ id, from, to, kind }`. `from` (consumer) depends on / consumes `to` (provider)
// over a contract of `kind` (api | data | events). The desktop Glance UI draws these; an agent reads
// them via `bsc project link list --json` to learn "what does my project consume". The id is derived so
// adding the same edge twice is idempotent.

/// The edge kinds a link may carry (the Glance contract surfaces).
pub const LINK_KINDS: [&str; 3] = ["api", "data", "events"];

/// One project→project relationship.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectLink {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
}

/// The global links file: `~/.base-studio-code/project-links.json`. `None` when no home dir resolves.
pub fn links_path() -> Option<PathBuf> {
    bsc_util::bsc_base_dir().map(|b| b.join("project-links.json"))
}

/// Deterministic id for a link, so adding the same edge twice is idempotent (matches the frontend).
pub fn link_id(from: &str, to: &str, kind: &str) -> String {
    format!("{from}>{to}:{kind}")
}

fn link_from_json(v: &serde_json::Value) -> Option<ProjectLink> {
    Some(ProjectLink {
        id: v.get("id")?.as_str()?.to_string(),
        from: v.get("from")?.as_str()?.to_string(),
        to: v.get("to")?.as_str()?.to_string(),
        kind: v.get("kind")?.as_str()?.to_string(),
    })
}

fn link_to_json(l: &ProjectLink) -> serde_json::Value {
    serde_json::json!({ "id": l.id, "from": l.from, "to": l.to, "kind": l.kind })
}

/// Load every project link. Empty when the file is missing/unreadable/malformed (never errors — a
/// fresh install simply has no links).
pub fn load_links() -> Vec<ProjectLink> {
    let Some(path) = links_path() else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(&path) else { return Vec::new() };
    let Ok(serde_json::Value::Array(arr)) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    arr.iter().filter_map(link_from_json).collect()
}

fn save_links(links: &[ProjectLink]) -> Result<(), String> {
    let path = links_path().ok_or("save_links: no home dir ($HOME / $USERPROFILE unset)")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("save_links: {e}"))?;
    }
    let arr: Vec<serde_json::Value> = links.iter().map(link_to_json).collect();
    let json = serde_json::to_string(&arr).map_err(|e| format!("save_links: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("save_links: {e}"))
}

/// Add a link (idempotent by id). Rejects an empty endpoint, a self-loop, or an unknown kind. Returns
/// the link id.
pub fn add_link(from: &str, to: &str, kind: &str) -> Result<String, String> {
    let (from, to, kind) = (from.trim(), to.trim(), kind.trim());
    if from.is_empty() || to.is_empty() {
        return Err("add_link: empty from/to".into());
    }
    if from == to {
        return Err("add_link: a project can't link to itself".into());
    }
    if !LINK_KINDS.contains(&kind) {
        return Err(format!("add_link: unknown kind '{kind}' (want one of {LINK_KINDS:?})"));
    }
    let id = link_id(from, to, kind);
    let mut links = load_links();
    if !links.iter().any(|l| l.id == id) {
        links.push(ProjectLink { id: id.clone(), from: from.into(), to: to.into(), kind: kind.into() });
        save_links(&links)?;
    }
    Ok(id)
}

/// Remove a link by id (no-op when absent).
pub fn remove_link(id: &str) -> Result<(), String> {
    let mut links = load_links();
    let before = links.len();
    links.retain(|l| l.id != id);
    if links.len() != before {
        save_links(&links)?;
    }
    Ok(())
}

// ── Persisted GitHub board state (#2446, epic #2444) ────────────────────────────────────────────────
//
// The desktop app mirrors its last successful GitHub projects fetch here so the last-known board
// state survives a restart AND is reachable from a live session via `bsc project github-state`
// (golden rule: every persistent app store is `bsc`-reachable). One global file next to
// project-links.json: `~/.base-studio-code/github-state.json`, holding
// `{ records: [<minimal per-project record>, …], fetchedAt: <epoch ms> }`. The frontend owns the
// record schema (id/number/title/shortDescription/url/closed/updatedAt/itemsTotalCount/openCount/
// closedCount/repos); this side treats the payload as opaque-but-valid JSON with that envelope,
// replaced wholesale on each successful fetch.

/// The global github-state file: `~/.base-studio-code/github-state.json`. `None` when no home dir
/// resolves.
pub fn github_state_path() -> Option<PathBuf> {
    bsc_util::bsc_base_dir().map(|b| b.join("github-state.json"))
}

/// Load the persisted GitHub board state as its raw JSON text. `None` when the file is missing,
/// unreadable, or not valid JSON (never errors — a fresh install simply has no state).
pub fn load_github_state() -> Option<String> {
    let path = github_state_path()?;
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok()?;
    Some(text)
}

/// Replace the persisted GitHub board state wholesale. `json` must parse to an object carrying a
/// `records` array and a numeric `fetchedAt` (the envelope the desktop app writes) — anything else is
/// rejected so a malformed write can never clobber the last good state.
pub fn save_github_state(json: &str) -> Result<(), String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("save_github_state: invalid JSON: {e}"))?;
    let shape_ok = v.get("records").map(serde_json::Value::is_array).unwrap_or(false)
        && v.get("fetchedAt").map(serde_json::Value::is_number).unwrap_or(false);
    if !shape_ok {
        return Err("save_github_state: expected { records: [...], fetchedAt: <epoch ms> }".into());
    }
    let path = github_state_path().ok_or("save_github_state: no home dir ($HOME / $USERPROFILE unset)")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("save_github_state: {e}"))?;
    }
    let compact = serde_json::to_string(&v).map_err(|e| format!("save_github_state: {e}"))?;
    std::fs::write(&path, compact).map_err(|e| format!("save_github_state: {e}"))
}

/// Shared test-home plumbing (used by BOTH this module's tests and [`cli`]'s): every store here
/// resolves through $HOME / $USERPROFILE (via bsc_util), so all tests overriding them must
/// serialize on ONE lock — two test modules with separate locks would race the process-global env.
#[cfg(test)]
pub(crate) mod testhome {
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Run `f` with the home dir pointed at a fresh temp dir, restoring the prior value after. The
    /// key matches `bsc_util::home_dir` precedence (USERPROFILE on Windows, HOME on Unix).
    pub(crate) fn with_home<T>(f: impl FnOnce(&std::path::Path) -> T) -> T {
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
}

#[cfg(test)]
mod tests {
    use super::testhome::with_home;
    use super::*;

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

    #[test]
    fn links_add_dedup_reject_and_remove() {
        with_home(|_home| {
            assert!(load_links().is_empty(), "fresh install has no links");

            let id = add_link("a", "b", "api").unwrap();
            assert_eq!(id, "a>b:api");
            add_link("a", "b", "api").unwrap(); // idempotent
            assert_eq!(load_links().len(), 1);

            add_link("a", "b", "data").unwrap(); // different kind = a distinct link
            assert_eq!(load_links().len(), 2);

            assert!(add_link("a", "a", "api").is_err(), "no self-loop");
            assert!(add_link("a", "b", "nope").is_err(), "unknown kind rejected");
            assert!(add_link("", "b", "api").is_err(), "empty endpoint rejected");

            remove_link("a>b:api").unwrap();
            let links = load_links();
            assert_eq!(links.len(), 1);
            assert_eq!(links[0].kind, "data");
            remove_link("missing").unwrap(); // no-op, not an error
            assert_eq!(load_links().len(), 1);
        });
    }

    #[test]
    fn github_state_round_trips_next_to_project_links() {
        with_home(|home| {
            assert!(load_github_state().is_none(), "fresh install has no github state");

            let body = r#"{"records":[{"id":"PVT_1","number":3,"title":"Acme CRM","shortDescription":null,"url":"https://github.com/users/u/projects/3","closed":false,"updatedAt":"2026-07-01T00:00:00Z","itemsTotalCount":4,"openCount":3,"closedCount":1,"repos":["o/r"]}],"fetchedAt":1234}"#;
            save_github_state(body).unwrap();

            // The durable copy lands next to project-links.json under the bsc base dir.
            assert!(home.join(".base-studio-code").join("github-state.json").is_file());
            let v: serde_json::Value = serde_json::from_str(&load_github_state().unwrap()).unwrap();
            assert_eq!(v["fetchedAt"], 1234);
            assert_eq!(v["records"][0]["title"], "Acme CRM");
            assert_eq!(v["records"][0]["openCount"], 3);

            // A later fetch REPLACES the state wholesale (no merging).
            save_github_state(r#"{"records":[],"fetchedAt":99}"#).unwrap();
            let v: serde_json::Value = serde_json::from_str(&load_github_state().unwrap()).unwrap();
            assert_eq!(v["fetchedAt"], 99);
            assert_eq!(v["records"].as_array().unwrap().len(), 0);
        });
    }

    #[test]
    fn github_state_rejects_garbage_and_keeps_the_last_good_state() {
        with_home(|_home| {
            save_github_state(r#"{"records":[],"fetchedAt":7}"#).unwrap();

            assert!(save_github_state("not json").is_err(), "non-JSON rejected");
            assert!(save_github_state(r#"{"records":{}}"#).is_err(), "records must be an array");
            assert!(save_github_state(r#"{"records":[]}"#).is_err(), "fetchedAt required");
            assert!(save_github_state(r#"{"records":[],"fetchedAt":"soon"}"#).is_err(), "fetchedAt must be numeric");

            // Every rejected write left the last good state untouched.
            let v: serde_json::Value = serde_json::from_str(&load_github_state().unwrap()).unwrap();
            assert_eq!(v["fetchedAt"], 7);
        });
    }
}
