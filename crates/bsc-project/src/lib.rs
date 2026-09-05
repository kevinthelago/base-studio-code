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

// ── the repo clone (#the-director-can-clone-its-projects-repos) ────────────────────────────────────
//
// Lives HERE, in the Tauri-free crate, because two callers need the identical act: the app's
// `clone_repo` command (the UI's door) and `bsc fleet clone` (the DIRECTOR's door). Before this, only
// the first existed — so a hub with no clone could not start a single worker, and the one act that
// would unblock the whole fleet was the one act a shell session could not perform.
//
// A clone needs no app: it is git plus the hub path. Keeping it out of src-tauri is what lets the CLI
// do it with the desktop closed.

/// The SHORT repo name: the segment of a GitHub `owner/name` after the last `/`.
///
/// Every on-disk path derived from a repo uses this form — the clone dir under the hub, and the
/// worktree dir name — so it is the single source of that idiom, mirrored from `platform::paths`.
pub fn repo_short(repo_full_name: &str) -> &str {
    repo_full_name.rsplit('/').next().unwrap_or(repo_full_name)
}

/// Where a repo is cloned inside its project hub: `projects/<key>/<short-repo-name>`.
pub fn repo_dir(project_key: &str, repo_full_name: &str) -> Option<PathBuf> {
    project_dir(project_key).map(|d| d.join(repo_short(repo_full_name)))
}

/// The https clone URL, with a PAT injected for a private repo (empty token → the plain public URL).
///
/// Pure so it can be unit-tested without shelling out, which is the only way to check the token is
/// placed correctly without a test that would leak one.
pub fn clone_url(repo_full_name: &str, token: &str) -> String {
    if token.is_empty() {
        format!("https://github.com/{repo_full_name}.git")
    } else {
        format!("https://{token}@github.com/{repo_full_name}.git")
    }
}

/// What `ensure_clone` / [`ensure_local_repo`] did, so a caller can report "already there" without
/// inferring it from silence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloneOutcome {
    /// The destination was already a git checkout — nothing ran.
    AlreadyPresent,
    /// `git clone` ran and succeeded.
    Cloned,
    /// There was nothing to clone FROM, so the repo was created locally — `git init` plus a root
    /// commit ([`ensure_local_repo`]). Distinct from `Cloned` because it is a different claim: this
    /// repo has no upstream and never had one, and a caller that reported it as a clone would be
    /// telling a director it could push.
    Initialized,
}

/// The identity a root commit is authored under when git has none configured.
///
/// A `git commit` on a machine with no `user.email` fails outright ("Please tell me who you are"),
/// which would turn a fresh checkout into a materialization that cannot happen. Applied ONLY when git
/// resolves no identity of its own, and ONLY to this one commit: every later commit in the repo is
/// the worker's, under whatever identity the user actually configured.
const FALLBACK_COMMIT_IDENTITY: (&str, &str) = ("base-studio-code", "fleet@base-studio-code.local");

