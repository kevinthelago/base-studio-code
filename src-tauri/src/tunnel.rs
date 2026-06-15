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

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::sync::{broadcast, mpsc, watch};

use crate::fcm::{self, FcmSender, SendOutcome};

// ── Wire protocol ───────────────────────────────────────────────────────────────
// Conforms to the shipped mobile client (mobile-studio-code/src/lib/types.ts). The
// shared fixture (../src/lib/tunnelProtocol.fixtures.json) pins the exact byte shape;
// `shared_fixture_matches_serde` (below) fails CI on any drift (#46).

/// One mirrored pane as the mobile client lists it. Mirrors mobile `PaneDescriptor`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PaneDescriptor {
    pub id: String,
    pub cwd: String,
    pub name: String,
    /// One of `running | idle | awaiting_input | error` (mobile `PaneStatus`).
    pub status: String,
}

/// A pushed session-state snapshot from the frontend (camelCase on the wire).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub pane_id: String,
    pub status: String,
    pub current_task: String,
    /// ISO-8601 timestamp string (produced by the frontend).
    pub last_activity: String,
    /// Populated when `status == "awaiting_input"`.
    pub prompt: Option<String>,
}

/// One plan file in the canonical planner-sync representation.
/// Mirrors TS `CanonicalFile` in src/lib/plannerCore/types.ts.
/// Pinned wire shape in src/lib/plannerCore.fixtures.json (wireFrames.plan_sync_files).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlanFile {
    pub relpath: String,
    pub content: String,
}

/// Messages the desktop sends to the mobile client. Tagged by snake_case `type`.
/// `AuthOk` / `PaneOutput` are emitted by the relay transport (#242b); the rest are
/// emitted now by the metadata-push commands.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(dead_code)]
pub enum ServerMsg {
    AuthOk,
    PaneList {
        panes: Vec<PaneDescriptor>,
    },
    #[serde(rename_all = "camelCase")]
    PaneOutput {
        pane_id: String,
        data: String,
        coarse: bool,
    },
    /// The PTY grid size a pane's output is rendered for. Mobile sets its terminal to
    /// these cols/rows so the byte stream's baked line-wrapping + cursor positioning
    /// line up (otherwise a phone-width terminal garbles desktop-width output). Sent on
    /// pairing replay and whenever the desktop PTY resizes.
    #[serde(rename_all = "camelCase")]
    PaneSize {
        pane_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename_all = "camelCase")]
    SessionState {
        pane_id: String,
        status: String,
        current_task: String,
        last_activity: String,
        prompt: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    UserRequest {
        pane_id: String,
        prompt: String,
    },
    // ── Planner sync (#588) ──────────────────────────────────────────────────
    /// Desktop pushes its plan manifest (relpath → hex hash) to mobile.
    /// Also sent proactively on connect so mobile can start reconciling immediately.
    #[serde(rename_all = "camelCase")]
    PlanSyncManifest {
        project_id: String,
        /// relpath → lowercase 8-char hex FNV-1a 32-bit content hash.
        files: HashMap<String, String>,
    },
    /// Desktop sends requested plan files to mobile (response to PlanSyncPull).
    #[serde(rename_all = "camelCase")]
    PlanSyncFiles {
        project_id: String,
        files: Vec<PlanFile>,
    },
    /// Desktop acknowledges a plan push from mobile.
    #[serde(rename_all = "camelCase")]
    PlanSyncAck {
        project_id: String,
        applied: bool,
    },
}

