use std::collections::HashMap;
use tauri::{Manager, RunEvent};

mod tunnel;
mod fcm;
mod perf;
mod logs;
mod docstore;
mod plan_db;
mod tokens;
mod githooks;
mod oauth;
mod config;
mod github;
mod shell;
mod pty;
mod pty_ledger;
mod session_discovery;
mod bsc;
mod planner;
mod data;
mod credentials;
mod source_oauth;
mod harness;

// ── Logging / performance ────────────────────────────────────────────────────

/// ANSI color for a log level, used by the custom log format. Pure.
fn level_color(level: log::Level) -> &'static str {
    match level {
        log::Level::Error => "\x1b[31m", // red
        log::Level::Warn  => "\x1b[33m", // yellow
        log::Level::Info  => "\x1b[32m", // green
        log::Level::Debug => "\x1b[36m", // cyan
        log::Level::Trace => "\x1b[90m", // bright black
    }
}

/// RAII timer: logs how long a scope took when it drops, but only if the elapsed
/// time crosses `threshold_ms` — so it surfaces slow operations without noise.
/// Lives across `.await` points, so wrapping an async command times the whole call.
pub(crate) struct PerfSpan {
    label: &'static str,
    start: std::time::Instant,
    threshold_ms: u128,
}

impl PerfSpan {
    fn new(label: &'static str) -> Self {
        Self { label, start: std::time::Instant::now(), threshold_ms: 50 }
    }
}

impl Drop for PerfSpan {
    fn drop(&mut self) {
        let ms = self.start.elapsed().as_millis();
        if ms >= self.threshold_ms {
            log::info!("perf · {} took {}ms", self.label, ms);
        }
    }
}

// ── PTY commands ─────────────────────────────────────────────────────────────

/// Splits `bytes` at the last complete UTF-8 character boundary.
/// Returns `(valid_string, leftover_bytes)` where `leftover_bytes` is any
/// trailing incomplete multi-byte sequence to prepend to the next read.
pub(crate) fn split_utf8_at_boundary(bytes: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            if e.error_len().is_none() {
                // Incomplete sequence at end of buffer — hold the trailing
                // bytes for the next read rather than replacing with U+FFFD.
                let text = unsafe { std::str::from_utf8_unchecked(&bytes[..valid_up_to]) }.to_string();
                (text, bytes[valid_up_to..].to_vec())
            } else {
                // Genuinely invalid bytes mid-stream — keep going with lossy.
                (String::from_utf8_lossy(bytes).into_owned(), Vec::new())
            }
        }
    }
}

/// Converts a native OS path to a bash-compatible POSIX path.
/// On Windows (Git Bash): `C:\Users\foo` → `/c/Users/foo`.
/// On Unix: returns the path unchanged.
pub(crate) fn to_bash_path(p: &str) -> String {
    #[cfg(windows)]
    {
        let s = p.replace('\\', "/");
        if s.len() >= 2 && s.as_bytes()[1] == b':' {
            let drive = s[..1].to_lowercase();
            return format!("/{}{}", drive, &s[2..]);
        }
        s
    }
    #[cfg(not(windows))]
    p.to_string()
}

/// Inverse of [`to_bash_path`]: a git-bash drive path (`/c/Users/...`, as reported by a
/// bash shell's OSC-7 cwd and then persisted) back to a native `C:/Users/...` path, so
/// Windows fs/process APIs (`Path::is_dir`, `Command::cwd`) can resolve it. Without this a
/// restored pane whose worktree/dir genuinely EXISTS reads as "missing" and fails to launch
/// (#979). Already-native and non-drive paths pass through unchanged; no-op off Windows.
pub(crate) fn to_native_path(p: &str) -> String {
    #[cfg(windows)]
    {
        let b = p.as_bytes();
        if b.len() >= 3 && b[0] == b'/' && b[2] == b'/' && (b[1] as char).is_ascii_alphabetic() {
            let drive = (b[1] as char).to_ascii_uppercase();
            return format!("{drive}:/{}", &p[3..]);
        }
        p.to_string()
    }
    #[cfg(not(windows))]
    p.to_string()
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

/// Root of the flat, reusable document library: `~/.base-studio-code/documents`.
/// Holds standalone markdown blocks (`*.md`) plus the library's own `CLAUDE.md`
/// and `.claude/settings.json`. These are reusable across every project — they
/// are referenced from a project's `kb_index.md` via a relative path.
pub(crate) fn documents_dir() -> std::path::PathBuf {
    bsc_base_dir().join("documents")
}

/// The project hub directory and the planner session's CWD: `~/.base-studio-code/projects/<key>`.
/// Holds the project's `CLAUDE.md` (ancestor-loaded context for repo sessions), plan sections
/// (`goal.md`…), control files, `prompts/`, and the cloned repos as subdirectories.
///
/// ONE location for the life of the project — published or draft (#922). The hub NEVER moves, so
/// the planner's cwd (and Claude's cwd-keyed `--continue` history) stays stable. Published-ness is
/// an in-place marker file (`.published`), NOT the directory's location — see [`is_published`] /
/// [`mark_published`]. This replaces the #904 draft/ vs projects/ split, whose publish-time rename
/// fought the Windows cwd lock (a live process can't have its cwd renamed), orphaned Claude history,
/// and wedged into a permanent split-brain when the rename half-failed.
pub(crate) fn project_dir(project_key: &str) -> std::path::PathBuf {
    bsc_base_dir().join("projects").join(sanitize_project_key(project_key))
}

/// The published-marker file inside a project hub (#922): `projects/<key>/.published`. Its presence
/// means the project has been published to GitHub; absence = draft. The source of published-ness,
/// replacing directory location.
fn published_marker(project_key: &str) -> std::path::PathBuf {
    project_dir(project_key).join(".published")
}

/// Whether a project hub carries the published marker (#922).
fn is_published(project_key: &str) -> bool {
    published_marker(project_key).is_file()
}

/// The legacy unpublished-hub location from the #904 split: `~/.base-studio-code/draft/<key>`.
/// Retained ONLY for the one-time migration that consolidates these back under `projects/` (#922)
/// and for defensive cleanup in `delete_project_dir`.
fn legacy_draft_dir(project_key: &str) -> std::path::PathBuf {
    bsc_base_dir().join("draft").join(sanitize_project_key(project_key))
}

/// Mark a project published (#922): write `projects/<key>/.published`. Unlike the old promote-rename,
/// this is a file-create INSIDE the hub — allowed even while the planner holds the hub as its cwd,
/// instant, and the cwd never changes so Claude's `--continue` history survives. Idempotent.
#[tauri::command]
fn mark_published(project_key: String) -> Result<(), String> {
    if sanitize_project_key(&project_key).is_empty() {
        return Err("mark_published: empty project_key".into());
    }
    let dir = project_dir(&project_key);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mark_published: {e}"))?;
    std::fs::write(published_marker(&project_key), b"published\n")
        .map_err(|e| format!("mark_published: {e}"))?;
    log::info!("marked project published: {:?}", dir);
    Ok(())
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
/// Plan sections sit alongside the control files (CLAUDE.md, kb_index.md, …) in
/// the planner's CWD.
fn plan_dir_for(project_key: &str) -> std::path::PathBuf {
    project_dir(project_key)
}

/// The Context-stage discovery sections live in their own subdir of the hub (#807):
/// `projects/<sanitized-key>/context/`. Keeps the discovery topics easy to find (and the
/// hub uncluttered) for larger / off-script plans. Created only when the blueprint has a
/// context stage; read alongside the flat root so pre-existing projects still resolve.
pub(crate) fn context_dir_for(project_key: &str) -> std::path::PathBuf {
    project_dir(project_key).join("context")
}

/// Ingest every non-empty `.md`/`.json` section file in `dir` (top level only), keyed by
/// file stem, into `sections` — skipping the workspace control files. Used to read the hub
/// root + the `context/` subdir; a later call overrides earlier keys (context/ wins, #807).
fn ingest_section_files(dir: &std::path::Path, sections: &mut std::collections::HashMap<String, String>) {
    const CONTROL: &[&str] = &["CLAUDE.md", "kb_index.md", "automations.md", "extensions.md", "github_context.md"];
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() { continue; }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if CONTROL.contains(&name) { continue; }
        if !matches!(path.extension().and_then(|e| e.to_str()), Some("md") | Some("json")) { continue; }
        if let (Some(stem), Ok(content)) =
            (path.file_stem().and_then(|s| s.to_str()), std::fs::read_to_string(&path))
        {
            let content = content.trim().to_string();
            if !content.is_empty() {
                sections.insert(stem.to_string(), content);
            }
        }
    }
}

/// Delete a project's on-disk hub (`projects/<sanitized-key>`) and everything in
/// it — plan sections, prompts, cloned repos. Best-effort: a missing dir is fine.
/// Refuses an empty key so it can never wipe the `projects/` root.
#[tauri::command]
fn delete_project_dir(project_key: String) -> Result<(), String> {
    if sanitize_project_key(&project_key).is_empty() {
        return Err("delete_project_dir: empty project_key".to_string());
    }
    // The hub lives under projects/<key> (#922). Also remove any legacy draft/<key> copy left by a
    // pre-migration build so a stale half-moved hub can't linger and reappear in the list.
    for dir in [project_dir(&project_key), legacy_draft_dir(&project_key)] {
        if !dir.exists() { continue; }
        // Clear read-only first: on Windows `remove_dir_all` can't delete read-only files, and
        // git pack files in a cloned-repo subdir are read-only — so a project with a linked repo
        // would otherwise fail to delete (#793). Unix's `remove_dir_all` ignores file perms, so
        // this is Windows-only.
        #[cfg(windows)]
        clear_readonly_recursive(&dir);
        std::fs::remove_dir_all(&dir).map_err(|e| format!("delete_project_dir: {e}"))?;
        log::info!("deleted project hub {:?}", dir);
    }
    // The fleet's worktrees now live outside the hub (see `worktrees_dir`, #844), so the
    // hub delete above no longer reaches them — remove them explicitly. Best-effort: a
    // missing dir is fine, and an orphaned worktree dir must not block deleting the hub.
    let wts = worktrees_dir(&project_key);
    if wts.exists() {
        #[cfg(windows)]
        clear_readonly_recursive(&wts);
        if let Err(e) = std::fs::remove_dir_all(&wts) {
            log::warn!("delete_project_dir: leftover worktrees {:?}: {e}", wts);
        }
    }
    Ok(())
}

/// Recursively clear the read-only attribute on every file under `dir`. Best-effort:
/// unreadable entries are skipped. Needed so `remove_dir_all` can delete cloned-repo dirs
/// (git's pack files are read-only) on Windows. Windows-only: on Unix `remove_dir_all`
/// deletes regardless of file perms, and `set_readonly(false)` would loosen the mode there.
#[cfg(windows)]
#[allow(clippy::permissions_set_readonly_false)] // clearing the RO attribute IS the intent on Windows
fn clear_readonly_recursive(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => clear_readonly_recursive(&path),
            Ok(_) => {
                if let Ok(meta) = entry.metadata() {
                    let mut perms = meta.permissions();
                    if perms.readonly() {
                        perms.set_readonly(false);
                        let _ = std::fs::set_permissions(&path, perms);
                    }
                }
            }
            Err(_) => {}
        }
    }
}

/// Clear every project's plan files for a from-scratch dev reset, WITHOUT touching
/// the cloned repos. Deletes only the top-level `.md` / `.json` plan files in each
/// `projects/<key>/` dir (goal.md, issues.json, phases.json, fleet.json, the
/// context docs, …) and leaves all SUBDIRECTORIES — the cloned repos and
/// `prompts/` — intact. Best-effort; returns how many files were
/// removed. Without this, the planning poll re-reads the files and a store-only
/// clear is undone within a tick.
#[tauri::command]
fn clear_all_plan_files() -> Result<u32, String> {
    let projects = bsc_base_dir().join("projects");
    if !projects.exists() {
        return Ok(0);
    }
    let mut removed = 0u32;
    let entries = std::fs::read_dir(&projects).map_err(|e| format!("clear_all_plan_files: {e}"))?;
    for entry in entries.flatten() {
        let proj = entry.path();
        if !proj.is_dir() {
            continue;
        }
        let items = match std::fs::read_dir(&proj) {
            Ok(i) => i,
            Err(_) => continue,
        };
        for item in items.flatten() {
            let p = item.path();
            // Preserve every subdirectory (cloned repos, prompts, .claude).
            if !p.is_file() {
                continue;
            }
            let is_plan = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("json"))
                .unwrap_or(false);
            if is_plan && std::fs::remove_file(&p).is_ok() {
                removed += 1;
            }
        }
    }
    log::info!("clear_all_plan_files: removed {removed} plan files");
    Ok(removed)
}

// camelCase so the JSON the frontend receives is `hasPlan`/`updatedAt` — Tauri does NOT
// rename return-value fields (only command arguments), so without this the frontend's
// `lp.hasPlan` is undefined and every local project is skipped (#789).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalProject {
    key: String,
    title: String,
    has_plan: bool,
    updated_at: u64,
    /// True when the hub lives under `projects/` (published), false under `draft/` (#904).
    published: bool,
}

/// List the on-disk local projects (the `projects/<key>/` dirs) so the Projects page can surface
/// unpublished local work, not just GitHub boards + the store's draft map (#…). The on-disk hub is
/// the durable source of truth; the store had drifted out of sync, hiding real projects. `title`
/// is the first non-empty line of `goal.md` (heading markers stripped, first sentence, capped),
/// else the humanized key. `has_plan` marks a real project (any of goal/scope/CLAUDE.md present)
/// vs. a bare scaffold. `updated_at` is the dir mtime in ms since the epoch (for recency sorting).
#[tauri::command]
fn list_local_projects() -> Result<Vec<LocalProject>, String> {
    // Single root since #922: every hub lives under projects/<key>; `published` is the in-place
    // `.published` marker, not the directory's location.
    let root = bsc_base_dir().join("projects");
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else { return Ok(out) };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() { continue; }
        let key = match dir.file_name().and_then(|n| n.to_str()) {
            Some(k) if !k.starts_with('.') => k.to_string(),
            _ => continue,
        };
        let goal = dir.join("goal.md");
        let has_plan = goal.exists() || dir.join("scope.md").exists() || dir.join("CLAUDE.md").exists();
        let title = std::fs::read_to_string(&goal)
            .ok()
            .and_then(|c| {
                c.lines()
                    .map(|l| l.trim_start_matches('#').trim())
                    .find(|l| !l.is_empty())
                    .map(|l| l.split(['.', '!', '?']).next().unwrap_or(l).trim().chars().take(80).collect::<String>())
            })
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| key.replace(['_', '-'], " "));
        let updated_at = std::fs::metadata(&dir)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let published = is_published(&key);
        out.push(LocalProject { key, title, has_plan, updated_at, published });
    }
    Ok(out)
}

/// Run `git worktree repair` in every cloned repo under a moved hub (#904) so a fleet launched
/// before the move keeps working: the worktrees (kept outside the hub) still point at the repo's
/// OLD path, and `repair` rewrites those links to the repo's new location. Best-effort.
fn repair_hub_worktrees(hub: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(hub) else { return };
    for entry in entries.flatten() {
        let repo = entry.path();
        if !repo.join(".git").exists() { continue; }
        let mut cmd = std::process::Command::new("git");
        cmd.args(["-C", &repo.to_string_lossy(), "worktree", "repair"]);
        let _ = no_window(&mut cmd).status();
    }
}

/// Whether a directory looks like a REAL project hub (carries plan/control artifacts) vs an empty
/// scaffold shell (#922). Drives the migration's "empty `projects/<key>` shell" detection — the
/// split-brain artifact a failed promote-rename used to leave behind.
fn dir_is_hub(dir: &std::path::Path) -> bool {
    ["CLAUDE.md", "goal.md", "scope.md", "phases.json", "fleet.json", "issues.json"]
        .iter()
        .any(|f| dir.join(f).is_file())
}

/// One-time layout migration (#922): consolidate every legacy `draft/<key>` hub back under the
/// single `projects/<key>` root, then retire the `draft/` directory. Runs at STARTUP, before any
/// session opens, so nothing holds a hub as its cwd and the moves can't fail on the Windows lock
/// that broke publish-time promotion under #904.
///
/// - An empty / non-hub `projects/<key>` shell (the artifact of a failed promote) is removed first
///   so the real draft hub can take its place.
/// - A genuine `projects/<key>` hub colliding with a same-key draft is kept (published wins); the
///   stale draft is dropped.
///
/// Purely STRUCTURAL — published-ness markers are reconciled separately (the frontend stamps
/// `.published` on hubs that have a GitHub board), so this never has to guess published-ness.
fn migrate_draft_hubs_into_projects() {
    let draft_root = bsc_base_dir().join("draft");
    let Ok(entries) = std::fs::read_dir(&draft_root) else { return };
    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_dir() { continue; }
        let Some(key) = src.file_name().and_then(|n| n.to_str()).map(str::to_owned) else { continue };
        if key.starts_with('.') { continue; }
        let dst = project_dir(&key);
        if dst.exists() {
            if dir_is_hub(&dst) {
                log::warn!("migrate: projects/ and draft/ both hold a hub for {key:?}; keeping published, dropping draft");
                let _ = std::fs::remove_dir_all(&src);
                continue;
            }
            let _ = std::fs::remove_dir_all(&dst); // empty/non-hub shell — clear it for the real hub
        }
        match std::fs::rename(&src, &dst) {
            Ok(()) => { repair_hub_worktrees(&dst); log::info!("migrated draft hub {key:?} → projects/"); }
            Err(e) => log::warn!("migrate: could not move draft/{key:?} → projects/: {e}"),
        }
    }
    let _ = std::fs::remove_dir(&draft_root); // retire the now-empty draft/ root (no-op if non-empty)
}

/// Delete every plan section file (`.md` / `.json`) in a single project's hub
/// directory, leaving subdirectories (cloned repos, `prompts/`,
/// `.claude/`) intact. The section poll re-reads from disk, so this must run
/// before the store is cleared — otherwise the next poll repopulates the store.
/// Returns how many files were deleted. Best-effort: any unreadable file is skipped.
#[tauri::command]
fn clear_project_plan_files(project_key: String) -> Result<u32, String> {
    if sanitize_project_key(&project_key).is_empty() {
        return Err("clear_project_plan_files: empty project_key".to_string());
    }
    let proj = plan_dir_for(&project_key);
    if !proj.exists() {
        return Ok(0);
    }
    let entries = std::fs::read_dir(&proj).map_err(|e| format!("clear_project_plan_files: {e}"))?;
    let mut removed = 0u32;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() { continue; }
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if (ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("json"))
            && std::fs::remove_file(&p).is_ok()
        {
            removed += 1;
        }
    }
    // The Context-stage discovery sections live in `context/` (#807) — clear them too, or a
    // blueprint reset would leave the old goal/scope/stack/architecture behind. Drop the whole
    // subdir (it holds only generated section files).
    let context = context_dir_for(&project_key);
    if context.is_dir() && std::fs::remove_dir_all(&context).is_ok() {
        removed += 1;
    }
    // Drop generated UI artifacts too (#650): the .ui-skeleton/ dir feeds the render-preview
    // pipeline, so leaving it would re-show the old UI after a clear.
    let skeleton = proj.join(".ui-skeleton");
    if skeleton.is_dir() && std::fs::remove_dir_all(&skeleton).is_ok() {
        removed += 1;
    }
    // Empty the plan store too (#plan-db): issues + features live in plan.db, not files, so a
    // file-only clear would be undone when the next poll re-reads the DB. Best-effort.
    if let Err(e) = plan_db::clear(&project_key) {
        log::warn!("clear_project_plan_files({project_key}): clearing plan.db failed: {e}");
    }
    log::info!("clear_project_plan_files({project_key}): removed {removed} files");
    Ok(removed)
}

