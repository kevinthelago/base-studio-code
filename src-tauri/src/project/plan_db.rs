// Native per-project plan store (#plan-db) helpers. The store itself lives in the Tauri-free `plandb`
// crate (shared with the `bsc plan` agent CLI); this module resolves the project key →
// `projects/<key>/plan.db` and exposes the few reads the host still needs directly.
//
// The former per-verb Tauri command wrappers (plan_upsert_issue, plan_get_fleet, plan_lesson_*, …)
// were retired (#2125): the UI now drives plan.db entirely through the generic `bsc plan …` bridge,
// so only the internal helpers used by other host modules remain here.

use crate::StrErr;
use plandb::Store;
use std::path::PathBuf;

fn db_path(project_key: &str) -> PathBuf {
    crate::plan_db_path(project_key)
}

fn open(project_key: &str) -> Result<Store, String> {
    Store::open(&db_path(project_key)).str_err()
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
    Store::open(&path).and_then(|s| s.clear()).str_err()
}
