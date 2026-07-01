use crate::prelude::*;

/// Path of the session-lock marker (#1041).
pub(crate) fn session_lock_path() -> std::path::PathBuf {
    bsc_base_dir().join(".session-lock")
}
/// Claim the session lock for this run (#1041): returns whether the marker was ALREADY present
/// (= the previous shutdown was unclean — the Exit handler never deleted it), then (re)writes it.
/// Pure over an explicit path so it's testable; the pid content is just for debugging.
pub(crate) fn claim_session_lock(path: &std::path::Path) -> bool {
    let was_held = path.exists();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, std::process::id().to_string());
    was_held
}
/// Whether the previous shutdown was unclean (#1041). The frontend reads this once at boot to offer
/// restoring the sessions that were running (a clean quit returns `false`).
#[tauri::command]
pub(crate) fn was_unclean_shutdown(state: tauri::State<UncleanShutdown>) -> bool {
    state.0
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
    fn session_lock_detects_unclean_shutdown() {
        // #1041: the marker surviving a run = unclean shutdown (the Exit handler never deleted it).
        let dir = std::env::temp_dir().join(format!(
            "bsc-lock-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0),
        ));
        let lock = dir.join(".session-lock");
        // First claim (clean / first run): marker not present yet.
        assert!(!claim_session_lock(&lock), "first claim sees a clean state");
        assert!(lock.exists(), "claim writes the marker");
        // A second claim WITHOUT a clean release (no Exit delete) = unclean prior shutdown.
        assert!(claim_session_lock(&lock), "surviving marker => unclean");
        // A clean release (what RunEvent::Exit does), then a claim = clean again.
        let _ = std::fs::remove_file(&lock);
        assert!(!claim_session_lock(&lock), "after a clean release the next run is clean");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
