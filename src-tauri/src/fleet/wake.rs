//! `bsc fleet wake` (#4101) — the director's one lever over a parked worker.
//!
//! ```text
//! bsc fleet wake → request file → watcher → emit `bsc://fleet-wake` → the frontend wakes it
//!                → invokes `fleet_wake_ack` → we reply
//! ```
//!
//! ## Why it is not answered in Rust like `bsc fleet list`
//! Liveness lives in `PtyState`, so listing is pure Rust. WAKING is frontend state: `wakePane` clears
//! the dormant/ended marks, bakes the startup prompt, and bumps the owning tab's `runId`. Rust cannot
//! touch the zustand store, so the frontend has to do it and say whether it worked.
//!
//! ## Why the ack is load-bearing rather than ceremony
//! The wake path KILLS the PTY before relaunching. A fire-and-forget wake that failed would leave the
//! worker dead and the caller believing it was running — which is precisely #4025, where `wakePane`
//! resolved the owning tab by the retired positional pane id (`t0p1`), returned `false` for all 273
//! real identity-keyed sessions, and so the Wake button killed every parked worker and never brought
//! one back. It was silent because the skipped `woke` event meant the log did not record it either.
//!
//! So `woke: false` is reported as an ERROR here, not a quiet success.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Shorter than the CLI's timeout so the caller gets our real error ("the frontend did not ack")
/// rather than a bare timeout that reads as "the app is not running".
const ACK_TIMEOUT: Duration = Duration::from_millis(5_000);

/// What the frontend sends back once it has tried the wake.
#[derive(Debug, Clone, Deserialize)]
pub struct WakeAck {
    pub id: String,
    /// Set when the frontend could not apply the wake at all (it threw). The BUSY refusal is decided
    /// here in Rust, not there.
    #[serde(default)]
    pub error: Option<String>,
    /// `wakePane`'s own verdict.
    #[serde(default)]
    pub woke: bool,
}

/// In-flight wakes, keyed by request id.
#[derive(Default)]
pub struct WakePending(Mutex<HashMap<String, Sender<WakeAck>>>);

/// Ask the frontend to wake a pane, and block until it acks.
pub fn apply(
    app: &tauri::AppHandle,
    id: &str,
    req: &bsc_fleet::WakeRequest,
) -> Result<bsc_fleet::WakeResult, String> {
    if req.pane_id.trim().is_empty() {
        return Err("fleet wake: no pane id".into());
    }

    // Resolve BUSY here rather than in the frontend: the store does not know whether a shell has a live
    // descendant — `PtyState` + `shells_with_descendants` is the same authority `bsc fleet list` reports
    // from, so `list` and `wake` cannot disagree about which panes are working.
    let was_busy = app
        .try_state::<crate::console::pty::PtyState>()
        .map(|st| crate::console::pty::pane_liveness(vec![req.pane_id.clone()], &st))
        .and_then(|v| v.into_iter().next())
        .is_some_and(|p| p.busy);
    if was_busy && !req.force {
        // Refusing is the safe default: the wake kills the PTY, so an accidental wake destroys work
        // that is actually in flight.
        return Err(format!(
            "fleet wake: '{}' is BUSY — something is running in it. Waking kills its session first,              so this needs --force. `bsc fleet list` shows what is busy.",
            req.pane_id
        ));
    }

    let rx = register(app, id);

    // The id rides in the payload so the frontend can correlate its ack — a director loop and a human
    // could both have a wake in flight, and an ack for the wrong one would report the wrong pane woke.
    let mut payload = serde_json::to_value(req).map_err(|e| e.to_string())?;
    payload
        .as_object_mut()
        .ok_or("wake request did not serialize to an object")?
        .insert("id".into(), serde_json::Value::String(id.to_string()));

    app.emit("bsc://fleet-wake", payload)
        .map_err(|e| format!("cannot reach the frontend: {e}"))?;

    let ack = rx.recv_timeout(ACK_TIMEOUT).map_err(|_| {
        unregister(app, id); // don't leak the slot when nobody ever answers
        format!(
            "the frontend did not apply the wake within {}ms — is a window open, or was it \
             mid-reload? (the app IS running; this is not a 'no app' timeout)",
            ACK_TIMEOUT.as_millis()
        )
    })?;
    unregister(app, id);

    if let Some(e) = ack.error {
        return Err(e);
    }
    if !ack.woke {
        // The whole point of carrying the boolean: the PTY is already dead by now.
        return Err(format!(
            "fleet wake: the app could not wake '{}' — it resolved to no open tab, or is disabled. \
             Its session may now be stopped; `bsc fleet list` shows the current state.",
            req.pane_id
        ));
    }
    Ok(bsc_fleet::WakeResult { pane_id: req.pane_id.clone(), woke: true, was_busy })
}

fn register(app: &tauri::AppHandle, id: &str) -> Receiver<WakeAck> {
    let (tx, rx) = channel();
    if let Some(state) = app.try_state::<WakePending>() {
        if let Ok(mut m) = state.0.lock() {
            m.insert(id.to_string(), tx);
        }
    }
    rx
}

fn unregister(app: &tauri::AppHandle, id: &str) {
    if let Some(state) = app.try_state::<WakePending>() {
        if let Ok(mut m) = state.0.lock() {
            m.remove(id);
        }
    }
}

/// The frontend's ack — delivers into the waiter registered by [`apply`].
#[tauri::command]
pub(crate) fn fleet_wake_ack(ack: WakeAck, state: tauri::State<'_, WakePending>) {
    let tx = state.0.lock().ok().and_then(|mut m| m.remove(&ack.id));
    match tx {
        Some(tx) => {
            let _ = tx.send(ack);
        }
        None => log::debug!("fleet wake: ack for {} had no waiter (timed out?)", ack.id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An ack delivers to exactly its own waiter and is consumed — two wakes in flight must not cross,
    /// or a director would be told the wrong pane woke.
    #[test]
    fn an_ack_reaches_only_its_own_waiter() {
        let pending = WakePending::default();
        let (tx_a, rx_a) = channel::<WakeAck>();
        let (tx_b, rx_b) = channel::<WakeAck>();
        {
            let mut m = pending.0.lock().unwrap();
            m.insert("a".into(), tx_a);
            m.insert("b".into(), tx_b);
        }
        // Simulate fleet_wake_ack's core: take the waiter out and deliver.
        let ack = WakeAck { id: "b".into(), error: None, woke: true };
        let tx = pending.0.lock().unwrap().remove(&ack.id).unwrap();
        tx.send(ack).unwrap();

        assert!(rx_b.try_recv().is_ok(), "b's waiter got its ack");
        assert!(rx_a.try_recv().is_err(), "a's waiter is untouched");
        assert!(pending.0.lock().unwrap().contains_key("a"), "a is still registered");
        assert!(!pending.0.lock().unwrap().contains_key("b"), "b was consumed");
    }
}
