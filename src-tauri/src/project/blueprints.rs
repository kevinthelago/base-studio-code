use crate::*;

/// A user blueprint's on-disk path; the id is slugified so it can't escape the dir.
pub(crate) fn blueprint_file(id: &str) -> Result<std::path::PathBuf, String> {
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err("blueprint id is empty/invalid".into());
    }
    Ok(bsc_base_dir().join("blueprints").join(format!("{safe}.json")))
}
/// The JSON of every user blueprint on disk (the library hydrates from this + the bundled built-ins).
/// Skips unreadable/empty files; a missing dir ⇒ empty.
#[tauri::command]
pub(crate) fn list_blueprints() -> Vec<String> {
    let dir = bsc_base_dir().join("blueprints");
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(s) = std::fs::read_to_string(&p) {
                if !s.trim().is_empty() {
                    out.push(s);
                }
            }
        }
    }
    out
}
/// Persist a user blueprint to `blueprints/<id>.json` (written verbatim — the frontend owns the shape).
#[tauri::command]
pub(crate) fn write_blueprint(id: String, json: String) -> Result<(), String> {
    let path = blueprint_file(&id)?;
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    std::fs::write(&path, json).map_err(|e| format!("write_blueprint: {e}"))
}
/// Remove a user blueprint's file (no-op if absent).
#[tauri::command]
pub(crate) fn delete_blueprint(id: String) -> Result<(), String> {
    let path = blueprint_file(&id)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("delete_blueprint: {e}"))?;
    }
    Ok(())
}
