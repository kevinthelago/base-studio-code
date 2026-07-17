// Tunnel Tauri commands — the metadata-push + status + relay-control surface.
//
// These `#[tauri::command]` fns are the frontend's only entry points into `TunnelState`
// (push pane/session/plan/fleet/automation/MCP state, start/stop/unpair the relay, probe
// `/health`). They mutate/read the bus that lives in the sibling `state` module and spawn
// the dial-out client that lives in `transport`. `app/run.rs` references each by its
// `tunnel::tunnel_*` path (re-exported from `mod.rs`), so the set + signatures are frozen.

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::watch;

use super::protocol::*;
use super::state::{fnv1a32_hex, session_state_msg, TunnelState};
use super::transport;

// ── Tauri commands (metadata push + status) ─────────────────────────────────────

/// Current tunnel status for the settings card (incl. the QR's `hostPubKey`).
#[tauri::command]
pub fn tunnel_status(state: State<'_, TunnelState>) -> TunnelStatus {
    let inner = state.inner.lock().unwrap();
    state.status_locked(&inner)
}

/// Push the current pane list from the frontend store. Stored for replay to new
/// clients and broadcast to connected ones.
#[tauri::command]
pub fn tunnel_set_panes(panes: Vec<PaneDescriptor>, state: State<'_, TunnelState>) {
    log::debug!("tunnel: pane list updated ({} pane(s))", panes.len());
    state.set_and_broadcast(ServerMsg::PaneList { panes: panes.clone() }, |inner| {
        inner.panes = panes;
    });
}

/// Push session-state snapshots from the frontend store. Broadcasts a `session_state`
/// per entry, plus a `user_request` whenever a pane newly enters `awaiting_input` with
/// a prompt.
#[tauri::command]
pub fn tunnel_set_sessions(sessions: Vec<SessionMeta>, state: State<'_, TunnelState>) {
    // (pane_id, prompt, session_name) for each pane that JUST entered awaiting_input — the
    // `!was_awaiting` guard debounces it to exactly one event per transition, so repeated
    // state syncs while a pane stays awaiting don't re-fire the push (#846 deliverable 4).
    let mut newly_awaiting: Vec<(String, String, String)> = Vec::new();
    {
        let mut inner = state.inner.lock().unwrap();
        for s in &sessions {
            let was_awaiting = inner
                .sessions
                .get(&s.pane_id)
                .map(|p| p.status == "awaiting_input")
                .unwrap_or(false);
            if s.status == "awaiting_input" && !was_awaiting {
                if let Some(prompt) = &s.prompt {
                    // Banner title: the pane's display name, falling back to its current
                    // task, then the pane id — so the notification is always identifiable.
                    let name = inner
                        .panes
                        .iter()
                        .find(|p| p.id == s.pane_id)
                        .map(|p| p.name.clone())
                        .filter(|n| !n.trim().is_empty())
                        .or_else(|| (!s.current_task.trim().is_empty()).then(|| s.current_task.clone()))
                        .unwrap_or_else(|| s.pane_id.clone());
                    newly_awaiting.push((s.pane_id.clone(), prompt.clone(), name));
                }
            }
            inner.sessions.insert(s.pane_id.clone(), s.clone());
        }
    }
    for s in &sessions {
        let _ = state.event_tx.send(session_state_msg(s));
    }
    log::debug!(
        "tunnel: {} session state(s) pushed, {} newly awaiting input",
        sessions.len(),
        newly_awaiting.len()
    );
    for (pane_id, prompt, session_name) in newly_awaiting {
        // Notify a connected (foregrounded) phone over the relay…
        let _ = state
            .event_tx
            .send(ServerMsg::UserRequest { pane_id: pane_id.clone(), prompt: prompt.clone() });
        // …and push via FCM so a backgrounded/quit phone (off the relay) still gets it (#846).
        state.enqueue_user_request_push(&pane_id, &prompt, &session_name);
    }
}

