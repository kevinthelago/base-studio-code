use crate::*;

/// The user blueprint store, rooted at `~/.base-studio-code/blueprints/`. File CRUD + the
/// path-traversal slug guard live in the Tauri-free `bsc-blueprint` crate (shared with the
/// `bsc-blueprint` session CLI), so the slug guard has ONE definition (#1761).
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
