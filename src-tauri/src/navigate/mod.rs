//! `navigate` (#3274, epic #3260) — steer the RUNNING app to a view, so a capture can target something
//! instead of photographing whatever happens to be on screen.
//!
//! ## Why this one crosses into the frontend
//! A shot ends at the compositor, so Rust answers it alone. Navigation changes **frontend** state (the
//! Zustand store), which Rust cannot touch. So:
//!
//! ```text
//! watcher → emit `bsc://navigate` → the frontend applies it → invokes `navigate_ack` → we reply
//! ```
//!
//! The ack is the whole point. Without it `bsc navigate … && bsc shot take` would race: the capture
//! could fire against the previous view while every log line looked correct — the exact failure shape
//! this epic keeps hitting. So the handler BLOCKS on the frontend's ack and reports the view that
//! actually landed.
//!
//! A frontend that never acks (no window, mid-reload, a listener that threw) must TIME OUT with a stated
//! error rather than hang the watcher — one wedged request would stop every future one.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// How long to wait for the frontend to apply + ack. Shorter than the CLI's 8s so the caller gets our
/// real error ("the frontend did not ack") rather than a bare timeout that reads as "app not running".
const ACK_TIMEOUT: Duration = Duration::from_millis(5_000);

/// What the frontend sends back once it has applied the navigation — the view that ACTUALLY landed.
/// Deserialized straight into the CLI's result shape so there is one contract, not two.
#[derive(Debug, Clone, Deserialize)]
pub struct NavAck {
    pub id: String,
    /// Set when the frontend could not do it (unknown component, unknown workspace, …).
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub kit: Option<String>,
    #[serde(default)]
    pub component: Option<String>,
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
}

/// In-flight navigations, keyed by request id. The watcher parks on the receiver; `navigate_ack`
/// (invoked by the frontend) delivers into the sender.
#[derive(Default)]
pub struct NavPending(Mutex<HashMap<String, Sender<NavAck>>>);

/// Ask the frontend to navigate, and block until it acks.
pub fn apply(
    app: &tauri::AppHandle,
    id: &str,
    req: &bsc_navigate::NavRequest,
) -> Result<bsc_navigate::NavResult, String> {
    let rx = register(app, id);

    // The payload carries the id so the frontend can correlate its ack — several navigations could be
    // in flight (a loop firing while a human clicks), and an ack for the wrong one would report a view
    // that was never asked for.
    let mut payload = serde_json::to_value(req).map_err(|e| e.to_string())?;
    payload
        .as_object_mut()
        .ok_or("navigate request did not serialize to an object")?
        .insert("id".into(), serde_json::Value::String(id.to_string()));

    app.emit("bsc://navigate", payload).map_err(|e| format!("cannot reach the frontend: {e}"))?;

    let ack = rx.recv_timeout(ACK_TIMEOUT).map_err(|_| {
        unregister(app, id); // don't leak the slot when nobody ever answers
        format!(
            "the frontend did not apply the navigation within {}ms — is a window open, or was it \
             mid-reload? (the app IS running; this is not a 'no app' timeout)",
            ACK_TIMEOUT.as_millis()
        )
    })?;
    unregister(app, id);

    if let Some(e) = ack.error {
        return Err(e);
    }
    Ok(bsc_navigate::NavResult {
        // The frontend always reports its workspace; if it somehow didn't, say so rather than inventing
        // a plausible default — a wrong answer here silently mis-aims every capture that follows.
        workspace: ack.workspace.ok_or("the frontend acked without naming the workspace it landed on")?,
        page: ack.page,
        kit: ack.kit,
        component: ack.component,
        theme: ack.theme,
        state: ack.state,
    })
}

fn register(app: &tauri::AppHandle, id: &str) -> Receiver<NavAck> {
    let (tx, rx) = channel();
    if let Some(state) = app.try_state::<NavPending>() {
        if let Ok(mut map) = state.0.lock() {
            map.insert(id.to_string(), tx);
        }
    }
    rx
}

fn unregister(app: &tauri::AppHandle, id: &str) {
    if let Some(state) = app.try_state::<NavPending>() {
        if let Ok(mut map) = state.0.lock() {
            map.remove(id);
        }
    }
}

/// The frontend's ack: "I applied it, and here is what landed."
///
/// An ack for an id nobody is waiting on is DROPPED, not an error — the waiter may have already timed
/// out, and failing here would surface a confusing error in the app for a request that is already dead.
#[tauri::command]
pub(crate) fn navigate_ack(ack: NavAck, state: tauri::State<'_, NavPending>) {
    let tx = state.0.lock().ok().and_then(|mut m| m.remove(&ack.id));
    match tx {
        Some(tx) => {
            let _ = tx.send(ack);
        }
        None => log::debug!("navigate: ack for {} had no waiter (timed out?)", ack.id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ack_deserializes_from_the_frontends_shape() {
        let ack: NavAck = serde_json::from_str(
            r#"{"id":"a","workspace":"projects","page":"designs","kit":"react-d3","component":"Heatmap"}"#,
        )
        .unwrap();
        assert_eq!(ack.id, "a");
        assert_eq!(ack.workspace.as_deref(), Some("projects"));
        assert_eq!(ack.component.as_deref(), Some("Heatmap"));
        assert!(ack.error.is_none());
        assert!(ack.theme.is_none(), "an absent field is absent, not an error");
    }

    #[test]
    fn an_error_ack_deserializes_and_carries_no_view() {
        let ack: NavAck = serde_json::from_str(r#"{"id":"a","error":"no such component: Nope"}"#).unwrap();
        assert_eq!(ack.error.as_deref(), Some("no such component: Nope"));
        assert!(ack.workspace.is_none());
    }

    #[test]
    fn a_waiter_receives_its_own_ack_and_is_then_unregistered() {
        let pending = NavPending::default();
        let (tx, rx) = channel();
        pending.0.lock().unwrap().insert("a".into(), tx);

        // Simulate navigate_ack's core: take the waiter out and deliver.
        let taken = pending.0.lock().unwrap().remove("a").unwrap();
        taken.send(NavAck {
            id: "a".into(),
            error: None,
            workspace: Some("projects".into()),
            page: None,
            kit: None,
            component: None,
            theme: None,
            state: None,
        })
        .unwrap();

        assert_eq!(rx.recv().unwrap().workspace.as_deref(), Some("projects"));
        assert!(pending.0.lock().unwrap().is_empty(), "the slot must not leak once delivered");
    }

    #[test]
    fn an_ack_for_an_unknown_id_is_dropped_not_an_error() {
        // The waiter may have already timed out; erroring here would surface a confusing failure in the
        // app for a request that is already dead.
        let pending = NavPending::default();
        assert!(pending.0.lock().unwrap().remove("ghost").is_none());
    }
}
