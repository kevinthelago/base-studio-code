//! Noticing that the sensor has gone quiet.
//!
//! ## Why silence has to be a finding
//!
//! The stream is one-way by construction, so there is no acknowledgement and
//! never can be. Every socket write on the sensor succeeds, its TX counters
//! climb, and nothing errors — because from the sensor's point of view
//! nothing IS wrong. **The sensor can never learn that nobody heard it.**
//!
//! That makes absence the subscriber's job, and it is not a passive one. The
//! failure modes all look identical from the receiving end and identical to a
//! quiet network: the switch dropped the frames, the Pi is powered off,
//! somebody unplugged it, a firewall rule stopped forwarding the group, the
//! sensor process died. Every one of them renders as "no datagrams", which is
//! also exactly what a healthy sensor on an idle network renders as if the
//! subscriber is only listening for events.
//!
//! So this module exists to make one distinction impossible to miss: **a
//! stream nobody hears must not look healthy.**
//!
//! ## Never-heard is its own state
//!
//! [`Liveliness::NeverHeard`] is deliberately separate from
//! [`Liveliness::Silent`] rather than folded into it. A subscriber that has
//! *never* received anything has a different problem from one that heard the
//! sensor and then lost it — the first is usually configuration (wrong group,
//! wrong key, or, on this network, a mirror-destination port that will not
//! forward ordinary traffic), the second is usually the sensor or the path.
//! Collapsing them would send somebody to debug the wrong half.
//!
//! ## Clockless on purpose
//!
//! This crate is guarded to perform no I/O, so it cannot read a clock; the
//! caller supplies monotonic milliseconds. That is not a workaround. It is
//! what lets every boundary be tested *exactly* — a test that sleeps to cross
//! a deadline is a test that fails on a loaded machine.

/// How the subscriber judges the sensor's cadence.
///
/// Derived from what the sensor promised rather than from a number somebody
/// picked: a subscriber knows the snapshot interval, so lateness is measured
/// against the sensor's own declared behaviour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cadence {
    /// How often a snapshot is due.
    pub snapshot_interval_ms: u64,
    /// How much slack before "late" — one dropped datagram on a lossy
    /// multicast path should not page anybody.
    pub grace_ms: u64,
    /// How many consecutive missed snapshots make it an alert rather than a
    /// wobble. Silence past this is treated as the stream being gone.
    pub missed_snapshots_before_alert: u32,
}

impl Cadence {
    /// The point past which a stream is merely late.
    pub fn late_after_ms(&self) -> u64 {
        self.snapshot_interval_ms.saturating_add(self.grace_ms)
    }

    /// The point past which a stream is considered gone.
    pub fn silent_after_ms(&self) -> u64 {
        self.snapshot_interval_ms
            .saturating_mul(u64::from(self.missed_snapshots_before_alert).max(1))
            .saturating_add(self.grace_ms)
    }
}

/// A liveness state stripped of its payload.
///
/// Exists because edge-triggering must key on the STATE and never on the
/// value: every [`Liveliness`] variant carries an elapsed time that changes on
/// every single poll, so comparing whole values makes each poll look like a
/// transition and produces an alert per poll — which is not an alert, it is
/// noise that trains an operator to filter the channel. Discovered by the
/// subscription's own edge-trigger test, 2026-09-04.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LivelinessKind {
    NeverHeard,
    Healthy,
    Late,
    Silent,
}

/// What the subscriber can say about whether the sensor is still there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveliness {
    /// Nothing has EVER been received. Not healthy at any elapsed time — on
    /// this network the leading suspect is a mirror-destination port that
    /// will not forward ordinary traffic, which would otherwise present as a
    /// permanently empty and entirely reassuring screen.
    NeverHeard { waiting_ms: u64 },
    /// Heard recently enough. The only state that does not want attention.
    Healthy { since_last_ms: u64 },
    /// Overdue, but not yet long enough to call it gone.
    Late { since_last_ms: u64, overdue_by_ms: u64 },
    /// Past the alert deadline. Treat the stream as gone.
    Silent { since_last_ms: u64, overdue_by_ms: u64 },
}

