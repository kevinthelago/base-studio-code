//! What a subscriber makes of the order it received.
//!
//! There is no feedback channel, so this module never asks for anything to be
//! resent. Its whole job is to let a subscriber state precisely what it knows
//! and what it is missing -- and to tell the three cases apart that all look
//! like "the numbers jumped": a genuine LOSS, a sensor RESTART, and a REPLAY.
//!
//! Conflating them would be a real failure. A restart read as a gap invents
//! loss that never happened; a replay read as normal traffic lets an attacker
//! re-inject a stale "all clear" over a live alert.

use crate::envelope::{Envelope, Kind, BOOT_ID_LEN};
use crate::error::SequenceError;
use std::ops::RangeInclusive;

/// What one accepted datagram meant for the subscriber's view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reception {
    /// First datagram from this sensor.
    Started,
    /// Exactly the expected next sequence.
    InOrder,
    /// Datagrams were lost. The range is what never arrived; it can never be
    /// recovered directly, only superseded by the next snapshot.
    Gap { missing: RangeInclusive<u64> },
    /// The boot id changed: the sensor restarted. NOT a gap -- the preceding
    /// sequence simply ended, and numbering begins again.
    SensorRestarted {
        previous_boot: [u8; BOOT_ID_LEN],
        previous_last_seq: u64,
    },
}

/// Whether the subscriber's picture of sensor state is trustworthy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Completeness {
    /// Nothing has been missed since the last snapshot.
    Whole,
    /// Something was lost. Deltas since then may not be applicable, and the
    /// view stays degraded until a snapshot restates everything.
    Degraded,
}

/// Tracks one sensor's stream. Cheap and allocation-free in the steady state.
#[derive(Debug, Clone, Default)]
pub struct Tracker {
    seen: Option<Seen>,
    completeness: Option<Completeness>,
}

#[derive(Debug, Clone, Copy)]
struct Seen {
    boot_id: [u8; BOOT_ID_LEN],
    last_seq: u64,
}

