//! `bsc session` (#architect-starts-and-stops-system-sessions) — the app side of start · stop · list
//! for the app-owned SYSTEM SESSIONS.
//!
//! ```text
//! bsc session list          → request file → watcher → answered HERE, in Rust (liveness is PtyState)
//! bsc session start|stop    → request file → watcher → emit `bsc://session-lifecycle`
//!                           → the frontend opens/closes the studio → invokes `system_session_ack`
//! ```
//!
//! ## Why the split
//! Liveness is a pure Rust fact — the same `pane_liveness` walk `bsc fleet list` reports from, so the
//! two commands cannot disagree about what is running. Bringing a studio UP is not: `openStudio` marks
//! it wanted and `StudioSessionHosts` mounts its `TerminalSlot`, which is zustand state Rust cannot
//! touch. Same shape as `fleet::wake`, for the same reason.
//!
//! ## Why the id is re-resolved here
//! The CLI already refuses anything outside the closed set. This resolves it AGAIN before acting,
//! because the channel is a directory any process can write to — treating the CLI as the only writer
//! would make the mitigation a convention rather than a boundary. The closed set is the whole reason
//! this verb is safe to grant the architect, so it is enforced on both sides of the wire.
//!
//! ## Why RUNNING is not just "wanted"
//! A studio is "running" when the frontend wants it (its mount is up) OR a PTY still exists for its
//! pane. Those can disagree: `TerminalView`'s unmount deliberately leaves the backend session alive so
//! a tab-switch reconnects rather than respawns, so a stray PTY can outlive the mount. Reporting on
//! `wanted` alone would tell a caller "not running" while a `claude` process was still up — and then
//! `stop` would leave it there. So Rust measures the PTY, the frontend knows the mount, and the
//! outcome is decided from both.

use bsc_session::{
    LifecycleAction, LifecycleRequest, LifecycleResult, SessionListRequest, SessionListResult,
    SystemSessionState, SYSTEM_SESSIONS,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Shorter than the CLI's timeout so the caller gets our real error ("the frontend did not ack")
/// rather than a bare timeout that reads as "the app is not running".
const ACK_TIMEOUT: Duration = Duration::from_millis(5_000);

/// `bsc session list` — every system session's real state, answered in Rust.
///
/// Always reports the WHOLE registry, filtered by the request's ids when it names any. A session with
/// no PTY is reported as `live: false` rather than omitted: "not running" is an answer, and a missing
/// row would read as "this session does not exist".
pub fn list(app: &tauri::AppHandle, req: &SessionListRequest) -> Result<SessionListResult, String> {
    let wanted: Vec<&'static bsc_session::SystemSession> = if req.ids.is_empty() {
        SYSTEM_SESSIONS.iter().collect()
    } else {
        // An unknown id in the filter is DROPPED rather than erroring the whole read: `list` is the
        // command a caller runs to find out what the valid ids are, so failing it on a bad guess would
        // withhold exactly the information being asked for.
        req.ids.iter().filter_map(|id| bsc_session::resolve(id).ok()).collect()
    };

    let state = app.state::<crate::console::pty::PtyState>();
    let liveness = crate::console::pty::pane_liveness(
        wanted.iter().map(|s| s.pane_id.to_string()).collect(),
        &state,
    );

    let sessions = wanted
        .iter()
        .map(|s| {
            let live = liveness.iter().find(|p| p.pane_id == s.pane_id);
            SystemSessionState {
                id: s.id.to_string(),
                pane_id: s.pane_id.to_string(),
                live: live.is_some_and(|p| p.live),
                busy: live.is_some_and(|p| p.busy),
                pid: live.and_then(|p| p.pid),
            }
        })
        .collect();
    Ok(SessionListResult { sessions })
}

/// What the frontend sends back once it has applied the lifecycle change.
#[derive(Debug, Clone, Deserialize)]
pub struct LifecycleAck {
    pub id: String,
    /// Set when the frontend could not apply it at all (it threw).
    #[serde(default)]
    pub error: Option<String>,
    /// The outcome, as the frontend observed it — `started` / `already-running` / `stopped` /
    /// `not-running`.
    #[serde(default)]
    pub outcome: Option<bsc_session::LifecycleOutcome>,
}

/// In-flight lifecycle requests, keyed by request id.
#[derive(Default)]
pub struct LifecyclePending(Mutex<HashMap<String, Sender<LifecycleAck>>>);

