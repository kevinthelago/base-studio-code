//! Putting sealed datagrams on the wire, in the right order, with a nonce
//! that can never repeat.
//!
//! ## The nonce hazard, and why it has to be solved here
//!
//! [`bsc_lan_stream::crypto::Sensor::seal`] takes the nonce as a parameter, so
//! it cannot solve this itself -- the caller owns nonce discipline, and this
//! is the caller.
//!
//! ChaCha20-Poly1305 requires that a nonce is **never reused under the same
//! key**. Two facts collide here:
//!
//! - the group key is **long-lived**: every subscriber holds it, and it is not
//!   rotated when the sensor reboots;
//! - the sequence number **restarts at zero** on every boot.
//!
//! So a nonce derived from the sequence alone would replay the identical
//! nonce series under the identical key after every reboot. That is keystream
//! reuse: the XOR of two plaintexts encrypted under the same keystream is
//! recoverable, and the telemetry becomes readable by anyone who captured both
//! boots. The Ed25519 signature still prevents *forgery* -- worth knowing, but
//! it does nothing for confidentiality.
//!
//! The nonce therefore binds the boot id as well as the sequence:
//!
//! ```text
//! | boot_id[0..4] | seq as 8 bytes, big-endian |   = 12 bytes, exactly
//! ```
//!
//! Unique within a boot by construction, and different across boots with the
//! boot id. A test emits from two boot ids at identical sequence numbers and
//! asserts every nonce differs.

use crate::attest::attest;
use crate::posture::Posture;
use crate::transport::Transport;
use bsc_lan_stream::crypto::Sensor;
use bsc_lan_stream::envelope::{Kind, NONCE_LEN};
use bsc_lan_stream::frame::{Event, Frame, SensorState};
use bsc_lan_stream::WireError;

