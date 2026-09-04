//! Tier 3 — spectral FFT bins from `ath9k`'s debugfs.
//!
//! ## What this tier alone can see
//!
//! Every other tier reads *frames*. This one reads **energy**, so it is the
//! only one that can see a source which radiates without transmitting valid
//! 802.11: a microwave oven, a cordless phone, a video sender, or a jammer.
//! Those are invisible to frame capture by construction, however good it is.
//!
//! ## The format, confirmed against a real capture rather than assumed
//!
//! `spectral_scan0` yields a stream of TLV records. Measured on the rebuilt
//! driver, channel 6: 252,928 bytes, exactly 3,328 records of 76 bytes, every
//! one type 1, parsing to zero bytes left over.
//!
//! ```text
//! struct fft_sample_tlv   { u8 type; be16 length; }                 3 bytes
//! struct fft_sample_ht20  { tlv; u8 max_exp; be16 freq; s8 rssi;
//!                           s8 noise; be16 max_magnitude;
//!                           u8 max_index; u8 bitmap_weight;
//!                           be64 tsf; u8 data[56]; }               76 total
//! ```
//!
//! ## Aggregation is mandatory, and the real data is what proved it
//!
//! That capture is roughly **666 samples per second**, against a telemetry
//! wire capped at 20 datagrams per second — two orders of magnitude too fast.
//! Raw samples cannot go on the stream and should not: a waterfall display
//! updates at 1–10 Hz, so per-window bin statistics are what a renderer
//! actually wants. [`aggregate`] is therefore part of the contract, not an
//! optimisation.

use std::collections::BTreeMap;

/// `ATH_FFT_SAMPLE_HT20` — the only type this radio emits.
pub const TLV_HT20: u8 = 1;
/// Bins in an HT20 sample.
pub const HT20_BINS: usize = 56;
/// Header before the bins: TLV(3) + max_exp, freq, rssi, noise, max_magnitude,
/// max_index, bitmap_weight, tsf.
const HT20_HEADER: usize = 20;
/// One whole HT20 record.
pub const HT20_RECORD: usize = HT20_HEADER + HT20_BINS;

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum SpectralError {
    #[error("record at offset {offset} is truncated: {have} bytes left, need {need}")]
    Truncated { offset: usize, have: usize, need: usize },
    #[error("record at offset {offset} declares TLV type {kind}, which this decoder does not implement — refusing to guess at its layout")]
    UnknownType { offset: usize, kind: u8 },
    #[error("record at offset {offset} declares length {declared}, but a type-1 record is always {expected}")]
    LengthMismatch { offset: usize, declared: u16, expected: u16 },
}

/// One FFT sweep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sample {
    pub freq_mhz: u16,
    /// Relative to the noise floor, as the driver reports it — NOT absolute dBm.
    pub rssi: i8,
    /// Noise floor in dBm.
    pub noise_dbm: i8,
    pub max_magnitude: u16,
    pub max_index: u8,
    /// Shift applied to each bin before use.
    pub max_exp: u8,
    pub tsf: u64,
    pub bins: [u8; HT20_BINS],
}

/// Decode every record in a `spectral_scan0` read.
///
/// Stops at the first malformed record rather than skipping it: a spectral
/// stream is a byte stream with no resynchronisation marker, so one bad length
/// desynchronises everything after it. Returning what was decoded *plus* the
/// error is more useful than either alone — the caller keeps the good samples
/// and knows the tail is untrustworthy.
pub fn decode(raw: &[u8]) -> (Vec<Sample>, Option<SpectralError>) {
    let mut out = Vec::new();
    let mut off = 0usize;

    while off < raw.len() {
        if raw.len() - off < 3 {
            return (out, Some(SpectralError::Truncated { offset: off, have: raw.len() - off, need: 3 }));
        }
        let kind = raw[off];
        let declared = u16::from_be_bytes([raw[off + 1], raw[off + 2]]);

        if kind != TLV_HT20 {
            return (out, Some(SpectralError::UnknownType { offset: off, kind }));
        }
        let expected = (HT20_RECORD - 3) as u16;
        if declared != expected {
            return (out, Some(SpectralError::LengthMismatch { offset: off, declared, expected }));
        }
        if raw.len() - off < HT20_RECORD {
            return (
                out,
                Some(SpectralError::Truncated { offset: off, have: raw.len() - off, need: HT20_RECORD }),
            );
        }

        let b = &raw[off..off + HT20_RECORD];
        let mut bins = [0u8; HT20_BINS];
        bins.copy_from_slice(&b[HT20_HEADER..HT20_RECORD]);
        out.push(Sample {
            max_exp: b[3],
            freq_mhz: u16::from_be_bytes([b[4], b[5]]),
            rssi: b[6] as i8,
            noise_dbm: b[7] as i8,
            max_magnitude: u16::from_be_bytes([b[8], b[9]]),
            max_index: b[10],
            tsf: u64::from_be_bytes(b[12..20].try_into().expect("8 bytes")),
            bins,
        });
        off += HT20_RECORD;
    }
    (out, None)
}

/// One channel's energy over a window, small enough for the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelSpectrum {
    pub freq_mhz: u16,
    /// How many sweeps were folded in. A spectrum from two sweeps and one from
    /// two thousand are different claims and must not render alike.
    pub sweeps: u32,
    pub noise_dbm: i8,
    /// Peak bin magnitude across the window — where interference shows.
    pub peak_magnitude: u16,
    /// Bin index of that peak, so a renderer can mark the offending frequency.
    pub peak_bin: u8,
    /// Per-bin maximum across the window. The max, not the mean: a brief
    /// microwave burst is exactly what this tier exists to catch, and averaging
    /// it against quiet sweeps is how it gets hidden.
    pub bin_max: [u8; HT20_BINS],
}

