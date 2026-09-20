//! The ear hosts its OWN relay room, so a phone streams into it with no desktop app running.
//!
//! WHY THE EAR HOSTS RATHER THAN LISTENS TO THE APP. Capture has to work with the desktop app
//! closed, and the app's tunnel identity is minted fresh at every launch — a phone pinned to it is
//! unpaired by a restart. `crate::tunnel` therefore gives the ear a DURABLE identity of its own
//! (keychain-backed, generated once), and this module is what puts that identity on the wire. The
//! phone pairs with the EAR; the app is not in the path at all.
//!
//! THE HOST TRAIT IS DESKTOP-SHAPED, and this implementation is deliberately hollow in places.
//! `TunnelHost` was extracted from the app, so it speaks of panes, replay frames and push tokens —
//! none of which an ear has. Those methods return empty rather than the trait being split, because
//! splitting a trait that `src-tauri` also implements is a change to a shared crate and deserves
//! its own slice. Every hollow method says so at its definition, so the emptiness reads as a
//! decision rather than an oversight.

use crate::capture::{self, CaptureConfig, Progress, SampleSource};
use crate::stream::{FrameAssembler, Received};
use base64::Engine;
use bsc_tunnel::protocol::{ClientMsg, PaneOutputChunk, ServerMsg};
use bsc_tunnel::relay::{self, TunnelHost};
use std::sync::mpsc;
use std::sync::Mutex;
use tokio::sync::{broadcast, watch};

/// The rate the phone encodes at (`msc-audio`'s `DEFAULT_SAMPLE_RATE`). The sample source must be
/// built BEFORE any frame arrives, so this is an expectation rather than a measurement — a frame
/// that disagrees is reported rather than silently resampled at the wrong rate.
const EXPECTED_HZ: u32 = 16_000;

/// What a phone's audio becomes on the way to the segmenter.
///
/// Every method that an ear has no concept of is empty ON PURPOSE — see the module header.
pub struct EarHost {
    psk: String,
    /// Samples out to the capture loop. `Mutex` because `TunnelHost` requires `Sync` and an
    /// `mpsc::Sender` is `Send` but not `Sync`.
    ///
    /// NOTE there is no `channel` field. The label belongs on the CaptureConfig and the source
    /// name, which the caller sets; the phone's own label is ignored (see `on_client_msg`), so a
    /// copy here would be state nothing reads — which is exactly what clippy caught.
    tx: Mutex<mpsc::Sender<Vec<f32>>>,
    assembler: Mutex<FrameAssembler>,
    /// Kept alive only so `subscribe_output` / `subscribe_events` can hand out a receiver. The ear
    /// never sends on either: it has no panes to stream and no state to project.
    out_tx: broadcast::Sender<PaneOutputChunk>,
    evt_tx: broadcast::Sender<ServerMsg>,
    /// Diagnostics, reported when the session ends. SHARED rather than owned: `relay::run` takes
    /// the host by value, so this handle is how the caller still has counters to read afterwards.
    stats: std::sync::Arc<Mutex<RoomStats>>,
}

#[derive(Default, Clone, Copy, Debug)]
pub struct RoomStats {
    pub frames: u64,
    pub samples: u64,
    /// Frames known lost. A GAP IS NOT SILENCE — see `accept_audio`.
    pub lost: u64,
    /// Frames that arrived out of order and were dropped rather than spliced in late.
    pub stale: u64,
    /// Frames whose `sample_rate` disagreed with what the source was built for.
    pub rate_mismatch: u64,
    /// Frames whose base64 would not decode. Counted rather than logged: this crate declares no
    /// `log` dependency and initialises no logger, so a log line here would vanish silently —
    /// a count that reaches the session summary is the honest channel.
    pub undecodable: u64,
    /// Phones seen connecting, so a session that recorded nothing can still say whether anything
    /// ever arrived — "no phone connected" and "a phone connected and sent silence" are different
    /// failures and must not look alike.
    pub clients_seen: u64,
    /// Set if the relay closed the room out from under the session (expiry, not a transient drop).
    pub room_expired: bool,
}

impl EarHost {
    pub fn new(
        psk: String,
        tx: mpsc::Sender<Vec<f32>>,
        stats: std::sync::Arc<Mutex<RoomStats>>,
    ) -> EarHost {
        EarHost {
            psk,
            tx: Mutex::new(tx),
            assembler: Mutex::new(FrameAssembler::new()),
            out_tx: broadcast::channel(1).0,
            evt_tx: broadcast::channel(1).0,
            stats,
        }
    }