/// Messages the mobile client sends to the desktop. Tagged by snake_case `type`.
/// (Consumed by the relay transport in #242b; retained here as the shared contract.)
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(dead_code)]
pub enum ClientMsg {
    #[serde(rename_all = "camelCase")]
    Auth {
        token: String,
        #[serde(default)]
        fcm_token: Option<String>,
    },
    /// Mobile pushes a refreshed FCM registration token mid-session (#846). The initial
    /// token rides in `Auth.fcmToken`; FCM tokens rotate, so the client re-sends here and
    /// the desktop updates its push target. Allowed even while view-only (it's not a
    /// PTY-mutating frame).
    #[serde(rename_all = "camelCase")]
    SetFcmToken { fcm_token: String },
    #[serde(rename_all = "camelCase")]
    PaneSetState { pane_id: String, state: String },
    #[serde(rename_all = "camelCase")]
    PaneFocus { pane_id: String },
    #[serde(rename_all = "camelCase")]
    PaneInput { pane_id: String, data: String },
    #[serde(rename_all = "camelCase")]
    PaneResize { pane_id: String, cols: u16, rows: u16 },
    // ── Planner sync (#588) ──────────────────────────────────────────────────
    /// Mobile requests the desktop's current plan manifest for a project.
    #[serde(rename_all = "camelCase")]
    PlanSyncManifestRequest { project_id: String },
    /// Mobile requests specific files from the desktop's plan.
    #[serde(rename_all = "camelCase")]
    PlanSyncPull {
        project_id: String,
        /// Relpaths of the files to retrieve.
        paths: Vec<String>,
    },
    /// Mobile pushes its merged plan state to the desktop (desktop is not the merge
    /// authority in v1 — it applies the push and acks; no conflict frames returned).
    #[serde(rename_all = "camelCase")]
    PlanSyncPush {
        project_id: String,
        files: Vec<PlanFile>,
    },
}

/// One PTY output chunk fanned out to the relay transport (which filters per pane).
/// The fields are read by that transport (#242b).
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct PaneOutput {
    pub pane_id: String,
    pub data: String,
}

/// Relay-shaped status for the "Mobile tunnel" settings card. Unlike the LAN design,
/// trust comes from Noise (the QR carries `hostPubKey`), not a pinned cert.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub running: bool,
    /// The relay Worker URL this desktop dials (set once a transport connects, #242b).
    pub relay_url: Option<String>,
    /// The room id allocated for the current pairing (#242b).
    pub room: Option<String>,
    /// base64 of the desktop's static Noise public key — goes into the pairing QR.
    pub host_pub_key: String,
    /// The pairing secret the mobile echoes in its `auth` frame — goes into the QR.
    /// Empty until `tunnel_start` mints it. Carried only inside the QR, never shown.
    pub psk: String,
    pub client_count: usize,
    /// Whether the desktop has granted the paired phone input control. A freshly paired
    /// phone is **view-only** (`false`): keystrokes/resizes are dropped until the desktop
    /// flips this with `tunnel_set_input_granted` (#B-wan-viewonly).
    pub input_granted: bool,
}

// ── Noise IK end-to-end crypto ──────────────────────────────────────────────────

/// Noise helpers for the tunnel's end-to-end session. The desktop is the **responder**
/// and holds a static keypair; the mobile is the **initiator** and learns the desktop's
/// static public key out-of-band (the QR), giving mutual auth + forward secrecy + MITM
/// resistance against a malicious relay. The transport in #242b drives these.
pub mod noise {
    use snow::{Builder, HandshakeState, Keypair};

    /// Noise pattern: IK (initiator knows responder's static key up front),
    /// X25519 DH, ChaChaPoly AEAD, BLAKE2s hash.
    pub const PARAMS: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";

    /// Generate a fresh static keypair (the desktop's long-lived identity).
    pub fn generate_keypair() -> Result<Keypair, snow::Error> {
        Builder::new(PARAMS.parse().expect("valid noise params")).generate_keypair()
    }

    /// Build the responder handshake (desktop side) from its static private key. It
    /// does NOT pre-know the initiator's static key — IK reveals it during the handshake.
    #[allow(dead_code)] // wired into the relay transport in #242b
    pub fn responder(static_priv: &[u8]) -> Result<HandshakeState, snow::Error> {
        Builder::new(PARAMS.parse().expect("valid noise params"))
            .local_private_key(static_priv)?
            .build_responder()
    }

    /// Build the initiator handshake (mobile side) from its static private key plus the
    /// responder's static public key (learned from the QR). Used by the mobile client
    /// and the crypto tests here.
    #[allow(dead_code)] // mirrors the mobile initiator; exercised by tests + #242b
    pub fn initiator(static_priv: &[u8], remote_pub: &[u8]) -> Result<HandshakeState, snow::Error> {
        Builder::new(PARAMS.parse().expect("valid noise params"))
            .local_private_key(static_priv)?
            .remote_public_key(remote_pub)?
            .build_initiator()
    }
}

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

