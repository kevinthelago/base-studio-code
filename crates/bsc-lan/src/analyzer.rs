//! `bsc lan analyzer` — the request that opens or closes the analyser window.
//!
//! Rides [`bsc_appchan`], the ONE channel for asking the running app to do
//! something. Its own documentation records why there is only one: a second
//! directory and a second watcher was the duplication removed twice in a single
//! day. So this crate owns only its request and reply shapes, and the transport
//! stays where it is.
//!
//! ## Why the reply distinguishes three outcomes and not two
//!
//! `bsc-appchan` requires a reply *always*, because silence is
//! indistinguishable from "the app isn't running" and sends the caller to debug
//! the wrong thing. The same reasoning applies one level up: **opened**,
//! **closed** and **already in that state** are three things a person acts on
//! differently, and collapsing them into a bare success throws away the only
//! information the command had to give.

use serde::{Deserialize, Serialize};

/// Routes to the analyser handler and nothing else.
pub const KIND: &str = "lan-analyzer";

/// The window label. Stable, because "is it already open?" is answered by
/// asking the app for a window with this label rather than by tracking state
/// somewhere that can drift from reality.
pub const WINDOW_LABEL: &str = "bsc-lan-analyzer";

/// The URL the window loads. A detached page, so `App.tsx` early-returns the
/// minimal-chrome window instead of a second full app shell.
pub const WINDOW_URL: &str = "index.html?detach=analyzer&section=spectrum";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Open,
    Close,
    /// Open when closed, close when open — and say which happened.
    Toggle,
}

impl Action {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Action::Open),
            "close" => Some(Action::Close),
            "toggle" => Some(Action::Toggle),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnalyzerRequest {
    pub action: Action,
}

/// What actually happened, not merely that something did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Opened,
    Closed,
    /// It was already open and an open was asked for: the existing window is
    /// focused rather than a second one created.
    AlreadyOpen,
    /// It was already closed and a close was asked for.
    AlreadyClosed,
}

impl Outcome {
    /// Whether this call changed anything. A caller scripting against the verb
    /// needs to know, and it is not derivable from success alone.
    pub fn changed(&self) -> bool {
        match self {
            Outcome::Opened | Outcome::Closed => true,
            Outcome::AlreadyOpen | Outcome::AlreadyClosed => false,
        }
    }

    pub fn describe(&self) -> &'static str {
        match self {
            Outcome::Opened => "opened the analyzer window",
            Outcome::Closed => "closed the analyzer window",
            Outcome::AlreadyOpen => "the analyzer window was already open — focused it",
            Outcome::AlreadyClosed => "the analyzer window was already closed — nothing to do",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnalyzerResult {
    pub outcome: Outcome,
}

/// Resolve `action` against whether the window is currently open.
///
/// Pure, and separated from every Tauri type on purpose: this is the whole
/// decision the verb makes, and it is the part worth testing exhaustively.
pub fn decide(action: Action, is_open: bool) -> Outcome {
    match (action, is_open) {
        (Action::Open, true) => Outcome::AlreadyOpen,
        (Action::Open, false) => Outcome::Opened,
        (Action::Close, true) => Outcome::Closed,
        (Action::Close, false) => Outcome::AlreadyClosed,
        (Action::Toggle, true) => Outcome::Closed,
        (Action::Toggle, false) => Outcome::Opened,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_action_and_state_resolves_to_a_distinct_outcome() {
        assert_eq!(decide(Action::Open, false), Outcome::Opened);
        assert_eq!(decide(Action::Open, true), Outcome::AlreadyOpen);
        assert_eq!(decide(Action::Close, true), Outcome::Closed);
        assert_eq!(decide(Action::Close, false), Outcome::AlreadyClosed);
    }

    #[test]
    fn toggle_says_which_way_it_went() {
        // The reason toggle exists is that a caller cannot know the state; the
        // reason it reports is that they need to know what it became.
        assert_eq!(decide(Action::Toggle, false), Outcome::Opened);
        assert_eq!(decide(Action::Toggle, true), Outcome::Closed);
    }

    #[test]
    fn a_no_op_is_distinguishable_from_a_change() {
        assert!(decide(Action::Open, false).changed());
        assert!(!decide(Action::Open, true).changed(), "opening an open window changed nothing");
        assert!(decide(Action::Close, true).changed());
        assert!(!decide(Action::Close, false).changed());
    }

    #[test]
    fn opening_an_open_window_focuses_rather_than_duplicating() {
        // Pinned as an outcome rather than left to the handler: a second window
        // on the same label is the bug this prevents.
        assert_eq!(decide(Action::Open, true), Outcome::AlreadyOpen);
        assert!(Outcome::AlreadyOpen.describe().contains("focused"));
    }

    #[test]
    fn every_outcome_describes_itself_for_a_person() {
        for o in [Outcome::Opened, Outcome::Closed, Outcome::AlreadyOpen, Outcome::AlreadyClosed] {
            assert!(!o.describe().is_empty());
            assert!(o.describe().contains("analyzer"), "{o:?}: {}", o.describe());
        }
    }

    #[test]
    fn actions_parse_from_the_command_line_and_nothing_else_does() {
        assert_eq!(Action::parse("open"), Some(Action::Open));
        assert_eq!(Action::parse("close"), Some(Action::Close));
        assert_eq!(Action::parse("toggle"), Some(Action::Toggle));
        for bad in ["Open", "OPEN", "opne", "", "show"] {
            assert_eq!(Action::parse(bad), None, "{bad:?} must not parse");
        }
    }

    #[test]
    fn the_request_round_trips_as_the_appchan_payload() {
        let r = AnalyzerRequest { action: Action::Toggle };
        let v = serde_json::to_value(r.clone()).unwrap();
        assert_eq!(v, serde_json::json!({ "action": "toggle" }));
        assert_eq!(serde_json::from_value::<AnalyzerRequest>(v).unwrap(), r);
    }

    #[test]
    fn the_window_url_is_a_detached_page_not_a_second_full_shell() {
        // App.tsx early-returns the minimal-chrome window on ?detach=; loading
        // the plain index would mount an entire second app.
        assert!(WINDOW_URL.contains("detach=analyzer"));
        assert!(WINDOW_URL.contains("section=spectrum"));
    }
}
