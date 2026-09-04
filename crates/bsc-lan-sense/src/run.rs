//! The sensor's run loop: EVE lines and time in, datagrams out.
//!
//! Pure. It takes lines and a caller-supplied monotonic clock and writes
//! through the [`Transport`](crate::transport::Transport) seam, so the whole
//! loop is exercised with a fake clock and a recording transport — on a
//! laptop, with no sensor and no network.
//!
//! ## The sensor must not amplify an attack against its own network
//!
//! Alert volume is chosen by the **adversary**: they decide how much traffic
//! to send, and therefore how many alerts Suricata writes. A loop that emits
//! one datagram per alert turns the sensor into an amplifier — ten thousand
//! alerts a second becomes ten thousand multicast datagrams a second, which
//! saturates the group for every subscriber, floods the switch, and pins a Pi
//! that is already CPU-capped to 1.5 GHz and sitting at ~90 °C idle.
//!
//! That is strictly worse than the sensor merely falling behind: the datagrams
//! are real, signed and valid, so **no subscriber can distinguish the flood
//! from legitimate urgency**. The sensor becomes a weapon against the network
//! it exists to protect, and against itself.
//!
//! So emission is rate-bounded — and the bound is *not* a silent drop.
//! Suppressed events are counted and the count rides the next snapshot, so a
//! subscriber learns "the sensor saw 9,400 more alerts than it could send"
//! rather than simply seeing fewer alerts. Losing that count would be the
//! worst outcome available: it would make a flood look like quiet, the same
//! confusion the silence-detection work exists to prevent, arriving from the
//! opposite direction.

use crate::emit::{EmitError, Emitter};
use crate::eve::{self, EveCounters, Parsed};
use crate::posture::Posture;
use crate::transport::Transport;
use bsc_lan_stream::frame::{Event, SensorState};

/// How fast the sensor is allowed to emit.
///
/// A token bucket: `burst` datagrams may go out back to back, refilling at
/// `per_second`. A burst allowance matters because real incidents are bursty —
/// a scan produces a genuine cluster of alerts — so a flat rate would smear
/// exactly the events an operator most wants to see promptly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimit {
    pub per_second: u32,
    pub burst: u32,
}

impl RateLimit {
    /// Deliberately modest. The link is shared multicast and the sensor is
    /// thermally saturated; the ceiling exists to protect the network and the
    /// box, not to express how much the sensor would like to say.
    pub const fn conservative() -> Self {
        Self { per_second: 20, burst: 40 }
    }
}

/// Token bucket over the caller's monotonic clock.
#[derive(Debug, Clone)]
struct Bucket {
    limit: RateLimit,
    /// Scaled by 1000 so refill is integer arithmetic on milliseconds — no
    /// floats, so the behaviour is identical on every target and in tests.
    milli_tokens: u64,
    last_ms: u64,
}

impl Bucket {
    fn new(limit: RateLimit, now_ms: u64) -> Self {
        Self { limit, milli_tokens: u64::from(limit.burst) * 1000, last_ms: now_ms }
    }

    fn take(&mut self, now_ms: u64) -> bool {
        let elapsed = now_ms.saturating_sub(self.last_ms);
        self.last_ms = now_ms;
        let refill = elapsed.saturating_mul(u64::from(self.limit.per_second));
        let ceiling = u64::from(self.limit.burst) * 1000;
        self.milli_tokens = self.milli_tokens.saturating_add(refill).min(ceiling);

        if self.milli_tokens >= 1000 {
            self.milli_tokens -= 1000;
            true
        } else {
            false
        }
    }
}

/// What the loop did, for the caller and for the next snapshot.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RunCounters {
    pub eve: EveCounters,
    pub emitted: u64,
    /// Events parsed successfully but not sent, because the rate cap bit.
    /// Reported on the wire — never silently discarded.
    pub suppressed: u64,
    pub snapshots: u64,
}

/// The sensor loop.
pub struct SensorRun<T: Transport> {
    emitter: Emitter<T>,
    bucket: Bucket,
    counters: RunCounters,
}

impl<T: Transport> SensorRun<T> {
    pub fn new(emitter: Emitter<T>, limit: RateLimit, now_ms: u64) -> Self {
        Self { emitter, bucket: Bucket::new(limit, now_ms), counters: RunCounters::default() }
    }

    pub fn counters(&self) -> RunCounters {
        self.counters
    }

    /// The emitter, for callers that need its sequence or transport.
    pub fn emitter(&self) -> &Emitter<T> {
        &self.emitter
    }

