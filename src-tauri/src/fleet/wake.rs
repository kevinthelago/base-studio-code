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
    let probe = app
        .try_state::<crate::console::pty::PtyState>()
        .map(|st| crate::console::pty::pane_liveness(vec![req.pane_id.clone()], &st))
        .and_then(|v| v.into_iter().next());
    let was_busy = probe.as_ref().is_some_and(|p| p.busy);
    // A LIVE pane already has its roster entry, so it needs no plan lookup below. Read from the same
    // probe as `busy` rather than a second call: two reads of `PtyState` could straddle a session
    // ending, and "busy but not live" is not a state that should be expressible here.
    let live = probe.as_ref().is_some_and(|p| p.live);
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
    let obj = payload
        .as_object_mut()
        .ok_or("wake request did not serialize to an object")?;
    obj.insert("id".into(), serde_json::Value::String(id.to_string()));

    // START A STREAM THAT NEVER LAUNCHED (`the-director-cannot-start-a-stream-that-never-launched`).
    //
    // The store's roster (`fleetPaneStreams`) is written by `fleetStartProject` alone, so it knows what
    // LAUNCHED, never what the plan HOLDS. A stream plan.db names and no session ever ran is invisible
    // there, and `wakePane` refused it — leaving the director with only `bsc fleet start <projectKey>`,
    // a WHOLE-fleet launch that is refused outright while any pane is live.
    //
    // plan.db is the planned roster and this side already reads it (`fleet::start` does), so resolve the
    // row here and send it. ONLY FOR A PANE THAT IS NOT LIVE: a live pane is in the roster already, and
    // an ordinary wake must not pay a plan.db read and a worktree check it cannot use.
    //
    // A failure to resolve is NOT fatal. It means plan.db does not name this stream, and an unknown
    // stream must still refuse — which is what happens when the frontend receives no `stream`.
    if !live {
        if let Some(stream) = resolve_stream(&req.pane_id) {
            obj.insert("stream".into(), stream);
        }
    }

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

/// Split a WORKER pane id into `(project key, stream id)`, or `None` when it is not one.
///
/// PURE, and separate from the lookup, because the ids this must turn down are the interesting half and
/// a store is not needed to judge them. A director pane (`<key>:director`) carries no plan row and is
/// created by `bsc fleet director new`; a triage pane is `<key>:<repo>:triage`, so a second colon means
/// this grammar does not apply; and a bare id with no colon is not a fleet pane at all.
fn worker_pane(pane_id: &str) -> Option<(&str, &str)> {
    let (key, stream_id) = pane_id.split_once(':')?;
    if key.is_empty() || stream_id.is_empty() || stream_id == "director" || stream_id.contains(':') {
        return None;
    }
    Some((key, stream_id))
}

/// The plan.db row for a worker pane, with the absolute cwd its session would run in — or `None` when
/// plan.db does not name this stream, which is how an UNKNOWN stream stays an error downstream.
///
/// The cwd is resolved HERE for the reason a fleet launch resolves it here (#905): the store would have
/// to re-derive it from the async-loaded `bscBaseDir` mirror, and an empty one drops the session at the
/// user's home dir. A repo'd worker gets its git worktree, CREATED if it does not exist yet — the same
/// `ensure_worktree` a fleet start calls, so a stream that never launched gets the same tree it would
/// have got then. A REPO-LESS stream is not an error: it is a team-derived hub role-actor (#3103) and
/// runs at the hub, exactly as `fleetStartProject` places it.
///
/// The director is deliberately excluded. Its pane is not a stream, it carries no plan row, and
/// `bsc fleet director new` is the verb that creates one.
fn resolve_stream(pane_id: &str) -> Option<serde_json::Value> {
    let (key, stream_id) = worker_pane(pane_id)?;

    let store = plandb::Store::open(&crate::platform::paths::plan_db_path(key)).ok()?;
    let mut row = store
        .fleet_stream_list()
        .ok()?
        .into_iter()
        .find(|r| r.get("id").and_then(|v| v.as_str()) == Some(stream_id))?;

    let repo = row.get("repo").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let cwd = if repo.is_empty() {
        // A hub role-actor. `materialize_hub` is idempotent, and a hub that does not exist yet would
        // drop the session in a missing directory — the same failure `fleet start` materializes against.
        crate::project::hub::materialize_hub(key.to_string()).ok()?;
        bsc_project::project_dir(key)?.to_string_lossy().into_owned()
    } else {
        crate::fleet::worktree::ensure_worktree(key.to_string(), repo, stream_id.to_string(), None).ok()?
    };

    row.as_object_mut()?.insert("cwd".into(), serde_json::Value::String(cwd));
    Some(row)
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

    // ── which pane ids carry a plan row (#the-director-cannot-start-a-stream-that-never-launched) ──

    #[test]
    fn a_worker_pane_splits_into_its_project_and_stream() {
        assert_eq!(worker_pane("demo:api"), Some(("demo", "api")));
        // A stream id may contain anything a slug does — the split is on the FIRST colon only.
        assert_eq!(worker_pane("my-app:api-v2"), Some(("my-app", "api-v2")));
    }

    #[test]
    fn the_panes_that_carry_no_plan_row_are_turned_down() {
        // The director is not a stream: it has no plan.db row, and `bsc fleet director new` creates it.
        assert_eq!(worker_pane("demo:director"), None);
        // A triage pane is `<key>:<repo>:triage` — a second colon means this grammar does not apply.
        assert_eq!(worker_pane("demo:own/api:triage"), None);
        // Not a fleet pane at all.
        assert_eq!(worker_pane("scratch"), None);
        assert_eq!(worker_pane("demo:"), None);
        assert_eq!(worker_pane(":api"), None);
    }

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
