use crate::*;

/// Write one file into a project's hub — the shared persistence primitive pipelines call
/// (#…). Pipelines own *what*/*where*/*when* they save; this just performs the path-safe
/// write under `projects/<key>/`. `relpath` is resolved under the project dir; any attempt
/// to escape it (absolute, drive prefix, or `..`) is rejected.
#[tauri::command]
pub(crate) fn write_project_file(project_key: String, relpath: String, contents: String) -> Result<(), String> {
    if sanitize_project_key(&project_key).is_empty() {
        return Err("write_project_file: empty project_key".to_string());
    }
    if relpath.trim().is_empty() {
        return Err("write_project_file: empty relpath".to_string());
    }
    let rel = std::path::Path::new(&relpath);
    if !is_safe_relpath(rel) {
        return Err(format!("write_project_file: unsafe relpath '{relpath}'"));
    }
    let target = project_dir(&project_key).join(rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("write_project_file: {e}"))?;
    }
    std::fs::write(&target, contents).map_err(|e| format!("write_project_file: {e}"))?;
    log::info!("write_project_file({project_key}): wrote {relpath}");
    Ok(())
}
/// Write a BINARY file into a project's hub from base64 (#604) — the file-intake pipeline
/// stages dropped files (images, fonts, any binary) this way, since `write_project_file`
/// only handles text. Same path-safety rules. `b64` is standard base64 of the file bytes.
#[tauri::command]
pub(crate) fn write_project_file_bytes(project_key: String, relpath: String, b64: String) -> Result<(), String> {
    use base64::Engine;
    if sanitize_project_key(&project_key).is_empty() {
        return Err("write_project_file_bytes: empty project_key".to_string());
    }
    if relpath.trim().is_empty() {
        return Err("write_project_file_bytes: empty relpath".to_string());
    }
    let rel = std::path::Path::new(&relpath);
    if !is_safe_relpath(rel) {
        return Err(format!("write_project_file_bytes: unsafe relpath '{relpath}'"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("write_project_file_bytes: bad base64: {e}"))?;
    let target = project_dir(&project_key).join(rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("write_project_file_bytes: {e}"))?;
    }
    std::fs::write(&target, &bytes).map_err(|e| format!("write_project_file_bytes: {e}"))?;
    log::info!("write_project_file_bytes({project_key}): wrote {relpath} ({} bytes)", bytes.len());
    Ok(())
}
/// Read every file under a project-hub subdir (relpath → contents) so a pipeline can
/// rehydrate its saved results (#…). Empty when the subdir is missing or `subdir` would
/// escape the project dir.
#[tauri::command]
pub(crate) fn read_project_files(project_key: String, subdir: String) -> Vec<(String, String)> {
    let rel = std::path::Path::new(&subdir);
    if !is_safe_relpath(rel) {
        return Vec::new();
    }
    read_files_dir(&project_dir(&project_key).join(rel))
}
