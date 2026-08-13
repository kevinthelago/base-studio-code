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
pub mod store;

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

/// A project's key, derived from its name (#2409) — **frozen at creation**, and the one value that
/// names the hub, its plan.db, its worktrees, its pane ids and its board project.
///
/// A byte-exact mirror of `projectSlug` in `src/shared/lib/core/projectPaths.ts`, which is how the UI
/// creates projects. `bsc project new` is a SECOND door onto the same act, so the two must agree — a
/// divergence would let one name produce two different hubs depending on who created it.
/// `projectSlug.fixtures.json` holds the shared case table and both sides' tests read it.
///
/// It is also the CONTAINMENT for the one architect verb whose argument is genuinely free text
/// (`#architect-starts-a-new-project`). The output is `[a-z0-9-]`, capped, and non-empty, so a name —
/// however it was arrived at, including from prose an architect was handed — cannot escape
/// `projects/<key>/`: `../../etc/passwd` becomes `etc-passwd`, and `..` becomes `project`.
pub fn project_slug(name: &str) -> String {
    // Runs of non-alphanumerics collapse to ONE dash, matching the JS `[^a-z0-9]+` (a `+` quantifier,
    // not a per-character replace) — otherwise "a/b c" would slug as `a-b-c` on one side and `a--b-c`
    // on the other.
    let lowered = name.to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut in_run = false;
    for ch in lowered.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    // Trim, THEN cap — the same order as the JS, quirk included: a cut that lands on a dash leaves a
    // trailing one. Reordering would be "tidier" and would produce a different key for a long name.
    let trimmed = out.trim_matches('-');
    let capped: String = trimmed.chars().take(60).collect();
    if capped.is_empty() {
        "project".to_string()
    } else {
        capped
    }
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

// ── Project relationships / inter-app contracts (#2253 → #3786 Phase 2) ─────────────────────────────
//
// A GLOBAL, cross-project link store (not scoped to one hub): `~/.base-studio-code/project-links.json`,
// a flat JSON array of contracts. `from` (a project, the consumer) depends on / consumes `to` over a
// contract of `kind` (api | data | events). #3786 Phase 2 generalizes a link's TARGET beyond another
// project: `to` can also be an external `service` or an `mcp` server, described by an optional `target`
// descriptor. The desktop Glance UI draws these; an agent reads them via `bsc project link list --json`
// to learn "what does my project consume / contract with". The id is derived so adding the same edge
// twice is idempotent.
//
// BYTE-COMPATIBLE: a legacy link written with NO `target` reads back as a project→project contract
// (`{ type: "project" }`), and a plain project contract is still SAVED without a `target` key — so the
// on-disk file for the pre-#3786 project-link case is byte-identical.

/// The contract kinds a link may carry (the Glance contract surfaces).
pub const LINK_KINDS: [&str; 3] = ["api", "data", "events"];

/// The target endpoint types a contract may point at (#3786 Phase 2): another `project` (the default,
/// byte-compatible with the pre-#3786 model), an external `service`, or an `mcp` server.
pub const TARGET_TYPES: [&str; 3] = ["project", "service", "mcp"];

/// The endpoint a contract points at (#3786 Phase 2). `kind` is one of {@link TARGET_TYPES}; `name`,
/// `url`, and `app_type` are optional descriptors for a non-project endpoint. A `project` target with
/// no descriptors is the DEFAULT — it is not serialized (keeping legacy links byte-identical).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractTarget {
    /// "project" (default) | "service" | "mcp".
    pub kind: String,
    /// Display name of an external endpoint (a service / mcp server).
    pub name: Option<String>,
    /// The endpoint URL, when known (an http service / mcp server).
    pub url: Option<String>,
    /// The endpoint's application-architecture discriminator (api | serverless | …), surfaced on the
    /// Glance contract node — the same `AppType` vocabulary the frontend classifies a project by.
    pub app_type: Option<String>,
}