impl Tracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// How much of the sensor's state this subscriber can currently trust.
    /// `None` before anything has been received.
    pub fn completeness(&self) -> Option<Completeness> {
        self.completeness
    }

    /// Record a cryptographically verified datagram.
    ///
    /// Only ever called with a genuine envelope -- forged datagrams are
    /// rejected by [`crate::crypto::Subscriber::open`] long before here, so
    /// this function is about ordering, not trust.
    pub fn accept(&mut self, env: &Envelope) -> Result<Reception, SequenceError> {
        let outcome = match self.seen {
            None => Reception::Started,
            Some(seen) if seen.boot_id != env.boot_id => Reception::SensorRestarted {
                previous_boot: seen.boot_id,
                previous_last_seq: seen.last_seq,
            },
            Some(seen) if env.seq <= seen.last_seq => {
                // Refused BEFORE any state is updated, so a replay cannot move
                // the tracker backwards or mask a later genuine datagram.
                return Err(SequenceError::Replay {
                    seq: env.seq,
                    last: seen.last_seq,
                });
            }
            Some(seen) if env.seq == seen.last_seq + 1 => Reception::InOrder,
            Some(seen) => Reception::Gap {
                missing: (seen.last_seq + 1)..=(env.seq - 1),
            },
        };

        self.seen = Some(Seen { boot_id: env.boot_id, last_seq: env.seq });

        // A snapshot restates everything, so it heals a degraded view no
        // matter what was lost before it -- that is the entire recovery
        // mechanism on a stream that cannot ask for a retransmission.
        self.completeness = Some(match env.kind {
            Kind::Snapshot => Completeness::Whole,
            Kind::Delta => match outcome {
                Reception::Gap { .. } => Completeness::Degraded,
                // A restart is not loss, but the subscriber has not yet seen a
                // snapshot from the NEW boot, so its picture of the new run is
                // incomplete until one arrives.
                Reception::SensorRestarted { .. } | Reception::Started => Completeness::Degraded,
                Reception::InOrder => self.completeness.unwrap_or(Completeness::Degraded),
            },
        });

        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::NONCE_LEN;

    fn env(boot: u8, seq: u64, kind: Kind) -> Envelope {
        Envelope {
            kind,
            boot_id: [boot; BOOT_ID_LEN],
            seq,
            nonce: [0u8; NONCE_LEN],
            ciphertext: vec![0u8; 16],
        }
    }

    #[test]
    fn the_first_datagram_starts_the_stream() {
        let mut t = Tracker::new();
        assert_eq!(t.accept(&env(1, 0, Kind::Delta)).unwrap(), Reception::Started);
    }

    #[test]
    fn consecutive_deltas_are_in_order() {
        let mut t = Tracker::new();
        t.accept(&env(1, 0, Kind::Snapshot)).unwrap();
        assert_eq!(t.accept(&env(1, 1, Kind::Delta)).unwrap(), Reception::InOrder);
        assert_eq!(t.accept(&env(1, 2, Kind::Delta)).unwrap(), Reception::InOrder);
    }

    #[test]
    fn a_gap_names_exactly_what_was_missed() {
        let mut t = Tracker::new();
        t.accept(&env(1, 0, Kind::Snapshot)).unwrap();
        assert_eq!(
            t.accept(&env(1, 5, Kind::Delta)).unwrap(),
            Reception::Gap { missing: 1..=4 }
        );
    }

    #[test]
    fn a_one_datagram_gap_is_a_single_element_range() {
        let mut t = Tracker::new();
        t.accept(&env(1, 0, Kind::Snapshot)).unwrap();
        assert_eq!(
            t.accept(&env(1, 2, Kind::Delta)).unwrap(),
            Reception::Gap { missing: 1..=1 }
        );
    }

    #[test]
    fn a_reboot_is_a_restart_and_never_a_gap() {
        let mut t = Tracker::new();
        t.accept(&env(1, 0, Kind::Snapshot)).unwrap();
        t.accept(&env(1, 9, Kind::Delta)).unwrap();
        // New boot id, sequence restarts at 0 -- which would look like a
        // catastrophic backwards jump if boot id were not consulted first.
        let r = t.accept(&env(2, 0, Kind::Delta)).unwrap();
        assert_eq!(
            r,
            Reception::SensorRestarted { previous_boot: [1; BOOT_ID_LEN], previous_last_seq: 9 }
        );
    }

    #[test]
    fn a_restart_is_not_reported_as_a_replay_even_though_seq_went_backwards() {
        let mut t = Tracker::new();
        t.accept(&env(1, 100, Kind::Snapshot)).unwrap();
        assert!(t.accept(&env(2, 0, Kind::Delta)).is_ok());
    }

    #[test]
    fn a_replayed_sequence_is_refused() {
        let mut t = Tracker::new();
        t.accept(&env(1, 0, Kind::Snapshot)).unwrap();
        t.accept(&env(1, 1, Kind::Delta)).unwrap();
        assert_eq!(
            t.accept(&env(1, 1, Kind::Delta)),
            Err(SequenceError::Replay { seq: 1, last: 1 })
        );
        assert_eq!(
            t.accept(&env(1, 0, Kind::Delta)),
            Err(SequenceError::Replay { seq: 0, last: 1 })
        );
    }

    #[test]
    fn a_refused_replay_does_not_move_the_tracker_backwards() {
        let mut t = Tracker::new();
        t.accept(&env(1, 0, Kind::Snapshot)).unwrap();
        t.accept(&env(1, 5, Kind::Delta)).unwrap();
        let _ = t.accept(&env(1, 2, Kind::Delta));
        // Still expecting 6 -- the replay must not have rewound anything.
        assert_eq!(t.accept(&env(1, 6, Kind::Delta)).unwrap(), Reception::InOrder);
    }

    #[test]
    fn a_gap_degrades_the_view_and_a_snapshot_restores_it() {
        let mut t = Tracker::new();
        t.accept(&env(1, 0, Kind::Snapshot)).unwrap();
        assert_eq!(t.completeness(), Some(Completeness::Whole));

        t.accept(&env(1, 4, Kind::Delta)).unwrap();
        assert_eq!(t.completeness(), Some(Completeness::Degraded));

        // No retransmission, no request -- the next snapshot alone heals it.
        t.accept(&env(1, 5, Kind::Snapshot)).unwrap();
        assert_eq!(t.completeness(), Some(Completeness::Whole));
    }

    #[test]
    fn an_in_order_delta_after_a_gap_does_not_silently_heal_the_view() {
        let mut t = Tracker::new();
        t.accept(&env(1, 0, Kind::Snapshot)).unwrap();
        t.accept(&env(1, 4, Kind::Delta)).unwrap();
        t.accept(&env(1, 5, Kind::Delta)).unwrap();
        assert_eq!(
            t.completeness(),
            Some(Completeness::Degraded),
            "only a snapshot may restore a degraded view"
        );
    }
}
