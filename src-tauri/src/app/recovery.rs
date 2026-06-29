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
