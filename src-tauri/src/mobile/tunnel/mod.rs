// Mobile tunnel — desktop bus + protocol + end-to-end crypto (#242a).
//
// The desktop mirrors its terminal panes to mobile-studio-code over a zero-knowledge
// Cloudflare relay (#241): both peers dial out, the relay forwards only opaque
// `{ room, ciphertext }`, and the payload is an end-to-end **Noise IK** session so the
// relay can never read terminal data. This module is the transport-FREE core:
//
//   * the wire protocol (serde, conforming to mobile's `src/lib/types.ts`),
//   * `TunnelState` — the in-process bus that tees PTY output + holds pane metadata
//     and the desktop's static Noise keypair, plus the metadata-push Tauri commands,
//   * `noise` — the Noise IK handshake/transport helper (the desktop is the responder;
//     mobile is the initiator and learns the desktop's static key from the QR).
//
// The relay dial-out transport that drains this bus through a Noise session lands in
// #242b; `tunnel_write_pty` / `tunnel_resize_pty` (the inbound PTY bridge) arrive with
// it. See docs/tunnel-protocol.md.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::{broadcast, mpsc, watch};

use crate::fcm::{self, FcmSender, SendOutcome};

mod protocol;
pub mod noise;
mod transport;

pub(crate) use protocol::*;

// ── Tunnel state (the in-process bus) ───────────────────────────────────────────

struct Inner {
    running: bool,
    relay_url: Option<String>,
    room: Option<String>,
    /// Pre-shared pairing secret (the `token` the mobile sends in its `auth` frame,
    /// carried in the QR). Minted on `tunnel_start`; validated inside the Noise session.
    psk: String,
    panes: Vec<PaneDescriptor>,
    sessions: HashMap<String, SessionMeta>,
    /// Latest known PTY grid size per pane (cols, rows). Broadcast to mobile so it can
    /// render at the desktop's width; replayed to freshly-paired clients.
    sizes: HashMap<String, (u16, u16)>,
    client_count: usize,
    /// View-only gate (#B-wan-viewonly): `false` until the desktop grants input. While
    /// `false`, PTY-mutating mobile frames (keystrokes, resize) are dropped. Reset to
    /// `false` on every `tunnel_start`/`tunnel_stop` so each pairing starts view-only.
    input_granted: bool,
    /// Whether we've already notified the desktop that a view-only phone tried to send
    /// input, so the per-keystroke drop doesn't spam the frontend with prompts. Cleared
    /// when input is (re)granted/revoked or a new session begins.
    input_requested: bool,
    /// Send `true` to signal the relay transport task(s) to stop (#242b).
    shutdown_tx: Option<watch::Sender<bool>>,
    // ── Planner sync (#588) ──────────────────────────────────────────────────
    /// Plan manifests per projectId — pushed by the frontend so mobile can request
    /// them via PlanSyncManifestRequest. relpath → hex hash.
    plan_manifests: HashMap<String, HashMap<String, String>>,
    /// Full plan file caches per projectId — pushed by the frontend so mobile can
    /// pull individual files via PlanSyncPull.
    plan_files: HashMap<String, Vec<PlanFile>>,
    // ── Live planning session (PT1 / #934) ───────────────────────────────────
    /// Last `plan_state` / `plan_status` frame per projectId — replayed to a freshly-paired
    /// client so it mirrors the live session immediately. `plan_event` is transient (not stored).
    plan_states: HashMap<String, ServerMsg>,
    plan_statuses: HashMap<String, ServerMsg>,
    // ── Fleet / coordination (F2) ────────────────────────────────────────────
    /// Latest fleet roster — replayed to freshly-paired mobile clients.
    fleet_sessions: Vec<FleetSession>,
    // ── Automations (A2) ────────────────────────────────────────────────────
    /// Latest automation list — replayed to freshly-paired mobile clients.
    automations: Vec<AutomationFrame>,
    // ── MCP extensions (M2) ─────────────────────────────────────────────────
    /// Latest MCP extension list — replayed to freshly-paired mobile clients.
    mcp_extensions: Vec<McpExtFrame>,
}

/// Single source of truth for the tunnel, managed by Tauri. Holds the desktop's static
/// Noise identity, the pane metadata pushed from the frontend, and the broadcast
/// channels the relay transport subscribes to. Created once at startup; the transport
/// is attached later (#242b).
pub struct TunnelState {
    inner: Mutex<Inner>,
    /// High-volume raw PTY output, fanned out to the transport (filtered per-pane).
    output_tx: broadcast::Sender<PaneOutput>,
    /// Low-volume control events (pane_list / session_state / user_request).
    event_tx: broadcast::Sender<ServerMsg>,
    /// The desktop's long-lived Noise static keypair (identity proven to mobile).
    static_priv: Vec<u8>,
    static_pub: Vec<u8>,
    /// FCM registration tokens of paired devices (#846), captured from the auth handshake
    /// and `set_fcm_token` refreshes. Shared with the push worker so it can drop a token
    /// the moment FCM reports it stale. A `HashSet` dedupes a re-auth re-sending the same
    /// token. In-memory only — re-populated on the next pairing after a desktop restart.
    fcm_tokens: Arc<Mutex<HashSet<String>>>,
    /// Hands `user_request` pushes to the background FCM worker. Unbounded + non-blocking
    /// so the Tauri command thread never waits on a network send; the worker owns its own
    /// runtime (see `spawn_push_worker`).
    push_tx: mpsc::UnboundedSender<PushJob>,
}

/// Queued FCM push jobs. The worker reads the live token set itself; each variant carries
/// the content for a different notification type.
enum PushJob {
    /// Agent just entered `awaiting_input` — notify the user to respond (T6).
    UserRequest { pane_id: String, prompt: String, session_name: String },
    /// Agent entered a manual-wait or asking state (F4).
    CoordWait { session: String, reason: String },
    /// Automation failed non-transiently (A4).
    AutomFailed { name: String, error: String },
    /// The warden quarantined a worker — possible prompt injection / hijack (#1102).
    Warden { session: String, detail: String },
}

/// Drain `rx` and send an FCM push per paired token for each job. Runs on its own OS thread
/// with a dedicated current-thread tokio runtime, so a network send never blocks the Tauri
/// command thread and never depends on whether the relay transport is connected (the whole
/// point of FCM: notify a phone whose app is backgrounded/quit and thus off the relay).
///
/// Credentials are loaded once at startup: if no service-account key is present FCM is
/// disabled — the worker still drains the channel (so senders never block) but every job is
/// a no-op. A token FCM reports stale (UNREGISTERED / INVALID_ARGUMENT) is removed from the
/// shared set so the next pairing's token isn't shadowed by a dead one.
fn spawn_push_worker(mut rx: mpsc::UnboundedReceiver<PushJob>, tokens: Arc<Mutex<HashSet<String>>>) {
    std::thread::Builder::new()
        .name("fcm-push".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    log::error!("fcm: push worker runtime build failed: {e}");
                    return;
                }
            };
            let sender = match fcm::ServiceAccount::load() {
                Ok(Some(sa)) => {
                    log::info!("fcm: push enabled for Firebase project {}", sa.project_id);
                    Some(FcmSender::new(sa))
                }
                Ok(None) => {
                    log::info!(
                        "fcm: no service-account key at {} (set {} to enable mobile push); user_request pushes disabled",
                        fcm::ServiceAccount::key_path().display(),
                        fcm::KEY_PATH_ENV,
                    );
                    None
                }
                Err(e) => {
                    log::warn!("fcm: service-account key present but unusable: {e}; push disabled");
                    None
                }
            };
            rt.block_on(async move {
                while let Some(job) = rx.recv().await {
                    let Some(sender) = sender.as_ref() else { continue };
                    let targets: Vec<String> = tokens.lock().unwrap().iter().cloned().collect();
                    if targets.is_empty() {
                        continue;
                    }
                    for token in &targets {
                        let msg = match &job {
                            PushJob::UserRequest { pane_id, prompt, session_name } =>
                                fcm::build_message(token, pane_id, prompt, session_name),
                            PushJob::CoordWait { session, reason } =>
                                fcm::build_coord_wait_message(token, session, reason),
                            PushJob::AutomFailed { name, error } =>
                                fcm::build_autom_failed_message(token, name, error),
                            PushJob::Warden { session, detail } =>
                                fcm::build_warden_message(token, session, detail),
                        };
                        match sender.send_built(msg).await {
                            SendOutcome::Sent => {
                                log::debug!("fcm: pushed {:?}", match &job {
                                    PushJob::UserRequest { pane_id, .. } => format!("user_request pane={pane_id}"),
                                    PushJob::CoordWait { session, .. } => format!("coord_wait session={session}"),
                                    PushJob::AutomFailed { name, .. } => format!("autom_failed name={name}"),
                                    PushJob::Warden { session, .. } => format!("warden_quarantine session={session}"),
                                });
                            }
                            SendOutcome::DropToken => {
                                tokens.lock().unwrap().remove(token);
                            }
                            SendOutcome::Error => {}
                        }
                    }
                }
            });
        })
        .map(|_| ())
        .unwrap_or_else(|e| log::error!("fcm: could not spawn push worker: {e}"));
}

