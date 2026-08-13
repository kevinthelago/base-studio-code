//! `bsc fleet director new` (#architect-creates-a-director-with-discovery) — the architect's one
//! CREATE into the project tier.
//!
//! ```text
//! bsc fleet director new <key> → request file → watcher → resolve + seed the kickoff
//!                              → emit `bsc://fleet-director` → the frontend launches it
//!                              → invokes `fleet_director_ack` → we reply
//! ```
//!
//! ## What Rust decides, and what the frontend does
//! Everything checkable is settled HERE — does the project exist, is a director already running, does
//! the hub have a kickoff — because those are filesystem and `PtyState` facts. Only the launch itself
//! is emitted, because creating a pane is zustand state Rust cannot touch. Same split as
//! [`crate::fleet::wake`].
//!
//! ## Why the kickoff is written before the emit
//! The launch path reads `prompts/director-kickoff.md` as the director's startup doc. Writing it
//! afterwards would race the session that is already reading it — the director would come up with
//! whatever was there (usually nothing) and the discovery it was created to carry would arrive too
//! late to be what it read first. Creation carries context or it is just a launch.
//!
//! ## Why an existing kickoff is never overwritten
//! A planner-authored `director-kickoff.md` is that project's real briefing, and it is richer than
//! anything derivable from the discovery sources. Clobbering it would be a silent downgrade of a
//! director created by someone who only wanted one to exist. The reply says which one you got.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

const ACK_TIMEOUT: Duration = Duration::from_millis(8_000);

/// The kickoff path, relative to the project hub — the same one `fleetStartProject` points the
/// director's startup doc at.
const KICKOFF_RELPATH: &str = "prompts/director-kickoff.md";

/// What the frontend sends back once it has launched (or declined to).
#[derive(Debug, Clone, Deserialize)]
pub struct DirectorAck {
    pub id: String,
    #[serde(default)]
    pub error: Option<String>,
    /// Whether the launch actually happened.
    #[serde(default)]
    pub created: bool,
}

/// In-flight director creates, keyed by request id.
#[derive(Default)]
pub struct DirectorPending(Mutex<HashMap<String, Sender<DirectorAck>>>);

pub fn apply(
    app: &tauri::AppHandle,
    id: &str,
    req: &bsc_fleet::DirectorNewRequest,
) -> Result<bsc_fleet::DirectorNewResult, String> {
    let key = req.project_key.trim();
    if key.is_empty() {
        return Err("fleet director new: no project key".into());
    }

    // THE PROJECT MUST ALREADY EXIST — mitigation (a): the argument is an id from a registry, not a
    // name that scaffolds something. Two places count as existing, because a project can legitimately
    // be in either: a durable row (created by `bsc project new` or the UI, hub not materialized yet)
    // or an on-disk hub (a project that predates the store). Requiring both would refuse a freshly
    // created draft, which is exactly the project an architect is most likely to want a director for.
    let hub = bsc_project::project_dir(key)
        .ok_or("fleet director new: no home dir ($HOME / $USERPROFILE unset)")?;
    let has_hub = hub.exists();
    let has_row = bsc_project::store::open()
        .ok()
        .and_then(|c| bsc_project::store::get(&c, key))
        .is_some();
    if !has_hub && !has_row {
        return Err(format!(
            "fleet director new: no project '{key}'. This creates a DIRECTOR for a project that \
             already exists — `bsc project list` shows the keys, and `bsc project new \"<name>\"` \
             makes a new one."
        ));
    }

    let pane_id = bsc_fleet::director_pane_id(key);

    // A SECOND COORDINATOR FOR ONE FLEET is the failure this check exists to prevent: both would
    // merge, both would answer a worker, and each would be working from a different picture. Measured
    // from `PtyState` — the same authority `bsc fleet directors` reports from, so the read a caller
    // ran a moment ago cannot disagree with this.
    let already_live = app
        .try_state::<crate::console::pty::PtyState>()
        .map(|st| crate::console::pty::pane_liveness(vec![pane_id.clone()], &st))
        .and_then(|v| v.into_iter().next())
        .is_some_and(|p| p.live);
    if already_live {
        return Ok(bsc_fleet::DirectorNewResult {
            project_key: key.to_string(),
            pane_id,
            outcome: bsc_fleet::DirectorOutcome::AlreadyRunning,
            kickoff_written: false,
        });
    }

    // Seed the kickoff BEFORE the launch reads it (see the header).
    let kickoff_written = ensure_kickoff(&hub, key)?;

    let rx = register(app, id);
    app.emit(
        "bsc://fleet-director",
        serde_json::json!({
            "id": id,
            "projectKey": key,
            "paneId": pane_id,
            // The absolute hub path, resolved here (#905) so the launch never depends on the
            // async-loaded `bscBaseDir` mirror — an empty one drops the session at the user root.
            "hubPath": hub.to_string_lossy(),
        }),
    )
    .map_err(|e| format!("cannot reach the frontend: {e}"))?;

    let ack = rx.recv_timeout(ACK_TIMEOUT).map_err(|_| {
        unregister(app, id);
        format!(
            "the frontend did not create the director within {}ms — is a window open, or was it \
             mid-reload? (the app IS running; this is not a 'no app' timeout)",
            ACK_TIMEOUT.as_millis()
        )
    })?;
    unregister(app, id);

    if let Some(e) = ack.error {
        return Err(e);
    }
    if !ack.created {
        // The kickoff is already on disk at this point, so a false success would leave a project
        // looking seeded with no session behind it.
        return Err(format!(
            "fleet director new: the app could not create a director for '{key}'. \
             `bsc fleet directors` shows the current state."
        ));
    }

    Ok(bsc_fleet::DirectorNewResult {
        project_key: key.to_string(),
        pane_id,
        outcome: bsc_fleet::DirectorOutcome::Created,
        kickoff_written,
    })
}

