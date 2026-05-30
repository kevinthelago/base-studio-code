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

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::{broadcast, watch};

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
    #[serde(rename_all = "camelCase")]
    PaneSetState { pane_id: String, state: String },
    #[serde(rename_all = "camelCase")]
    PaneFocus { pane_id: String },
    #[serde(rename_all = "camelCase")]
    PaneInput { pane_id: String, data: String },
    #[serde(rename_all = "camelCase")]
    PaneResize { pane_id: String, cols: u16, rows: u16 },
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
    pub client_count: usize,
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
            .local_private_key(static_priv)
            .build_responder()
    }

    /// Build the initiator handshake (mobile side) from its static private key plus the
    /// responder's static public key (learned from the QR). Used by the mobile client
    /// and the crypto tests here.
    #[allow(dead_code)] // mirrors the mobile initiator; exercised by tests + #242b
    pub fn initiator(static_priv: &[u8], remote_pub: &[u8]) -> Result<HandshakeState, snow::Error> {
        Builder::new(PARAMS.parse().expect("valid noise params"))
            .local_private_key(static_priv)
            .remote_public_key(remote_pub)
            .build_initiator()
    }
}

// ── Tunnel state (the in-process bus) ───────────────────────────────────────────

struct Inner {
    running: bool,
    relay_url: Option<String>,
    room: Option<String>,
    panes: Vec<PaneDescriptor>,
    sessions: HashMap<String, SessionMeta>,
    client_count: usize,
    /// Send `true` to signal the relay transport task(s) to stop (#242b).
    shutdown_tx: Option<watch::Sender<bool>>,
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
        TunnelState {
            inner: Mutex::new(Inner {
                running: false,
                relay_url: None,
                room: None,
                panes: Vec::new(),
                sessions: HashMap::new(),
                client_count: 0,
                shutdown_tx: None,
            }),
            output_tx,
            event_tx,
            static_priv,
            static_pub,
        }
    }

    /// The desktop's static private key (used by the relay transport's responder, #242b).
    #[allow(dead_code)]
    pub(crate) fn static_private_key(&self) -> &[u8] {
        &self.static_priv
    }

    /// base64 of the static public key — embedded in the pairing QR (#243).
    pub fn host_pub_key_b64(&self) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(&self.static_pub)
    }

    /// Subscribe to the PTY-output fan-out (the relay transport calls this per client).
    #[allow(dead_code)]
    pub(crate) fn subscribe_output(&self) -> broadcast::Receiver<PaneOutput> {
        self.output_tx.subscribe()
    }

    /// Subscribe to control events (pane_list / session_state / user_request).
    #[allow(dead_code)]
    pub(crate) fn subscribe_events(&self) -> broadcast::Receiver<ServerMsg> {
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

    /// Signal the relay transport (if any) to shut down — called on app exit.
    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(tx) = inner.shutdown_tx.take() {
            let _ = tx.send(true);
        }
        inner.running = false;
        inner.client_count = 0;
    }

    fn status_locked(&self, inner: &Inner) -> TunnelStatus {
        TunnelStatus {
            running: inner.running,
            relay_url: inner.relay_url.clone(),
            room: inner.room.clone(),
            host_pub_key: self.host_pub_key_b64(),
            client_count: inner.client_count,
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
    let mut newly_awaiting: Vec<(String, String)> = Vec::new();
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
                    newly_awaiting.push((s.pane_id.clone(), prompt.clone()));
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
    for (pane_id, prompt) in newly_awaiting {
        let _ = state.event_tx.send(ServerMsg::UserRequest { pane_id, prompt });
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

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
}