impl Default for ContractTarget {
    /// The default target is a bare `project` endpoint — what a pre-#3786 link (no `target`) reads as.
    fn default() -> Self {
        Self { kind: "project".into(), name: None, url: None, app_type: None }
    }
}

impl ContractTarget {
    /// True when this target is anything other than a bare project endpoint — i.e. it carries real
    /// contract detail worth serializing. A trivial project target is omitted on save (byte-compat).
    fn is_nontrivial(&self) -> bool {
        self.kind != "project" || self.name.is_some() || self.url.is_some() || self.app_type.is_some()
    }
}

/// One inter-app contract: `from` (a project) consumes `to` over `kind`, where `to` is an endpoint of
/// `target.kind` (another project, an external service, or an mcp server).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectLink {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    /// The target endpoint (#3786). A legacy link with no `target` deserializes to the default
    /// (`project`), so this is never absent in memory.
    pub target: ContractTarget,
}

/// The global links file: `~/.base-studio-code/project-links.json`. `None` when no home dir resolves.
pub fn links_path() -> Option<PathBuf> {
    bsc_util::bsc_base_dir().map(|b| b.join("project-links.json"))
}

/// Deterministic id for a link, so adding the same edge twice is idempotent (matches the frontend).
/// The id is target-agnostic (`<from>><to>:<kind>`) — the same shape whatever the target endpoint is.
pub fn link_id(from: &str, to: &str, kind: &str) -> String {
    format!("{from}>{to}:{kind}")
}

/// Parse a `target` value into a {@link ContractTarget}. A missing/non-object value (or a legacy link
/// with no `target`) yields the default `project` endpoint; `type` defaults to `"project"`.
fn target_from_json(v: &serde_json::Value) -> ContractTarget {
    let Some(obj) = v.as_object() else { return ContractTarget::default() };
    ContractTarget {
        kind: obj.get("type").and_then(|t| t.as_str()).unwrap_or("project").to_string(),
        name: obj.get("name").and_then(|s| s.as_str()).map(str::to_string),
        url: obj.get("url").and_then(|s| s.as_str()).map(str::to_string),
        app_type: obj.get("appType").and_then(|s| s.as_str()).map(str::to_string),
    }
}

/// Serialize a target descriptor for the `list --json` / on-disk form. `type` is always present; the
/// optional descriptors are omitted when absent.
fn target_to_json(t: &ContractTarget) -> serde_json::Value {
    let mut o = serde_json::json!({ "type": t.kind });
    if let Some(n) = &t.name { o["name"] = serde_json::json!(n); }
    if let Some(u) = &t.url { o["url"] = serde_json::json!(u); }
    if let Some(a) = &t.app_type { o["appType"] = serde_json::json!(a); }
    o
}

fn link_from_json(v: &serde_json::Value) -> Option<ProjectLink> {
    Some(ProjectLink {
        id: v.get("id")?.as_str()?.to_string(),
        from: v.get("from")?.as_str()?.to_string(),
        to: v.get("to")?.as_str()?.to_string(),
        kind: v.get("kind")?.as_str()?.to_string(),
        // A legacy link (no `target`) reads as the default project endpoint (byte-compatible).
        target: v.get("target").map(target_from_json).unwrap_or_default(),
    })
}

fn link_to_json(l: &ProjectLink) -> serde_json::Value {
    let mut o = serde_json::json!({ "id": l.id, "from": l.from, "to": l.to, "kind": l.kind });
    // A trivial project target is NOT written, so a plain project→project link stays byte-identical to
    // the pre-#3786 on-disk form.
    if l.target.is_nontrivial() {
        o["target"] = target_to_json(&l.target);
    }
    o
}

