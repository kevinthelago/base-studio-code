use crate::*;

/// Mark a project published (#922): write `projects/<key>/.published`. Unlike the old promote-rename,
/// this is a file-create INSIDE the hub — allowed even while the planner holds the hub as its cwd,
/// instant, and the cwd never changes so Claude's `--continue` history survives. Idempotent.
///
/// The create-dir + marker-write is delegated to `bsc_project::mark_published` (#1761) so the
/// `.published` logic lives in ONE place, shared with the `bsc-project` session CLI. The key is
/// sanitized here (the app boundary) before delegating, since the crate treats it as opaque.
#[tauri::command]
pub(crate) fn mark_published(project_key: String) -> Result<(), String> {
    let key = sanitize_project_key(&project_key);
    if key.is_empty() {
        return Err("mark_published: empty project_key".into());
    }
    bsc_project::mark_published(&key)?;
    log::info!("marked project published: {:?}", project_dir(&project_key));
    Ok(())
}
/// Delete a project's on-disk hub (`projects/<sanitized-key>`) and everything in
/// it — plan sections, prompts, cloned repos. Best-effort: a missing dir is fine.
/// Refuses an empty key so it can never wipe the `projects/` root.
#[tauri::command]
pub(crate) fn delete_project_dir(project_key: String, pty: tauri::State<'_, crate::pty::PtyState>) -> Result<(), String> {
    delete_project_dir_impl(&project_key, pty.inner())
}

/// Core of [`delete_project_dir`], taking `&PtyState` directly so it's callable from tests without a
/// Tauri managed-state handle.
pub(crate) fn delete_project_dir_impl(project_key: &str, pty: &crate::pty::PtyState) -> Result<(), String> {
    if sanitize_project_key(project_key).is_empty() {
        return Err("delete_project_dir: empty project_key".to_string());
    }
    let safe = sanitize_project_key(project_key);
    // Tear down the project's LIVE PTY sessions FIRST (#1387): drain + Job-Object-kill each shell
    // whose pane id is `<key>:…`, releasing the cwd locks they hold on the hub. The ledger reap
    // (#1279) only tree-kills by pid (async, no handle ownership), which races remove_dir_all — so
    // the in-process teardown (the same path app-exit uses) is what actually frees the directory.
    crate::pty::kill_project_sessions(pty, &safe);
    // Then reap any ORPHANED shells left by a prior run (owner gone) — forgetting their ledger
    // entries so discovery can't surface a deleted project's pid as an unrestorable session.
    let killed = crate::pty_ledger::reap_project_shells(&safe);
    if killed > 0 {
        log::info!("delete_project_dir: reaped {killed} orphaned shell(s) of {project_key:?}");
    }
    // The hub lives under projects/<key> (#922). Also remove any legacy draft/<key> copy left by a
    // pre-migration build so a stale half-moved hub can't linger and reappear in the list.
    for dir in [project_dir(project_key), legacy_draft_dir(project_key)] {
        if !dir.exists() { continue; }
        // Clear read-only first: on Windows `remove_dir_all` can't delete read-only files, and
        // git pack files in a cloned-repo subdir are read-only — so a project with a linked repo
        // would otherwise fail to delete (#793). Unix's `remove_dir_all` ignores file perms, so
        // this is Windows-only.
        #[cfg(windows)]
        crate::platform::fsx::clear_readonly_recursive(&dir);
        remove_dir_all_retrying(&dir).map_err(|e| format!("delete_project_dir: {e}"))?;
        log::info!("deleted project hub {:?}", dir);
    }
    // The fleet's worktrees now live outside the hub (see `worktrees_dir`, #844), so the hub delete
    // above no longer reaches them — reclaim them explicitly (#1080). This runs git's worktree
    // teardown per worktree (dropping the owning clones' admin records too) and, crucially, detaches
    // any `node_modules` JUNCTION first so the recursive delete can't follow it into the shared
    // main-clone node_modules. (A bare `remove_dir_all` here previously risked exactly that.)
    fleet::teardown::reclaim_project_worktrees(project_key);
    Ok(())
}

/// `remove_dir_all` with a few short retries (#1387): even after a holding process is killed, Windows
/// can keep a directory handle for a few ms (a sharing violation on the first attempt). Retry with a
/// brief backoff; succeed immediately if the dir is already gone (a concurrent removal).
fn remove_dir_all_retrying(dir: &std::path::Path) -> std::io::Result<()> {
    let mut attempt = 0u32;
    loop {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(_) if !dir.exists() => return Ok(()), // already gone
            Err(e) => {
                attempt += 1;
                if attempt >= 5 {
                    return Err(e);
                }
                std::thread::sleep(std::time::Duration::from_millis(60 * attempt as u64));
            }
        }
    }
}
// camelCase so the JSON the frontend receives is `hasPlan`/`updatedAt` — Tauri does NOT
// rename return-value fields (only command arguments), so without this the frontend's
// `lp.hasPlan` is undefined and every local project is skipped (#789).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalProject {
    pub(crate) key: String,
    pub(crate) title: String,
    pub(crate) has_plan: bool,
    pub(crate) updated_at: u64,
    /// True when the hub has been published — marked in-place by the `.published` file (#922).
    pub(crate) published: bool,
}
/// List the on-disk local projects (the `projects/<key>/` dirs) so the Projects page can surface
/// unpublished local work, not just GitHub boards + the store's draft map (#…). The on-disk hub is
/// the durable source of truth; the store had drifted out of sync, hiding real projects. `title`
/// is the first non-empty line of `goal.md` (heading markers stripped, first sentence, capped),
/// else the humanized key. `has_plan` marks a real project (any of goal/scope/CLAUDE.md present)
/// vs. a bare scaffold. `updated_at` is the dir mtime in ms since the epoch (for recency sorting).
#[tauri::command]
pub(crate) fn list_local_projects() -> Result<Vec<LocalProject>, String> {
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
pub(crate) fn repair_hub_worktrees(hub: &std::path::Path) {
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
pub(crate) fn dir_is_hub(dir: &std::path::Path) -> bool {
    // The fleet now lives in plan.db, not a fleet.json file (#1317) — so plan.db is a hub marker.
    ["CLAUDE.md", "goal.md", "scope.md", "phases.json", "issues.json", "plan.db"]
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
pub(crate) fn migrate_draft_hubs_into_projects() {
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
/// Absolute path to a project's hub directory (#647) — the frontend reveals it so the
/// user can export/back up authored plan files before resetting the blueprint.
#[tauri::command]
pub(crate) fn project_dir_path(project_key: String) -> String {
    project_dir(&project_key).to_string_lossy().to_string()
}

/// Absolute on-disk clone path of a repo within its project hub (#1819) —
/// `projects/<key>/<short-repo-name>`. Triage resolves each repo's cwd through this so the launch
/// uses a backend-authoritative absolute path instead of the async-loaded `bscBaseDir` mirror
/// (which is empty at crash-recovery startup → empty cwd → the settings.json writer is skipped →
/// a permission-less session). Mirrors [`repo_dir`] / the frontend `projectRepoCwd`; the key/repo
/// are opaque and sanitized downstream.
#[tauri::command]
pub(crate) fn repo_dir_path(project_key: String, repo: String) -> String {
    repo_dir(&project_key, &repo).to_string_lossy().to_string()
}