// ── Planner sync (#588) — Tauri commands ────────────────────────────────────

/// Push the current plan manifest + files for a project from the frontend.
/// Computes the content manifest (relpath → FNV-1a hex hash), stores both for
/// mobile to request, and broadcasts `plan_sync_manifest` so any connected mobile
/// client receives the update immediately.
#[tauri::command]
pub fn tunnel_set_plan_state(
    project_id: String,
    files: Vec<PlanFile>,
    state: State<'_, TunnelState>,
) {
    let manifest: HashMap<String, String> = files
        .iter()
        .map(|f| (f.relpath.clone(), fnv1a32_hex(&f.content)))
        .collect();
    let broadcast_manifest = manifest.clone();
    {
        let mut inner = state.inner.lock().unwrap();
        inner.plan_manifests.insert(project_id.clone(), manifest);
        inner.plan_files.insert(project_id.clone(), files);
    }
    log::debug!("tunnel: plan state pushed for project {project_id}");
    let _ = state.event_tx.send(ServerMsg::PlanSyncManifest {
        project_id,
        files: broadcast_manifest,
    });
}

/// Acknowledge a plan push (called by the frontend after applying the received files
/// to the hub directory). Broadcasts `plan_sync_ack` back to the mobile client.
#[tauri::command]
pub fn tunnel_ack_plan_push(
    project_id: String,
    applied: bool,
    state: State<'_, TunnelState>,
) {
    log::debug!("tunnel: plan push ack for {project_id} (applied={applied})");
    let _ = state.event_tx.send(ServerMsg::PlanSyncAck { project_id, applied });
}

/// One pushed plan file — the `{ relpath, content }` shape the `tunnel://plan-sync-push` event carries
/// (mirrors the wire `PlanFile`). Deserialized straight from the frontend listener's payload.
#[derive(serde::Deserialize)]
pub struct PushedPlanFile {
    pub relpath: String,
    pub content: String,
}

/// Apply plan files pushed from mobile (`tunnel://plan-sync-push`, #3248) to the project's hub dir
/// (`projects/<key>/`). SECURITY: each `relpath` must be a plain relative path (no `..`, no absolute,
/// no drive/root — [`is_safe_relpath`]) so a mobile push can never write outside the hub; the FIRST
/// unsafe path aborts the whole apply (no partial write is acked as success). The frontend calls
/// [`tunnel_ack_plan_push`] with the returned outcome so mobile learns whether it landed.
#[tauri::command]
pub fn apply_pushed_plan_files(project_id: String, files: Vec<PushedPlanFile>) -> Result<u32, String> {
    if project_id.trim().is_empty() {
        return Err("apply_pushed_plan_files: empty project_id".to_string());
    }
    let written = apply_pushed_plan_files_to(&crate::platform::paths::project_dir(&project_id), &files)?;
    log::info!("tunnel: applied {written} pushed plan file(s) for {project_id}");
    Ok(written)
}

/// Testable core of [`apply_pushed_plan_files`]: write each file under `dir`, refusing any unsafe
/// relpath (the FIRST one aborts, so a bad path in a batch never leaves a partial write acked as
/// success). Split out so the path-traversal guard is unit-tested against a temp dir (never the real
/// hub).
pub(crate) fn apply_pushed_plan_files_to(
    dir: &std::path::Path,
    files: &[PushedPlanFile],
) -> Result<u32, String> {
    let mut written = 0u32;
    for f in files {
        let rel = std::path::Path::new(&f.relpath);
        if !crate::platform::fsx::is_safe_relpath(rel) {
            return Err(format!("apply_pushed_plan_files: unsafe relpath {:?} — refused", f.relpath));
        }
        let target = dir.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("apply_pushed_plan_files: mkdir {parent:?}: {e}"))?;
        }
        std::fs::write(&target, &f.content)
            .map_err(|e| format!("apply_pushed_plan_files: write {:?}: {e}", f.relpath))?;
        written += 1;
    }
    Ok(written)
}

