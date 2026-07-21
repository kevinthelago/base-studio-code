use crate::prelude::*;
use crate::project::plan_db;

/// Clear every project's plan files for a from-scratch dev reset, WITHOUT touching
/// the cloned repos. Deletes only the top-level `.md` / `.json` plan files in each
/// `projects/<key>/` dir (goal.md, issues.json, phases.json, the context docs, …;
/// the fleet lives solely in plan.db now (#1805), cleared separately — a stray legacy
/// `fleet.json` is still swept by the `.json` rule) and leaves all SUBDIRECTORIES — the cloned
/// repos and `prompts/` — intact. Best-effort; returns how many files were
/// removed. Without this, the planning poll re-reads the files and a store-only
/// clear is undone within a tick.
#[tauri::command]
pub(crate) fn clear_all_plan_files() -> Result<u32, String> {
    let projects = projects_root();
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
    // Empty the plan store FIRST, before the hub-exists check below. Since plan.db moved to the central
    // `plans/<key>.db` store (#2993), a DB-backed project can have a POPULATED plan.db with NO
    // materialized hub dir — so gating the store clear on the hub existing would leave the plan in the
    // DB and the next poll would re-read it. Best-effort. (Issues + features live in plan.db, not files.)
    if let Err(e) = plan_db::clear(&project_key) {
        log::warn!("clear_project_plan_files({project_key}): clearing plan.db failed: {e}");
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
    let context = discovery_dir_for(&project_key);
    if context.is_dir() && std::fs::remove_dir_all(&context).is_ok() {
        removed += 1;
    }
    // Drop generated UI artifacts too (#650): the .ui-skeleton/ dir feeds the render-preview
    // pipeline, so leaving it would re-show the old UI after a clear.
    let skeleton = proj.join(".ui-skeleton");
    if skeleton.is_dir() && std::fs::remove_dir_all(&skeleton).is_ok() {
        removed += 1;
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
pub(crate) fn read_plan_stages(project_key: String) -> Result<std::collections::HashMap<String, String>, String> {
    let _perf = PerfSpan::new("read_plan_stages");
    let safe_key  = sanitize_project_key(&project_key);
    if safe_key.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    // Every non-empty .md/.json section file, keyed by file stem, from BOTH the ephemeral planning
    // workspace (`planning/<key>`, where a never-materialized greenfield draft's planner writes,
    // #2997) AND the materialized hub (`projects/<key>`) — root files (manifests + legacy flat
    // sections + the considered-but-skipped `_skipped` record + the `phases` roadmap, handled
    // specially by the UI) plus each dir's `discovery/` subdir (the Context-stage discovery topics,
    // #807). The union is purely additive: a draft whose files still sit in either location surfaces.
    // Ingest ORDER sets precedence (later wins): the planning workspace first, then the hub — so the
    // materialized hub (more recent) wins over a same-named ephemeral section; within each dir the
    // `discovery/` subdir is ingested after its root so a discovery topic overrides a stale root copy.
    let mut sections = std::collections::HashMap::new();
    let planning_dir = planning_workspace_dir(&project_key);
    ingest_stage_files(&planning_dir, &mut sections);
    ingest_stage_files(&planning_dir.join("discovery"), &mut sections);
    ingest_stage_files(&plan_dir_for(&project_key), &mut sections);
    ingest_stage_files(&discovery_dir_for(&project_key), &mut sections);
    // plan.db `section` artifacts (#2997 A2) — the DB-backed source as planner content migrates OFF
    // files toward the hub-is-a-pure-projection model. Ingested LAST so an artifact WINS over a
    // same-named file; trimmed + empties dropped, matching the file ingest.
    for (name, content) in plan_db::artifacts_of_kind(&project_key, "section") {
        let c = content.trim();
        if !c.is_empty() {
            sections.insert(name, c.to_string());
        }
    }
    Ok(sections)
}

#[cfg(test)]
mod relocated_tests {
    #![allow(unused_imports)]
    use super::*;
    use crate::testutil::prelude::*;

    #[test]
    fn clear_project_plan_files_removes_md_and_json_only() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("cpf");
        let key = "test-plan-clear".to_string();
        let proj = bsc_base_dir().join("projects").join(&key);
        let sub = proj.join("my-repo");
        std::fs::create_dir_all(&sub).unwrap();
        write_file(&proj.join("goal.md"), "goal");
        write_file(&proj.join("phases.json"), "[]");
        write_file(&sub.join("README.md"), "# repo"); // inside subdir -- preserved
        // a generated UI skeleton that must be wiped too (#650)
        let skel = proj.join(".ui-skeleton");
        std::fs::create_dir_all(&skel).unwrap();
        write_file(&skel.join("Home.jsx"), "export default () => null");

        let removed = clear_project_plan_files(key.clone()).unwrap();
        assert_eq!(removed, 3, "goal.md + phases.json + .ui-skeleton removed");
        assert!(!proj.join("goal.md").exists());
        assert!(!proj.join("phases.json").exists());
        assert!(!skel.exists(), ".ui-skeleton dir wiped");
        assert!(sub.join("README.md").exists(), "subdir entry preserved");

        // Missing project -> Ok(0), no panic.
        let n = clear_project_plan_files("no-such-bsc-cpf-key".to_string()).unwrap();
        assert_eq!(n, 0);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn read_plan_stages_dual_reads_plandb_artifacts_over_files() {
        // #2997 A2: read_plan_stages merges plan.db `section` artifacts with the file sections, and an
        // artifact WINS over a same-named file (plan.db is the source as content migrates off files).
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("dualread");
        let key = "dual-read-proj".to_string();
        let proj = bsc_base_dir().join("projects").join(&key);
        write_file(&proj.join("stack.md"), "stack from FILE"); // file-only section
        write_file(&proj.join("scope.md"), "scope from file"); // will be overridden by an artifact
        // plan.db `section` artifacts: a fresh one, one colliding with scope.md, + a non-section kind.
        let store = plandb::Store::open(&crate::plan_db_path(&key)).unwrap();
        store.artifact_set("section", "goal", "goal from DB").unwrap();
        store.artifact_set("section", "scope", "scope from DB").unwrap();
        store.artifact_set("kickoff", "web", "kickoff — ignored").unwrap();

        let out = read_plan_stages(key).unwrap();
        assert_eq!(out.get("stack").map(String::as_str), Some("stack from FILE"), "a file-only section still surfaces");
        assert_eq!(out.get("goal").map(String::as_str), Some("goal from DB"), "a plan.db-only artifact surfaces");
        assert_eq!(out.get("scope").map(String::as_str), Some("scope from DB"), "plan.db WINS over the same-named file");
        assert!(!out.contains_key("web"), "a non-section artifact kind never leaks into the sections map");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn read_plan_stages_unions_files_from_the_planning_workspace_and_the_hub() {
        // #2997: a never-materialized greenfield draft plans in the ephemeral `planning/<key>`
        // workspace, so read_plan_stages must ingest section files from BOTH that workspace AND the
        // materialized `projects/<key>` hub — additive, with the hub winning on a same-named section.
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("unionread");
        let key = "union-read-proj".to_string();
        let planning = planning_workspace_dir(&key);
        let hub = project_dir(&key);
        // A section that ONLY lives in the ephemeral planning workspace still surfaces (the greenfield
        // draft case, before materialization — project_dir may not even exist yet).
        write_file(&planning.join("goal.md"), "goal from PLANNING");
        // A discovery topic in the workspace's discovery/ subdir surfaces too.
        write_file(&planning.join("discovery").join("stack.md"), "stack from PLANNING discovery");
        // A section present in BOTH: the materialized hub wins (more recent than the ephemeral copy).
        write_file(&planning.join("scope.md"), "scope from PLANNING");
        write_file(&hub.join("scope.md"), "scope from HUB");
        // A hub-only section surfaces (a materialized / repo-linked project).
        write_file(&hub.join("architecture.md"), "arch from HUB");

        let out = read_plan_stages(key).unwrap();
        assert_eq!(out.get("goal").map(String::as_str), Some("goal from PLANNING"), "planning-only section surfaces");
        assert_eq!(out.get("stack").map(String::as_str), Some("stack from PLANNING discovery"), "planning discovery/ surfaces");
        assert_eq!(out.get("scope").map(String::as_str), Some("scope from HUB"), "the materialized hub wins over the ephemeral copy");
        assert_eq!(out.get("architecture").map(String::as_str), Some("arch from HUB"), "hub-only section surfaces");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn clear_project_plan_files_empties_the_plan_db() {
        // The plan now lives in plan.db, not files — clearing must empty it too, or the next poll
        // re-reads the DB and the plan reappears (#plan-db).
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("cpfdb");
        let key = "test-clear-plan-db".to_string();
        // plan.db lives in the central `plans/<key>.db` store (#2993), not the hub — the same path
        // `clear_project_plan_files` → `plan_db::clear` operates on. (Matches the sibling test above.)
        let db = crate::plan_db_path(&key);
        {
            let store = plandb::Store::open(&db).unwrap();
            store.upsert(&plandb::PlanIssue { r#ref: "F1".into(), title: "issue".into(), ..Default::default() }).unwrap();
            store.feature_upsert(&plandb::PlanFeature { name: "Feature".into(), ..Default::default() }).unwrap();
        }
        clear_project_plan_files(key.clone()).unwrap();
        let store = plandb::Store::open(&db).unwrap();
        assert!(store.list(None, None).unwrap().is_empty(), "issues cleared from the DB");
        assert!(store.feature_list().unwrap().is_empty(), "features cleared from the DB");

        std::fs::remove_dir_all(&home).ok();
    }
}