/// One queued FCM push: a `user_request` transition that should notify every paired device.
/// The worker reads the live token set itself (so it always uses the latest), so the job
/// only carries the per-request content.
struct PushJob {
    pane_id: String,
    prompt: String,
    /// Human-readable banner title — the pane/session name.
    session_name: String,
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
                    for token in targets {
                        match sender.send(&token, &job.pane_id, &job.prompt, &job.session_name).await {
                            SendOutcome::Sent => {
                                log::debug!("fcm: pushed user_request for pane {}", job.pane_id);
                            }
                            SendOutcome::DropToken => {
                                tokens.lock().unwrap().remove(&token);
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
        let _ = self.push_tx.send(PushJob {
            pane_id: pane_id.to_string(),
            prompt: prompt.to_string(),
            session_name: session_name.to_string(),
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

mod transport {
    use super::{
        decode_room_msg, noise, ClientMsg, PaneOutput, ServerMsg, SessionMeta, TunnelState,
    };
    use futures_util::stream::{SplitSink, SplitStream};
    use futures_util::{SinkExt, StreamExt};
    use serde::Serialize;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager};
    use tokio::net::TcpStream;
    use tokio::sync::{broadcast, watch};
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

    type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;
    type WsSink = SplitSink<Ws, Message>;
    type WsStream = SplitStream<Ws>;

    /// Noise transport messages cap at 65535 bytes; keep app-plaintext well under that
    /// (the JSON wrapper + AEAD tag add overhead), splitting large PTY output into
    /// several `pane_output` frames.
    const MAX_PLAINTEXT: usize = 48 * 1024;

    /// A high-entropy, URL-safe room id matching the relay's `validateRoomId`
    /// (`[A-Za-z0-9_-]{16,64}`) — 24 random bytes → 32 base64url chars.
    pub fn generate_room_id() -> String {
        use base64::Engine;
        let bytes: [u8; 24] = rand::random();
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    }

    /// A pre-shared pairing secret (hex of 32 random bytes) — the mobile sends it back
    /// inside the Noise session as its `auth` token.
    pub fn generate_psk() -> String {
        let bytes: [u8; 32] = rand::random();
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Split a string into ≤ `max`-byte pieces on char boundaries (never mid-codepoint).
    pub fn split_utf8(s: &str, max: usize) -> Vec<&str> {
        if s.len() <= max {
            return if s.is_empty() { vec![] } else { vec![s] };
        }
        let mut out = Vec::new();
        let mut start = 0;
        while start < s.len() {
            let mut end = (start + max).min(s.len());
            while end > start && !s.is_char_boundary(end) {
                end -= 1;
            }
            out.push(&s[start..end]);
            start = end;
        }
        out
    }

    /// Constant-time string compare for the pairing secret.
    fn ct_eq(a: &str, b: &str) -> bool {
        let (a, b) = (a.as_bytes(), b.as_bytes());
        if a.len() != b.len() {
            return false;
        }
        let mut diff = 0u8;
        for (x, y) in a.iter().zip(b.iter()) {
            diff |= x ^ y;
        }
        diff == 0
    }

    /// Encrypt a JSON-serialized message into one Noise transport frame.
    pub fn encode<T: Serialize>(tx: &mut snow::TransportState, msg: &T) -> Result<Vec<u8>, String> {
        let json = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; json.len() + 16];
        let n = tx.write_message(&json, &mut buf).map_err(|e| e.to_string())?;
        buf.truncate(n);
        Ok(buf)
    }

    async fn send_msg(sink: &mut WsSink, tx: &mut snow::TransportState, msg: &ServerMsg) -> Result<(), String> {
        let frame = encode(tx, msg)?;
        sink.send(Message::Binary(frame.into())).await.map_err(|e| e.to_string())
    }

    async fn send_output(sink: &mut WsSink, tx: &mut snow::TransportState, po: &PaneOutput) -> Result<(), String> {
        for chunk in split_utf8(&po.data, MAX_PLAINTEXT) {
            let msg = ServerMsg::PaneOutput {
                pane_id: po.pane_id.clone(),
                data: chunk.to_string(),
                coarse: false,
            };
            send_msg(sink, tx, &msg).await?;
        }
        Ok(())
    }

    /// Read the next binary WebSocket frame, skipping text/ping/pong; `Err` on close.
    async fn next_binary(read: &mut WsStream) -> Result<Vec<u8>, String> {
        loop {
            match read.next().await {
                Some(Ok(Message::Binary(b))) => return Ok(b.to_vec()),
                Some(Ok(Message::Close(_))) | None => return Err("connection closed".into()),
                Some(Ok(_)) => continue,
                Some(Err(e)) => return Err(e.to_string()),
            }
        }
    }

    /// Reconnect loop: dial the relay, run one session, back off, repeat until shutdown.
    pub async fn run(
        app: AppHandle,
        relay_url: String,
        room: String,
        static_priv: Vec<u8>,
        mut shutdown_rx: watch::Receiver<bool>,
    ) {
        let mut backoff = 1u64;
        loop {
            if *shutdown_rx.borrow() {
                break;
            }
            log::info!("tunnel: connecting to relay (room {room})");
            match session(&app, &relay_url, &room, &static_priv, &mut shutdown_rx).await {
                Ok(()) => {
                    backoff = 1;
                    log::info!("tunnel: relay session closed cleanly");
                }
                Err(e) => log::warn!("tunnel: relay session ended: {e}"),
            }
            if let Some(ts) = app.try_state::<TunnelState>() {
                ts.set_client_count(0);
            }
            if *shutdown_rx.borrow() {
                break;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(backoff)) => {}
                _ = shutdown_rx.changed() => {}
            }
            backoff = (backoff * 2).min(30);
        }
        log::info!("tunnel: relay client stopped");
    }

    /// One relay session: dial, Noise handshake (responder), authenticate, replay, pump.
    async fn session(
        app: &AppHandle,
        relay_url: &str,
        room: &str,
        static_priv: &[u8],
        shutdown_rx: &mut watch::Receiver<bool>,
    ) -> Result<(), String> {
        let scheme = if relay_url.starts_with("http") {
            relay_url.replacen("http", "ws", 1)
        } else {
            relay_url.to_string()
        };
        let url = format!("{scheme}/connect?room={room}&role=host");
        log::debug!("tunnel: dialing host websocket {url}");
        // `connect_async` has no built-in timeout: a stalled TLS/WS upgrade would hang
        // forever — never entering the room, never erroring, never logging. Bound it so a
        // hang becomes a logged error + backoff reconnect instead of silent death.
        let (ws, _) = match tokio::time::timeout(Duration::from_secs(15), connect_async(&url)).await {
            Ok(Ok(pair)) => pair,
            Ok(Err(e)) => return Err(format!("relay dial failed: {e}")),
            Err(_) => return Err("relay dial timed out after 15s (no TLS/WS upgrade response)".into()),
        };
        let (mut sink, mut read) = ws.split();
        log::info!("tunnel: connected to relay as host; waiting for mobile peer (room {room})");

        // Noise IK responder: read the mobile's first handshake message, answer it.
        let mut hs = noise::responder(static_priv).map_err(|e| e.to_string())?;
        let mut scratch = vec![0u8; 65535];
        let msg1 = next_binary(&mut read).await?;
        log::info!("tunnel: peer joined — handshake msg1 received ({} bytes)", msg1.len());
        hs.read_message(&msg1, &mut scratch)
            .map_err(|e| format!("handshake msg1 read failed: {e}"))?;
        let n = hs
            .write_message(&[], &mut scratch)
            .map_err(|e| format!("handshake msg2 write failed: {e}"))?;
        sink.send(Message::Binary(scratch[..n].to_vec().into())).await.map_err(|e| e.to_string())?;
        log::debug!("tunnel: handshake msg2 sent ({n} bytes); awaiting auth");
        let mut noise_tx = hs.into_transport_mode().map_err(|e| e.to_string())?;

        // First app frame must be `auth`; validate the pairing secret.
        let frame = next_binary(&mut read).await?;
        match decode_room_msg(&mut noise_tx, &frame)? {
            ClientMsg::Auth { token, fcm_token } => {
                let psk = app
                    .try_state::<TunnelState>()
                    .map(|s| s.psk())
                    .unwrap_or_default();
                if !ct_eq(&token, &psk) {
                    log::warn!("tunnel: auth rejected — pairing secret mismatch (stale QR or wrong desktop?)");
                    return Err("auth rejected (bad pairing secret)".into());
                }
                // Persist the device's FCM push token (#846) so a `user_request` can reach it
                // even after the app backgrounds/quits and drops this relay connection.
                if let (Some(state), Some(t)) = (app.try_state::<TunnelState>(), fcm_token) {
                    state.add_fcm_token(t);
                }
                log::info!("tunnel: auth accepted");
            }
            _ => return Err("expected auth as the first frame".into()),
        }
        send_msg(&mut sink, &mut noise_tx, &ServerMsg::AuthOk).await?;

        // Replay current pane list + session state to the freshly-paired client.
        let (panes, sessions): (Vec<_>, Vec<SessionMeta>) = app
            .try_state::<TunnelState>()
            .map(|s| s.snapshot())
            .unwrap_or_default();
        send_msg(&mut sink, &mut noise_tx, &ServerMsg::PaneList { panes }).await?;
        for s in &sessions {
            send_msg(&mut sink, &mut noise_tx, &super::session_state_msg(s)).await?;
        }
        // Replay each pane's current PTY size so mobile renders at the desktop's width
        // before any output arrives.
        let sizes = app.try_state::<TunnelState>().map(|s| s.pane_sizes()).unwrap_or_default();
        for (pane_id, cols, rows) in sizes {
            send_msg(&mut sink, &mut noise_tx, &ServerMsg::PaneSize { pane_id, cols, rows }).await?;
        }

        // Replay plan manifests so mobile can start reconciling immediately (#588).
        let plan_manifests = app
            .try_state::<TunnelState>()
            .map(|s| s.plan_manifests_snapshot())
            .unwrap_or_default();
        for (project_id, files) in plan_manifests {
            send_msg(&mut sink, &mut noise_tx, &ServerMsg::PlanSyncManifest { project_id, files }).await?;
        }

        // Subscribe AFTER replay so we don't double-send; then pump until either side closes.
        let (mut out_rx, mut evt_rx) = match app.try_state::<TunnelState>() {
            Some(s) => {
                s.set_client_count(1);
                (s.subscribe_output(), s.subscribe_events())
            }
            None => return Err("tunnel state missing".into()),
        };
        let mut focused: Option<String> = None;
        log::info!("tunnel: mobile client paired (room {room})");

        loop {
            tokio::select! {
                biased;
                _ = shutdown_rx.changed() => return Ok(()),
                inbound = next_binary(&mut read) => {
                    let frame = inbound?;
                    match decode_room_msg(&mut noise_tx, &frame) {
                        Ok(msg) => handle_client_msg(app, msg, &mut focused),
                        // A malformed/unknown mobile frame can't be parsed — name it before
                        // the session tears down + reconnects, so a wrong client shape (e.g.
                        // a `pane_input` missing `data`) is diagnosable rather than a silent
                        // reconnect loop.
                        Err(e) => {
                            log::warn!("tunnel: failed to decode mobile frame ({} bytes): {e}", frame.len());
                            return Err(e);
                        }
                    }
                }
                out = out_rx.recv() => match out {
                    Ok(po) => {
                        if focused.as_deref() == Some(po.pane_id.as_str()) {
                            send_output(&mut sink, &mut noise_tx, &po).await?;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("tunnel: dropped {n} output chunk(s) (slow client)");
                    }
                    Err(broadcast::error::RecvError::Closed) => return Ok(()),
                },
                evt = evt_rx.recv() => match evt {
                    Ok(msg) => send_msg(&mut sink, &mut noise_tx, &msg).await?,
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return Ok(()),
                },
            }
        }
    }

    /// Decide whether a decrypted mobile frame may be applied to the desktop PTY given the
    /// view-only gate (#B-wan-viewonly). Keystrokes and resizes require `input_granted`;
    /// focus / set-state / auth frames only steer which pane's output streams back (the
    /// read side), so they are always allowed even while the phone is view-only. Pure so
    /// the gate is unit-testable without an `AppHandle` or a live PTY.
    pub fn input_allowed(msg: &ClientMsg, input_granted: bool) -> bool {
        match msg {
            ClientMsg::PaneInput { .. } | ClientMsg::PaneResize { .. } => input_granted,
            _ => true,
        }
    }

    /// Route a decrypted mobile message: keystrokes/resize to the PTY, focus to filtering.
    /// While the phone is view-only (#B-wan-viewonly), PTY-mutating frames are dropped and
    /// the desktop is prompted once to grant input.
    fn handle_client_msg(app: &AppHandle, msg: ClientMsg, focused: &mut Option<String>) {
        let granted = app
            .try_state::<TunnelState>()
            .map(|s| s.input_granted())
            .unwrap_or(false);
        if !input_allowed(&msg, granted) {
            // Notify the desktop once per session (not per keystroke) so it can offer to
            // grant input; the latch is cleared whenever input is (re)granted/revoked.
            let first = app
                .try_state::<TunnelState>()
                .map(|s| s.take_input_request())
                .unwrap_or(false);
            if first {
                log::info!("tunnel: view-only phone requested input — awaiting desktop grant");
                let _ = app.emit("tunnel://input-requested", ());
            }
            return;
        }
        match msg {
            ClientMsg::PaneInput { pane_id, data } => crate::pty::tunnel_write_pty(app, &pane_id, &data),
            ClientMsg::PaneResize { pane_id, cols, rows } => {
                crate::pty::tunnel_resize_pty(app, &pane_id, cols, rows)
            }
            ClientMsg::PaneFocus { pane_id } => {
                log::debug!("tunnel: focus → pane[{pane_id}]");
                *focused = Some(pane_id);
            }
            ClientMsg::PaneSetState { pane_id, state } => {
                if state == "streaming" {
                    log::debug!("tunnel: stream → pane[{pane_id}]");
                    *focused = Some(pane_id);
                }
            }
            ClientMsg::SetFcmToken { fcm_token } => {
                // FCM tokens rotate; the client re-sends the fresh one (#846).
                if let Some(state) = app.try_state::<TunnelState>() {
                    state.add_fcm_token(fcm_token);
                }
            }
            ClientMsg::Auth { .. } => {} // already authenticated for this session
            // ── Planner sync (#588) ──────────────────────────────────────────
            ClientMsg::PlanSyncManifestRequest { project_id } => {
                if let Some(ts) = app.try_state::<TunnelState>() {
                    let files = ts
                        .inner
                        .lock()
                        .unwrap()
                        .plan_manifests
                        .get(&project_id)
                        .cloned()
                        .unwrap_or_default();
                    log::debug!("tunnel: plan manifest requested for {project_id} ({} files)", files.len());
                    let _ = ts.event_tx.send(ServerMsg::PlanSyncManifest { project_id, files });
                }
            }
            ClientMsg::PlanSyncPull { project_id, paths } => {
                if let Some(ts) = app.try_state::<TunnelState>() {
                    let all = ts
                        .inner
                        .lock()
                        .unwrap()
                        .plan_files
                        .get(&project_id)
                        .cloned()
                        .unwrap_or_default();
                    let path_set: std::collections::HashSet<_> = paths.into_iter().collect();
                    let files: Vec<_> = all.into_iter().filter(|f| path_set.contains(&f.relpath)).collect();
                    log::debug!("tunnel: plan pull for {project_id} — serving {} file(s)", files.len());
                    let _ = ts.event_tx.send(ServerMsg::PlanSyncFiles { project_id, files });
                }
            }
            ClientMsg::PlanSyncPush { project_id, files } => {
                // Emit a Tauri event so the frontend applies the pushed files to the hub dir,
                // then calls tunnel_ack_plan_push with the result.
                log::info!("tunnel: plan push received for {project_id} ({} file(s))", files.len());
                let payload = serde_json::json!({ "projectId": project_id, "files": files });
                let _ = app.emit("tunnel://plan-sync-push", payload);
            }
        }
    }
}

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
            .join("../src/lib/plannerCore.fixtures.json");
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
            .join("../src/lib/tunnelProtocol.fixtures.json");
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
}
