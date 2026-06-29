//! Relay dial-out transport (#1300) — dials the zero-knowledge relay over WebSocket, runs the
//! Noise responder handshake, and pumps the `TunnelState` bus (PTY output + events) to the paired
//! mobile client, routing inbound client frames back. The transport-FREE core lives in the parent.

use super::{
    decode_room_msg, noise, ClientMsg, PaneOutputChunk, ServerMsg, SessionMeta, TunnelState,
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

async fn send_output(sink: &mut WsSink, tx: &mut snow::TransportState, po: &PaneOutputChunk) -> Result<(), String> {
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

    // Replay the last live planner snapshot(s) — plan_state + plan_status — so a
    // freshly-paired phone mirrors the session immediately (#934). plan_event is transient.
    let plan_frames = app.try_state::<TunnelState>().map(|s| s.plan_frames_snapshot()).unwrap_or_default();
    for frame in plan_frames {
        send_msg(&mut sink, &mut noise_tx, &frame).await?;
    }

    // Replay fleet roster (F2) — non-empty only after the fleet has launched.
    let fleet = app.try_state::<TunnelState>().map(|s| s.fleet_snapshot()).unwrap_or_default();
    if !fleet.is_empty() {
        send_msg(&mut sink, &mut noise_tx, &ServerMsg::FleetRoster { sessions: fleet }).await?;
    }

    // Replay automation list (A2).
    let automations = app.try_state::<TunnelState>().map(|s| s.automations_snapshot()).unwrap_or_default();
    if !automations.is_empty() {
        send_msg(&mut sink, &mut noise_tx, &ServerMsg::AutomationList { automations }).await?;
    }

    // Replay MCP extension list (M2).
    let mcp = app.try_state::<TunnelState>().map(|s| s.mcp_snapshot()).unwrap_or_default();
    if !mcp.is_empty() {
        send_msg(&mut sink, &mut noise_tx, &ServerMsg::McpList { extensions: mcp }).await?;
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
            inbound = read.next() => match inbound {
                Some(Ok(Message::Binary(b))) => {
                    let frame = b.to_vec();
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
                // Relay closed the room — distinguish idle/TTL expiry from a transient
                // disconnect so the frontend can prompt the user to re-pair (#T5).
                Some(Ok(Message::Close(cf))) => {
                    let reason = cf.as_ref().map(|f| f.reason.as_ref()).unwrap_or("");
                    if reason.contains("idle timeout") || reason.contains("lifetime exceeded") {
                        log::info!("tunnel: relay room expired ({reason}); reconnecting");
                        let _ = app.emit("tunnel://room-expired",
                            serde_json::json!({ "reason": reason }));
                    }
                    return Ok(());
                }
                Some(Ok(_)) => {}    // ping/pong/text — relay heartbeat, ignore
                None => return Ok(()),  // clean EOF, backoff resets
                Some(Err(e)) => return Err(e.to_string()),
            },
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
        // PTY mutation + planner drive (advance/confirm/chat) require an explicit grant —
        // a view-only phone can mirror the planning session but cannot steer it (#934).
        ClientMsg::PaneInput { .. }
        | ClientMsg::PaneResize { .. }
        | ClientMsg::PlanAdvance { .. }
        | ClientMsg::PlanConfirm { .. }
        | ClientMsg::PlanChat { .. } => input_granted,
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
        ClientMsg::PaneInput { pane_id, data } => crate::console::pty::tunnel_write_pty(app, &pane_id, &data),
        ClientMsg::PaneResize { pane_id, cols, rows } => {
            crate::console::pty::tunnel_resize_pty(app, &pane_id, cols, rows)
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
        // ── Fleet / coordination (F2) ────────────────────────────────
        ClientMsg::CoordWake { session } => {
            log::info!("tunnel: mobile requested wake for session {session}");
            let _ = app.emit("tunnel://coord-wake", serde_json::json!({ "session": session }));
        }
        ClientMsg::CoordApprove { session } => {
            log::info!("tunnel: mobile approved session {session}");
            let _ = app.emit("tunnel://coord-approve", serde_json::json!({ "session": session }));
        }
        // ── Automations (A2) ────────────────────────────────────────
        ClientMsg::AutomationArm { id, armed } => {
            log::info!("tunnel: mobile {} automation {id}", if armed { "armed" } else { "disarmed" });
            let _ = app.emit("tunnel://automation-arm", serde_json::json!({ "id": id, "armed": armed }));
        }
        ClientMsg::AutomationRunNow { id } => {
            log::info!("tunnel: mobile triggered automation {id}");
            let _ = app.emit("tunnel://automation-run-now", serde_json::json!({ "id": id }));
        }
        // ── Live planning session — drive (#934) ─────────────────────
        ClientMsg::PlanAdvance { project_id, stage_key } => {
            log::info!("tunnel: mobile advanced planner {project_id} → {stage_key}");
            let _ = app.emit("tunnel://plan-advance", serde_json::json!({ "projectId": project_id, "stageKey": stage_key }));
        }
        ClientMsg::PlanConfirm { project_id, section } => {
            log::info!("tunnel: mobile confirmed section {section} for {project_id}");
            let _ = app.emit("tunnel://plan-confirm", serde_json::json!({ "projectId": project_id, "section": section }));
        }
        ClientMsg::PlanChat { project_id, text } => {
            log::info!("tunnel: mobile chat into planner {project_id} ({} chars)", text.len());
            let _ = app.emit("tunnel://plan-chat", serde_json::json!({ "projectId": project_id, "text": text }));
        }
    }
}