// ── User blueprint storage (#blueprints) ────────────────────────────────────────────
// User-generated blueprints (authored + imported) live as JSON files under
// `~/.base-studio-code/blueprints/<id>.json` — a durable home separate from the project hubs, so
// they survive a store reset and a download has somewhere real to land. Built-in app blueprints are
// bundled in the frontend and never written here. The store hydrates from this dir + the built-ins.

/// A user blueprint's on-disk path; the id is slugified so it can't escape the dir.
fn blueprint_file(id: &str) -> Result<std::path::PathBuf, String> {
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err("blueprint id is empty/invalid".into());
    }
    Ok(bsc_base_dir().join("blueprints").join(format!("{safe}.json")))
}

/// The JSON of every user blueprint on disk (the library hydrates from this + the bundled built-ins).
/// Skips unreadable/empty files; a missing dir ⇒ empty.
#[tauri::command]
fn list_blueprints() -> Vec<String> {
    let dir = bsc_base_dir().join("blueprints");
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(s) = std::fs::read_to_string(&p) {
                if !s.trim().is_empty() {
                    out.push(s);
                }
            }
        }
    }
    out
}

/// Persist a user blueprint to `blueprints/<id>.json` (written verbatim — the frontend owns the shape).
#[tauri::command]
fn write_blueprint(id: String, json: String) -> Result<(), String> {
    let path = blueprint_file(&id)?;
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    std::fs::write(&path, json).map_err(|e| format!("write_blueprint: {e}"))
}

/// Remove a user blueprint's file (no-op if absent).
#[tauri::command]
fn delete_blueprint(id: String) -> Result<(), String> {
    let path = blueprint_file(&id)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("delete_blueprint: {e}"))?;
    }
    Ok(())
}

/// Reject a relative path that would escape the project hub: absolute paths, a Windows
/// drive prefix, a root component, or any `..` segment. Shared by the pipeline file
/// primitives so a pipeline can never write/read outside its own project dir.
fn is_safe_relpath(rel: &std::path::Path) -> bool {
    !rel.is_absolute()
        && !rel.components().any(|c| matches!(
            c,
            std::path::Component::ParentDir
                | std::path::Component::Prefix(_)
                | std::path::Component::RootDir
        ))
}

/// Write one file into a project's hub — the shared persistence primitive pipelines call
/// (#…). Pipelines own *what*/*where*/*when* they save; this just performs the path-safe
/// write under `projects/<key>/`. `relpath` is resolved under the project dir; any attempt
/// to escape it (absolute, drive prefix, or `..`) is rejected.
#[tauri::command]
fn write_project_file(project_key: String, relpath: String, contents: String) -> Result<(), String> {
    if sanitize_project_key(&project_key).is_empty() {
        return Err("write_project_file: empty project_key".to_string());
    }
    if relpath.trim().is_empty() {
        return Err("write_project_file: empty relpath".to_string());
    }
    let rel = std::path::Path::new(&relpath);
    if !is_safe_relpath(rel) {
        return Err(format!("write_project_file: unsafe relpath '{relpath}'"));
    }
    let target = project_dir(&project_key).join(rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("write_project_file: {e}"))?;
    }
    std::fs::write(&target, contents).map_err(|e| format!("write_project_file: {e}"))?;
    log::info!("write_project_file({project_key}): wrote {relpath}");
    Ok(())
}

