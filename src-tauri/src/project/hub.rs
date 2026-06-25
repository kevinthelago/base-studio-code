use crate::*;

/// Mark a project published (#922): write `projects/<key>/.published`. Unlike the old promote-rename,
/// this is a file-create INSIDE the hub — allowed even while the planner holds the hub as its cwd,
/// instant, and the cwd never changes so Claude's `--continue` history survives. Idempotent.
#[tauri::command]
pub(crate) fn mark_published(project_key: String) -> Result<(), String> {
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
/// Delete a project's on-disk hub (`projects/<sanitized-key>`) and everything in
/// it — plan sections, prompts, cloned repos. Best-effort: a missing dir is fine.
/// Refuses an empty key so it can never wipe the `projects/` root.
#[tauri::command]
pub(crate) fn delete_project_dir(project_key: String) -> Result<(), String> {
    if sanitize_project_key(&project_key).is_empty() {
        return Err("delete_project_dir: empty project_key".to_string());
    }
    // Reap the project's still-running shells first (#1279): kill any live PTY child whose ledger
    // pane id is `<key>:…` and forget all of its ledger entries. Otherwise a shell still running at
    // delete time survives as an orphaned pid the deleted-project key can no longer resolve, which
    // discovery would surface as an unrestorable "running" session. The on-disk hub keys off the
    // SANITIZED slug, so match the ledger on the same value.
    let killed = crate::pty_ledger::reap_project_shells(&sanitize_project_key(&project_key));
    if killed > 0 {
        log::info!("delete_project_dir: reaped {killed} running shell(s) of {project_key:?}");
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
pub(crate) fn clear_readonly_recursive(dir: &std::path::Path) {
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
    /// True when the hub lives under `projects/` (published), false under `draft/` (#904).
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
