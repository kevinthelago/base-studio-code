//! The spectral decoder against a REAL capture from the rebuilt driver.
//!
//! `fixtures/ath9k-ht20-channel6.bin` is the first 200 records of a 252,928-byte
//! read from `spectral_scan0` on the monitor Pi's ALFA AR9271, channel 6
//! (2437 MHz), 2026-09-04 — taken minutes after `ath9k_htc` and `ath9k_common`
//! were rebuilt with `CONFIG_ATH9K_HTC_DEBUGFS` and `CONFIG_ATH9K_COMMON_SPECTRAL`,
//! on a kernel that shipped with both unset.
//!
//! Every other test of this decoder uses records I constructed, which proves
//! the decoder does what I intended. This one proves I understood the format
//! the hardware actually emits — and it is the only test that could have
//! caught a wrong field offset, since a wrong offset still produces
//! plausible-looking numbers.

use bsc_rf::spectral::{aggregate, decode, HT20_BINS, HT20_RECORD};

fn capture() -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/ath9k-ht20-channel6.bin"),
    )
    .expect("the real capture fixture is readable")
}

#[test]
fn the_real_capture_decodes_completely_with_nothing_left_over() {
    let raw = capture();
    assert_eq!(raw.len() % HT20_RECORD, 0, "the capture is not a whole number of records");

    let (samples, err) = decode(&raw);
    assert!(err.is_none(), "real hardware output failed to decode: {err:?}");
    assert_eq!(
        samples.len(),
        raw.len() / HT20_RECORD,
        "decoded a different number of records than the byte length implies"
    );
    assert!(samples.len() >= 100, "only {} samples — too few to conclude anything", samples.len());
}

/// A wrong field offset still yields plausible numbers, so the values are
/// checked against what the radio was actually doing.
#[test]
fn the_decoded_fields_match_the_radios_real_state() {
    let (samples, _) = decode(&capture());

    // The radio was pinned to channel 6 before the capture.
    assert!(
        samples.iter().all(|s| s.freq_mhz == 2437),
        "every sample should report 2437 MHz; saw {:?}",
        samples.iter().map(|s| s.freq_mhz).collect::<std::collections::BTreeSet<_>>()
    );

    // A 2.4 GHz noise floor is around -90 to -100 dBm. A wrong offset here
    // would read some other byte and land far outside that.
    for s in &samples {
        assert!(
            (-110..=-70).contains(&(s.noise_dbm as i32)),
            "noise floor {} dBm is not physically plausible — likely a field offset error",
            s.noise_dbm
        );
    }

    // max_index must address a real bin.
    assert!(
        samples.iter().all(|s| (s.max_index as usize) < HT20_BINS),
        "max_index out of range for a 56-bin sample"
    );
}

/// The data must actually vary. A decoder reading a constant byte would give
/// identical samples and pass every structural check above.
#[test]
fn the_capture_carries_real_variation_and_not_a_constant() {
    let (samples, _) = decode(&capture());
    let mags: std::collections::BTreeSet<u16> = samples.iter().map(|s| s.max_magnitude).collect();
    assert!(
        mags.len() > 10,
        "only {} distinct max_magnitude values across {} samples — this looks like a \
         constant field being read, not real spectrum",
        mags.len(),
        samples.len()
    );
    let bins_vary = samples.iter().any(|s| {
        let first = s.bins[0];
        s.bins.iter().any(|b| *b != first)
    });
    assert!(bins_vary, "no sample has any variation across its 56 bins");
}

#[test]
fn aggregating_the_real_capture_produces_one_channel_and_keeps_the_peak() {
    let (samples, _) = decode(&capture());
    let agg = aggregate(&samples);

    assert_eq!(agg.len(), 1, "the capture was single-channel; got {} channels", agg.len());
    let c = &agg[0];
    assert_eq!(c.freq_mhz, 2437);
    assert_eq!(c.sweeps as usize, samples.len(), "every sweep must be counted as evidence");

    // The aggregate peak must equal the real maximum, not an average of it.
    let true_peak = samples.iter().map(|s| s.max_magnitude).max().unwrap();
    assert_eq!(c.peak_magnitude, true_peak, "aggregation lost the peak");

    // And per-bin maxima must dominate every individual sweep.
    for s in &samples {
        for (i, b) in s.bins.iter().enumerate() {
            assert!(c.bin_max[i] >= *b, "bin {i}: aggregate {} < sample {}", c.bin_max[i], b);
        }
    }
}

/// The reduction that makes Tier 3 fit the wire, measured on real data.
#[test]
fn aggregation_reduces_the_real_capture_by_orders_of_magnitude() {
    let (samples, _) = decode(&capture());
    let agg = aggregate(&samples);
    assert!(
        samples.len() / agg.len() > 100,
        "aggregation only reduced {} samples to {} records — the full capture runs at \
         ~666 samples/sec against a 20/s wire, so the reduction has to be large",
        samples.len(),
        agg.len()
    );
}