    /// Decode one `audio_frame` and push its samples at the capture loop.
    ///
    /// A GAP IS REPORTED, NEVER FILLED. Silence-filling a hole would read to the segmenter as a
    /// pause and corrupt exactly the measures this audio exists to produce — speech rate and pause
    /// structure. Concatenating across it is worse still: that SHORTENS the timeline while looking
    /// like confident data.
    ///
    /// KNOWN LIMIT, stated rather than hidden: the seam is a bare `mpsc::Receiver<Vec<f32>>` with
    /// no side band, so a gap can be COUNTED and logged here but the segmenter cannot be told to
    /// close its open segment across it. Closing it properly needs a gap signal alongside the
    /// sample channel — a change to `SampleSource` itself, which is not this slice's to make.
    fn accept_audio(&self, seq: u64, sample_rate: u32, pcm: &str) {
        let bytes = match base64::engine::general_purpose::STANDARD.decode(pcm) {
            Ok(b) => b,
            Err(_) => {
                self.stats.lock().expect("room stats poisoned").undecodable += 1;
                return;
            }
        };
        let mut stats = self.stats.lock().expect("room stats poisoned");
        stats.frames += 1;
        if sample_rate != EXPECTED_HZ {
            stats.rate_mismatch += 1;
        }
        let received = self.assembler.lock().expect("assembler poisoned").accept(seq, &bytes);
        let samples = match received {
            Received::Samples(s) => s,
            Received::Gap { lost, samples } => {
                stats.lost += lost;
                samples
            }
            Received::Stale { .. } => {
                stats.stale += 1;
                return;
            }
        };
        stats.samples += samples.len() as u64;
        drop(stats);
        // A closed receiver means the capture loop has stopped; the session is ending anyway.
        let _ = self.tx.lock().expect("audio sender poisoned").send(samples);
    }
}

impl TunnelHost for EarHost {
    fn psk(&self) -> String {
        self.psk.clone()
    }

    /// ALWAYS GRANTED, and that is not a weakened gate. The app's view-only default exists because
    /// a phone pairing with it can drive a terminal; this room carries exactly one frame type the
    /// ear acts on, and the pairing secret is the authorisation. A phone that reached here was
    /// deliberately given the ear's psk.
    fn input_granted(&self) -> bool {
        true
    }

    /// Nothing to prompt: input is never withheld, so the latch can never fire.
    fn take_input_request(&self) -> bool {
        false
    }

    /// No push notifications — the ear has no FCM worker and nothing to notify about.
    fn store_push_token(&self, _token: String) {}

    fn set_client_count(&self, n: usize) {
        if n > 0 {
            self.stats.lock().expect("room stats poisoned").clients_seen += n as u64;
        }
    }

    /// Hollow: an ear has no PTY and streams no pane output. The receiver is live but silent.
    fn subscribe_output(&self) -> broadcast::Receiver<PaneOutputChunk> {
        self.out_tx.subscribe()
    }

    /// Hollow: an ear projects no store state and lists no panes.
    fn subscribe_events(&self) -> broadcast::Receiver<ServerMsg> {
        self.evt_tx.subscribe()
    }

    /// Hollow: there is no connect-time state to replay. The phone needs nothing from the ear.
    fn replay_frames(&self) -> Vec<ServerMsg> {
        Vec::new()
    }

