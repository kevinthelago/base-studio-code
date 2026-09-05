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

pub mod subscribe;

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

#[cfg(test)]
mod capability_tests {
    //! A window label is not merely a name — it decides whether that window can
    //! do ANYTHING. Tauri grants permissions per capability, and each capability
    //! names the window labels it covers; a window matching none is granted
    //! nothing, so its `listen()` is denied and no event can reach it.
    //!
    //! MEASURED: the spectrum widget rendered nothing while the backend logged
    //! `1000 spectrum record(s) delivered … 0 rejected`, because
    //! `capabilities/default.json` covered `main` and `tab-*` and the widget
    //! slice minted a third prefix. It fails silently in BOTH directions —
    //! `app.emit` returns Ok having emitted to every permitted webview, and
    //! `listen()` resolves to a handle that never fires — so a working sender
    //! and a working receiver produce a dead channel with nothing to report.

    /// The capability document, read from disk so a moved or renamed file fails
    /// loudly rather than leaving the guard scanning nothing.
    fn capability_windows() -> Vec<String> {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities/default.json");
        let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("cannot read {}: {e}", p.display()));
        let doc: serde_json::Value =
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", p.display()));
        let windows: Vec<String> = doc["windows"]
            .as_array()
            .unwrap_or_else(|| panic!("{} has no `windows` array", p.display()))
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        assert!(!windows.is_empty(), "the capability covers no windows at all");
        windows
    }

    /// Tauri's glob: a trailing `*` matches any suffix, otherwise it is exact.
    fn covers(pattern: &str, label: &str) -> bool {
        match pattern.strip_suffix('*') {
            Some(prefix) => label.starts_with(prefix),
            None => pattern == label,
        }
    }

    #[test]
    fn every_widget_window_this_app_can_create_is_covered_by_a_capability() {
        // Derived from the code that MINTS the labels, never restated here: a
        // second list is a list that drifts, and the drift is invisible until
        // somebody opens the window and sees nothing.
        let windows = capability_windows();
        assert!(
            !bsc_widget::WIDGETS.is_empty(),
            "no widgets to check — this guard would pass over an empty set"
        );
        for w in bsc_widget::WIDGETS {
            let label = bsc_widget::window_label(w.id);
            assert!(
                windows.iter().any(|p| covers(p, &label)),
                "the widget window {label:?} matches no capability window pattern {windows:?} — \
                 it would be granted NOTHING, its listen() denied, and no event could reach it"
            );
        }
    }

    #[test]
    fn the_matcher_is_the_glob_tauri_actually_uses() {
        // Asserted directly, because the whole guard rests on it: a matcher
        // that was too GENEROUS would pass a label Tauri then refuses, which is
        // the failure this test exists to catch, arriving by another door.
        assert!(covers("main", "main"));
        assert!(!covers("main", "main-2"));
        assert!(covers("tab-*", "tab-7"));
        assert!(!covers("tab-*", "bsc-widget-spectrum"));
        assert!(covers("bsc-widget-*", "bsc-widget-spectrum"));
        assert!(!covers("bsc-widget-*", "widget-spectrum"));
    }

    #[test]
    fn the_detached_tab_prefix_is_still_covered() {
        // The prefix that already worked, pinned: widening the list must not
        // come at the cost of the windows that were fine.
        let windows = capability_windows();
        for label in ["main", "tab-1"] {
            assert!(
                windows.iter().any(|p| covers(p, label)),
                "{label} lost its capability coverage"
            );
        }
    }
}
