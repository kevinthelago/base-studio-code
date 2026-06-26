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

/// Validates a base-relative posix path for read: rejects `..`/absolute/out-of-root
/// paths via the shared [`crate::platform::fsx::is_safe_relpath`] guard (component-based,
/// the single source of truth), then layers docstore's extra requirement that the path
/// live under `documents/` or `projects/`. Returns the resolved absolute path on success.
fn resolve_store_path(relpath: &str) -> Result<std::path::PathBuf, String> {
    // Shared traversal/absolute guard: rejects `..` segments, absolute paths, and
    // Windows drive prefixes (component-based, so a legit name like `a..b.md` passes).
    if !crate::platform::fsx::is_safe_relpath(std::path::Path::new(relpath)) {
        return Err("invalid relpath: must be a relative path without traversal".to_string());
    }
    // Docstore-specific root allow-list on top of the shared guard.
    let normalized = relpath.replace('\\', "/");
    if !(normalized.starts_with("documents/") || normalized.starts_with("projects/")) {
        return Err("invalid relpath: must begin with documents/ or projects/".to_string());
    }
    Ok(bsc_base_dir().join(relpath))
}

/// Reads one document by its base-relative posix path. Path must be under
/// `documents/` or `projects/` and must not contain `..` (see
/// [`resolve_store_path`]).
#[tauri::command]
pub(crate) fn read_document(relpath: String) -> Result<String, String> {
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
        let got = read_document("documents/note.md".to_string()).expect("read succeeds");
        assert_eq!(got, "hello world");

        // Documents under projects/ read too.
        write_file(&base.join("projects").join("p1").join("goal.md"), "the goal");
        assert_eq!(
            read_document("projects/p1/goal.md".to_string())
                .expect("project read succeeds"),
            "the goal",
        );

        // A legit filename containing `..` (no traversal) is accepted: the guard is
        // component-based, not an over-broad `..` substring match (#1664).
        write_file(&base.join("documents").join("a..b.md"), "dotted name");
        assert_eq!(
            read_document("documents/a..b.md".to_string())
                .expect("dotted-name read succeeds"),
            "dotted name",
        );

        // Traversal is rejected.
        assert!(read_document("documents/../secret.md".to_string()).is_err(), "`..` rejected on read");

        // Out-of-store roots are rejected.
        assert!(read_document("repos/x.md".to_string()).is_err(), "non documents/projects root rejected");

        // Absolute paths are rejected.
        assert!(read_document("/etc/passwd".to_string()).is_err(), "absolute path rejected");

        std::fs::remove_dir_all(&home).ok();
    }
}