/// Ask the frontend to start or stop a system session, and block until it acks.
pub fn apply(
    app: &tauri::AppHandle,
    id: &str,
    req: &LifecycleRequest,
) -> Result<LifecycleResult, String> {
    // THE BOUNDARY. Not a courtesy re-check: anything that can write the channel dir reaches this line,
    // so the closed set has to be enforced where the action happens, not only where the CLI parsed it.
    let session = match req.action {
        LifecycleAction::Start => bsc_session::resolve(&req.id)?,
        LifecycleAction::Stop => bsc_session::resolve_stoppable(&req.id)?,
    };

    // Measured here rather than asked of the frontend: the store knows what it WANTS mounted, not
    // whether a PTY exists. Both halves are needed to answer "is it running" honestly — see the header.
    let pty_live = app
        .try_state::<crate::console::pty::PtyState>()
        .map(|st| crate::console::pty::pane_liveness(vec![session.pane_id.to_string()], &st))
        .and_then(|v| v.into_iter().next())
        .is_some_and(|p| p.live);

    let rx = register(app, id);

    let payload = serde_json::json!({
        "id": id,
        "sessionId": session.id,
        "paneId": session.pane_id,
        "action": match req.action { LifecycleAction::Start => "start", LifecycleAction::Stop => "stop" },
        // The frontend ORs this with its own `wantedStudios` view. Sent rather than re-derived there
        // because the store cannot see a PTY.
        "ptyLive": pty_live,
    });

    app.emit("bsc://session-lifecycle", payload)
        .map_err(|e| format!("cannot reach the frontend: {e}"))?;

    let ack = rx.recv_timeout(ACK_TIMEOUT).map_err(|_| {
        unregister(app, id); // don't leak the slot when nobody ever answers
        format!(
            "the frontend did not apply the {} within {}ms — is a window open, or was it mid-reload? \
             (the app IS running; this is not a 'no app' timeout)",
            match req.action { LifecycleAction::Start => "start", LifecycleAction::Stop => "stop" },
            ACK_TIMEOUT.as_millis()
        )
    })?;
    unregister(app, id);

    if let Some(e) = ack.error {
        return Err(e);
    }
    // No outcome means the frontend acked without saying what happened — which is indistinguishable
    // from a no-op that succeeded, and a caller acting on "started" when nothing started is the #4025
    // failure in a different costume. Refuse rather than invent one.
    let outcome = ack.outcome.ok_or_else(|| {
        format!(
            "the app acked the {} of '{}' without reporting an outcome — its state is unknown; \
             `bsc session list` shows what is actually running.",
            match req.action { LifecycleAction::Start => "start", LifecycleAction::Stop => "stop" },
            session.id
        )
    })?;

    Ok(LifecycleResult {
        id: session.id.to_string(),
        pane_id: session.pane_id.to_string(),
        outcome,
    })
}

fn register(app: &tauri::AppHandle, id: &str) -> Receiver<LifecycleAck> {
    let (tx, rx) = channel();
    if let Some(state) = app.try_state::<LifecyclePending>() {
        if let Ok(mut m) = state.0.lock() {
            m.insert(id.to_string(), tx);
        }
    }
    rx
}

fn unregister(app: &tauri::AppHandle, id: &str) {
    if let Some(state) = app.try_state::<LifecyclePending>() {
        if let Ok(mut m) = state.0.lock() {
            m.remove(id);
        }
    }
}

/// The frontend's ack — delivers into the waiter registered by [`apply`].
#[tauri::command]
pub(crate) fn system_session_ack(ack: LifecycleAck, state: tauri::State<'_, LifecyclePending>) {
    let tx = state.0.lock().ok().and_then(|mut m| m.remove(&ack.id));
    match tx {
        Some(tx) => {
            let _ = tx.send(ack);
        }
        None => log::debug!("session lifecycle: ack for {} had no waiter (timed out?)", ack.id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsc_session::LifecycleOutcome;

    /// An ack delivers to exactly its own waiter and is consumed — two lifecycle requests in flight
    /// must not cross, or a caller would be told the wrong session started.
    #[test]
    fn an_ack_reaches_only_its_own_waiter() {
        let pending = LifecyclePending::default();
        let (tx_a, rx_a) = channel::<LifecycleAck>();
        let (tx_b, rx_b) = channel::<LifecycleAck>();
        {
            let mut m = pending.0.lock().unwrap();
            m.insert("a".into(), tx_a);
            m.insert("b".into(), tx_b);
        }
        let ack = LifecycleAck { id: "b".into(), error: None, outcome: Some(LifecycleOutcome::Started) };
        let tx = pending.0.lock().unwrap().remove(&ack.id).unwrap();
        tx.send(ack).unwrap();

        assert!(rx_b.try_recv().is_ok(), "b's waiter got its ack");
        assert!(rx_a.try_recv().is_err(), "a's waiter is untouched");
        assert!(pending.0.lock().unwrap().contains_key("a"), "a is still registered");
        assert!(!pending.0.lock().unwrap().contains_key("b"), "b was consumed");
    }

    /// The ack's outcome is the wire enum, so the frontend's kebab-case strings must deserialize into
    /// it. A silent mismatch here would surface as "acked without an outcome" for every request.
    #[test]
    fn the_frontends_outcome_strings_deserialize() {
        for (json, want) in [
            ("\"started\"", LifecycleOutcome::Started),
            ("\"already-running\"", LifecycleOutcome::AlreadyRunning),
            ("\"stopped\"", LifecycleOutcome::Stopped),
            ("\"not-running\"", LifecycleOutcome::NotRunning),
        ] {
            let ack: LifecycleAck =
                serde_json::from_str(&format!("{{\"id\":\"x\",\"outcome\":{json}}}")).unwrap();
            assert_eq!(ack.outcome, Some(want));
        }
    }

    /// An ack with no outcome parses (the field is optional on the wire) but `apply` turns it into an
    /// error rather than a fabricated success — pinned here because the parse succeeding is exactly
    /// what makes the omission easy to miss.
    #[test]
    fn an_ack_without_an_outcome_parses_but_carries_none() {
        let ack: LifecycleAck = serde_json::from_str("{\"id\":\"x\"}").unwrap();
        assert!(ack.outcome.is_none());
        assert!(ack.error.is_none());
    }

    /// A `stop` naming a director never reaches the emit: `apply` resolves against the closed set
    /// first. This is the app-side half of the guarantee the CLI also makes — both sides, because the
    /// channel dir is writable by anything on the machine.
    #[test]
    fn the_app_side_refuses_an_id_outside_the_closed_set() {
        for candidate in ["studio-code:director", "director", "worker", ""] {
            assert!(
                bsc_session::resolve(candidate).is_err(),
                "{candidate} must not resolve app-side either"
            );
        }
    }
}
