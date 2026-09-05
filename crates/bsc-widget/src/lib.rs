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

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/tests.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-widget--<module>.rs
//     bsc graph impl set --id bsc-widget--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-widget--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-widget--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));