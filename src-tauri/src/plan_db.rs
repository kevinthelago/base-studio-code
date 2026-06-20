// Tauri command surface over the native per-project plan store (#plan-db). The store itself lives in
// the Tauri-free `plandb` crate (shared with the `bsc-plan` agent CLI); this module only resolves the
// project key → `projects/<key>/plan.db` and adapts the `Store` API to Tauri commands for the UI.

use plandb::{PlanFeature, PlanIssue, Store, STATUSES};
use std::path::PathBuf;

fn db_path(project_key: &str) -> PathBuf {
    crate::project_dir(project_key).join("plan.db")
}

fn open(project_key: &str) -> Result<Store, String> {
    Store::open(&db_path(project_key)).map_err(|e| e.to_string())
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

