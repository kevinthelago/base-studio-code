// Native per-project plan store (#plan-db) helpers. The store itself lives in the Tauri-free `plandb`
// crate (shared with the `bsc plan` agent CLI); this module resolves the project key →
// `projects/<key>/plan.db` and exposes the few reads the host still needs directly.
//
// The former per-verb Tauri command wrappers (plan_upsert_issue, plan_get_fleet, plan_lesson_*, …)
// were retired (#2125): the UI now drives plan.db entirely through the generic `bsc plan …` bridge,
// so only the internal helpers used by other host modules remain here.

use crate::StrErr;
use plandb::Store;
use std::path::{Path, PathBuf};

fn db_path(project_key: &str) -> PathBuf {
    crate::plan_db_path(project_key)
}

/// The SQLite main file + its WAL sidecars — moved together so uncommitted WAL frames aren't lost.
const DB_SUFFIXES: [&str; 3] = ["", "-wal", "-shm"];

/// Append a suffix to a path's filename without lossy string round-tripping (`plans/x.db` + `-wal`
/// → `plans/x.db-wal`). Used to name SQLite's `-wal`/`-shm` sidecars beside the relocated `.db`.
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// Relocate one hub's `plan.db` (+ `-wal`/`-shm`) to `new`, if the hub has one and `new` is absent.
/// Idempotent: when `new` already exists the stale in-hub copy is dropped instead. Returns whether the
/// main `.db` was moved. Split out so it's testable against temp dirs.
fn relocate_one(hub: &Path, new: &Path) -> bool {
    let old = hub.join("plan.db");
    if !old.is_file() {
        return false;
    }
    if new.exists() {
        // Already relocated (or a same-key central store exists) — drop the stale in-hub copy + sidecars.
        for suf in DB_SUFFIXES {
            let _ = std::fs::remove_file(with_suffix(&hub.join("plan.db"), suf));
        }
        return false;
    }
    if let Some(parent) = new.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut moved = false;
    for suf in DB_SUFFIXES {
        let src = with_suffix(&hub.join("plan.db"), suf);
        if !src.exists() {
            continue;
        }
        match std::fs::rename(&src, with_suffix(new, suf)) {
            Ok(()) => moved |= suf.is_empty(),
            Err(e) => log::warn!("relocate plan.db{suf}: {e}"),
        }
    }
    moved
}

/// One-time relocation (#2996): move every in-hub `projects/<key>/plan.db` to the central
/// `plans/<key>.db` store, so the plan is folder-independent (the DB is the source of truth; the hub
/// is a projection materialized at triage, epic #2993). Runs at STARTUP after the draft-hub
/// consolidation, before any session opens a plan.db — so nothing holds one and the move can't fail on
/// the Windows lock. Idempotent + best-effort. `error.db` stays in the hub (a runtime store, only live
/// at execution). See [`crate::plan_db_path`].
pub(crate) fn migrate_plan_dbs_to_central() {
    let Ok(entries) = std::fs::read_dir(crate::projects_root()) else { return };
    for entry in entries.flatten() {
        let hub = entry.path();
        if !hub.is_dir() {
            continue;
        }
        let Some(key) = hub.file_name().and_then(|n| n.to_str()) else { continue };
        if key.starts_with('.') {
            continue;
        }
        if relocate_one(&hub, &crate::plan_db_path(key)) {
            log::info!("relocated plan.db {key:?} → plans/");
        }
    }
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

/// The project's deploy config blob from plan.db, or None. Like [`fleet_for`] this does NOT create a
/// db — the fleet launch probes every project, so it must never materialize an empty store.
pub(crate) fn deploy_for(project_key: &str) -> Option<serde_json::Value> {
    if !db_path(project_key).exists() {
        return None;
    }
    open(project_key).ok().and_then(|s| s.deploy_get().ok().flatten())
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

/// Plan.db artifacts of `kind` (#2997 A2) as `(name, content)` pairs — the DB-backed source for
/// planner-authored content (discovery/section/contract/kickoff) as it migrates OFF hub files, so the
/// hub becomes a pure projection. Empty when there's no plan.db (never MATERIALIZES one — mirrors
/// [`fleet_for`]); best-effort on any read error. See [`plandb`]'s `artifact_list`.
pub(crate) fn artifacts_of_kind(project_key: &str, kind: &str) -> Vec<(String, String)> {
    if !db_path(project_key).exists() {
        return Vec::new();
    }
    open(project_key)
        .ok()
        .and_then(|s| s.artifact_list(Some(kind)).ok())
        .map(|arts| arts.into_iter().map(|a| (a.name, a.content)).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relocate_one_moves_the_db_and_wal_sidecars_then_is_idempotent() {
        let tmp = std::env::temp_dir().join(format!("bsc-relocate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let hub = tmp.join("projects").join("my-app");
        let new = tmp.join("plans").join("my-app.db");
        std::fs::create_dir_all(&hub).unwrap();
        std::fs::write(hub.join("plan.db"), b"main").unwrap();
        std::fs::write(hub.join("plan.db-wal"), b"wal").unwrap();
        std::fs::write(hub.join("plan.db-shm"), b"shm").unwrap();

        // First run — the main db AND its WAL sidecars relocate; the in-hub copies are gone.
        assert!(relocate_one(&hub, &new), "the main db moved");
        assert_eq!(std::fs::read(&new).unwrap(), b"main");
        assert_eq!(std::fs::read(with_suffix(&new, "-wal")).unwrap(), b"wal", "WAL sidecar moved too");
        assert_eq!(std::fs::read(with_suffix(&new, "-shm")).unwrap(), b"shm");
        assert!(!hub.join("plan.db").exists(), "in-hub copy gone");

        // Second run — central already present → idempotent no-move; a stale in-hub copy is dropped.
        std::fs::write(hub.join("plan.db"), b"stale").unwrap();
        assert!(!relocate_one(&hub, &new), "idempotent when the central store exists");
        assert!(!hub.join("plan.db").exists(), "stale in-hub copy dropped");
        assert_eq!(std::fs::read(&new).unwrap(), b"main", "central copy untouched");

        // A hub with no plan.db → no-op.
        let empty = tmp.join("projects").join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(!relocate_one(&empty, &tmp.join("plans").join("empty.db")));

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