impl TunnelState {
    pub fn new() -> Self {
        let (output_tx, _) = broadcast::channel(1024);
        let (event_tx, _) = broadcast::channel(256);
        // A failure here means the Noise resolver is misconfigured at build time —
        // unrecoverable, so fall back to an empty identity rather than panicking at
        // startup (the tunnel simply can't pair until restarted).
        let (static_priv, static_pub) = match noise::generate_keypair() {
            Ok(kp) => (kp.private, kp.public),
            Err(e) => {
                log::error!("tunnel: noise keypair generation failed: {e}");
                (Vec::new(), Vec::new())
            }
        };
        let fcm_tokens: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let (push_tx, push_rx) = mpsc::unbounded_channel();
        spawn_push_worker(push_rx, fcm_tokens.clone());
        TunnelState {
            inner: Mutex::new(Inner {
                running: false,
                relay_url: None,
                room: None,
                psk: String::new(),
                panes: Vec::new(),
                sessions: HashMap::new(),
                sizes: HashMap::new(),
                client_count: 0,
                input_granted: false,
                input_requested: false,
                shutdown_tx: None,
                plan_manifests: HashMap::new(),
                plan_files: HashMap::new(),
                plan_states: HashMap::new(),
                plan_statuses: HashMap::new(),
                fleet_sessions: Vec::new(),
                automations: Vec::new(),
                mcp_extensions: Vec::new(),
            }),
            output_tx,
            event_tx,
            static_priv,
            static_pub,
            fcm_tokens,
            push_tx,
        }
    }

    /// Store an FCM registration token from the auth handshake or a `set_fcm_token` refresh
    /// (#846). Idempotent (a `HashSet`), so a re-auth re-sending the same token is a no-op.
    pub fn add_fcm_token(&self, token: String) {
        let token = token.trim().to_string();
        if token.is_empty() {
            return;
        }
        let inserted = self.fcm_tokens.lock().unwrap().insert(token);
        if inserted {
            log::info!("tunnel: stored an FCM push token for the paired device");
        }
    }

    /// Queue an FCM `user_request` push for the paired device(s). Non-blocking — the actual
    /// HTTP send happens on the push worker. No-op when there are no stored tokens (no phone
    /// has paired / shared a token this session).
    fn enqueue_user_request_push(&self, pane_id: &str, prompt: &str, session_name: &str) {
        if self.fcm_tokens.lock().unwrap().is_empty() {
            return;
        }
        let _ = self.push_tx.send(PushJob::UserRequest {
            pane_id: pane_id.to_string(),
            prompt: prompt.to_string(),
            session_name: session_name.to_string(),
        });
    }

    /// Queue an FCM `coord_wait` push (F4). Non-blocking. No-op without stored tokens.
    fn enqueue_coord_wait_push(&self, session: &str, reason: &str) {
        if self.fcm_tokens.lock().unwrap().is_empty() {
            return;
        }
        let _ = self.push_tx.send(PushJob::CoordWait {
            session: session.to_string(),
            reason: reason.to_string(),
        });
    }

    /// Queue an FCM `autom_failed` push (A4). Non-blocking. No-op without stored tokens.
    fn enqueue_autom_failed_push(&self, name: &str, error: &str) {
        if self.fcm_tokens.lock().unwrap().is_empty() {
            return;
        }
        let _ = self.push_tx.send(PushJob::AutomFailed {
            name: name.to_string(),
            error: error.to_string(),
        });
    }

    /// Queue an FCM `warden_quarantine` push (#1102). Non-blocking. No-op without stored tokens.
    fn enqueue_warden_push(&self, session: &str, detail: &str) {
        if self.fcm_tokens.lock().unwrap().is_empty() {
            return;
        }
        let _ = self.push_tx.send(PushJob::Warden {
            session: session.to_string(),
            detail: detail.to_string(),
        });
    }