// ── Live planning session (PT1 / #934 / #986) — Tauri commands ──────────────
//
// Distinct from `tunnel_set_plan_state` (the async file-sync path, untouched): these project
// the LIVE planner UI state. State + status are stored per projectId and replayed on connect
// (like tunnel_set_panes); events are fire-and-forget.

/// Push the full live planner snapshot; stored per projectId for replay + broadcast.
#[tauri::command]
pub fn tunnel_emit_plan_state(
    project_id: String,
    current_stage: String,
    confirmed_sections: Vec<String>,
    files: Vec<PlanFile>,
    messages: Vec<PlanMessage>,
    pipeline_runs: Vec<PlanPipelineRun>,
    state: State<'_, TunnelState>,
) {
    let frame = ServerMsg::PlanState {
        project_id: project_id.clone(),
        current_stage,
        confirmed_sections,
        files,
        messages,
        pipeline_runs,
    };
    state.inner.lock().unwrap().plan_states.insert(project_id, frame.clone());
    let _ = state.event_tx.send(frame);
}

/// Push a transient planning event. Fire-and-forget — never stored or replayed.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn tunnel_emit_plan_event(
    project_id: String,
    kind: String,
    at: u64,
    section: Option<String>,
    stage: Option<String>,
    message: Option<PlanMessage>,
    run: Option<PlanPipelineRun>,
    state: State<'_, TunnelState>,
) {
    let _ = state.event_tx.send(ServerMsg::PlanEvent { project_id, kind, at, section, stage, message, run });
}

/// Push the cheap header update (active stage + status); stored per projectId for replay + broadcast.
#[tauri::command]
pub fn tunnel_emit_plan_status(
    project_id: String,
    current_stage: String,
    status: String,
    state: State<'_, TunnelState>,
) {
    let frame = ServerMsg::PlanStatus { project_id: project_id.clone(), current_stage, status };
    state.inner.lock().unwrap().plan_statuses.insert(project_id, frame.clone());
    let _ = state.event_tx.send(frame);
}

// ── Fleet / coordination (F2) — Tauri commands ──────────────────────────────

/// Push the full fleet roster from the frontend store. Stored for replay to new
/// clients and broadcast to connected ones.
#[tauri::command]
pub fn tunnel_set_fleet_state(sessions: Vec<FleetSession>, state: State<'_, TunnelState>) {
    log::debug!("tunnel: fleet state updated ({} session(s))", sessions.len());
    state.set_and_broadcast(ServerMsg::FleetRoster { sessions: sessions.clone() }, |inner| {
        inner.fleet_sessions = sessions;
    });
}

/// Push one coordination event to connected mobile clients. When the event kind is
/// "waiting" or "asking" (an agent paused for user input), an FCM push is also queued
/// (F4) so the user is notified even when the mobile app is backgrounded.
#[tauri::command]
pub fn tunnel_emit_coord_event(
    kind: String,
    session: Option<String>,
    ref_key: Option<String>,
    at: u64,
    state: State<'_, TunnelState>,
) {
    log::debug!("tunnel: coord event kind={kind} session={session:?}");
    // F4: push FCM when an agent enters a state that requires user attention.
    if (kind == "waiting" || kind == "asking") && !state.fcm_tokens.lock().unwrap().is_empty() {
        if let Some(ref s) = session {
            state.enqueue_coord_wait_push(s, &kind);
        }
    }
    // #1102: the warden quarantined a worker (possible injection/hijack) — high-signal push so
    // the user is alerted even when the mobile app is backgrounded. `ref_key` carries the
    // deterministic trip summary (out-of-lane file / denied command), never untrusted prose.
    if kind == "quarantine" && !state.fcm_tokens.lock().unwrap().is_empty() {
        if let Some(ref s) = session {
            state.enqueue_warden_push(s, ref_key.as_deref().unwrap_or(""));
        }
    }
    let _ = state.event_tx.send(ServerMsg::CoordEvent { kind, session, ref_key, at });
}

