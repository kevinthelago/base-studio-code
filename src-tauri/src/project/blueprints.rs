use crate::prelude::*;

/// The user blueprint store, rooted at `~/.base-studio-code/blueprints/`. File CRUD + the
/// path-traversal slug guard live in the Tauri-free `bsc-blueprint` crate (shared with the
/// `bsc blueprint` session CLI), so the slug guard has ONE definition (#1761).
fn blueprint_store() -> bsc_blueprint::Store {
    bsc_blueprint::Store::new(bsc_base_dir().join("blueprints"))
}

/// The JSON of every user blueprint on disk (the library hydrates from this + the bundled built-ins).
/// Skips unreadable/empty files; a missing dir ⇒ empty.
#[tauri::command]
pub(crate) fn list_blueprints() -> Vec<String> {
    blueprint_store().list()
}
/// Persist a user blueprint to `blueprints/<id>.json` (written verbatim — the frontend owns the shape).
#[tauri::command]
pub(crate) fn write_blueprint(id: String, json: String) -> Result<(), String> {
    blueprint_store().set(&id, &json)
}
/// Remove a user blueprint's file (no-op if absent).
#[tauri::command]
pub(crate) fn delete_blueprint(id: String) -> Result<(), String> {
    blueprint_store().remove(&id)
}

#[cfg(test)]
mod relocated_tests {
    #![allow(unused_imports)]
    use super::*;
    use crate::testutil::prelude::*;

    #[test]
    fn blueprint_storage_round_trips_and_stays_in_its_dir() {
        // User blueprints live as files under ~/.base-studio-code/blueprints/ (#blueprints).
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("bp");
        write_blueprint("bp-1".into(), r#"{"id":"bp-1","name":"Mine"}"#.into()).unwrap();
        write_blueprint("bp-2".into(), r#"{"id":"bp-2","name":"Other"}"#.into()).unwrap();
        let all = list_blueprints();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|s| s.contains("Mine")));
        delete_blueprint("bp-1".into()).unwrap();
        let after = list_blueprints();
        assert_eq!(after.len(), 1);
        assert!(after.iter().all(|s| !s.contains("Mine")), "deleted blueprint is gone");
        // The slug guard now lives in the `bsc-blueprint` crate (one definition, #1761) — the app
        // commands delegate to it. A slashy/dotty id is slugified (`.`/`/` → `_`) so it can never
        // escape the blueprints dir, and an empty id is rejected outright.
        let store = bsc_blueprint::Store::new(bsc_base_dir().join("blueprints"));
        let escaped = store.file("../../etc/passwd").unwrap();
        assert!(escaped.starts_with(bsc_base_dir().join("blueprints")), "must stay under blueprints/");
        assert!(store.file("").is_err());
        std::fs::remove_dir_all(&home).ok();
    }
}
