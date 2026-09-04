//! The app's own subscription to the sensor's stream.
//!
//! Until this existed the only thing in the codebase that received the stream
//! was `bsc lan watch` — a separate short-lived process printing to a terminal
//! — so the analyzer widget rendered its empty state no matter how healthy the
//! sensor was.
//!
//! ## The subscription is in Rust, and the webview never sees a key
//!
//! A webview cannot bind a UDP socket at all, so this was never a choice about
//! where the code reads better. But even if it could, doing it there would put
//! the GROUP KEY — the confidentiality half of the whole stream — inside a
//! surface that renders remote-influenced content. Rust verifies the signature,
//! decrypts, and decodes; what crosses into the webview is already-authenticated
//! structured data with no key attached. [`SpectrumPayload`] has no field a key
//! could occupy, and a test asserts the emitted JSON contains neither.
//!
//! ## No config, no socket
//!
//! An app that binds a port because a file happened to parse is a surprise.
//! The subscription starts only when a subscriber config is present and valid;
//! otherwise it does nothing at all and says so once in the log.
//!
//! ## A blocking read on its own thread, not the async runtime
//!
//! [`MulticastReceiver::next_tick`] blocks up to its read timeout, and the
//! timeout is the point: a tick with no datagram is what lets liveness advance
//! while the network is silent. Parking that on a tokio worker would hold an
//! executor thread for the whole life of the app, so it gets an OS thread.
//!
//! ## Silence is a state, not the absence of one
//!
//! The widget must be able to tell fresh from stale from never-heard, so the
//! liveness verdict is emitted on its own event on every tick rather than only
//! when a datagram arrives. A display that simply stops updating looks exactly
//! like a quiet band, and only one of those is good news.

use std::time::{Duration, Instant};

use bsc_lan_sense::receive::{MulticastReceiver, Tick};
use bsc_lan_stream::crypto::{GroupKey, Subscriber};
use bsc_lan_stream::frame::Event;
use bsc_lan_stream::liveness::{Cadence, Liveliness};
use bsc_lan_stream::subscription::{Finding, Subscription};
use ed25519_dalek::VerifyingKey;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// One channel's spectrum, as the widget receives it.
///
/// Deliberately a struct of its own rather than the wire [`Event`]: this is
/// what crosses into the webview, and it should be possible to read its
/// definition and see that no key can travel on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectrumPayload {
    pub freq_mhz: u16,
    /// How many sweeps went into this record — the evidence count. Carried
    /// because a peak from three sweeps and a peak from three thousand are
    /// different claims.
    pub sweeps: u32,
    pub noise_dbm: i8,
    pub peak_magnitude: u16,
    pub peak_bin: u8,
    /// Per-bin MAXIMUM across the window, never a mean. A microwave burst is
    /// exactly what this tier exists to catch, and averaging it against quiet
    /// sweeps is how it hides.
    pub bin_max: Vec<u8>,
    /// Milliseconds since the subscription started, so the widget can age a
    /// record without trusting a clock the sensor cannot have.
    pub received_at_ms: u64,
}

/// The liveness verdict, flattened for the widget.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LivenessPayload {
    /// `never-heard` · `healthy` · `late` · `silent`.
    pub state: &'static str,
    /// Milliseconds since the last datagram, or since watching began when
    /// nothing has ever arrived.
    pub since_ms: u64,
    /// How far past the deadline, when there is one.
    pub overdue_by_ms: u64,
}

/// The event a spectrum record is announced on.
pub const SPECTRUM_EVENT: &str = "lan://spectrum";
/// The event the liveness verdict is announced on.
pub const LIVENESS_EVENT: &str = "lan://liveness";

/// How long a read blocks before becoming a tick. Short enough that liveness
/// advances promptly on a silent network, long enough not to spin.
const READ_TIMEOUT: Duration = Duration::from_millis(500);

/// The cadence the subscriber judges the sensor by. Matches the sensor unit's
/// own `--snapshot-ms` default; a subscriber that expected snapshots faster
/// than the sensor sends them would report a healthy stream as late.
const CADENCE: Cadence =
    Cadence { snapshot_interval_ms: 10_000, grace_ms: 2_000, missed_snapshots_before_alert: 3 };

