//! Turning an RF finding into the event that goes on the wire.
//!
//! Kept as its own module, like [`crate::attest`], because this is the point
//! where a carefully-hedged local judgement is flattened into something other
//! machines act on — and flattening is where hedges get lost.
//!
//! ## The bounding here is a security control, not tidiness
//!
//! A deauth verdict's `claimed_bssid` and `top_target` come from frames the
//! **attacker transmits**. So does the reason code. An unbounded field would
//! let a crafted frame produce an event too large for one datagram, `seal()`
//! would correctly refuse it, and the sensor would go silent for exactly the
//! attack it was reporting — the alert about the attack suppressed by the
//! attack. Identical in shape to the EVE bounds, and worth restating because
//! the field looks harmless: a MAC address is "obviously" 17 characters, right
//! up until something writes one that is not.

use bsc_lan_stream::envelope::MAX_PLAINTEXT_BYTES;
use bsc_lan_stream::frame::{Event, Frame};
use bsc_rf::deauth::{Evidence, Verdict};

/// A MAC address is 17 characters. Anything longer did not come from a
/// well-formed frame, so it is cut rather than trusted.
pub const MAX_MAC_BYTES: usize = 17;
/// Reason codes worth carrying. The distribution's tail says nothing a
/// responder acts on, and an unbounded list is attacker-controlled length.
pub const MAX_REASONS: usize = 8;

fn bounded_mac(s: &str) -> String {
    let mut out: String = s.chars().take(MAX_MAC_BYTES).collect();
    // char-boundary safe by construction (take on chars), and re-checked
    // against the byte budget for multi-byte input that a frame should never
    // contain but might.
    while out.len() > MAX_MAC_BYTES {
        out.pop();
    }
    out
}

fn event_from(evidence: &Evidence, flood: bool) -> Event {
    Event::RfDeauthFlood {
        flood,
        frames: evidence.frames,
        broadcast_frames: evidence.broadcast_frames,
        window_ms: evidence.window_ms,
        rate_centi_per_s: evidence.rate_centi_per_s,
        claimed_bssid: bounded_mac(&evidence.top_bssid),
        top_target: bounded_mac(&evidence.top_target),
        distinct_targets: evidence.distinct_targets,
        reasons: evidence.reasons.iter().copied().take(MAX_REASONS).collect(),
    }
}

/// The wire event for a verdict, or `None` when there is nothing to say.
///
/// Every arm is written out: a new [`Verdict`] variant fails to compile here
/// rather than silently taking a neighbouring meaning on the wire.
pub fn wire_event(v: &Verdict) -> Option<Event> {
    match v {
        // Quiet is the steady state and would flood the stream with
        // non-events; the snapshot already carries the sensor's health.
        Verdict::Quiet { .. } => None,
        // NOT emitted as an RF finding: a radio that saw nothing is a SENSOR
        // fault, not an RF observation, and it belongs in the posture the
        // snapshot already attests. Emitting it here would let "my capture is
        // broken" render as "the air is clear".
        Verdict::NotObserved => None,
        Verdict::Elevated(e) => Some(event_from(e, false)),
        Verdict::Flood(e) => Some(event_from(e, true)),
    }
}

