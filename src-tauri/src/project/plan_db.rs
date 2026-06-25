// Tauri command surface over the native per-project plan store (#plan-db). The store itself lives in
// the Tauri-free `plandb` crate (shared with the `bsc-plan` agent CLI); this module only resolves the
// project key → `projects/<key>/plan.db` and adapts the `Store` API to Tauri commands for the UI.

use plandb::{PlanFeature, PlanIssue, PlanPhase, Store, STATUSES};
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
pub fn plan_upsert_issue(project_key: String, issue: PlanIssue) -> Result<(), String> {
    open(&project_key)?.upsert(&issue).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_list_issues(
    project_key: String,
    status: Option<String>,
    stream: Option<String>,
) -> Result<Vec<PlanIssue>, String> {
    open(&project_key)?
        .list(status.as_deref(), stream.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_remove_issue(project_key: String, issue_ref: String) -> Result<(), String> {
    open(&project_key)?.remove(&issue_ref).map_err(|e| e.to_string())
}

/// Set an issue's execution status (workers: in_progress/complete; director: verified/failed).
/// Validates against the known lifecycle so a typo can't wedge the board.
#[tauri::command]
pub fn plan_set_issue_status(project_key: String, issue_ref: String, status: String) -> Result<(), String> {
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
pub fn plan_upsert_feature(project_key: String, feature: PlanFeature) -> Result<String, String> {
    open(&project_key)?.feature_upsert(&feature).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_list_features(project_key: String) -> Result<Vec<PlanFeature>, String> {
    open(&project_key)?.feature_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_remove_feature(project_key: String, slug: String) -> Result<(), String> {
    open(&project_key)?.feature_remove(&slug).map_err(|e| e.to_string())
}

// ── linked repos (#1012) — durable per-project repo links in the hub's plan.db, so a zustand /
//    app-state reset can't lose them (the store-only persistence proved fragile). ──────────────

#[tauri::command]
pub fn plan_add_repo(project_key: String, full_name: String) -> Result<(), String> {
    open(&project_key)?.repo_add(&full_name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_list_repos(project_key: String) -> Result<Vec<String>, String> {
    open(&project_key)?.repo_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_remove_repo(project_key: String, full_name: String) -> Result<(), String> {
    open(&project_key)?.repo_remove(&full_name).map_err(|e| e.to_string())
}

// ── roadmap phases (#1017) — names/descriptions; the structure card + publish read them from here. ──

#[tauri::command]
pub fn plan_upsert_phase(project_key: String, phase: PlanPhase) -> Result<(), String> {
    open(&project_key)?.phase_upsert(&phase).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_list_phases(project_key: String) -> Result<Vec<PlanPhase>, String> {
    open(&project_key)?.phase_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_remove_phase(project_key: String, name: String) -> Result<(), String> {
    open(&project_key)?.phase_remove(&name).map_err(|e| e.to_string())
}

// ── fleet + per-stream permissions (#1018) — the whole FleetPlan as meta + per-stream rows. ─────────

#[tauri::command]
pub fn plan_set_fleet(project_key: String, fleet: serde_json::Value) -> Result<(), String> {
    open(&project_key)?.fleet_set(&fleet).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_get_fleet(project_key: String) -> Result<Option<serde_json::Value>, String> {
    open(&project_key)?.fleet_get().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_remove_stream(project_key: String, id: String) -> Result<(), String> {
    open(&project_key)?.fleet_stream_remove(&id).map_err(|e| e.to_string())
}

// ── deploy config (#1020) — the Deploy stage's structured config as one blob (the poll coerces it). ──

#[tauri::command]
pub fn plan_set_deploy(project_key: String, config: serde_json::Value) -> Result<(), String> {
    open(&project_key)?.deploy_set(&config).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_get_deploy(project_key: String) -> Result<Option<serde_json::Value>, String> {
    open(&project_key)?.deploy_get().map_err(|e| e.to_string())
}

// ── dependency manifest (#1191) — the locked library manifest as one blob (was `dependencies.json`).
//    The poll coerces it into the DEPENDENCIES section + the one-time legacy-file import writes here. ──

#[tauri::command]
pub fn plan_set_deps(project_key: String, manifest: serde_json::Value) -> Result<(), String> {
    open(&project_key)?.deps_set(&manifest).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_get_deps(project_key: String) -> Result<Option<serde_json::Value>, String> {
    open(&project_key)?.deps_get().map_err(|e| e.to_string())
}

// ── MCP assignments (#1021) — catalog server names scoped to the project; the poll resolves each. ──

#[tauri::command]
pub fn plan_add_mcp(project_key: String, name: String) -> Result<(), String> {
    open(&project_key)?.mcp_add(&name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_list_mcp(project_key: String) -> Result<Vec<String>, String> {
    open(&project_key)?.mcp_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_remove_mcp(project_key: String, name: String) -> Result<(), String> {
    open(&project_key)?.mcp_remove(&name).map_err(|e| e.to_string())
}

// ── authored blueprint (#1022) — the blueprint an authoring project designs, as one blob. ──

#[tauri::command]
pub fn plan_set_blueprint(project_key: String, blueprint: serde_json::Value) -> Result<(), String> {
    open(&project_key)?.blueprint_set(&blueprint).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_get_blueprint(project_key: String) -> Result<Option<serde_json::Value>, String> {
    open(&project_key)?.blueprint_get().map_err(|e| e.to_string())
}

// ── Context required-set (#1019/#1028) — the dynamic set of topics this project requires. The poll
//    reads it (`plan_list_context`); the blueprint seed / planner shapes it (`plan_require_context`).
//    Context files gate on GENERATION (the file exists), not confirmation — there is no confirm. ──

#[tauri::command]
pub fn plan_list_context(project_key: String) -> Result<Vec<String>, String> {
    open(&project_key)?.context_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_require_context(project_key: String, topic: String, required: bool) -> Result<(), String> {
    open(&project_key)?.context_require(&topic, required).map_err(|e| e.to_string())
}

// ── triage runs (#1004) — per-repo "last triage launch" timestamp + the since-T delta, so a re-run
//    resumes cheaply from what changed instead of re-ingesting the whole project. ──

#[tauri::command]
pub fn plan_triage_record_run(project_key: String, repo: String) -> Result<i64, String> {
    open(&project_key)?.triage_record_run(&repo).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_triage_last_run(project_key: String, repo: String) -> Result<Option<i64>, String> {
    open(&project_key)?.triage_last_run(&repo).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_issues_changed_since(project_key: String, repo: String, since: i64) -> Result<Vec<PlanIssue>, String> {
    open(&project_key)?.issues_changed_since(&repo, since).map_err(|e| e.to_string())
}

