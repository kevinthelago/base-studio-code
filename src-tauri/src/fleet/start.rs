//! `bsc fleet start` — launch a project's WHOLE fleet from a shell
//! (`headless-fleet-launch-a-director-cannot-start-its-own-fleet`).
//!
//! ```text
//! bsc fleet start <key> → request file → watcher → resolve, read plan.db, build the worktrees
//!                       → emit `bsc://fleet-start` → the frontend calls fleetStartProject
//!                       → invokes `fleet_start_ack` → we reply
//! ```
//!
//! ## What Rust decides, and what the frontend does
//! The same split as [`crate::fleet::director_new`] and [`crate::fleet::wake`], for the same reason:
//! everything checkable is a filesystem or `PtyState` fact and is settled HERE, but **creating a pane
//! is zustand state Rust cannot touch**, so only the launch itself is emitted.
//!
//! That split is also why this slice's original acceptance — "launch with no frontend involved" — was
//! unachievable as written. `fleetStartProject` builds the console tab plus some twenty pane-keyed
//! maps; a pane IS frontend state. What the epic actually needs is a launch with no PLANNER UI, and
//! deleting the planner screen leaves the store and the console pane system intact.
//!
//! ## Why the worktrees are created here, before the emit
//! FAIL CLOSED (#551/#359): if any worker's worktree cannot be created, NO session starts. Creating
//! them in Rust — before the frontend is asked to place a single pane — is what makes that possible.
//! Doing it after the emit would mean panes already exist when the failure is discovered, and the
//! caller would be told the launch failed while a half-fleet ran on screen.
//!
//! ## Why plan.db is the fleet source
//! #1805 made plan.db the SOLE fleet store. Reading it here means a `bsc fleet start` and a UI launch
//! read the same rows, so the two cannot disagree about what the fleet is.

use serde::Deserialize;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Longer than the director's 8s: this launch can create many worktrees and place many panes, and a
/// timeout here would report failure for a fleet that is in fact coming up.
const ACK_TIMEOUT: Duration = Duration::from_millis(30_000);

/// What the frontend sends back once it has launched (or declined to).
#[derive(Debug, Clone, Deserialize)]
pub struct StartAck {
    pub id: String,
    #[serde(default)]
    pub error: Option<String>,
    /// Whether the launch actually happened.
    #[serde(default)]
    pub launched: bool,
}

/// In-flight fleet starts, keyed by request id.
pub type StartPending = crate::app::ack::AckPending<StartAck>;

/// One stream as the launch needs it: **the plan's whole row**, plus the worktree just created for it.
///
/// The row is passed through VERBATIM rather than reduced to id/repo. A stream carries its name,
/// owns, issues, dependsOn, flow, profile, persona, model, commands and kickoff — that is the plan,
/// and synthesizing a thinner version here would hand the CLI launch a poorer fleet than the UI
/// launch gets while looking like it had launched the same one.
#[derive(Debug, Clone)]
struct LaunchStream {
    id: String,
    /// The plan.db row with `worktree` added.
    row: serde_json::Value,
}

