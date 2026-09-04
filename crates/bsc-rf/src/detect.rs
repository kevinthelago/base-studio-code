//! The **fusion scorer** — several individually-ambiguous signals combined into one verdict that
//! carries its own evidence.
//!
//! # Why fusion, and not a threshold
//!
//! Every signal available to a WiFi radio has a benign explanation. A microwave oven parks broadband
//! noise across channels 6–11. A crowded apartment block saturates a channel all evening. A distant
//! client raises the apparent noise floor. Any one of these trips a naive "the channel is busy"
//! alarm, and a detector that cries wolf on a microwave is worse than none — it trains its operator
//! to ignore it.
//!
//! What no benign cause reproduces is the COMBINATION: a medium held busy by energy that does not
//! decode into frames. Congestion saturates a channel *with frames*; that is what congestion is. So
//! the discriminating quantity is a ratio of ratios, and it is the only thing here promoted to
//! [`Level::Jamming`] on its own evidence.
//!
//! # Counters are cumulative, so a single reading proves nothing
//!
//! nl80211 survey counters are monotonic since the interface came up. A lone sample says only how
//! busy the channel has been *on average since boot*, which smears a 30-second attack into nothing.
//! Every score therefore runs over a [`Delta`] between two samples, and [`delta`] refuses rather
//! than guesses when the counters go backwards — a channel change or an interface bounce resets
//! them, and a negative delta silently treated as a huge positive one would fire every alarm at once.

use serde::Serialize;

use crate::survey::ChannelSurvey;

/// Fraction of wall time the medium must be busy with OTHER parties' energy before saturation is
/// considered established. Below this there is simply not enough energy for any verdict.
pub const SATURATION_THRESHOLD: f64 = 0.50;

/// Fraction of busy time that must decode into frames for the traffic to be considered legitimate.
/// Above this, a saturated channel is congestion — loud, but made of real frames.
pub const CONGESTION_DECODE_FLOOR: f64 = 0.30;

/// Below this fraction, energy is holding the medium busy while producing almost no frames. This is
/// the signature no amount of ordinary traffic can produce, and the only one that reaches
/// [`Level::Jamming`] on its own.
pub const JAMMING_DECODE_CEILING: f64 = 0.10;

/// dB the noise floor must rise above baseline to count as corroborating evidence. Deliberately
/// coarse: noise-floor reporting is not calibrated across drivers, so this supports a verdict and
/// never establishes one.
pub const NOISE_ELEVATION_DB: i32 = 6;

/// How confident the verdict is, and what it is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    /// Not enough telemetry to say anything. The honest answer when the driver has no survey op,
    /// when only one sample exists, or when the counters reset under us. NEVER conflated with
    /// [`Level::Clear`] — "I cannot see" and "I see nothing wrong" are different claims.
    Unknown,
    /// The medium is quiet.
    Clear,
    /// The medium is saturated, and it is saturated with decodable frames. Loud, not hostile.
    Congested,
    /// Saturated, and decoding worse than congestion explains, but not conclusively. Worth watching;
    /// not worth waking anyone.
    Suspect,
    /// Energy is holding the medium busy and producing almost no frames.
    Jamming,
}

impl Level {
    /// The wire word.
    pub const fn as_str(self) -> &'static str {
        match self {
            Level::Unknown => "unknown",
            Level::Clear => "clear",
            Level::Congested => "congested",
            Level::Suspect => "suspect",
            Level::Jamming => "jamming",
        }
    }
}

/// One piece of evidence, carried whether it fired or not.
///
/// A verdict that lists only what fired cannot be argued with — the reader has no way to see which
/// checks were even applied, or how close a quiet one came. Both are reported.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Signal {
    /// Stable identifier, safe to alert on.
    pub name: &'static str,
    /// Whether this signal's condition was met.
    pub fired: bool,
    /// The measured value, or `None` when the input it needed was absent. An absent input is NOT a
    /// value of zero and does not count as a signal that failed to fire.
    pub value: Option<f64>,
    /// The threshold `value` was compared against.
    pub threshold: f64,
    /// What this signal means, in one line, for a human reading an alert at 3am.
    pub detail: String,
}

/// The differenced telemetry two samples apart — the only form the scorer accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Delta {
    pub frequency_mhz: u32,
    /// Wall time the radio spent on this channel during the interval.
    pub active_ms: u64,
    /// Busy time attributable to OTHER parties — our own transmit time is already subtracted, so a
    /// chatty local interface cannot read as someone else's interference.
    pub foreign_busy_ms: u64,
    /// Time spent decoding frames during the interval.
    pub rx_ms: Option<u64>,
    /// Noise floor at the end of the interval.
    pub noise_dbm: Option<i32>,
}