// ── Automations (A2) — Tauri commands ───────────────────────────────────────

/// Push the full automation list from the frontend store. Stored for replay to new
/// clients and broadcast to connected ones.
#[tauri::command]
pub fn tunnel_set_automations(automations: Vec<AutomationFrame>, state: State<'_, TunnelState>) {
    log::debug!("tunnel: automation list updated ({} automation(s))", automations.len());
    state.set_and_broadcast(ServerMsg::AutomationList { automations: automations.clone() }, |inner| {
        inner.automations = automations;
    });
}

/// Push a non-critical automation-ran notification. No FCM push — skipped/ok runs are
/// informational and don't require user attention.
#[tauri::command]
pub fn tunnel_automation_ran(
    id: String,
    at: u64,
    status: String,
    note: String,
    state: State<'_, TunnelState>,
) {
    log::debug!("tunnel: automation {id} ran (status={status})");
    let _ = state.event_tx.send(ServerMsg::AutomationRan { id, at, status, note });
}

/// Push a non-transient automation failure. Broadcasts `automation_failed` to
/// connected clients and queues an FCM push (A4) so a backgrounded phone is notified.
#[tauri::command]
pub fn tunnel_automation_failed(
    id: String,
    at: u64,
    error: String,
    name: String,
    state: State<'_, TunnelState>,
) {
    log::warn!("tunnel: automation {id} ({name}) failed: {error}");
    state.enqueue_autom_failed_push(&name, &error);
    let _ = state.event_tx.send(ServerMsg::AutomationFailed { id, at, error });
}

// ── MCP extensions (M2) — Tauri commands ────────────────────────────────────

/// Push the full MCP extension list from the frontend store. Stored for replay to new
/// clients and broadcast to connected ones. Read-only on mobile.
#[tauri::command]
pub fn tunnel_set_mcp_state(extensions: Vec<McpExtFrame>, state: State<'_, TunnelState>) {
    log::debug!("tunnel: MCP list updated ({} extension(s))", extensions.len());
    state.set_and_broadcast(ServerMsg::McpList { extensions: extensions.clone() }, |inner| {
        inner.mcp_extensions = extensions;
    });
}

// ── Hook telemetry (M3 / #937) — Tauri commands ──────────────────────────────

/// Push the aggregated hook-fire telemetry summary from the frontend (parsed + aggregated
/// from `hooks.log` by `aggregateHookTelemetry`). Stored for replay to new clients and
/// broadcast to connected ones. Read-only on mobile — there is no inbound counterpart.
#[tauri::command]
pub fn tunnel_set_hook_telemetry(telemetry: HookTelemetryFrame, state: State<'_, TunnelState>) {
    log::debug!(
        "tunnel: hook telemetry updated ({} fire(s), {} hook(s))",
        telemetry.total,
        telemetry.per_hook.len()
    );
    state.set_and_broadcast(ServerMsg::HookTelemetry { telemetry: telemetry.clone() }, |inner| {
        inner.hook_telemetry = Some(telemetry);
    });
}

// ── Generic store projections (#2497) — Tauri commands ──────────────────────

/// Push one store domain's projection from the frontend — the SINGLE entry point for the
/// generic `store_state` frame (#2497). `domain` names the store (see
/// `protocol::store_domains` for the registered vocabulary — the frame itself is
/// domain-agnostic), `rev` is the caller's monotonically increasing revision for that
/// domain, and `json` is the opaque serialized projection. Stored per domain for replay to
/// freshly-paired clients and broadcast to connected ones.
///
/// The bespoke `tunnel_set_fleet_state` / `tunnel_set_automations` / `tunnel_set_mcp_state`
/// / `tunnel_set_hook_telemetry` pushes remain wire-compatible alongside this; retiring
/// them onto store_state domains is a follow-up once mobile consumes the new frames.
#[tauri::command]
pub fn tunnel_set_store_state(domain: String, rev: u64, json: String, state: State<'_, TunnelState>) {
    log::debug!("tunnel: store_state[{domain}] rev {rev} pushed ({} bytes)", json.len());
    let frame = ServerMsg::StoreState { domain: domain.clone(), rev, json };
    state.set_and_broadcast(frame.clone(), |inner| {
        inner.store_states.insert(domain, frame);
    });
}