/// Fold many sweeps into one per-channel spectrum.
///
/// The reduction that makes Tier 3 fit a 20/s wire: ~666 samples per second in,
/// one record per channel per window out.
pub fn aggregate(samples: &[Sample]) -> Vec<ChannelSpectrum> {
    let mut by_freq: BTreeMap<u16, ChannelSpectrum> = BTreeMap::new();

    for s in samples {
        let e = by_freq.entry(s.freq_mhz).or_insert_with(|| ChannelSpectrum {
            freq_mhz: s.freq_mhz,
            sweeps: 0,
            noise_dbm: s.noise_dbm,
            peak_magnitude: 0,
            peak_bin: 0,
            bin_max: [0u8; HT20_BINS],
        });
        e.sweeps += 1;
        if s.max_magnitude > e.peak_magnitude {
            e.peak_magnitude = s.max_magnitude;
            e.peak_bin = s.max_index;
        }
        for (slot, v) in e.bin_max.iter_mut().zip(s.bins.iter()) {
            *slot = (*slot).max(*v);
        }
    }
    by_freq.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ht20(freq: u16, bins: [u8; HT20_BINS], max_mag: u16, max_idx: u8) -> Vec<u8> {
        let mut v = Vec::with_capacity(HT20_RECORD);
        v.push(TLV_HT20);
        v.extend_from_slice(&((HT20_RECORD - 3) as u16).to_be_bytes());
        v.push(1); // max_exp
        v.extend_from_slice(&freq.to_be_bytes());
        v.push(23u8); // rssi
        v.push((-95i8) as u8); // noise
        v.extend_from_slice(&max_mag.to_be_bytes());
        v.push(max_idx);
        v.push(0); // bitmap_weight
        v.extend_from_slice(&7u64.to_be_bytes());
        v.extend_from_slice(&bins);
        v
    }

    #[test]
    fn a_well_formed_record_decodes_every_field() {
        let mut bins = [0u8; HT20_BINS];
        bins[11] = 194;
        let (s, err) = decode(&ht20(2437, bins, 194, 11));
        assert!(err.is_none());
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].freq_mhz, 2437);
        assert_eq!(s[0].noise_dbm, -95);
        assert_eq!(s[0].rssi, 23);
        assert_eq!(s[0].max_magnitude, 194);
        assert_eq!(s[0].max_index, 11);
        assert_eq!(s[0].bins[11], 194);
    }

    #[test]
    fn a_truncated_record_is_an_error_and_the_good_samples_survive() {
        let mut raw = ht20(2437, [1u8; HT20_BINS], 10, 0);
        raw.extend_from_slice(&ht20(2437, [2u8; HT20_BINS], 10, 0)[..40]); // cut short
        let (s, err) = decode(&raw);
        assert_eq!(s.len(), 1, "the intact record must still be returned");
        assert!(matches!(err, Some(SpectralError::Truncated { .. })), "{err:?}");
    }

    #[test]
    fn an_unknown_tlv_type_is_refused_rather_than_guessed_at() {
        // No resynchronisation marker exists in this stream, so guessing a
        // layout desynchronises everything after it.
        let mut raw = ht20(2437, [0u8; HT20_BINS], 1, 0);
        raw[0] = 9;
        let (s, err) = decode(&raw);
        assert!(s.is_empty());
        assert!(matches!(err, Some(SpectralError::UnknownType { kind: 9, .. })), "{err:?}");
    }

    #[test]
    fn a_bad_length_is_refused_rather_than_desynchronising_the_stream() {
        let mut raw = ht20(2437, [0u8; HT20_BINS], 1, 0);
        raw[1] = 0xff;
        raw[2] = 0xff;
        let (_, err) = decode(&raw);
        assert!(matches!(err, Some(SpectralError::LengthMismatch { .. })), "{err:?}");
    }

    #[test]
    fn aggregation_keeps_the_peak_not_the_mean() {
        // A brief microwave burst is exactly what this tier exists to catch,
        // and averaging it against quiet sweeps is how it gets hidden.
        let quiet = [5u8; HT20_BINS];
        let mut burst = [5u8; HT20_BINS];
        burst[30] = 250;
        let mut raw = Vec::new();
        for _ in 0..50 {
            raw.extend_from_slice(&ht20(2437, quiet, 10, 0));
        }
        raw.extend_from_slice(&ht20(2437, burst, 1514, 30));

        let (s, err) = decode(&raw);
        assert!(err.is_none());
        let agg = aggregate(&s);
        assert_eq!(agg.len(), 1);
        assert_eq!(agg[0].sweeps, 51, "the evidence count must travel with the spectrum");
        assert_eq!(agg[0].bin_max[30], 250, "one burst in fifty quiet sweeps must survive");
        assert_eq!(agg[0].peak_magnitude, 1514);
        assert_eq!(agg[0].peak_bin, 30, "a renderer must be able to mark the offending frequency");
    }

    #[test]
    fn separate_channels_aggregate_separately() {
        let mut raw = ht20(2437, [1u8; HT20_BINS], 10, 0);
        raw.extend_from_slice(&ht20(2412, [2u8; HT20_BINS], 20, 1));
        let (s, _) = decode(&raw);
        let agg = aggregate(&s);
        assert_eq!(agg.len(), 2);
        assert_eq!(agg[0].freq_mhz, 2412, "sorted by frequency for a stable render order");
        assert_eq!(agg[1].freq_mhz, 2437);
    }

    #[test]
    fn an_empty_read_yields_nothing_and_no_error() {
        let (s, err) = decode(&[]);
        assert!(s.is_empty());
        assert!(err.is_none(), "an empty read is not a malformed one");
        assert!(aggregate(&s).is_empty());
    }
}
