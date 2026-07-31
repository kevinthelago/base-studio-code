//! `bsc fleet` (#4098) — which fleet panes are ACTUALLY alive.
//!
//! ## Why
//! The `bsc-fleet` shell helper reads `fleet.roster.tsv` — a LAUNCH MANIFEST — and joins `coord.log`.
//! It never checked a process, so a pane printed `idle` whether its session had exited an hour ago or
//! started ten seconds ago and not yet logged. Agents read that as "these sessions are running": on
//! `studio-code` it listed 14 launched panes while 5 `claude.exe` existed system-wide.
//!
//! Part 1 stopped the helper CLAIMING liveness. This supplies it.
//!
//! ## Why it goes through the app
//! Liveness is the app's fact, not the filesystem's: the PTY sessions live in `PtyState`, and "is
//! something running in this pane" is a descendant-process walk the app already does (`console/pty/
//! busy.rs`). No file on disk knows it. So this rides the same `bsc-appchan` request channel `bsc shot`
//! and `bsc navigate` use rather than inventing a second mechanism — or, worse, re-deriving liveness by
//! scanning the process table and guessing which process belongs to which pane.
//!
//! ## Contract
//! An empty `pane_ids` means "every pane the app is tracking". Naming panes narrows it — the caller
//! usually has a roster and wants those rows resolved. The reply reports each pane's `live` (a PTY
//! session exists) and `busy` (it has a live descendant), which are DIFFERENT questions: a session can
//! exist with nothing running in it, and that distinction is the whole point of the original report.

use serde::{Deserialize, Serialize};

pub mod cli;

/// This verb's routing key in the shared channel.
pub const KIND: &str = "fleet";

/// Which panes to report on. Empty ⇒ every pane the app tracks.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FleetRequest {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pane_ids: Vec<String>,
}

/// One pane's real runtime state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneLive {
    pub pane_id: String,
    /// A PTY session exists for this pane — `pty_create` would RECONNECT rather than launch.
    pub live: bool,
    /// Its shell has at least one live descendant, i.e. something is actually running in it. Distinct
    /// from `live`: an idle-but-open session is `live: true, busy: false`.
    pub busy: bool,
    /// The session's OS process id, when the app has one. Answers the original report's "diagnosing
    /// this required dropping out to tasklist" without a second tool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

/// The app's answer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FleetResult {
    pub panes: Vec<PaneLive>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The app deserializes `FleetRequest` from the envelope payload and the CLI deserializes
    /// `FleetResult` back, so both directions must survive a JSON round trip verbatim — a rename on one
    /// side would otherwise show up as "every pane is gone", which is exactly the wrong answer for a
    /// command whose whole job is reporting liveness.
    #[test]
    fn the_wire_contract_round_trips() {
        let req = FleetRequest { pane_ids: vec!["k:director".into(), "k:worker".into()] };
        let back: FleetRequest = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert_eq!(back, req);

        let res = FleetResult {
            panes: vec![
                PaneLive { pane_id: "k:director".into(), live: true, busy: true, pid: Some(4242) },
                PaneLive { pane_id: "k:worker".into(), live: false, busy: false, pid: None },
            ],
        };
        let json = serde_json::to_string(&res).unwrap();
        // camelCase on the wire — the field is `paneId`, matching every other appchan result.
        assert!(json.contains("\"paneId\""), "{json}");
        assert_eq!(serde_json::from_str::<FleetResult>(&json).unwrap(), res);
    }

    /// An empty request must serialize to an EMPTY object, not `{"pane_ids":[]}` — the app reads absent
    /// as "report everything", and a `[]` that survived would silently mean "report nothing".
    #[test]
    fn an_empty_request_asks_for_everything() {
        let json = serde_json::to_string(&FleetRequest::default()).unwrap();
        assert_eq!(json, "{}", "an empty ask must not serialize a pane list");
        assert!(serde_json::from_str::<FleetRequest>("{}").unwrap().pane_ids.is_empty());
    }
}
