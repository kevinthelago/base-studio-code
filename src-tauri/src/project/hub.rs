use crate::prelude::*;
use crate::fleet;

/// Mark a project published (#922): write `projects/<key>/.published`. Unlike the old promote-rename,
/// this is a file-create INSIDE the hub — allowed even while the planner holds the hub as its cwd,
/// instant, and the cwd never changes so Claude's `--continue` history survives. Idempotent.
///
/// The create-dir + marker-write is delegated to `bsc_project::mark_published` (#1761) so the
/// `.published` logic lives in ONE place, shared with the `bsc project` session CLI. The key is
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
/// Persist a project's DISPLAY TITLE into its hub as `projects/<key>/.title` (#…). This is the durable
/// source `list_local_projects` reads back, so the on-disk name reflects the user's actual input
/// instead of a title fabricated from the opaque `p-…` key. Called at project creation and on every
/// rename. An empty/blank title CLEARS the marker (the listing then falls back to the goal.md-derived
/// name, else "Untitled project"). `create_dir_all` so it works even before the hub is fully set up.
/// Idempotent.
#[tauri::command]
pub(crate) fn set_project_title(project_key: String, title: String) -> Result<(), String> {
    let key = sanitize_project_key(&project_key);
    if key.is_empty() {
        return Err("set_project_title: empty project_key".into());
    }
    let dir = project_dir(&project_key);
    let path = dir.join(".title");
    let trimmed = title.trim();
    if trimmed.is_empty() {
        let _ = std::fs::remove_file(&path); // clear → fall back to goal-derived / "Untitled project"
        return Ok(());
    }
    std::fs::create_dir_all(&dir).str_err()?;
    std::fs::write(&path, trimmed).str_err()?;
    Ok(())
}
/// The durable hub title written by [`set_project_title`] (the `.title` sidecar), if present and
/// non-empty (first line, trimmed). `None` lets `list_local_projects` fall back to the goal-derived
/// title, then a neutral placeholder — it NEVER fabricates a name from the opaque key.
fn read_hub_title(dir: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(dir.join(".title"))
        .ok()
        .and_then(|c| c.lines().next().map(|l| l.trim().to_string()))
        .filter(|s| !s.is_empty())
}
/// Delete a project's on-disk hub (`projects/<sanitized-key>`) and everything in
/// it — plan sections, prompts, cloned repos. Best-effort: a missing dir is fine.
/// Refuses an empty key so it can never wipe the `projects/` root.
#[tauri::command]
pub(crate) fn delete_project_dir(project_key: String, pty: tauri::State<'_, crate::console::pty::PtyState>) -> Result<(), String> {
    delete_project_dir_impl(&project_key, pty.inner())
}