// Checked by the COMPILER rather than by a test, which is what clippy's
// assertions-on-constants lint was pointing at and it is right: these are
// properties of a constant, so a wrong one should not be buildable rather than
// merely caught the next time somebody runs the suite.
const _: () = {
    // A zero grace makes ordinary jitter read as lateness, and a liveness
    // state that cries wolf trains the reader to ignore it.
    assert!(CADENCE.grace_ms > 0);
    // One missed datagram is not an outage. UDP loses some; that is what the
    // snapshot machinery exists for.
    assert!(CADENCE.missed_snapshots_before_alert >= 2);
    // And the grace must not swallow a whole interval, or a sensor that has
    // stopped would still read as merely late for two full cadences.
    assert!(CADENCE.grace_ms < CADENCE.snapshot_interval_ms);
};

/// Turn a wire event into what the widget gets, or `None` for an event this
/// surface does not render.
///
/// Every variant is named rather than absorbed by a wildcard: a new event kind
/// must be a decision here, not something that silently never reaches the UI.
pub fn payload_for(event: &Event, received_at_ms: u64) -> Option<SpectrumPayload> {
    match event {
        Event::RfSpectrum { freq_mhz, sweeps, noise_dbm, peak_magnitude, peak_bin, bin_max } => {
            Some(SpectrumPayload {
                freq_mhz: *freq_mhz,
                sweeps: *sweeps,
                noise_dbm: *noise_dbm,
                peak_magnitude: *peak_magnitude,
                peak_bin: *peak_bin,
                bin_max: bin_max.clone(),
                received_at_ms,
            })
        }
        Event::Alert { .. }
        | Event::Flow { .. }
        | Event::Health { .. }
        | Event::RfDeauthFlood { .. }
        | Event::RfChannelActivity { .. }
        | Event::PostureChanged { .. } => None,
    }
}

/// Flatten a liveness verdict for the wire to the webview.
pub fn liveness_payload(l: Liveliness) -> LivenessPayload {
    match l {
        Liveliness::NeverHeard { waiting_ms } => {
            LivenessPayload { state: "never-heard", since_ms: waiting_ms, overdue_by_ms: 0 }
        }
        Liveliness::Healthy { since_last_ms } => {
            LivenessPayload { state: "healthy", since_ms: since_last_ms, overdue_by_ms: 0 }
        }
        Liveliness::Late { since_last_ms, overdue_by_ms } => {
            LivenessPayload { state: "late", since_ms: since_last_ms, overdue_by_ms }
        }
        Liveliness::Silent { since_last_ms, overdue_by_ms } => {
            LivenessPayload { state: "silent", since_ms: since_last_ms, overdue_by_ms }
        }
    }
}