/// Write a BINARY file into a project's hub from base64 (#604) — the file-intake pipeline
/// stages dropped files (images, fonts, any binary) this way, since `write_project_file`
/// only handles text. Same path-safety rules. `b64` is standard base64 of the file bytes.
#[tauri::command]
fn write_project_file_bytes(project_key: String, relpath: String, b64: String) -> Result<(), String> {
    use base64::Engine;
    if sanitize_project_key(&project_key).is_empty() {
        return Err("write_project_file_bytes: empty project_key".to_string());
    }
    if relpath.trim().is_empty() {
        return Err("write_project_file_bytes: empty relpath".to_string());
    }
    let rel = std::path::Path::new(&relpath);
    if !is_safe_relpath(rel) {
        return Err(format!("write_project_file_bytes: unsafe relpath '{relpath}'"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("write_project_file_bytes: bad base64: {e}"))?;
    let target = project_dir(&project_key).join(rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("write_project_file_bytes: {e}"))?;
    }
    std::fs::write(&target, &bytes).map_err(|e| format!("write_project_file_bytes: {e}"))?;
    log::info!("write_project_file_bytes({project_key}): wrote {relpath} ({} bytes)", bytes.len());
    Ok(())
}

/// Result of running a dead-code scanner (#626). `ran` distinguishes "the tool ran"
/// (parse `stdout`) from "couldn't run it" (`error` set — not installed, bad dir, …).
#[derive(serde::Serialize)]
struct ScanResult {
    tool: String,
    ran: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    error: Option<String>,
}

/// Allowlisted dead-code / unused-dependency scanners → (program, args). Only these may
/// run — the `tool` arg never becomes an arbitrary command. (#626)
fn dead_code_cmd(tool: &str) -> Option<(&'static str, &'static [&'static str])> {
    match tool {
        "depcheck" => Some(("npx", &["--yes", "depcheck", "--json"])),
        "ts-prune" => Some(("npx", &["--yes", "ts-prune"])),
        "cargo-machete" => Some(("cargo", &["machete"])),
        _ => None,
    }
}

/// Run an allowlisted dead-code scanner in `repo_path` and return its raw output for the
/// frontend to parse. Never panics; a missing tool / bad dir comes back as `error`.
#[tauri::command]
fn scan_dead_code(repo_path: String, tool: String) -> ScanResult {
    let err = |e: String| ScanResult { tool: tool.clone(), ran: false, exit_code: None, stdout: String::new(), stderr: String::new(), error: Some(e) };
    let dir = std::path::Path::new(&repo_path);
    if !dir.is_dir() {
        return err(format!("not a directory: {repo_path}"));
    }
    let Some((prog, args)) = dead_code_cmd(&tool) else {
        return err(format!("unknown scanner '{tool}'"));
    };
    match std::process::Command::new(prog).args(args).current_dir(dir).output() {
        Ok(out) => ScanResult {
            tool,
            ran: true,
            exit_code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            error: None,
        },
        Err(e) => err(format!("couldn't run {prog}: {e}")),
    }
}

/// Recursively read every (text) file under `root` as `(relpath → contents)`, capped at
/// 512 KiB each, skipping unreadable/binary files. relpaths are forward-slashed and
/// relative to `root`. The generic complement to `read_skeleton_dir` (which filters by
/// extension) — pipelines persist arbitrary file types (`.vue`, `.svg`, `.html`, …).
fn read_files_dir(root: &std::path::Path) -> Vec<(String, String)> {
    fn walk(base: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                let small = std::fs::metadata(&p).map(|m| m.len() <= 512 * 1024).unwrap_or(false);
                if small {
                    if let (Ok(rel), Ok(content)) = (p.strip_prefix(base), std::fs::read_to_string(&p)) {
                        out.push((rel.to_string_lossy().replace('\\', "/"), content));
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Read every file under a project-hub subdir (relpath → contents) so a pipeline can
/// rehydrate its saved results (#…). Empty when the subdir is missing or `subdir` would
/// escape the project dir.
#[tauri::command]
fn read_project_files(project_key: String, subdir: String) -> Vec<(String, String)> {
    let rel = std::path::Path::new(&subdir);
    if !is_safe_relpath(rel) {
        return Vec::new();
    }
    read_files_dir(&project_dir(&project_key).join(rel))
}

/// Quote an arbitrary string as a single bash ANSI-C token (`$'...'`).
///
/// Used to bake a startup prompt into `claude <token>` safely: ANSI-C quoting
/// keeps the whole value on one physical line (newlines become `\n`) and `$`,
/// backticks, and double quotes are literal — so no shell expansion, no PS2
/// continuation, and any prompt content survives intact.
pub(crate) fn bash_ansi_c_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    out.push_str("$'");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// Build the shell command that launches `claude` with the baked startup prompt.
/// Triage sessions pass `continue_session = true` to resume the repo's most recent
/// conversation (`--continue`) instead of starting a fresh one.
pub(crate) fn claude_launch(prompt: &str, continue_session: bool) -> String {
    let flag = if continue_session { "--continue " } else { "" };
    format!("claude {}{}", flag, bash_ansi_c_quote(prompt))
}

/// Map a UI model id (`sonnet-4.5`, `opus-4.5`, `haiku-4.5`) to the alias Claude
/// Code's `--model` flag accepts. Returns `None` for anything unrecognized, so the
/// session falls back to Claude Code's own default and we never interpolate an
/// arbitrary caller string into the shell command (the match only ever yields a
/// fixed literal — no injection surface).
pub(crate) fn claude_model_flag(model: &str) -> Option<&'static str> {
    match model {
        "haiku-4.5" => Some("haiku"),
        "sonnet-4.5" => Some("sonnet"),
        "opus-4.5" => Some("opus"),
        _ => None,
    }
}

/// Claude Code's on-disk directory name for a launch cwd. Conversations live at
/// `~/.claude/projects/<dir>/<session>.jsonl`, where `<dir>` is the cwd with every
/// non-alphanumeric character replaced by `-`
/// (e.g. `C:\Users\Kevin\foo` → `C--Users-Kevin-foo`).
fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Whether Claude has a prior conversation for `cwd`. `--continue` aborts with
/// "No conversation found to continue" (and never delivers the baked startup
/// prompt) when there's no history, so we only pass the flag when this is true.
/// Fail-safe: any uncertainty (empty cwd, unreadable dir) returns `false`, which
/// launches a fresh session so the prompt is always delivered.
pub(crate) fn has_claude_history(cwd: &str) -> bool {
    if cwd.is_empty() {
        return false;
    }
    let dir = home_dir()
        .join(".claude")
        .join("projects")
        .join(claude_project_dir_name(cwd));
    let Ok(entries) = std::fs::read_dir(&dir) else { return false };
    entries
        .flatten()
        .any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl"))
}

/// Where `bsc-agent` persists (and resumes) the conversation for `cwd`:
/// `~/.base-studio-code/agent-sessions/<cwd-key>/conversation.json`. The app owns this keying
/// (mirroring Claude's per-cwd projects dir, via the same `claude_project_dir_name` slug) and hands
/// the path to the sidecar through `$BSC_AGENT_SESSION`; the sidecar just reads/writes it. The
/// adapter checks the same path for `detect_history`. Empty cwd ⇒ None (no persistence). (#1144)
pub(crate) fn bsc_agent_session_path(cwd: &str) -> Option<std::path::PathBuf> {
    if cwd.is_empty() {
        return None;
    }
    Some(
        bsc_base_dir()
            .join("agent-sessions")
            .join(claude_project_dir_name(cwd))
            .join("conversation.json"),
    )
}

/// Whether `bsc-agent` has a resumable conversation for `cwd` — a non-empty session file exists.
/// Fail-safe: any uncertainty returns `false`, launching a fresh session. (#1144)
pub(crate) fn has_bsc_agent_history(cwd: &str) -> bool {
    bsc_agent_session_path(cwd)
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len() > 0)
        .unwrap_or(false)
}

// ── File picker ───────────────────────────────────────────────────────────────

#[tauri::command]
async fn pick_directory() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned())
}

// ── Claude API (knowledge store) ─────────────────────────────────────────────

/// Provider-agnostic one-shot chat completion (#1079 / epic #1078). Dispatches to
/// the `provider` (default `"anthropic"`) via the [`llm`] layer; every provider
/// normalizes its reply to `{ content: [...], usage }`, so callers are unchanged.
/// `provider`/`model` are optional — omitting them preserves the legacy Anthropic
/// `claude-sonnet-4-6` behavior verbatim.
#[tauri::command]
async fn kb_chat(
    messages: Vec<serde_json::Value>,
    system: String,
    tools: Vec<serde_json::Value>,
    api_key: String,
    provider: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<serde_json::Value, String> {
    use llm::LlmProvider;
    let provider = provider.unwrap_or_else(|| "anthropic".to_string());
    let kind = llm::resolve_provider(&provider)?;
    // Local (Ollama) needs no API key; every hosted provider does.
    if api_key.is_empty() && !matches!(kind, llm::ProviderKind::Local) {
        return Err("No API key configured. Add it in Settings → Integrations.".to_string());
    }
    let req = llm::LlmRequest {
        model: model.unwrap_or_else(|| "claude-sonnet-4-6".to_string()),
        system,
        messages,
        tools,
        max_tokens: 4096,
    };
    match kind {
        llm::ProviderKind::Anthropic => llm::AnthropicProvider.complete(&req, &api_key).await,
        llm::ProviderKind::OpenAi => llm::OpenAiProvider.complete(&req, &api_key).await,
        llm::ProviderKind::Gemini => llm::GeminiProvider.complete(&req, &api_key).await,
        llm::ProviderKind::Local => {
            let base = base_url
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| llm::DEFAULT_LOCAL_BASE_URL.to_string());
            llm::LocalProvider { base_url: base }.complete(&req, &api_key).await
        }
    }
}

// ── Workspaces ───────────────────────────────────────────────────────────────
//
// Two roots under ~/.base-studio-code/:
//   documents/        — flat reusable markdown library; claude can Read/Write .md
//   projects/<key>/   — project hub + planner session CWD; references reusable
//                       blocks at ../../documents/{id}.md
//
// Each gets a .claude/settings.json (tool restrictions) and a CLAUDE.md
// (auto-loaded system prompt) written on every session start so the instructions
// stay in sync with the app without manual editing.

pub(crate) fn home_dir() -> std::path::PathBuf {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE")
            .unwrap_or_else(|_| std::env::var("HOME").unwrap_or_default())
    } else {
        std::env::var("HOME").unwrap_or_default()
    };
    std::path::PathBuf::from(home)
}

pub(crate) fn bsc_base_dir() -> std::path::PathBuf {
    home_dir().join(".base-studio-code")
}

/// Read the Agents audit log (#257): the newest `limit` TSV lines, newest first.
#[tauri::command]
fn read_audit_log(limit: usize) -> Vec<String> {
    let path = bsc_base_dir().join("audit.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    lines.reverse();
    lines.truncate(limit);
    lines
}

/// Repo-relative paths a worktree session has touched but not yet committed: tracked changes
/// vs HEAD (staged + unstaged) plus untracked files. The warden's conformance check (#1102)
/// uses this as the trusted "what did this worker actually change" signal. Tolerant: returns
/// empty on any git failure (no repo, git absent) so the warden simply has no file signal
/// rather than crashing. `cwd` is the session's worktree.
#[tauri::command]
fn read_worktree_changes(cwd: String) -> Vec<String> {
    if cwd.trim().is_empty() {
        return Vec::new();
    }
    let tracked = git_lines(&cwd, &["diff", "--name-only", "HEAD"]);
    let untracked = git_lines(&cwd, &["ls-files", "--others", "--exclude-standard"]);
    merge_change_lists(tracked, untracked)
}

/// One commit in a worker's done-time audit (#920).
#[derive(serde::Serialize)]
struct WorktreeCommit {
    hash: String,
    subject: String,
    author: String,
    /// Committer date, ISO-8601 (`%cI`).
    date: String,
}

/// The current branch name of a worktree (`git rev-parse --abbrev-ref HEAD`); empty on any
/// failure. Part of the per-worker audit snapshot (#920).
#[tauri::command]
fn read_worktree_branch(cwd: String) -> String {
    if cwd.trim().is_empty() {
        return String::new();
    }
    git_lines(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .into_iter()
        .next()
        .unwrap_or_default()
}

/// The most recent commits on a worktree branch (newest first), for the per-worker audit
/// snapshot (#920). Tolerant: empty on any git failure. `limit` is clamped to 1..=200.
#[tauri::command]
fn read_worktree_commits(cwd: String, limit: usize) -> Vec<WorktreeCommit> {
    if cwd.trim().is_empty() {
        return Vec::new();
    }
    let n = limit.clamp(1, 200).to_string();
    // Tab-separated so subjects with spaces survive: %h \t %s \t %an \t %cI.
    git_lines(&cwd, &["log", "-n", &n, "--format=%h%x09%s%x09%an%x09%cI"])
        .into_iter()
        .filter_map(|l| {
            let mut p = l.splitn(4, '\t');
            let hash = p.next()?.to_string();
            if hash.is_empty() {
                return None;
            }
            Some(WorktreeCommit {
                hash,
                subject: p.next().unwrap_or("").to_string(),
                author: p.next().unwrap_or("").to_string(),
                date: p.next().unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// A pull request found for a worker's branch (#920) — the concrete "did the work ship" link.
#[derive(serde::Serialize)]
struct BranchPr {
    number: u64,
    url: String,
    /// OPEN | CLOSED | MERGED (GitHub's `state`).
    state: String,
    merged: bool,
}

/// Find the PR opened from `branch` on `repo` (`owner/name`), via `gh pr list`. `None` when gh
/// is absent / unauthenticated / there's no PR — the audit simply shows "no PR yet". (#920)
#[tauri::command]
fn find_branch_pr(repo: String, branch: String) -> Option<BranchPr> {
    if repo.trim().is_empty() || branch.trim().is_empty() {
        return None;
    }
    let out = std::process::Command::new("gh")
        .args([
            "pr", "list", "--repo", &repo, "--head", &branch, "--state", "all",
            "--json", "number,url,state,mergedAt", "--limit", "1",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let first = v.as_array()?.first()?;
    Some(BranchPr {
        number: first.get("number")?.as_u64()?,
        url: first.get("url")?.as_str()?.to_string(),
        state: first.get("state").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        merged: first.get("mergedAt").map(|m| !m.is_null()).unwrap_or(false),
    })
}

/// The newest Claude transcript `.jsonl` for a worker's cwd, so the audit can surface the raw
/// conversation without re-capturing it (#920). `None` when there's no history. Reuses the same
/// per-cwd projects-dir slug Claude Code itself uses (`claude_project_dir_name`).
#[tauri::command]
fn claude_transcript_path(cwd: String) -> Option<String> {
    if cwd.trim().is_empty() {
        return None;
    }
    let dir = home_dir()
        .join(".claude")
        .join("projects")
        .join(claude_project_dir_name(&cwd));
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for entry in std::fs::read_dir(&dir).ok()?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
            if newest.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
                newest = Some((modified, p));
            }
        }
    }
    newest.map(|(_, p)| p.to_string_lossy().into_owned())
}

/// Run `git -C <cwd> <args…>` and return its stdout as trimmed, non-empty lines; empty on any
/// failure (non-zero exit, git missing).
fn git_lines(cwd: &str, args: &[&str]) -> Vec<String> {
    match std::process::Command::new("git").arg("-C").arg(cwd).args(args).output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// Merge two path lists into one sorted, de-duplicated set (pure; unit-tested). A file that is
/// both modified and listed elsewhere appears once.
fn merge_change_lists(a: Vec<String>, b: Vec<String>) -> Vec<String> {
    let mut set: std::collections::BTreeSet<String> = a.into_iter().collect();
    set.extend(b);
    set.into_iter().collect()
}

/// Read the skill usage log (#406): the newest `limit` TSV lines, newest first.
#[tauri::command]
fn read_skill_log(limit: usize) -> Vec<String> {
    let path = bsc_base_dir().join("skills.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    lines.reverse();
    lines.truncate(limit);
    lines
}

/// Read the hook-fire log (#865 PR 2): the newest `limit` TSV lines, newest first. Each line
/// is `ts \t event \t hook \t outcome` (written by the hook wrappers; absent until that lands,
/// in which case this returns an empty list). Mirrors `read_skill_log`.
#[tauri::command]
fn read_hook_log(limit: usize) -> Vec<String> {
    let path = bsc_base_dir().join("hooks.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    lines.reverse();
    lines.truncate(limit);
    lines
}

/// Read the MCP-call log (#879): the newest `limit` TSV lines, newest first. Each line is
/// `ts \t server \t tool \t outcome \t ms [\t detail]` (written by the bsc-mcp hook pair;
/// absent until that lands, in which case this returns an empty list). Mirrors `read_hook_log`.
#[tauri::command]
fn read_mcp_log(limit: usize) -> Vec<String> {
    let path = bsc_base_dir().join("mcp.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    lines.reverse();
    lines.truncate(limit);
    lines
}

/// Collect a UI-skeleton directory as (relpath, contents) pairs — source files only,
/// size-capped, recursive. Pure over a path so it's unit-testable (#533).
fn read_skeleton_dir(root: &std::path::Path) -> Vec<(String, String)> {
    fn ok_ext(p: &std::path::Path) -> bool {
        matches!(p.extension().and_then(|s| s.to_str()), Some("jsx" | "tsx" | "js" | "ts" | "css" | "json"))
    }
    fn walk(base: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else if ok_ext(&p) {
                let small = std::fs::metadata(&p).map(|m| m.len() <= 512 * 1024).unwrap_or(false);
                if small {
                    if let (Ok(rel), Ok(content)) = (p.strip_prefix(base), std::fs::read_to_string(&p)) {
                        out.push((rel.to_string_lossy().replace('\\', "/"), content));
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Read a project's `.ui-skeleton/` folder (relpath → contents) for the render-preview
/// pipeline (#533): the lightweight, functionless UI the planner generates. Empty when
/// the folder doesn't exist yet.
#[tauri::command]
fn read_ui_skeleton(project_key: String) -> Vec<(String, String)> {
    read_skeleton_dir(&project_dir(&project_key).join(".ui-skeleton"))
}

/// Absolute path to a project's hub directory (#647) — the frontend reveals it so the
/// user can export/back up authored plan files before resetting the blueprint.
#[tauri::command]
fn project_dir_path(project_key: String) -> String {
    project_dir(&project_key).to_string_lossy().to_string()
}

/// Read the coordination log (#199): up to the newest `limit` TSV lines, in
/// chronological (oldest-first) order so the coordinator can replay them.
#[tauri::command]
fn read_coord_log(limit: usize) -> Vec<String> {
    let path = bsc_base_dir().join("coord.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    if lines.len() > limit {
        lines = lines.split_off(lines.len() - limit);
    }
    lines
}

/// Append a `woke` event to the coordination log (#199): records that a parked
/// session was relaunched, so the coordinator won't re-wake it (idempotent across
/// polls + restarts). Same TSV shape + ISO-8601 UTC timestamp as the shell emitters.
#[tauri::command]
fn append_coord_woke(session: String) -> Result<(), String> {
    use std::io::Write;
    let path = bsc_base_dir().join("coord.log");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let fmt = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second]Z"
    );
    let ts = time::OffsetDateTime::now_utc().format(&fmt).unwrap_or_default();
    let line = format!("{ts}	{session}	woke		
");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

pub(crate) const KB_CLAUDE_MD: &str = include_str!("../templates/kb-claude.md");

// ── Knowledge base workspace ──────────────────────────────────────────────────

/// Creates the flat reusable document library at `documents/`, writing CLAUDE.md
/// and .claude/settings.json. Safe to call on every mount — overwrites config
/// files but leaves articles alone. Returns the library path.
#[tauri::command]
async fn setup_kb_workspace() -> Result<String, String> {
    config::sanitize_claude_config();
    let kb_dir     = documents_dir();
    let claude_dir = kb_dir.join(".claude");
    std::fs::create_dir_all(&claude_dir).map_err(|e| e.to_string())?;
    std::fs::write(
        claude_dir.join("settings.json"),
        r#"{"permissions":{"allow":["Read","Write","Edit"],"deny":["Bash","WebFetch","WebSearch","MultiEdit"]}}"#,
    ).map_err(|e| e.to_string())?;
    std::fs::write(kb_dir.join("CLAUDE.md"), KB_CLAUDE_MD)
        .map_err(|e| e.to_string())?;
    Ok(kb_dir.to_string_lossy().into_owned())
}

/// Turns an arbitrary project key into a filesystem-safe directory name.
/// Canonicalize a project key into a filesystem-safe slug.
///
/// Must stay byte-for-byte identical to the frontend's paneId sanitization in
/// Planning.tsx (`replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 80)`) so the PTY id and
/// the planning directory always correspond. ASCII-only on purpose — Rust's
/// `char::is_alphanumeric` accepts Unicode letters, which the JS regex does not.
pub(crate) fn sanitize_project_key(key: &str) -> String {
    let s: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    // Truncate so paths stay manageable.
    s.chars().take(80).collect()
}

// ── Repository resolution ─────────────────────────────────────────────────────
//
// Repos live inside their project hub at `projects/<project>/<short-repo-name>`.
// clone_repo: clones there via HTTPS; idempotent if the dir already exists.

/// Suppress the console window Windows pops for each child process (#432).
///
/// A GUI-subsystem Tauri build has no console, so every `std::process::Command`
/// it spawns (git, the readiness-probe shell, …) would otherwise flash — or, on
/// Windows 10, *persist* — its own `cmd`/`conhost` window with no way to close it.
/// The `CREATE_NO_WINDOW` (0x0800_0000) creation flag spawns the child detached
/// from any console. No-op on non-Windows. Call it on the `Command` right before
/// `.status()`/`.output()`/`.spawn()`. (The PTY path is unaffected — it goes
/// through portable_pty's headless ConPTY, not `std::process`.)
fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Clones `full_name` (an `owner/name` GitHub slug) into the project hub at
/// `projects/<sanitize(project)>/<short-repo-name>` and returns the clone path.
/// Idempotent: if the destination is already a git clone it is returned as-is.
/// After cloning, `CLAUDE.local.md` is appended to the clone's
/// `.git/info/exclude` so the planner-generated per-repo context file stays out
/// of `git status`.
#[tauri::command]
async fn clone_repo(project: String, full_name: String) -> Result<String, String> {
    let _perf = PerfSpan::new("clone_repo");
    let dest = repo_dir(&project, &full_name);
    if dest.is_dir() && dest.join(".git").exists() {
        return Ok(dest.to_string_lossy().into_owned());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let url = format!("https://github.com/{}.git", full_name);
    let mut cmd = std::process::Command::new("git");
    cmd.args(["clone", &url, &dest.to_string_lossy()]);
    let status = no_window(&mut cmd).status().map_err(|e| e.to_string())?;
    if !status.success() {
        log::warn!("clone_repo: git clone failed for {full_name}");
        return Err(format!("git clone failed for {}", full_name));
    }
    // Keep app-managed files (per-repo CLAUDE.local.md, the .claude/ session
    // settings) out of the clone's `git status`.
    git_exclude(&dest, "CLAUDE.local.md");
    git_exclude(&dest, ".claude/");
    // The fleet assume-and-log journal (bsc-note / bsc-blocked) lives in the repo
    // root; keep it out of the clone's `git status`.
    git_exclude(&dest, "DECISIONS.md");
    log::info!("clone_repo: cloned {full_name} → {}", dest.display());
    Ok(dest.to_string_lossy().into_owned())
}

/// Download (or update) a catalog MCP server repo into the app-managed
/// `~/.base-studio-code/mcp/<name>` and return its local path (#859 follow-up). The
/// Extensions catalog's "download" button calls this so a first-party server lands at a
/// known location ready to build + run, instead of just opening the browser. Idempotent:
/// an existing clone is fast-forwarded; a fresh one is a shallow clone of the default
/// branch (`main`). `name` is slugified so it can never escape the `mcp/` root.
/// Resolve a catalog MCP server's download directory under `~/.base-studio-code/mcp/`,
/// slugifying `name` (`[A-Za-z0-9._-]`, else `_`) so it can never escape the `mcp/` root.
/// `Err` for an empty / `.` / `..` name. Pure over the base dir — unit-tested.
fn mcp_install_dir(name: &str) -> Result<std::path::PathBuf, String> {
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err("mcp_clone: invalid name".into());
    }
    Ok(bsc_base_dir().join("mcp").join(safe))
}

#[tauri::command]
async fn mcp_clone(name: String, url: String) -> Result<String, String> {
    let _perf = PerfSpan::new("mcp_clone");
    let dir = mcp_install_dir(&name)?;
    let dir_str = dir.to_string_lossy().into_owned();
    if dir.join(".git").exists() {
        // Already downloaded — fast-forward to the latest default branch (best-effort).
        let mut pull = std::process::Command::new("git");
        pull.args(["-C", &dir_str, "pull", "--ff-only"]);
        let _ = no_window(&mut pull).status();
        log::info!("mcp_clone: updated {name} at {dir_str}");
        return Ok(dir_str);
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut cmd = std::process::Command::new("git");
    cmd.args(["clone", "--depth", "1", &url, &dir_str]);
    let status = no_window(&mut cmd).status().map_err(|e| e.to_string())?;
    if !status.success() {
        log::warn!("mcp_clone: git clone failed for {url}");
        return Err(format!("git clone failed for {url}"));
    }
    log::info!("mcp_clone: downloaded {url} → {dir_str}");
    Ok(dir_str)
}

/// The shell build command for a downloaded MCP server, detected from its repo files,
/// or `None` if the toolchain isn't recognized. A `uv`/Python project builds with
/// `python -m uv sync` (uv is a Python module; its shim is often off PATH — `python -m uv`
/// runs without any PATH setup, #887); a pnpm project with `pnpm install && pnpm build`;
/// any other Node project falls back to npm. Pure over the dir contents — unit-tested.
fn mcp_build_command(dir: &std::path::Path) -> Option<String> {
    if dir.join("pyproject.toml").exists() || dir.join("uv.lock").exists() {
        Some("python -m uv sync".into())
    } else if dir.join("pnpm-lock.yaml").exists() {
        Some("pnpm install && pnpm build".into())
    } else if dir.join("package.json").exists() {
        Some("npm install && npm run build".into())
    } else {
        None
    }
}

/// Result of building a downloaded MCP server. `ok` is the overall success; `ran` is the
/// shell command that was executed; `stdout`/`stderr` are its (truncated) output so the
/// MCP panel can show why a build failed.
#[derive(serde::Serialize)]
struct McpBuildResult {
    ok: bool,
    ran: String,
    stdout: String,
    stderr: String,
}

/// Build a downloaded MCP server in place (`~/.base-studio-code/mcp/<name>`), running its
/// detected toolchain build (`uv sync` / `pnpm install && pnpm build` / npm). Invoked by the
/// MCP panel's "build" button — kept separate from `mcp_clone` so downloading is cheap and
/// the (slow, toolchain-dependent) build is opt-in. Returns the outcome instead of erroring on
/// a failed build so the panel can surface stdout/stderr; only setup problems (missing dir,
/// unknown toolchain) are `Err`.
#[tauri::command]
async fn mcp_build(name: String) -> Result<McpBuildResult, String> {
    let _perf = PerfSpan::new("mcp_build");
    let dir = mcp_install_dir(&name)?;
    if !dir.exists() {
        return Err(format!("mcp_build: {name} is not downloaded yet — download it first"));
    }
    let Some(command) = mcp_build_command(&dir) else {
        return Err(format!("mcp_build: don't recognize how to build {name} (no pyproject.toml / package.json)"));
    };
    // Run through the platform shell so `&&` chains work and Windows `.cmd` shims
    // (pnpm/npm) resolve — a bare `Command::new("pnpm")` only finds `.exe` on Windows.
    #[cfg(windows)]
    let (shell, flag) = ("cmd", "/C");
    #[cfg(not(windows))]
    let (shell, flag) = ("sh", "-c");
    let mut cmd = std::process::Command::new(shell);
    cmd.current_dir(&dir).args([flag, &command]);
    let output = no_window(&mut cmd).output().map_err(|e| format!("mcp_build: failed to run `{command}`: {e}"))?;
    // Truncate captured output so a noisy build log doesn't bloat the IPC payload.
    let cap = |b: &[u8]| {
        let s = String::from_utf8_lossy(b);
        if s.len() > 8000 { format!("…{}", &s[s.len() - 8000..]) } else { s.into_owned() }
    };
    let ok = output.status.success();
    if ok {
        log::info!("mcp_build: built {name} via `{command}`");
    } else {
        log::warn!("mcp_build: `{command}` failed for {name}");
    }
    Ok(McpBuildResult { ok, ran: command, stdout: cap(&output.stdout), stderr: cap(&output.stderr) })
}

/// (downloaded, built) for an MCP server's install dir. Downloaded ⇒ a clone is present;
/// built ⇒ its toolchain's install/build output exists (`.venv` for uv, `node_modules` for
/// npm/pnpm, `dist` for a TS build). Pure over the dir — unit-tested.
fn mcp_status_of(dir: &std::path::Path) -> (bool, bool) {
    let downloaded = dir.join(".git").exists();
    let built = downloaded
        && (dir.join(".venv").exists() || dir.join("node_modules").exists() || dir.join("dist").exists());
    (downloaded, built)
}

#[derive(serde::Serialize)]
struct McpStatusResult {
    downloaded: bool,
    built: bool,
}

/// Report whether a catalog MCP server has been downloaded and built, so the planning page's
/// MCP panel can open with real install status instead of assuming "not installed".
#[tauri::command]
async fn mcp_status(name: String) -> Result<McpStatusResult, String> {
    let dir = mcp_install_dir(&name)?;
    let (downloaded, built) = mcp_status_of(&dir);
    Ok(McpStatusResult { downloaded, built })
}

/// An update can be pulled when the remote HEAD differs from the local HEAD (both known).
/// Pure over the two sha strings — unit-tested.
fn mcp_update_available(local: &str, remote: &str) -> bool {
    let (l, r) = (local.trim(), remote.trim());
    !l.is_empty() && !r.is_empty() && l != r
}

/// Run a git command, returning its trimmed stdout on success, else "".
fn git_output(args: &[&str]) -> String {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args);
    match no_window(&mut cmd).output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")] // return values aren't auto-renamed (#789): expose `updateAvailable`
struct McpUpdateStatus {
    downloaded: bool,
    built: bool,
    update_available: bool,
}

/// Check whether a downloaded MCP server has an update available — the MCP page runs this for
/// every installed first-party server on open, so each card shows an "up to date" pill or an
/// "update" button. Compares the local HEAD with the remote's (`git ls-remote origin HEAD`, refs
/// only — no object download). Also reports downloaded/built so an un-built clone surfaces a
/// "build" action. `update_available` is false for a non-git / not-downloaded server.
#[tauri::command]
async fn mcp_check_update(name: String) -> Result<McpUpdateStatus, String> {
    let _perf = PerfSpan::new("mcp_check_update");
    let dir = mcp_install_dir(&name)?;
    let (downloaded, built) = mcp_status_of(&dir);
    let mut update_available = false;
    if downloaded {
        let dir_str = dir.to_string_lossy().into_owned();
        let local = git_output(&["-C", &dir_str, "rev-parse", "HEAD"]);
        // `<sha>\tHEAD` — take the leading sha.
        let remote_line = git_output(&["-C", &dir_str, "ls-remote", "origin", "HEAD"]);
        let remote = remote_line.split_whitespace().next().unwrap_or("");
        update_available = mcp_update_available(&local, remote);
    }
    Ok(McpUpdateStatus { downloaded, built, update_available })
}

/// Branch/dir slug for a fleet agent — keeps only `[A-Za-z0-9._-]`, every other
/// char becomes `-`. Must match the frontend `worktreeSlug` so the computed
/// worktree cwd and the on-disk worktree path agree.
fn worktree_slug(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '-' })
        .collect()
}

/// Coordination protocol appended to every fleet worker's CLAUDE.local.md (#369) so the
/// defer-to-director / never-ask-the-user rules are authoritative context, not just a
/// first-message hint. A multi-line raw string (real newlines; literal backticks/quotes).
const FLEET_PROTOCOL_MD: &str = include_str!("../templates/fleet-protocol.md");

/// Director protocol (#375) appended to the project hub's CLAUDE.local.md so the
/// async-integrator director always has its standing duties as authoritative context
/// (it runs at the hub, so it never gets the worker worktree protocol).
const DIRECTOR_PROTOCOL_MD: &str = include_str!("../templates/director-protocol.md");

/// Injection-resistance preamble (#1167) appended to every fleet session's CLAUDE.local.md —
/// authoritative context that content read while working (issues, PRs, web pages, repo files,
/// other agents' notes) is untrusted DATA, never instructions. The containment half of the
/// warden (#1102): prevent an injection from acting, not just detect it after.
const INJECTION_RESISTANCE_MD: &str = include_str!("../templates/injection-resistance.md");

/// Heading marker for {@link INJECTION_RESISTANCE_MD}, used to keep the append idempotent.
const INJECTION_RESISTANCE_MARKER: &str = "## Untrusted input";

/// Ensure the project hub's CLAUDE.local.md carries the director protocol (#375). Idempotent.
#[tauri::command]
fn ensure_director_protocol(project_key: String) -> Result<(), String> {
    let local = project_dir(&project_key).join("CLAUDE.local.md");
    if let Some(parent) = local.parent() { let _ = std::fs::create_dir_all(parent); }
    let cur = std::fs::read_to_string(&local).unwrap_or_default();
    if !cur.contains("## Director protocol") {
        std::fs::write(&local, format!("{cur}{DIRECTOR_PROTOCOL_MD}")).map_err(|e| e.to_string())?;
    }
    // Injection-resistance preamble (#1167): the director reads issue/PR prose + authors kickoffs,
    // so it's a high-value injection target — give it the same untrusted-input rules as workers.
    let cur = std::fs::read_to_string(&local).unwrap_or_default();
    if !cur.contains(INJECTION_RESISTANCE_MARKER) {
        std::fs::write(&local, format!("{cur}{INJECTION_RESISTANCE_MD}")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Create (idempotently) a git worktree for one fleet agent: an isolated checkout
/// of `repo` on a branch named after the agent, at
/// `~/.base-studio-code/worktrees/<key>/<repoShort>--<agentSlug>` — OUTSIDE the project
/// hub (see `worktrees_dir`, #844), so the planner spec at `projects/<key>/CLAUDE.md` is
/// not an ancestor of the worker's CWD. Each agent edits and commits in its own
/// worktree+branch, so co-located agents (several in one repo) never share a working
/// tree; the director merges the branches via PRs.
///
/// `scope_md` is this worker's focused context — its owned globs, issues, and
/// dependencies — written as the lead of the worktree's `CLAUDE.local.md` (see
/// `write_worker_context`) instead of the full plan.
///
/// The repo's main clone must already exist (cloned during planning). A worktree or
/// branch left over from a prior run is reused. Returns the worktree's absolute path
/// (native form — mirrors `agentWorktreeCwd` so the launched pane's cwd matches).
#[tauri::command]
async fn ensure_worktree(project_key: String, repo: String, agent_id: String, scope_md: Option<String>) -> Result<String, String> {
    let _perf = PerfSpan::new("ensure_worktree");
    let clone = repo_dir(&project_key, &repo);
    if !clone.join(".git").exists() {
        return Err(format!("ensure_worktree: repo not cloned: {}", clone.display()));
    }
    let slug  = worktree_slug(&agent_id);
    let short = repo.rsplit('/').next().unwrap_or(&repo);
    let wt    = worktrees_dir(&project_key).join(format!("{short}--{slug}"));
    let wt_str = wt.to_string_lossy().into_owned();
    // A worktree's `.git` is a FILE pointing into the main repo; create it only if
    // it isn't there yet (reuse across re-runs).
    if !wt.join(".git").exists() {
        if let Some(parent) = wt.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let clone_str = clone.to_string_lossy().into_owned();
        // Reuse the branch if a prior run already created it; otherwise create it.
        let mut probe = std::process::Command::new("git");
        probe.args(["-C", &clone_str, "rev-parse", "--verify", "--quiet", &format!("refs/heads/{slug}")]);
        let branch_exists = no_window(&mut probe).status().map(|s| s.success()).unwrap_or(false);
        let mut args: Vec<String> = vec!["-C".into(), clone_str, "worktree".into(), "add".into()];
        if branch_exists {
            args.push(wt_str.clone());
            args.push(slug.clone());
        } else {
            args.push("-b".into());
            args.push(slug.clone());
            args.push(wt_str.clone());
        }
        let mut wt_cmd = std::process::Command::new("git");
        wt_cmd.args(&args);
        let status = no_window(&mut wt_cmd).status().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("ensure_worktree: git worktree add failed for {repo} / {agent_id}"));
        }
        log::info!("ensure_worktree: {repo} agent {agent_id} → {wt_str}");
    }
    // Copy the repo's own (tracked) CLAUDE.md only when the worktree lacks one, so a
    // checked-out CLAUDE.md isn't clobbered. (The hub's planner CLAUDE.md is no longer an
    // ancestor — that's the whole point of relocating the worktree — so this is just the
    // repo's real guidance.)
    let claude_md = clone.join("CLAUDE.md");
    if claude_md.is_file() && !wt.join("CLAUDE.md").exists() {
        let _ = std::fs::copy(&claude_md, wt.join("CLAUDE.md"));
    }
    write_worker_context(&wt, &clone, &project_dir(&project_key), scope_md.as_deref());
    Ok(wt_str)
}

/// Assemble a fleet worker's `CLAUDE.local.md` in its worktree (`wt`): its own `scope_md`
/// (owned globs / issues / dependencies) first, then the planner's app-managed per-repo
/// context (`CLAUDE.local.md` in the `clone`, which is git-excluded and so absent from a
/// fresh worktree), then the fleet coordination protocol (#369) and the hub's attached
/// skills (#636). Because the worktree lives outside the hub (`worktrees_dir`, #844), THIS
/// scoped file — not the planner spec — is what Claude Code loads as the worker's context.
///
/// Rewritten on every launch (the per-repo context is untracked and not in a fresh
/// worktree); deterministic, so re-runs converge to identical content. Best-effort writes,
/// matching the rest of the worktree-context setup — a context-file failure must not abort
/// an otherwise-good launch.
fn write_worker_context(
    wt: &std::path::Path,
    clone: &std::path::Path,
    hub: &std::path::Path,
    scope_md: Option<&str>,
) {
    let mut md = String::new();
    if let Some(scope) = scope_md {
        let scope = scope.trim();
        if !scope.is_empty() {
            md.push_str(scope);
            md.push_str("\n\n");
        }
    }
    if let Ok(repo_ctx) = std::fs::read_to_string(clone.join("CLAUDE.local.md")) {
        let repo_ctx = repo_ctx.trim();
        if !repo_ctx.is_empty() {
            md.push_str(repo_ctx);
            md.push('\n');
        }
    }
    let wt_local = wt.join("CLAUDE.local.md");
    let _ = std::fs::write(&wt_local, &md);
    // Coordination protocol (#369): the defer-to-director / never-ask-the-user rules.
    let cur = std::fs::read_to_string(&wt_local).unwrap_or_default();
    if !cur.contains("## Fleet coordination protocol") {
        let _ = std::fs::write(&wt_local, format!("{cur}{FLEET_PROTOCOL_MD}"));
    }
    // Injection-resistance preamble (#1167): untrusted-input rules as authoritative worker context.
    let cur = std::fs::read_to_string(&wt_local).unwrap_or_default();
    if !cur.contains(INJECTION_RESISTANCE_MARKER) {
        let _ = std::fs::write(&wt_local, format!("{cur}{INJECTION_RESISTANCE_MD}"));
    }
    // Inline the blueprint's attached skills (#636) so each worker carries the same skill
    // context the planner had. skills.md lives at the hub (not in the worktree), so the
    // planner's "read skills.md" note doesn't help a worker — inline it instead.
    inject_skills(hub, &wt_local);
}

/// Inline the hub's attached skills (`skills.md`, #636) into a worker's CLAUDE.local.md
/// so the worker auto-loads the same skill context the planner had. Idempotent; a no-op
/// when there are no attached skills (skills.md absent/empty).
fn inject_skills(hub: &std::path::Path, wt_local: &std::path::Path) {
    let skills = std::fs::read_to_string(hub.join("skills.md")).unwrap_or_default();
    let trimmed = skills.trim();
    if trimmed.is_empty() {
        return;
    }
    let cur = std::fs::read_to_string(wt_local).unwrap_or_default();
    if cur.contains("# Attached skills & knowledge") {
        return; // already injected
    }
    let _ = std::fs::write(wt_local, format!("{}\n\n{}\n", cur.trim_end(), trimmed));
}

/// Resolve the absolute path git would use for a file under its git dir, via
/// `git rev-parse --git-path <rel>`. This is the ONLY correct way to locate shared paths like
/// `info/exclude` across both layouts: in a normal clone `.git` is a directory, but in a linked
/// **worktree** `.git` is a FILE pointing at `…/.git/worktrees/<id>`, and shared paths resolve to
/// the common dir — so `repo_root/.git/info/exclude` is simply wrong there. Returns None when git
/// is unavailable or `repo_root` is not a repo.
fn git_path(repo_root: &std::path::Path, rel: &str) -> Option<std::path::PathBuf> {
    let out = std::process::Command::new("git")
        .arg("-C").arg(repo_root)
        .args(["rev-parse", "--git-path", rel])
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if p.is_empty() { return None; }
    // git prints the path relative to the cwd (= repo_root) for a normal clone, or absolute for a
    // worktree's common dir. Resolve relatives against repo_root; keep absolutes as-is.
    let pb = std::path::PathBuf::from(&p);
    Some(if pb.is_absolute() { pb } else { repo_root.join(pb) })
}

/// Append `entry` to a repo's `info/exclude` (idempotent) so app-managed files (`.mcp.json`,
/// `.claude/`) stay out of `git status` — and therefore out of the warden's worktree-change signal,
/// which would otherwise quarantine every fleet worker for an "out-of-lane" edit it never made
/// (#1102). No-op when `repo_root` is not a git repo.
///
/// Resolves the exclude file through git rather than assuming `repo_root/.git/info/exclude`: in a
/// linked worktree `.git` is a file, so the assumed path doesn't exist and the write silently
/// fails — the bug that let `.mcp.json` leak into every worker's diff.
fn git_exclude(repo_root: &std::path::Path, entry: &str) {
    if !repo_root.join(".git").exists() { return; }
    // Fall back to the literal path only if git can't resolve it (e.g. git absent) AND `.git` is a
    // real directory — never write through a worktree's `.git` file.
    let exclude = git_path(repo_root, "info/exclude").unwrap_or_else(|| {
        repo_root.join(".git").join("info").join("exclude")
    });
    if exclude.parent().map(|p| !p.is_dir()).unwrap_or(false) {
        // Parent isn't a directory (e.g. unresolved worktree `.git` file) — bail rather than fail.
        return;
    }
    if let Some(parent) = exclude.parent() { let _ = std::fs::create_dir_all(parent); }
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == entry) { return; }
    let next = if existing.trim().is_empty() {
        format!("{}\n", entry)
    } else {
        format!("{}\n{}\n", existing.trim_end(), entry)
    };
    let _ = std::fs::write(&exclude, next);
}

/// Shell commands every spawned repo/console session auto-approves regardless of
/// the user's allowlist — the app's GitHub workflow (triage, publish, repo ops)
/// depends on them. `gh` is required by triage; `git` by every repo session;
/// `bsc-plan` is the plan-store CLI (#plan-db) the planner/director/workers use to
/// read+write issues, so it must never prompt (the planner runs it under autopilot).
const MANDATORY_BASH: &[&str] = &["gh", "git", "bsc-plan"];

/// Dangerous command patterns denied in every spawned session by default.
///
/// The session allows the Bash tool broadly so ordinary work — including loops
/// and `&&` / `|` compound commands — runs without a prompt ("start and go").
/// These guard against the most catastrophic *direct* invocations; deny takes
/// precedence over allow in Claude Code. Best-effort: prefix matching can't catch
/// a dangerous command nested inside a loop or pipe, so this raises the bar
/// against accidents, not a true sandbox. Users extend it from the Knowledge Base
/// → Commands section (the per-session `denied_commands`).
const DEFAULT_DENY: &[&str] = &[
    "Bash(sudo *)",
    "Bash(rm -rf /*)",
    "Bash(rm -fr /*)",
    "Bash(rm -rf ~*)",
    "Bash(dd *)",
    "Bash(mkfs *)",
    "Bash(shutdown *)",
    "Bash(reboot *)",
    "Bash(git push --force*)",
    "Bash(git push -f *)",
    "Bash(curl *| sh)",
    "Bash(curl *| bash)",
    "Bash(wget *| sh)",
];

/// One MCP server an extension contributes to a session's `.mcp.json`. Field names
/// match the frontend `McpServerPayload`.
#[derive(serde::Deserialize, Clone)]
struct McpServerCfg {
    name: String,
    transport: String, // "stdio" | "http"
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    env: Vec<(String, String)>,
}

/// One lifecycle hook an extension contributes to a session's settings.json.
#[derive(serde::Deserialize, Clone)]
struct HookCfg {
    event: String,   // PreToolUse | PostToolUse | …
    #[serde(default)]
    matcher: String, // optional tool matcher; empty = all
    command: String,
}

/// One reusable Skill written into a session as a Claude Code Skill file
/// (`.claude/skills/<slug>/SKILL.md`). Field names match the frontend payload.
#[derive(serde::Deserialize, Clone)]
struct SkillCfg {
    name: String,
    description: String,
    prompt: String,
    #[serde(default)]
    tools: Vec<String>,
}

/// Ensure the claude session rooted at `cwd` can run shell commands without a
/// permission prompt while blocking dangerous ones, and apply the session's
/// extensions (MCP servers → `.mcp.json`, hooks → settings.json), by merging into
/// `<cwd>/.claude/settings.json` and `<cwd>/.mcp.json`.
/// Markers the GitHub-readiness probe echoes when each check passes (#297). Plain
/// `echo` tokens so parsing is a locale-independent substring match, not coupled to
/// gh/git output formatting.
const GH_PATH_MARK: &str = "BSC_GH_PATH_OK";
const GIT_PATH_MARK: &str = "BSC_GIT_PATH_OK";
const GH_AUTH_MARK: &str = "BSC_GH_AUTH_OK";

/// Prefix the diagnostics preflight (#446) emits, one tab-delimited line per CLI
/// tool: `BSC_PREREQ\t<name>\t<path>\t<version>` (path/version empty when the tool
/// is absent). A distinct prefix keeps parsing a locale-independent substring scan,
/// like the GitHub-readiness markers above.
const PREFLIGHT_MARK: &str = "BSC_PREREQ";

/// Parse the probe shell's stdout into `(gh_on_path, git_on_path, gh_authed)`. Pure.
fn parse_github_probe(stdout: &str) -> (bool, bool, bool) {
    (
        stdout.contains(GH_PATH_MARK),
        stdout.contains(GIT_PATH_MARK),
        stdout.contains(GH_AUTH_MARK),
    )
}

/// Probe whether a session shell can actually reach GitHub (#297): is `git`/`gh`
/// on PATH, and is `gh` authenticated. Fleet agents are told to push branches and
/// open PRs, but a spawned shell can silently lack the tools; this lets the pane
/// warn the user up front. Runs the checks through the SAME resolved shell and
/// caller env (e.g. `GH_TOKEN`) the agent's `bash -c` subshells inherit, via a
/// login shell (`-lc`) so login-profile PATH additions are reflected. Best-effort:
/// returns all-false on spawn failure rather than erroring, so the caller can still
/// surface an actionable warning. Field names match the frontend `GithubProbe`.
#[tauri::command]
async fn github_readiness(
    cwd: String,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let shell = crate::shell::resolve_shell();
    let script = format!(
        "command -v git >/dev/null 2>&1 && echo {GIT_PATH_MARK}; \
         command -v gh  >/dev/null 2>&1 && echo {GH_PATH_MARK}; \
         gh auth status >/dev/null 2>&1 && echo {GH_AUTH_MARK}",
    );
    let mut cmd = std::process::Command::new(&shell);
    cmd.arg("-lc").arg(&script);
    if !cwd.is_empty() {
        cmd.current_dir(&cwd);
    }
    let env_map = env.unwrap_or_default();
    for (k, v) in crate::pty::session_env(&env_map) {
        cmd.env(k, v);
    }
    let (gh, git, auth) = match no_window(&mut cmd).output() {
        Ok(out) => parse_github_probe(&String::from_utf8_lossy(&out.stdout)),
        Err(e) => {
            log::warn!("github_readiness probe failed to spawn ({shell}): {e}");
            (false, false, false)
        }
    };
    Ok(serde_json::json!({ "ghOnPath": gh, "gitOnPath": git, "ghAuthed": auth }))
}

/// One prerequisite's detected state, reported to the Diagnostics UI (#446). Field
/// names match the frontend `PrereqStatus`.
#[derive(serde::Serialize, PartialEq, Debug)]
struct PrereqStatus {
    /// Display name, e.g. "Git Bash", "claude", "git", "gh", "gh auth".
    name: String,
    /// Whether the tool was located (and, for "gh auth", authenticated).
    found: bool,
    /// First line of `<tool> --version`, when found.
    version: Option<String>,
    /// Resolved on-disk path, when found.
    path: Option<String>,
    /// Actionable install/fix hint — empty when `found`.
    hint: String,
}

/// Git Bash detection outcome handed to [`interpret_preflight`] so the pure
/// interpretation stays testable off-Windows. `NotApplicable` omits the entry
/// (non-Windows, where the session shell IS bash); `Missing`/`Found` map to the
/// Windows console-shell prerequisite.
// Each build constructs only its platform's variants — `NotApplicable` off Windows,
// `Found`/`Missing` on Windows (plus tests exercise all three), so per-platform
// dead-code analysis would flag the unused ones.
#[allow(dead_code)]
#[derive(Clone, PartialEq, Debug)]
enum GitBashProbe {
    NotApplicable,
    Missing,
    Found(String),
}

/// Static install/fix hint for a prerequisite that wasn't found. Empty for unknown
/// names so a present tool never carries a hint.
fn prereq_hint(tool: &str) -> &'static str {
    match tool {
        "claude" => "Install the Claude CLI — see https://docs.claude.com/claude-code",
        "git" => "Install Git — https://git-scm.com/downloads",
        "gh" => "Install the GitHub CLI — https://cli.github.com",
        "gh auth" => "Run `gh auth login` to authenticate the GitHub CLI",
        "Git Bash" => "Install Git for Windows (provides Git Bash) — https://git-scm.com/download/win",
        _ => "",
    }
}

/// Pure: turn the preflight probe's stdout (+ Git Bash detection) into the ordered
/// prerequisite list. No I/O, so it is fully unit-testable. `BSC_PREREQ` lines carry
/// each CLI tool's path/version; `BSC_GH_AUTH_OK` (reused from the GitHub probe)
/// signals `gh` is authenticated. `gh auth` is only reported authenticated when `gh`
/// itself is present, so a stale auth marker can't mask a missing CLI.
fn interpret_preflight(stdout: &str, git_bash: GitBashProbe) -> Vec<PrereqStatus> {
    // name -> (path, version), both trimmed; empty string means absent.
    let mut probed: HashMap<String, (String, String)> = HashMap::new();
    for line in stdout.lines() {
        let mut parts = line.splitn(4, '\t');
        if parts.next() != Some(PREFLIGHT_MARK) { continue; }
        if let Some(name) = parts.next() {
            let path = parts.next().unwrap_or("").trim().to_string();
            let version = parts.next().unwrap_or("").trim().to_string();
            probed.insert(name.to_string(), (path, version));
        }
    }

    let mut out: Vec<PrereqStatus> = Vec::new();

    // Git Bash — the Windows console shell; omitted where bash is the native shell.
    match git_bash {
        GitBashProbe::NotApplicable => {}
        GitBashProbe::Missing => out.push(PrereqStatus {
            name: "Git Bash".into(), found: false, version: None, path: None,
            hint: prereq_hint("Git Bash").into(),
        }),
        GitBashProbe::Found(p) => out.push(PrereqStatus {
            name: "Git Bash".into(), found: true, version: None, path: Some(p),
            hint: String::new(),
        }),
    }

    // CLI tools probed through the shell, in a fixed order (independent of stdout).
    for tool in ["claude", "git", "gh"] {
        let (path, version) = probed.get(tool).cloned().unwrap_or_default();
        let found = !path.is_empty();
        out.push(PrereqStatus {
            name: tool.into(),
            found,
            version: if version.is_empty() { None } else { Some(version) },
            path: if path.is_empty() { None } else { Some(path) },
            hint: if found { String::new() } else { prereq_hint(tool).into() },
        });
    }

    // gh authentication — meaningful only once `gh` itself is present.
    let gh_found = probed.get("gh").map(|(p, _)| !p.is_empty()).unwrap_or(false);
    let authed = gh_found && stdout.contains(GH_AUTH_MARK);
    out.push(PrereqStatus {
        name: "gh auth".into(),
        found: authed,
        version: None,
        path: None,
        hint: if authed { String::new() } else { prereq_hint("gh auth").into() },
    });

    out
}

/// Resolve the Git Bash prerequisite state for the diagnostics preflight: on
/// Windows, whether [`find_git_bash`] located a `bash.exe`; elsewhere bash is the
/// native shell, so Git Bash is not a prerequisite.
fn detect_git_bash() -> GitBashProbe {
    #[cfg(windows)]
    {
        match crate::shell::find_git_bash() {
            Some(p) => GitBashProbe::Found(p),
            None => GitBashProbe::Missing,
        }
    }
    #[cfg(not(windows))]
    {
        GitBashProbe::NotApplicable
    }
}

/// Diagnostics preflight (#446): in one call, report whether each external
/// prerequisite the app needs is present — the Windows console shell (Git Bash),
/// the `claude` CLI that runs agents, and `git`/`gh` (+ `gh` auth). Each result
/// carries presence, version, path, and an install hint so the UI can tell the user
/// exactly what to install. Runs through the SAME resolved shell + caller env as
/// agent subshells (login shell, so profile PATH additions count). Best-effort: a
/// spawn failure reports the CLI tools as missing rather than erroring.
#[tauri::command]
async fn preflight(
    cwd: String,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<Vec<PrereqStatus>, String> {
    let shell = crate::shell::resolve_shell();
    // One tab-delimited line per tool: BSC_PREREQ <name> <path> <version>. `tr` drops
    // CRs/tabs so a Windows version string can't break the field layout.
    let script = format!(
        "for t in claude git gh; do \
           p=\"$(command -v \"$t\" 2>/dev/null)\"; \
           v=\"$(\"$t\" --version 2>/dev/null | head -1 | tr -d '\\r\\t')\"; \
           printf '{PREFLIGHT_MARK}\\t%s\\t%s\\t%s\\n' \"$t\" \"$p\" \"$v\"; \
         done; \
         gh auth status >/dev/null 2>&1 && echo {GH_AUTH_MARK}",
    );
    let mut cmd = std::process::Command::new(&shell);
    cmd.arg("-lc").arg(&script);
    if !cwd.is_empty() {
        cmd.current_dir(&cwd);
    }
    let env_map = env.unwrap_or_default();
    for (k, v) in crate::pty::session_env(&env_map) {
        cmd.env(k, v);
    }
    let stdout = match no_window(&mut cmd).output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout).into_owned(),
        Err(e) => {
            log::warn!("preflight probe failed to spawn ({shell}): {e}");
            String::new()
        }
    };
    Ok(interpret_preflight(&stdout, detect_git_bash()))
}

/// Read the persisted console-shell preference (#447) for the Diagnostics selector.
/// Returns the lowercase kind string (`auto`/`bash`/`powershell`/`cmd`).
#[tauri::command]
fn get_preferred_shell() -> String {
    crate::shell::read_shell_pref().as_str().to_string()
}

/// Persist the console-shell preference (#447). Takes the frontend `ShellKind`
/// string; an unrecognized value is normalized to `auto` so the file always holds a
/// valid token. The next session launch reads it via `resolve_interactive_shell`.
#[tauri::command]
fn set_preferred_shell(kind: String) -> Result<(), String> {
    let pref = crate::shell::ShellPref::parse(&kind);
    let base = bsc_base_dir();
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    std::fs::write(crate::shell::shell_pref_path(), pref.as_str()).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn ensure_session_settings(
    cwd: String,
    allowed_commands: Vec<String>,
    denied_commands: Vec<String>,
    mcp_servers: Option<Vec<McpServerCfg>>,
    hooks: Option<Vec<HookCfg>>,
    allow_tool_rules: Option<Vec<String>>,
    deny_tool_rules: Option<Vec<String>>,
    ask_tool_rules: Option<Vec<String>>,
    skills: Option<Vec<SkillCfg>>,
    replace_permissions: Option<bool>,
) -> Result<(), String> {
    write_session_settings(
        &cwd, &allowed_commands, &denied_commands,
        &mcp_servers.unwrap_or_default(), &hooks.unwrap_or_default(),
        &allow_tool_rules.unwrap_or_default(), &deny_tool_rules.unwrap_or_default(),
        &ask_tool_rules.unwrap_or_default(),
        &skills.unwrap_or_default(),
        replace_permissions.unwrap_or(false),
    )
}

/// Synchronous core of [`ensure_session_settings`] (testable without a runtime).
///
/// Security model: the session ALLOWS the Bash tool broadly so normal commands
/// (loops, pipes, `&&` chains) run without a prompt. A curated default deny-list
/// ({@link DEFAULT_DENY}) plus any user/project `denied_commands` block the most
/// dangerous direct invocations (deny wins over allow). The configured
/// `allowed_commands` are still written as explicit prefix rules — harmless under
/// the broad allow, and meaningful if "Bash" is ever removed to go strict.
/// Merges into existing settings rather than clobbering; `.claude/` stays out of
/// the repo's `git status`.
#[allow(clippy::too_many_arguments)]
fn write_session_settings(
    cwd: &str,
    allowed_commands: &[String],
    denied_commands: &[String],
    mcp_servers: &[McpServerCfg],
    hooks: &[HookCfg],
    allow_tool_rules: &[String],
    deny_tool_rules: &[String],
    ask_tool_rules: &[String],
    skills: &[SkillCfg],
    replace_permissions: bool,
) -> Result<(), String> {
    if cwd.is_empty() { return Ok(()); }
    let root = std::path::PathBuf::from(cwd);
    let settings_path = root.join(".claude").join("settings.json");

    let mut config: serde_json::Value = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !config.is_object() { config = serde_json::json!({}); }

    // Allow: the Bash tool broadly (start-and-go) + mandatory gh/git + each
    // configured command as an explicit prefix rule (deduped).
    let mut allow_rules: Vec<String> = vec!["Bash".to_string()];
    for c in MANDATORY_BASH.iter().map(|s| (*s).to_string())
        .chain(allowed_commands.iter().map(|c| c.trim().to_string()))
    {
        if !c.is_empty() {
            let r = format!("Bash({} *)", c);
            if !allow_rules.contains(&r) { allow_rules.push(r); }
        }
    }

    // Deny: curated dangerous defaults + user/project denies (deny > allow).
    let mut deny_rules: Vec<String> = DEFAULT_DENY.iter().map(|s| (*s).to_string()).collect();
    for c in denied_commands {
        let c = c.trim();
        if !c.is_empty() {
            let r = format!("Bash({} *)", c);
            if !deny_rules.contains(&r) { deny_rules.push(r); }
        }
    }

    // Tool-permission rules (verbatim, NOT Bash-wrapped) — the role write-path guard
    // passes `Edit(<glob>)` / `Write` / … here to scope or deny the file-write tools.
    for r in allow_tool_rules {
        let r = r.trim().to_string();
        if !r.is_empty() && !allow_rules.contains(&r) { allow_rules.push(r); }
    }
    for r in deny_tool_rules {
        let r = r.trim().to_string();
        if !r.is_empty() && !deny_rules.contains(&r) { deny_rules.push(r); }
    }

    // Ask: rules that PROMPT the user before the command (Claude Code precedence
    // deny > ask > allow, so a specific ask overrides the broad Bash allow). The
    // flow's hard push-confirm gate (#297) passes `Bash(git push *)` / `Bash(gh pr
    // create *)` here so pushes/PRs require approval instead of auto-running.
    let mut ask_rules: Vec<String> = Vec::new();
    for r in ask_tool_rules {
        let r = r.trim().to_string();
        if !r.is_empty() && !ask_rules.contains(&r) { ask_rules.push(r); }
    }

    // Replace mode (#799): drop the existing allow/deny/ask lists first, so the freshly
    // computed role+profile set is AUTHORITATIVE. Without this, merge only UNIONS — a
    // permission the user removed from a profile would linger across relaunches. Used when
    // re-applying after a profile/permission edit.
    if replace_permissions {
        if let Some(perms) = config.get_mut("permissions").and_then(|p| p.as_object_mut()) {
            for k in ["allow", "deny", "ask"] { perms.remove(k); }
        }
    }
    merge_permission_list(&mut config, "allow", &allow_rules);
    merge_permission_list(&mut config, "deny", &deny_rules);
    merge_permission_list(&mut config, "ask", &ask_rules);

    // Hooks → settings.json `hooks` (overwritten with the resolved set, so toggling
    // a hook extension off and relaunching drops it). MCP servers → `.mcp.json`,
    // auto-approved for autonomous sessions via `enabledMcpjsonServers` (exactly the
    // resolved set — servers not listed aren't trusted, which is how removal lands).
    write_session_hooks(&mut config, hooks);
    {
        let obj = config.as_object_mut().unwrap();
        if mcp_servers.is_empty() {
            obj.remove("enabledMcpjsonServers");
        } else {
            obj.insert(
                "enabledMcpjsonServers".into(),
                serde_json::Value::Array(
                    mcp_servers.iter().map(|m| serde_json::Value::String(m.name.clone())).collect(),
                ),
            );
        }
    }

    std::fs::create_dir_all(root.join(".claude")).map_err(|e| e.to_string())?;
    std::fs::write(
        &settings_path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    ).map_err(|e| e.to_string())?;
    write_mcp_json(&root, mcp_servers)?;
    write_session_skills(&root, skills)?;
    git_exclude(&root, ".claude/");
    git_exclude(&root, ".mcp.json");
    Ok(())
}

/// Overwrite `config.hooks` with the resolved hooks, grouped by event:
/// `{event: [{matcher?, hooks: [{type:"command", command}]}]}`. Empty → key removed.
fn write_session_hooks(config: &mut serde_json::Value, hooks: &[HookCfg]) {
    let obj = config.as_object_mut().unwrap();
    if hooks.is_empty() { obj.remove("hooks"); return; }
    let mut by_event = serde_json::Map::new();
    for h in hooks {
        let inner = serde_json::json!({ "type": "command", "command": h.command });
        let entry = if h.matcher.is_empty() {
            serde_json::json!({ "hooks": [inner] })
        } else {
            serde_json::json!({ "matcher": h.matcher, "hooks": [inner] })
        };
        by_event
            .entry(h.event.clone())
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut().unwrap()
            .push(entry);
    }
    obj.insert("hooks".into(), serde_json::Value::Object(by_event));
}

/// Merge the resolved MCP servers into `<cwd>/.mcp.json` by name (preserving any
/// repo-authored entries). Skips entirely when there are none and no file exists.
/// `enabledMcpjsonServers` in settings.json gates which are actually active.
fn write_mcp_json(root: &std::path::Path, mcp_servers: &[McpServerCfg]) -> Result<(), String> {
    let path = root.join(".mcp.json");
    if mcp_servers.is_empty() && !path.exists() { return Ok(()); }
    let mut doc: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !doc.is_object() { doc = serde_json::json!({}); }
    let servers = doc.as_object_mut().unwrap()
        .entry("mcpServers").or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() { *servers = serde_json::json!({}); }
    let smap = servers.as_object_mut().unwrap();
    for m in mcp_servers {
        smap.insert(m.name.clone(), mcp_server_value(m));
    }
    std::fs::write(&path, serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// The sentinel command the frontend sets for the built-in Research server (#1196). It carries no
/// real path (the frontend can't know where the app exe lives), so `mcp_server_value` rewrites it to
/// the bundled `bsc-research-mcp` binary's absolute path at write time.
const RESEARCH_MCP_MARKER: &str = "bsc-research-mcp";

/// Resolve a stdio MCP command, substituting the bundled-binary absolute path for the built-in
/// Research marker (#1196). A non-marker command passes through unchanged; the marker falls back to
/// the bare name when the bundled binary can't be located (e.g. a dev build without the sidecar).
fn resolve_mcp_command(command: &str, bundled: Option<std::path::PathBuf>) -> String {
    if command == RESEARCH_MCP_MARKER {
        if let Some(p) = bundled {
            return p.to_string_lossy().to_string();
        }
    }
    command.to_string()
}

/// One MCP server's `.mcp.json` value: stdio `{command,args,env?}` or http `{type,url}`.
fn mcp_server_value(m: &McpServerCfg) -> serde_json::Value {
    if m.transport == "http" {
        return serde_json::json!({ "type": "http", "url": m.url.clone().unwrap_or_default() });
    }
    let mut v = serde_json::Map::new();
    let command = resolve_mcp_command(
        &m.command.clone().unwrap_or_default(),
        pty::bsc_research_mcp_bin_path(),
    );
    v.insert("command".into(), serde_json::Value::String(command));
    v.insert("args".into(), serde_json::Value::Array(
        m.args.iter().map(|a| serde_json::Value::String(a.clone())).collect(),
    ));
    let env: serde_json::Map<String, serde_json::Value> = m.env.iter()
        .filter(|(k, _)| !k.is_empty())
        .map(|(k, val)| (k.clone(), serde_json::Value::String(val.clone())))
        .collect();
    if !env.is_empty() { v.insert("env".into(), serde_json::Value::Object(env)); }
    serde_json::Value::Object(v)
}

/// Write each resolved Skill as a Claude Code Skill file at
/// `<cwd_root>/.claude/skills/<slug>/SKILL.md` (slug derived from the name). The
/// file is YAML frontmatter (`name`, `description`, optional `allowed-tools`) then
/// the prompt body. Skills with an empty slug are skipped; an empty set is a no-op.
///
/// Additive only: this writer creates/updates skill files but never deletes them,
/// so toggling a skill off does not remove its file yet (follow-up).
fn write_session_skills(cwd_root: &std::path::Path, skills: &[SkillCfg]) -> Result<(), String> {
    if cwd_root.as_os_str().is_empty() || skills.is_empty() { return Ok(()); }
    let skills_root = cwd_root.join(".claude").join("skills");
    for s in skills {
        let slug = skill_slug(&s.name);
        if slug.is_empty() { continue; }
        let dir = skills_root.join(&slug);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut doc = String::from("---\n");
        doc.push_str(&format!("name: {}\n", yaml_quote(&s.name)));
        doc.push_str(&format!("description: {}\n", yaml_quote(&s.description)));
        if !s.tools.is_empty() {
            doc.push_str(&format!("allowed-tools: {}\n", yaml_quote(&s.tools.join(", "))));
        }
        doc.push_str("---\n\n");
        doc.push_str(&s.prompt);
        std::fs::write(dir.join("SKILL.md"), doc).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Render a string as a YAML double-quoted scalar so frontmatter values with
/// colons, `#`, leading specials, or newlines can't break the `SKILL.md` header.
fn yaml_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
    format!("\"{}\"", escaped)
}

/// Slug a skill name: lowercase, keep `[a-z0-9-]`, collapse any run of other
/// chars to a single `-`, and trim leading/trailing `-`. May return empty.
fn skill_slug(name: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || c == '-' {
            if pending_dash && !out.is_empty() { out.push('-'); }
            pending_dash = false;
            out.push(c);
        } else {
            pending_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Merge `rules` into `config.permissions.<key>` (an array), preserving existing
/// entries and order, deduped. Creates the objects/array as needed.
fn merge_permission_list(config: &mut serde_json::Value, key: &str, rules: &[String]) {
    let obj = config.as_object_mut().unwrap();
    let permissions = obj.entry("permissions").or_insert_with(|| serde_json::json!({}));
    if !permissions.is_object() { *permissions = serde_json::json!({}); }
    let perm_obj = permissions.as_object_mut().unwrap();
    let list = perm_obj.entry(key).or_insert_with(|| serde_json::json!([]));
    if !list.is_array() { *list = serde_json::json!([]); }
    let arr = list.as_array_mut().unwrap();
    let mut seen: std::collections::HashSet<String> =
        arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
    for r in rules {
        if seen.insert(r.clone()) { arr.push(serde_json::Value::String(r.clone())); }
    }
}

/// Reads plan section files from the project hub. They live FLAT in
/// `projects/<key>/<section>.{md|json}` (no `plans/` subdir).
/// Returns a map of section key → file content for every file that exists and
/// is non-empty. Callers poll this on a short interval to pick up sections that
/// Claude writes via its Write tool (more reliable than parsing PTY output).
#[tauri::command]
async fn read_plan_sections(project_key: String) -> Result<std::collections::HashMap<String, String>, String> {
    let _perf = PerfSpan::new("read_plan_sections");
    let safe_key  = sanitize_project_key(&project_key);
    if safe_key.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let plans_dir = plan_dir_for(&project_key);
    if !plans_dir.exists() {
        return Ok(std::collections::HashMap::new());
    }
    // Every non-empty .md/.json section file, keyed by file stem, from the hub root
    // (manifests + legacy flat sections + the considered-but-skipped `_skipped` record +
    // the `phases` roadmap — handled specially by the UI) AND the `context/` subdir (the
    // Context-stage discovery topics, #807). Reading both keeps pre-existing flat projects
    // working; context/ is ingested last so a section there wins over a stale root copy.
    let mut sections = std::collections::HashMap::new();
    ingest_section_files(&plans_dir, &mut sections);
    ingest_section_files(&context_dir_for(&project_key), &mut sections);
    Ok(sections)
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Crash-recovery flag (#1041): true when the PREVIOUS shutdown was UNCLEAN — the `.session-lock`
/// marker survived because the `RunEvent::Exit` handler never ran (crash / kill / power loss /
/// force-quit). A clean quit deletes the marker, so a normal restart reads `false`. The frontend
/// reads this once (`was_unclean_shutdown`) to offer restoring the sessions that were running.
pub(crate) struct UncleanShutdown(pub bool);

/// Path of the session-lock marker (#1041).
fn session_lock_path() -> std::path::PathBuf {
    bsc_base_dir().join(".session-lock")
}

/// Claim the session lock for this run (#1041): returns whether the marker was ALREADY present
/// (= the previous shutdown was unclean — the Exit handler never deleted it), then (re)writes it.
/// Pure over an explicit path so it's testable; the pid content is just for debugging.
fn claim_session_lock(path: &std::path::Path) -> bool {
    let was_held = path.exists();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, std::process::id().to_string());
    was_held
}

/// Whether the previous shutdown was unclean (#1041). The frontend reads this once at boot to offer
/// restoring the sessions that were running (a clean quit returns `false`).
#[tauri::command]
fn was_unclean_shutdown(state: tauri::State<UncleanShutdown>) -> bool {
    state.0
}

pub fn run() {
    // rustls 0.23 can't auto-determine a CryptoProvider from features at runtime, so
    // the relay dial's TLS handshake (tokio-tungstenite) would panic the tunnel thread
    // ("could not automatically determine the process-level CryptoProvider"). Install
    // `ring` explicitly before any TLS; Err just means one is already installed.
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Startup timing (#perf): wall clock from here to `setup` ≈ native + plugin init, before the
    // WebView even loads our page. The frontend logs the doc→paint portion separately.
    let boot_start = std::time::Instant::now();

    // Crash recovery (#1041): if the session-lock marker SURVIVED the last run, the previous
    // shutdown was unclean (the Exit handler never ran to delete it). Read it BEFORE re-writing, then
    // claim the lock for this run. Existence is the signal; the pid is just for debugging.
    let unclean_shutdown = claim_session_lock(&session_lock_path());
    if unclean_shutdown {
        log::warn!("[startup] previous shutdown was UNCLEAN (session-lock survived) — offering session restore");
    }

    // Reap PTY children leaked by a prior run that never reached RunEvent::Exit (#1049). The ledger is
    // authoritative about what THIS app spawned, so this only ever kills our own orphans (owner gone +
    // same process) — never the user's terminals. Runs before any session launches.
    let reaped = pty_ledger::reconcile_on_boot();
    if reaped > 0 {
        log::warn!("[startup] reaped {reaped} orphaned PTY child process(es) from a prior unclean run");
    }

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                // Keep noisy dependencies (tauri/wry/reqwest) quiet — only warnings
                // and above — while showing our own app logs at info. A global Info
                // filter floods stdout+file from deps and can stall the UI.
                .level(log::LevelFilter::Warn)
                .level_for("base_studio_code_lib", log::LevelFilter::Info)
                .format(|out, message, record| {
                    let ts = time::OffsetDateTime::now_utc()
                        .format(&time::macros::format_description!("[hour]:[minute]:[second]"))
                        .unwrap_or_default();
                    out.finish(format_args!(
                        "\x1b[90m{ts}\x1b[0m {color}{level:<5}\x1b[0m \x1b[90m{target}\x1b[0m {message}",
                        color = level_color(record.level()),
                        level = record.level(),
                        target = record.target(),
                    ));
                })
                .targets([
                    // Visible in the `tauri dev` terminal…
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    // …and persisted to a rotating file in the app log dir.
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("base-studio-code".into()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .manage(crate::pty::PtyState::new())
        .manage(tunnel::TunnelState::new())
        .manage(perf::PerfState::new(bsc_base_dir().join("perf.db")))
        .manage(logs::LogState::new())
        .manage(UncleanShutdown(unclean_shutdown))
        .setup(move |app| {
            log::info!("[startup] process→setup {}ms (native + plugin init)", boot_start.elapsed().as_millis());
            // One-time layout migration (#922): consolidate legacy draft/ hubs back under
            // projects/ while nothing holds them as a cwd. Idempotent + cheap once draft/ is gone.
            migrate_draft_hubs_into_projects();
            // Cap unbounded log files to reclaim disk space — OFF the synchronous boot path
            // (#1047). A full read/rewrite of audit.log (≈520 KB) + the other TSV streams is
            // housekeeping, not first-paint work; doing it inline blocked every startup. Defer
            // past the cold-start window, then run the blocking I/O on a worker thread so it
            // never stalls first paint or the async runtime. Config-driven (#1060): uses the
            // LogState default (10k lines) until the frontend pushes the user's value.
            let cap_base = bsc_base_dir();
            let cap_cfg = app.state::<logs::LogState>().get();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_secs(perf::STARTUP_GRACE_SECS)).await;
                tauri::async_runtime::spawn_blocking(move || logs::cap_logs(&cap_base, &cap_cfg));
            });
            // Spawn the background performance sampler.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(perf::run_sampler(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            kb_chat,
            github::github_request,
            github::gist_create,
            github::gist_update,
            github::github_cache_clear,
            github::github_graphql,
            github::github_post,
            github::github_put,
            github::github_patch,
            oauth::github_client_id,
            oauth::github_device_start,
            oauth::github_device_poll,
            pty::pty_create,
            pty::pty_write,
            pty::pty_broadcast,
            pty::pty_resize,
            pty::pty_kill,
            pick_directory,
            data::pick_csv_file,
            data::data_preview_csv,
            data::data_load_csv,
            data::data_reconcile_csvs,
            data::data_source_inventory,
            data::data_source_sample,
            data::data_infer_model,
            data::data_persist_model,
            data::data_load_reconciled,
            data::data_platform_scan,
            data::data_connector_catalog,
            credentials::source_save_secret,
            credentials::source_has_secret,
            credentials::source_delete_secret,
            source_oauth::source_oauth_begin,
            planner::setup_workspaces,
            planner::planner_intro_prompt,
            setup_kb_workspace,
            clone_repo,
            mcp_clone,
            mcp_build,
            mcp_status,
            mcp_check_update,
            ensure_worktree,
            ensure_director_protocol,
            docstore::get_base_dir,
            config::read_claude_config,
            config::write_claude_config,
            ensure_session_settings,
            was_unclean_shutdown,
            github_readiness,
            preflight,
            get_preferred_shell,
            set_preferred_shell,
            read_plan_sections,
            docstore::write_project_plan,
            delete_project_dir,
            mark_published,
            clear_all_plan_files,
            clear_project_plan_files,
            list_blueprints,
            write_blueprint,
            delete_blueprint,
            list_local_projects,
            write_project_file,
            write_project_file_bytes,
            scan_dead_code,
            read_project_files,
            planner::get_context_signature,
            planner::compute_context_signature,
            docstore::list_documents,
            docstore::read_document,
            docstore::write_document,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
            tunnel::tunnel_status,
            tunnel::tunnel_set_input_granted,
            tunnel::tunnel_unpair,
            tunnel::tunnel_set_panes,
            tunnel::tunnel_set_sessions,
            tunnel::tunnel_set_plan_state,
            tunnel::tunnel_emit_plan_state,
            tunnel::tunnel_emit_plan_event,
            tunnel::tunnel_emit_plan_status,
            tunnel::tunnel_ack_plan_push,
            tunnel::tunnel_check_relay,
            tunnel::tunnel_set_fleet_state,
            tunnel::tunnel_emit_coord_event,
            tunnel::tunnel_set_automations,
            tunnel::tunnel_automation_ran,
            tunnel::tunnel_automation_failed,
            tunnel::tunnel_set_mcp_state,
            read_audit_log,
            read_worktree_changes,
            read_worktree_branch,
            read_worktree_commits,
            find_branch_pr,
            claude_transcript_path,
            read_skill_log,
            read_hook_log,
            read_mcp_log,
            tokens::read_token_usage,
            tokens::read_pane_messages,
            read_coord_log,
            read_ui_skeleton,
            project_dir_path,
            append_coord_woke,
            githooks::read_git_hooks,
            perf::perf_get_config,
            perf::perf_set_config,
            perf::perf_record_frontend_sample,
            perf::perf_clear_history,
            perf::perf_get_recent_samples,
            session_discovery::discover_sessions,
            logs::list_log_files,
            logs::read_log_tail,
            logs::clear_log,
            logs::export_log,
            logs::log_get_config,
            logs::log_set_config,
            logs::enforce_log_caps,
            plan_db::plan_upsert_issue,
            plan_db::plan_list_issues,
            plan_db::plan_remove_issue,
            plan_db::plan_set_issue_status,
            plan_db::plan_upsert_feature,
            plan_db::plan_list_features,
            plan_db::plan_remove_feature,
            plan_db::plan_add_repo,
            plan_db::plan_list_repos,
            plan_db::plan_remove_repo,
            plan_db::plan_upsert_phase,
            plan_db::plan_list_phases,
            plan_db::plan_remove_phase,
            plan_db::plan_set_fleet,
            plan_db::plan_get_fleet,
            plan_db::plan_remove_stream,
            plan_db::plan_set_deploy,
            plan_db::plan_get_deploy,
            plan_db::plan_add_mcp,
            plan_db::plan_list_mcp,
            plan_db::plan_remove_mcp,
            plan_db::plan_set_blueprint,
            plan_db::plan_get_blueprint,
            plan_db::plan_list_context,
            plan_db::plan_require_context,
            plan_db::plan_triage_record_run,
            plan_db::plan_triage_last_run,
            plan_db::plan_issues_changed_since,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Drain PtyState on app exit so the OS reclaims every shell + its
        // descendants (`claude`, `gh`, `git`, MCP children) before the process
        // dies. Without this, closing the app window left ~28 orphan
        // `bash`/`claude`/WebView children holding cwd locks on
        // `~/.base-studio-code` (#52).
        .run(|app_handle, event| {
            if matches!(event, RunEvent::Exit) {
                // Clean shutdown (#1041): delete the session-lock marker so the NEXT launch reads a
                // clean exit and doesn't offer to restore. A crash/kill skips this handler, leaving
                // the marker → the next launch detects the unclean shutdown.
                let _ = std::fs::remove_file(session_lock_path());
                // Signal the tunnel transport (#242b) to close before tearing down PTYs.
                app_handle.state::<tunnel::TunnelState>().shutdown();
                crate::pty::kill_all_pty_sessions(app_handle.state::<crate::pty::PtyState>().inner());
            }
        });
}

/// Shared test helpers, reachable from every module's `#[cfg(test)] mod tests` via
/// `crate::testutil::*` (so module tests can be co-located, #758).
#[cfg(test)]
pub(crate) mod testutil {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex as StdMutex;

    /// Serializes the env-mutating tests (they all repoint HOME/USERPROFILE, which
    /// `home_dir()` reads) so they can't race each other.
    pub static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    /// Fresh unique temp dir with HOME/USERPROFILE pointed at it so `bsc_base_dir()`
    /// resolves inside it. Caller removes it when done.
    pub fn temp_home(tag: &str) -> PathBuf {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("bsc-test-{tag}-{pid}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("HOME", &dir);
        std::env::set_var("USERPROFILE", &dir);
        dir
    }

    pub fn write_file(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use crate::testutil::{ENV_LOCK, temp_home, write_file};

    #[test]
    fn session_lock_detects_unclean_shutdown() {
        // #1041: the marker surviving a run = unclean shutdown (the Exit handler never deleted it).
        let dir = std::env::temp_dir().join(format!(
            "bsc-lock-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0),
        ));
        let lock = dir.join(".session-lock");
        // First claim (clean / first run): marker not present yet.
        assert!(!super::claim_session_lock(&lock), "first claim sees a clean state");
        assert!(lock.exists(), "claim writes the marker");
        // A second claim WITHOUT a clean release (no Exit delete) = unclean prior shutdown.
        assert!(super::claim_session_lock(&lock), "surviving marker => unclean");
        // A clean release (what RunEvent::Exit does), then a claim = clean again.
        let _ = std::fs::remove_file(&lock);
        assert!(!super::claim_session_lock(&lock), "after a clean release the next run is clean");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn director_protocol_assigns_contract_ownership() {
        // The director owns the integration contracts, tests the seams, and is the worker's
        // help desk for them (#…). Guard that the standing protocol says so.
        let p = super::DIRECTOR_PROTOCOL_MD;
        assert!(p.contains("contracts/") || p.contains("contracts directory") || p.contains("INTEGRATION CONTRACTS"),
            "director protocol must claim ownership of the contracts directory");
        assert!(p.contains("TEST THE INTEGRATIONS"), "director protocol must mandate integration testing");
    }

    #[test]
    fn pane_id_format_matches_frontend_convention() {
        // The frontend uses `t${tabIdx}p${paneIdx}` as the pane ID key.
        // Verify the format matches for several indices.
        assert_eq!(format!("t{}p{}", 0, 0), "t0p0");
        assert_eq!(format!("t{}p{}", 1, 3), "t1p3");
        assert_eq!(format!("t{}p{}", 2, 8), "t2p8");
    }

    #[test]
    fn osc7_path_strip_removes_scheme_and_host() {
        // Mirrors what TerminalView.tsx does in the browser:
        // data.replace(/^file:\/\/[^/]*/, "")
        let input = "file://localhost/c/Users/Kevin/project";
        let stripped = input.trim_start_matches("file://").split_once('/')
            .map(|(_, rest)| format!("/{}", rest))
            .unwrap_or_default();
        assert_eq!(stripped, "/c/Users/Kevin/project");
    }

    #[test]
    fn to_native_path_resolves_git_bash_drive_paths_on_windows() {
        // The OSC-7 cwd a bash shell reports (and the app persists) — must round back to a native
        // path so pty_create's is_dir/Command::cwd resolve an EXISTING worktree on restore (#979).
        let bash = "/c/Users/Kevin/.base-studio-code/worktrees/studio-code/base-studio-code--source-experience";
        let got = super::to_native_path(bash);
        if cfg!(windows) {
            assert_eq!(got, "C:/Users/Kevin/.base-studio-code/worktrees/studio-code/base-studio-code--source-experience");
        } else {
            assert_eq!(got, bash); // no-op off Windows
        }
        // Non-drive POSIX paths and already-native paths pass through unchanged everywhere.
        assert_eq!(super::to_native_path("/usr/local/bin"), "/usr/local/bin");
        assert_eq!(super::to_native_path("C:/already/native"), "C:/already/native");
    }

    use super::{bash_ansi_c_quote, sanitize_project_key, claude_launch, claude_project_dir_name};

    #[test]
    fn read_skeleton_dir_collects_source_files_recursively() {
        use std::fs;
        let root = std::env::temp_dir().join(format!("bsc_skel_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("parts")).unwrap();
        fs::write(root.join("Login.jsx"), "export default () => null;").unwrap();
        fs::write(root.join("parts/Field.tsx"), "export const F = 1;").unwrap();
        fs::write(root.join("notes.md"), "ignore me").unwrap();        // wrong ext → skipped
        fs::write(root.join("data.json"), "{}").unwrap();

        let files = super::read_skeleton_dir(&root);
        let keys: Vec<&str> = files.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"Login.jsx"), "got {keys:?}");
        assert!(keys.contains(&"parts/Field.tsx"), "nested + forward-slash relpath");
        assert!(keys.contains(&"data.json"));
        assert!(!keys.iter().any(|k| k.ends_with(".md")), "non-source files skipped");

        // Missing folder → empty, never panics.
        assert!(super::read_skeleton_dir(&root.join("nope")).is_empty());
        let _ = fs::remove_dir_all(&root);
    }


    #[test]
    fn ansi_c_quote_wraps_plain_text() {
        assert_eq!(bash_ansi_c_quote("triage the issues"), "$'triage the issues'");
    }

    #[test]
    fn claude_launch_bakes_prompt_fresh() {
        assert_eq!(claude_launch("triage the issues", false), "claude $'triage the issues'");
    }

    #[test]
    fn claude_launch_adds_continue_flag() {
        // Triage resumes the repo's prior conversation instead of starting fresh.
        assert_eq!(claude_launch("triage the issues", true), "claude --continue $'triage the issues'");
    }

    #[test]
    fn worktree_slug_keeps_only_branch_safe_chars() {
        // The slug doubles as a git branch name + worktree dir, and must match the
        // frontend `worktreeSlug` (replace anything outside [A-Za-z0-9._-] with '-').
        assert_eq!(super::worktree_slug("auth-ui"), "auth-ui");
        assert_eq!(super::worktree_slug("a.b_c-d"), "a.b_c-d");
        assert_eq!(super::worktree_slug("API client/2"), "API-client-2");
    }

    #[test]
    fn claude_project_dir_name_replaces_non_alnum_with_dash() {
        // Matches the dir Claude Code creates under ~/.claude/projects.
        assert_eq!(
            claude_project_dir_name(r"C:\Users\Kevin\Projects\rust\base-studio-code"),
            "C--Users-Kevin-Projects-rust-base-studio-code"
        );
        // Consecutive specials (\ then .) each map to their own dash.
        assert_eq!(
            claude_project_dir_name(r"C:\Users\Kevin\.base-studio-code\documents"),
            "C--Users-Kevin--base-studio-code-documents"
        );
    }

    #[test]
    fn ansi_c_quote_escapes_newlines_quotes_and_backslashes() {
        // Newlines collapse to \n so the whole token stays on one physical line;
        // single quotes and backslashes are escaped. $ and backticks pass through
        // literally (ANSI-C quoting does not expand them).
        assert_eq!(
            bash_ansi_c_quote("line1\nit's $HOME `cmd` \\x"),
            "$'line1\\nit\\'s $HOME `cmd` \\\\x'"
        );
    }

    #[test]
    fn parse_github_probe_detects_each_marker_independently() {
        use super::{GH_AUTH_MARK, GH_PATH_MARK, GIT_PATH_MARK};
        // All three markers present -> (gh, git, auth) all true.
        let all = format!("{GIT_PATH_MARK}
{GH_PATH_MARK}
{GH_AUTH_MARK}
");
        assert_eq!(super::parse_github_probe(&all), (true, true, true));
        // Empty output (probe found nothing) -> all false.
        assert_eq!(super::parse_github_probe(""), (false, false, false));
        // git on PATH but gh missing -> gh false, git true, auth false.
        let git_only = format!("{GIT_PATH_MARK}
");
        assert_eq!(super::parse_github_probe(&git_only), (false, true, false));
        // gh present but unauthenticated -> gh true, git true, auth false.
        let no_auth = format!("{GIT_PATH_MARK}
{GH_PATH_MARK}
");
        assert_eq!(super::parse_github_probe(&no_auth), (true, true, false));
    }

    #[test]
    fn interpret_preflight_reports_each_prerequisite() {
        use super::{interpret_preflight, GitBashProbe, GH_AUTH_MARK, PREFLIGHT_MARK};
        // Everything present + authed, on Windows with Git Bash found.
        let stdout = format!(
            "{PREFLIGHT_MARK}\tclaude\t/usr/bin/claude\tclaude 1.2.3\n\
             {PREFLIGHT_MARK}\tgit\t/usr/bin/git\tgit version 2.43.0\n\
             {PREFLIGHT_MARK}\tgh\t/usr/bin/gh\tgh version 2.40.0\n\
             {GH_AUTH_MARK}\n"
        );
        let r = interpret_preflight(&stdout, GitBashProbe::Found("C:\\Git\\bin\\bash.exe".into()));
        // Git Bash first (the console shell), then claude, git, gh, gh auth.
        let names: Vec<&str> = r.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["Git Bash", "claude", "git", "gh", "gh auth"]);
        assert!(r.iter().all(|p| p.found), "all prerequisites should be found");
        assert!(r.iter().all(|p| p.hint.is_empty()), "found tools carry no hint");
        let git = r.iter().find(|p| p.name == "git").unwrap();
        assert_eq!(git.version.as_deref(), Some("git version 2.43.0"));
        assert_eq!(git.path.as_deref(), Some("/usr/bin/git"));
    }

    #[test]
    fn interpret_preflight_flags_missing_tools_with_hints() {
        use super::{interpret_preflight, GitBashProbe, PREFLIGHT_MARK};
        // claude + git present; gh missing (empty path), unauthenticated; Git Bash missing.
        let stdout = format!(
            "{PREFLIGHT_MARK}\tclaude\t/usr/bin/claude\tclaude 1.2.3\n\
             {PREFLIGHT_MARK}\tgit\t/usr/bin/git\tgit version 2.43.0\n\
             {PREFLIGHT_MARK}\tgh\t\t\n"
        );
        let r = interpret_preflight(&stdout, GitBashProbe::Missing);
        let gh = r.iter().find(|p| p.name == "gh").unwrap();
        assert!(!gh.found);
        assert!(gh.hint.contains("cli.github.com"));
        let gh_auth = r.iter().find(|p| p.name == "gh auth").unwrap();
        assert!(!gh_auth.found, "gh missing -> auth cannot be reported found");
        assert!(!gh_auth.hint.is_empty());
        let gitbash = r.iter().find(|p| p.name == "Git Bash").unwrap();
        assert!(!gitbash.found);
        assert!(gitbash.hint.contains("git-scm.com"));
        // Present tools still carry their version/path even when others are missing.
        assert!(r.iter().find(|p| p.name == "claude").unwrap().found);
    }

    #[test]
    fn interpret_preflight_omits_git_bash_off_windows() {
        use super::{interpret_preflight, GitBashProbe};
        let r = interpret_preflight("", GitBashProbe::NotApplicable);
        assert!(!r.iter().any(|p| p.name == "Git Bash"));
        // Empty probe -> every CLI tool reported missing with a hint.
        let names: Vec<&str> = r.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["claude", "git", "gh", "gh auth"]);
        assert!(r.iter().all(|p| !p.found));
        assert!(r.iter().all(|p| !p.hint.is_empty()));
    }

    #[test]
    fn interpret_preflight_gh_auth_requires_gh_present() {
        // A stale GH_AUTH_OK marker must NOT report auth when gh itself is absent.
        use super::{interpret_preflight, GitBashProbe, GH_AUTH_MARK, PREFLIGHT_MARK};
        let stdout = format!("{PREFLIGHT_MARK}\tgh\t\t\n{GH_AUTH_MARK}\n");
        let r = interpret_preflight(&stdout, GitBashProbe::NotApplicable);
        assert!(!r.iter().find(|p| p.name == "gh auth").unwrap().found);
    }

    #[test]
    fn ensure_session_settings_merges_mandatory_and_custom_commands() {
        use super::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-{}", std::process::id()));
        let settings = dir.join(".claude").join("settings.json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        // Seed an existing setting that must be preserved (not clobbered).
        std::fs::write(
            &settings,
            r#"{"model":"claude-sonnet-4-6","permissions":{"allow":["Read"],"deny":["WebSearch"]}}"#,
        ).unwrap();

        write_session_settings(
            &dir.to_string_lossy(),
            &["cargo".into(), "git".into()],
            &["scp".into()],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            false,
        ).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let deny: Vec<String> = v["permissions"]["deny"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        // Pre-existing entries are preserved (merged, not clobbered).
        assert!(allow.contains(&"Read".to_string()));
        assert!(deny.contains(&"WebSearch".to_string()));
        assert_eq!(v["model"], "claude-sonnet-4-6");
        // Bash is allowed broadly (start-and-go) plus explicit gh/git/custom rules.
        assert!(allow.contains(&"Bash".to_string()));
        assert!(allow.contains(&"Bash(gh *)".to_string()));
        assert!(allow.contains(&"Bash(git *)".to_string()));
        assert!(allow.contains(&"Bash(bsc-plan *)".to_string())); // the plan-store CLI (#plan-db)
        assert!(allow.contains(&"Bash(cargo *)".to_string()));
        assert_eq!(allow.iter().filter(|r| *r == "Bash(git *)").count(), 1);
        // Curated dangerous defaults plus the user deny are present.
        assert!(deny.contains(&"Bash(sudo *)".to_string()));
        assert!(deny.contains(&"Bash(rm -rf /*)".to_string()));
        assert!(deny.contains(&"Bash(scp *)".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_writes_ask_tier_for_hard_push_gate() {
        use super::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-ask-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();

        // A hard push-confirm flow (#297) asks before push/PR: the rules land in
        // permissions.ask (deny > ask > allow), so they prompt under the broad Bash allow.
        write_session_settings(
            &dir.to_string_lossy(),
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &["Bash(git push *)".into(), "Bash(gh pr create *)".into()],
            &[],
            false,
        ).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let ask: Vec<String> = v["permissions"]["ask"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(ask.contains(&"Bash(git push *)".to_string()));
        assert!(ask.contains(&"Bash(gh pr create *)".to_string()));
        // Bash stays broadly allowed; ask only narrows the two push writes.
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(allow.contains(&"Bash".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_merges_verbatim_tool_rules() {
        use super::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-tool-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();

        // The role write-path guard: deny every write tool (planner/director/triage),
        // and auto-approve a worker's boundary glob.
        write_session_settings(
            &dir.to_string_lossy(),
            &[],
            &[],
            &[],
            &[],
            &["Edit(src/auth/**)".into(), "Write(src/auth/**)".into()],
            &["Edit".into(), "Write".into(), "MultiEdit".into(), "NotebookEdit".into()],
            &[],
            &[],
            false,
        ).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let deny: Vec<String> = v["permissions"]["deny"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        // Tool rules land verbatim — NOT wrapped in Bash(...).
        assert!(allow.contains(&"Edit(src/auth/**)".to_string()));
        assert!(allow.contains(&"Write(src/auth/**)".to_string()));
        assert!(!allow.iter().any(|r| r.contains("Bash(Edit")));
        assert!(deny.contains(&"Edit".to_string()));
        assert!(deny.contains(&"Write".to_string()));
        assert!(deny.contains(&"MultiEdit".to_string()));
        assert!(deny.contains(&"NotebookEdit".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_replace_drops_removed_permissions() {
        use super::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-replace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        let cwd = dir.to_string_lossy();
        let read = || -> Vec<String> {
            let v: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
            v["permissions"]["allow"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
        };

        // First pass grants a custom command (merge mode).
        write_session_settings(&cwd, &["cargo".into()], &[], &[], &[], &[], &[], &[], &[], false).unwrap();
        assert!(read().contains(&"Bash(cargo *)".to_string()));

        // Re-apply with the command REMOVED — replace mode must drop it (merge would keep it).
        write_session_settings(&cwd, &[], &[], &[], &[], &[], &[], &[], &[], true).unwrap();
        let allow = read();
        assert!(!allow.contains(&"Bash(cargo *)".to_string()), "replace must drop the removed command (#799)");
        assert!(allow.contains(&"Bash".to_string()), "but the broad Bash allow is recomputed");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_writes_mcp_servers_and_hooks() {
        let dir = std::env::temp_dir().join(format!("bsc-ext-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let mcp = vec![
            super::McpServerCfg {
                name: "filesystem".into(), transport: "stdio".into(),
                command: Some("npx".into()), args: vec!["-y".into(), "@mcp/fs".into()],
                url: None, env: vec![("ROOT".into(), "/tmp".into())],
            },
            super::McpServerCfg {
                name: "sentry".into(), transport: "http".into(),
                command: None, args: vec![], url: Some("https://mcp.sentry.dev/sse".into()), env: vec![],
            },
        ];
        let hooks = vec![super::HookCfg {
            event: "PostToolUse".into(), matcher: "Write|Edit".into(), command: "format.sh".into(),
        }];
        super::write_session_settings(&dir.to_string_lossy(), &[], &[], &mcp, &hooks, &[], &[], &[], &[], false).unwrap();

        // .mcp.json carries both servers in the right transport shapes.
        let mcp_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(mcp_json["mcpServers"]["filesystem"]["command"], "npx");
        assert_eq!(mcp_json["mcpServers"]["filesystem"]["args"][1], "@mcp/fs");
        assert_eq!(mcp_json["mcpServers"]["filesystem"]["env"]["ROOT"], "/tmp");
        assert_eq!(mcp_json["mcpServers"]["sentry"]["type"], "http");
        assert_eq!(mcp_json["mcpServers"]["sentry"]["url"], "https://mcp.sentry.dev/sse");

        // settings.json gates the servers + carries the hook grouped by event.
        let settings: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let enabled: Vec<String> = settings["enabledMcpjsonServers"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(enabled.contains(&"filesystem".to_string()) && enabled.contains(&"sentry".to_string()));
        assert_eq!(settings["hooks"]["PostToolUse"][0]["matcher"], "Write|Edit");
        assert_eq!(settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"], "format.sh");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_mcp_command_substitutes_research_marker(){
        use std::path::PathBuf;
        // A normal command is untouched.
        assert_eq!(super::resolve_mcp_command("npx", None), "npx");
        assert_eq!(
            super::resolve_mcp_command("npx", Some(PathBuf::from("/x/bsc-research-mcp"))),
            "npx",
        );
        // The Research marker resolves to the bundled binary's absolute path when present…
        let bin = PathBuf::from("/opt/app/bsc-research-mcp");
        assert_eq!(super::resolve_mcp_command("bsc-research-mcp", Some(bin.clone())), bin.to_string_lossy());
        // …and falls back to the bare marker when the bundled binary can't be located (dev build).
        assert_eq!(super::resolve_mcp_command("bsc-research-mcp", None), "bsc-research-mcp");
    }

    #[test]
    fn write_session_skills_writes_skill_files() {
        let dir = std::env::temp_dir().join(format!("bsc-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let skills = vec![
            super::SkillCfg {
                name: "Open a clean PR".into(),
                description: "Open a tidy pull request".into(),
                prompt: "Do the PR steps.".into(),
                tools: vec!["create_pr".into(), "git_diff".into()],
            },
            super::SkillCfg {
                name: "Review Docs".into(),
                description: "Review the docs".into(),
                prompt: "Check the docs.".into(),
                tools: vec![],
            },
        ];
        super::write_session_skills(&dir, &skills).unwrap();

        // First skill: slugged dir, frontmatter with name/description/allowed-tools, body.
        let a = std::fs::read_to_string(
            dir.join(".claude").join("skills").join("open-a-clean-pr").join("SKILL.md"),
        ).unwrap();
        assert!(a.starts_with("---\n"));
        assert!(a.contains("name: \"Open a clean PR\"\n"));
        assert!(a.contains("description: \"Open a tidy pull request\"\n"));
        assert!(a.contains("allowed-tools: \"create_pr, git_diff\"\n"));
        assert!(a.contains("Do the PR steps."));

        // Second skill: no tools → no allowed-tools line, body still present.
        let b = std::fs::read_to_string(
            dir.join(".claude").join("skills").join("review-docs").join("SKILL.md"),
        ).unwrap();
        assert!(b.contains("name: \"Review Docs\"\n"));
        assert!(b.contains("description: \"Review the docs\"\n"));
        assert!(!b.contains("allowed-tools:"));
        assert!(b.contains("Check the docs."));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_preserves_ascii_alphanumerics_and_dash() {
        assert_eq!(sanitize_project_key("my-project-123"), "my-project-123");
    }

    #[test]
    fn sanitize_replaces_punctuation_and_whitespace_with_underscore() {
        // Slashes, spaces, colons, dots → '_'.
        assert_eq!(sanitize_project_key("acme/api"), "acme_api");
        assert_eq!(sanitize_project_key("title::pitch"), "title__pitch");
        assert_eq!(sanitize_project_key("Studio Code v2.0"), "Studio_Code_v2_0");
    }

    #[test]
    fn sanitize_preserves_github_project_node_id() {
        // Project v2 node ids (underscores stay underscores, dash stays) are ASCII-safe.
        assert_eq!(sanitize_project_key("PVT_kwHOA_-LFc4BYsJC"), "PVT_kwHOA_-LFc4BYsJC");
    }

    #[test]
    fn sanitize_drops_unicode_letters_to_match_js_regex() {
        // The frontend's /[^a-zA-Z0-9-]/ is ASCII-only; café → caf_ (not café),
        // so the PTY id and planning directory stay byte-for-byte identical.
        assert_eq!(sanitize_project_key("café"), "caf_");
    }

    #[test]
    fn sanitize_truncates_to_80_chars() {
        let long = "a".repeat(200);
        assert_eq!(sanitize_project_key(&long).len(), 80);
    }

    #[test]
    fn project_dir_places_the_sanitized_key_directly_under_projects() {
        // Every hub lives at projects/<key> for life (#922) — no draft/ root, no documents/ prefix.
        let p = super::project_dir("studio-code").to_string_lossy().replace('\\', "/");
        assert!(p.ends_with("/projects/studio-code"), "got {p}");
        assert!(!p.contains("/documents/"), "got {p}");
        let s = super::project_dir("acme/api project").to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("/projects/acme_api_project"), "got {s}");
    }

    #[test]
    fn mark_published_writes_an_in_place_marker_read_by_is_published() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("marker");
        let key = "publish-me";
        // A live hub with a plan file (simulating the planner's cwd) — never moved.
        write_file(&super::project_dir(key).join("goal.md"), "# goal");
        assert!(!super::is_published(key), "a fresh hub is a draft");

        super::mark_published(key.to_string()).unwrap();
        assert!(super::is_published(key), "marker present after mark_published");
        assert!(super::project_dir(key).join(".published").is_file());
        // The hub did not move: its files stay put (so the planner's cwd + Claude history survive).
        assert!(super::project_dir(key).join("goal.md").exists(), "files stay in place");
        // Idempotent.
        super::mark_published(key.to_string()).unwrap();
        assert!(super::is_published(key));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn migration_consolidates_draft_hubs_and_clears_empty_published_shells() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("migrate");
        let draft_root = super::bsc_base_dir().join("draft");

        // (1) A plain draft → moved into projects/.
        write_file(&draft_root.join("plain").join("goal.md"), "# plain goal");
        // (2) The overdrive case: real hub in draft/, empty shell in projects/ → shell cleared, hub wins.
        write_file(&draft_root.join("overdrive").join("CLAUDE.md"), "spec");
        std::fs::create_dir_all(super::project_dir("overdrive").join("prompts")).unwrap();
        // (3) A real published hub colliding with a stale same-key draft → published kept, draft dropped.
        write_file(&super::project_dir("shipped").join("CLAUDE.md"), "published spec");
        write_file(&draft_root.join("shipped").join("goal.md"), "stale draft");

        super::migrate_draft_hubs_into_projects();

        // (1) consolidated.
        assert!(super::project_dir("plain").join("goal.md").exists(), "plain draft moved into projects/");
        // (2) the real overdrive hub replaced the empty shell.
        assert!(super::project_dir("overdrive").join("CLAUDE.md").exists(), "real overdrive hub moved in");
        assert!(!super::project_dir("overdrive").join("prompts").exists(), "empty shell cleared");
        // (3) published kept, stale draft content not clobbered in.
        assert_eq!(std::fs::read_to_string(super::project_dir("shipped").join("CLAUDE.md")).unwrap(), "published spec");
        // draft/ root retired.
        assert!(!draft_root.exists(), "draft/ root removed after migration");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn ingest_section_files_reads_both_dirs_and_context_wins() {
        use std::collections::HashMap;
        let root = std::env::temp_dir().join(format!("bsc-ingest-{}", std::process::id()));
        let context = root.join("context");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&context).unwrap();

        // Hub root: a manifest (json) + a stale flat copy of `stack` + a control file.
        std::fs::write(root.join("phases.json"), r#"{"phases":[]}"#).unwrap();
        std::fs::write(root.join("stack.md"), "OLD flat stack").unwrap();
        std::fs::write(root.join("CLAUDE.md"), "the planner spec").unwrap();
        // An empty section is a created-but-unwritten ghost and must be dropped.
        std::fs::write(root.join("empty.md"), "   \n").unwrap();
        // context/: the discovery sections (one shadows the stale root `stack`).
        std::fs::write(context.join("goal.md"), "ship it").unwrap();
        std::fs::write(context.join("stack.md"), "NEW context stack").unwrap();

        let mut sections: HashMap<String, String> = HashMap::new();
        super::ingest_section_files(&root, &mut sections);
        super::ingest_section_files(&context, &mut sections);

        assert_eq!(sections.get("phases").map(String::as_str), Some(r#"{"phases":[]}"#));
        assert_eq!(sections.get("goal").map(String::as_str), Some("ship it"));
        // context/ is ingested last, so its section wins over the stale flat copy.
        assert_eq!(sections.get("stack").map(String::as_str), Some("NEW context stack"));
        // Control files and empty sections never become sections.
        assert!(!sections.contains_key("CLAUDE"));
        assert!(!sections.contains_key("empty"));

        let _ = std::fs::remove_dir_all(&root);
    }

    use super::level_color;

    #[test]
    fn level_color_is_distinct_per_level() {
        let colors = [
            level_color(log::Level::Error),
            level_color(log::Level::Warn),
            level_color(log::Level::Info),
            level_color(log::Level::Debug),
            level_color(log::Level::Trace),
        ];
        // every code is a non-empty ANSI escape, and all five are distinct
        assert!(colors.iter().all(|c| c.starts_with("\x1b[")));
        let unique: std::collections::HashSet<_> = colors.iter().collect();
        assert_eq!(unique.len(), colors.len());
    }

    use super::has_claude_history;

    #[test]
    fn has_claude_history_detects_jsonl_in_project_dir() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = temp_home("history");
        let cwd = r"C:\Users\Kevin\Projects\demo";
        let proj = home.join(".claude").join("projects").join(claude_project_dir_name(cwd));

        // No project dir yet → fresh launch.
        assert!(!has_claude_history(cwd));

        // Dir exists but holds no conversation → still fresh.
        std::fs::create_dir_all(&proj).unwrap();
        write_file(&proj.join("config.json"), "{}");
        assert!(!has_claude_history(cwd));

        // A conversation transcript is present → resume is safe.
        write_file(&proj.join("abc-123.jsonl"), "{}\n");
        assert!(has_claude_history(cwd));

        // Empty cwd is never resumable.
        assert!(!has_claude_history(""));
    }

    #[test]
    fn bsc_agent_session_path_keys_off_cwd() {
        // Deterministic per-cwd path under agent-sessions/, slugged like Claude's projects dir.
        let _guard = ENV_LOCK.lock().unwrap();
        let _home = temp_home("agentsess-path");
        let cwd = r"C:\Users\Kevin\Projects\demo";
        let p = super::bsc_agent_session_path(cwd).unwrap();
        assert!(p.ends_with("conversation.json"));
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.contains("/agent-sessions/"));
        assert!(s.contains(&claude_project_dir_name(cwd)));
        // Empty cwd ⇒ no path (no persistence).
        assert!(super::bsc_agent_session_path("").is_none());
    }

    #[test]
    fn has_bsc_agent_history_requires_nonempty_session_file() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _home = temp_home("agentsess-hist");
        let cwd = r"C:\Users\Kevin\Projects\demo";
        let path = super::bsc_agent_session_path(cwd).unwrap();

        // No file yet → fresh.
        assert!(!super::has_bsc_agent_history(cwd));

        // Empty file → still fresh (an aborted/empty run shouldn't trigger resume).
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        write_file(&path, "");
        assert!(!super::has_bsc_agent_history(cwd));

        // Non-empty conversation → resume is safe.
        write_file(&path, "[{\"User\":\"hi\"}]");
        assert!(super::has_bsc_agent_history(cwd));

        // Empty cwd is never resumable.
        assert!(!super::has_bsc_agent_history(""));
    }

    #[test]
    fn worktree_audit_commands_tolerate_empty_cwd() {
        // The per-worker audit snapshot (#920) must never panic on a missing/blank cwd —
        // it just yields nothing so the UI shows "no data" rather than crashing.
        assert!(super::read_worktree_branch(String::new()).is_empty());
        assert!(super::read_worktree_branch("   ".into()).is_empty());
        assert!(super::read_worktree_commits(String::new(), 10).is_empty());
        assert!(super::read_worktree_commits("   ".into(), 10).is_empty());
        assert!(super::claude_transcript_path(String::new()).is_none());
        assert!(super::find_branch_pr(String::new(), "branch".into()).is_none());
        assert!(super::find_branch_pr("owner/repo".into(), String::new()).is_none());
    }

    #[test]
    fn merge_change_lists_dedupes_and_sorts() {
        let merged = super::merge_change_lists(
            vec!["src/b.ts".into(), "src/a.ts".into(), "src/b.ts".into()],
            vec!["new.ts".into(), "src/a.ts".into()],
        );
        assert_eq!(merged, vec!["new.ts", "src/a.ts", "src/b.ts"]);
        // Empty inputs yield an empty set.
        assert!(super::merge_change_lists(vec![], vec![]).is_empty());
    }

    #[test]
    fn read_worktree_changes_empty_cwd_is_empty() {
        assert!(super::read_worktree_changes(String::new()).is_empty());
        assert!(super::read_worktree_changes("   ".into()).is_empty());
    }

    /// Regression (#1102): in a linked worktree `.git` is a FILE, so the old
    /// `repo_root/.git/info/exclude` write silently failed and `.mcp.json` leaked into the worker's
    /// diff — quarantining every fleet worker for an "out-of-lane" edit it never made. git_exclude
    /// must resolve the real (common-dir) exclude so the app-managed file is hidden from git, and
    /// thus from read_worktree_changes (the warden's trusted signal).
    #[test]
    fn git_exclude_hides_mcp_json_in_a_worktree() {
        // Needs the git binary; skip gracefully where it's absent rather than failing the suite.
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let base = std::env::temp_dir().join(format!("bsc-gx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let main = base.join("main");
        std::fs::create_dir_all(&main).unwrap();
        let git = |cwd: &std::path::Path, args: &[&str]| {
            std::process::Command::new("git").arg("-C").arg(cwd).args(args).output().unwrap()
        };
        git(&main, &["init", "-q"]);
        git(&main, &["config", "user.email", "t@t.t"]);
        git(&main, &["config", "user.name", "t"]);
        std::fs::write(main.join("README.md"), "x").unwrap();
        git(&main, &["add", "-A"]);
        git(&main, &["commit", "-qm", "init"]);

        // A linked worktree: its `.git` is a FILE, the layout that broke the old exclude.
        let wt = base.join("wt");
        git(&main, &["worktree", "add", "-q", wt.to_str().unwrap()]);
        assert!(wt.join(".git").is_file(), "worktree .git should be a file, not a dir");

        // App writes the session's MCP config + asks git to exclude it (mirrors the launch path).
        std::fs::write(wt.join(".mcp.json"), "{}").unwrap();
        super::git_exclude(&wt, ".mcp.json");

        // The warden's signal must NOT see it — pre-fix this listed ".mcp.json" and tripped a trip.
        let changes = super::read_worktree_changes(wt.to_string_lossy().into_owned());
        assert!(
            !changes.iter().any(|f| f == ".mcp.json"),
            "worktree .mcp.json must be git-excluded, but read_worktree_changes returned {changes:?}",
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn clear_project_plan_files_removes_md_and_json_only() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("cpf");
        let key = "test-plan-clear".to_string();
        let proj = super::bsc_base_dir().join("projects").join(&key);
        let sub = proj.join("my-repo");
        std::fs::create_dir_all(&sub).unwrap();
        write_file(&proj.join("goal.md"), "goal");
        write_file(&proj.join("phases.json"), "[]");
        write_file(&sub.join("README.md"), "# repo"); // inside subdir -- preserved
        // a generated UI skeleton that must be wiped too (#650)
        let skel = proj.join(".ui-skeleton");
        std::fs::create_dir_all(&skel).unwrap();
        write_file(&skel.join("Home.jsx"), "export default () => null");

        let removed = super::clear_project_plan_files(key.clone()).unwrap();
        assert_eq!(removed, 3, "goal.md + phases.json + .ui-skeleton removed");
        assert!(!proj.join("goal.md").exists());
        assert!(!proj.join("phases.json").exists());
        assert!(!skel.exists(), ".ui-skeleton dir wiped");
        assert!(sub.join("README.md").exists(), "subdir entry preserved");

        // Missing project -> Ok(0), no panic.
        let n = super::clear_project_plan_files("no-such-bsc-cpf-key".to_string()).unwrap();
        assert_eq!(n, 0);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn clear_project_plan_files_empties_the_plan_db() {
        // The plan now lives in plan.db, not files — clearing must empty it too, or the next poll
        // re-reads the DB and the plan reappears (#plan-db).
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("cpfdb");
        let key = "test-clear-plan-db".to_string();
        let db = super::project_dir(&key).join("plan.db");
        {
            let store = plandb::Store::open(&db).unwrap();
            store.upsert(&plandb::PlanIssue { r#ref: "F1".into(), title: "issue".into(), ..Default::default() }).unwrap();
            store.feature_upsert(&plandb::PlanFeature { name: "Feature".into(), ..Default::default() }).unwrap();
        }
        super::clear_project_plan_files(key.clone()).unwrap();
        let store = plandb::Store::open(&db).unwrap();
        assert!(store.list(None, None).unwrap().is_empty(), "issues cleared from the DB");
        assert!(store.feature_list().unwrap().is_empty(), "features cleared from the DB");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn blueprint_storage_round_trips_and_stays_in_its_dir() {
        // User blueprints live as files under ~/.base-studio-code/blueprints/ (#blueprints).
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("bp");
        super::write_blueprint("bp-1".into(), r#"{"id":"bp-1","name":"Mine"}"#.into()).unwrap();
        super::write_blueprint("bp-2".into(), r#"{"id":"bp-2","name":"Other"}"#.into()).unwrap();
        let all = super::list_blueprints();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|s| s.contains("Mine")));
        super::delete_blueprint("bp-1".into()).unwrap();
        let after = super::list_blueprints();
        assert_eq!(after.len(), 1);
        assert!(after.iter().all(|s| !s.contains("Mine")), "deleted blueprint is gone");
        // A slashy/dotty id is slugified (`.`/`/` → `_`) so it can never escape the blueprints dir,
        // and an empty id is rejected outright.
        let escaped = super::blueprint_file("../../etc/passwd").unwrap();
        assert!(escaped.starts_with(super::bsc_base_dir().join("blueprints")), "must stay under blueprints/");
        assert!(super::blueprint_file("").is_err());
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn list_local_projects_surfaces_on_disk_unpublished_projects() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("llp");
        let root = super::bsc_base_dir().join("projects");
        // A real project: goal.md drives the title (first sentence, heading stripped).
        write_file(&root.join("monkeys-paw").join("goal.md"), "# A wish-granting app.\n\nmore");
        // A project with only CLAUDE.md still counts as has_plan, title falls back to humanized key.
        write_file(&root.join("artist_portfolio").join("CLAUDE.md"), "spec");
        // A bare scaffold dir (no plan artifacts) is listed but flagged has_plan=false.
        std::fs::create_dir_all(root.join("empty-scaffold").join("prompts")).unwrap();

        let found = super::list_local_projects().unwrap();
        let by = |k: &str| found.iter().find(|p| p.key == k);
        assert_eq!(by("monkeys-paw").unwrap().title, "A wish-granting app");
        assert!(by("monkeys-paw").unwrap().has_plan);
        assert_eq!(by("artist_portfolio").unwrap().title, "artist portfolio");
        assert!(by("artist_portfolio").unwrap().has_plan);
        assert!(!by("empty-scaffold").unwrap().has_plan, "bare scaffold flagged has_plan=false");

        // The wire format MUST be camelCase — Tauri doesn't rename return fields, and the
        // frontend reads `hasPlan`/`updatedAt`. snake_case here silently hides every project (#789).
        let json = serde_json::to_string(by("monkeys-paw").unwrap()).unwrap();
        assert!(json.contains("\"hasPlan\""), "expected camelCase hasPlan in {json}");
        assert!(json.contains("\"updatedAt\""), "expected camelCase updatedAt in {json}");
        assert!(!json.contains("has_plan") && !json.contains("updated_at"), "must not emit snake_case: {json}");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn delete_project_dir_removes_a_dir_with_a_read_only_file() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("dpd");
        let key = "doomed-proj".to_string();
        let proj = super::bsc_base_dir().join("projects").join(&key);
        // Simulate a cloned repo's read-only git pack file — the Windows delete failure mode.
        let f = proj.join("repo").join("objects").join("pack.idx");
        write_file(&f, "packdata");
        let mut perms = std::fs::metadata(&f).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&f, perms).unwrap();

        super::delete_project_dir(key).unwrap();
        assert!(!proj.exists(), "project dir (incl. read-only files) should be deleted");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn project_file_write_then_read_roundtrips_and_blocks_escape() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("ppf");
        let key = "test-pipeline-files".to_string();

        // Write nested under a pipeline subdir, then read the subdir back.
        super::write_project_file(key.clone(), "pipelines/vue/button.vue".to_string(), "<template/>".to_string()).unwrap();
        super::write_project_file(key.clone(), "pipelines/vue/card.vue".to_string(), "<card/>".to_string()).unwrap();
        // A fresh project's hub is the draft hub (#904) — resolve, don't hardcode projects/.
        let proj = super::project_dir(&key);
        assert!(proj.join("pipelines").join("vue").join("button.vue").exists());

        let mut files = super::read_project_files(key.clone(), "pipelines/vue".to_string());
        files.sort();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].0, "button.vue");
        assert_eq!(files[0].1, "<template/>");

        // Escapes are rejected on write and yield empty on read.
        assert!(super::write_project_file(key.clone(), "../escape.txt".to_string(), "x".to_string()).is_err());
        assert!(super::write_project_file(key.clone(), "/abs.txt".to_string(), "x".to_string()).is_err());
        assert!(super::write_project_file(key.clone(), "  ".to_string(), "x".to_string()).is_err());
        assert!(super::read_project_files(key.clone(), "../..".to_string()).is_empty());

        // Missing subdir -> empty, no panic.
        assert!(super::read_project_files(key.clone(), "pipelines/none".to_string()).is_empty());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn inject_skills_inlines_hub_skills_idempotently() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("injectskills");
        let hub = home.join("hub");
        std::fs::create_dir_all(&hub).unwrap();
        let wt_local = home.join("CLAUDE.local.md");
        std::fs::write(&wt_local, "# repo plan\n").unwrap();

        // No skills.md ⇒ no-op.
        super::inject_skills(&hub, &wt_local);
        assert_eq!(std::fs::read_to_string(&wt_local).unwrap(), "# repo plan\n");

        // With skills.md ⇒ inlined under its heading.
        std::fs::write(hub.join("skills.md"), "# Attached skills & knowledge\n\n### Auth\nUse OAuth.\n").unwrap();
        super::inject_skills(&hub, &wt_local);
        let after = std::fs::read_to_string(&wt_local).unwrap();
        assert!(after.contains("# repo plan"), "keeps the plan");
        assert!(after.contains("Use OAuth."), "inlines the skills");

        // Second call ⇒ idempotent (not appended twice).
        super::inject_skills(&hub, &wt_local);
        assert_eq!(after, std::fs::read_to_string(&wt_local).unwrap());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn worker_context_appends_injection_resistance_idempotently() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("injresist");
        let wt = home.join("wt");
        let clone = home.join("clone");
        let hub = home.join("hub");
        for d in [&wt, &clone, &hub] { std::fs::create_dir_all(d).unwrap(); }

        super::write_worker_context(&wt, &clone, &hub, Some("# scope: owns src/api/**"));
        let md = std::fs::read_to_string(wt.join("CLAUDE.local.md")).unwrap();
        assert!(md.contains("# scope: owns src/api/**"), "keeps the worker scope");
        assert!(md.contains(super::INJECTION_RESISTANCE_MARKER), "appends the injection-resistance preamble");
        assert!(md.contains("untrusted data"), "carries the untrusted-input rule");

        // Re-running converges (the preamble isn't appended twice).
        super::write_worker_context(&wt, &clone, &hub, Some("# scope: owns src/api/**"));
        let again = std::fs::read_to_string(wt.join("CLAUDE.local.md")).unwrap();
        assert_eq!(again.matches(super::INJECTION_RESISTANCE_MARKER).count(), 1, "preamble appears once");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn director_protocol_includes_injection_resistance() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("dirproto");
        let key = "proj-dir".to_string();
        super::ensure_director_protocol(key.clone()).unwrap();
        let md = std::fs::read_to_string(super::project_dir(&key).join("CLAUDE.local.md")).unwrap();
        assert!(md.contains("## Director protocol"), "director protocol present");
        assert!(md.contains(super::INJECTION_RESISTANCE_MARKER), "director also gets the injection-resistance preamble");
        // Idempotent — a second ensure doesn't duplicate either section.
        super::ensure_director_protocol(key.clone()).unwrap();
        let again = std::fs::read_to_string(super::project_dir(&key).join("CLAUDE.local.md")).unwrap();
        assert_eq!(again.matches(super::INJECTION_RESISTANCE_MARKER).count(), 1);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn mcp_install_dir_slugifies_and_stays_under_mcp_root() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("mcpdir");
        let root = super::bsc_base_dir().join("mcp");
        // A normal repo name lands directly under mcp/.
        assert_eq!(super::mcp_install_dir("compliance-mcp-server").unwrap(), root.join("compliance-mcp-server"));
        // Path separators are slugified to `_`, so a traversal attempt collapses to a single
        // literal dir name DIRECTLY under mcp/ — it can't escape (the `..` substring that
        // survives is just part of a leaf filename, not a real parent ref).
        let evil = super::mcp_install_dir("../../etc/passwd").unwrap();
        assert_eq!(evil.parent(), Some(root.as_path()), "must be a direct child of mcp/: {evil:?}");
        let leaf = evil.file_name().unwrap().to_string_lossy();
        assert!(!leaf.contains('/') && !leaf.contains('\\'), "no separators survive the slug: {leaf}");
        // Empty / dot names are rejected.
        assert!(super::mcp_install_dir("").is_err());
        assert!(super::mcp_install_dir(".").is_err());
        assert!(super::mcp_install_dir("..").is_err());
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn mcp_build_command_detects_the_toolchain() {
        let base = std::env::temp_dir().join(format!("bsc-mcpbuild-{}", std::process::id()));
        let uv = base.join("uv");
        let pnpm = base.join("pnpm");
        let npm = base.join("npm");
        let none = base.join("none");
        for d in [&uv, &pnpm, &npm, &none] {
            std::fs::create_dir_all(d).unwrap();
        }
        // Python/uv project → `python -m uv sync` (module form — no PATH dependency, #887).
        std::fs::write(uv.join("pyproject.toml"), "[project]\nname='x'\n").unwrap();
        assert_eq!(super::mcp_build_command(&uv).as_deref(), Some("python -m uv sync"));
        // pnpm project → pnpm install && build (a package.json is also present, but the
        // pnpm lockfile wins over the npm fallback).
        std::fs::write(pnpm.join("package.json"), "{}").unwrap();
        std::fs::write(pnpm.join("pnpm-lock.yaml"), "lockfileVersion: 9\n").unwrap();
        assert_eq!(super::mcp_build_command(&pnpm).as_deref(), Some("pnpm install && pnpm build"));
        // Plain Node project → npm fallback.
        std::fs::write(npm.join("package.json"), "{}").unwrap();
        assert_eq!(super::mcp_build_command(&npm).as_deref(), Some("npm install && npm run build"));
        // Unknown toolchain → None.
        assert_eq!(super::mcp_build_command(&none), None);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn mcp_status_of_reports_downloaded_and_built() {
        let base = std::env::temp_dir().join(format!("bsc-mcpstatus-{}", std::process::id()));
        let dir = base.join("srv");
        std::fs::create_dir_all(&dir).unwrap();
        // Nothing yet → neither downloaded nor built.
        assert_eq!(super::mcp_status_of(&dir), (false, false));
        // A clone (.git) → downloaded, not built.
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        assert_eq!(super::mcp_status_of(&dir), (true, false));
        // A build artifact (node_modules) → built. (dist / .venv count too.)
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        assert_eq!(super::mcp_status_of(&dir), (true, true));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn mcp_update_available_compares_heads() {
        // Differing non-empty shas → update available; equal → none; empty (unknown) → none.
        assert!(super::mcp_update_available("aaaa", "bbbb"));
        assert!(!super::mcp_update_available("aaaa", "aaaa"));
        assert!(!super::mcp_update_available("aaaa", ""));
        assert!(!super::mcp_update_available("", "bbbb"));
        // Trims surrounding whitespace before comparing.
        assert!(!super::mcp_update_available(" aaaa\n", "aaaa"));
    }

    #[test]
    fn worktrees_dir_is_outside_the_project_hub() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("wtdir");
        let key = "my-proj";
        let wts = super::worktrees_dir(key);
        let hub = super::project_dir(key);
        // The whole point of #844: a worker's worktree is NOT under the hub, so the hub's
        // planner CLAUDE.md is not an ancestor of the worker's cwd.
        assert!(wts.starts_with(super::bsc_base_dir().join("worktrees")), "got {wts:?}");
        assert!(!wts.starts_with(&hub), "worktrees must not be under the hub: {wts:?} ⊄ {hub:?}");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn write_worker_context_leads_with_scope_then_repo_ctx_protocol_skills() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("workerctx");
        let wt = home.join("wt");
        let clone = home.join("clone");
        let hub = home.join("hub");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(&clone).unwrap();
        std::fs::create_dir_all(&hub).unwrap();
        // Per-repo app-managed context (untracked in the clone) + attached skills at the hub.
        std::fs::write(clone.join("CLAUDE.local.md"), "# repo notes\nUse the shared client.\n").unwrap();
        std::fs::write(hub.join("skills.md"), "# Attached skills & knowledge\n\n### Auth\nUse OAuth.\n").unwrap();

        let scope = "# Your scope\n\nYou own `src/auth/**`. Issues: #12, #13.";
        super::write_worker_context(&wt, &clone, &hub, Some(scope));
        let out = std::fs::read_to_string(wt.join("CLAUDE.local.md")).unwrap();

        // Scope leads, then per-repo context, then protocol, then skills — in that order.
        let i_scope = out.find("You own `src/auth/**`").expect("scope present");
        let i_repo = out.find("Use the shared client").expect("repo ctx present");
        let i_proto = out.find("## Fleet coordination protocol").expect("protocol present");
        let i_skills = out.find("Use OAuth.").expect("skills inlined");
        assert!(i_scope < i_repo, "scope must lead the per-repo context");
        assert!(i_repo < i_proto, "per-repo context must precede the protocol");
        assert!(i_proto < i_skills, "protocol must precede the skills");
        // The full planner spec is NOT here — only the worker's scope.
        assert!(!out.contains("Project Planner"), "must not carry the planner spec");

        // Idempotent: a second launch converges to identical content (protocol/skills not doubled).
        super::write_worker_context(&wt, &clone, &hub, Some(scope));
        assert_eq!(out, std::fs::read_to_string(wt.join("CLAUDE.local.md")).unwrap());
        assert_eq!(out.matches("## Fleet coordination protocol").count(), 1);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn delete_project_dir_removes_relocated_worktrees() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("dpdwt");
        let key = "doomed-with-wt".to_string();
        // A hub file and a relocated worktree with a (Windows-hostile) read-only file.
        write_file(&super::project_dir(&key).join("goal.md"), "# goal");
        let wt_file = super::worktrees_dir(&key).join("web--auth").join("src").join("x.rs");
        write_file(&wt_file, "fn main() {}");
        let mut perms = std::fs::metadata(&wt_file).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&wt_file, perms).unwrap();

        super::delete_project_dir(key.clone()).unwrap();
        assert!(!super::project_dir(&key).exists(), "hub should be deleted");
        assert!(!super::worktrees_dir(&key).exists(), "relocated worktrees should be deleted too");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn dead_code_cmd_allowlists_known_scanners_only() {
        assert!(super::dead_code_cmd("depcheck").is_some());
        assert!(super::dead_code_cmd("ts-prune").is_some());
        assert!(super::dead_code_cmd("cargo-machete").is_some());
        // arbitrary commands are never runnable
        assert!(super::dead_code_cmd("rm").is_none());
        assert!(super::dead_code_cmd("cargo machete; rm -rf /").is_none());
        assert!(super::dead_code_cmd("").is_none());
    }

    #[test]
    fn scan_dead_code_handles_bad_dir_and_unknown_tool() {
        let bad = super::scan_dead_code("/no/such/dir/xyzzy".to_string(), "depcheck".to_string());
        assert!(!bad.ran && bad.error.is_some());
        let unknown = super::scan_dead_code(".".to_string(), "totally-unknown".to_string());
        assert!(!unknown.ran && unknown.error.as_deref().unwrap_or("").contains("unknown scanner"));
    }

    #[test]
    fn write_project_file_bytes_decodes_base64_and_blocks_escape() {
        use base64::Engine;
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("ppfb");
        let key = "test-intake".to_string();

        // Stage a "binary" file (raw bytes, incl. a NUL) from base64.
        let bytes: &[u8] = &[0x89, b'P', b'N', b'G', 0x00, 0xFF, 0x10];
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        super::write_project_file_bytes(key.clone(), ".intake/logo.png".to_string(), b64).unwrap();
        let path = super::project_dir(&key).join(".intake").join("logo.png");
        assert!(path.exists());
        assert_eq!(std::fs::read(&path).unwrap(), bytes, "bytes round-trip exactly");

        // Bad base64 + path escapes are rejected.
        assert!(super::write_project_file_bytes(key.clone(), ".intake/x.png".to_string(), "not base64!!".to_string()).is_err());
        assert!(super::write_project_file_bytes(key.clone(), "../escape.png".to_string(), "AAAA".to_string()).is_err());
        assert!(super::write_project_file_bytes(key.clone(), "/abs.png".to_string(), "AAAA".to_string()).is_err());

        std::fs::remove_dir_all(&home).ok();
    }
}