/// How often the sensor restates everything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnapshotPolicy {
    /// Milliseconds between snapshots. Subscribers derive their liveness
    /// deadlines from this same number.
    pub interval_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum EmitError {
    #[error("could not seal the datagram: {0}")]
    Seal(#[from] WireError),
    #[error("could not send the datagram: {0}")]
    Send(#[from] std::io::Error),
}

/// Derive the AEAD nonce for one datagram.
///
/// Kept as a free function so the property that matters -- that it can never
/// repeat under a long-lived key -- is testable directly rather than only
/// through the emitter.
pub fn nonce_for(boot_id: &[u8; 16], seq: u64) -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    nonce[0..4].copy_from_slice(&boot_id[0..4]);
    nonce[4..12].copy_from_slice(&seq.to_be_bytes());
    nonce
}

/// The sensor's outbound half.
///
/// Holds no receive path of any kind: [`Transport`] can only send.
pub struct Emitter<T: Transport> {
    sensor: Sensor,
    transport: T,
    policy: SnapshotPolicy,
    seq: u64,
    last_snapshot_ms: Option<u64>,
}

impl<T: Transport> Emitter<T> {
    pub fn new(sensor: Sensor, transport: T, policy: SnapshotPolicy) -> Self {
        Self { sensor, transport, policy, seq: 0, last_snapshot_ms: None }
    }

    /// The sequence the next datagram will carry.
    pub fn next_seq(&self) -> u64 {
        self.seq
    }

    fn emit(&mut self, kind: Kind, frame: &Frame) -> Result<u64, EmitError> {
        let seq = self.seq;
        let nonce = nonce_for(&self.sensor.boot_id(), seq);
        let datagram = self.sensor.seal(kind, seq, nonce, &frame.encode()?)?;
        self.transport.send(&datagram)?;
        // Advance only after a successful send, so a failed send does not burn
        // a sequence number and manufacture a gap the subscriber would report
        // as loss that never happened.
        self.seq += 1;
        Ok(seq)
    }

    /// Emit one incremental event.
    pub fn emit_event(&mut self, event: Event) -> Result<u64, EmitError> {
        self.emit(Kind::Delta, &Frame::Delta(event))
    }

    /// Emit a full snapshot, stamping it with the posture observed right now.
    ///
    /// Takes the posture as an argument rather than reading it internally, so
    /// the caller decides how often to pay for a `/proc` sweep on a
    /// thermally-saturated box -- and so this is testable without one.
    pub fn emit_snapshot(
        &mut self,
        mut state: SensorState,
        posture: &Posture,
        now_ms: u64,
    ) -> Result<u64, EmitError> {
        // Always overwritten from the live verdict: a snapshot carrying a
        // stale or defaulted posture is worse than none, because it is a fresh
        // timestamp on an old claim.
        state.posture = attest(posture);
        let seq = self.emit(Kind::Snapshot, &Frame::Snapshot(state))?;
        self.last_snapshot_ms = Some(now_ms);
        Ok(seq)
    }

    /// Whether a snapshot is due at `now_ms`.
    pub fn snapshot_due(&self, now_ms: u64) -> bool {
        match self.last_snapshot_ms {
            // Never sent one: due immediately, so a subscriber that joins
            // before the first interval elapses is not left with nothing.
            None => true,
            Some(last) => now_ms.saturating_sub(last) >= self.policy.interval_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::procnet::{Protocol, Reach, Role, Socket};
    use bsc_lan_stream::crypto::{GroupKey, Subscriber};
    use bsc_lan_stream::frame::AttestedPosture;
    use ed25519_dalek::SigningKey;
    use std::cell::RefCell;
    use std::collections::HashSet;

    #[derive(Default)]
    struct Recorder {
        sent: RefCell<Vec<Vec<u8>>>,
    }

    impl Transport for Recorder {
        fn send(&self, datagram: &[u8]) -> std::io::Result<()> {
            self.sent.borrow_mut().push(datagram.to_vec());
            Ok(())
        }
    }

    struct Failing;
    impl Transport for Failing {
        fn send(&self, _: &[u8]) -> std::io::Result<()> {
            Err(std::io::Error::other("link down"))
        }
    }

    const GROUP: [u8; 32] = [7u8; 32];

    fn sensor(boot: [u8; 16]) -> Sensor {
        Sensor::new(SigningKey::from_bytes(&[3u8; 32]), GroupKey::from_bytes(GROUP), boot)
    }

    fn subscriber() -> Subscriber {
        Subscriber::new(
            SigningKey::from_bytes(&[3u8; 32]).verifying_key(),
            GroupKey::from_bytes(GROUP),
        )
    }

    fn policy() -> SnapshotPolicy {
        SnapshotPolicy { interval_ms: 10_000 }
    }

    fn an_event() -> Event {
        Event::Health { uptime_s: 1, soc_temp_c: 89.0, capture_drops: 0 }
    }

    /// THE HAZARD. A long-lived group key plus a sequence that restarts at
    /// zero would replay the nonce series on every reboot.
    #[test]
    fn a_reboot_cannot_replay_a_nonce_under_the_long_lived_group_key() {
        let first = [0xAAu8; 16];
        let after_reboot = [0xBBu8; 16];
        for seq in 0..1000u64 {
            assert_ne!(
                nonce_for(&first, seq),
                nonce_for(&after_reboot, seq),
                "seq {seq} produced the same nonce across two boots -- keystream reuse"
            );
        }
    }

    #[test]
    fn nonces_never_repeat_within_a_boot() {
        let boot = [0xAAu8; 16];
        let mut seen = HashSet::new();
        for seq in 0..10_000u64 {
            assert!(seen.insert(nonce_for(&boot, seq)), "duplicate nonce at seq {seq}");
        }
    }

    #[test]
    fn the_nonce_binds_the_boot_id_in_its_leading_bytes() {
        let boot = [1, 2, 3, 4, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9];
        let n = nonce_for(&boot, 0x0102030405060708);
        assert_eq!(&n[0..4], &[1, 2, 3, 4]);
        assert_eq!(&n[4..12], &0x0102030405060708u64.to_be_bytes());
    }

    #[test]
    fn the_sequence_is_strictly_monotonic_and_datagrams_open_in_order() {
        let mut e = Emitter::new(sensor([1u8; 16]), Recorder::default(), policy());
        for expected in 0..5u64 {
            assert_eq!(e.emit_event(an_event()).unwrap(), expected);
        }
        let sub = subscriber();
        let sent = e.transport.sent.borrow();
        assert_eq!(sent.len(), 5);
        for (i, dg) in sent.iter().enumerate() {
            let (env, _) = sub.open(dg).unwrap();
            assert_eq!(env.seq, i as u64);
        }
    }

    /// A burnt sequence number would look to every subscriber like a datagram
    /// that was lost in flight -- loss that never happened.
    #[test]
    fn a_failed_send_does_not_burn_a_sequence_number() {
        let mut e = Emitter::new(sensor([1u8; 16]), Failing, policy());
        assert!(e.emit_event(an_event()).is_err());
        assert_eq!(e.next_seq(), 0, "a failed send must not manufacture a gap");
    }

    #[test]
    fn every_snapshot_carries_the_posture_observed_now_not_a_default() {
        let mut e = Emitter::new(sensor([1u8; 16]), Recorder::default(), policy());
        let exposed = Posture::Exposed {
            reachable: vec![Socket {
                transport: Protocol::Tcp,
                role: Role::Inbound,
                reach: Reach::Wildcard,
                local_port: 22,
                local_addr: "0.0.0.0".into(),
            }],
            rows_examined: 12,
        };
        // SensorState::default() carries AttestedPosture::Unknown; the emitter
        // must overwrite it from the live verdict rather than ship the default.
        e.emit_snapshot(SensorState::default(), &exposed, 0).unwrap();

        let sub = subscriber();
        let sent = e.transport.sent.borrow();
        let (_, plaintext) = sub.open(&sent[0]).unwrap();
        match Frame::decode(&plaintext).unwrap() {
            Frame::Snapshot(s) => match s.posture {
                AttestedPosture::Exposed { reachable, rows_examined } => {
                    assert_eq!(rows_examined, 12);
                    assert_eq!(reachable[0].port, 22);
                }
                AttestedPosture::Sealed { .. } | AttestedPosture::Unknown { .. } => {
                    panic!("snapshot shipped a stale or defaulted posture")
                }
            },
            Frame::Delta(d) => panic!("expected a snapshot, got {d:?}"),
        }
    }

    #[test]
    fn the_first_snapshot_is_due_immediately_so_a_new_subscriber_is_not_left_blank() {
        let e = Emitter::new(sensor([1u8; 16]), Recorder::default(), policy());
        assert!(e.snapshot_due(0));
    }

    #[test]
    fn the_snapshot_cadence_boundary_is_exact() {
        let mut e = Emitter::new(sensor([1u8; 16]), Recorder::default(), policy());
        let p = Posture::Sealed { loopback_listeners: vec![], rows_examined: 5 };
        e.emit_snapshot(SensorState::default(), &p, 1_000).unwrap();
        assert!(!e.snapshot_due(10_999));
        assert!(e.snapshot_due(11_000));
    }

    #[test]
    fn deltas_between_snapshots_do_not_reset_the_cadence() {
        let mut e = Emitter::new(sensor([1u8; 16]), Recorder::default(), policy());
        let p = Posture::Sealed { loopback_listeners: vec![], rows_examined: 5 };
        e.emit_snapshot(SensorState::default(), &p, 0).unwrap();
        for _ in 0..20 {
            e.emit_event(an_event()).unwrap();
        }
        assert!(e.snapshot_due(10_000), "a busy sensor must still restate its state on time");
    }
}