impl Liveliness {
    /// This verdict's state, without the elapsed time. Use for edge-triggering.
    pub fn kind(&self) -> LivelinessKind {
        match self {
            Liveliness::NeverHeard { .. } => LivelinessKind::NeverHeard,
            Liveliness::Healthy { .. } => LivelinessKind::Healthy,
            Liveliness::Late { .. } => LivelinessKind::Late,
            Liveliness::Silent { .. } => LivelinessKind::Silent,
        }
    }

    /// Healthy is the ONLY state that does not want a human. Never-heard
    /// wanting attention is the entire point of this module.
    pub fn needs_attention(&self) -> bool {
        match self {
            Liveliness::Healthy { .. } => false,
            Liveliness::NeverHeard { .. } | Liveliness::Late { .. } | Liveliness::Silent { .. } => true,
        }
    }

    /// Milliseconds since the last datagram, or since watching began if none
    /// has ever arrived. Present so a subscriber can render the number rather
    /// than only a colour — "quiet for 4 s" and "quiet for 4 days" are very
    /// different and must not share a pixel.
    pub fn elapsed_ms(&self) -> u64 {
        match self {
            Liveliness::NeverHeard { waiting_ms } => *waiting_ms,
            Liveliness::Healthy { since_last_ms }
            | Liveliness::Late { since_last_ms, .. }
            | Liveliness::Silent { since_last_ms, .. } => *since_last_ms,
        }
    }
}

/// Tracks one sensor's cadence. Holds no clock: every method takes `now_ms`.
#[derive(Debug, Clone)]
pub struct Watch {
    cadence: Cadence,
    started_ms: u64,
    last_seen_ms: Option<u64>,
}

impl Watch {
    /// Begin watching at `now_ms`. Starts in
    /// [`NeverHeard`](Liveliness::NeverHeard), never in a healthy state — a
    /// subscriber must earn the right to look fine by actually receiving
    /// something.
    pub fn started_at(cadence: Cadence, now_ms: u64) -> Self {
        Self { cadence, started_ms: now_ms, last_seen_ms: None }
    }

    /// Record that a datagram arrived.
    pub fn heard(&mut self, now_ms: u64) {
        // Monotonic in, monotonic out: a stale timestamp must never move the
        // watch backwards and make a dying stream look fresher than it is.
        self.last_seen_ms = Some(match self.last_seen_ms {
            Some(prev) => prev.max(now_ms),
            None => now_ms,
        });
    }

    pub fn cadence(&self) -> Cadence {
        self.cadence
    }

