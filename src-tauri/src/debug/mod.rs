//! `debug` (#3437, epic #3260) — answer `bsc debug` by INSPECTING the running app's live view.
//!
//! ## Why this crosses into the frontend
//! A shot ends at the compositor, so Rust answers it alone. An inspection reads the **DOM** — rects,
//! computed styles, hit-testing — which only the WebView can do. So this uses the same round-trip
//! `navigate` established (#3274):
//!
//! ```text
//! watcher → emit `bsc://debug` → the frontend inspects → invokes `debug_ack` → we reply
//! ```
//!
//! ## Read-only
//! The request is one of a CLOSED set of inspections ([`bsc_debug::DebugRequest`]) — there is no
//! "evaluate this string" arm, and adding one would turn the `designer` role's `bsc ui`-only surface
//! (#2471) into a general-purpose console. The frontend handler mirrors that: it dispatches on the tag
//! and never interprets caller-supplied code.
//!
//! ## A frontend that never answers must TIME OUT
//! Same reasoning as `navigate`: one wedged request must not stop every future one, and "the app is
//! running but its inspector threw" has to be distinguishable from "no app".

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// How long to wait for the frontend to inspect + ack. Shorter than the CLI's 8s so the caller gets the
/// real error ("the frontend did not answer") rather than a bare timeout that reads as "app not running".
///
/// Deliberately longer than `navigate`'s: a `frames` inspection round-trips into each preview iframe over
/// `postMessage` and waits briefly for engines that may never reply.
const ACK_TIMEOUT: Duration = Duration::from_millis(6_000);

/// What the frontend sends back once it has inspected. `result` is the [`bsc_debug::DebugResult`] as
/// JSON — kept opaque here so adding an inspection verb does not touch this file.
#[derive(Debug, Clone, Deserialize)]
pub struct DebugAck {
    pub id: String,
    /// Set when the frontend could not inspect (bad selector, no window, …).
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
}

/// In-flight inspections, keyed by request id. The watcher parks on the receiver; `debug_ack` (invoked
/// by the frontend) delivers into the sender.
#[derive(Default)]
pub struct DebugPending(Mutex<HashMap<String, Sender<DebugAck>>>);

/// Ask the frontend to inspect, and block until it acks.
pub fn inspect(
    app: &tauri::AppHandle,
    id: &str,
    req: &bsc_debug::DebugRequest,
) -> Result<bsc_debug::DebugResult, String> {
    let rx = register(app, id);

    // The payload carries the id so the frontend can correlate its ack — several inspections could be
    // in flight (a loop probing while a human debugs), and an ack for the wrong one would report a view
    // that was never asked about.
    let mut payload = serde_json::to_value(req).map_err(|e| e.to_string())?;
    payload
        .as_object_mut()
        .ok_or("debug request did not serialize to an object")?
        .insert("id".into(), serde_json::Value::String(id.to_string()));

    app.emit("bsc://debug", payload).map_err(|e| format!("cannot reach the frontend: {e}"))?;

    let ack = rx.recv_timeout(ACK_TIMEOUT).map_err(|_| {
        unregister(app, id); // don't leak the slot when nobody ever answers
        format!(
            "the frontend did not answer the inspection within {}ms — is a window open, or was it \
             mid-reload? (the app IS running; this is not a 'no app' timeout)",
            ACK_TIMEOUT.as_millis()
        )
    })?;
    unregister(app, id);

    if let Some(e) = ack.error {
        return Err(e);
    }
    let value = ack.result.ok_or("the frontend acked without a result")?;
    serde_json::from_value(value).map_err(|e| format!("the frontend's result did not parse: {e}"))
}

fn register(app: &tauri::AppHandle, id: &str) -> Receiver<DebugAck> {
    let (tx, rx) = channel();
    if let Some(state) = app.try_state::<DebugPending>() {
        if let Ok(mut map) = state.0.lock() {
            map.insert(id.to_string(), tx);
        }
    }
    rx
}

fn unregister(app: &tauri::AppHandle, id: &str) {
    if let Some(state) = app.try_state::<DebugPending>() {
        if let Ok(mut map) = state.0.lock() {
            map.remove(id);
        }
    }
}

/// The frontend's ack: "I inspected it, and here is what I found."
///
/// An ack for an id nobody is waiting on is DROPPED, not an error — the waiter may have already timed
/// out, and failing here would surface a confusing error in the app for a request that is already dead.
#[tauri::command]
pub(crate) fn debug_ack(ack: DebugAck, state: tauri::State<'_, DebugPending>) {
    let tx = state.0.lock().ok().and_then(|mut m| m.remove(&ack.id));
    match tx {
        Some(tx) => {
            let _ = tx.send(ack);
        }
        None => log::debug!("debug: ack for {} had no waiter (timed out?)", ack.id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ack_carries_the_result_verbatim_for_the_crate_to_parse() {
        // The handler stays agnostic of the inspection shapes: adding a verb must not touch this file.
        let ack: DebugAck = serde_json::from_str(
            r#"{"id":"a","result":{"probe":{"matched":[]}}}"#,
        )
        .unwrap();
        assert_eq!(ack.id, "a");
        assert!(ack.error.is_none());
        let parsed: bsc_debug::DebugResult = serde_json::from_value(ack.result.unwrap()).unwrap();
        assert_eq!(parsed, bsc_debug::DebugResult::Probe { matched: vec![] });
    }

    #[test]
    fn an_error_ack_wins_over_any_result() {
        let ack: DebugAck = serde_json::from_str(r#"{"id":"a","error":"bad selector: ((("}"#).unwrap();
        assert_eq!(ack.error.as_deref(), Some("bad selector: ((("));
        assert!(ack.result.is_none());
    }

    #[test]
    fn a_waiter_receives_its_own_ack_and_is_then_unregistered() {
        let pending = DebugPending::default();
        let (tx, rx) = channel();
        pending.0.lock().unwrap().insert("a".into(), tx);

        let taken = pending.0.lock().unwrap().remove("a").unwrap();
        taken
            .send(DebugAck { id: "a".into(), error: None, result: Some(serde_json::json!({"frames":{"frames":[]}})) })
            .unwrap();

        assert!(rx.recv().unwrap().result.is_some());
        assert!(pending.0.lock().unwrap().is_empty(), "the slot must not leak once delivered");
    }

    #[test]
    fn an_ack_for_an_unknown_id_is_dropped_not_an_error() {
        let pending = DebugPending::default();
        assert!(pending.0.lock().unwrap().remove("ghost").is_none());
    }
}
