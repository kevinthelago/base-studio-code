//! `bsc widget` — a widget is a **node**.
//!
//! One node stands for one toggleable UI surface and the data stream it
//! subscribes to. The spectrum analyzer is the first; anything else that wants
//! its own window becomes another node rather than another verb.
//!
//! ## Why a noun instead of a verb per surface
//!
//! The analyzer originally shipped as `bsc lan analyzer`. A second surface
//! would have meant a second verb, a second appchan `KIND` and a second
//! handler — the shape this codebase has already removed twice, and which
//! `bsc-appchan`'s own documentation records deleting in a single day when a
//! second channel was nearly added. One noun, any number of nodes.
//!
//! ## Dispatch stays literal, and that is not an implementation detail
//!
//! A registry keyed by id invites a dynamic lookup, and this codebase refuses
//! that on purpose: `renderDetachedSection` is a switch over literal cases
//! precisely so there is no user-controlled dispatch. **A widget id arriving
//! from a command line is exactly user-controlled input** — a lookup would let
//! an attacker-influenced string choose what mounts.
//!
//! So the id is validated against a closed set here, and the frontend selects
//! among literal cases. The node carries the metadata a person or an LLM reads;
//! it never carries the code path.

pub mod cli;

use serde::{Deserialize, Serialize};

/// Routes to the widget handler and nothing else.
pub const KIND: &str = "widget";

/// What a widget subscribes to.
///
/// `None` is a real answer, not a missing one: a static panel legitimately has
/// no stream, and it must be distinguishable from a widget whose stream simply
/// is not arriving. That distinction has been needed at every level of this
/// system, and it is the same one every time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stream {
    /// Spectral FFT bins aggregated per channel, off the sensor's multicast.
    LanSpectrum,
    /// Nothing — a static surface. Deliberate, not absent.
    None,
}

impl Stream {
    pub fn describe(&self) -> &'static str {
        match self {
            Stream::LanSpectrum => "lan spectrum (aggregated FFT bins, per channel)",
            Stream::None => "no stream — a static surface",
        }
    }
}

/// One widget node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Widget {
    /// Stable id, and the only thing a caller names. Validated against
    /// [`WIDGETS`]; never used to index anything.
    pub id: &'static str,
    pub title: &'static str,
    pub stream: Stream,
    pub width: u32,
    pub height: u32,
}

/// Every widget node. A CLOSED set — the whole reason an id from the command
/// line is safe to act on.
pub const WIDGETS: &[Widget] = &[Widget {
    id: "spectrum",
    title: "Spectrum analyzer",
    stream: Stream::LanSpectrum,
    width: 1100,
    height: 780,
}];

/// Look up a node by id.
///
/// Returns the node, never an index or a path: nothing downstream can be
/// selected by the caller's string beyond choosing among this closed set.
pub fn find(id: &str) -> Option<&'static Widget> {
    WIDGETS.iter().find(|w| w.id == id)
}

/// The ids that exist, for an error message worth reading.
pub fn known_ids() -> Vec<&'static str> {
    WIDGETS.iter().map(|w| w.id).collect()
}

/// The window label for a node. Stable, so "is it already open?" is answered by
/// asking the window set rather than by remembering.
pub fn window_label(id: &str) -> String {
    format!("bsc-widget-{id}")
}

