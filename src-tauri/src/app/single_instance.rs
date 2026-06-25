//! Single-instance guard (#1303): a second launch focuses the already-running window instead of
//! spawning a duplicate process. A duplicate would own its own in-memory `PtyState` — it can't see
//! or attach to the first instance's live PTY/`claude` sessions (their master fds + child processes
//! belong to the first process), so it would come up empty and race over the same on-disk hubs.
//!
//! Dev escape hatch: `BSC_ALLOW_MULTIPLE_INSTANCES=1` disables the guard so two builds can run side
//! by side intentionally.

use tauri::{AppHandle, Manager};

/// The env var name for the dev escape hatch.
const ALLOW_MULTIPLE: &str = "BSC_ALLOW_MULTIPLE_INSTANCES";

/// Whether running multiple instances is allowed — true ONLY when the escape hatch is exactly `1`.
/// Pure (takes the env value) so the gate decision is unit-testable.
pub(crate) fn multiple_instances_allowed(val: Option<&str>) -> bool {
    val == Some("1")
}

/// Whether the single-instance guard is enforced for this launch (the live read of the escape hatch).
pub(crate) fn guard_enforced() -> bool {
    !multiple_instances_allowed(std::env::var(ALLOW_MULTIPLE).ok().as_deref())
}

/// Raise + focus the main window. This is the single-instance callback body: it runs in the FIRST
/// (already-running) instance when a second launch is detected, so the user is returned to the
/// existing app instead of getting a duplicate.
pub(crate) fn focus_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_hatch_only_on_exactly_1() {
        // Default (var unset) and any value other than "1" ⇒ guard enforced.
        assert!(!multiple_instances_allowed(None));
        assert!(!multiple_instances_allowed(Some("")));
        assert!(!multiple_instances_allowed(Some("0")));
        assert!(!multiple_instances_allowed(Some("true")));
        assert!(!multiple_instances_allowed(Some("11")));
        // Exactly "1" ⇒ multiple instances allowed (guard off).
        assert!(multiple_instances_allowed(Some("1")));
    }
}
