// Tunnel state — the in-process bus + FCM push worker + small wire helpers.
//
// `TunnelState` is the single source of truth for the tunnel (managed by Tauri): it holds the
// desktop's static Noise identity, the pane metadata pushed from the frontend, the broadcast
// channels the relay transport subscribes to, and the FCM token set + push queue. The Tauri
// commands that mutate/read it live in the sibling `commands` module; the relay transport that
// drains it lives in `transport`. Fields/methods reached from those siblings (and the test
// module) are `pub(super)` — visible within the `tunnel` module tree, private outside it.

use crate::StrErr;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tokio::sync::{broadcast, mpsc, watch};

use crate::mobile::fcm::{self, FcmSender, SendOutcome};

use super::noise;
use super::protocol::*;

// ── Tunnel state (the in-process bus) ───────────────────────────────────────────

pub(super) struct Inner {
    pub(super) running: bool,
    pub(super) relay_url: Option<String>,
    pub(super) room: Option<String>,
    /// Pre-shared pairing secret (the `token` the mobile sends in its `auth` frame,
    /// carried in the QR). Minted on `tunnel_start`; validated inside the Noise session.
    pub(super) psk: String,
    pub(super) panes: Vec<PaneDescriptor>,
    pub(super) sessions: HashMap<String, SessionMeta>,
    /// Latest known PTY grid size per pane (cols, rows). Broadcast to mobile so it can
    /// render at the desktop's width; replayed to freshly-paired clients.
    pub(super) sizes: HashMap<String, (u16, u16)>,
    pub(super) client_count: usize,
    /// View-only gate (#B-wan-viewonly): `false` until the desktop grants input. While
    /// `false`, PTY-mutating mobile frames (keystrokes, resize) are dropped. Reset to
    /// `false` on every `tunnel_start`/`tunnel_stop` so each pairing starts view-only.
    pub(super) input_granted: bool,
    /// Whether we've already notified the desktop that a view-only phone tried to send
    /// input, so the per-keystroke drop doesn't spam the frontend with prompts. Cleared
    /// when input is (re)granted/revoked or a new session begins.
    pub(super) input_requested: bool,
    /// Send `true` to signal the relay transport task(s) to stop (#242b).
    pub(super) shutdown_tx: Option<watch::Sender<bool>>,
    // ── Planner sync (#588) ──────────────────────────────────────────────────
    /// Plan manifests per projectId — pushed by the frontend so mobile can request
    /// them via PlanSyncManifestRequest. relpath → hex hash.
    pub(super) plan_manifests: HashMap<String, HashMap<String, String>>,
    /// Full plan file caches per projectId — pushed by the frontend so mobile can
    /// pull individual files via PlanSyncPull.
    pub(super) plan_files: HashMap<String, Vec<PlanFile>>,
    // ── Live planning session (PT1 / #934) ───────────────────────────────────
    /// Last `plan_state` / `plan_status` frame per projectId — replayed to a freshly-paired
    /// client so it mirrors the live session immediately. `plan_event` is transient (not stored).
    pub(super) plan_states: HashMap<String, ServerMsg>,
    pub(super) plan_statuses: HashMap<String, ServerMsg>,
    // ── Fleet / coordination (F2) ────────────────────────────────────────────
    /// Latest fleet roster — replayed to freshly-paired mobile clients.
    pub(super) fleet_sessions: Vec<FleetSession>,
    // ── Automations (A2) ────────────────────────────────────────────────────
    /// Latest automation list — replayed to freshly-paired mobile clients.
    pub(super) automations: Vec<AutomationFrame>,
    // ── MCP extensions (M2) ─────────────────────────────────────────────────
    /// Latest MCP extension list — replayed to freshly-paired mobile clients.
    pub(super) mcp_extensions: Vec<McpExtFrame>,
    // ── Hook telemetry (M3 / #937) ──────────────────────────────────────────
    /// Latest aggregated hook-fire telemetry — replayed to freshly-paired mobile clients.
    /// `None` until the frontend pushes the first summary (read-only projection).
    pub(super) hook_telemetry: Option<HookTelemetryFrame>,
    // ── Generic store projections (#2497) ────────────────────────────────────
    /// Last `store_state` frame per domain (see `protocol::store_domains`) — replayed to a
    /// freshly-paired client so every published projection arrives on connect. Only the
    /// LAST frame per domain is kept (the frame is a full snapshot, `rev` orders them).
    pub(super) store_states: HashMap<String, ServerMsg>,
}

