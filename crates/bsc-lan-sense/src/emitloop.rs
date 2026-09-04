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

/// What a failed send means to a sensor nobody is obliged to be listening to.
///
/// ## Nothing here can stop the loop, and that is the whole design
///
/// The sensor's socket is `connect`ed (see [`crate::transport`] for why), and a
/// connected UDP socket reports ICMP errors back to the sender: if no process
/// is bound on the collector, the kernel there answers port-unreachable and the
/// sensor's **next** `send` fails with `ECONNREFUSED`. A loop that treats a
/// send error as fatal therefore dies precisely when the desktop app is closed
/// — which is the normal state of a device whose entire premise is emitting to
/// whoever happens to be subscribed. With `Restart=always` that becomes a crash
/// loop, and the journal fills with a fault whose real cause is that nobody was
/// home.
///
/// So [`SendLog::record`] returns a line to PRINT and never a reason to stop.
/// There is no variant, no error type and no boolean by which a caller could
/// decide to give up; the absence is structural rather than a policy a future
/// edit could quietly reverse.
///
/// ## But it must not go quiet either
///
/// A destination that is simply wrong looks identical to one that is merely
/// unattended, and a sensor that swallowed both would run for a week telling
/// nobody. The first failure always prints, and after that only powers of ten
/// — so a closed laptop costs a handful of journal lines a day while a
/// misconfigured collector still leaves a running count that says how long it
/// has been shouting into the void.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SendLog {
    /// Datagrams the socket accepted.
    pub sent: u64,
    /// Sends that failed, for any reason.
    pub failures: u64,
}

impl SendLog {
    /// Record one send attempt. Returns a line worth printing, if this
    /// failure is one the operator should see.
    pub fn record(&mut self, outcome: Result<(), std::io::Error>) -> Option<String> {
        match outcome {
            Ok(()) => {
                self.sent += 1;
                None
            }
            Err(e) => {
                self.failures += 1;
                if Self::should_report(self.failures) {
                    Some(format!(
                        "send failed ({e}) — {} failure(s) so far, {} datagram(s) delivered. \
                         Continuing: nobody is obliged to be listening, and a connected UDP \
                         socket reports an absent collector as an error on the next send.",
                        self.failures, self.sent
                    ))
                } else {
                    None
                }
            }
        }
    }

    /// The first failure, then powers of ten.
    pub fn should_report(failures: u64) -> bool {
        if failures <= 1 {
            return true;
        }
        let mut p = 10u64;
        while p <= failures {
            if p == failures {
                return true;
            }
            match p.checked_mul(10) {
                Some(n) => p = n,
                None => return false,
            }
        }
        false
    }
}

#[cfg(test)]
mod send_policy_tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    #[test]
    fn an_absent_collector_never_stops_the_sensor() {
        // THE FAILURE THIS EXISTS FOR. Closing the desktop app makes the
        // collector's kernel answer ICMP port-unreachable, which a connected
        // UDP socket surfaces as ECONNREFUSED on the sensor's next send. If
        // that were fatal the sensor would die every time nobody was watching,
        // and Restart=always would turn it into a crash loop.
        let mut log = SendLog::default();
        for _ in 0..500 {
            // `record` returns a line to print. There is no value it could
            // return that means stop — which is the point: this test asserts
            // the SHAPE as much as the behaviour.
            let _line: Option<String> = log.record(Err(Error::new(ErrorKind::ConnectionRefused, "refused")));
        }
        assert_eq!(log.failures, 500);
        assert_eq!(log.sent, 0);
    }

    #[test]
    fn the_first_failure_is_reported_and_then_powers_of_ten() {
        // A closed laptop must not cost a journal line per second, and a
        // genuinely misconfigured destination must not go silent.
        let mut log = SendLog::default();
        let mut reported = Vec::new();
        for i in 1..=1000u64 {
            if log.record(Err(Error::new(ErrorKind::ConnectionRefused, "x"))).is_some() {
                reported.push(i);
            }
        }
        assert_eq!(reported, vec![1, 10, 100, 1000], "reported at: {reported:?}");
    }

    #[test]
    fn the_reported_line_says_what_is_happening_and_that_it_is_continuing() {
        let mut log = SendLog::default();
        log.record(Ok(()));
        let line = log
            .record(Err(Error::new(ErrorKind::ConnectionRefused, "connection refused")))
            .expect("the first failure is always reported");
        assert!(line.contains("connection refused"), "the cause is missing: {line}");
        assert!(line.contains("1 datagram(s) delivered"), "the counts are missing: {line}");
        assert!(line.contains("Continuing"), "the line must say the sensor is not giving up: {line}");
    }

    #[test]
    fn a_successful_send_counts_and_says_nothing() {
        let mut log = SendLog::default();
        for _ in 0..3 {
            assert!(log.record(Ok(())).is_none(), "a working sensor must be quiet");
        }
        assert_eq!(log, SendLog { sent: 3, failures: 0 });
    }
}