/// Queue an FCM push for one alert from the #2498 taxonomy (agent-paused / prompt-waiting /
/// worker-question / fleet-failed / fleet-landed / gate-ready / planner-waiting). Deliberately
/// THIN and wire-free: the alert INBOX rides the `alerts` store_state domain (replayed on
/// connect, so a foregrounded phone reads it there); this command only reaches a
/// backgrounded/quit phone out-of-band via FCM. No-op without a paired FCM token. `at` is
/// accepted for parity with the frontend event (logged, not forwarded — FCM stamps delivery).
#[tauri::command]
pub fn tunnel_emit_alert(
    kind: String,
    title: String,
    body: String,
    pane_id: Option<String>,
    at: u64,
    state: State<'_, TunnelState>,
) {
    log::debug!("tunnel: alert kind={kind} pane={pane_id:?} at={at}");
    state.enqueue_alert_push(&kind, &title, &body, pane_id.as_deref().unwrap_or(""));
}

// ── Relay diagnostics (T3b) ──────────────────────────────────────────────────

/// Diagnostic report from `tunnel_check_relay`. All error conditions are captured in the
/// `error` field — the command always succeeds at the Tauri level so the Settings card can
/// render a structured result rather than catching an error.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayDiag {
    /// True when the relay's `/health` probe returned HTTP 200.
    pub reachable: bool,
    /// `service` field from the relay's `/health` JSON body.
    pub service: Option<String>,
    /// `version` field from the relay's `/health` JSON body.
    pub version: Option<String>,
    /// Round-trip latency for the `/health` probe (milliseconds).
    pub latency_ms: u64,
    /// Human-readable error when the probe fails.
    pub error: Option<String>,
    /// Whether the desktop's own relay WebSocket (host leg) is currently open.
    pub host_connected: bool,
    /// Number of paired mobile clients (guest legs) connected right now.
    pub client_count: usize,
}