/// Single source of truth for the tunnel, managed by Tauri. Holds the desktop's static
/// Noise identity, the pane metadata pushed from the frontend, and the broadcast
/// channels the relay transport subscribes to. Created once at startup; the transport
/// is attached later (#242b).
pub struct TunnelState {
    pub(super) inner: Mutex<Inner>,
    /// High-volume raw PTY output, fanned out to the transport (filtered per-pane).
    output_tx: broadcast::Sender<PaneOutputChunk>,
    /// Low-volume control events (pane_list / session_state / user_request).
    pub(super) event_tx: broadcast::Sender<ServerMsg>,
    /// The desktop's long-lived Noise static keypair (identity proven to mobile).
    pub(super) static_priv: Vec<u8>,
    pub(super) static_pub: Vec<u8>,
    /// FCM registration tokens of paired devices (#846), captured from the auth handshake
    /// and `set_fcm_token` refreshes. Shared with the push worker so it can drop a token
    /// the moment FCM reports it stale. A `HashSet` dedupes a re-auth re-sending the same
    /// token. In-memory only — re-populated on the next pairing after a desktop restart.
    pub(super) fcm_tokens: Arc<Mutex<HashSet<String>>>,
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
    /// One alert from the #2498 taxonomy (the `alerts` store_state domain's push companion).
    /// The frontend composes title/body; `kind` routes the tap on mobile.
    Alert { kind: String, title: String, body: String, pane_id: String },
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
                            PushJob::Alert { kind, title, body, pane_id } =>
                                fcm::build_alert_message(token, kind, title, body, pane_id),
                        };
                        match sender.send_built(msg).await {
                            SendOutcome::Sent => {
                                log::debug!("fcm: pushed {:?}", match &job {
                                    PushJob::UserRequest { pane_id, .. } => format!("user_request pane={pane_id}"),
                                    PushJob::CoordWait { session, .. } => format!("coord_wait session={session}"),
                                    PushJob::AutomFailed { name, .. } => format!("autom_failed name={name}"),
                                    PushJob::Warden { session, .. } => format!("warden_quarantine session={session}"),
                                    PushJob::Alert { kind, pane_id, .. } => format!("alert kind={kind} pane={pane_id}"),
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
                hook_telemetry: None,
                store_states: HashMap::new(),
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

    /// Enqueue a `PushJob` for the paired device(s). Non-blocking — the actual HTTP send happens
    /// on the push worker. No-op when there are no stored tokens (no phone has paired / shared a
    /// token this session). The shared guard + send behind the `enqueue_*_push` helpers.
    fn enqueue(&self, job: PushJob) {
        if self.fcm_tokens.lock().unwrap().is_empty() {
            return;
        }
        let _ = self.push_tx.send(job);
    }

    /// Queue an FCM `user_request` push for the paired device(s). Non-blocking — the actual
    /// HTTP send happens on the push worker. No-op when there are no stored tokens (no phone
    /// has paired / shared a token this session).
    pub(super) fn enqueue_user_request_push(&self, pane_id: &str, prompt: &str, session_name: &str) {
        self.enqueue(PushJob::UserRequest {
            pane_id: pane_id.to_string(),
            prompt: prompt.to_string(),
            session_name: session_name.to_string(),
        });
    }

    /// Queue an FCM `coord_wait` push (F4). Non-blocking. No-op without stored tokens.
    pub(super) fn enqueue_coord_wait_push(&self, session: &str, reason: &str) {
        self.enqueue(PushJob::CoordWait {
            session: session.to_string(),
            reason: reason.to_string(),
        });
    }

    /// Queue an FCM `autom_failed` push (A4). Non-blocking. No-op without stored tokens.
    pub(super) fn enqueue_autom_failed_push(&self, name: &str, error: &str) {
        self.enqueue(PushJob::AutomFailed {
            name: name.to_string(),
            error: error.to_string(),
        });
    }

    /// Queue an FCM `warden_quarantine` push (#1102). Non-blocking. No-op without stored tokens.
    pub(super) fn enqueue_warden_push(&self, session: &str, detail: &str) {
        self.enqueue(PushJob::Warden {
            session: session.to_string(),
            detail: detail.to_string(),
        });
    }

    /// Queue an FCM push for one #2498 alert. Non-blocking. No-op without stored tokens.
    pub(super) fn enqueue_alert_push(&self, kind: &str, title: &str, body: &str, pane_id: &str) {
        self.enqueue(PushJob::Alert {
            kind: kind.to_string(),
            title: title.to_string(),
            body: body.to_string(),
            pane_id: pane_id.to_string(),
        });
    }

    /// base64 of the static public key — embedded in the pairing QR (#243).
    pub fn host_pub_key_b64(&self) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(&self.static_pub)
    }

    /// Subscribe to the PTY-output fan-out (the relay transport calls this per client).
    pub(super) fn subscribe_output(&self) -> broadcast::Receiver<PaneOutputChunk> {
        self.output_tx.subscribe()
    }

    /// Subscribe to control events (pane_list / session_state / user_request).
    pub(super) fn subscribe_events(&self) -> broadcast::Receiver<ServerMsg> {
        self.event_tx.subscribe()
    }

    /// Tee one PTY output chunk to the relay transport. Called from the `lib.rs`
    /// emitter thread on every flush. No-op (and no allocation) when nobody is
    /// connected, so the tunnel costs nothing while idle.
    pub fn broadcast_output(&self, pane_id: &str, data: &str) {
        if self.output_tx.receiver_count() == 0 {
            return;
        }
        let _ = self.output_tx.send(PaneOutputChunk {
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
    pub(super) fn pane_sizes(&self) -> Vec<(String, u16, u16)> {
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
    pub(super) fn psk(&self) -> String {
        self.inner.lock().unwrap().psk.clone()
    }

    /// Whether the desktop has granted the paired phone input control (#B-wan-viewonly).
    /// `false` (view-only) drops PTY-mutating mobile frames in `handle_client_msg`.
    pub(super) fn input_granted(&self) -> bool {
        self.inner.lock().unwrap().input_granted
    }

    /// Grant or revoke the paired phone's input control. Resets the "input requested"
    /// notification latch so a later view-only attempt re-prompts the desktop.
    pub(super) fn set_input_granted(&self, granted: bool) {
        let mut inner = self.inner.lock().unwrap();
        inner.input_granted = granted;
        inner.input_requested = false;
    }

    /// Latch the first view-only input attempt: returns `true` exactly once per session
    /// (until input is granted/revoked or the session restarts), so the desktop is
    /// prompted to grant input once rather than on every dropped keystroke.
    pub(super) fn take_input_request(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.input_requested {
            return false;
        }
        inner.input_requested = true;
        true
    }

    /// Snapshot the pane list + session metadata to replay to a freshly-paired client.
    pub(super) fn snapshot(&self) -> (Vec<PaneDescriptor>, Vec<SessionMeta>) {
        let inner = self.inner.lock().unwrap();
        (inner.panes.clone(), inner.sessions.values().cloned().collect())
    }

    /// Snapshot all stored plan manifests to replay to a freshly-paired mobile client.
    pub(super) fn plan_manifests_snapshot(&self) -> HashMap<String, HashMap<String, String>> {
        self.inner.lock().unwrap().plan_manifests.clone()
    }

    /// The last `plan_state` + `plan_status` frames (across projects) to replay on connect (#934).
    pub(super) fn plan_frames_snapshot(&self) -> Vec<ServerMsg> {
        let inner = self.inner.lock().unwrap();
        inner.plan_states.values().cloned().chain(inner.plan_statuses.values().cloned()).collect()
    }

    pub(super) fn fleet_snapshot(&self) -> Vec<FleetSession> {
        self.inner.lock().unwrap().fleet_sessions.clone()
    }

    pub(super) fn automations_snapshot(&self) -> Vec<AutomationFrame> {
        self.inner.lock().unwrap().automations.clone()
    }

    pub(super) fn mcp_snapshot(&self) -> Vec<McpExtFrame> {
        self.inner.lock().unwrap().mcp_extensions.clone()
    }

    /// The last aggregated hook-fire telemetry summary to replay to a freshly-paired client
    /// (M3 / #937). `None` until the frontend has pushed one.
    pub(super) fn hook_telemetry_snapshot(&self) -> Option<HookTelemetryFrame> {
        self.inner.lock().unwrap().hook_telemetry.clone()
    }

    /// The last `store_state` frame per domain (#2497), sorted by domain for a
    /// deterministic replay order. Empty until the frontend publishes a projection.
    pub(super) fn store_states_snapshot(&self) -> Vec<ServerMsg> {
        let inner = self.inner.lock().unwrap();
        let mut domains: Vec<&String> = inner.store_states.keys().collect();
        domains.sort();
        domains.into_iter().map(|d| inner.store_states[d].clone()).collect()
    }

    /// Record how many mobile clients are connected (for the settings card).
    pub(super) fn set_client_count(&self, n: usize) {
        self.inner.lock().unwrap().client_count = n;
    }

    pub(super) fn status_locked(&self, inner: &Inner) -> TunnelStatus {
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

    /// Store a pushed snapshot under the lock, then broadcast `msg` to connected clients.
    /// Shared by the metadata-push setters (`tunnel_set_panes` / `tunnel_set_fleet_state` /
    /// `tunnel_set_automations` / `tunnel_set_mcp_state` / `tunnel_set_hook_telemetry`), which all follow the same
    /// store-then-broadcast shape (only the field written, the log line, and the broadcast
    /// variant differ — those stay at the call site).
    pub(super) fn set_and_broadcast(&self, msg: ServerMsg, set: impl FnOnce(&mut Inner)) {
        {
            let mut inner = self.inner.lock().unwrap();
            set(&mut inner);
        }
        let _ = self.event_tx.send(msg);
    }
}

impl Default for TunnelState {
    fn default() -> Self {
        Self::new()
    }
}

/// Build a `session_state` event from a pushed snapshot.
pub(super) fn session_state_msg(s: &SessionMeta) -> ServerMsg {
    ServerMsg::SessionState {
        pane_id: s.pane_id.clone(),
        status: s.status.clone(),
        current_task: s.current_task.clone(),
        last_activity: s.last_activity.clone(),
        prompt: s.prompt.clone(),
    }
}

/// FNV-1a 32-bit hash of a UTF-8 string, returned as a lowercase 8-char hex string.
/// Mirrors the TS `fnv1a32hex` in src/lib/plannerCore/hash.ts; both hash UTF-8 bytes.
/// Test vectors pinned in src/lib/plannerCore.fixtures.json (fnv1a32 section).
pub(super) fn fnv1a32_hex(s: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for b in s.bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x01000193);
    }
    format!("{h:08x}")
}

/// Decrypt + deserialize one Noise transport frame into a client message. Kept at module
/// scope (not in `transport`) so the tests can exercise it against the protocol types.
pub(super) fn decode_room_msg(tx: &mut snow::TransportState, frame: &[u8]) -> Result<ClientMsg, String> {
    let mut out = vec![0u8; frame.len()];
    let n = tx.read_message(frame, &mut out).str_err()?;
    out.truncate(n);
    serde_json::from_slice(&out).str_err()
}
