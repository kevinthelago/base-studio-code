//! `bsc-navigate` (#3274, epic #3260) — steer the RUNNING app to a view, so a capture can target
//! something instead of photographing whatever happens to be on screen.
//!
//! ## Why
//! #3261 gave `bsc` eyes; nothing gave it hands. Verifying that shot needed a human to click
//! `Components` → `Heatmap`, because the Design Studio's selection is local React state. For the
//! overnight loop (#3263) that is disqualifying: it needs "component X in theme Y", and without steering
//! it would iterate on stale or irrelevant frames while every log line looked perfectly reasonable —
//! the same shape as every failure in this epic's history.
//!
//! ## Why it is not pure Rust like `bsc shot`
//! A shot ends at the compositor, so the app answers it entirely in Rust. Navigation changes **frontend**
//! state (the Zustand store), which Rust cannot touch. So the app's watcher emits a Tauri event, the
//! frontend applies it and ACKs, and only then is the reply written. That ack is the point: it makes
//!
//! ```text
//! bsc navigate component react-d3 Heatmap && bsc shot take
//! ```
//!
//! race-free instead of hoping the view landed first.
//!
//! ## Contract
//! A [`NavRequest`] is a set of INTENTS, not a script. `component` implies its workspace + page — the
//! caller should not have to know the app's structure to point at a component. The app resolves the
//! whole navigation and answers with the **resulting** view ([`NavResult`]), so the caller learns what
//! actually landed rather than what it asked for. An empty request is a read: "what is showing?".

use serde::{Deserialize, Serialize};


/// This verb's routing key in the shared channel.
pub const KIND: &str = "navigate";

/// What to steer to. Every field optional; absent ⇒ leave it alone. All-absent ⇒ just report the view.
///
/// Intents, not steps: setting `component` also lands its workspace + page, because a caller asking for
/// a component should not need to know which Workspace hosts the Design Studio this week.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NavRequest {
    /// A HUMAN asked for this steer, so the presence gate does not apply (#4248). An agent's background
    /// loop must not set it: the gate exists because a background steer takes the screen from whoever is
    /// using the app, and `--force` is the one path that says a person wanted it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub force: bool,
    /// A rail destination (`registry.ts` `Workspace`): console · glance · projects · skills · automation
    /// · mcp · github · security · settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// A page within the workspace (the PageTabs strip) — e.g. projects · teams · designs · algorithms
    /// · sounds under the Planner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    /// A UI-kit id (e.g. `react-ui`). Paired with `component`; also selectable alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kit: Option<String>,
    /// A component to focus in the Design Studio. Implies the Designs page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
    /// A kit theme id (e.g. `nord`) — pair with `component` for a themed capture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    /// A preview DATA-STATE to render (`loaded` · `empty` · `loading`) — pair with `component` to capture
    /// a specific render (e.g. the skeleton vs the loaded body), instead of whatever state was pinned. It
    /// drives the Design Studio's state control, the same axis a human toggles there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// #54 — an app NOTICE to clear (a banner id, or `all`). Every banner hides through its own local
    /// React state, so a session driving the app from a shell could see one in a capture with no way to
    /// reach the affordance a human has. `all` clears every notice that does not ASK something; a
    /// decision-bearing one (session recovery's "restore or discard?") is refused BY NAME, because
    /// hiding a question does not answer it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dismiss: Option<String>,
}

impl NavRequest {
    /// True when nothing is being changed — a pure read of the current view.
    pub fn is_read_only(&self) -> bool {
        self.workspace.is_none()
            && self.page.is_none()
            && self.kit.is_none()
            && self.component.is_none()
            && self.theme.is_none()
            && self.state.is_none()
            // A dismiss MUTATES the app — `show` must stay the only read-only request, or the presence
            // gate and every "is this a write" caller would treat clearing a banner as a pure look.
            && self.dismiss.is_none()
    }
}

/// The view that ACTUALLY landed, as the app reports it. Not an echo of the request: if the app resolved
/// `component` into a different page, or clamped something, this says so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NavResult {
    pub workspace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// The navigation deliberately left the VIEW alone (#3599/#4248) and this says why. Not an error —
    /// the focus landed. Carried all the way to the caller so a decline cannot read as a success with an
    /// unexpected view, which is what made the designer loop force the view every few seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declined: Option<String>,
    /// What the preview frame actually SHOWS, observed after it settled — not what was selected. When
    /// this differs from `component`, a capture taken now would photograph the wrong thing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mounted: Option<String>,
    /// Why the selected component is not on screen (refused build, bundle error, or did not settle).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mount_error: Option<String>,
    /// #54 — the app NOTICES this request cleared. Reported so `dismiss all` is auditable rather than a
    /// silent sweep, and so a caller can tell "nothing was showing" from "it worked".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dismissed: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_request_is_a_read_not_a_no_op_write() {
        assert!(NavRequest::default().is_read_only());
        assert!(!NavRequest { component: Some("Heatmap".into()), ..Default::default() }.is_read_only());
        assert!(!NavRequest { theme: Some("nord".into()), ..Default::default() }.is_read_only());
        assert!(!NavRequest { state: Some("loading".into()), ..Default::default() }.is_read_only());
    }

    #[test]
    fn the_request_round_trips_through_the_shared_envelope() {
        let dir = tempfile::tempdir().unwrap();
        let req = NavRequest {
            kit: Some("react-d3".into()),
            component: Some("Heatmap".into()),
            ..Default::default()
        };
        bsc_appchan::write_request(dir.path(), "a", KIND, 1, &req).unwrap();

        let env = bsc_appchan::pending(dir.path()).unwrap().pop().unwrap();
        assert_eq!(env.kind, KIND, "routes to the navigate handler, not the shot one");
        assert_eq!(serde_json::from_value::<NavRequest>(env.payload).unwrap(), req);
    }

    #[test]
    fn absent_fields_are_omitted_so_the_app_can_tell_leave_alone_from_clear() {
        // `{"component": null}` and `{}` must not be the same wire value — the first would read as
        // "clear the selection", the second as "don't touch it".
        let json = serde_json::to_string(&NavRequest { theme: Some("nord".into()), ..Default::default() }).unwrap();
        assert_eq!(json, r#"{"theme":"nord"}"#);
    }

    #[test]
    fn the_result_reports_what_landed_and_an_error_wins_over_it() {
        let landed = NavResult {
            workspace: "projects".into(),
            page: Some("designs".into()),
            kit: Some("react-d3".into()),
            component: Some("Heatmap".into()),
            theme: Some("default".into()),
            state: Some("loading".into()),
            declined: None,
            mounted: Some("Heatmap".into()),
            mount_error: None,
            dismissed: None,
        };
        let ok = bsc_appchan::Reply::ok("a", &landed, 1);
        assert_eq!(bsc_appchan::take_payload::<NavResult>(ok).unwrap(), landed);

        let bad = bsc_appchan::Reply::err("a", "no such component: Nope", 1);
        assert_eq!(bsc_appchan::take_payload::<NavResult>(bad).unwrap_err(), "no such component: Nope");
    }
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs does not exist — it is a record in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-navigate--<module>.rs
//     bsc graph impl set --id bsc-navigate--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-navigate--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-navigate--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));