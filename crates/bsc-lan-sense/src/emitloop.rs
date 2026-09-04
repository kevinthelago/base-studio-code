//! Turning observed spectrum into datagrams on the wire.
//!
//! ## The destination is configured, never discovered
//!
//! Measured: multicast does not cross a VLAN boundary without a multicast
//! router, and OPNsense does not do that by default — so a multicast-only
//! stream reaches the sensor's own segment and nobody else. Unicast does cross;
//! the inter-VLAN policy allows `MONITOR → Any`, and a probe from the sensor to
//! a desktop on another VLAN arrived.
//!
//! So the sensor sends **where it is told**: a multicast group for same-segment
//! subscribers, or a unicast collector to cross a VLAN. That is configuration
//! written when the SD card is written — not a dynamic subscriber list, which
//! the sensor could not manage anyway through an inbound channel it does not
//! have.
//!
//! ## A barren window emits nothing
//!
//! If the radio produced no samples, this sends **no datagram at all** rather
//! than a spectrum of zeroes. On a display those are indistinguishable, and
//! only one of them is good news. The subscriber's own silence detection is
//! what reports the gap — which is precisely what that machinery was built for,
//! so inventing an empty record here would defeat it.

use crate::spectrum::SpectrumRead;
use bsc_lan_stream::envelope::Kind;
use bsc_lan_stream::frame::{Event, Frame};

/// One window's worth of spectrum, as events ready to seal.
///
/// Pure: takes what was observed and returns what should go on the wire, so the
/// emit policy is testable without a radio or a socket.
pub fn events_for(read: &SpectrumRead) -> Vec<Event> {
    // The rule that matters. Nothing observed is NOT a quiet band, and a record
    // of zeroes would say the opposite of the truth.
    if !read.observed() {
        return Vec::new();
    }
    read.channels
        .iter()
        .map(|c| Event::RfSpectrum {
            freq_mhz: c.freq_mhz,
            sweeps: c.sweeps,
            noise_dbm: c.noise_dbm,
            peak_magnitude: c.peak_magnitude,
            peak_bin: c.peak_bin,
            bin_max: c.bin_max.to_vec(),
        })
        .collect()
}

/// Whether an event fits one datagram once framed.
pub fn fits_one_datagram(e: &Event) -> bool {
    Frame::Delta(e.clone())
        .encode()
        .map(|b| b.len() <= bsc_lan_stream::envelope::MAX_PLAINTEXT_BYTES)
        .unwrap_or(false)
}

/// The kind every spectrum event rides as. Deltas, not snapshots: a spectrum is
/// an observation of a moment, and restating an old one in a snapshot would
/// present stale energy as current.
pub const SPECTRUM_KIND: Kind = Kind::Delta;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spectrum::from_bytes;

    fn real_capture() -> Vec<u8> {
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../bsc-rf/tests/fixtures/ath9k-ht20-channel6.bin"),
        )
        .expect("the real capture fixture is readable")
    }

    #[test]
    fn a_barren_window_emits_nothing_rather_than_a_spectrum_of_zeroes() {
        // The whole point: on a display, zeroes and a clear channel look the
        // same, and only one is good news. Silence is the subscriber's to
        // report, and inventing a record here would defeat that machinery.
        let read = from_bytes(&[]);
        assert!(!read.observed());
        assert!(events_for(&read).is_empty(), "a barren window must put nothing on the wire");
    }

    #[test]
    fn a_real_window_becomes_one_event_per_channel() {
        let read = from_bytes(&real_capture());
        let events = events_for(&read);
        assert_eq!(events.len(), read.channels.len());
        assert_eq!(events.len(), 1, "the capture was single-channel");
    }

    #[test]
    fn the_emitted_event_carries_what_the_sensor_actually_observed() {
        let read = from_bytes(&real_capture());
        let c = &read.channels[0];
        match &events_for(&read)[0] {
            Event::RfSpectrum { freq_mhz, sweeps, noise_dbm, peak_magnitude, peak_bin, bin_max } => {
                assert_eq!(*freq_mhz, c.freq_mhz);
                assert_eq!(*sweeps, c.sweeps, "the evidence count must reach the subscriber");
                assert_eq!(*noise_dbm, c.noise_dbm);
                assert_eq!(*peak_magnitude, c.peak_magnitude);
                assert_eq!(*peak_bin, c.peak_bin);
                assert_eq!(bin_max.as_slice(), c.bin_max.as_slice());
            }
            Event::Alert { .. }
            | Event::Flow { .. }
            | Event::Health { .. }
            | Event::RfDeauthFlood { .. }
            | Event::RfChannelActivity { .. }
            | Event::PostureChanged { .. } => panic!("expected an RfSpectrum event"),
        }
    }

    #[test]
    fn a_real_spectrum_fits_one_datagram() {
        // 56 bins of real data, not a synthetic best case.
        for e in events_for(&from_bytes(&real_capture())) {
            assert!(fits_one_datagram(&e), "a real spectrum did not fit one datagram");
        }
    }

    #[test]
    fn aggregation_happens_before_emission_so_the_raw_rate_cannot_reach_the_wire() {
        // ~666 sweeps/sec against a 20/sec wire. One event per CHANNEL is the
        // reduction that makes the tier shippable at all.
        let read = from_bytes(&real_capture());
        assert!(read.samples > 100, "only {} samples", read.samples);
        assert!(
            events_for(&read).len() * 100 < read.samples,
            "{} samples produced {} events — the reduction is not happening",
            read.samples,
            events_for(&read).len()
        );
    }

    #[test]
    fn a_spectrum_rides_as_a_delta_never_a_snapshot() {
        // A snapshot restates current state; replaying old energy as current
        // would be a lie about the air right now.
        assert_eq!(SPECTRUM_KIND, Kind::Delta);
    }
}