    /// Feed one line of Suricata's EVE output.
    pub fn on_eve_line(&mut self, line: &str, now_ms: u64) -> Result<(), EmitError> {
        let parsed = match eve::parse_line(line) {
            Ok(p) => p,
            Err(_) => {
                // Counted, not silently skipped: a parser that quietly
                // discards what it cannot read reports a clean stream while
                // seeing nothing.
                self.counters.eve.malformed += 1;
                return Ok(());
            }
        };

        let event = match parsed {
            Parsed::NotForwarded(_) => {
                self.counters.eve.not_forwarded += 1;
                return Ok(());
            }
            Parsed::Event(e) => e,
        };
        self.counters.eve.forwarded += 1;

        if !self.bucket.take(now_ms) {
            // The whole point: the adversary sets the volume, so the ceiling
            // is ours. Counted so the suppression is visible on the wire.
            self.counters.suppressed += 1;
            return Ok(());
        }

        self.emitter.emit_event(event)?;
        self.counters.emitted += 1;
        Ok(())
    }

    /// Whether a snapshot is due.
    pub fn snapshot_due(&self, now_ms: u64) -> bool {
        self.emitter.snapshot_due(now_ms)
    }

    /// Emit a snapshot carrying the counters and a **freshly observed**
    /// posture.
    ///
    /// The posture is passed in rather than cached across snapshots on
    /// purpose: a snapshot stamped with a posture observed minutes ago is a
    /// fresh timestamp on a stale claim, which is exactly what the attestation
    /// work set out to avoid. The `/proc` sweep is four small files on a
    /// ten-second cadence and is affordable even on this box.
    pub fn emit_snapshot(
        &mut self,
        posture: &Posture,
        monotonic_us: u64,
        now_ms: u64,
    ) -> Result<(), EmitError> {
        let mut state = SensorState { monotonic_us, ..Default::default() };
        let c = self.counters;
        state.counters.insert("eve.forwarded".into(), c.eve.forwarded);
        state.counters.insert("eve.not_forwarded".into(), c.eve.not_forwarded);
        state.counters.insert("eve.malformed".into(), c.eve.malformed);
        state.counters.insert("emitted".into(), c.emitted);
        // The number that turns a flood into information instead of silence.
        state.counters.insert("suppressed".into(), c.suppressed);

        self.emitter.emit_snapshot(state, posture, now_ms)?;
        self.counters.snapshots += 1;
        Ok(())
    }

