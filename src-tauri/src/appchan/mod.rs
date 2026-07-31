//! `appchan` (#3274, epic #3260) — the **one** watcher answering `bsc`→app requests.
//!
//! `bsc` cannot call the app (the bridge only runs app→`bsc`), so each CLI drops a request in
//! `~/.base-studio-code/appreq/` and this loop answers it. The transport lives in the Tauri-free
//! [`bsc_appchan`] crate so the lean `bsc` binary can depend on it; only the handlers are here.
//!
//! ## One watcher, routed by kind
//! #3261 shipped this loop inside `shot`. Adding `navigate` could have meant a second dir + a second
//! watcher — the "superseded but never removed" duplication removed twice in one day (#3244, #3251).
//! So the loop is here and dispatches on [`bsc_appchan::Envelope::kind`]; each verb owns only its handler.
//!
//! ## Every request gets an answer
//! Success or a stated error — never silence. A request that fails quietly leaves the caller to time out
//! reporting "is the app running?" while the app IS running and the handler is what broke. That
//! distinction is the difference between a debuggable loop and a mysterious one.

use std::time::Duration;

/// How often the loop sweeps for new requests. A request is interactive-ish (a loop iteration waits on
/// it), so this is the latency floor; the CLIs allow 8s, so there is ample room.
const POLL_INTERVAL: Duration = Duration::from_millis(150);

/// Requests older than this are dropped rather than served — an abandoned CLI (Ctrl-C'd mid-poll) must
/// not have its capture taken, or the app navigated, minutes later for nobody.
const STALE_MS: i64 = 60_000;

/// Watch the channel and answer requests. Spawned once at app setup.
pub fn spawn_watcher(app: tauri::AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = match bsc_appchan::chan_dir() {
            Ok(d) => d,
            Err(e) => {
                log::warn!("appchan: no channel dir, bsc→app requests disabled: {e}");
                return;
            }
        };
        if let Err(e) = std::fs::create_dir_all(&dir) {
            log::warn!("appchan: cannot create {}, bsc→app requests disabled: {e}", dir.display());
            return;
        }
        log::info!("appchan: watching {}", dir.display());

        loop {
            let now = bsc_util::now_ms();
            let _ = bsc_appchan::sweep_stale(&dir, now, STALE_MS);

            match bsc_appchan::pending(&dir) {
                Ok(reqs) => {
                    for env in reqs {
                        // Age it here too: `pending` reports everything unanswered, and a request that
                        // arrived while we were mid-handler may already be past its caller's patience.
                        if now - env.at > STALE_MS {
                            continue;
                        }
                        serve(&app, &dir, &env);
                    }
                }
                Err(e) => log::warn!("appchan: cannot list {}: {e}", dir.display()),
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

/// Answer ONE request. Never panics out of the loop: a bad request must not stop every future one.
fn serve(app: &tauri::AppHandle, dir: &std::path::Path, env: &bsc_appchan::Envelope) {
    let now = bsc_util::now_ms();
    let reply = match handle(app, env) {
        Ok(payload) => bsc_appchan::Reply { id: env.id.clone(), error: None, payload, at: now },
        Err(e) => {
            log::warn!("appchan: {} {} failed: {e}", env.kind, env.id);
            bsc_appchan::Reply::err(&env.id, &e, now)
        }
    };
    if let Err(e) = bsc_appchan::write_reply(dir, &reply) {
        // The caller will now time out. Nothing else we can do, but say so — a silent loss here looks
        // exactly like "the app isn't running", which would send someone debugging the wrong thing.
        log::error!("appchan: cannot answer {}: {e}", env.id);
    }
}

/// Route one envelope to its verb. Returns the reply payload, or a stated error.
#[allow(unused_imports)]
use tauri::Manager;

fn handle(app: &tauri::AppHandle, env: &bsc_appchan::Envelope) -> Result<serde_json::Value, String> {
    match env.kind.as_str() {
        bsc_shot::KIND => {
            let req: bsc_shot::ShotRequest = serde_json::from_value(env.payload.clone())
                .map_err(|e| format!("malformed shot request: {e}"))?;
            let res = crate::shot::capture(app, &env.id, &req)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        bsc_fleet::KIND => {
            let req: bsc_fleet::FleetRequest = serde_json::from_value(env.payload.clone())
                .map_err(|e| format!("malformed fleet request: {e}"))?;
            let state = app.state::<crate::console::pty::PtyState>();
            let panes = crate::console::pty::pane_liveness(req.pane_ids, &state);
            serde_json::to_value(bsc_fleet::FleetResult { panes }).map_err(|e| e.to_string())
        }
        bsc_fleet::WAKE_KIND => {
            let req: bsc_fleet::WakeRequest = serde_json::from_value(env.payload.clone())
                .map_err(|e| format!("malformed fleet wake request: {e}"))?;
            let res = crate::fleet::wake::apply(app, &env.id, &req)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        bsc_navigate::KIND => {
            let req: bsc_navigate::NavRequest = serde_json::from_value(env.payload.clone())
                .map_err(|e| format!("malformed navigate request: {e}"))?;
            let res = crate::navigate::apply(app, &env.id, &req)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        bsc_debug::KIND => {
            let req: bsc_debug::DebugRequest = serde_json::from_value(env.payload.clone())
                .map_err(|e| format!("malformed debug request: {e}"))?;
            let res = crate::debug::inspect(app, &env.id, &req)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        // A `bsc` newer than this app asking for a verb it doesn't have. Say so plainly — the caller
        // can't tell "unknown verb" from "the app is old" otherwise.
        other => Err(format!(
            "this app build has no handler for '{other}' — is `bsc` newer than the running app?"
        )),
    }
}

#[cfg(test)]
mod tests {
    /// The routing keys the watcher dispatches on. If a verb crate renames its KIND, requests would
    /// silently fall through to "unknown verb" — this pins the pair.
    #[test]
    fn the_verbs_own_their_routing_keys() {
        assert_eq!(bsc_shot::KIND, "shot");
        assert_eq!(bsc_navigate::KIND, "navigate");
        assert_eq!(bsc_debug::KIND, "debug");
        // One channel, routed by kind — a collision silently sends a request to the wrong handler.
        let kinds = [bsc_shot::KIND, bsc_navigate::KIND, bsc_debug::KIND];
        for (i, a) in kinds.iter().enumerate() {
            for b in &kinds[i + 1..] {
                assert_ne!(a, b, "two verbs on one channel must not collide");
            }
        }
    }
}