/// Start the subscription for the app's lifetime, if this host holds a
/// subscriber config. Returns whether it started, so the caller can log the
/// reason rather than leaving a silent no-op.
pub fn spawn(app: AppHandle) -> Result<(), String> {
    let cfg = bsc_lan_sense::config::load_subscriber()?;
    let group = cfg.value.group_addr()?;
    let iface = cfg.value.iface_addr()?;
    let verifying = VerifyingKey::from_bytes(&cfg.value.sensor_public_key_bytes()?)
        .map_err(|_| "the sensor public key is not a valid ed25519 public key".to_string())?;
    let group_key = GroupKey::from_bytes(cfg.value.group_key_bytes()?);

    // A group address joins; anything else binds unicast. Multicast does not
    // cross a VLAN without a router, so a desktop on another segment is fed by
    // unicast and has to be able to listen for it.
    let rx = if group.ip().is_multicast() {
        MulticastReceiver::join(iface, group, READ_TIMEOUT)
            .map_err(|e| format!("cannot join {group} on {iface}: {e}"))?
    } else {
        MulticastReceiver::bind_unicast(group.port(), READ_TIMEOUT)
            .map_err(|e| format!("cannot bind {}: {e}", group.port()))?
    };

    std::thread::spawn(move || {
        let started = Instant::now();
        let mut sub = Subscription::new(Subscriber::new(verifying, group_key), CADENCE, 0);
        let mut last_liveness: Option<LivenessPayload> = None;
        loop {
            let now_ms = started.elapsed().as_millis() as u64;
            let findings = match rx.next_tick() {
                Ok(Tick::Datagram(d)) => sub.receive(&d, now_ms),
                Ok(Tick::Quiet) => sub.poll(now_ms),
                // A receive error is not a reason to stop listening: the
                // interface can go down and come back under a running app, and
                // a subscription that exited would leave the widget frozen on
                // its last spectrum with nothing saying why.
                Err(_) => Vec::new(),
            };
            for f in &findings {
                if let Finding::Event(e) = f {
                    if let Some(p) = payload_for(e, now_ms) {
                        let _ = app.emit(SPECTRUM_EVENT, &p);
                    }
                }
            }
            // Emitted on every tick, not only on a change: a widget that
            // mounts after the last transition would otherwise have no way to
            // learn the current state, and "no liveness yet" would render the
            // same as "healthy".
            let p = liveness_payload(sub.liveliness(now_ms));
            if last_liveness.as_ref() != Some(&p) {
                let _ = app.emit(LIVENESS_EVENT, &p);
                last_liveness = Some(p);
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsc_lan_stream::crypto::Sensor;
    use bsc_lan_stream::envelope::Kind;
    use bsc_lan_stream::frame::Frame;
    use ed25519_dalek::SigningKey;

    const GROUP_KEY: [u8; 32] = [9u8; 32];

    fn spectrum() -> Event {
        Event::RfSpectrum {
            freq_mhz: 2437,
            sweeps: 3328,
            noise_dbm: -95,
            peak_magnitude: 2551,
            peak_bin: 21,
            bin_max: (0..56u8).collect(),
        }
    }

    #[test]
    fn what_crosses_into_the_webview_cannot_carry_a_key() {
        // The property the whole Rust-side design exists for. Asserted over
        // the SERIALIZED payload rather than the struct, because that is what
        // actually reaches the webview — and against the key bytes themselves,
        // not against the absence of a field name, since a key smuggled into
        // any field would pass the weaker check.
        let p = payload_for(&spectrum(), 1234).expect("a spectrum payload");
        let json = serde_json::to_string(&p).unwrap();
        let group_hex: String = GROUP_KEY.iter().map(|b| format!("{b:02x}")).collect();
        assert!(!json.contains(&group_hex), "the group key reached the webview: {json}");
        // LOWERCASED before the check, and that is not fussiness: `serde` is
        // `rename_all = "camelCase"` here, so a `group_key` field serializes as
        // `groupKey` and a case-sensitive search for "key" walks straight past
        // it. A bite test caught exactly that — the guard passed against a
        // payload that had just grown a key field.
        let lower = json.to_ascii_lowercase();
        assert!(!lower.contains("key"), "the payload has a key-shaped field: {json}");
        // And no 64-character hex run of any kind, whatever it is called: every
        // secret on this wire is a 32-byte key rendered that way.
        assert!(
            !json
                .split(|c: char| !c.is_ascii_hexdigit())
                .any(|run| run.len() >= 64),
            "the payload carries a 64-character hex run — that is the shape of every key here: {json}"
        );
        // And it carries what the widget actually needs.
        assert!(json.contains("\"freqMhz\":2437"), "{json}");
        assert!(json.contains("\"sweeps\":3328"), "the evidence count is missing: {json}");
        assert!(json.contains("\"binMax\""), "{json}");
        assert!(json.contains("\"receivedAtMs\":1234"), "{json}");
    }

    #[test]
    fn only_a_spectrum_reaches_the_analyzer_and_every_other_event_is_a_decision() {
        // Not a wildcard: a new wire event must be decided about here rather
        // than silently never reaching the UI.
        assert!(payload_for(&spectrum(), 0).is_some());
        for e in [
            Event::Health { uptime_s: 91, soc_temp_c: 80.7, capture_drops: 0 },
            Event::RfDeauthFlood {
                flood: true,
                frames: 100,
                broadcast_frames: 40,
                window_ms: 1000,
                rate_centi_per_s: 10_000,
                claimed_bssid: "aa:bb:cc:dd:ee:ff".into(),
                top_target: "ff:ff:ff:ff:ff:ff".into(),
                distinct_targets: 3,
                reasons: vec![7],
            },
        ] {
            assert!(payload_for(&e, 0).is_none(), "{e:?} reached the analyzer");
        }
    }

    #[test]
    fn a_forged_datagram_is_counted_and_never_rendered() {
        // Proven by forging one, not by reading the code. A subscriber holding
        // the wrong public half must reject a datagram that is otherwise
        // perfectly formed — if it did not, the signature would prove nothing
        // and anyone on the segment could paint the analyzer.
        let real = SigningKey::from_bytes(&[7u8; 32]);
        let impostor = SigningKey::from_bytes(&[8u8; 32]);
        let group = GroupKey::from_bytes(GROUP_KEY);

        let mut sub = Subscription::new(
            Subscriber::new(real.verifying_key(), GroupKey::from_bytes(GROUP_KEY)),
            CADENCE,
            0,
        );

        // The impostor seals a genuine-looking spectrum with the right group key.
        let forger = Sensor::new(impostor, group, [1u8; 16]);
        let plain = Frame::Delta(spectrum()).encode().unwrap();
        let forged = forger.seal(Kind::Delta, 0, [3u8; 12], &plain).unwrap();

        let findings = sub.receive(&forged, 10);
        let rendered: Vec<_> = findings
            .iter()
            .filter_map(|f| match f {
                Finding::Event(e) => payload_for(e, 10),
                _ => None,
            })
            .collect();
        assert!(rendered.is_empty(), "a forged spectrum reached the widget: {rendered:?}");
        assert!(
            findings.iter().any(|f| matches!(f, Finding::ForgeryRejected { .. })),
            "the forgery was dropped without being counted: {findings:?}"
        );

        // And the genuine sensor's identical record DOES get through, so the
        // test above is about the signature rather than about the payload.
        let genuine = Sensor::new(SigningKey::from_bytes(&[7u8; 32]), GroupKey::from_bytes(GROUP_KEY), [1u8; 16]);
        let good = genuine.seal(Kind::Delta, 0, [4u8; 12], &plain).unwrap();
        let ok: Vec<_> = sub
            .receive(&good, 20)
            .iter()
            .filter_map(|f| match f {
                Finding::Event(e) => payload_for(e, 20),
                _ => None,
            })
            .collect();
        assert_eq!(ok.len(), 1, "the genuine record did not reach the widget");
    }

    #[test]
    fn every_liveness_state_is_distinguishable_by_the_widget() {
        // The widget has to render fresh, stale and never-heard differently,
        // so the states must not collapse into one another on the way over.
        let all = [
            Liveliness::NeverHeard { waiting_ms: 5_000 },
            Liveliness::Healthy { since_last_ms: 100 },
            Liveliness::Late { since_last_ms: 12_000, overdue_by_ms: 2_000 },
            Liveliness::Silent { since_last_ms: 40_000, overdue_by_ms: 30_000 },
        ];
        let states: Vec<&str> = all.iter().map(|l| liveness_payload(*l).state).collect();
        let unique: std::collections::BTreeSet<_> = states.iter().collect();
        assert_eq!(unique.len(), all.len(), "two liveness states render the same: {states:?}");
        // Never-heard must not be reachable by mistake from a healthy stream's
        // rendering: the elapsed time travels with it.
        let nh = liveness_payload(Liveliness::NeverHeard { waiting_ms: 5_000 });
        assert_eq!((nh.state, nh.since_ms), ("never-heard", 5_000));
        let s = liveness_payload(Liveliness::Silent { since_last_ms: 40_000, overdue_by_ms: 30_000 });
        assert_eq!((s.state, s.since_ms, s.overdue_by_ms), ("silent", 40_000, 30_000));
    }

    #[test]
    fn the_subscriber_cadence_matches_what_the_sensor_unit_actually_sends() {
        // A subscriber expecting snapshots faster than the sensor sends them
        // reports a perfectly healthy stream as late, which is worse than no
        // liveness at all: it trains the reader to ignore the state.
        // The relationship the compiler cannot check: this number has to match
        // what the SENSOR's unit actually sends, and that lives in another
        // crate's default. The const block above guards the internal shape.
        assert_eq!(
            CADENCE.snapshot_interval_ms, 10_000,
            "the sensor unit renders --snapshot-ms 10000; a subscriber expecting them faster \
             reports a healthy stream as late"
        );
    }
}
