use crate::prelude::*;

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
    fn project_file_write_then_read_roundtrips_and_blocks_escape() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("ppf");
        let key = "test-pipeline-files".to_string();

        // Write nested under a pipeline subdir, then read the subdir back.
        write_project_file(key.clone(), "pipelines/vue/button.vue".to_string(), "<template/>".to_string()).unwrap();
        write_project_file(key.clone(), "pipelines/vue/card.vue".to_string(), "<card/>".to_string()).unwrap();
        // A fresh project's hub is the draft hub (#904) — resolve, don't hardcode projects/.
        let proj = project_dir(&key);
        assert!(proj.join("pipelines").join("vue").join("button.vue").exists());

        let mut files = read_project_files(key.clone(), "pipelines/vue".to_string());
        files.sort();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].0, "button.vue");
        assert_eq!(files[0].1, "<template/>");

        // Escapes are rejected on write and yield empty on read.
        assert!(write_project_file(key.clone(), "../escape.txt".to_string(), "x".to_string()).is_err());
        assert!(write_project_file(key.clone(), "/abs.txt".to_string(), "x".to_string()).is_err());
        assert!(write_project_file(key.clone(), "  ".to_string(), "x".to_string()).is_err());
        assert!(read_project_files(key.clone(), "../..".to_string()).is_empty());

        // Missing subdir -> empty, no panic.
        assert!(read_project_files(key.clone(), "pipelines/none".to_string()).is_empty());

        std::fs::remove_dir_all(&home).ok();
    }
    #[test]
    fn write_project_file_bytes_decodes_base64_and_blocks_escape() {
        use base64::Engine;
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("ppfb");
        let key = "test-intake".to_string();

        // Stage a "binary" file (raw bytes, incl. a NUL) from base64.
        let bytes: &[u8] = &[0x89, b'P', b'N', b'G', 0x00, 0xFF, 0x10];
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        write_project_file_bytes(key.clone(), ".intake/logo.png".to_string(), b64).unwrap();
        let path = project_dir(&key).join(".intake").join("logo.png");
        assert!(path.exists());
        assert_eq!(std::fs::read(&path).unwrap(), bytes, "bytes round-trip exactly");

        // Bad base64 + path escapes are rejected.
        assert!(write_project_file_bytes(key.clone(), ".intake/x.png".to_string(), "not base64!!".to_string()).is_err());
        assert!(write_project_file_bytes(key.clone(), "../escape.png".to_string(), "AAAA".to_string()).is_err());
        assert!(write_project_file_bytes(key.clone(), "/abs.png".to_string(), "AAAA".to_string()).is_err());

        std::fs::remove_dir_all(&home).ok();
    }
}
