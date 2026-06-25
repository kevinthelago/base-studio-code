use crate::*;

/// Clear every project's plan files for a from-scratch dev reset, WITHOUT touching
/// the cloned repos. Deletes only the top-level `.md` / `.json` plan files in each
/// `projects/<key>/` dir (goal.md, issues.json, phases.json, the context docs, …;
/// the fleet lives in plan.db now, cleared separately — a stray legacy `fleet.json`
/// is still swept by the `.json` rule) and leaves all SUBDIRECTORIES — the cloned
/// repos and `prompts/` — intact. Best-effort; returns how many files were
/// removed. Without this, the planning poll re-reads the files and a store-only
/// clear is undone within a tick.
#[tauri::command]
pub(crate) fn clear_all_plan_files() -> Result<u32, String> {
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
/// Delete every plan section file (`.md` / `.json`) in a single project's hub
/// directory, leaving subdirectories (cloned repos, `prompts/`,
/// `.claude/`) intact. The section poll re-reads from disk, so this must run
/// before the store is cleared — otherwise the next poll repopulates the store.
/// Returns how many files were deleted. Best-effort: any unreadable file is skipped.
#[tauri::command]
pub(crate) fn clear_project_plan_files(project_key: String) -> Result<u32, String> {
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
/// Reads plan section files from the project hub. They live FLAT in
/// `projects/<key>/<section>.{md|json}` (no `plans/` subdir).
/// Returns a map of section key → file content for every file that exists and
/// is non-empty. Callers poll this on a short interval to pick up sections that
/// Claude writes via its Write tool (more reliable than parsing PTY output).
#[tauri::command]
pub(crate) async fn read_plan_sections(project_key: String) -> Result<std::collections::HashMap<String, String>, String> {
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