/// One contract as a CALLER-facing row (`link list --json`, and what `link set` prints).
///
/// Deliberately NOT [`link_to_json`]: the target is ALWAYS present here (a legacy link reads back as
/// `{ "type": "project" }`), whereas the on-disk form omits a trivial one to stay byte-identical to the
/// pre-#3786 file. The two shapes serve different readers, so they are two functions rather than one
/// with a flag — and sharing this one between `list` and `set` is what stops the row a modify prints
/// from drifting from the row a list shows.
pub fn link_row_json(l: &ProjectLink) -> serde_json::Value {
    serde_json::json!({ "id": l.id, "from": l.from, "to": l.to, "kind": l.kind, "target": target_to_json(&l.target) })
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

/// Add a project→project link (idempotent by id) — the pre-#3786 form, a bare project target. Rejects
/// an empty endpoint, a self-loop, or an unknown kind. Returns the link id. Thin wrapper over
/// [`add_contract`] with the default (`project`) target.
pub fn add_link(from: &str, to: &str, kind: &str) -> Result<String, String> {
    add_contract(from, to, kind, ContractTarget::default())
}

/// Add a contract (#3786, idempotent by id). `target` names the endpoint `to` points at (another
/// project, an external service, or an mcp server). Rejects an empty endpoint, an unknown kind, an
/// unknown target type, or — for a PROJECT target only — a self-loop (a service/mcp endpoint shares no
/// namespace with the project key, so `from == to` there is legitimate). Returns the link id.
pub fn add_contract(from: &str, to: &str, kind: &str, target: ContractTarget) -> Result<String, String> {
    let (from, to, kind) = (from.trim(), to.trim(), kind.trim());
    if from.is_empty() || to.is_empty() {
        return Err("add_contract: empty from/to".into());
    }
    if !LINK_KINDS.contains(&kind) {
        return Err(format!("add_contract: unknown kind '{kind}' (want one of {LINK_KINDS:?})"));
    }
    let target_kind = target.kind.trim();
    if !TARGET_TYPES.contains(&target_kind) {
        return Err(format!("add_contract: unknown target type '{target_kind}' (want one of {TARGET_TYPES:?})"));
    }
    // A self-loop is only meaningless for a project target (a project can't depend on itself); a
    // service/mcp endpoint lives in its own namespace, so `from == to` there is a legitimate contract.
    if target_kind == "project" && from == to {
        return Err("add_contract: a project can't link to itself".into());
    }
    let id = link_id(from, to, kind);
    let mut links = load_links();
    if !links.iter().any(|l| l.id == id) {
        links.push(ProjectLink { id: id.clone(), from: from.into(), to: to.into(), kind: kind.into(), target });
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

/// A patch over the MUTABLE fields of an existing contract (#architect-wires-project-relationships).
///
/// Every field is an `Option<String>` because each carries THREE states, not two: `None` leaves the
/// field alone, `Some("")` CLEARS an optional descriptor, and `Some(v)` sets it. Without the clear
/// state a descriptor could be set and never unset, and the only route back would be deleting the
/// contract and re-adding it — which discards a relationship in order to edit a label on it.
#[derive(Debug, Clone, Default)]
pub struct ContractPatch {
    /// The contract kind (api | data | events). Changing it RE-KEYS the link, because the id is
    /// derived from it — see [`update_contract`]. Clearing is meaningless (a contract always has a
    /// kind), so an empty value is rejected rather than treated as a clear.
    pub kind: Option<String>,
    /// The endpoint type (project | service | mcp). Same: a target always has one.
    pub target_type: Option<String>,
    /// Display name of the endpoint — clearable.
    pub name: Option<String>,
    /// Endpoint URL — clearable.
    pub url: Option<String>,
    /// Endpoint app type — clearable.
    pub app_type: Option<String>,
}

/// Apply one descriptor patch: `None` keeps `cur`, an empty value CLEARS, anything else sets (trimmed).
fn patch_field(cur: &Option<String>, patch: &Option<String>) -> Option<String> {
    match patch {
        None => cur.clone(),
        Some(v) if v.trim().is_empty() => None,
        Some(v) => Some(v.trim().to_string()),
    }
}

/// Modify an EXISTING contract in place — the one thing [`add_contract`] cannot do
/// (#architect-wires-project-relationships).
///
/// `add` is idempotent BY ID, and the id is `<from>><to>:<kind>`. So re-adding a contract that already
/// exists silently discards the endpoint descriptor passed the second time, which left a contract's
/// target unchangeable once written: there was no verb anywhere that could alter one.
///
/// AN UNKNOWN ID IS AN ERROR, NEVER A CREATE. Modifying and creating are different acts, and a caller
/// that mistypes an id meant the first. Quietly doing the second would leave the contract it meant to
/// change untouched while inventing a second one beside it — the failure would surface later, as a
/// duplicate nobody drew.
///
/// CHANGING `kind` RE-KEYS the link, since the id derives from it, and the re-key is REFUSED when the
/// destination id already exists rather than overwriting it. Two contracts collapsing into one is a
/// deletion the caller did not ask for, so it is named and refused instead.
///
/// Returns the stored link — with its NEW id when the kind changed, which is why the caller is handed
/// the record rather than a bool.
pub fn update_contract(id: &str, patch: &ContractPatch) -> Result<ProjectLink, String> {
    let mut links = load_links();
    let idx = links.iter().position(|l| l.id == id).ok_or_else(|| {
        format!("update_contract: no contract '{id}' (list them with `bsc project link list`)")
    })?;
    let cur = links[idx].clone();

    let kind = match patch.kind.as_deref().map(str::trim) {
        Some("") => return Err("update_contract: --kind needs a value (a contract always has a kind)".into()),
        Some(k) => k.to_string(),
        None => cur.kind.clone(),
    };
    if !LINK_KINDS.contains(&kind.as_str()) {
        return Err(format!("update_contract: unknown kind '{kind}' (want one of {LINK_KINDS:?})"));
    }
    let target_kind = match patch.target_type.as_deref().map(str::trim) {
        Some("") => return Err("update_contract: --target-type needs a value (a target always has one)".into()),
        Some(t) => t.to_string(),
        None => cur.target.kind.clone(),
    };
    if !TARGET_TYPES.contains(&target_kind.as_str()) {
        return Err(format!("update_contract: unknown target type '{target_kind}' (want one of {TARGET_TYPES:?})"));
    }
    // The same self-loop rule `add_contract` enforces, re-checked because a PATCH can reach it: an
    // external endpoint may legitimately share the consumer's name, so flipping such a link back to
    // `project` would otherwise store a project depending on itself through the side door.
    if target_kind == "project" && cur.from == cur.to {
        return Err("update_contract: a project can't link to itself".into());
    }

    let new_id = link_id(&cur.from, &cur.to, &kind);
    if new_id != cur.id && links.iter().any(|l| l.id == new_id) {
        return Err(format!(
            "update_contract: changing kind to '{kind}' would collide with the existing contract \
             '{new_id}'. Remove one of them first — merging two contracts into one would drop a \
             relationship nobody asked to drop."
        ));
    }

    let updated = ProjectLink {
        id: new_id,
        from: cur.from,
        to: cur.to,
        kind,
        target: ContractTarget {
            kind: target_kind,
            name: patch_field(&cur.target.name, &patch.name),
            url: patch_field(&cur.target.url, &patch.url),
            app_type: patch_field(&cur.target.app_type, &patch.app_type),
        },
    };
    links[idx] = updated.clone();
    save_links(&links)?;
    Ok(updated)
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

    /// MODIFY (#architect-wires-project-relationships) — the gap `add` leaves. These pin the three
    /// things a caller can get wrong and the one thing `add` silently did instead.
    #[test]
    fn update_patches_only_the_fields_it_is_given() {
        with_home(|_home| {
            add_contract(
                "app",
                "stripe",
                "api",
                ContractTarget { kind: "service".into(), name: Some("Stripe".into()), url: Some("https://api.stripe.com".into()), app_type: None },
            )
            .unwrap();

            // The bug this verb exists for: a second `add` with different flags changes NOTHING,
            // because `add` is idempotent by id.
            add_contract("app", "stripe", "api", ContractTarget { kind: "service".into(), url: Some("https://v2".into()), ..Default::default() }).unwrap();
            assert_eq!(load_links()[0].target.url.as_deref(), Some("https://api.stripe.com"), "add is a no-op on an existing id");

            // `set` patches exactly what it is handed and leaves the rest alone.
            let out = update_contract("app>stripe:api", &ContractPatch { url: Some("https://api.stripe.com/v2".into()), ..Default::default() }).unwrap();
            assert_eq!(out.target.url.as_deref(), Some("https://api.stripe.com/v2"));
            assert_eq!(out.target.name.as_deref(), Some("Stripe"), "an absent flag leaves the field alone");
            assert_eq!(out.id, "app>stripe:api", "no kind change ⇒ no re-key");
            assert_eq!(load_links().len(), 1, "a modify never adds a row");

            // An EMPTY value clears a descriptor — without this a name could be set and never unset.
            let cleared = update_contract("app>stripe:api", &ContractPatch { name: Some("  ".into()), ..Default::default() }).unwrap();
            assert!(cleared.target.name.is_none());
            assert_eq!(cleared.target.url.as_deref(), Some("https://api.stripe.com/v2"), "clearing one field leaves the others");
        });
    }

    #[test]
    fn update_rekeys_on_a_kind_change_and_refuses_to_merge_two_contracts() {
        with_home(|_home| {
            add_link("app", "billing", "api").unwrap();

            // The id derives from the kind, so changing it MOVES the contract to a new id.
            let out = update_contract("app>billing:api", &ContractPatch { kind: Some("events".into()), ..Default::default() }).unwrap();
            assert_eq!(out.id, "app>billing:events");
            assert_eq!(out.kind, "events");
            let links = load_links();
            assert_eq!(links.len(), 1, "a re-key MOVES the contract, it does not duplicate it");
            assert_eq!(links[0].id, "app>billing:events");
            assert!(update_contract("app>billing:api", &ContractPatch::default()).is_err(), "the old id is gone");

            // A re-key onto an occupied id must be refused, not merged: merging is a deletion the
            // caller did not ask for.
            add_link("app", "billing", "data").unwrap();
            let err = update_contract("app>billing:data", &ContractPatch { kind: Some("events".into()), ..Default::default() }).unwrap_err();
            assert!(err.contains("app>billing:events"), "the refusal names what is already there: {err}");
            assert_eq!(load_links().len(), 2, "a refused re-key writes nothing");
        });
    }

    #[test]
    fn update_refuses_an_unknown_id_rather_than_creating_one() {
        with_home(|_home| {
            // Modifying and creating are different acts; a mistyped id meant the first one.
            let err = update_contract("ghost>nobody:api", &ContractPatch { url: Some("x".into()), ..Default::default() }).unwrap_err();
            assert!(err.contains("ghost>nobody:api"), "{err}");
            assert!(load_links().is_empty(), "a refused modify creates nothing");
        });
    }

    #[test]
    fn update_validates_the_two_closed_enums_and_the_self_loop_rule() {
        with_home(|_home| {
            add_contract("app", "app", "api", ContractTarget { kind: "service".into(), ..Default::default() }).unwrap();

            assert!(update_contract("app>app:api", &ContractPatch { kind: Some("nope".into()), ..Default::default() }).is_err());
            assert!(update_contract("app>app:api", &ContractPatch { target_type: Some("widget".into()), ..Default::default() }).is_err());
            // Neither enum is clearable — a contract always has a kind and a target always has a type.
            assert!(update_contract("app>app:api", &ContractPatch { kind: Some("".into()), ..Default::default() }).is_err());
            assert!(update_contract("app>app:api", &ContractPatch { target_type: Some("".into()), ..Default::default() }).is_err());
            // `from == to` is legitimate for a service endpoint (own namespace) but NOT for a project
            // one — so the patch that would flip it back is the side door `add_contract` closes.
            let err = update_contract("app>app:api", &ContractPatch { target_type: Some("project".into()), ..Default::default() }).unwrap_err();
            assert!(err.contains("itself"), "{err}");
            assert_eq!(load_links()[0].target.kind, "service", "every refusal left the record untouched");
        });
    }

    #[test]
    fn a_modify_that_leaves_a_bare_project_target_writes_no_target_key() {
        with_home(|_home| {
            // BYTE-COMPAT (#3786) survives the new verb: a contract patched back down to a plain
            // project endpoint must serialize exactly like one that was never external.
            add_contract("app", "billing", "api", ContractTarget { kind: "service".into(), name: Some("Billing".into()), ..Default::default() }).unwrap();
            update_contract("app>billing:api", &ContractPatch { target_type: Some("project".into()), name: Some("".into()), ..Default::default() }).unwrap();

            let raw = std::fs::read_to_string(links_path().unwrap()).unwrap();
            let arr: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
            assert!(arr[0].get("target").is_none(), "a trivial project target is not serialized: {raw}");
            // …and it still reads back as the default project endpoint.
            assert_eq!(load_links()[0].target, ContractTarget::default());
        });
    }

    #[test]
    fn contract_targets_round_trip_and_legacy_links_still_parse() {
        with_home(|_home| {
            // A plain project→project link (the pre-#3786 form) via add_link.
            add_link("app", "billing", "api").unwrap();
            // A SERVICE-targeted contract: `to` is the endpoint name, carrying a url + app_type.
            add_contract(
                "app",
                "stripe",
                "api",
                ContractTarget {
                    kind: "service".into(),
                    name: Some("Stripe".into()),
                    url: Some("https://api.stripe.com".into()),
                    app_type: Some("api".into()),
                },
            )
            .unwrap();
            // An MCP-targeted contract (no descriptors beyond the type + app_type).
            add_contract(
                "app",
                "postgres",
                "data",
                ContractTarget { kind: "mcp".into(), name: None, url: None, app_type: Some("serverless".into()) },
            )
            .unwrap();

            let links = load_links();
            assert_eq!(links.len(), 3);
            let by_id = |id: &str| links.iter().find(|l| l.id == id).unwrap().clone();

            // The project link reads back as the DEFAULT project target.
            let proj = by_id("app>billing:api");
            assert_eq!(proj.target, ContractTarget::default());
            assert_eq!(proj.target.kind, "project");

            // The service contract round-trips its whole descriptor.
            let svc = by_id("app>stripe:api");
            assert_eq!(svc.target.kind, "service");
            assert_eq!(svc.target.name.as_deref(), Some("Stripe"));
            assert_eq!(svc.target.url.as_deref(), Some("https://api.stripe.com"));
            assert_eq!(svc.target.app_type.as_deref(), Some("api"));

            // The mcp contract round-trips its type + app_type; a service/mcp self-namespace `to` is fine.
            let mcp = by_id("app>postgres:data");
            assert_eq!(mcp.target.kind, "mcp");
            assert_eq!(mcp.target.app_type.as_deref(), Some("serverless"));

            // BYTE-COMPAT: the project link is serialized with NO `target` key, while the external
            // contracts DO carry one — so the pre-#3786 on-disk form is unchanged for project links.
            let raw = std::fs::read_to_string(links_path().unwrap()).unwrap();
            let arr: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
            let obj = |id: &str| arr.iter().find(|v| v["id"] == id).unwrap();
            assert!(obj("app>billing:api").get("target").is_none(), "a plain project link writes no target");
            assert_eq!(obj("app>stripe:api")["target"]["type"], "service");
            assert_eq!(obj("app>postgres:data")["target"]["type"], "mcp");

            // A hand-written LEGACY array (no `target` anywhere) still parses — every entry a project.
            std::fs::write(
                links_path().unwrap(),
                r#"[{"id":"x>y:api","from":"x","to":"y","kind":"api"},{"id":"x>z:events","from":"x","to":"z","kind":"events"}]"#,
            )
            .unwrap();
            let legacy = load_links();
            assert_eq!(legacy.len(), 2);
            assert!(legacy.iter().all(|l| l.target == ContractTarget::default()));

            // An unknown target type is rejected.
            assert!(add_contract("a", "b", "api", ContractTarget { kind: "widget".into(), ..Default::default() }).is_err());
            // A service target `from == to` is allowed (own namespace) but a project self-loop is not.
            assert!(add_contract("dup", "dup", "api", ContractTarget { kind: "service".into(), ..Default::default() }).is_ok());
            assert!(add_link("solo", "solo", "api").is_err());
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

#[cfg(test)]
mod slug_tests {
    use super::*;

    /// The shared case table — the SAME file `projectPaths.test.ts` reads.
    ///
    /// Two implementations of one rule is a real risk, not a theoretical one: the slug is a project's
    /// FROZEN identity, so if `bsc project new` and the UI disagreed about one name, the two doors
    /// would create two different hubs for it and the second would look like a project that had lost
    /// its plan. A shared fixture is the only version of this test that can actually fail on drift —
    /// a hand-copied table in each language drifts silently the moment one is edited.
    fn cases() -> Vec<(String, String)> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/shared/lib/core/projectSlug.fixtures.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
        let v: serde_json::Value = serde_json::from_str(&text).expect("fixture is valid JSON");
        let arr = v["cases"].as_array().expect("fixture has a `cases` array").clone();
        assert!(!arr.is_empty(), "an empty case table would make this test vacuous");
        arr.iter()
            .map(|c| {
                (
                    c["name"].as_str().expect("case.name").to_string(),
                    c["slug"].as_str().expect("case.slug").to_string(),
                )
            })
            .collect()
    }

    #[test]
    fn project_slug_matches_the_shared_case_table() {
        for (name, want) in cases() {
            assert_eq!(project_slug(&name), want, "projectSlug({name:?})");
        }
    }

    /// The containment property, asserted over EVERY case rather than only the traversal ones: no
    /// input may produce a key that is empty, absolute, or able to climb out of `projects/`. This is
    /// what makes a free-text argument safe to hand a session that reads untrusted prose.
    #[test]
    fn no_name_can_escape_the_projects_directory() {
        for (name, _) in cases() {
            let key = project_slug(&name);
            assert!(!key.is_empty(), "{name:?} produced an empty key");
            assert!(
                key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{name:?} produced {key:?}, which is not [a-z0-9-]"
            );
            assert!(!key.contains(".."), "{name:?} produced a traversal: {key:?}");
            assert!(key.len() <= 60, "{name:?} produced an over-long key");
            // The decisive check: joining it onto the root cannot leave the root.
            let root = std::path::Path::new("/projects");
            let joined = root.join(&key);
            assert!(joined.starts_with(root), "{name:?} escaped: {}", joined.display());
        }
    }

    /// Adversarial inputs beyond the fixture — the fixture documents the CONTRACT, this sweeps for a
    /// hole in it. Every one of these is a plausible thing to find inside prose handed to an
    /// architect.
    #[test]
    fn hostile_names_still_land_inside_the_root() {
        for name in [
            "../../../../etc/shadow",
            "....//....//x",
            "/absolute/path",
            r"\\server\share",
            "con", // a reserved Windows device name — still just a directory name here
            "a".repeat(5000).as_str(),
            "%2e%2e%2f",
            "\u{202e}reversed",
            "; rm -rf /",
            "name\nwith\nnewlines",
        ] {
            let key = project_slug(name);
            assert!(!key.is_empty());
            assert!(key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'), "{name:?} -> {key:?}");
            assert!(key.len() <= 60);
        }
    }
}