    /// EXHAUSTIVE ON PURPOSE, mirroring the desktop host: a new `ClientMsg` variant must fail to
    /// compile here rather than being dropped silently by a wildcard.
    fn on_client_msg(&self, msg: ClientMsg) {
        match msg {
            // The phone's own `channel` label is DELIBERATELY IGNORED in favour of the operator's
            // --channel. The baseline is keyed per (speaker, channel), and the person running the
            // ear is the one who knows which microphone is in which room — a phone that labels
            // itself must not be able to pool its audio into the desk mic's habit.
            ClientMsg::AudioFrame { channel: _, seq, sample_rate, pcm } => {
                self.accept_audio(seq, sample_rate, &pcm);
            }
            // Everything else belongs to the app's surface — panes, planner, automations, push.
            // An ear has none of it, so these are dropped rather than half-handled.
            ClientMsg::Auth { .. }
            | ClientMsg::SetFcmToken { .. }
            | ClientMsg::PaneSetState { .. }
            | ClientMsg::PaneFocus { .. }
            | ClientMsg::PaneInput { .. }
            | ClientMsg::PaneResize { .. }
            | ClientMsg::PlanSyncManifestRequest { .. }
            | ClientMsg::PlanSyncPull { .. }
            | ClientMsg::PlanSyncPush { .. }
            | ClientMsg::CoordWake { .. }
            | ClientMsg::CoordApprove { .. }
            | ClientMsg::AutomationArm { .. }
            | ClientMsg::AutomationRunNow { .. }
            | ClientMsg::PlanAdvance { .. }
            | ClientMsg::PlanConfirm { .. }
            | ClientMsg::PlanChat { .. }
            // An ear hosts no sessions, so there is nothing here to wake.
            | ClientMsg::SessionWake { .. }
            // An ear pushes nothing, so it has no use for a device token.
            | ClientMsg::SetPushToken { .. }
            // An ear holds no jobs store to move an application in.
            | ClientMsg::JobsSetStatus { .. }
            // An ear holds no record stores, so there is no node here to have a body.
            | ClientMsg::NodeBodyRequest { .. } => {}
        }
    }

    /// The relay closed the room because it EXPIRED, not because of a transient drop. Recorded so
    /// the session summary can tell the user to re-pair, instead of reporting a quiet zero.
    fn on_room_expired(&self, _reason: &str) {
        self.stats.lock().expect("room stats poisoned").room_expired = true;
    }

    fn on_input_requested(&self) {}
}

/// Host a room and record everything the phone sends into it, until `stop` says otherwise.
///
/// The relay client is async and the capture loop is blocking, so the runtime runs on its own
/// thread and the two meet at the sample channel — the same `mpsc` the cpal callback writes to.
/// That is the whole point of the `SampleSource` seam: the segmenter, the retention window and the
/// per-channel baseline never learn where the samples came from.
/// Everything needed to open the ear's room. These five travel together — they all come out of one
/// `PairingPayload` plus the identity's private key — so they are one argument rather than five.
pub struct RoomIdentity {
    pub psk: String,
    pub relay_url: String,
    pub room: String,
    pub static_priv: Vec<u8>,
    /// The label the audio is recorded under. The RECORDING PATH, not a channel count.
    pub channel: String,
}

pub fn host_room(
    cfg: &CaptureConfig,
    id: RoomIdentity,
    stop: &dyn Fn() -> bool,
    on_event: &mut dyn FnMut(String),
) -> Result<(Progress, RoomStats), String> {
    let RoomIdentity { psk, relay_url, room, static_priv, channel } = id;
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    // `relay::run` takes the host BY VALUE, so only the counters are shared. Implementing
    // TunnelHost for Arc<EarHost> instead would be an orphan-rule question not worth asking.
    let stats = std::sync::Arc::new(Mutex::new(RoomStats::default()));
    let host = EarHost::new(psk, tx, std::sync::Arc::clone(&stats));

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(1)
        .build()
        .map_err(|e| format!("could not start the async runtime: {e}"))?;

    // THE LAN TOO. The phone dials this port first when it shares the network, so on a home Wi-Fi the
    // audio never leaves the house — the relay is only the fallback it silently takes when it does not.
    on_event(match relay::local_lan_host() {
        Some(lan) => format!(
            "hosting relay room {room} and ws://{lan}:{} on the LAN — waiting for a phone",
            relay::LAN_PORT_EAR
        ),
        None => format!("hosting relay room {room} — waiting for a phone (no LAN route found)"),
    });
    let relay_thread = std::thread::spawn(move || {
        runtime.block_on(relay::run_with_lan(host, relay_url, room, static_priv, Some(relay::LAN_PORT_EAR), shutdown_rx));
    });

    // Built before the first frame, so the rate is an expectation. `run_with_source` resamples
    // from here to the capture target; a phone that disagreed would be counted, not silently wrong.
    let src = SampleSource::from_channel(rx, 1, EXPECTED_HZ, format!("phone:{channel}"));
    let progress = capture::run_with_source(cfg, src, stop, on_event);

    let _ = shutdown_tx.send(true);
    let _ = relay_thread.join();
    let final_stats = *stats.lock().expect("room stats poisoned");
    progress.map(|p| (p, final_stats))
}