/// Does git resolve a commit identity in `dir`? When it does not, a commit there fails.
fn has_git_identity(dir: &std::path::Path) -> bool {
    std::process::Command::new("git")
        .current_dir(dir)
        .args(["config", "--get", "user.email"])
        .output()
        .map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

/// Create `repo_name` in its project hub as a LOCAL git repo — for a project that ships nowhere.
///
/// ## Why this exists at all
/// `ensure_worktree` requires `<clone>/.git`, because every worker runs in a worktree cut from it. The
/// only verb that could produce one was `bsc fleet clone`, which reads `owner/repo` from the plan and
/// shells `git clone` at github.com (or at a `--source` checkout that must already exist). So a
/// project classified `usesGithub: false` was structurally unable to start a single repo'd worker:
/// there was nothing to clone, and no production path anywhere in the workspace ran `git init`.
///
/// MEASURED on twitter-clone-test (2026-08-30): the hub held `projects/<key>/<repo>/` with a README
/// the architect had written, no `.git`, an EMPTY `repos` table, and a fleet whose one worker could
/// never be given a worktree.
///
/// ## Why it commits rather than just initialising
/// `git init` alone leaves an UNBORN HEAD. `ensure_integration_branch` creates `develop` at HEAD and
/// `add_worktree_healing` cuts the worker's branch from it — neither can name a commit that does not
/// exist, so a bare `git init` moves the failure one step later and makes it harder to read. The root
/// commit is what makes the repo usable, so it is part of materializing it.
///
/// Content already in the directory is COMMITTED, not discarded: an architect writes a README there
/// before any fleet exists, and a root commit that ignored it would leave that file untracked forever
/// and absent from every worktree cut from the branch. The `.git/info/exclude` entries go in FIRST, so
/// the app-managed files `ensure_clone` keeps out of `git status` never enter history here either.
///
/// IDEMPOTENT on the same test `ensure_clone` uses — a destination holding `.git` is returned
/// untouched — so a caller can run it over every linked repo without first working out which are
/// missing, and a second call after a worker has committed can never rewrite its history.
pub fn ensure_local_repo(
    project_key: &str,
    repo_name: &str,
    default_branch: &str,
) -> Result<(PathBuf, CloneOutcome), String> {
    let dest = repo_dir(project_key, repo_name)
        .ok_or("no home dir ($HOME / $USERPROFILE unset), so the hub has no path")?;
    if dest.join(".git").exists() {
        return Ok((dest, CloneOutcome::AlreadyPresent));
    }
    std::fs::create_dir_all(&dest).map_err(|e| format!("cannot create {}: {e}", dest.display()))?;

    let git = |args: &[&str]| -> Result<(), String> {
        let out = std::process::Command::new("git")
            .current_dir(&dest)
            .args(args)
            .output()
            .map_err(|e| format!("cannot run git: {e}"))?;
        if out.status.success() {
            return Ok(());
        }
        Err(format!(
            "git {} failed in {}: {}",
            args.first().copied().unwrap_or(""),
            dest.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    };

    let branch = if default_branch.trim().is_empty() { "main" } else { default_branch.trim() };
    git(&["init", "-q", "-b", branch])?;

    // BEFORE the root commit, so the app-managed files never enter history — the same three
    // `ensure_clone` excludes from a cloned checkout.
    for path in ["CLAUDE.local.md", ".claude/", "DECISIONS.md"] {
        git_exclude(&dest, path);
    }

    git(&["add", "-A"])?;
    let mut commit: Vec<&str> = Vec::new();
    let (name, email) = FALLBACK_COMMIT_IDENTITY;
    let name_cfg = format!("user.name={name}");
    let email_cfg = format!("user.email={email}");
    if !has_git_identity(&dest) {
        commit.extend(["-c", &name_cfg, "-c", &email_cfg]);
    }
    // `--allow-empty` because an empty hub directory is the ordinary case: the fleet is usually
    // materialized before anything has been written into the repo at all.
    commit.extend(["commit", "-q", "--allow-empty", "-m", "chore: initialize the project repo"]);
    git(&commit)?;

    Ok((dest, CloneOutcome::Initialized))
}

/// Clone `repo_full_name` into its project hub, if it is not already there. Returns the clone path.
///
/// IDEMPOTENT by the same test the app used: a destination holding `.git` is returned untouched. That
/// is what makes it safe for a caller to run over every linked repo without first working out which
/// ones are missing.
///
/// `source` overrides where it clones FROM — a local path instead of GitHub. Not a convenience: a
/// hub sitting beside an existing checkout should not re-download hundreds of megabytes, and a clone
/// with no network is the only kind an offline or sandboxed session can make.
pub fn ensure_clone(
    project_key: &str,
    repo_full_name: &str,
    token: &str,
    source: Option<&str>,
) -> Result<(PathBuf, CloneOutcome), String> {
    let dest = repo_dir(project_key, repo_full_name)
        .ok_or("no home dir ($HOME / $USERPROFILE unset), so the hub has no path")?;
    if dest.join(".git").exists() {
        return Ok((dest, CloneOutcome::AlreadyPresent));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let url = match source {
        Some(src) => src.to_string(),
        None => clone_url(repo_full_name, token),
    };
    let out = std::process::Command::new("git")
        .args(["clone", &url, &dest.to_string_lossy()])
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        // REDACT before the message ever leaves this function — a failed private clone echoes the URL
        // it was given, and that URL carries the PAT.
        let mut err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if !token.is_empty() {
            err = err.replace(token, "***");
        }
        return Err(format!("git clone failed for {repo_full_name}: {err}"));
    }
    // Keep the app-managed files out of the clone's `git status`, exactly as the UI path did: the
    // per-repo context file, the session settings, and the fleet's assume-and-log journal.
    for path in ["CLAUDE.local.md", ".claude/", "DECISIONS.md"] {
        git_exclude(&dest, path);
    }
    Ok((dest, CloneOutcome::Cloned))
}

/// Append `entry` to a clone's `.git/info/exclude`, once. Best-effort: an exclude that could not be
/// written leaves a noisier `git status`, which is not worth failing a good clone over.
fn git_exclude(clone: &std::path::Path, entry: &str) {
    let f = clone.join(".git").join("info").join("exclude");
    if let Ok(existing) = std::fs::read_to_string(&f) {
        if existing.lines().any(|l| l.trim() == entry) {
            return;
        }
        let _ = std::fs::write(&f, format!("{existing}
{entry}
"));
        return;
    }
    if let Some(parent) = f.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&f, format!("{entry}
"));
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

/// The LEGACY, pre-#2409 project key: keep `[A-Za-z0-9-]`, map every other char to `_`, cap 80.
///
/// Not a second way to name a NEW project — [`project_slug`] is that, and it is frozen at creation.
/// This is the GRANDFATHERING rule: hubs created before #2409 are keyed this way and are deliberately
/// untouched on disk (there is no startup migration), so anything matching a persisted record against
/// a local hub has to try both derivations or it will not find them.
///
/// It must stay byte-for-byte identical to the frontend's paneId sanitization
/// (`replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 80)`) so a PTY id and its planning directory always
/// correspond. ASCII-only on purpose — Rust's `char::is_alphanumeric` accepts Unicode letters, which
/// the JS regex does not.
///
/// LIVES HERE rather than in `src-tauri` so that both key derivations are reachable from the same
/// place. `board_state` needs both and used to be pinned into the app for exactly that reason; the
/// app's `platform::fsx::sanitize_project_key` now delegates here, so there is ONE implementation.
pub fn sanitize_project_key(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .take(80)
        .collect()
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

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/store.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-project--<module>.rs
//     bsc graph impl set --id bsc-project--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-project--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-project--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));