/// Whether an event fits one datagram — the bound that stops a crafted frame
/// silencing the report about itself.
pub fn fits_one_datagram(e: &Event) -> bool {
    Frame::Delta(e.clone())
        .encode()
        .map(|b| b.len() <= MAX_PLAINTEXT_BYTES)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsc_rf::deauth::{assess, FrameKind, FrameObservation, Policy};

    fn evidence(bssid: &str, target: &str, reasons: Vec<u16>) -> Evidence {
        Evidence {
            frames: 40,
            broadcast_frames: 40,
            window_ms: 10_000,
            rate_centi_per_s: 400,
            top_bssid: bssid.into(),
            top_target: target.into(),
            distinct_targets: 1,
            reasons,
        }
    }

    #[test]
    fn a_flood_becomes_an_actionable_wire_event() {
        let e = wire_event(&Verdict::Flood(evidence(
            "aa:bb:cc:dd:ee:ff",
            "11:22:33:44:55:66",
            vec![7],
        )))
        .expect("a flood must reach the wire");
        match e {
            Event::RfDeauthFlood { flood, top_target, claimed_bssid, window_ms, .. } => {
                assert!(flood);
                assert_eq!(top_target, "11:22:33:44:55:66", "a responder must know WHICH client");
                assert_eq!(claimed_bssid, "aa:bb:cc:dd:ee:ff");
                assert_eq!(window_ms, 10_000, "the rate is meaningless without its window");
            }
            Event::Alert { .. }
            | Event::Flow { .. }
            | Event::Health { .. }
            | Event::RfChannelActivity { .. }
            | Event::RfSpectrum { .. }
            | Event::PostureChanged { .. } => panic!("expected an RfDeauthFlood event"),
        }
    }

    #[test]
    fn elevated_is_distinguishable_from_a_flood_on_the_wire() {
        // A subscriber may reasonably act on one and only log the other.
        let f = wire_event(&Verdict::Flood(evidence("a", "b", vec![]))).unwrap();
        let el = wire_event(&Verdict::Elevated(evidence("a", "b", vec![]))).unwrap();
        assert_ne!(f, el);
    }

    #[test]
    fn quiet_says_nothing_and_an_unobserved_radio_is_not_an_rf_finding() {
        assert!(wire_event(&Verdict::Quiet { frames: 2, window_ms: 10_000 }).is_none());
        // The important one: a broken capture must NOT render as clear air.
        // It belongs in the sensor's attested posture, not here.
        assert!(wire_event(&Verdict::NotObserved).is_none());
    }

    /// THE SILENCING ATTACK, in its RF form. The addresses come from frames
    /// the attacker transmits.
    #[test]
    fn no_crafted_frame_can_produce_an_un_emittable_rf_event() {
        let huge_mac = "a".repeat(4_000);
        let many_reasons: Vec<u16> = (0..5_000).map(|i| i as u16).collect();
        let e = wire_event(&Verdict::Flood(evidence(&huge_mac, &huge_mac, many_reasons)))
            .expect("a flood must still reach the wire");
        assert!(
            fits_one_datagram(&e),
            "a crafted frame produced an RF event that cannot be emitted — the attacker \
             would have silenced the alert about their own attack"
        );
    }

    #[test]
    fn truncation_of_an_address_never_splits_a_character() {
        // A frame should never carry multi-byte here, but the input is
        // attacker-written and slicing bytes on a char boundary panics.
        for pad in 0..6usize {
            let s = format!("{}{}", "a".repeat(pad), "☃".repeat(40));
            let out = bounded_mac(&s);
            assert!(out.len() <= MAX_MAC_BYTES, "pad {pad}: {} bytes", out.len());
            assert!(out.is_char_boundary(out.len()));
        }
    }

    /// End to end from raw observations, so the detector and the bridge are
    /// exercised as a pair rather than each against its own assumptions.
    #[test]
    fn a_broadcast_flood_travels_from_observation_to_wire_event() {
        let o: Vec<_> = (0..5)
            .map(|i| FrameObservation {
                at_ms: 1_000 + i * 100,
                kind: FrameKind::Deauthentication,
                bssid: "aa:bb:cc:dd:ee:ff".into(),
                target: "ff:ff:ff:ff:ff:ff".into(),
                reason: Some(7),
            })
            .collect();
        let v = assess(&o, 10_000, Policy::sensible());
        let e = wire_event(&v).expect("a broadcast flood must reach the wire");
        assert!(fits_one_datagram(&e));
        match e {
            Event::RfDeauthFlood { flood, broadcast_frames, top_target, .. } => {
                assert!(flood);
                assert_eq!(broadcast_frames, 5);
                assert_eq!(top_target, "ff:ff:ff:ff:ff:ff");
            }
            Event::Alert { .. }
            | Event::Flow { .. }
            | Event::Health { .. }
            | Event::RfChannelActivity { .. }
            | Event::RfSpectrum { .. }
            | Event::PostureChanged { .. } => panic!("expected an RfDeauthFlood event"),
        }
    }
}