/// Probe the relay's `/health` endpoint and return a structured diagnostic.
/// Also includes the desktop's own connection state (host + client legs) from TunnelState,
/// giving the Settings card a complete per-leg picture in a single call (T3b).
///
/// Always returns `Ok(RelayDiag)` — network failures are captured in `RelayDiag.error`
/// so the frontend never needs to handle a command error for this probe.
#[tauri::command]
pub async fn tunnel_check_relay(
    relay_url: String,
    app: AppHandle,
) -> Result<RelayDiag, String> {
    // Extract state synchronously before any await point — State<'_> cannot cross await
    // boundaries in Tauri v2 async commands (the borrowed lifetime can't be 'static).
    let (host_connected, client_count) = app
        .try_state::<TunnelState>()
        .map(|s| {
            let inner = s.inner.lock().unwrap();
            (inner.running, inner.client_count)
        })
        .unwrap_or((false, 0));

    let base = relay_url.trim().trim_end_matches('/').to_string();
    let health_url = format!("{base}/health");

    let t0 = std::time::Instant::now();
    let result = crate::platform::http::client()
        .get(&health_url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;
    let latency_ms = t0.elapsed().as_millis() as u64;

    Ok(match result {
        Err(e) => RelayDiag {
            reachable: false,
            service: None,
            version: None,
            latency_ms,
            error: Some(if e.is_timeout() {
                "probe timed out after 5s".into()
            } else {
                format!("probe failed: {e}")
            }),
            host_connected,
            client_count,
        },
        Ok(resp) => {
            let status = resp.status();
            if !status.is_success() {
                return Ok(RelayDiag {
                    reachable: false,
                    service: None,
                    version: None,
                    latency_ms,
                    error: Some(format!("relay returned {status}")),
                    host_connected,
                    client_count,
                });
            }
            let (service, version) = resp
                .json::<serde_json::Value>()
                .await
                .map(|v| {
                    (
                        v["service"].as_str().map(str::to_string),
                        v["version"].as_str().map(str::to_string),
                    )
                })
                .unwrap_or_default();
            RelayDiag {
                reachable: true,
                service,
                version,
                latency_ms,
                error: None,
                host_connected,
                client_count,
            }
        }
    })
}

/// Start the relay transport: mint a room id + pairing secret, mark running, and spawn
/// the dial-out client on its own tokio runtime. Idempotent (returns the current status
/// if already running). The QR (#243) reads `room` + `hostPubKey` + the psk from status.
#[tauri::command]
pub fn tunnel_start(
    app: AppHandle,
    relay_url: String,
    state: State<'_, TunnelState>,
) -> Result<TunnelStatus, String> {
    {
        let inner = state.inner.lock().unwrap();
        if inner.running {
            return Ok(state.status_locked(&inner));
        }
    }
    let relay_url = relay_url.trim().trim_end_matches('/').to_string();
    if relay_url.is_empty() {
        return Err("a relay URL is required".into());
    }
    let status = rotate_and_dial(app, &state, relay_url)?;
    log::info!(
        "tunnel: dialing relay {} (room {})",
        status.relay_url.as_deref().unwrap_or_default(),
        status.room.as_deref().unwrap_or_default()
    );
    Ok(status)
}

/// Mint a fresh room id + pairing secret and (re)dial the relay. Shared by `tunnel_start`
/// (initial dial) and `tunnel_unpair` (rotate-in-place): both generate a new room + psk, reset
/// the pairing to view-only with zero connected clients, install a fresh shutdown channel, and
/// spawn the relay dial-out thread — then return the resulting status.
///
/// The field writes are a superset that stays a no-op for whichever caller didn't already set a
/// given field: `tunnel_start` reaches here only when the tunnel is stopped (so `running` flips
/// false→true and `client_count` is already `0`), and `tunnel_unpair` only when it is running
/// (so `running` stays `true` and `relay_url` is re-set to its own current value).
fn rotate_and_dial(
    app: AppHandle,
    state: &TunnelState,
    relay_url: String,
) -> Result<TunnelStatus, String> {
    let room = transport::generate_room_id();
    let psk = transport::generate_psk();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    {
        let mut inner = state.inner.lock().unwrap();
        inner.running = true;
        inner.relay_url = Some(relay_url.clone());
        inner.room = Some(room.clone());
        inner.psk = psk;
        inner.client_count = 0;
        // Every fresh pairing starts view-only (#B-wan-viewonly): the desktop must
        // explicitly grant input before the phone can drive a pane.
        inner.input_granted = false;
        inner.input_requested = false;
        inner.shutdown_tx = Some(shutdown_tx);
    }

    spawn_relay_thread(app, relay_url, room, state.static_priv.clone(), shutdown_rx)?;

    let inner = state.inner.lock().unwrap();
    Ok(state.status_locked(&inner))
}

/// Spawn the relay dial-out client on its own OS thread with a dedicated multi-thread
/// tokio runtime, so the tunnel never depends on Tauri's runtime having the IO driver
/// enabled and stopping it is a clean watch-signal rather than reaching into Tauri
/// internals. Shared by `tunnel_start` and `tunnel_unpair` (which rotates the room).
fn spawn_relay_thread(
    app: AppHandle,
    relay_url: String,
    room: String,
    static_priv: Vec<u8>,
    shutdown_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    std::thread::Builder::new()
        .name("tunnel-relay".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    log::error!("tunnel: runtime build failed: {e}");
                    return;
                }
            };
            rt.block_on(transport::run(app, relay_url, room, static_priv, shutdown_rx));
        })
        .map(|_| ())
        .map_err(|e| format!("could not spawn tunnel thread: {e}"))
}