impl Delta {
    /// Fraction of the interval the medium was held busy by others.
    pub fn saturation(&self) -> Option<f64> {
        (self.active_ms > 0).then(|| self.foreign_busy_ms as f64 / self.active_ms as f64)
    }

    /// Fraction of that busy time which decoded into frames.
    ///
    /// `None` when the driver did not report receive time, or when nothing was busy — in both cases
    /// there is no ratio, and inventing one would be the absent-as-zero mistake in its most
    /// damaging form: a radio with no `rx_ms` counter would score as decoding nothing, i.e. as
    /// permanently jammed.
    pub fn decode_ratio(&self) -> Option<f64> {
        let rx = self.rx_ms?;
        (self.foreign_busy_ms > 0).then(|| rx as f64 / self.foreign_busy_ms as f64)
    }
}

/// Difference two survey readings of the SAME channel.
///
/// Returns `None` when the samples are not comparable — different channels, no elapsed active time,
/// or counters that went backwards (a channel change or interface bounce resets them). Refusing is
/// the point: a reset read as a delta produces an enormous busy time and a zero decode ratio, which
/// is indistinguishable from a total jam and would fire on every `iw set channel`.
pub fn delta(prev: &ChannelSurvey, cur: &ChannelSurvey) -> Option<Delta> {
    if prev.frequency_mhz != cur.frequency_mhz {
        return None;
    }
    let (pa, ca) = (prev.active_ms?, cur.active_ms?);
    let (pb, cb) = (prev.busy_ms?, cur.busy_ms?);
    if ca < pa || cb < pb {
        return None; // counter reset
    }
    let active = ca - pa;
    if active == 0 {
        return None;
    }
    let busy = cb - pb;

    // Our own transmissions make the medium busy. Subtract them where the driver reports them; where
    // it does not, `tx` contributes nothing and the result is conservative in the safe direction
    // (busier-looking, so at worst a false Congested rather than a missed jam).
    let tx = match (prev.tx_ms, cur.tx_ms) {
        (Some(p), Some(c)) if c >= p => c - p,
        _ => 0,
    };
    let foreign_busy = busy.saturating_sub(tx);

    let rx = match (prev.rx_ms, cur.rx_ms) {
        (Some(p), Some(c)) if c >= p => Some(c - p),
        _ => None,
    };

    Some(Delta {
        frequency_mhz: cur.frequency_mhz,
        active_ms: active,
        foreign_busy_ms: foreign_busy.min(active),
        rx_ms: rx,
        noise_dbm: cur.noise_dbm,
    })
}

/// A quiet-time reference for one channel, so a score is stated relative to something real.
///
/// Anomaly detection with no baseline is guesswork: a -70 dBm noise floor is alarming in a rural
/// field and unremarkable in an apartment block. Optional, because a first run has none and should
/// still say what it can.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Baseline {
    pub frequency_mhz: u32,
    /// The noise floor observed while the channel was known clean.
    pub noise_dbm: Option<i32>,
}

/// The verdict, with the evidence that produced it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Verdict {
    pub level: Level,
    pub frequency_mhz: u32,
    /// Every signal considered — fired or not — so the reader can see which checks applied.
    pub signals: Vec<Signal>,
    /// The reference the score was stated against, when one existed.
    pub baseline: Option<Baseline>,
    /// One line explaining the level, naming the evidence that decided it.
    pub summary: String,
}

