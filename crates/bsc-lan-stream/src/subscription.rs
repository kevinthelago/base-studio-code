//! The receiving half: datagrams and time in, findings out.
//!
//! Composes the three pieces built separately — signature and group-key
//! verification ([`crate::crypto`]), sequence tracking ([`crate::sequence`])
//! and liveness ([`crate::liveness`]) — into the thing a consumer actually
//! wires to an alert, a dashboard, or another agent.
//!
//! Pure: it holds no socket and no clock, so it stays inside this crate's
//! no-I/O guarantee and every property below is testable without a network.
//!
//! ## Three things a naive subscriber gets wrong
//!
//! **A rejected datagram is a finding, not a non-event.** The obvious loop
//! calls `open()`, sees `Err`, and `continue`s. But a datagram that fails
//! signature verification on the multicast group is not noise — it is someone
//! injecting into the group, which is the exact attack the signature exists to
//! stop. Dropping it silently means the defence works and *nobody ever learns
//! it was needed*. Worse, it means a sustained injection campaign is invisible.
//!
//! **Silence is only observable if something looks.** A subscriber that reacts
//! only to arriving datagrams can never notice that none are arriving: the
//! code path that would report it is the one that has stopped running. So
//! [`Subscription::poll`] takes the time and yields findings with no input at
//! all. This is the single most likely way the whole design fails quietly.
//!
//! **Alerts fire on transition, not on every poll.** A consumer polling each
//! second must not get a `Silent` finding every second. That is not an alert,
//! it is a denial of service against the person reading it, and it is exactly
//! how real alerts come to be filtered out by tired operators. State-derived
//! findings are edge-triggered; the current state stays queryable at any time.

use crate::crypto::Subscriber;
use crate::envelope::Kind;
use crate::error::{SequenceError, WireError};
use crate::frame::{AttestedPosture, Event, Frame, SensorState};
use crate::liveness::{Cadence, Liveliness, LivelinessKind, Watch};
use crate::sequence::{Completeness, Reception, Tracker};

/// Why a datagram on the group was refused.
///
/// Split by cause rather than collapsed into one "bad datagram" counter,
/// because the causes call for different responses: a bad signature means
/// somebody is injecting, while an undecryptable payload usually means a
/// subscriber — or the sensor — is holding a stale group key after a rotation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rejections {
    /// Signature did not verify: a forgery attempt, or corruption in flight.
    pub forged: u64,
    /// Signature verified but the payload would not decrypt: almost always a
    /// group-key mismatch rather than an attack.
    pub undecryptable: u64,
    /// Malformed, truncated, oversized, or simply not ours.
    pub malformed: u64,
    /// Cryptographically genuine but out of order: a replay.
    pub replayed: u64,
}

impl Rejections {
    pub fn total(&self) -> u64 {
        self.forged + self.undecryptable + self.malformed + self.replayed
    }
}

/// Something a consumer should act on.
#[derive(Debug, Clone, PartialEq)]
pub enum Finding {
    /// A genuine event from the sensor.
    Event(Event),
    /// A genuine snapshot from the sensor.
    Snapshot(Box<SensorState>),

    /// **Somebody is injecting into the multicast group.** The signature did
    /// not verify, so this did not come from the sensor. `seen` is the running
    /// count, so one corrupted datagram reads differently from a campaign.
    ForgeryRejected { seen: u64 },
    /// Signed by the sensor but undecryptable — a group-key mismatch, not an
    /// attack. Reported separately so it does not read as hostile.
    UndecryptableRejected { seen: u64 },
    /// Not a well-formed datagram of ours at all.
    MalformedRejected { seen: u64 },

    /// Datagrams were lost. Not recoverable — superseded by the next snapshot.
    Gap { missing_from: u64, missing_to: u64 },
    /// A cryptographically genuine datagram arrived out of order.
    Replayed { seq: u64, last: u64 },
    /// The sensor restarted. Distinct from a gap: nothing was lost, the
    /// numbering simply began again.
    SensorRestarted { previous_last_seq: u64 },
    /// The subscriber's view of sensor state is no longer trustworthy.
    ViewDegraded,
    /// A snapshot restored it.
    ViewWhole,