/// Write the discovery kickoff if the hub has none. Returns whether it wrote one.
///
/// Deliberately NOT idempotent-by-overwrite: an existing kickoff (a planner's, or one from an earlier
/// create) is left exactly as it is. The one thing this must never do is replace a real briefing with
/// a generated pointer list.
fn ensure_kickoff(hub: &std::path::Path, project_key: &str) -> Result<bool, String> {
    let path = hub.join(KICKOFF_RELPATH);
    if path.exists() {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("fleet director new: creating {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, bsc_fleet::discovery_kickoff(project_key))
        .map_err(|e| format!("fleet director new: writing {}: {e}", path.display()))?;
    Ok(true)
}

fn register(app: &tauri::AppHandle, id: &str) -> Receiver<DirectorAck> {
    let (tx, rx) = channel();
    if let Some(state) = app.try_state::<DirectorPending>() {
        if let Ok(mut m) = state.0.lock() {
            m.insert(id.to_string(), tx);
        }
    }
    rx
}

fn unregister(app: &tauri::AppHandle, id: &str) {
    if let Some(state) = app.try_state::<DirectorPending>() {
        if let Ok(mut m) = state.0.lock() {
            m.remove(id);
        }
    }
}

/// The frontend's ack — delivers into the waiter registered by [`apply`].
#[tauri::command]
pub(crate) fn fleet_director_ack(ack: DirectorAck, state: tauri::State<'_, DirectorPending>) {
    let tx = state.0.lock().ok().and_then(|mut m| m.remove(&ack.id));
    match tx {
        Some(tx) => {
            let _ = tx.send(ack);
        }
        None => log::debug!("fleet director: ack for {} had no waiter (timed out?)", ack.id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("bsc-director-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// The seeding half: an empty hub gets the discovery kickoff, and it is the real one (not a stub).
    #[test]
    fn an_empty_hub_is_seeded_with_the_discovery_kickoff() {
        let hub = tmpdir("seed");
        assert!(ensure_kickoff(&hub, "studio-code").unwrap(), "it wrote one");

        let text = std::fs::read_to_string(hub.join(KICKOFF_RELPATH)).unwrap();
        assert_eq!(text, bsc_fleet::discovery_kickoff("studio-code"));
        assert!(text.contains("bsc plan requirement get"), "the requirement is cited first");
        let _ = std::fs::remove_dir_all(&hub);
    }

    /// It creates `prompts/` on the way — a project whose hub exists but was never planned has no
    /// such dir, and that is the most likely hub for an architect-created director.
    #[test]
    fn it_creates_the_prompts_dir_when_the_hub_has_none() {
        let hub = tmpdir("mkdir");
        assert!(!hub.join("prompts").exists());
        ensure_kickoff(&hub, "k").unwrap();
        assert!(hub.join(KICKOFF_RELPATH).exists());
        let _ = std::fs::remove_dir_all(&hub);
    }

    /// The rule that matters most: a planner-authored kickoff is never replaced by the generated one.
    /// Overwriting would silently downgrade a real briefing to a pointer list.
    #[test]
    fn an_existing_kickoff_is_left_exactly_as_it_was() {
        let hub = tmpdir("keep");
        std::fs::create_dir_all(hub.join("prompts")).unwrap();
        let planner_text = "# Director\n\nThe planner wrote this, and it is richer.\n";
        std::fs::write(hub.join(KICKOFF_RELPATH), planner_text).unwrap();

        assert!(!ensure_kickoff(&hub, "k").unwrap(), "it reports that it wrote nothing");
        assert_eq!(
            std::fs::read_to_string(hub.join(KICKOFF_RELPATH)).unwrap(),
            planner_text,
            "byte-for-byte untouched"
        );
        let _ = std::fs::remove_dir_all(&hub);
    }

    /// Seeding twice keeps the FIRST one — the second create finds a kickoff and leaves it, which is
    /// the same rule as the planner case and is what makes repeat creates safe.
    #[test]
    fn seeding_is_write_once() {
        let hub = tmpdir("once");
        assert!(ensure_kickoff(&hub, "k").unwrap());
        assert!(!ensure_kickoff(&hub, "k").unwrap());
        let _ = std::fs::remove_dir_all(&hub);
    }

    #[test]
    fn an_ack_reaches_only_its_own_waiter() {
        let pending = DirectorPending::default();
        let (tx_a, rx_a) = channel::<DirectorAck>();
        let (tx_b, rx_b) = channel::<DirectorAck>();
        {
            let mut m = pending.0.lock().unwrap();
            m.insert("a".into(), tx_a);
            m.insert("b".into(), tx_b);
        }
        let ack = DirectorAck { id: "b".into(), error: None, created: true };
        let tx = pending.0.lock().unwrap().remove(&ack.id).unwrap();
        tx.send(ack).unwrap();

        assert!(rx_b.try_recv().is_ok());
        assert!(rx_a.try_recv().is_err());
        assert!(pending.0.lock().unwrap().contains_key("a"));
    }

    /// An ack that says nothing was created must not read as success — the kickoff is already on disk
    /// by then, so a project would look seeded with no session behind it.
    #[test]
    fn an_ack_defaults_to_not_created_rather_than_to_success() {
        let ack: DirectorAck = serde_json::from_str("{\"id\":\"x\"}").unwrap();
        assert!(!ack.created, "absent `created` is FALSE, so a malformed ack fails loudly");
    }
}