/// The URL a widget window loads. A detached page, so the app renders minimal
/// chrome instead of a second full shell.
pub fn window_url(id: &str) -> String {
    format!("index.html?detach=widget&section={id}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Open,
    Close,
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
pub struct WidgetRequest {
    pub action: Action,
    pub id: String,
}

/// What actually happened, not merely that something did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Opened,
    Closed,
    AlreadyOpen,
    AlreadyClosed,
}

impl Outcome {
    pub fn changed(&self) -> bool {
        match self {
            Outcome::Opened | Outcome::Closed => true,
            Outcome::AlreadyOpen | Outcome::AlreadyClosed => false,
        }
    }

    pub fn describe(&self, title: &str) -> String {
        match self {
            Outcome::Opened => format!("opened {title}"),
            Outcome::Closed => format!("closed {title}"),
            Outcome::AlreadyOpen => format!("{title} was already open — focused it"),
            Outcome::AlreadyClosed => format!("{title} was already closed — nothing to do"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WidgetResult {
    pub id: String,
    pub title: String,
    pub outcome: Outcome,
}

/// Resolve an action against whether the window is open. Pure, and the whole
/// decision the verb makes.
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
    fn every_node_is_well_formed_and_uniquely_identified() {
        assert!(!WIDGETS.is_empty(), "a registry with no nodes proves nothing");
        let mut ids: Vec<&str> = known_ids();
        ids.sort_unstable();
        let mut deduped = ids.clone();
        deduped.dedup();
        assert_eq!(ids, deduped, "two nodes share an id — the label would collide");
        for w in WIDGETS {
            assert!(!w.id.is_empty() && !w.title.is_empty(), "{:?}", w.id);
            assert!(w.width >= 320 && w.height >= 240, "{} opens unusably small", w.id);
        }
    }

    #[test]
    fn an_unknown_id_finds_nothing_rather_than_falling_back() {
        // The security property: a caller's string selects among a CLOSED set
        // or selects nothing. It never indexes and never defaults.
        for bad in ["", "Spectrum", "../etc/passwd", "spectrum ", "widget"] {
            assert!(find(bad).is_none(), "{bad:?} must not resolve");
        }
        assert!(find("spectrum").is_some());
    }

    #[test]
    fn the_label_and_url_are_derived_from_the_id_and_are_distinct_per_node() {
        assert_eq!(window_label("spectrum"), "bsc-widget-spectrum");
        assert!(window_url("spectrum").contains("detach=widget"));
        assert!(window_url("spectrum").contains("section=spectrum"));
        // Two nodes must not share a window.
        assert_ne!(window_label("a"), window_label("b"));
    }

    #[test]
    fn a_widget_with_no_stream_is_distinguishable_from_one_that_declares_one() {
        // Not the same as a stream that is not arriving — that is a runtime
        // condition the subscriber reports, and conflating them would let a
        // broken feed read as a surface that never had one.
        assert_eq!(Stream::None.describe(), "no stream — a static surface");
        assert!(Stream::LanSpectrum.describe().contains("spectrum"));
        assert_ne!(Stream::None, Stream::LanSpectrum);
    }

    #[test]
    fn the_spectrum_node_declares_the_stream_that_feeds_it() {
        let w = find("spectrum").expect("the first widget");
        assert_eq!(w.stream, Stream::LanSpectrum, "the node answers what feeds it");
        assert_eq!(w.title, "Spectrum analyzer");
    }

    #[test]
    fn every_action_and_state_resolves_to_a_distinct_outcome() {
        assert_eq!(decide(Action::Open, false), Outcome::Opened);
        assert_eq!(decide(Action::Open, true), Outcome::AlreadyOpen);
        assert_eq!(decide(Action::Close, true), Outcome::Closed);
        assert_eq!(decide(Action::Close, false), Outcome::AlreadyClosed);
        assert_eq!(decide(Action::Toggle, false), Outcome::Opened);
        assert_eq!(decide(Action::Toggle, true), Outcome::Closed);
    }

    #[test]
    fn a_no_op_is_distinguishable_from_a_change() {
        assert!(decide(Action::Open, false).changed());
        assert!(!decide(Action::Open, true).changed());
        assert!(!decide(Action::Close, false).changed());
    }

    #[test]
    fn an_outcome_names_the_widget_it_is_about() {
        // With many widgets, "opened" alone is not an answer.
        for o in [Outcome::Opened, Outcome::Closed, Outcome::AlreadyOpen, Outcome::AlreadyClosed] {
            assert!(o.describe("Spectrum analyzer").contains("Spectrum analyzer"), "{o:?}");
        }
    }

    #[test]
    fn actions_parse_from_the_command_line_and_nothing_else_does() {
        assert_eq!(Action::parse("toggle"), Some(Action::Toggle));
        for bad in ["Open", "OPEN", "", "show", "opne"] {
            assert_eq!(Action::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_request_round_trips_as_the_appchan_payload() {
        let r = WidgetRequest { action: Action::Open, id: "spectrum".into() };
        let v = serde_json::to_value(r.clone()).unwrap();
        assert_eq!(v, serde_json::json!({ "action": "open", "id": "spectrum" }));
        assert_eq!(serde_json::from_value::<WidgetRequest>(v).unwrap(), r);
    }
}