/// Score one differenced interval.
///
/// PURE. Every correctness question about the discrimination between congestion and jamming is
/// answerable from a constructed [`Delta`] with no radio present.
pub fn score(d: &Delta, baseline: Option<Baseline>) -> Verdict {
    let saturation = d.saturation();
    let decode = d.decode_ratio();

    let saturated = saturation.is_some_and(|s| s >= SATURATION_THRESHOLD);
    let decode_collapsed = decode.is_some_and(|r| r < JAMMING_DECODE_CEILING);
    let decode_healthy = decode.is_some_and(|r| r >= CONGESTION_DECODE_FLOOR);

    // Noise elevation is CORROBORATING only. It never establishes a verdict on its own, because
    // noise-floor reporting is uncalibrated across drivers and a neighbour's amplifier moves it.
    let noise_rise = match (baseline.and_then(|b| b.noise_dbm), d.noise_dbm) {
        (Some(base), Some(now)) => Some((now - base) as f64),
        _ => None,
    };
    let noise_elevated = noise_rise.is_some_and(|r| r >= NOISE_ELEVATION_DB as f64);

    let signals = vec![
        Signal {
            name: "medium_saturated",
            fired: saturated,
            value: saturation,
            threshold: SATURATION_THRESHOLD,
            detail: match saturation {
                Some(s) => format!("others held the medium busy {:.0}% of the interval", s * 100.0),
                None => "no active time reported — cannot measure saturation".into(),
            },
        },
        Signal {
            name: "decode_collapse",
            fired: decode_collapsed,
            value: decode,
            threshold: JAMMING_DECODE_CEILING,
            detail: match decode {
                Some(r) => format!(
                    "{:.0}% of busy time decoded into frames; congestion is made of frames, so a low \
                     figure here is energy that is not traffic",
                    r * 100.0
                ),
                None => "receive time not reported by this driver — the decisive ratio is UNAVAILABLE, \
                         which is not the same as it being zero"
                    .into(),
            },
        },
        Signal {
            name: "noise_floor_elevated",
            fired: noise_elevated,
            value: noise_rise,
            threshold: NOISE_ELEVATION_DB as f64,
            detail: match (noise_rise, baseline) {
                (Some(r), _) => format!("noise floor {r:+.0} dB against baseline"),
                (None, None) => "no baseline recorded — run `bsc rf baseline` on a known-clean channel".into(),
                (None, Some(_)) => "noise floor not reported by this driver".into(),
            },
        },
    ];

    // The decision. Ordered so that the ambiguous cases fall to the WEAKER claim: anything that
    // cannot be established lands on Unknown or Suspect, never on Jamming.
    let (level, summary) = if decode.is_none() {
        (
            Level::Unknown,
            "the driver does not report receive time, so energy cannot be separated from traffic on \
             this radio — use monitor-mode frame statistics instead"
                .to_string(),
        )
    } else if !saturated {
        (
            Level::Clear,
            format!(
                "medium busy {:.0}% of the interval — below the {:.0}% saturation threshold",
                saturation.unwrap_or(0.0) * 100.0,
                SATURATION_THRESHOLD * 100.0
            ),
        )
    } else if decode_collapsed {
        (
            Level::Jamming,
            format!(
                "medium saturated at {:.0}% while only {:.0}% of it decoded into frames{} — energy \
                 without traffic is not a state ordinary congestion can produce",
                saturation.unwrap_or(0.0) * 100.0,
                decode.unwrap_or(0.0) * 100.0,
                if noise_elevated { ", with the noise floor raised against baseline" } else { "" }
            ),
        )
    } else if decode_healthy {
        (
            Level::Congested,
            format!(
                "medium saturated at {:.0}%, but {:.0}% of it decoded into frames — this is traffic, \
                 not interference",
                saturation.unwrap_or(0.0) * 100.0,
                decode.unwrap_or(0.0) * 100.0
            ),
        )
    } else {
        (
            Level::Suspect,
            format!(
                "medium saturated at {:.0}% with {:.0}% decoding — worse than congestion explains, \
                 short of conclusive",
                saturation.unwrap_or(0.0) * 100.0,
                decode.unwrap_or(0.0) * 100.0
            ),
        )
    };

    Verdict { level, frequency_mhz: d.frequency_mhz, signals, baseline, summary }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(freq: u32, active: u64, busy: u64, rx: u64, tx: u64, noise: i32) -> ChannelSurvey {
        ChannelSurvey {
            frequency_mhz: freq,
            in_use: true,
            noise_dbm: Some(noise),
            active_ms: Some(active),
            busy_ms: Some(busy),
            rx_ms: Some(rx),
            tx_ms: Some(tx),
            ext_busy_ms: None,
        }
    }

    /// THE test this module exists for. Both arms are saturated; only the decode ratio separates
    /// them. If this ever collapses into one verdict the detector is worthless — it would either
    /// alarm on every busy evening or miss every jam.
    #[test]
    fn congestion_and_jamming_are_separated_by_decode_ratio_alone() {
        // Busy 80% of the interval, and 75% of that busy time decoded into frames.
        let congested = delta(
            &sample(2437, 0, 0, 0, 0, -95),
            &sample(2437, 10_000, 8_000, 6_000, 0, -95),
        )
        .unwrap();

        // IDENTICAL saturation — busy 80% — but almost nothing decoded.
        let jammed = delta(
            &sample(2437, 0, 0, 0, 0, -95),
            &sample(2437, 10_000, 8_000, 200, 0, -95),
        )
        .unwrap();

        assert_eq!(congested.saturation(), jammed.saturation(), "the arms must differ ONLY in decode");

        assert_eq!(score(&congested, None).level, Level::Congested);
        assert_eq!(score(&jammed, None).level, Level::Jamming);
    }

    /// A driver with no receive-time counter must not score as decoding nothing. This is the
    /// absent-as-zero trap in its most dangerous direction: it would report a permanent jam.
    #[test]
    fn a_driver_without_receive_time_is_unknown_and_never_jamming() {
        let mut prev = sample(2437, 0, 0, 0, 0, -95);
        let mut cur = sample(2437, 10_000, 9_500, 0, 0, -95);
        prev.rx_ms = None;
        cur.rx_ms = None;

        let d = delta(&prev, &cur).unwrap();
        assert_eq!(d.decode_ratio(), None, "no receive counter means no ratio, not a zero ratio");

        let v = score(&d, None);
        assert_eq!(v.level, Level::Unknown, "a radio that cannot measure must not be read as attacked");
        assert_ne!(v.level, Level::Clear, "and equally must not be read as safe");

        // The absent input is reported as absent, not as a signal that failed to fire.
        let collapse = v.signals.iter().find(|s| s.name == "decode_collapse").unwrap();
        assert_eq!(collapse.value, None);
        assert!(!collapse.fired);
    }

    /// A counter reset — from a channel change or an interface bounce — must be refused, not read
    /// as an enormous busy interval with no decoding, which is indistinguishable from a total jam.
    #[test]
    fn a_counter_reset_is_refused_rather_than_scored() {
        let prev = sample(2437, 900_000, 700_000, 500_000, 0, -95);
        let cur = sample(2437, 1_000, 900, 20, 0, -95); // counters restarted
        assert_eq!(delta(&prev, &cur), None, "backwards counters must not become a delta");
    }

    #[test]
    fn samples_from_different_channels_are_not_comparable() {
        let prev = sample(2412, 0, 0, 0, 0, -95);
        let cur = sample(2437, 10_000, 8_000, 200, 0, -95);
        assert_eq!(delta(&prev, &cur), None);
    }

    /// Our own transmissions make the medium busy. If they were not subtracted, a busy local
    /// interface would score as someone else's interference.
    #[test]
    fn our_own_transmit_time_is_not_counted_as_foreign_energy() {
        // 8s busy of a 10s interval, but 7s of it was US transmitting.
        let d = delta(
            &sample(2437, 0, 0, 0, 0, -95),
            &sample(2437, 10_000, 8_000, 900, 7_000, -95),
        )
        .unwrap();
        assert_eq!(d.foreign_busy_ms, 1_000, "8000 busy minus 7000 of our own transmit");
        assert!(d.saturation().unwrap() < SATURATION_THRESHOLD);
        assert_eq!(score(&d, None).level, Level::Clear, "our own chatter is not an attack");
    }

    #[test]
    fn a_quiet_channel_is_clear() {
        let d = delta(&sample(2437, 0, 0, 0, 0, -95), &sample(2437, 10_000, 500, 400, 0, -95)).unwrap();
        assert_eq!(score(&d, None).level, Level::Clear);
    }

    /// Between the two thresholds is deliberately its own verdict rather than being rounded to one
    /// of the confident ones.
    #[test]
    fn the_ambiguous_middle_is_suspect_not_jamming() {
        // 80% saturated, 20% decode — between JAMMING_DECODE_CEILING and CONGESTION_DECODE_FLOOR.
        let d = delta(&sample(2437, 0, 0, 0, 0, -95), &sample(2437, 10_000, 8_000, 1_600, 0, -95)).unwrap();
        let v = score(&d, None);
        assert_eq!(v.level, Level::Suspect);
    }

    /// Noise elevation corroborates but must never promote a verdict by itself — a healthy,
    /// well-decoding channel with a risen noise floor is still congestion.
    #[test]
    fn a_raised_noise_floor_alone_does_not_make_a_jam() {
        let base = Baseline { frequency_mhz: 2437, noise_dbm: Some(-95) };
        // Saturated, decoding fine, but noise up 15 dB.
        let d = delta(&sample(2437, 0, 0, 0, 0, -80), &sample(2437, 10_000, 8_000, 6_000, 0, -80)).unwrap();
        let v = score(&d, Some(base));

        let noise = v.signals.iter().find(|s| s.name == "noise_floor_elevated").unwrap();
        assert!(noise.fired, "the noise signal itself should fire");
        assert_eq!(v.level, Level::Congested, "but it must not override a healthy decode ratio");
    }

    /// Every verdict carries every check, fired or not — a verdict listing only what fired cannot
    /// be argued with by its reader.
    #[test]
    fn a_verdict_reports_every_signal_considered() {
        let d = delta(&sample(2437, 0, 0, 0, 0, -95), &sample(2437, 10_000, 8_000, 200, 0, -95)).unwrap();
        let v = score(&d, None);
        let names: Vec<_> = v.signals.iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["medium_saturated", "decode_collapse", "noise_floor_elevated"]);
        assert!(!v.summary.is_empty(), "a level without a stated reason is a bare verdict");
    }

    /// Unknown and Clear are different claims and must never collapse into one another.
    #[test]
    fn unknown_is_not_clear() {
        assert_ne!(Level::Unknown, Level::Clear);
        assert_eq!(Level::Unknown.as_str(), "unknown");
        assert_eq!(Level::Clear.as_str(), "clear");
    }
}
