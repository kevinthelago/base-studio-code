//! Widget windows — opening and closing a widget node's surface.
//!
//! ## Why this builds the window in Rust when nothing else does
//!
//! Every other detached window is opened from the frontend, and `bsc navigate`
//! emits an event the frontend applies and acks. This does not, deliberately.
//!
//! A widget is a separate window partly so it survives the main surface being
//! wedged. Routing the request to open it *through* that surface would make the
//! escape hatch depend on the thing it is escaping — the one circumstance where
//! a person most wants it to work is exactly the one where it would not.
//!
//! ## "Is it already open?" is asked, never remembered
//!
//! The answer comes from `get_webview_window(label)` each time. A remembered
//! flag drifts from reality the first time a user closes a window with its own
//! title-bar button, and then `open` reports `AlreadyOpen` about a window that
//! is not there.

use bsc_widget::{decide, Outcome, WidgetRequest, WidgetResult};
use tauri::Manager;

/// Apply one widget request against the live window set.
pub fn apply(app: &tauri::AppHandle, req: &WidgetRequest) -> Result<WidgetResult, String> {
    // The id came from a command line. Resolving it against the closed set is
    // what makes it safe to act on — it selects a NODE, never a path.
    let node = bsc_widget::find(&req.id).ok_or_else(|| {
        format!(
            "no widget {:?} — the widgets are: {}",
            req.id,
            bsc_widget::known_ids().join(", ")
        )
    })?;

    let label = bsc_widget::window_label(node.id);
    let existing = app.get_webview_window(&label);
    let outcome = decide(req.action, existing.is_some());

    match outcome {
        Outcome::Opened => {
            let url = tauri::WebviewUrl::App(bsc_widget::window_url(node.id).into());
            tauri::WebviewWindowBuilder::new(app, &label, url)
                .title(node.title)
                .inner_size(f64::from(node.width), f64::from(node.height))
                .min_inner_size(640.0, 480.0)
                .resizable(true)
                .build()
                .map_err(|e| format!("could not open {}: {e}", node.title))?;
        }
        Outcome::Closed => {
            if let Some(w) = existing {
                w.close().map_err(|e| format!("could not close {}: {e}", node.title))?;
            }
        }
        Outcome::AlreadyOpen => {
            // Focus rather than build a second window on the same label.
            if let Some(w) = existing {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        Outcome::AlreadyClosed => {}
    }

    Ok(WidgetResult { id: node.id.to_string(), title: node.title.to_string(), outcome })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsc_widget::Action;

    #[test]
    fn the_handler_delegates_the_decision_rather_than_reimplementing_it() {
        for (a, open, want) in [
            (Action::Open, false, Outcome::Opened),
            (Action::Open, true, Outcome::AlreadyOpen),
            (Action::Close, true, Outcome::Closed),
            (Action::Close, false, Outcome::AlreadyClosed),
            (Action::Toggle, false, Outcome::Opened),
            (Action::Toggle, true, Outcome::Closed),
        ] {
            assert_eq!(decide(a, open), want);
        }
    }

    #[test]
    fn an_unknown_id_resolves_to_nothing_before_any_window_is_touched() {
        // The security property, asserted at the handler as well as the CLI:
        // an id that is not a node selects nothing at all.
        assert!(bsc_widget::find("../etc/passwd").is_none());
        assert!(bsc_widget::find("").is_none());
        assert!(bsc_widget::find("spectrum").is_some());
    }

    #[test]
    fn each_node_gets_its_own_window_label_and_detached_url() {
        for w in bsc_widget::WIDGETS {
            let label = bsc_widget::window_label(w.id);
            assert!(label.contains(w.id));
            let url = bsc_widget::window_url(w.id);
            assert!(url.contains("detach=widget"), "{url}");
            assert!(url.contains(w.id), "{url}");
        }
    }
}
