// Tauri command surface over the native per-project plan store (#plan-db). The store itself lives in
// the Tauri-free `plandb` crate (shared with the `bsc plan` agent CLI); this module only resolves the
// project key → `projects/<key>/plan.db` and adapts the `Store` API to Tauri commands for the UI.

use plandb::{Automation, Lesson, PlanFeature, PlanIssue, StartupScript, Store, STATUSES};
use std::path::PathBuf;

fn db_path(project_key: &str) -> PathBuf {
    crate::project_dir(project_key).join("plan.db")
}

fn open(project_key: &str) -> Result<Store, String> {
    Store::open(&db_path(project_key)).map_err(|e| e.to_string())
}

/// The project's fleet (the FleetPlan JSON: `{…meta(director,…), streams:[…]}`) from plan.db — the
/// sole fleet source for session discovery (#1317). Returns `None` when there's no plan.db or no
/// fleet stored, and does NOT create a db: discovery scans every hub dir, so it must never
/// materialize an empty store as a side effect.
pub(crate) fn fleet_for(project_key: &str) -> Option<serde_json::Value> {
    if !db_path(project_key).exists() {
        return None;
    }
    open(project_key).ok().and_then(|s| s.fleet_get().ok().flatten())
}

/// Empty the project's plan store (issues + features) — backs "clear plan" (#plan-db). No-op when
/// the db doesn't exist (don't create one just to clear it). Called from `clear_project_plan_files`
/// so a reset isn't undone by the next poll re-reading the DB.
pub(crate) fn clear(project_key: &str) -> Result<(), String> {
    let path = db_path(project_key);
    if !path.exists() {
        return Ok(());
    }
    Store::open(&path).and_then(|s| s.clear()).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_upsert_issue(project_key: String, issue: PlanIssue) -> Result<(), String> {
    open(&project_key)?.upsert(&issue).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_list_issues(
    project_key: String,
    status: Option<String>,
    stream: Option<String>,
) -> Result<Vec<PlanIssue>, String> {
    open(&project_key)?
        .list(status.as_deref(), stream.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_remove_issue(project_key: String, issue_ref: String) -> Result<(), String> {
    open(&project_key)?.remove(&issue_ref).map_err(|e| e.to_string())
}

/// Set an issue's execution status (workers: in_progress/complete; director: verified/failed).
/// Validates against the known lifecycle so a typo can't wedge the board.
#[tauri::command]
pub(crate) fn plan_set_issue_status(project_key: String, issue_ref: String, status: String) -> Result<(), String> {
    if !plandb::is_valid_status(&status) {
        return Err(format!("unknown status '{status}' (expected one of {STATUSES:?})"));
    }
    let n = open(&project_key)?.set_status(&issue_ref, &status).map_err(|e| e.to_string())?;
    if n == 0 {
        Err(format!("no issue with ref '{issue_ref}'"))
    } else {
        Ok(())
    }
}

// ── features (#plan-db) ───────────────────────────────────────────────────────────

/// Merge-upsert a feature (titles-first: register titles, then fill detail by slug). Returns the slug.
#[tauri::command]
pub(crate) fn plan_upsert_feature(project_key: String, feature: PlanFeature) -> Result<String, String> {
    open(&project_key)?.feature_upsert(&feature).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_list_features(project_key: String) -> Result<Vec<PlanFeature>, String> {
    open(&project_key)?.feature_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_remove_feature(project_key: String, slug: String) -> Result<(), String> {
    open(&project_key)?.feature_remove(&slug).map_err(|e| e.to_string())
}

// ── linked repos (#1012) — durable per-project repo links in the hub's plan.db, so a zustand /
//    app-state reset can't lose them (the store-only persistence proved fragile). ──────────────

#[tauri::command]
pub(crate) fn plan_add_repo(project_key: String, full_name: String) -> Result<(), String> {
    open(&project_key)?.repo_add(&full_name).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_list_repos(project_key: String) -> Result<Vec<String>, String> {
    open(&project_key)?.repo_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_remove_repo(project_key: String, full_name: String) -> Result<(), String> {
    open(&project_key)?.repo_remove(&full_name).map_err(|e| e.to_string())
}

// ── fleet + per-stream permissions (#1018) — the whole FleetPlan as meta + per-stream rows. ─────────

/// One-time migration of a stray legacy `fleet.json` in the project hub into plan.db (#1805).
/// plan.db is the SOLE fleet store now; this rescues data from pre-#1317 hubs that still carry a
/// `fleet.json` on disk, then removes the file so the fleet has exactly one home. Idempotent and
/// **plan.db-wins**:
/// - no stray file ⇒ no-op (the common, post-migration case — a cheap `is_file()` check per call).
/// - file present AND plan.db already has a fleet ⇒ delete the file untouched (plan.db is never
///   overwritten from disk).
/// - file present AND plan.db empty ⇒ import the file's JSON object into plan.db, then delete it.
///
/// The stream JSON is stored wholesale (any flat-flow fields are preserved), and the frontend's
/// `parseFleetFile` normalizes flat→nested flow at read time, so the import is lossless.
pub(crate) fn migrate_stray_fleet_json(project_key: &str) {
    let file = crate::project_dir(project_key).join("fleet.json");
    if !file.is_file() {
        return;
    }
    // plan.db wins: if it already holds a fleet, drop the stray file without reading it.
    if fleet_for(project_key).is_some() {
        let _ = std::fs::remove_file(&file);
        return;
    }
    // plan.db is empty — import the file's JSON object (if it parses) into plan.db, then delete it.
    let parsed = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .filter(serde_json::Value::is_object);
    match parsed {
        Some(value) => match open(project_key).and_then(|s| s.fleet_set(&value).map_err(|e| e.to_string())) {
            Ok(()) => {
                let _ = std::fs::remove_file(&file);
                log::info!("migrate_stray_fleet_json({project_key}): imported legacy fleet.json into plan.db");
            }
            Err(e) => log::warn!("migrate_stray_fleet_json({project_key}): import failed, keeping file: {e}"),
        },
        None => {
            // Unparseable / non-object stray file — it carries no usable fleet; drop the dead artifact.
            let _ = std::fs::remove_file(&file);
            log::warn!("migrate_stray_fleet_json({project_key}): dropped unparseable fleet.json");
        }
    }
}

#[tauri::command]
pub(crate) fn plan_set_fleet(project_key: String, fleet: serde_json::Value) -> Result<(), String> {
    open(&project_key)?.fleet_set(&fleet).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_get_fleet(project_key: String) -> Result<Option<serde_json::Value>, String> {
    // plan.db is the sole fleet store (#1805) — fold a stray legacy fleet.json in before reading so
    // it can't be lost, then it's gone for good (idempotent; plan.db wins on conflict).
    migrate_stray_fleet_json(&project_key);
    open(&project_key)?.fleet_get().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_remove_stream(project_key: String, id: String) -> Result<(), String> {
    open(&project_key)?.fleet_stream_remove(&id).map_err(|e| e.to_string())
}

// ── deploy config (#1020) — the Deploy stage's structured config as one blob (the poll coerces it). ──

#[tauri::command]
pub(crate) fn plan_set_deploy(project_key: String, config: serde_json::Value) -> Result<(), String> {
    open(&project_key)?.deploy_set(&config).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_get_deploy(project_key: String) -> Result<Option<serde_json::Value>, String> {
    open(&project_key)?.deploy_get().map_err(|e| e.to_string())
}

// ── dependency manifest (#1191) — the locked library manifest as one blob (was `dependencies.json`).
//    The poll coerces it into the DEPENDENCIES section + the one-time legacy-file import writes here. ──

#[tauri::command]
pub(crate) fn plan_set_deps(project_key: String, manifest: serde_json::Value) -> Result<(), String> {
    open(&project_key)?.deps_set(&manifest).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_get_deps(project_key: String) -> Result<Option<serde_json::Value>, String> {
    open(&project_key)?.deps_get().map_err(|e| e.to_string())
}

// ── MCP assignments (#1021) — catalog server names scoped to the project; the poll resolves each. ──

#[tauri::command]
pub(crate) fn plan_add_mcp(project_key: String, name: String) -> Result<(), String> {
    open(&project_key)?.mcp_add(&name).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_list_mcp(project_key: String) -> Result<Vec<String>, String> {
    open(&project_key)?.mcp_list().map_err(|e| e.to_string())
}

// ── automations (#2009) — structured cron/on-demand recipes assigned to the project; the section
//    poll reflects `plan_list_automations` into the store (replacing the <automation_assign> tag). ──

#[tauri::command]
pub(crate) fn plan_list_automations(project_key: String) -> Result<Vec<Automation>, String> {
    open(&project_key)?.automation_list().map_err(|e| e.to_string())
}

// ── startup scripts (#2010) — per-repo kickoff/triage prompt docs; the section poll reflects
//    `plan_list_startup` into the store (replacing the <startup_script> tag). ──

#[tauri::command]
pub(crate) fn plan_list_startup(project_key: String) -> Result<Vec<StartupScript>, String> {
    open(&project_key)?.startup_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_remove_mcp(project_key: String, name: String) -> Result<(), String> {
    open(&project_key)?.mcp_remove(&name).map_err(|e| e.to_string())
}

// ── authored blueprint (#1022) — the blueprint an authoring project designs, as one blob. ──

#[tauri::command]
pub(crate) fn plan_set_blueprint(project_key: String, blueprint: serde_json::Value) -> Result<(), String> {
    open(&project_key)?.blueprint_set(&blueprint).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_get_blueprint(project_key: String) -> Result<Option<serde_json::Value>, String> {
    open(&project_key)?.blueprint_get().map_err(|e| e.to_string())
}

// ── Context required-set (#1019/#1028) — the dynamic set of topics this project requires. The poll
//    reads it (`plan_list_discovery`); the blueprint seed / planner shapes it (`plan_require_discovery`).
//    Context files gate on GENERATION (the file exists), not confirmation — there is no confirm. ──

#[tauri::command]
pub(crate) fn plan_list_discovery(project_key: String) -> Result<Vec<String>, String> {
    open(&project_key)?.discovery_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_require_discovery(project_key: String, topic: String, required: bool) -> Result<(), String> {
    open(&project_key)?.discovery_require(&topic, required).map_err(|e| e.to_string())
}

// ── triage runs (#1004) — per-repo "last triage launch" timestamp + the since-T delta, so a re-run
//    resumes cheaply from what changed instead of re-ingesting the whole project. ──

#[tauri::command]
pub(crate) fn plan_triage_record_run(project_key: String, repo: String) -> Result<i64, String> {
    open(&project_key)?.triage_record_run(&repo).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_triage_last_run(project_key: String, repo: String) -> Result<Option<i64>, String> {
    open(&project_key)?.triage_last_run(&repo).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn plan_issues_changed_since(project_key: String, repo: String, since: i64) -> Result<Vec<PlanIssue>, String> {
    open(&project_key)?.issues_changed_since(&repo, since).map_err(|e| e.to_string())
}

// ── Self-correction lessons (#1362) ──────────────────────────────────────────────
// The `bsc-learned` helper captures candidates into plan.db via the `bsc plan lesson` CLI; these
// commands back the desktop "Pending lessons" review queue. Confirm/discard only set the user's
// verdict — turning a confirmed lesson INTO a project skill is the frontend's job (it owns the
// SkillDef shape + the skilldb bridge), so this bridge stays a thin wrapper over the plan store.

/// The project's lesson candidates, newest-touched first. `status` filters (`pending` for the queue);
/// empty returns all.
#[tauri::command]
pub(crate) fn plan_lesson_list(project_key: String, status: String) -> Result<Vec<Lesson>, String> {
    open(&project_key)?.lesson_list(&status).map_err(|e| e.to_string())
}

/// The user accepts a candidate — mark it `confirmed`. The caller then materializes it as a
/// project-scoped skill via the skilldb bridge.
#[tauri::command]
pub(crate) fn plan_lesson_confirm(project_key: String, id: String) -> Result<(), String> {
    open(&project_key)?.lesson_set_status(&id, "confirmed").map(|_| ()).map_err(|e| e.to_string())
}

/// The user rejects a candidate — mark it `discarded` (kept as a record; its `seen` count still grows
/// if the mistake recurs).
#[tauri::command]
pub(crate) fn plan_lesson_discard(project_key: String, id: String) -> Result<(), String> {
    open(&project_key)?.lesson_set_status(&id, "discarded").map(|_| ()).map_err(|e| e.to_string())
}

/// Permanently delete a lesson candidate.
#[tauri::command]
pub(crate) fn plan_lesson_remove(project_key: String, id: String) -> Result<(), String> {
    open(&project_key)?.lesson_remove(&id).map_err(|e| e.to_string())
}

/// Sweep un-confirmed candidates older than `before` (epoch seconds) — the 14-day expiry. Returns the
/// number removed.
#[tauri::command]
pub(crate) fn plan_lesson_expire(project_key: String, before: i64) -> Result<usize, String> {
    open(&project_key)?.lesson_expire_pending(before).map_err(|e| e.to_string())
}


#[cfg(test)]
mod relocated_tests {
    #![allow(unused_imports)]
    use super::*;
    use crate::prelude::*;
    use crate::project::{hub::*, plan_files::*, plan_db::*, blueprints::*, dead_code::*, ui_skeleton::*, files::*};
    use crate::fleet::{worktree::*, director::*, inspect::*};
    use crate::extensions::{mcp::*, cfg::*};
    use crate::testutil::{ENV_LOCK, temp_home, write_file};

    #[test]
    fn plan_get_fleet_imports_a_stray_fleet_json_then_deletes_it() {
        // #1805: plan.db is the sole fleet store. A stray legacy fleet.json in a hub whose plan.db has
        // no fleet is imported into plan.db on the first read, then the file is deleted.
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("fleetmig");
        let key = "test-fleet-migrate".to_string();
        let file = project_dir(&key).join("fleet.json");
        write_file(&file, r#"{"recommended":2,"reasoning":"r","streams":[{"id":"api","repo":"o/api"}]}"#);

        let fleet = plan_get_fleet(key.clone()).unwrap().expect("fleet imported from the stray file");
        assert_eq!(fleet.get("recommended").and_then(|v| v.as_i64()), Some(2));
        let streams = fleet.get("streams").and_then(|v| v.as_array()).unwrap();
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0].get("id").and_then(|v| v.as_str()), Some("api"));
        assert!(!file.exists(), "the stray fleet.json is deleted after import");

        std::fs::remove_dir_all(&home).ok();
    }
    #[test]
    fn plan_get_fleet_keeps_plan_db_and_deletes_a_stray_fleet_json() {
        // #1805: when plan.db ALREADY has a fleet, a stray fleet.json is deleted without overwriting
        // the DB (plan.db wins, never read from disk).
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("fleetwins");
        let key = "test-fleet-wins".to_string();
        // Seed plan.db with the authoritative fleet.
        plan_set_fleet(key.clone(), serde_json::json!({
            "recommended": 1, "streams": [ { "id": "db-stream", "repo": "o/db" } ]
        })).unwrap();
        // A conflicting stray file that must NOT overwrite the DB.
        let file = project_dir(&key).join("fleet.json");
        write_file(&file, r#"{"recommended":9,"streams":[{"id":"stale","repo":"o/stale"}]}"#);

        let fleet = plan_get_fleet(key.clone()).unwrap().expect("plan.db fleet present");
        let streams = fleet.get("streams").and_then(|v| v.as_array()).unwrap();
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0].get("id").and_then(|v| v.as_str()), Some("db-stream"), "plan.db wins");
        assert_eq!(fleet.get("recommended").and_then(|v| v.as_i64()), Some(1), "DB meta untouched");
        assert!(!file.exists(), "the stray fleet.json is deleted even though plan.db won");

        std::fs::remove_dir_all(&home).ok();
    }
}