    /// base64 of the static public key — embedded in the pairing QR (#243).
    pub fn host_pub_key_b64(&self) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(&self.static_pub)
    }

    /// Subscribe to the PTY-output fan-out (the relay transport calls this per client).
    fn subscribe_output(&self) -> broadcast::Receiver<PaneOutput> {
        self.output_tx.subscribe()
    }

    /// Subscribe to control events (pane_list / session_state / user_request).
    fn subscribe_events(&self) -> broadcast::Receiver<ServerMsg> {
        self.event_tx.subscribe()
    }

    /// Tee one PTY output chunk to the relay transport. Called from the `lib.rs`
    /// emitter thread on every flush. No-op (and no allocation) when nobody is
    /// connected, so the tunnel costs nothing while idle.
    pub fn broadcast_output(&self, pane_id: &str, data: &str) {
        if self.output_tx.receiver_count() == 0 {
            return;
        }
        let _ = self.output_tx.send(PaneOutput {
            pane_id: pane_id.to_string(),
            data: data.to_string(),
        });
    }

    /// Record a pane's PTY grid size and broadcast it to the mobile client so it can
    /// render at the same width. Stored for replay to freshly-paired clients. No-op (no
    /// event) when the size is unchanged, so repeated identical fits don't spam the bus.
    pub fn set_pane_size(&self, pane_id: &str, cols: u16, rows: u16) {
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.sizes.insert(pane_id.to_string(), (cols, rows)) == Some((cols, rows)) {
                return;
            }
        }
        let _ = self.event_tx.send(ServerMsg::PaneSize {
            pane_id: pane_id.to_string(),
            cols,
            rows,
        });
    }

    /// Snapshot the known pane sizes to replay to a freshly-paired client.
    fn pane_sizes(&self) -> Vec<(String, u16, u16)> {
        self.inner
            .lock()
            .unwrap()
            .sizes
            .iter()
            .map(|(k, (c, r))| (k.clone(), *c, *r))
            .collect()
    }

    /// Signal the relay transport (if any) to shut down — called on app exit.
    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(tx) = inner.shutdown_tx.take() {
            let _ = tx.send(true);
        }
        inner.running = false;
        inner.client_count = 0;
    }

    /// The current pairing secret (validated against the mobile's `auth` token).
    fn psk(&self) -> String {
        self.inner.lock().unwrap().psk.clone()
    }

    /// Whether the desktop has granted the paired phone input control (#B-wan-viewonly).
    /// `false` (view-only) drops PTY-mutating mobile frames in `handle_client_msg`.
    fn input_granted(&self) -> bool {
        self.inner.lock().unwrap().input_granted
    }

    /// Grant or revoke the paired phone's input control. Resets the "input requested"
    /// notification latch so a later view-only attempt re-prompts the desktop.
    fn set_input_granted(&self, granted: bool) {
        let mut inner = self.inner.lock().unwrap();
        inner.input_granted = granted;
        inner.input_requested = false;
    }

    /// Latch the first view-only input attempt: returns `true` exactly once per session
    /// (until input is granted/revoked or the session restarts), so the desktop is
    /// prompted to grant input once rather than on every dropped keystroke.
    fn take_input_request(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.input_requested {
            return false;
        }
        inner.input_requested = true;
        true
    }

    /// Snapshot the pane list + session metadata to replay to a freshly-paired client.
    fn snapshot(&self) -> (Vec<PaneDescriptor>, Vec<SessionMeta>) {
        let inner = self.inner.lock().unwrap();
        (inner.panes.clone(), inner.sessions.values().cloned().collect())
    }

    /// Snapshot all stored plan manifests to replay to a freshly-paired mobile client.
    fn plan_manifests_snapshot(&self) -> HashMap<String, HashMap<String, String>> {
        self.inner.lock().unwrap().plan_manifests.clone()
    }

    /// The last `plan_state` + `plan_status` frames (across projects) to replay on connect (#934).
    fn plan_frames_snapshot(&self) -> Vec<ServerMsg> {
        let inner = self.inner.lock().unwrap();
        inner.plan_states.values().cloned().chain(inner.plan_statuses.values().cloned()).collect()
    }

    fn fleet_snapshot(&self) -> Vec<FleetSession> {
        self.inner.lock().unwrap().fleet_sessions.clone()
    }

    fn automations_snapshot(&self) -> Vec<AutomationFrame> {
        self.inner.lock().unwrap().automations.clone()
    }

    fn mcp_snapshot(&self) -> Vec<McpExtFrame> {
        self.inner.lock().unwrap().mcp_extensions.clone()
    }

    /// Record how many mobile clients are connected (for the settings card).
    fn set_client_count(&self, n: usize) {
        self.inner.lock().unwrap().client_count = n;
    }

    fn status_locked(&self, inner: &Inner) -> TunnelStatus {
        TunnelStatus {
            running: inner.running,
            relay_url: inner.relay_url.clone(),
            room: inner.room.clone(),
            host_pub_key: self.host_pub_key_b64(),
            psk: inner.psk.clone(),
            client_count: inner.client_count,
            input_granted: inner.input_granted,
        }
    }
}

impl Default for TunnelState {
    fn default() -> Self {
        Self::new()
    }
}

/// Build a `session_state` event from a pushed snapshot.
fn session_state_msg(s: &SessionMeta) -> ServerMsg {
    ServerMsg::SessionState {
        pane_id: s.pane_id.clone(),
        status: s.status.clone(),
        current_task: s.current_task.clone(),
        last_activity: s.last_activity.clone(),
        prompt: s.prompt.clone(),
    }
}

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
    {
        let mut inner = state.inner.lock().unwrap();
        inner.panes = panes.clone();
    }
    log::debug!("tunnel: pane list updated ({} pane(s))", panes.len());
    let _ = state.event_tx.send(ServerMsg::PaneList { panes });
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
    {
        let mut inner = state.inner.lock().unwrap();
        inner.fleet_sessions = sessions.clone();
    }
    log::debug!("tunnel: fleet state updated ({} session(s))", sessions.len());
    let _ = state.event_tx.send(ServerMsg::FleetRoster { sessions });
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
    {
        let mut inner = state.inner.lock().unwrap();
        inner.automations = automations.clone();
    }
    log::debug!("tunnel: automation list updated ({} automation(s))", automations.len());
    let _ = state.event_tx.send(ServerMsg::AutomationList { automations });
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
    {
        let mut inner = state.inner.lock().unwrap();
        inner.mcp_extensions = extensions.clone();
    }
    log::debug!("tunnel: MCP list updated ({} extension(s))", extensions.len());
    let _ = state.event_tx.send(ServerMsg::McpList { extensions });
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
    let result = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default()
        .get(&health_url)
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
    let room = transport::generate_room_id();
    let psk = transport::generate_psk();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    {
        let mut inner = state.inner.lock().unwrap();
        inner.running = true;
        inner.relay_url = Some(relay_url.clone());
        inner.room = Some(room.clone());
        inner.psk = psk;
        // Every fresh pairing starts view-only (#B-wan-viewonly): the desktop must
        // explicitly grant input before the phone can drive a pane.
        inner.input_granted = false;
        inner.input_requested = false;
        inner.shutdown_tx = Some(shutdown_tx);
    }

    spawn_relay_thread(app, relay_url.clone(), room.clone(), state.static_priv.clone(), shutdown_rx)?;

    log::info!("tunnel: dialing relay {relay_url} (room {room})");
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
    let room = transport::generate_room_id();
    let psk = transport::generate_psk();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    {
        let mut inner = state.inner.lock().unwrap();
        inner.room = Some(room.clone());
        inner.psk = psk;
        inner.client_count = 0;
        inner.input_granted = false;
        inner.input_requested = false;
        inner.shutdown_tx = Some(shutdown_tx);
    }
    spawn_relay_thread(app, relay_url, room.clone(), state.static_priv.clone(), shutdown_rx)?;

    log::info!("tunnel: unpaired — rotated to room {room}, pairing secret reset, view-only");
    let inner = state.inner.lock().unwrap();
    Ok(state.status_locked(&inner))
}

// ── Relay dial-out transport ────────────────────────────────────────────────────
// The desktop dials the relay (#241), registers a room as host, completes a Noise IK
// handshake with the mobile peer (relayed end-to-end), then pumps the bus: PTY output
// + control events out (Noise-encrypted), mobile input/resize/focus in. Reconnects
// with backoff. The relay only ever sees ciphertext.


/// FNV-1a 32-bit hash of a UTF-8 string, returned as a lowercase 8-char hex string.
/// Mirrors the TS `fnv1a32hex` in src/lib/plannerCore/hash.ts; both hash UTF-8 bytes.
/// Test vectors pinned in src/lib/plannerCore.fixtures.json (fnv1a32 section).
fn fnv1a32_hex(s: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for b in s.bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x01000193);
    }
    format!("{h:08x}")
}

/// Decrypt + deserialize one Noise transport frame into a client message. Kept at module
/// scope (not in `transport`) so the tests can exercise it against the protocol types.
fn decode_room_msg(tx: &mut snow::TransportState, frame: &[u8]) -> Result<ClientMsg, String> {
    let mut out = vec![0u8; frame.len()];
    let n = tx.read_message(frame, &mut out).map_err(|e| e.to_string())?;
    out.truncate(n);
    serde_json::from_slice(&out).map_err(|e| e.to_string())
}

