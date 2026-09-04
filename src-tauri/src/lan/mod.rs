//! `bsc lan analyzer` — opening and closing the analyser window.
//!
//! ## Why this builds the window in Rust when nothing else does
//!
//! Every other detached window in this app is opened from the frontend with
//! `new WebviewWindow(...)`, and `bsc navigate` works by emitting an event the
//! frontend applies and acks back. This one does not, deliberately.
//!
//! The analyser is a separate window so it survives the main surface being
//! wedged or mid-crash. Routing the request to open it *through* that surface
//! would make the escape hatch depend on the thing it is escaping — the one
//! circumstance where a person most wants it to work is exactly the one where
//! it would not.
//!
//! ## "Is it already open?" is asked, never remembered
//!
//! The answer comes from `get_webview_window(LABEL)` each time rather than from
//! any state this module keeps. A remembered flag drifts from reality the first
//! time a user closes the window with its own title-bar button, and then
//! `open` reports `AlreadyOpen` about a window that is not there.

use bsc_lan::analyzer::{decide, Action, AnalyzerRequest, AnalyzerResult, WINDOW_LABEL, WINDOW_URL};
use tauri::Manager;

/// Apply one analyser request against the live window set.
pub fn apply(app: &tauri::AppHandle, req: &AnalyzerRequest) -> Result<AnalyzerResult, String> {
    // Asked, not remembered — see the module docs.
    let existing = app.get_webview_window(WINDOW_LABEL);
    let outcome = decide(req.action, existing.is_some());

    match outcome {
        bsc_lan::analyzer::Outcome::Opened => {
            let url = tauri::WebviewUrl::App(WINDOW_URL.into());
            tauri::WebviewWindowBuilder::new(app, WINDOW_LABEL, url)
                .title("Spectrum analyzer — bsc lan")
                .inner_size(1100.0, 780.0)
                .min_inner_size(640.0, 480.0)
                .resizable(true)
                .build()
                .map_err(|e| format!("could not open the analyzer window: {e}"))?;
        }
        bsc_lan::analyzer::Outcome::Closed => {
            if let Some(w) = existing {
                w.close().map_err(|e| format!("could not close the analyzer window: {e}"))?;
            }
        }
        bsc_lan::analyzer::Outcome::AlreadyOpen => {
            // Focus rather than build a second window on the same label.
            if let Some(w) = existing {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        bsc_lan::analyzer::Outcome::AlreadyClosed => {}
    }

    Ok(AnalyzerResult { outcome })
}

/// Whether an action would change anything, given the window state. Split out
/// so the decision is testable without a Tauri app handle, which cannot be
/// constructed in a unit test.
pub fn would_change(action: Action, is_open: bool) -> bool {
    decide(action, is_open).changed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsc_lan::analyzer::Outcome;

    #[test]
    fn the_handler_decides_the_same_way_the_contract_does() {
        // The handler must not re-implement the decision; this pins that it
        // delegates, so the exhaustive tests in bsc-lan cover this path too.
        for (a, open, want) in [
            (Action::Open, false, Outcome::Opened),
            (Action::Open, true, Outcome::AlreadyOpen),
            (Action::Close, true, Outcome::Closed),
            (Action::Close, false, Outcome::AlreadyClosed),
            (Action::Toggle, false, Outcome::Opened),
            (Action::Toggle, true, Outcome::Closed),
        ] {
            assert_eq!(decide(a, open), want);
            assert_eq!(would_change(a, open), want.changed());
        }
    }

    #[test]
    fn the_window_is_loaded_as_a_detached_page() {
        // A plain index.html would mount a second full app shell — rail,
        // tabstrip and all — instead of the minimal-chrome analyser.
        assert!(WINDOW_URL.starts_with("index.html?"));
        assert!(WINDOW_URL.contains("detach=analyzer"));
    }

    #[test]
    fn the_label_is_stable_so_a_second_open_cannot_duplicate() {
        assert_eq!(WINDOW_LABEL, "bsc-lan-analyzer");
        assert!(!WINDOW_LABEL.is_empty());
    }
}