    /// The sensor's reachability changed. `Sealed` to `Unknown` counts: on a
    /// box nobody can log into, losing the ability to describe itself is a
    /// real change rather than missing data.
    PostureChanged {
        from: Option<AttestedPosture>,
        to: AttestedPosture,
    },

    /// The stream's liveness changed. Edge-triggered.
    LivelinessChanged { to: Liveliness },
}

/// One sensor's stream, as seen by one subscriber.
pub struct Subscription {
    subscriber: Subscriber,
    tracker: Tracker,
    watch: Watch,
    rejections: Rejections,
    last_posture: Option<AttestedPosture>,
    last_liveliness: Option<LivelinessKind>,
    last_completeness: Option<Completeness>,
}

impl Subscription {
    pub fn new(subscriber: Subscriber, cadence: Cadence, now_ms: u64) -> Self {
        Self {
            subscriber,
            tracker: Tracker::new(),
            watch: Watch::started_at(cadence, now_ms),
            rejections: Rejections::default(),
            last_posture: None,
            last_liveliness: None,
            last_completeness: None,
        }
    }

    pub fn rejections(&self) -> Rejections {
        self.rejections
    }

    /// The current liveness, queryable at any time. Distinct from the
    /// edge-triggered finding: a dashboard wants the state continuously, an
    /// alert wants the transition once.
    pub fn liveliness(&self, now_ms: u64) -> Liveliness {
        self.watch.assess(now_ms)
    }

    pub fn posture(&self) -> Option<&AttestedPosture> {
        self.last_posture.as_ref()
    }

    /// Findings that depend only on the passage of time.
    ///
    /// **Must be called even when nothing is arriving** — that is the entire
    /// point. A subscriber driven only by inbound datagrams cannot report
    /// silence, because silence is the absence of the thing that would drive
    /// it.
    pub fn poll(&mut self, now_ms: u64) -> Vec<Finding> {
        let mut out = Vec::new();
        let current = self.watch.assess(now_ms);
        // Edge-triggered on the KIND, never on the value: every variant
        // carries an elapsed time that moves on every poll, so comparing
        // whole values would report a transition every time and produce an
        // alert per poll. The finding still carries the full verdict, so the
        // consumer gets the elapsed time it needs to render.
        if self.last_liveliness != Some(current.kind()) {
            self.last_liveliness = Some(current.kind());
            out.push(Finding::LivelinessChanged { to: current });
        }
        out
    }