    /// The verdict as of `now_ms`.
    pub fn assess(&self, now_ms: u64) -> Liveliness {
        let Some(last) = self.last_seen_ms else {
            return Liveliness::NeverHeard {
                waiting_ms: now_ms.saturating_sub(self.started_ms),
            };
        };

        let since = now_ms.saturating_sub(last);

        if since > self.cadence.silent_after_ms() {
            Liveliness::Silent {
                since_last_ms: since,
                overdue_by_ms: since - self.cadence.silent_after_ms(),
            }
        } else if since > self.cadence.late_after_ms() {
            Liveliness::Late {
                since_last_ms: since,
                overdue_by_ms: since - self.cadence.late_after_ms(),
            }
        } else {
            Liveliness::Healthy { since_last_ms: since }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cadence() -> Cadence {
        Cadence { snapshot_interval_ms: 10_000, grace_ms: 2_000, missed_snapshots_before_alert: 3 }
    }

    #[test]
    fn the_deadlines_derive_from_the_sensors_declared_cadence() {
        let c = cadence();
        assert_eq!(c.late_after_ms(), 12_000);
        assert_eq!(c.silent_after_ms(), 32_000);
    }

    /// The property this module exists for.
    #[test]
    fn a_subscriber_that_has_heard_nothing_is_never_healthy() {
        let w = Watch::started_at(cadence(), 1_000);
        // Even at zero elapsed time, before any deadline could possibly have
        // passed, "I have heard nothing" must not render as fine.
        for now in [1_000u64, 1_001, 5_000, 1_000_000] {
            let v = w.assess(now);
            assert!(matches!(v, Liveliness::NeverHeard { .. }), "at {now}: {v:?}");
            assert!(v.needs_attention(), "never-heard must want attention at {now}");
        }
    }

    #[test]
    fn never_heard_is_distinct_from_silent_so_the_right_thing_gets_debugged() {
        let never = Watch::started_at(cadence(), 0).assess(100_000);
        let mut w = Watch::started_at(cadence(), 0);
        w.heard(0);
        let silent = w.assess(100_000);
        assert!(matches!(never, Liveliness::NeverHeard { .. }));
        assert!(matches!(silent, Liveliness::Silent { .. }));
        assert_ne!(never, silent, "a config problem and a dead sensor must not look the same");
    }

    #[test]
    fn a_freshly_heard_stream_is_healthy_and_wants_nothing() {
        let mut w = Watch::started_at(cadence(), 0);
        w.heard(5_000);
        let v = w.assess(6_000);
        assert_eq!(v, Liveliness::Healthy { since_last_ms: 1_000 });
        assert!(!v.needs_attention());
    }

    #[test]
    fn the_late_boundary_is_exact() {
        let mut w = Watch::started_at(cadence(), 0);
        w.heard(0);
        // Exactly at the deadline is still healthy; one millisecond past is not.
        assert!(matches!(w.assess(12_000), Liveliness::Healthy { .. }));
        assert!(matches!(w.assess(12_001), Liveliness::Late { overdue_by_ms: 1, .. }));
    }

    #[test]
    fn the_silent_boundary_is_exact() {
        let mut w = Watch::started_at(cadence(), 0);
        w.heard(0);
        assert!(matches!(w.assess(32_000), Liveliness::Late { .. }));
        assert!(matches!(w.assess(32_001), Liveliness::Silent { overdue_by_ms: 1, .. }));
    }

    #[test]
    fn hearing_the_sensor_again_restores_health() {
        let mut w = Watch::started_at(cadence(), 0);
        w.heard(0);
        assert!(w.assess(40_000).needs_attention());
        w.heard(40_000);
        assert!(!w.assess(40_500).needs_attention());
    }

    #[test]
    fn an_out_of_order_timestamp_cannot_make_a_dying_stream_look_fresher() {
        let mut w = Watch::started_at(cadence(), 0);
        w.heard(50_000);
        w.heard(10_000); // late-delivered, older datagram
        assert_eq!(w.assess(51_000), Liveliness::Healthy { since_last_ms: 1_000 });
    }

    #[test]
    fn every_verdict_reports_how_long_it_has_been_quiet() {
        let mut w = Watch::started_at(cadence(), 1_000);
        assert_eq!(w.assess(4_000).elapsed_ms(), 3_000);
        w.heard(5_000);
        assert_eq!(w.assess(9_000).elapsed_ms(), 4_000);
        assert_eq!(w.assess(20_000).elapsed_ms(), 15_000);
        assert_eq!(w.assess(90_000).elapsed_ms(), 85_000);
    }

    #[test]
    fn the_kind_is_stable_while_the_elapsed_time_moves() {
        // The property edge-triggering depends on: two verdicts in the same
        // state must compare equal by kind even though their payloads differ.
        let w = Watch::started_at(cadence(), 0);
        assert_ne!(w.assess(1_000), w.assess(2_000), "payloads legitimately differ");
        assert_eq!(w.assess(1_000).kind(), w.assess(2_000).kind(), "the state has not changed");
    }

    #[test]
    fn healthy_is_the_only_state_that_does_not_want_attention() {
        let states = [
            Liveliness::NeverHeard { waiting_ms: 0 },
            Liveliness::Healthy { since_last_ms: 0 },
            Liveliness::Late { since_last_ms: 0, overdue_by_ms: 0 },
            Liveliness::Silent { since_last_ms: 0, overdue_by_ms: 0 },
        ];
        let quiet: Vec<_> = states.iter().filter(|s| !s.needs_attention()).collect();
        assert_eq!(quiet.len(), 1, "exactly one state may be non-alertable");
        assert!(matches!(quiet[0], Liveliness::Healthy { .. }));
    }

    #[test]
    fn a_zero_missed_snapshot_cadence_still_produces_a_usable_deadline() {
        // Guards against a config that would otherwise collapse the silent
        // deadline onto the grace period and page on every single drop.
        let c = Cadence { snapshot_interval_ms: 10_000, grace_ms: 1_000, missed_snapshots_before_alert: 0 };
        assert_eq!(c.silent_after_ms(), 11_000);
    }
}
