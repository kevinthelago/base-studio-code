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

pub mod cli;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_round_trips_through_the_shared_envelope() {
        let dir = tempfile::tempdir().unwrap();
        let req = DebugRequest::Hit { x: 412.0, y: 300.5 };
        bsc_appchan::write_request(dir.path(), "a", KIND, 1, &req).unwrap();

        let env = bsc_appchan::pending(dir.path()).unwrap().pop().unwrap();
        assert_eq!(env.kind, KIND, "routes to the debug handler, not shot/navigate");
        assert_eq!(serde_json::from_value::<DebugRequest>(env.payload).unwrap(), req);
    }

    #[test]
    fn the_op_tag_is_on_the_wire_so_the_frontend_dispatches_without_guessing() {
        // A tagged enum keeps "which inspection" explicit. An untagged shape would make `probe` with no
        // selector indistinguishable from `frames`, and the frontend would have to infer intent.
        let json = serde_json::to_string(&DebugRequest::Probe { selector: ".ds-frame".into(), all: true }).unwrap();
        assert_eq!(json, r#"{"op":"probe","selector":".ds-frame","all":true}"#);
        assert_eq!(serde_json::to_string(&DebugRequest::Frames).unwrap(), r#"{"op":"frames"}"#);
    }

    #[test]
    fn a_covered_element_names_its_coverer() {
        // The whole reason this verb exists: "the rect is right, so why is it dead?"
        let info = ElementInfo {
            label: "iframe#preview".into(),
            rect: [0.0, 0.0, 384.0, 441.0],
            styles: [("pointer-events".to_string(), "auto".to_string())].into_iter().collect(),
            topmost_at_centre: false,
            covered_by: Some("div.overlay-scrim".into()),
        };
        let round = serde_json::from_str::<ElementInfo>(&serde_json::to_string(&info).unwrap()).unwrap();
        assert_eq!(round, info);
        assert!(!round.topmost_at_centre && round.covered_by.is_some());
    }

    #[test]
    fn an_engine_that_never_answers_is_distinct_from_one_reporting_not_listening() {
        // Absent  ⇒ the script never ran (threw, or the srcdoc never loaded).
        // listening:false ⇒ it ran and knows it failed. Different bugs, so the shapes stay distinct.
        let silent = FrameInfo {
            component: "invoicespage".into(),
            element: ElementInfo {
                label: "iframe".into(),
                rect: [0.0; 4],
                styles: Default::default(),
                topmost_at_centre: true,
                covered_by: None,
            },
            engine_requested: true,
            engine_in_srcdoc: true,
            engine: None,
        };
        let json = serde_json::to_string(&silent).unwrap();
        assert!(!json.contains("\"engine\""), "a silent engine is OMITTED, not null: {json}");
        assert_eq!(serde_json::from_str::<FrameInfo>(&json).unwrap(), silent);
    }

    #[test]
    fn an_empty_probe_match_is_a_result_not_an_error() {
        let empty = DebugResult::Probe { matched: vec![] };
        let ok = bsc_appchan::Reply::ok("a", &empty, 1);
        assert_eq!(bsc_appchan::take_payload::<DebugResult>(ok).unwrap(), empty);
    }
}