/// Stop the relay transport: signal the client task to close and clear the pairing.
#[tauri::command]
pub fn tunnel_stop(state: State<'_, TunnelState>) -> TunnelStatus {
    let mut inner = state.inner.lock().unwrap();
    if let Some(tx) = inner.shutdown_tx.take() {
        let _ = tx.send(true);
    }
    inner.running = false;
    inner.room = None;
    inner.client_count = 0;
    inner.input_granted = false;
    inner.input_requested = false;
    log::info!("tunnel: stopped");
    state.status_locked(&inner)
}

/// Grant or revoke the paired phone's input control (#B-wan-viewonly). A phone is
/// view-only until the desktop calls this with `granted = true`; revoking returns it
/// to view-only. Returns the updated status so the settings card reflects the change.
#[tauri::command]
pub fn tunnel_set_input_granted(
    granted: bool,
    state: State<'_, TunnelState>,
) -> TunnelStatus {
    state.set_input_granted(granted);
    log::info!(
        "tunnel: input {} for paired phone",
        if granted { "granted" } else { "revoked (view-only)" }
    );
    let inner = state.inner.lock().unwrap();
    state.status_locked(&inner)
}

/// Unpair the current device (#B-unpair-revoke). Tears down the live relay session
/// (dropping the paired phone and leaving the old room), rotates to a **fresh room id +
/// pairing secret** — so the old QR can never re-authenticate — and reconnects so a new
/// QR can be scanned. The tunnel stays running and returns to view-only. Errors if the
/// tunnel isn't running. Pairing secrets are therefore short-lived and rotatable: each
/// `tunnel_start` mints one, and `tunnel_unpair` rotates it on demand.
#[tauri::command]
pub fn tunnel_unpair(app: AppHandle, state: State<'_, TunnelState>) -> Result<TunnelStatus, String> {
    let relay_url = {
        let mut inner = state.inner.lock().unwrap();
        if !inner.running {
            return Err("tunnel is not running".into());
        }
        let relay_url = inner
            .relay_url
            .clone()
            .ok_or_else(|| "tunnel has no relay url".to_string())?;
        // Signal the current transport to drop the paired phone and leave the old room.
        if let Some(tx) = inner.shutdown_tx.take() {
            let _ = tx.send(true);
        }
        relay_url
    };

    // Rotate the pairing material so the old QR is dead, then re-dial on the new room.
    let status = rotate_and_dial(app, &state, relay_url)?;
    log::info!(
        "tunnel: unpaired — rotated to room {}, pairing secret reset, view-only",
        status.room.as_deref().unwrap_or_default()
    );
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(relpath: &str, content: &str) -> PushedPlanFile {
        PushedPlanFile { relpath: relpath.to_string(), content: content.to_string() }
    }

    #[test]
    fn apply_pushed_plan_files_writes_safe_paths_and_refuses_traversal() {
        // A temp hub — never the real projects dir (the command wrapper resolves that; the core takes
        // an explicit dir so this is hermetic).
        let dir = std::env::temp_dir().join(format!("bsc-3248-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // Safe relpaths (incl. a nested one) are written under the hub.
        let ok = apply_pushed_plan_files_to(&dir, &[f("goal.md", "g"), f("discovery/stack.md", "s")]);
        assert_eq!(ok.unwrap(), 2);
        assert_eq!(std::fs::read_to_string(dir.join("goal.md")).unwrap(), "g");
        assert_eq!(std::fs::read_to_string(dir.join("discovery/stack.md")).unwrap(), "s");

        // A `..` traversal is refused, and nothing escapes the hub.
        assert!(apply_pushed_plan_files_to(&dir, &[f("../escape.md", "x")]).is_err());
        assert!(!dir.parent().unwrap().join("escape.md").exists());
        // An absolute path is refused too.
        assert!(apply_pushed_plan_files_to(&dir, &[f("/tmp/evil.md", "x")]).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