pub fn apply(
    app: &tauri::AppHandle,
    id: &str,
    req: &bsc_fleet::StartRequest,
) -> Result<bsc_fleet::StartResult, String> {
    let key = req.project_key.trim();
    if key.is_empty() {
        return Err("fleet start: no project key".into());
    }

    // THE PROJECT MUST ALREADY EXIST — same two-places rule as `director new`: a durable row (hub not
    // materialized yet) or an on-disk hub (a project predating the store). Requiring both would refuse
    // a freshly created draft.
    let hub = bsc_project::project_dir(key)
        .ok_or("fleet start: no home dir ($HOME / $USERPROFILE unset)")?;
    let has_hub = hub.exists();
    let has_row = bsc_project::store::open()
        .ok()
        .and_then(|c| bsc_project::store::get(&c, key))
        .is_some();
    if !has_hub && !has_row {
        return Err(format!(
            "fleet start: no project '{key}'. This LAUNCHES an existing project's fleet — \
             `bsc project list` shows the keys."
        ));
    }

    // The fleet comes from plan.db, the sole fleet store (#1805).
    let plan_db = crate::platform::paths::plan_db_path(key);
    let store = plandb::Store::open(&plan_db)
        .map_err(|e| format!("fleet start: cannot open the plan store {}: {e}", plan_db.display()))?;
    let stream_rows = store
        .fleet_stream_list()
        .map_err(|e| format!("fleet start: cannot read the fleet: {e}"))?;
    let meta = store.fleet_get().ok().flatten();
    // A director is on unless the plan explicitly disables it — the same default the planner uses.
    let director = meta
        .as_ref()
        .and_then(|m| m.get("director"))
        .and_then(|d| d.get("enabled"))
        .and_then(|e| e.as_bool())
        .unwrap_or(true);

    if stream_rows.is_empty() && !director {
        return Err(format!(
            "fleet start: '{key}' has no fleet to launch — no streams and no director. \
             `bsc plan fleet` shows what the plan holds."
        ));
    }

    // ALREADY RUNNING: relaunching over live sessions would put two workers on one worktree, fighting
    // over the same branch. Measured from `PtyState`, the same authority `bsc fleet list` reports from.
    let pane_ids: Vec<String> = std::iter::once(bsc_fleet::director_pane_id(key))
        .chain(stream_rows.iter().filter_map(|s| {
            s.get("id").and_then(|v| v.as_str()).map(|sid| format!("{key}:{sid}"))
        }))
        .collect();
    let live: Vec<String> = app
        .try_state::<crate::console::pty::PtyState>()
        .map(|st| crate::console::pty::pane_liveness(pane_ids.clone(), &st))
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.live)
        .map(|p| p.pane_id)
        .collect();
    if !live.is_empty() && !req.force {
        return Ok(bsc_fleet::StartResult {
            project_key: key.to_string(),
            outcome: bsc_fleet::StartOutcome::AlreadyRunning,
            director,
            streams: live,
            skipped_no_repo: Vec::new(),
        });
    }

    // Materialize the hub BEFORE any cwd resolves to it: planning may have run in an ephemeral
    // workspace, and a director dropped into a missing directory is the failure this prevents.
    // Idempotent — an already-materialized hub is a no-op.
    crate::project::hub::materialize_hub(key.to_string())
        .map_err(|e| format!("fleet start: could not materialize the project hub: {e}"))?;

    // Build every worker's worktree. FAIL CLOSED — the first failure aborts before a single pane is
    // placed, so a caller is never told "launched" while some workers have nowhere to run.
    let mut launch: Vec<LaunchStream> = Vec::new();
    let mut skipped_no_repo: Vec<String> = Vec::new();
    for row in &stream_rows {
        let sid = row.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if sid.is_empty() {
            continue;
        }
        let repo = row.get("repo").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if repo.is_empty() {
            // A stream with no repo cannot be worktree'd. Reported, never silently dropped (#2611).
            skipped_no_repo.push(sid);
            continue;
        }
        let worktree =
            crate::fleet::worktree::ensure_worktree(key.to_string(), repo.clone(), sid.clone(), None)
                .map_err(|e| {
                    format!(
                        "fleet start: no session was started — could not create the worktree for \
                         stream '{sid}' in {repo}: {e}"
                    )
                })?;
        let mut row = row.clone();
        if let Some(obj) = row.as_object_mut() {
            obj.insert("worktree".into(), serde_json::Value::String(worktree));
        }
        launch.push(LaunchStream { id: sid, row });
    }

    if launch.is_empty() && !director {
        return Err(format!(
            "fleet start: nothing to launch for '{key}' — {} stream(s) name no repo ({}).",
            skipped_no_repo.len(),
            skipped_no_repo.join(", ")
        ));
    }

    // The director's standing protocol at the hub, so it comes up knowing how to coordinate.
    if director {
        let _ = crate::fleet::director::ensure_director_protocol(key.to_string());
    }

    let rx = crate::app::ack::register::<StartAck>(app, id);
    app.emit(
        "bsc://fleet-start",
        serde_json::json!({
            "id": id,
            "projectKey": key,
            "director": director,
            "streams": launch.iter().map(|s| s.row.clone()).collect::<Vec<_>>(),
            // Absolute paths resolved HERE (#905) so the launch never depends on the async-loaded
            // `bscBaseDir` mirror — an empty one drops every session at the user's home dir.
            "hubPath": hub.to_string_lossy(),
        }),
    )
    .map_err(|e| format!("cannot reach the frontend: {e}"))?;

    let ack = rx.recv_timeout(ACK_TIMEOUT).map_err(|_| {
        crate::app::ack::unregister::<StartAck>(app, id);
        format!(
            "the frontend did not launch the fleet within {}ms — is a window open, or was it \
             mid-reload? (the app IS running; this is not a 'no app' timeout)",
            ACK_TIMEOUT.as_millis()
        )
    })?;
    crate::app::ack::unregister::<StartAck>(app, id);

    if let Some(e) = ack.error {
        return Err(e);
    }
    if !ack.launched {
        return Err(format!(
            "fleet start: the app could not launch the fleet for '{key}'. \
             `bsc fleet list` shows the current state."
        ));
    }

    Ok(bsc_fleet::StartResult {
        project_key: key.to_string(),
        outcome: bsc_fleet::StartOutcome::Launched,
        director,
        streams: launch.into_iter().map(|s| s.id).collect(),
        skipped_no_repo,
    })
}

/// The frontend's reply, routed back to the waiting request.
#[tauri::command]
pub(crate) fn fleet_start_ack(ack: StartAck, state: tauri::State<'_, StartPending>) {
    let tx = state.take(&ack.id);
    if let Some(tx) = tx {
        let _ = tx.send(ack);
    }
}
