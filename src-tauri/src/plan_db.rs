// Tauri command surface over the native per-project plan store (#plan-db). The store itself lives in
// the Tauri-free `plandb` crate (shared with the `bsc-plan` agent CLI); this module only resolves the
// project key → `projects/<key>/plan.db` and adapts the `Store` API to Tauri commands for the UI.

use plandb::{PlanIssue, Store, STATUSES};
use std::path::PathBuf;

fn db_path(project_key: &str) -> PathBuf {
    crate::project_dir(project_key).join("plan.db")
}

fn open(project_key: &str) -> Result<Store, String> {
    Store::open(&db_path(project_key)).map_err(|e| e.to_string())
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

/// Materialize `issues.json` in the project hub from the DB (the render-on-launch projection).
#[tauri::command]
pub fn plan_write_issues_json(project_key: String) -> Result<(), String> {
    let json = open(&project_key)?.render_issues_json().map_err(|e| e.to_string())?;
    std::fs::write(crate::project_dir(&project_key).join("issues.json"), json).map_err(|e| e.to_string())
}