/// Core of [`delete_project_dir`], taking `&PtyState` directly so it's callable from tests without a
/// Tauri managed-state handle.
pub(crate) fn delete_project_dir_impl(project_key: &str, pty: &crate::console::pty::PtyState) -> Result<(), String> {
    if sanitize_project_key(project_key).is_empty() {
        return Err("delete_project_dir: empty project_key".to_string());
    }
    let safe = sanitize_project_key(project_key);
    // Tear down the project's LIVE PTY sessions FIRST (#1387): drain + Job-Object-kill each shell
    // whose pane id is `<key>:…`, releasing the cwd locks they hold on the hub. The ledger reap
    // (#1279) only tree-kills by pid (async, no handle ownership), which races remove_dir_all — so
    // the in-process teardown (the same path app-exit uses) is what actually frees the directory.
    crate::console::pty::kill_project_sessions(pty, &safe);
    // Then reap any ORPHANED shells left by a prior run (owner gone) — forgetting their ledger
    // entries so discovery can't surface a deleted project's pid as an unrestorable session.
    let killed = crate::console::ledger::reap_project_shells(&safe);
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
/// resolution: the durable `.title` sidecar (the user's input, written by `set_project_title`), else
/// the first real sentence of `goal.md` (heading lines skipped, capped), else a neutral "Untitled
/// project" — it NEVER fabricates a name from the opaque `p-…` key (that produced gibberish like
/// "p mqwroabz fbtub8"). `has_plan` marks a real project (a plan SECTION — goal/scope — present),
/// NOT `CLAUDE.md` (which EVERY hub gets at setup, so it can't tell a bare scaffold apart).
/// `updated_at` is the dir mtime in ms since the epoch (for recency sorting).
#[tauri::command]
pub(crate) fn list_local_projects() -> Result<Vec<LocalProject>, String> {
    // Single root since #922: every hub lives under projects/<key>; `published` is the in-place
    // `.published` marker, not the directory's location.
    let root = projects_root();
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
        // Real project vs bare scaffold: a plan SECTION (goal/scope) is present. CLAUDE.md is
        // EXCLUDED — it's written into EVERY hub at setup, so counting it made `has_plan` always true,
        // surfacing a freshly-created/empty hub (just CLAUDE.md + an empty plan.db) as a draft.
        let has_plan = goal.exists() || dir.join("scope.md").exists();
        // Title precedence: the durable `.title` sidecar (the user's own input) → the goal.md-derived
        // first sentence → a neutral placeholder. Crucially the old `key.replace(['_','-'], " ")`
        // fabrication is GONE — the opaque key must never masquerade as a display name (#…).
        let title = read_hub_title(&dir)
            .or_else(|| {
                std::fs::read_to_string(&goal).ok().and_then(|c| {
                    // First real (non-empty, non-heading) line → its first sentence. SKIP heading lines
                    // (`# Goal`) rather than just stripping the `#` — otherwise every hub whose goal.md
                    // opens with `# Goal` would be titled "Goal" (matches the frontend deriveProjectTitle).
                    c.lines()
                        .map(|l| l.trim())
                        .find(|l| !l.is_empty() && !l.starts_with('#'))
                        .map(|l| l.split(['.', '!', '?']).next().unwrap_or(l).trim().chars().take(80).collect::<String>())
                })
                .filter(|t| !t.is_empty())
            })
            .unwrap_or_else(|| "Untitled project".to_string());
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
/// One-time re-key of a project's on-disk footprint onto its name-derived slug (#2409) — the
/// backend half of the reopen-mismatch modal's "Link to an existing local project": move
/// `projects/<old>` → `projects/<new>` and `worktrees/<old>` → `worktrees/<new>`, then repair the
/// git worktree links in BOTH directions (the clones live inside the hub and the worktrees moved
/// with the project, so each clone's `.git/worktrees/<id>/gitdir` records AND each worktree's
/// `.git` pointer file are stale). plan.db, `.title`, `.published`, prompts, and every plan file
/// travel with the hub — the move IS the whole migration; nothing else on disk keys off the old
/// name. Refuses to clobber: an existing hub at the new key is an error (the caller resolves that
/// as a create-collision instead).
#[tauri::command]
pub(crate) fn relink_project_hub(
    old_key: String,
    new_key: String,
    pty: tauri::State<'_, crate::console::pty::PtyState>,
) -> Result<(), String> {
    relink_project_hub_impl(&old_key, &new_key, pty.inner())
}

/// Core of [`relink_project_hub`], taking `&PtyState` directly so it's callable from tests.
pub(crate) fn relink_project_hub_impl(
    old_key: &str,
    new_key: &str,
    pty: &crate::console::pty::PtyState,
) -> Result<(), String> {
    let old = sanitize_project_key(old_key);
    let new = sanitize_project_key(new_key);
    if old.is_empty() || new.is_empty() {
        return Err("relink_project_hub: empty project key".into());
    }
    if old == new {
        return Ok(()); // already keyed by its name-slug — nothing to move
    }
    let src = project_dir(&old);
    let dst = project_dir(&new);
    if !src.is_dir() {
        return Err(format!("relink_project_hub: no hub at {src:?}"));
    }
    if dst.exists() {
        return Err(format!("relink_project_hub: a hub already exists at {dst:?}"));
    }
    // Release cwd locks first (#1387, same as delete): tear down any live PTY session of the OLD
    // key and reap orphaned shells, so the rename can't fail on a held Windows directory handle.
    crate::console::pty::kill_project_sessions(pty, &old);
    let _ = crate::console::ledger::reap_project_shells(&old);
    rename_retrying(&src, &dst).map_err(|e| format!("relink_project_hub: hub move failed: {e}"))?;
    // The fleet worktrees live OUTSIDE the hub (#844) — move them onto the new key too.
    let wt_src = worktrees_dir(&old);
    let wt_dst = worktrees_dir(&new);
    if wt_src.is_dir() {
        if let Err(e) = rename_retrying(&wt_src, &wt_dst) {
            // Non-fatal: the hub already moved (the identity is re-keyed); a stale worktree tree is
            // recoverable by relaunching the fleet, which recreates worktrees under the new key.
            log::warn!("relink_project_hub: worktrees move failed ({e}); relaunch the fleet to rebuild them");
        }
    }
    repair_moved_worktrees(&dst, &wt_dst);
    log::info!("relinked project hub {old:?} → {new:?} (#2409)");
    Ok(())
}

/// `fs::rename` with the same short-retry backoff as [`remove_dir_all_retrying`] (#1387): Windows
/// can hold a just-released directory handle for a few ms, failing the first attempt spuriously.
fn rename_retrying(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    let mut attempt = 0u32;
    loop {
        match std::fs::rename(src, dst) {
            Ok(()) => return Ok(()),
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

/// After BOTH a hub and its worktree tree moved (#2409): from each repo clone in the hub, run
/// `git worktree repair <its worktree paths…>` — passing the paths is what lets git rewrite both
/// the clone-side gitdir records and each worktree's `.git` pointer when the two sides moved
/// together (a bare `repair` can't find worktrees that moved). A clone's worktrees are matched by
/// the `<repoShort>--` dir-name prefix ([`worktree_dir_name`]). Best-effort, like
/// [`repair_hub_worktrees`].
fn repair_moved_worktrees(hub: &std::path::Path, wts: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(hub) else { return };
    for entry in entries.flatten() {
        let clone = entry.path();
        if !clone.join(".git").exists() {
            continue;
        }
        let Some(clone_name) = clone.file_name().and_then(|n| n.to_str()).map(str::to_owned) else { continue };
        let mut wt_paths: Vec<String> = Vec::new();
        if let Ok(wt_entries) = std::fs::read_dir(wts) {
            for wt in wt_entries.flatten() {
                let name = wt.file_name().to_string_lossy().to_string();
                if parse_worktree_dir_name(&name).is_some_and(|(repo, _)| repo == clone_name) {
                    wt_paths.push(wt.path().to_string_lossy().to_string());
                }
            }
        }
        let mut args: Vec<&str> = vec!["worktree", "repair"];
        args.extend(wt_paths.iter().map(String::as_str));
        let _ = git_ok(&clone.to_string_lossy(), &args);
    }
}

/// Run `git worktree repair` in every cloned repo under a moved hub (#904) so a fleet launched
/// before the move keeps working: the worktrees (kept outside the hub) still point at the repo's
/// OLD path, and `repair` rewrites those links to the repo's new location. Best-effort.
pub(crate) fn repair_hub_worktrees(hub: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(hub) else { return };
    for entry in entries.flatten() {
        let repo = entry.path();
        if !repo.join(".git").exists() { continue; }
        let _ = git_ok(&repo.to_string_lossy(), &["worktree", "repair"]);
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

#[cfg(test)]
mod relocated_tests {
    #![allow(unused_imports)]
    use super::*;
    use crate::testutil::prelude::*;

    #[test]
    fn mark_published_writes_an_in_place_marker_read_by_is_published() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("marker");
        let key = "publish-me";
        // A live hub with a plan file (simulating the planner's cwd) — never moved.
        write_file(&project_dir(key).join("goal.md"), "# goal");
        assert!(!is_published(key), "a fresh hub is a draft");

        mark_published(key.to_string()).unwrap();
        assert!(is_published(key), "marker present after mark_published");
        assert!(project_dir(key).join(".published").is_file());
        // The hub did not move: its files stay put (so the planner's cwd + Claude history survive).
        assert!(project_dir(key).join("goal.md").exists(), "files stay in place");
        // Idempotent.
        mark_published(key.to_string()).unwrap();
        assert!(is_published(key));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn has_plan_ignores_the_always_present_claude_md_scaffold() {
        // The bug: every hub gets a CLAUDE.md at setup, so counting it in `has_plan` made a freshly
        // created / empty hub (just CLAUDE.md + an empty plan.db, no plan section) surface as a draft
        // named by its raw `p-…` key. A real project has a plan SECTION (goal/scope); a bare scaffold
        // does not. (A real in-progress draft the user created is still shown from the store's draft
        // map regardless — this only governs ORPHAN on-disk hubs with no store entry.)
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("hasplan");
        // A bare scaffold — only the setup-written CLAUDE.md.
        write_file(&project_dir("p-empty").join("CLAUDE.md"), "planner spec");
        // A real project — a goal section was written.
        write_file(&project_dir("real-proj").join("CLAUDE.md"), "planner spec");
        write_file(&project_dir("real-proj").join("goal.md"), "# Goal\n\nBuild a thing.");

        let list = list_local_projects().unwrap();
        let get = |k: &str| list.iter().find(|p| p.key == k).expect("project listed");
        assert!(!get("p-empty").has_plan, "a CLAUDE.md-only scaffold is NOT a real project (no random-named draft)");
        assert!(get("real-proj").has_plan, "a hub with a plan section IS a real project");
        assert_eq!(get("real-proj").title, "Build a thing", "title comes from goal.md, not the key");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn migration_consolidates_draft_hubs_and_clears_empty_published_shells() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("migrate");
        let draft_root = bsc_base_dir().join("draft");

        // (1) A plain draft → moved into projects/.
        write_file(&draft_root.join("plain").join("goal.md"), "# plain goal");
        // (2) The overdrive case: real hub in draft/, empty shell in projects/ → shell cleared, hub wins.
        write_file(&draft_root.join("overdrive").join("CLAUDE.md"), "spec");
        std::fs::create_dir_all(project_dir("overdrive").join("prompts")).unwrap();
        // (3) A real published hub colliding with a stale same-key draft → published kept, draft dropped.
        write_file(&project_dir("shipped").join("CLAUDE.md"), "published spec");
        write_file(&draft_root.join("shipped").join("goal.md"), "stale draft");

        migrate_draft_hubs_into_projects();

        // (1) consolidated.
        assert!(project_dir("plain").join("goal.md").exists(), "plain draft moved into projects/");
        // (2) the real overdrive hub replaced the empty shell.
        assert!(project_dir("overdrive").join("CLAUDE.md").exists(), "real overdrive hub moved in");
        assert!(!project_dir("overdrive").join("prompts").exists(), "empty shell cleared");
        // (3) published kept, stale draft content not clobbered in.
        assert_eq!(std::fs::read_to_string(project_dir("shipped").join("CLAUDE.md")).unwrap(), "published spec");
        // draft/ root retired.
        assert!(!draft_root.exists(), "draft/ root removed after migration");
        std::fs::remove_dir_all(&home).ok();
    }
    #[test]
    fn list_local_projects_surfaces_on_disk_unpublished_projects() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("llp");
        let root = bsc_base_dir().join("projects");
        // A real project: goal.md drives the title (first sentence of the body; the leading `# Goal`
        // heading LINE is skipped whole — matches the frontend `deriveProjectTitle`, so a `# Goal`
        // heading never leaks as the title).
        write_file(&root.join("monkeys-paw").join("goal.md"), "# Goal\n\nA wish-granting app. more");
        // A project with only CLAUDE.md (no goal/scope, no .title) → neutral "Untitled project"; the
        // opaque key is NEVER humanized into a display name anymore (#…). CLAUDE.md is written into
        // EVERY hub at setup, so it's EXCLUDED from has_plan — a CLAUDE.md-only hub is has_plan=false.
        write_file(&root.join("p-abc-xyz").join("CLAUDE.md"), "spec");
        // The `.title` sidecar (the user's input) OUTRANKS the goal-derived title (#…).
        write_file(&root.join("p-titled-1").join("goal.md"), "# Goal\n\nSome goal prose here.");
        write_file(&root.join("p-titled-1").join(".title"), "Acme CRM");
        // A bare scaffold dir (no plan artifacts) is listed but flagged has_plan=false.
        std::fs::create_dir_all(root.join("empty-scaffold").join("prompts")).unwrap();

        let found = list_local_projects().unwrap();
        let by = |k: &str| found.iter().find(|p| p.key == k);
        assert_eq!(by("monkeys-paw").unwrap().title, "A wish-granting app");
        assert!(by("monkeys-paw").unwrap().has_plan);
        assert_eq!(by("p-abc-xyz").unwrap().title, "Untitled project", "opaque key must not become the title");
        assert!(!by("p-abc-xyz").unwrap().has_plan, "CLAUDE.md-only hub is excluded from has_plan");
        assert_eq!(by("p-titled-1").unwrap().title, "Acme CRM", ".title sidecar wins over goal.md");
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
    fn set_project_title_persists_then_clears_the_hub_title() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("spt");
        let key = "p-xyz-title";
        // A hub with a plan section so list_local_projects surfaces it.
        write_file(&project_dir(key).join("goal.md"), "# Goal\n\nGoal prose.");
        let title = |k: &str| list_local_projects().unwrap().into_iter().find(|p| p.key == k).unwrap().title;

        // Persisting the user's title (trimmed) wins over the goal-derived one.
        set_project_title(key.to_string(), "  My Project  ".to_string()).unwrap();
        assert_eq!(title(key), "My Project", "trimmed .title sidecar drives the listed title");

        // Clearing it falls back to the goal-derived title — never the opaque key.
        set_project_title(key.to_string(), "   ".to_string()).unwrap();
        assert_eq!(title(key), "Goal prose", "blank title clears the sidecar → goal fallback");

        // An empty key is refused (never writes to the projects/ root).
        assert!(set_project_title(String::new(), "x".to_string()).is_err());
        std::fs::remove_dir_all(&home).ok();
    }
    #[test]
    fn relink_moves_the_hub_and_worktrees_onto_the_new_key() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("relink");
        // A legacy-keyed hub (plan file + published marker + .title) and a relocated worktree tree.
        write_file(&project_dir("Video_Game").join("goal.md"), "# goal");
        write_file(&project_dir("Video_Game").join(".title"), "Video Game");
        write_file(&worktrees_dir("Video_Game").join("web--auth").join("x.rs"), "fn main() {}");

        relink_project_hub_impl("Video_Game", "video-game", &crate::console::pty::PtyState::new()).unwrap();

        // The whole footprint moved: hub (with plan files + sidecars) and the worktree tree.
        assert!(!project_dir("Video_Game").exists(), "old hub gone");
        assert!(project_dir("video-game").join("goal.md").exists(), "plan files travel with the hub");
        assert!(project_dir("video-game").join(".title").exists(), ".title travels with the hub");
        assert!(!worktrees_dir("Video_Game").exists(), "old worktree tree gone");
        assert!(worktrees_dir("video-game").join("web--auth").join("x.rs").exists(), "worktrees moved");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn relink_refuses_to_clobber_and_requires_an_existing_source() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("relinkguard");
        let pty = crate::console::pty::PtyState::new();
        write_file(&project_dir("old-key").join("goal.md"), "# goal");
        write_file(&project_dir("taken").join("goal.md"), "# other project");

        // Destination occupied → error, and NEITHER hub is touched.
        assert!(relink_project_hub_impl("old-key", "taken", &pty).is_err());
        assert!(project_dir("old-key").join("goal.md").exists(), "source untouched on refusal");
        assert_eq!(
            std::fs::read_to_string(project_dir("taken").join("goal.md")).unwrap(),
            "# other project",
            "destination untouched on refusal",
        );
        // Missing source → error; empty keys → error; same key → Ok(no-op).
        assert!(relink_project_hub_impl("does-not-exist", "fresh", &pty).is_err());
        assert!(relink_project_hub_impl("", "fresh", &pty).is_err());
        assert!(relink_project_hub_impl("old-key", "old-key", &pty).is_ok());
        assert!(project_dir("old-key").join("goal.md").exists(), "same-key relink is a no-op");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn delete_project_dir_removes_a_dir_with_a_read_only_file() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("dpd");
        let key = "doomed-proj".to_string();
        let proj = bsc_base_dir().join("projects").join(&key);
        // Simulate a cloned repo's read-only git pack file — the Windows delete failure mode.
        let f = proj.join("repo").join("objects").join("pack.idx");
        write_file(&f, "packdata");
        let mut perms = std::fs::metadata(&f).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&f, perms).unwrap();

        crate::project::hub::delete_project_dir_impl(&key, &crate::console::pty::PtyState::new()).unwrap();
        assert!(!proj.exists(), "project dir (incl. read-only files) should be deleted");

        std::fs::remove_dir_all(&home).ok();
    }
    #[test]
    fn delete_project_dir_removes_relocated_worktrees() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("dpdwt");
        let key = "doomed-with-wt".to_string();
        // A hub file and a relocated worktree with a (Windows-hostile) read-only file.
        write_file(&project_dir(&key).join("goal.md"), "# goal");
        let wt_file = worktrees_dir(&key).join("web--auth").join("src").join("x.rs");
        write_file(&wt_file, "fn main() {}");
        let mut perms = std::fs::metadata(&wt_file).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&wt_file, perms).unwrap();

        crate::project::hub::delete_project_dir_impl(&key, &crate::console::pty::PtyState::new()).unwrap();
        assert!(!project_dir(&key).exists(), "hub should be deleted");
        assert!(!worktrees_dir(&key).exists(), "relocated worktrees should be deleted too");

        std::fs::remove_dir_all(&home).ok();
    }
}