    /// Convenience for a caller that has a health reading to hand.
    pub fn emit_health(&mut self, health: Event, now_ms: u64) -> Result<(), EmitError> {
        if !self.bucket.take(now_ms) {
            self.counters.suppressed += 1;
            return Ok(());
        }
        self.emitter.emit_event(health)?;
        self.counters.emitted += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::emit::SnapshotPolicy;
    use crate::transport::Transport as TransportTrait;
    use bsc_lan_stream::crypto::{GroupKey, Sensor, Subscriber};
    use bsc_lan_stream::frame::Frame;
    use ed25519_dalek::SigningKey;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Recorder {
        sent: RefCell<Vec<Vec<u8>>>,
    }
    impl TransportTrait for Recorder {
        fn send(&self, d: &[u8]) -> std::io::Result<()> {
            self.sent.borrow_mut().push(d.to_vec());
            Ok(())
        }
    }

    const GROUP: [u8; 32] = [7u8; 32];

    fn run(limit: RateLimit) -> SensorRun<Recorder> {
        let sensor = Sensor::new(
            SigningKey::from_bytes(&[3u8; 32]),
            GroupKey::from_bytes(GROUP),
            [1u8; 16],
        );
        SensorRun::new(
            Emitter::new(sensor, Recorder::default(), SnapshotPolicy { interval_ms: 10_000 }),
            limit,
            0,
        )
    }

    fn subscriber() -> Subscriber {
        Subscriber::new(
            SigningKey::from_bytes(&[3u8; 32]).verifying_key(),
            GroupKey::from_bytes(GROUP),
        )
    }

    const ALERT: &str = r#"{"event_type":"alert","src_ip":"10.99.4.66","dest_ip":"10.99.2.1","alert":{"signature_id":2010935,"signature":"ET SCAN","severity":2}}"#;

    /// THE ATTACK. An adversary chooses the alert volume; the datagram count
    /// must stay bounded regardless.
    #[test]
    fn a_flood_of_alerts_cannot_produce_a_flood_of_datagrams() {
        let mut r = run(RateLimit { per_second: 20, burst: 40 });
        // Ten thousand alerts in the same millisecond — a scan, or someone
        // deliberately generating them.
        for _ in 0..10_000 {
            r.on_eve_line(ALERT, 0).unwrap();
        }
        let c = r.counters();
        assert_eq!(c.eve.forwarded, 10_000, "every line was parsed");
        assert_eq!(c.emitted, 40, "emission is capped at the burst allowance");
        assert_eq!(c.suppressed, 9_960, "the rest are counted, not forgotten");
    }

    #[test]
    fn the_budget_refills_so_a_reasonable_sustained_rate_is_not_penalised_forever() {
        let mut r = run(RateLimit { per_second: 20, burst: 20 });
        for _ in 0..20 {
            r.on_eve_line(ALERT, 0).unwrap();
        }
        assert_eq!(r.counters().emitted, 20);
        // A full second later the bucket has refilled.
        for _ in 0..20 {
            r.on_eve_line(ALERT, 1_000).unwrap();
        }
        assert_eq!(r.counters().emitted, 40, "a steady legitimate rate must get through");
    }

    #[test]
    fn the_bucket_never_refills_past_its_burst_ceiling() {
        let mut r = run(RateLimit { per_second: 20, burst: 20 });
        // Idle for an hour: the allowance must not accumulate into a flood.
        for _ in 0..1_000 {
            r.on_eve_line(ALERT, 3_600_000).unwrap();
        }
        assert_eq!(r.counters().emitted, 20, "an idle sensor must not bank a burst");
    }

    /// If the suppressed count were lost, a flood would look like quiet — the
    /// same confusion silence-detection exists to prevent, from the other side.
    #[test]
    fn the_suppressed_count_reaches_the_wire_so_a_flood_never_looks_like_quiet() {
        let mut r = run(RateLimit { per_second: 1, burst: 1 });
        for _ in 0..500 {
            r.on_eve_line(ALERT, 0).unwrap();
        }
        let posture = Posture::Sealed { loopback_listeners: vec![], rows_examined: 40 };
        r.emit_snapshot(&posture, 1_000_000, 0).unwrap();

        let sub = subscriber();
        let sent = r.emitter().transport().sent.borrow();
        let last = sent.last().expect("a snapshot was emitted");
        let (_, plaintext) = sub.open(last).unwrap();
        match Frame::decode(&plaintext).unwrap() {
            Frame::Snapshot(s) => {
                assert_eq!(
                    s.counters.get("suppressed"),
                    Some(&499),
                    "the suppression must reach a subscriber, or a flood is indistinguishable \
                     from quiet"
                );
                assert_eq!(s.counters.get("eve.forwarded"), Some(&500));
            }
            Frame::Delta(d) => panic!("expected a snapshot, got {d:?}"),
        }
    }

    #[test]
    fn a_malformed_eve_line_is_counted_and_does_not_stop_the_loop() {
        let mut r = run(RateLimit::conservative());
        r.on_eve_line("{not json", 0).unwrap();
        r.on_eve_line(ALERT, 0).unwrap();
        let c = r.counters();
        assert_eq!(c.eve.malformed, 1);
        assert_eq!(c.emitted, 1, "a bad line must not stop the next good one");
    }

    #[test]
    fn a_type_we_do_not_forward_is_counted_separately_from_malformed() {
        let mut r = run(RateLimit::conservative());
        r.on_eve_line(r#"{"event_type":"stats","stats":{}}"#, 0).unwrap();
        let c = r.counters();
        assert_eq!(c.eve.not_forwarded, 1);
        assert_eq!(c.eve.malformed, 0, "ordinary traffic must not inflate the malformed count");
    }

    #[test]
    fn a_snapshot_is_still_due_on_cadence_while_the_loop_is_busy() {
        let mut r = run(RateLimit::conservative());
        let posture = Posture::Sealed { loopback_listeners: vec![], rows_examined: 40 };
        r.emit_snapshot(&posture, 0, 0).unwrap();
        for _ in 0..5_000 {
            r.on_eve_line(ALERT, 5_000).unwrap();
        }
        assert!(r.snapshot_due(10_000), "a busy sensor must still restate its state on time");
    }

    #[test]
    fn suppression_does_not_burn_sequence_numbers() {
        let mut r = run(RateLimit { per_second: 1, burst: 1 });
        for _ in 0..100 {
            r.on_eve_line(ALERT, 0).unwrap();
        }
        // One emitted, ninety-nine suppressed: the wire must show exactly one
        // datagram, or subscribers would see a gap for events never sent.
        assert_eq!(r.emitter().transport().sent.borrow().len(), 1);
    }
}