    /// Take one datagram off the group.
    ///
    /// Never returns an error: a refusal is a finding, because the caller's
    /// only sane response to `Err` is to ignore it, and ignoring an injection
    /// attempt is the failure this design exists to prevent.
    pub fn receive(&mut self, datagram: &[u8], now_ms: u64) -> Vec<Finding> {
        let mut out = Vec::new();

        let (env, plaintext) = match self.subscriber.open(datagram) {
            Ok(v) => v,
            Err(e) => {
                match e {
                    WireError::BadSignature => {
                        self.rejections.forged += 1;
                        out.push(Finding::ForgeryRejected { seen: self.rejections.forged });
                    }
                    WireError::Undecryptable => {
                        self.rejections.undecryptable += 1;
                        out.push(Finding::UndecryptableRejected {
                            seen: self.rejections.undecryptable,
                        });
                    }
                    WireError::TooLarge { .. }
                    | WireError::Truncated { .. }
                    | WireError::BadMagic
                    | WireError::UnsupportedVersion(_)
                    | WireError::UnknownKind(_)
                    | WireError::PayloadTooLarge { .. }
                    | WireError::MalformedPayload(_) => {
                        self.rejections.malformed += 1;
                        out.push(Finding::MalformedRejected { seen: self.rejections.malformed });
                    }
                }
                return out;
            }
        };

        match self.tracker.accept(&env) {
            Err(SequenceError::Replay { seq, last }) => {
                self.rejections.replayed += 1;
                out.push(Finding::Replayed { seq, last });
                // A replay must not refresh liveness: an attacker replaying an
                // old datagram would otherwise keep a dead sensor looking alive.
                return out;
            }
            Ok(reception) => {
                self.watch.heard(now_ms);
                match reception {
                    Reception::Started | Reception::InOrder => {}
                    Reception::Gap { missing } => out.push(Finding::Gap {
                        missing_from: *missing.start(),
                        missing_to: *missing.end(),
                    }),
                    Reception::SensorRestarted { previous_last_seq, .. } => {
                        out.push(Finding::SensorRestarted { previous_last_seq });
                        // A restart begins a new run, so nothing carries over.
                        self.last_posture = None;
                    }
                }
            }
        }

        // Completeness transitions, edge-triggered like liveness.
        let completeness = self.tracker.completeness();
        if completeness != self.last_completeness {
            self.last_completeness = completeness;
            match completeness {
                Some(Completeness::Degraded) => out.push(Finding::ViewDegraded),
                Some(Completeness::Whole) => out.push(Finding::ViewWhole),
                None => {}
            }
        }

        match Frame::decode(&plaintext) {
            Err(_) => {
                self.rejections.malformed += 1;
                out.push(Finding::MalformedRejected { seen: self.rejections.malformed });
            }
            Ok(Frame::Delta(event)) => out.push(Finding::Event(event)),
            Ok(Frame::Snapshot(state)) => {
                if self.last_posture.as_ref() != Some(&state.posture) {
                    out.push(Finding::PostureChanged {
                        from: self.last_posture.clone(),
                        to: state.posture.clone(),
                    });
                    self.last_posture = Some(state.posture.clone());
                }
                out.push(Finding::Snapshot(Box::new(state)));
            }
        }

        // Kind is consulted by the tracker for completeness; nothing else here
        // needs it, but naming it keeps the exhaustive-match discipline honest.
        let _ = Kind::Delta;

        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{GroupKey, Sensor};
    use crate::envelope::NONCE_LEN;
    use ed25519_dalek::SigningKey;

    const GROUP: [u8; 32] = [7u8; 32];

    fn sensor(boot: [u8; 16]) -> Sensor {
        Sensor::new(SigningKey::from_bytes(&[3u8; 32]), GroupKey::from_bytes(GROUP), boot)
    }

    fn sub_at(now: u64) -> Subscription {
        Subscription::new(
            Subscriber::new(
                SigningKey::from_bytes(&[3u8; 32]).verifying_key(),
                GroupKey::from_bytes(GROUP),
            ),
            Cadence { snapshot_interval_ms: 10_000, grace_ms: 2_000, missed_snapshots_before_alert: 3 },
            now,
        )
    }

    fn nonce(seq: u64) -> [u8; NONCE_LEN] {
        let mut n = [0u8; NONCE_LEN];
        n[4..12].copy_from_slice(&seq.to_be_bytes());
        n
    }

    fn an_event() -> Event {
        Event::Health { uptime_s: 1, soc_temp_c: 89.0, capture_drops: 0 }
    }

    fn snapshot_with(posture: AttestedPosture) -> Frame {
        Frame::Snapshot(SensorState { posture, ..Default::default() })
    }

    // ---- a rejected datagram is a finding ----------------------------------

    #[test]
    fn a_forged_datagram_is_reported_not_silently_dropped() {
        let attacker = Sensor::new(
            SigningKey::from_bytes(&[9u8; 32]), // wrong signing key
            GroupKey::from_bytes(GROUP),        // but the real group key
            [1u8; 16],
        );
        let dg = attacker
            .seal(Kind::Delta, 0, nonce(0), &Frame::Delta(an_event()).encode().unwrap())
            .unwrap();

        let mut s = sub_at(0);
        let found = s.receive(&dg, 0);
        assert_eq!(found, vec![Finding::ForgeryRejected { seen: 1 }]);
        assert_eq!(s.rejections().forged, 1);
    }

    #[test]
    fn a_sustained_injection_is_counted_so_it_reads_differently_from_one_bad_datagram() {
        let attacker = Sensor::new(
            SigningKey::from_bytes(&[9u8; 32]),
            GroupKey::from_bytes(GROUP),
            [1u8; 16],
        );
        let mut s = sub_at(0);
        for i in 1..=50u64 {
            let dg = attacker
                .seal(Kind::Delta, i, nonce(i), &Frame::Delta(an_event()).encode().unwrap())
                .unwrap();
            assert_eq!(s.receive(&dg, 0), vec![Finding::ForgeryRejected { seen: i }]);
        }
        assert_eq!(s.rejections().forged, 50);
    }

    #[test]
    fn a_stale_group_key_reads_differently_from_a_forgery() {
        // Correct signing key, wrong group key: a key-rotation problem, not an
        // attacker. Conflating them would send somebody hunting an intruder.
        let wrong_group = Sensor::new(
            SigningKey::from_bytes(&[3u8; 32]),
            GroupKey::from_bytes([8u8; 32]),
            [1u8; 16],
        );
        let dg = wrong_group
            .seal(Kind::Delta, 0, nonce(0), &Frame::Delta(an_event()).encode().unwrap())
            .unwrap();

        let mut s = sub_at(0);
        assert_eq!(s.receive(&dg, 0), vec![Finding::UndecryptableRejected { seen: 1 }]);
        assert_eq!(s.rejections().forged, 0, "a key mismatch must not be counted as a forgery");
    }

    #[test]
    fn garbage_on_the_group_is_reported_as_malformed() {
        let mut s = sub_at(0);
        assert_eq!(s.receive(&[0u8; 200], 0), vec![Finding::MalformedRejected { seen: 1 }]);
    }

    #[test]
    fn a_rejected_datagram_never_refreshes_liveness() {
        let mut s = sub_at(0);
        let sensor = sensor([1u8; 16]);
        let dg = sensor
            .seal(Kind::Delta, 0, nonce(0), &Frame::Delta(an_event()).encode().unwrap())
            .unwrap();
        s.receive(&dg, 0);

        // A replayed genuine datagram must not keep a dead sensor looking alive.
        for t in [50_000u64, 60_000, 70_000] {
            s.receive(&dg, t);
        }
        assert!(
            matches!(s.liveliness(80_000), Liveliness::Silent { .. }),
            "a replay kept a dead stream looking alive"
        );
    }

    // ---- silence is only observable if something looks ---------------------

    #[test]
    fn polling_with_no_traffic_at_all_still_reports_never_heard_then_silent() {
        let mut s = sub_at(0);
        // Not one datagram is ever fed in. This is the production failure mode:
        // the switch ate the frames, or the sensor never started.
        let first = s.poll(0);
        assert_eq!(first.len(), 1);
        assert!(matches!(
            first[0],
            Finding::LivelinessChanged { to: Liveliness::NeverHeard { .. } }
        ));

        // Still never-heard much later, and still not healthy.
        assert!(matches!(s.liveliness(10_000_000), Liveliness::NeverHeard { .. }));
    }

    #[test]
    fn a_stream_that_stops_is_reported_without_any_further_input() {
        let mut s = sub_at(0);
        let sensor = sensor([1u8; 16]);
        let dg = sensor
            .seal(Kind::Delta, 0, nonce(0), &Frame::Delta(an_event()).encode().unwrap())
            .unwrap();
        s.receive(&dg, 1_000);
        s.poll(1_000);

        // The sensor dies here. Nothing further arrives, ever.
        let late = s.poll(20_000);
        assert!(matches!(late[0], Finding::LivelinessChanged { to: Liveliness::Late { .. } }));
        let silent = s.poll(60_000);
        assert!(matches!(silent[0], Finding::LivelinessChanged { to: Liveliness::Silent { .. } }));
    }

    // ---- edge-triggered ----------------------------------------------------

    #[test]
    fn polling_repeatedly_in_one_state_yields_the_finding_once_not_once_per_poll() {
        let mut s = sub_at(0);
        assert_eq!(s.poll(0).len(), 1, "the first poll reports the initial state");
        for t in 1..500u64 {
            assert!(
                s.poll(t).is_empty(),
                "poll at {t} re-reported an unchanged state -- an alert every poll is not an alert"
            );
        }
    }

    #[test]
    fn the_current_state_stays_queryable_even_though_findings_are_edge_triggered() {
        let mut s = sub_at(0);
        s.poll(0);
        // No new finding, but a dashboard can still ask.
        assert!(s.poll(5_000).is_empty());
        assert!(matches!(s.liveliness(5_000), Liveliness::NeverHeard { .. }));
    }

    // ---- sequencing findings ----------------------------------------------

    #[test]
    fn a_gap_a_restart_and_a_replay_are_three_distinct_findings() {
        let mut s = sub_at(0);
        let live = sensor([1u8; 16]);
        let mk = |sen: &Sensor, seq: u64| {
            sen.seal(Kind::Delta, seq, nonce(seq), &Frame::Delta(an_event()).encode().unwrap())
                .unwrap()
        };

        s.receive(&mk(&live, 0), 0);
        let gap = s.receive(&mk(&live, 5), 100);
        assert!(gap.contains(&Finding::Gap { missing_from: 1, missing_to: 4 }));

        let replay = s.receive(&mk(&live, 3), 200);
        assert!(replay.contains(&Finding::Replayed { seq: 3, last: 5 }));

        let rebooted = sensor([2u8; 16]);
        let restart = s.receive(&mk(&rebooted, 0), 300);
        assert!(restart.contains(&Finding::SensorRestarted { previous_last_seq: 5 }));
    }

    // ---- posture -----------------------------------------------------------

    #[test]
    fn a_posture_change_is_reported_including_sealed_to_unknown() {
        let mut s = sub_at(0);
        let sensor = sensor([1u8; 16]);
        let mut seq = 0u64;
        let mut send = |s: &mut Subscription, posture: AttestedPosture| {
            let dg = sensor
                .seal(Kind::Snapshot, seq, nonce(seq), &snapshot_with(posture).encode().unwrap())
                .unwrap();
            seq += 1;
            s.receive(&dg, seq * 100)
        };

        let sealed = AttestedPosture::Sealed { loopback_listeners: 0, rows_examined: 40 };
        let f = send(&mut s, sealed.clone());
        assert!(f.iter().any(|x| matches!(x, Finding::PostureChanged { from: None, .. })));

        // Same posture again: no finding, or every snapshot would alert.
        let f = send(&mut s, sealed.clone());
        assert!(!f.iter().any(|x| matches!(x, Finding::PostureChanged { .. })));

        // Losing the ability to describe itself IS a change.
        let unknown = AttestedPosture::Unknown { reason: "/proc unreadable".into() };
        let f = send(&mut s, unknown.clone());
        assert!(
            f.iter().any(|x| matches!(
                x,
                Finding::PostureChanged { to: AttestedPosture::Unknown { .. }, .. }
            )),
            "sealed -> unknown must be reported: on a box nobody can log into, the sensor \
             losing the ability to describe itself is a real change, not missing data"
        );
    }

    #[test]
    fn a_snapshot_heals_a_degraded_view_and_the_transition_is_reported() {
        let mut s = sub_at(0);
        let sensor = sensor([1u8; 16]);
        let sealed = AttestedPosture::Sealed { loopback_listeners: 0, rows_examined: 40 };

        let dg = sensor
            .seal(Kind::Snapshot, 0, nonce(0), &snapshot_with(sealed.clone()).encode().unwrap())
            .unwrap();
        s.receive(&dg, 0);

        let dg = sensor
            .seal(Kind::Delta, 9, nonce(9), &Frame::Delta(an_event()).encode().unwrap())
            .unwrap();
        let f = s.receive(&dg, 100);
        assert!(f.contains(&Finding::ViewDegraded));

        let dg = sensor
            .seal(Kind::Snapshot, 10, nonce(10), &snapshot_with(sealed).encode().unwrap())
            .unwrap();
        let f = s.receive(&dg, 200);
        assert!(f.contains(&Finding::ViewWhole));
    }
}
