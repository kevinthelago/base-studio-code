// Document store reads (extracted from lib.rs, #758).
//
// Resolves the base-studio-code data dir and reads on-disk markdown documents
// (e.g. a session's kickoff/checkpoint/reference docs) by base-relative path.
// Pure of Tauri beyond the command attrs. The KB-page listing/write surface was
// removed with the page itself (#1460 / #1504); only the read side remains.

use crate::bsc_base_dir;

/// Absolute path of the base-studio-code data dir, so the frontend can build
/// project/repo session paths: `<base>/projects/<sanitized project>/<repo>`.
#[tauri::command]
pub(crate) fn get_base_dir() -> String {
    bsc_base_dir().to_string_lossy().into_owned()
}

/// Validates a base-relative posix path for read: rejects `..` segments,
/// rejects absolute paths, and only permits paths under `documents/` or
/// `projects/`. Returns the resolved absolute path on success.
fn resolve_store_path(relpath: &str) -> Result<std::path::PathBuf, String> {
    if relpath.contains("..") {
        return Err("invalid relpath: contains '..'".to_string());
    }
    let normalized = relpath.replace('\\', "/");
    // Reject absolute paths (unix `/x`, windows `C:/x` or `\\server`).
    let is_absolute = normalized.starts_with('/')
        || std::path::Path::new(relpath).is_absolute()
        || (normalized.len() >= 2 && normalized.as_bytes()[1] == b':');
    if is_absolute {
        return Err("invalid relpath: must be relative".to_string());
    }
    if !(normalized.starts_with("documents/") || normalized.starts_with("projects/")) {
        return Err("invalid relpath: must begin with documents/ or projects/".to_string());
    }
    Ok(bsc_base_dir().join(relpath))
}

/// Reads one document by its base-relative posix path. Path must be under
/// `documents/` or `projects/` and must not contain `..` (see
/// [`resolve_store_path`]).
#[tauri::command]
pub(crate) async fn read_document(relpath: String) -> Result<String, String> {
    let path = resolve_store_path(&relpath)?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{ENV_LOCK, temp_home, write_file};

    #[test]
    fn read_document_reads_store_files_and_rejects_traversal() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = temp_home("readdoc");
        let base = bsc_base_dir();

        // A document placed under documents/ reads back by base-relative path.
        write_file(&base.join("documents").join("note.md"), "hello world");
        let got = tauri::async_runtime::block_on(
            read_document("documents/note.md".to_string())
        ).expect("read succeeds");
        assert_eq!(got, "hello world");

        // Documents under projects/ read too.
        write_file(&base.join("projects").join("p1").join("goal.md"), "the goal");
        assert_eq!(
            tauri::async_runtime::block_on(read_document("projects/p1/goal.md".to_string()))
                .expect("project read succeeds"),
            "the goal",
        );

        // Traversal is rejected.
        assert!(tauri::async_runtime::block_on(
            read_document("documents/../secret.md".to_string())
        ).is_err(), "`..` rejected on read");

        // Out-of-store roots are rejected.
        assert!(tauri::async_runtime::block_on(
            read_document("repos/x.md".to_string())
        ).is_err(), "non documents/projects root rejected");

        // Absolute paths are rejected.
        assert!(tauri::async_runtime::block_on(
            read_document("/etc/passwd".to_string())
        ).is_err(), "absolute path rejected");

        std::fs::remove_dir_all(&home).ok();
    }
}
