//! `debug` (#3437, epic #3260) — INSPECT the running app's live view from a session.
//!
//! The third leg of the app channel: `bsc shot` reads the app's **pixels**, `bsc navigate` **steers**
//! it, and this **interrogates** it. Until now a structural UI defect — an element covering another, a
//! collapsed rect, an engine that never attached — could only be chased by reading source and guessing,
//! because nothing could answer "what is actually under that pixel?" for the live WebView.
//!
//! ## Read-only, by construction
//! There is no `eval` verb and there will not be one. The whole point of the `designer` role (#2471) is
//! that its entire writable surface is `bsc ui`; an arbitrary-JS verb on the same binary would be a back
//! door around that gate. So this exposes a CURATED report — rects, the computed styles that decide
//! event delivery, and hit-testing — which is enough to diagnose the class of bug it exists for without
//! becoming a console.
//!
//! ## Seeing INTO the preview iframe
//! The preview runs at an OPAQUE origin (`sandbox="allow-scripts"`, no `allow-same-origin`), so the host
//! document cannot read it — `document.querySelector` stops at the iframe element. That boundary is a
//! deliberate trust boundary and this does not weaken it. Instead {@link DebugRequest::frames} asks each
//! preview to describe ITSELF over the `postMessage` channel the pan/zoom engine already listens on
//! (`{__probe:1}` → the engine replies with its own state). The sandbox stays intact; the preview
//! volunteers the answer.
//!
//! Wire contract only — the CLI is [`cli`], and the app-side handler lives in the desktop crate.

use serde::{Deserialize, Serialize};


/// This verb's routing key in the shared channel ([`bsc_appchan`]). Must not collide with `shot` /
/// `navigate`; a test in the desktop crate's dispatcher pins that.
pub const KIND: &str = "debug";

/// What to inspect. Exactly one of these is set per request — the CLI's verbs map 1:1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum DebugRequest {
    /// The element at a viewport point, plus its ancestor chain — "is something covering this?".
    Hit { x: f64, y: f64 },
    /// Every element matching a CSS selector (or just the first, unless `all`).
    Probe {
        selector: String,
        #[serde(default)]
        all: bool,
    },
    /// Every mounted component-preview iframe: its host-side geometry AND the in-iframe engine's own
    /// report, gathered over the preview's existing `postMessage` channel.
    Frames,
}

/// One element's report — the fields that decide whether a click reaches it.
///
/// `covered_by` is the load-bearing one: an element can have a perfect rect and still be unclickable
/// because something transparent sits on top. Everything else here is context for reading that.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ElementInfo {
    /// `tag#id.class1.class2` — enough to recognize it in the source.
    pub label: String,
    /// Viewport rect, CSS px: `[x, y, w, h]`.
    pub rect: [f64; 4],
    /// The computed styles that decide event delivery + visibility.
    pub styles: std::collections::BTreeMap<String, String>,
    /// `true` when `elementFromPoint` at this element's own centre returns this element (or a
    /// descendant) — i.e. a click aimed at its middle would actually land on it.
    pub topmost_at_centre: bool,
    /// When NOT topmost: the label of whatever is on top instead. The answer to "what ate my click".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub covered_by: Option<String>,
}

/// One mounted preview iframe: what the HOST set up, and what the preview itself reports back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FrameInfo {
    /// The previewed component's id, as the host knows it.
    pub component: String,
    /// The iframe element's own report (rect, styles, hit-testing).
    pub element: ElementInfo,
    /// Was the pan/zoom engine requested for this frame (the `zoomEngine` prop)?
    pub engine_requested: bool,
    /// Did the built srcdoc actually CONTAIN the engine? (`engine_requested && !engine_in_srcdoc` is a
    /// builder bug; the pair is why this reports both rather than one "engine on" flag.)
    pub engine_in_srcdoc: bool,
    /// The engine's OWN reply to `{__probe:1}` — `None` when it never answered, which is the signal
    /// that the script is present but not running (it threw, or the iframe never loaded the srcdoc).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<EngineProbe>,
}

/// What the in-iframe pan/zoom engine says about itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EngineProbe {
    /// Did the engine finish installing its listeners? `false`/absent ⇒ it threw during setup.
    pub listening: bool,
    /// The live `#root` transform the engine has applied — the ground truth for "did my drag pan".
    pub transform: String,
    /// The engine's current scale + pan, as it believes them.
    pub scale: f64,
    pub pan: [f64; 2],
}

/// The answer to one inspection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DebugResult {
    /// `hit`: the topmost element first, then each ancestor outward to `<html>`.
    Hit { chain: Vec<ElementInfo> },
    /// `probe`: one entry per matched element (empty when the selector matched nothing — an empty
    /// match is a RESULT, not an error: "that selector matches nothing" is the answer).
    Probe { matched: Vec<ElementInfo> },
    /// `frames`: one entry per mounted preview.
    Frames { frames: Vec<FrameInfo> },
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/tests.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-debug--<module>.rs
//     bsc graph impl set --id bsc-debug--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-debug--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-debug--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));