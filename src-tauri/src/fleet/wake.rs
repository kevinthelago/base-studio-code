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
        // `?` on purpose. THREE outcomes, and collapsing them is the bug this shape prevents: not a
        // worker pane and "plan.db does not name it" are legitimately silent (they are how the
        // unknown-stream refusal downstream still works), but a stream that IS named and whose cwd
        // could not be prepared is a real failure with a cause worth printing. Swallowed, it reached
        // the caller as "it resolved to no open tab, or is disabled" — which sent three rounds of
        // debugging at the frontend for a repo that was simply not cloned.
        if let Some(stream) = resolve_stream(&req.pane_id)? {
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
        return Err(unresolved_wake_message(&req.pane_id));
    }
    Ok(bsc_fleet::WakeResult { pane_id: req.pane_id.clone(), woke: true, was_busy })
}

/// The FALLBACK refusal message — reached only when the frontend answered `woke: false` with no
/// `ack.error`, i.e. it could not name a reason (an app build older than
/// `a-refused-wake-must-name-which-condition-refused-it`, or a bridge exception before it reached
/// `refusalReason`). The named-cause path is normal now; this is what is left over.
///
/// Request #133 (network-monitor:director) is this string, quoted verbatim, from a director stuck
/// retrying a wake for five-plus minutes: "the app could not wake ... it resolved to no open tab, or is
/// disabled". `a-wake-revives-a-disabled-pane` fixed the *cause* — DISABLED no longer refuses a wake, it
/// revives one — but left this sentence still claiming disabled panes as a possible cause, which is now
/// simply wrong and would send the next reader chasing a condition that cannot happen. Say what remains
/// instead: no owning tab to recreate, or a stream neither the roster nor plan.db names.
fn unresolved_wake_message(pane_id: &str) -> String {
    format!(
        "fleet wake: the app could not wake '{pane_id}' and did not say why — it resolved to no open \
         tab it could recreate, or to a stream neither the roster nor plan.db names. `bsc fleet list` \
         shows the current state; `bsc plan fleet get` shows what plan.db knows about this stream."
    )
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

/// The plan.db row for a worker pane, with the absolute cwd its session would run in.
///
/// `Ok(None)` is the SILENT arm — not a worker pane, or plan.db does not name this stream. Both must
/// stay silent: that is how an unknown stream still reaches the refusal downstream.
///
/// `Err` is the arm that was missing. A stream plan.db DOES name, whose cwd cannot be prepared, is a
/// real failure with a cause — `ensure_worktree: repo not cloned: …` is the one that bit — and telling
/// the caller "it resolved to no open tab" instead names neither the stream, the repo, nor the reason.
/// `fleet/start.rs` already draws this line for the identical failure, so the wording matches it: one
/// cause must not read as two different bugs.
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
fn resolve_stream(pane_id: &str) -> Result<Option<serde_json::Value>, String> {
    let Some((key, stream_id)) = worker_pane(pane_id) else { return Ok(None) };

    // A store that will not open is the same silence as a project with no plan: there is nothing to
    // say about a stream nobody planned, and the refusal downstream is the right answer.
    let Ok(store) = plandb::Store::open(&crate::platform::paths::plan_db_path(key)) else {
        return Ok(None);
    };
    let streams = store.fleet_stream_list().unwrap_or_default();
    let mut row = match streams.iter().find(|r| r.get("id").and_then(|v| v.as_str()) == Some(stream_id)) {
        Some(r) => r.clone(),
        None => {
            // ON-DEMAND LANE PROVISIONING (#132). `commons`/`integration` (bare, or per-repo
            // `--<slug>` suffixed) are ORDINARY streams `commonsLanesFor` materializes at launch —
            // but only inside `fleetStartProject`, a frontend action, and only when it derives a
            // non-empty stack from `planStages`, a field nothing in the shipped app still writes
            // (see `fleet::commons` module docs). So a plan can go its whole life with no commons
            // lane, and a director that discovers this mid-run — exactly what happened on
            // network-monitor, filing #132 — has no OTHER lever: `bsc plan fleet stream set` exists,
            // but the protocol never told a director to reach for it, and doing so by hand means
            // re-deriving the stack detection this module already centralizes.
            //
            // So a wake for a RECOGNIZABLY lane-shaped id, that plan.db does not (yet) name, does not
            // take the silent refusal every other unplanned stream takes: it provisions the pair (a
            // commons lane never comes without its integration lane, `commonsLanesFor`) and proceeds
            // as if it had always been there. Any OTHER unplanned id still resolves silently, below.
            if !crate::fleet::commons::is_lane_stream(stream_id) {
                return Ok(None);
            }
            let known_repos: Vec<String> = streams
                .iter()
                .filter_map(|r| r.get("repo").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .collect();
            let repo = crate::fleet::commons::resolve_lane_repo(stream_id, &known_repos)
                .map_err(|e| format!("fleet wake: cannot provision the lane '{stream_id}': {e}"))?;
            let (commons_id, integration_id) = crate::fleet::commons::lane_id_pair(stream_id);
            let (commons_row, integration_row) =
                crate::fleet::commons::build_lane_rows(&commons_id, &integration_id, &repo);
            store.fleet_stream_set(&commons_id, &commons_row).map_err(|e| {
                format!("fleet wake: could not provision the commons lane '{commons_id}': {e}")
            })?;
            store.fleet_stream_set(&integration_id, &integration_row).map_err(|e| {
                format!("fleet wake: could not provision the integration lane '{integration_id}': {e}")
            })?;
            log::info!(
                "fleet wake: provisioned the '{commons_id}'/'{integration_id}' lanes for '{key}' \
                 (repo {repo}) — plan.db had neither yet, and '{stream_id}' asked for one"
            );
            if stream_id == commons_id { commons_row } else { integration_row }
        }
    };

    // From here the stream IS real, so every failure is nameable and none of them may be silent.
    let repo = row.get("repo").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let cwd = if repo.is_empty() {
        // A hub role-actor. `materialize_hub` is idempotent, and a hub that does not exist yet would
        // drop the session in a missing directory — the same failure `fleet start` materializes against.
        crate::project::hub::materialize_hub(key.to_string())
            .map_err(|e| format!("fleet wake: could not materialize the project hub for '{key}': {e}"))?;
        bsc_project::project_dir(key)
            .ok_or_else(|| format!("fleet wake: no home dir, so '{key}' has no hub path"))?
            .to_string_lossy()
            .into_owned()
    } else {
        crate::fleet::worktree::ensure_worktree(key.to_string(), repo.clone(), stream_id.to_string(), None)
            .map_err(|e| {
                format!(
                    "fleet wake: no session was started — could not create the worktree for stream \
                     '{stream_id}' in {repo}: {e}"
                )
            })?
    };

    // Close the OTHER gap `resolve_stream` can hit alongside a missing worktree: a cwd that exists but
    // has no `.claude/settings.json` yet (request #142; `bsc fleet doctor`'s `no-gate` finding). Without
    // this, `pty_launch_refusal` refuses every wake of it forever — the refusal fires before `wakePane`,
    // which is the only thing that would ever trigger the real settings write. See
    // `ensure_session_gate`'s doc comment for why a placeholder here is safe.
    crate::fleet::worktree::ensure_session_gate(&cwd);

    if let Some(obj) = row.as_object_mut() {
        obj.insert("cwd".into(), serde_json::Value::String(cwd));
    }
    Ok(Some(row))
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

    // ── the three outcomes stay three (#a-wake-that-cannot-build-its-worktree-reports-the-wrong-failure) ──

    #[test]
    fn a_pane_that_is_not_a_worker_resolves_silently() {
        // Silent, NOT an error: the director and a triage pane carry no plan row, and the refusal
        // downstream is the right answer for them. An Err here would turn every director wake red.
        for pane in ["demo:director", "demo:own/api:triage", "scratch"] {
            assert!(matches!(resolve_stream(pane), Ok(None)), "{pane} must resolve silently");
        }
    }

    #[test]
    fn a_stream_no_plan_names_resolves_silently_too() {
        // The UNKNOWN-stream case, and the one the whole design turns on: it must stay silent so the
        // frontend's refusal is what the caller sees, rather than a Rust error that would read as a
        // malfunction instead of "that stream does not exist".
        //
        // `$HOME` is pointed at a fresh temp dir so the plan store genuinely is not there — the same
        // shape as a project key nobody has planned. ENV_LOCK because `home_dir()` is process-global
        // and nextest runs these in one process per test but `cargo test` threads them.
        let _lock = crate::testutil::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = crate::testutil::temp_home("wake-unplanned");
        assert!(matches!(resolve_stream("nobody-planned-this:api"), Ok(None)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_stream_provisions_the_lane_pair_in_plan_db_on_first_wake() {
        // THE REGRESSION (#132, network-monitor): a plan that never got a commons/integration lane
        // gave its director no lever to create one — `bsc fleet wake <key>:commons--<slug>` used to
        // resolve silently (no plan row), which the caller read as "it resolved to no open tab, or is
        // disabled". Waking a recognizably lane-shaped id that plan.db does not yet name must now
        // PROVISION the pair — proven here against a real `plandb::Store`, not just the pure helpers
        // in `commons.rs`.
        let _lock = crate::testutil::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = crate::testutil::temp_home("wake-lane-provision");

        let store = plandb::Store::open(&crate::platform::paths::plan_db_path("proj")).unwrap();
        store
            .fleet_stream_set(
                "domain-model",
                &serde_json::json!({
                    "id": "domain-model", "repo": "kevinthelago/networkmonitor",
                    "owns": ["src/**"], "dependsOn": [],
                }),
            )
            .unwrap();
        assert!(
            store.fleet_stream_list().unwrap().iter().all(|r| r.get("id").and_then(|v| v.as_str()) != Some("commons--kevinthelago-networkmonitor")),
            "the lane must not exist yet — that absence is the bug"
        );

        // The repo is named but never cloned in this test, so cwd resolution genuinely fails
        // downstream — real and expected with no git fixture. What matters is that provisioning
        // already landed in plan.db before that failure.
        let err = resolve_stream("proj:commons--kevinthelago-networkmonitor").unwrap_err();
        assert!(err.contains("repo not cloned"), "the downstream cwd failure is real, not swallowed: {err}");

        let streams = store.fleet_stream_list().unwrap();
        let commons = streams
            .iter()
            .find(|r| r.get("id").and_then(|v| v.as_str()) == Some("commons--kevinthelago-networkmonitor"))
            .expect("the commons lane was provisioned into plan.db");
        let integration = streams
            .iter()
            .find(|r| r.get("id").and_then(|v| v.as_str()) == Some("integration--kevinthelago-networkmonitor"))
            .expect("the integration lane was provisioned alongside it");
        assert_eq!(commons["repo"], serde_json::json!("kevinthelago/networkmonitor"));
        let owns = commons["owns"].as_array().unwrap();
        assert!(owns.iter().any(|v| v == "Cargo.toml"), "the commons lane owns the manifest #132 was filed over");
        assert_eq!(
            integration["dependsOn"],
            serde_json::json!(["commons--kevinthelago-networkmonitor"]),
            "the integration lane gates on its own commons lane"
        );

        // A second wake for the same lane must not mint a duplicate row.
        let before = store.fleet_stream_list().unwrap().len();
        let _ = resolve_stream("proj:commons--kevinthelago-networkmonitor");
        assert_eq!(
            store.fleet_stream_list().unwrap().len(),
            before,
            "waking an already-provisioned lane does not duplicate it"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #142 (network-monitor:director): a worktree/hub that plan.db names can exist with NO
    /// `.claude/settings.json` — an earlier `start`/`wake` that built the cwd but never reached the
    /// settings write. Left alone, `pty_launch_refusal` refuses it FOREVER: the refusal fires before the
    /// only thing (a real launch) that would ever write the real gate. `resolve_stream` must close that
    /// gap itself, the same way it already closes a missing WORKTREE.
    #[test]
    fn resolve_stream_provisions_a_missing_gate_at_the_hub_for_a_repo_less_stream() {
        let _lock = crate::testutil::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = crate::testutil::temp_home("wake-hub-gate");

        let store = plandb::Store::open(&crate::platform::paths::plan_db_path("proj")).unwrap();
        // A repo-less stream (a hub role-actor, #3103) — no "repo" key, so `resolve_stream` takes the
        // hub branch rather than building a worktree.
        store
            .fleet_stream_set("triage-lead", &serde_json::json!({ "id": "triage-lead", "dependsOn": [] }))
            .unwrap();

        let row = resolve_stream("proj:triage-lead").unwrap().expect("a planned repo-less stream resolves");
        let cwd = row.get("cwd").and_then(|v| v.as_str()).expect("cwd is carried on the row");
        assert!(
            std::path::Path::new(cwd).join(".claude").join("settings.json").is_file(),
            "resolve_stream provisions the missing gate at the hub cwd (#142): {cwd}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_error_names_the_stream_the_repo_and_the_cause() {
        // The regression. `ensure_worktree: repo not cloned` used to become an absent `stream`, which
        // the caller read as "it resolved to no open tab, or is disabled" — naming neither the stream,
        // the repo, nor the reason, and sending three rounds of debugging at the frontend.
        let msg = format!(
            "fleet wake: no session was started — could not create the worktree for stream \
             '{}' in {}: {}",
            "accessibility", "kevinthelago/base-studio-code", "ensure_worktree: repo not cloned: /x",
        );
        assert!(msg.contains("accessibility"), "names the stream");
        assert!(msg.contains("kevinthelago/base-studio-code"), "names the repo");
        assert!(msg.contains("repo not cloned"), "carries the cause");
        // Worded to match `fleet start`'s error for the identical failure, so one cause does not read
        // as two different bugs depending on which verb hit it.
        assert!(msg.contains("could not create the worktree for stream"));
    }

    // ── the fallback refusal must not claim a cause that can no longer happen (#133) ──

    #[test]
    fn the_fallback_wake_message_no_longer_blames_a_disabled_pane() {
        // `a-wake-revives-a-disabled-pane` made DISABLED a REVIVED case, not a refused one, so a
        // sentence that still lists it as a possible reason a wake failed is actively misleading —
        // exactly what sent request #133's director in circles for five-plus minutes.
        let msg = unresolved_wake_message("network-monitor:domain-model-and-adapter-traits");
        assert!(
            !msg.to_lowercase().contains("disabled"),
            "a disabled pane is revived, not refused, so the fallback must not name it: {msg}"
        );
        assert!(msg.contains("network-monitor:domain-model-and-adapter-traits"), "names the pane");
        assert!(msg.contains("bsc fleet list"), "points at how to check current state");
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