// ── Tests ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Validate the plannerCore fixture: FNV-1a hash vectors + plan-sync wire frame serde.
    /// Shared with mobile-studio-code and the TS tests; any drift is a breaking protocol
    /// change (#588).
    #[test]
    fn planner_core_fixture_matches_hash_and_serde() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/lib/planner/plannerCore/plannerCore.fixtures.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read plannerCore fixture {}: {e}", path.display()));
        let fx: serde_json::Value = serde_json::from_str(&raw).unwrap();

        // FNV-1a 32-bit hash vectors.
        let v = &fx["fnv1a32"];
        assert_eq!(fnv1a32_hex(""),      v["empty"].as_str().unwrap(), "empty");
        assert_eq!(fnv1a32_hex("a"),     v["a"].as_str().unwrap(),     "\"a\"");
        assert_eq!(fnv1a32_hex("foobar"),v["foobar"].as_str().unwrap(),"\"foobar\"");

        // projectId derivation.
        let pi = &fx["projectId"];
        let expected_pid = format!("proj-{}", fnv1a32_hex(pi["input"].as_str().unwrap()));
        assert_eq!(expected_pid, pi["id"].as_str().unwrap());

        // phaseId derivation.
        let ph = &fx["phaseId"];
        let expected_ph = format!("pid-{}", fnv1a32_hex(ph["input"].as_str().unwrap()));
        assert_eq!(expected_ph, ph["id"].as_str().unwrap());

        // Wire frame serde — ClientMsg round-trips.
        let frames = &fx["wireFrames"];
        let req = serde_json::from_value::<ClientMsg>(frames["plan_sync_manifest_request"].clone())
            .expect("plan_sync_manifest_request deserializes");
        assert!(
            matches!(&req, ClientMsg::PlanSyncManifestRequest { project_id, .. } if project_id == "proj-bf9cf968"),
            "expected PlanSyncManifestRequest with proj-bf9cf968, got {req:?}"
        );
        let pull = serde_json::from_value::<ClientMsg>(frames["plan_sync_pull"].clone())
            .expect("plan_sync_pull deserializes");
        assert!(matches!(&pull, ClientMsg::PlanSyncPull { paths, .. } if paths == &["goal.md"]),
            "expected PlanSyncPull with [\"goal.md\"], got {pull:?}");
        let push = serde_json::from_value::<ClientMsg>(frames["plan_sync_push"].clone())
            .expect("plan_sync_push deserializes");
        assert!(matches!(&push, ClientMsg::PlanSyncPush { files, .. } if files.len() == 1),
            "expected PlanSyncPush with 1 file, got {push:?}");

        // ServerMsg serialization matches fixture wire shapes.
        let manifest_frame = serde_json::to_value(ServerMsg::PlanSyncManifest {
            project_id: "proj-bf9cf968".into(),
            files: [("goal.md".to_string(), "bf9cf968".to_string())].into_iter().collect(),
        })
        .unwrap();
        assert_eq!(manifest_frame, frames["plan_sync_manifest"], "plan_sync_manifest shape");

        let files_frame = serde_json::to_value(ServerMsg::PlanSyncFiles {
            project_id: "proj-bf9cf968".into(),
            files: vec![PlanFile { relpath: "goal.md".into(), content: "foobar".into() }],
        })
        .unwrap();
        assert_eq!(files_frame, frames["plan_sync_files"], "plan_sync_files shape");

        let ack_frame = serde_json::to_value(ServerMsg::PlanSyncAck {
            project_id: "proj-bf9cf968".into(),
            applied: true,
        })
        .unwrap();
        assert_eq!(ack_frame, frames["plan_sync_ack"], "plan_sync_ack shape");

        // Manifest content hash: fnv1a32("foobar") == fixture manifest files["goal.md"].
        let manifest = &fx["manifest"];
        let expected_hash = fnv1a32_hex("foobar");
        assert_eq!(expected_hash, manifest["files"]["goal.md"].as_str().unwrap());
    }

    /// FNV-1a 32-bit is a 32-bit operation even for long strings.
    #[test]
    fn fnv1a32_stays_in_u32_range() {
        let h = fnv1a32_hex("the quick brown fox jumps over the lazy dog");
        assert_eq!(h.len(), 8);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// Validate serde against the shared cross-repo fixture
    /// (`src/lib/tunnelProtocol.fixtures.json`, also consumed by the TS tests and
    /// mobile-studio-code). If this drifts, the protocol changed and both repos
    /// must coordinate (#46).
    #[test]
    fn shared_fixture_matches_serde() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/features/tunnel/lib/tunnelProtocol.fixtures.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read fixture {}: {e}", path.display()));
        let fx: serde_json::Value = serde_json::from_str(&raw).unwrap();

        // client → server: every fixture deserializes into the expected variant.
        let c = &fx["clientToServer"];
        assert!(matches!(
            serde_json::from_value::<ClientMsg>(c["auth"].clone()).unwrap(),
            ClientMsg::Auth { fcm_token: Some(_), .. }
        ));
        assert!(matches!(
            serde_json::from_value::<ClientMsg>(c["auth_no_fcm"].clone()).unwrap(),
            ClientMsg::Auth { fcm_token: None, .. }
        ));
        assert!(matches!(
            serde_json::from_value::<ClientMsg>(c["set_fcm_token"].clone()).unwrap(),
            ClientMsg::SetFcmToken { fcm_token } if fcm_token == "fcm-token-xyz"
        ));
        assert!(matches!(
            serde_json::from_value::<ClientMsg>(c["pane_set_state"].clone()).unwrap(),
            ClientMsg::PaneSetState { .. }
        ));
        assert!(matches!(
            serde_json::from_value::<ClientMsg>(c["pane_focus"].clone()).unwrap(),
            ClientMsg::PaneFocus { .. }
        ));
        assert!(matches!(
            serde_json::from_value::<ClientMsg>(c["pane_input"].clone()).unwrap(),
            ClientMsg::PaneInput { .. }
        ));
        assert!(matches!(
            serde_json::from_value::<ClientMsg>(c["pane_resize"].clone()).unwrap(),
            ClientMsg::PaneResize { cols: 80, rows: 24, .. }
        ));

        // server → client: our serialization equals the fixture byte-shape.
        let s = &fx["serverToClient"];
        assert_eq!(serde_json::to_value(ServerMsg::AuthOk).unwrap(), s["auth_ok"]);
        assert_eq!(
            serde_json::to_value(ServerMsg::PaneOutput {
                pane_id: "t0p0".into(),
                data: "$ ls\r\n".into(),
                coarse: false,
            })
            .unwrap(),
            s["pane_output"]
        );
        assert_eq!(
            serde_json::to_value(ServerMsg::PaneSize {
                pane_id: "t0p0".into(),
                cols: 80,
                rows: 24,
            })
            .unwrap(),
            s["pane_size"]
        );
        assert_eq!(
            serde_json::to_value(ServerMsg::SessionState {
                pane_id: "t0p0".into(),
                status: "awaiting_input".into(),
                current_task: "api".into(),
                last_activity: "2026-05-29T00:00:00.000Z".into(),
                prompt: Some("Apply this change? (y/n)".into()),
            })
            .unwrap(),
            s["session_state"]
        );
        assert_eq!(
            serde_json::to_value(ServerMsg::UserRequest {
                pane_id: "t0p0".into(),
                prompt: "Apply this change? (y/n)".into(),
            })
            .unwrap(),
            s["user_request"]
        );
        // pane_list: deserialize the descriptors, then re-serialize to compare.
        let panes: Vec<PaneDescriptor> =
            serde_json::from_value(s["pane_list"]["panes"].clone()).unwrap();
        assert_eq!(
            serde_json::to_value(ServerMsg::PaneList { panes }).unwrap(),
            s["pane_list"]
        );
    }

    // ── #928 / T1b: Noise IK byte-level match against the shared cross-repo vector ──
    //
    // `src-tauri/tests/noise_vectors.json` is the *canonical, frozen* Noise IK test
    // vector: empty prologue, fixed static AND ephemeral keypairs, and the exact
    // ciphertext snow produces for the IK handshake + a transport message each way.
    // snow normally samples a random ephemeral, so a byte-stable handshake is only
    // reproducible when the ephemeral is pinned via `fixed_ephemeral_key_for_testing_only`
    // (the two helpers below) — that is what makes a cross-impl vector possible at all.
    //
    // The same JSON is vendored into mobile-studio-code, where the noble side asserts
    // against it; so any snow-vs-noble divergence (prologue, message framing, HKDF
    // chaining, nonce/rekey) fails a test on at least one side. To regenerate after an
    // intentional protocol change, run the `generate_noise_vector` authoring tool below
    // and commit its output.

    /// Build an IK *initiator* with a FIXED ephemeral — identical to `noise::initiator`
    /// apart from pinning the ephemeral, which `noise::initiator` deliberately does not
    /// expose (production must use a fresh random ephemeral). Test-vectors only.
    fn vector_initiator(static_priv: &[u8], remote_pub: &[u8], eph_priv: &[u8]) -> snow::HandshakeState {
        snow::Builder::new(noise::PARAMS.parse().expect("valid noise params"))
            .local_private_key(static_priv).unwrap()
            .remote_public_key(remote_pub).unwrap()
            .fixed_ephemeral_key_for_testing_only(eph_priv)
            .build_initiator().unwrap()
    }

    /// Build an IK *responder* (desktop side) with a FIXED ephemeral. Test-vectors only.
    fn vector_responder(static_priv: &[u8], eph_priv: &[u8]) -> snow::HandshakeState {
        snow::Builder::new(noise::PARAMS.parse().expect("valid noise params"))
            .local_private_key(static_priv).unwrap()
            .fixed_ephemeral_key_for_testing_only(eph_priv)
            .build_responder().unwrap()
    }

    #[test]
    fn noise_ik_matches_shared_test_vector() {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/noise_vectors.json");
        let raw = std::fs::read_to_string(&path)
            .expect("src-tauri/tests/noise_vectors.json must exist (the shared Noise vector, #928)");
        let v: serde_json::Value = serde_json::from_str(&raw)
            .expect("tests/noise_vectors.json must be valid JSON");

        // Guard the params: if the tunnel ever changes its Noise suite, the frozen
        // ciphertext below stops matching — but assert the declared protocol up front so
        // the failure names the cause instead of looking like a crypto bug.
        assert_eq!(
            v["protocolName"].as_str().expect("protocolName"),
            noise::PARAMS,
            "the vector is for a different Noise protocol than the tunnel now uses"
        );

        let dec = |k: &str| b64.decode(v[k].as_str().unwrap_or_else(|| panic!("missing key {k}"))).unwrap();
        let init_static = dec("initStaticPriv");
        let init_eph    = dec("initEphemeralPriv");
        let resp_static = dec("respStaticPriv");
        let resp_pub    = dec("respStaticPub");
        let resp_eph    = dec("respEphemeralPriv");
        let msgs = v["messages"].as_array().expect("messages[]");

        let mut init = vector_initiator(&init_static, &resp_pub, &init_eph);
        let mut resp = vector_responder(&resp_static, &resp_eph);
        let mut buf = vec![0u8; 4096];
        let mut out = vec![0u8; 4096];

        let expect_ct = |i: usize| msgs[i]["ciphertext"].as_str().expect("ciphertext");
        let payload   = |i: usize| b64.decode(msgs[i]["payload"].as_str().expect("payload")).unwrap();

        // msg1 → e, es, s, ss
        let n = init.write_message(&[], &mut buf).unwrap();
        assert_eq!(b64.encode(&buf[..n]), expect_ct(0), "msg1 snow ↔ vector divergence (#928)");
        let m = resp.read_message(&buf[..n], &mut out).unwrap();
        assert_eq!(m, 0, "msg1 carries no payload");

        // msg2 ← e, ee, se
        let n = resp.write_message(&[], &mut buf).unwrap();
        assert_eq!(b64.encode(&buf[..n]), expect_ct(1), "msg2 snow ↔ vector divergence (#928)");
        let m = init.read_message(&buf[..n], &mut out).unwrap();
        assert_eq!(m, 0, "msg2 carries no payload");

        let mut it = init.into_transport_mode().unwrap();
        let mut rt = resp.into_transport_mode().unwrap();

        // transport init → resp (nonce 0 on the initiator's sending key)
        let p = payload(2);
        let n = it.write_message(&p, &mut buf).unwrap();
        assert_eq!(b64.encode(&buf[..n]), expect_ct(2), "transport init→resp divergence (#928)");
        let m = rt.read_message(&buf[..n], &mut out).unwrap();
        assert_eq!(&out[..m], &p[..], "transport init→resp decrypt mismatch");

        // transport resp → init (nonce 0 on the responder's sending key)
        let p = payload(3);
        let n = rt.write_message(&p, &mut buf).unwrap();
        assert_eq!(b64.encode(&buf[..n]), expect_ct(3), "transport resp→init divergence (#928)");
        let m = it.read_message(&buf[..n], &mut out).unwrap();
        assert_eq!(&out[..m], &p[..], "transport resp→init decrypt mismatch");
    }

    /// Authoring tool (not a CI test): regenerates `tests/noise_vectors.json`. Run with
    ///   cargo test -p app --lib generate_noise_vector -- --ignored --nocapture
    /// and replace the file with the JSON printed between the markers.
    #[test]
    #[ignore = "authoring tool — regenerates tests/noise_vectors.json"]
    fn generate_noise_vector() {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;

        let is = noise::generate_keypair().unwrap();
        let ie = noise::generate_keypair().unwrap();
        let rs = noise::generate_keypair().unwrap();
        let re = noise::generate_keypair().unwrap();

        let mut init = vector_initiator(&is.private, &rs.public, &ie.private);
        let mut resp = vector_responder(&rs.private, &re.private);
        let mut buf = vec![0u8; 4096];
        let mut out = vec![0u8; 4096];

        let n = init.write_message(&[], &mut buf).unwrap();
        let msg1 = b64.encode(&buf[..n]);
        resp.read_message(&buf[..n], &mut out).unwrap();
        let n = resp.write_message(&[], &mut buf).unwrap();
        let msg2 = b64.encode(&buf[..n]);
        init.read_message(&buf[..n], &mut out).unwrap();

        let mut it = init.into_transport_mode().unwrap();
        let mut rt = resp.into_transport_mode().unwrap();
        let pa: &[u8] = b"pane_input";
        let n = it.write_message(pa, &mut buf).unwrap();
        let ct_a = b64.encode(&buf[..n]);
        rt.read_message(&buf[..n], &mut out).unwrap();
        let pb: &[u8] = b"pane_output";
        let n = rt.write_message(pb, &mut buf).unwrap();
        let ct_b = b64.encode(&buf[..n]);
        it.read_message(&buf[..n], &mut out).unwrap();

        let json = serde_json::json!({
            "$comment": "Canonical Noise IK test vector (#928). FROZEN + shared cross-repo: \
                         mobile-studio-code vendors this same file and asserts the noble side \
                         against it. Empty prologue; static AND ephemeral keypairs are fixed so \
                         the handshake bytes are reproducible. All values base64. Regenerate via \
                         the `generate_noise_vector` authoring test after an intentional change.",
            "protocolName": noise::PARAMS,
            "prologue": "",
            "initStaticPriv": b64.encode(is.private),
            "initEphemeralPriv": b64.encode(ie.private),
            "respStaticPriv": b64.encode(rs.private),
            "respStaticPub": b64.encode(rs.public),
            "respEphemeralPriv": b64.encode(re.private),
            "messages": [
                { "label": "msg1 init->resp (e, es, s, ss)", "payload": "", "ciphertext": msg1 },
                { "label": "msg2 resp->init (e, ee, se)", "payload": "", "ciphertext": msg2 },
                { "label": "transport init->resp", "payload": b64.encode(pa), "ciphertext": ct_a },
                { "label": "transport resp->init", "payload": b64.encode(pb), "ciphertext": ct_b },
            ]
        });
        println!("<<<NOISE_VECTOR_JSON");
        println!("{}", serde_json::to_string_pretty(&json).unwrap());
        println!("NOISE_VECTOR_JSON>>>");
    }

    /// A full Noise IK handshake between the desktop (responder) and a mobile peer
    /// (initiator that knows the desktop's static public key) yields a working
    /// bidirectional transport — the end-to-end channel the relay can't read.
    #[test]
    fn noise_ik_handshake_roundtrips_both_directions() {
        let host = noise::generate_keypair().unwrap(); // desktop static identity
        let mobile = noise::generate_keypair().unwrap(); // mobile static identity

        // Mobile learns `host.public` from the QR; the desktop learns mobile's key
        // during the handshake (IK).
        let mut init = noise::initiator(&mobile.private, &host.public).unwrap();
        let mut resp = noise::responder(&host.private).unwrap();

        let mut buf = [0u8; 1024];
        let mut out = [0u8; 1024];

        // -> e, es, s, ss
        let n = init.write_message(&[], &mut buf).unwrap();
        resp.read_message(&buf[..n], &mut out).unwrap();
        // <- e, ee, se
        let n = resp.write_message(&[], &mut buf).unwrap();
        init.read_message(&buf[..n], &mut out).unwrap();

        let mut it = init.into_transport_mode().unwrap();
        let mut rt = resp.into_transport_mode().unwrap();

        // mobile → desktop
        let n = it.write_message(b"pane_input", &mut buf).unwrap();
        let m = rt.read_message(&buf[..n], &mut out).unwrap();
        assert_eq!(&out[..m], b"pane_input");

        // desktop → mobile
        let n = rt.write_message(b"pane_output", &mut buf).unwrap();
        let m = it.read_message(&buf[..n], &mut out).unwrap();
        assert_eq!(&out[..m], b"pane_output");
    }

    /// A wrong responder key (a malicious relay swapping the host identity) fails the
    /// handshake — the QR-pinned `hostPubKey` is what authenticates the desktop.
    #[test]
    fn noise_ik_rejects_wrong_host_key() {
        let host = noise::generate_keypair().unwrap();
        let imposter = noise::generate_keypair().unwrap();
        let mobile = noise::generate_keypair().unwrap();

        // Mobile expects `host`, but the responder is `imposter`.
        let mut init = noise::initiator(&mobile.private, &host.public).unwrap();
        let mut resp = noise::responder(&imposter.private).unwrap();

        let mut buf = [0u8; 1024];
        let mut out = [0u8; 1024];
        let n = init.write_message(&[], &mut buf).unwrap();
        // The responder can't decrypt an IK first message sealed to a different static
        // key — the handshake fails rather than establishing a session.
        assert!(resp.read_message(&buf[..n], &mut out).is_err());
    }

    /// View-only gate (#B-wan-viewonly): a paired phone cannot drive a pane until the
    /// desktop grants input. Keystrokes/resizes are dropped while view-only and flow once
    /// granted; focus/set-state (read-side filtering) and auth are always allowed.
    #[test]
    fn view_only_drops_pty_input_until_granted() {
        let keys = ClientMsg::PaneInput { pane_id: "t0p0".into(), data: "rm -rf /\n".into() };
        let resize = ClientMsg::PaneResize { pane_id: "t0p0".into(), cols: 80, rows: 24 };
        let focus = ClientMsg::PaneFocus { pane_id: "t0p0".into() };
        let set_state = ClientMsg::PaneSetState { pane_id: "t0p0".into(), state: "streaming".into() };

        // View-only (not granted): PTY-mutating frames are dropped …
        assert!(!transport::input_allowed(&keys, false));
        assert!(!transport::input_allowed(&resize, false));
        // … but read-side frames still steer which pane streams back.
        assert!(transport::input_allowed(&focus, false));
        assert!(transport::input_allowed(&set_state, false));

        // After the desktop grants input, keystrokes + resize are allowed.
        assert!(transport::input_allowed(&keys, true));
        assert!(transport::input_allowed(&resize, true));
    }

    /// Granting/revoking input flips the gate, and the once-per-session request latch is
    /// reset so a later view-only attempt re-prompts the desktop.
    #[test]
    fn input_grant_toggles_state_and_resets_request_latch() {
        let st = TunnelState::new();
        // Fresh state is view-only and reflected in the status card.
        assert!(!st.input_granted());
        assert!(!st.status_locked(&st.inner.lock().unwrap()).input_granted);

        // First view-only attempt latches a single prompt; subsequent ones don't re-fire.
        assert!(st.take_input_request());
        assert!(!st.take_input_request());

        // Granting input flips the gate and clears the latch.
        st.set_input_granted(true);
        assert!(st.input_granted());
        assert!(st.status_locked(&st.inner.lock().unwrap()).input_granted);

        // Revoking returns to view-only and re-arms the prompt latch.
        st.set_input_granted(false);
        assert!(!st.input_granted());
        assert!(st.take_input_request());
    }

    #[test]
    fn host_pub_key_is_base64_of_static_public() {
        let st = TunnelState::new();
        let b64 = st.host_pub_key_b64();
        assert!(!b64.is_empty());
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD.decode(&b64).unwrap();
        assert_eq!(decoded, st.static_pub);
    }

    #[test]
    fn broadcast_output_is_noop_without_subscribers() {
        let st = TunnelState::new();
        // No receivers yet → returns without sending (and without panicking).
        st.broadcast_output("t0p0", "hello");
        // With a subscriber, the chunk is delivered.
        let mut rx = st.subscribe_output();
        st.broadcast_output("t0p0", "world");
        let got = rx.try_recv().unwrap();
        assert_eq!(got.pane_id, "t0p0");
        assert_eq!(got.data, "world");
    }

    #[test]
    fn set_pane_size_records_dedupes_and_broadcasts() {
        let st = TunnelState::new();
        let mut rx = st.subscribe_events();

        // First set records the size and broadcasts a pane_size event.
        st.set_pane_size("t0p0", 80, 24);
        match rx.try_recv().unwrap() {
            ServerMsg::PaneSize { pane_id, cols, rows } => {
                assert_eq!((pane_id.as_str(), cols, rows), ("t0p0", 80, 24));
            }
            other => panic!("expected pane_size, got {other:?}"),
        }
        assert_eq!(st.pane_sizes(), vec![("t0p0".to_string(), 80, 24)]);

        // An identical size is a no-op — no duplicate event.
        st.set_pane_size("t0p0", 80, 24);
        assert!(rx.try_recv().is_err());

        // A changed size broadcasts again and updates the replay snapshot.
        st.set_pane_size("t0p0", 100, 30);
        assert!(matches!(
            rx.try_recv().unwrap(),
            ServerMsg::PaneSize { cols: 100, rows: 30, .. }
        ));
        assert_eq!(st.pane_sizes(), vec![("t0p0".to_string(), 100, 30)]);
    }

    #[test]
    fn room_id_is_relay_valid() {
        // Matches the relay's validateRoomId: [A-Za-z0-9_-]{16,64}.
        let id = transport::generate_room_id();
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        // Two draws differ (entropy sanity).
        assert_ne!(transport::generate_room_id(), transport::generate_room_id());
    }

    /// Pairing secrets are fresh + rotatable (#B-unpair-revoke): each draw is 64 hex
    /// chars (32 bytes) and two draws differ, so `tunnel_unpair` invalidating the old
    /// secret by minting a new one cannot collide with the previous QR.
    #[test]
    fn psk_is_fresh_rotatable_hex() {
        let a = transport::generate_psk();
        let b = transport::generate_psk();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    // ── T3b: RelayDiag struct shape ──────────────────────────────────────────────

    /// RelayDiag serializes with camelCase keys — asserts the wire shape the frontend
    /// (tunnelClient.ts `tunnelCheckRelay`) and the Settings card depend on.
    #[test]
    fn relay_diag_serializes_camel_case() {
        let d = RelayDiag {
            reachable: true,
            service: Some("msc-tunnel-relay".into()),
            version: Some("0.1.0".into()),
            latency_ms: 42,
            error: None,
            host_connected: false,
            client_count: 1,
        };
        let v = serde_json::to_value(&d).unwrap();
        assert!(v.get("reachable").is_some(),       "reachable");
        assert!(v.get("latencyMs").is_some(),        "latencyMs (camelCase)");
        assert!(v.get("hostConnected").is_some(),    "hostConnected (camelCase)");
        assert!(v.get("clientCount").is_some(),      "clientCount (camelCase)");
        assert_eq!(v["latencyMs"], 42);
        assert_eq!(v["service"], "msc-tunnel-relay");
    }

    /// A failed probe (e.g. invalid URL) always produces `reachable: false` with an
    /// `error` message rather than panicking — the Settings card can render the result.
    #[test]
    fn relay_diag_error_case_is_not_reachable() {
        let d = RelayDiag {
            reachable: false,
            service: None,
            version: None,
            latency_ms: 5001,
            error: Some("probe timed out after 5s".into()),
            host_connected: false,
            client_count: 0,
        };
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["reachable"], false);
        assert!(v["error"].as_str().unwrap().contains("timed out"));
        assert_eq!(v["service"], serde_json::Value::Null);
    }

    // ── T5: relay idle/TTL close detection ───────────────────────────────────────

    /// The close-reason strings the Cloudflare relay emits for idle/TTL expiry are
    /// detected so `tunnel://room-expired` is emitted instead of a generic reconnect.
    #[test]
    fn room_expired_close_reasons_are_recognized() {
        // Strings emitted by relay/src/room.ts's alarm() handler.
        let idle = "room idle timeout";
        let ttl  = "room lifetime exceeded";
        let transient = "going away";
        let empty = "";

        assert!(idle.contains("idle timeout"),       "idle timeout pattern");
        assert!(ttl.contains("lifetime exceeded"),   "lifetime exceeded pattern");
        assert!(!transient.contains("idle timeout") && !transient.contains("lifetime exceeded"),
            "transient close should not trigger room-expired");
        assert!(!empty.contains("idle timeout") && !empty.contains("lifetime exceeded"),
            "empty reason should not trigger room-expired");
    }

    #[test]
    fn split_utf8_respects_size_and_char_boundaries() {
        assert_eq!(transport::split_utf8("", 4), Vec::<&str>::new());
        assert_eq!(transport::split_utf8("abc", 8), vec!["abc"]);
        // Multi-byte chars must never be split mid-codepoint.
        let s = "é".repeat(10); // each 'é' is 2 bytes → 20 bytes
        let parts = transport::split_utf8(&s, 5);
        assert!(parts.iter().all(|p| p.len() <= 5));
        assert_eq!(parts.concat(), s); // lossless
    }

    /// Establish a Noise IK transport pair (host responder, mobile initiator).
    fn handshake_pair() -> (snow::TransportState, snow::TransportState) {
        let host = noise::generate_keypair().unwrap();
        let mobile = noise::generate_keypair().unwrap();
        let mut init = noise::initiator(&mobile.private, &host.public).unwrap();
        let mut resp = noise::responder(&host.private).unwrap();
        let mut b = [0u8; 1024];
        let mut o = [0u8; 1024];
        let n = init.write_message(&[], &mut b).unwrap();
        resp.read_message(&b[..n], &mut o).unwrap();
        let n = resp.write_message(&[], &mut b).unwrap();
        init.read_message(&b[..n], &mut o).unwrap();
        (resp.into_transport_mode().unwrap(), init.into_transport_mode().unwrap())
    }

    #[test]
    fn app_messages_roundtrip_through_the_noise_session() {
        let (mut host, mut mobile) = handshake_pair();

        // desktop → mobile: encode a ServerMsg, decrypt + parse on the mobile side.
        let frame = transport::encode(&mut host, &ServerMsg::AuthOk).unwrap();
        let mut out = vec![0u8; frame.len()];
        let n = mobile.read_message(&frame, &mut out).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&out[..n]).unwrap();
        assert_eq!(v, serde_json::json!({ "type": "auth_ok" }));

        // mobile → desktop: a client `auth` frame decodes via decode_room_msg.
        let cj = serde_json::to_vec(&serde_json::json!({ "type": "auth", "token": "secret" })).unwrap();
        let mut cf = vec![0u8; cj.len() + 16];
        let m = mobile.write_message(&cj, &mut cf).unwrap();
        cf.truncate(m);
        let decoded = decode_room_msg(&mut host, &cf).unwrap();
        assert!(matches!(decoded, ClientMsg::Auth { token, .. } if token == "secret"));
    }

    // ── F2: fleet roster + coord event ──────────────────────────────────────────

    /// FleetSession serializes with camelCase and omits empty `blocked_on`.
    #[test]
    fn fleet_session_camel_case_and_skips_empty_blocked_on() {
        let s = FleetSession {
            session: "t0p1".into(),
            status: "running".into(),
            blocked_on: vec![],
            wait_reason: None,
            question: None,
            at: 1_700_000_000_000,
        };
        let v = serde_json::to_value(&s).unwrap();
        // camelCase field names
        assert!(v.get("blockedOn").is_none(), "empty blocked_on must be omitted");
        assert!(v.get("waitReason").is_some(), "waitReason must be present (null)");
        assert_eq!(v["session"], "t0p1");
        assert_eq!(v["status"], "running");
    }

    /// FleetSession with deps serializes blocked_on as an array.
    #[test]
    fn fleet_session_with_blocked_on_includes_array() {
        let s = FleetSession {
            session: "t0p2".into(),
            status: "blocked".into(),
            blocked_on: vec!["#42".into(), "contract:TunnelState".into()],
            wait_reason: None,
            question: None,
            at: 0,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["blockedOn"], serde_json::json!(["#42", "contract:TunnelState"]));
    }

    /// FleetRoster ServerMsg serializes with snake_case type tag.
    #[test]
    fn fleet_roster_msg_type_tag() {
        let msg = ServerMsg::FleetRoster { sessions: vec![] };
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "fleet_roster");
        assert_eq!(v["sessions"], serde_json::json!([]));
    }

    /// CoordEvent ServerMsg serializes correctly.
    #[test]
    fn coord_event_msg_type_tag() {
        let msg = ServerMsg::CoordEvent {
            kind: "waiting".into(),
            session: Some("t0p1".into()),
            ref_key: None,
            at: 12345,
        };
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "coord_event");
        assert_eq!(v["kind"], "waiting");
        assert_eq!(v["session"], "t0p1");
        assert_eq!(v["at"], 12345);
    }

    /// CoordWake ClientMsg deserializes from the wire shape.
    #[test]
    fn coord_wake_client_msg_deserializes() {
        let raw = serde_json::json!({ "type": "coord_wake", "session": "t0p3" });
        let msg = serde_json::from_value::<ClientMsg>(raw).unwrap();
        assert!(matches!(msg, ClientMsg::CoordWake { session } if session == "t0p3"));
    }

    /// CoordApprove ClientMsg deserializes from the wire shape.
    #[test]
    fn coord_approve_client_msg_deserializes() {
        let raw = serde_json::json!({ "type": "coord_approve", "session": "t0p4" });
        let msg = serde_json::from_value::<ClientMsg>(raw).unwrap();
        assert!(matches!(msg, ClientMsg::CoordApprove { session } if session == "t0p4"));
    }

    // ── A2: automation frames + run-now ─────────────────────────────────────────

    /// AutomationFrame serializes with camelCase.
    #[test]
    fn automation_frame_camel_case() {
        let f = AutomationFrame {
            id: "a1".into(),
            name: "Nightly build".into(),
            armed: true,
            when_expr: "0 2 * * *".into(),
            last_run_at: Some(1_700_000_000_000),
            next_run_at: None,
            last_status: Some("ok".into()),
        };
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v["whenExpr"], "0 2 * * *");
        assert_eq!(v["lastRunAt"], 1_700_000_000_000_u64);
        assert_eq!(v["lastStatus"], "ok");
        assert_eq!(v["nextRunAt"], serde_json::Value::Null);
    }

    /// AutomationList ServerMsg type tag.
    #[test]
    fn automation_list_msg_type_tag() {
        let msg = ServerMsg::AutomationList { automations: vec![] };
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "automation_list");
    }

    /// AutomationFailed ServerMsg type tag and camelCase.
    #[test]
    fn automation_failed_msg_shape() {
        let msg = ServerMsg::AutomationFailed { id: "a1".into(), at: 42, error: "timeout".into() };
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "automation_failed");
        assert_eq!(v["error"], "timeout");
    }

    /// AutomationArm ClientMsg deserializes.
    #[test]
    fn automation_arm_client_msg_deserializes() {
        let raw = serde_json::json!({ "type": "automation_arm", "id": "a1", "armed": false });
        let msg = serde_json::from_value::<ClientMsg>(raw).unwrap();
        assert!(matches!(msg, ClientMsg::AutomationArm { id, armed } if id == "a1" && !armed));
    }

    /// AutomationRunNow ClientMsg deserializes.
    #[test]
    fn automation_run_now_client_msg_deserializes() {
        let raw = serde_json::json!({ "type": "automation_run_now", "id": "a2" });
        let msg = serde_json::from_value::<ClientMsg>(raw).unwrap();
        assert!(matches!(msg, ClientMsg::AutomationRunNow { id } if id == "a2"));
    }

    // ── PT1: live planning frames (#934) ─────────────────────────────────────────

    /// plan_state serializes snake_case-tagged with the camelCase fields the phone expects.
    #[test]
    fn plan_state_msg_shape() {
        let msg = ServerMsg::PlanState {
            project_id: "proj-bf9cf968".into(),
            current_stage: "goal".into(),
            confirmed_sections: vec!["goal".into()],
            files: vec![PlanFile { relpath: "goal.md".into(), content: "# Goal".into() }],
            messages: vec![PlanMessage { role: "assistant".into(), text: "hi".into(), at: 1 }],
            pipeline_runs: vec![PlanPipelineRun { id: "build".into(), stage: "test".into(), status: "running".into() }],
        };
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "plan_state");
        assert_eq!(v["projectId"], "proj-bf9cf968");
        assert_eq!(v["currentStage"], "goal");
        assert_eq!(v["confirmedSections"][0], "goal");
        assert_eq!(v["files"][0]["relpath"], "goal.md");
        assert_eq!(v["pipelineRuns"][0]["id"], "build");
    }

    /// plan_event: snake_case type tag, camelCase fields, absent detail omitted.
    #[test]
    fn plan_event_msg_shape() {
        let msg = ServerMsg::PlanEvent {
            project_id: "p".into(),
            kind: "section_confirmed".into(),
            at: 1,
            section: Some("goal".into()),
            stage: None,
            message: None,
            run: None,
        };
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "plan_event");
        assert_eq!(v["kind"], "section_confirmed");
        assert_eq!(v["section"], "goal");
        assert!(v.get("stage").is_none()); // skip_serializing_if omits absent detail
    }

    /// plan_status type tag + camelCase.
    #[test]
    fn plan_status_msg_shape() {
        let msg = ServerMsg::PlanStatus { project_id: "p".into(), current_stage: "scope".into(), status: "in_progress".into() };
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "plan_status");
        assert_eq!(v["currentStage"], "scope");
        assert_eq!(v["status"], "in_progress");
    }

    /// The drive frames deserialize from the phone's camelCase wire shape.
    #[test]
    fn plan_drive_client_msgs_deserialize() {
        let adv = serde_json::from_value::<ClientMsg>(serde_json::json!({ "type": "plan_advance", "projectId": "p", "stageKey": "scope" })).unwrap();
        assert!(matches!(adv, ClientMsg::PlanAdvance { stage_key, .. } if stage_key == "scope"));
        let con = serde_json::from_value::<ClientMsg>(serde_json::json!({ "type": "plan_confirm", "projectId": "p", "section": "goal" })).unwrap();
        assert!(matches!(con, ClientMsg::PlanConfirm { section, .. } if section == "goal"));
        let chat = serde_json::from_value::<ClientMsg>(serde_json::json!({ "type": "plan_chat", "projectId": "p", "text": "hi" })).unwrap();
        assert!(matches!(chat, ClientMsg::PlanChat { text, .. } if text == "hi"));
    }

    /// A view-only phone can mirror the planning session but cannot steer it (#934).
    #[test]
    fn plan_drive_requires_input_grant() {
        let chat = ClientMsg::PlanChat { project_id: "p".into(), text: "hi".into() };
        assert!(!transport::input_allowed(&chat, false));
        assert!(transport::input_allowed(&chat, true));
        assert!(!transport::input_allowed(&ClientMsg::PlanAdvance { project_id: "p".into(), stage_key: "scope".into() }, false));
        assert!(!transport::input_allowed(&ClientMsg::PlanConfirm { project_id: "p".into(), section: "goal".into() }, false));
    }

    // ── M2: MCP extension list ───────────────────────────────────────────────────

    /// McpExtFrame serializes with camelCase.
    #[test]
    fn mcp_ext_frame_camel_case() {
        let f = McpExtFrame {
            id: "m1".into(),
            kind: "mcp".into(),
            name: "Postgres".into(),
            enabled: true,
            transport: Some("stdio".into()),
            url: None,
        };
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v["transport"], "stdio");
        assert_eq!(v["url"], serde_json::Value::Null);
        assert_eq!(v["enabled"], true);
    }

    /// McpList ServerMsg type tag.
    #[test]
    fn mcp_list_msg_type_tag() {
        let msg = ServerMsg::McpList { extensions: vec![] };
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "mcp_list");
    }

    // ── TunnelState snapshot methods ────────────────────────────────────────────

    /// fleet_snapshot / automations_snapshot / mcp_snapshot return empty then update.
    #[test]
    fn snapshot_methods_start_empty_and_update() {
        let st = TunnelState::new();
        assert!(st.fleet_snapshot().is_empty());
        assert!(st.automations_snapshot().is_empty());
        assert!(st.mcp_snapshot().is_empty());

        {
            let mut inner = st.inner.lock().unwrap();
            inner.fleet_sessions.push(FleetSession {
                session: "t0p0".into(),
                status: "running".into(),
                blocked_on: vec![],
                wait_reason: None,
                question: None,
                at: 0,
            });
            inner.automations.push(AutomationFrame {
                id: "a1".into(),
                name: "test".into(),
                armed: true,
                when_expr: "*/5 * * * *".into(),
                last_run_at: None,
                next_run_at: None,
                last_status: None,
            });
            inner.mcp_extensions.push(McpExtFrame {
                id: "m1".into(),
                kind: "mcp".into(),
                name: "Postgres".into(),
                enabled: true,
                transport: Some("stdio".into()),
                url: None,
            });
        }
        assert_eq!(st.fleet_snapshot().len(), 1);
        assert_eq!(st.automations_snapshot().len(), 1);
        assert_eq!(st.mcp_snapshot().len(), 1);
    }
}
