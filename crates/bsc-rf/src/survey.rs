//! Tier 1 — **channel occupancy**, parsed from `iw dev <iface> survey dump`.
//!
//! # What this tier is for
//!
//! The radio's clear-channel-assessment (CCA) logic reports how long it saw ENERGY on a channel,
//! separately from how long it spent DECODING that energy into frames. The gap between those two
//! numbers is the single strongest jamming discriminator obtainable without a spectrum analyzer:
//!
//! | | busy/active | rx/busy | noise |
//! |---|---|---|---|
//! | idle | low | — | flat |
//! | **congestion** | high | **high** | flat |
//! | **barrage jammer** | high | **~0** | **raised** |
//!
//! Congestion cannot produce "saturated but nothing decodes" — the frames that saturate it are, by
//! definition, frames. That asymmetry is what [`crate::detect`] scores.
//!
//! # This tier is NOT available on all hardware, and the failure is silent
//!
//! MEASURED 2026-09-04 on the development box: `iw dev … survey dump` returns **empty output with
//! exit status 0** on both an `ath9k_htc` AR9271 and an `rtw89` RTL8851BE, immediately after a scan
//! that saw twelve access points. `mac80211` carries the generic `ieee80211_dump_survey` path, but
//! neither driver registers a `get_survey` op, so `mac80211` answers `-EOPNOTSUPP` for every entry
//! and `iw` prints nothing at all rather than saying so.
//!
//! **An empty parse is therefore [`SurveyReading::Unsupported`], never an empty channel list, and
//! never zeroes.** This distinction is the whole reason the fields below are `Option`. A driver that
//! reports no `busy_ms` is not reporting a quiet channel; scoring it as one would read a radio with
//! no telemetry as proof of a clean band — the exact inversion this surface exists to avoid.

use serde::Serialize;

/// One channel's occupancy counters, exactly as the driver reported them.
///
/// **Every counter is `Option` on purpose.** `iw` omits a line the driver did not fill, and the
/// omission is information: it says the driver cannot measure that quantity, which is categorically
/// different from measuring it as zero. Collapsing the two is the absent-vs-zero trap.
///
/// The time counters are **cumulative since the interface came up**, not per-interval — so a single
/// reading says almost nothing and a rate requires differencing two of them. [`crate::detect::delta`]
/// is the only sanctioned way to do that, because it also has to handle the counter reset that a
/// channel change or an interface bounce produces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct ChannelSurvey {
    /// Centre frequency in MHz — `2412`, `5220`. The channel NUMBER is derived, never parsed:
    /// `iw survey` does not print one.
    pub frequency_mhz: u32,
    /// Whether the radio is currently tuned here. Only the in-use channel accumulates meaningful
    /// counters on most drivers; the others are stale from the last scan visit.
    pub in_use: bool,
    /// Noise floor in dBm (negative). Absent on drivers that do not measure it.
    pub noise_dbm: Option<i32>,
    /// Total time the radio has been on this channel.
    pub active_ms: Option<u64>,
    /// Of `active_ms`, time CCA judged the medium busy — energy above the threshold, whether or not
    /// it turned out to be a decodable frame. This is the closest thing a WiFi card has to a power
    /// measurement.
    pub busy_ms: Option<u64>,
    /// Of `busy_ms`, time actually spent receiving frames. The shortfall against `busy_ms` is
    /// energy the radio could not turn into anything — the jamming signal.
    pub rx_ms: Option<u64>,
    /// Of `active_ms`, time spent transmitting. Subtracted out before scoring: our own transmissions
    /// make the medium busy and must not read as someone else's interference.
    pub tx_ms: Option<u64>,
    /// Some drivers report an extension-channel busy time for 40 MHz operation. Carried for
    /// completeness; not scored, because its semantics vary between drivers.
    pub ext_busy_ms: Option<u64>,
}

/// The result of asking a radio for its survey — which is a three-way answer, not a list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SurveyReading {
    /// The driver reported channels. May still contain `None` counters per channel.
    Channels(Vec<ChannelSurvey>),
    /// The command succeeded and said nothing — the driver has no `get_survey` op. Tier 1 is
    /// unavailable on this radio and the caller must fall back to Tier 2 rather than conclude
    /// anything about the band.
    Unsupported,
}

impl SurveyReading {
    /// The channels, or an empty slice when unsupported.
    ///
    /// Deliberately NOT a `Default`-style unwrap that hides the distinction: callers that must
    /// branch on support use the enum, and this is only for rendering.
    pub fn channels(&self) -> &[ChannelSurvey] {
        match self {
            SurveyReading::Channels(c) => c,
            SurveyReading::Unsupported => &[],
        }
    }

    /// The channel the radio is currently tuned to, if any reported `[in use]`.
    pub fn in_use(&self) -> Option<&ChannelSurvey> {
        self.channels().iter().find(|c| c.in_use)
    }
}

/// Pull the trailing integer out of a `iw` value like `"-95 dBm"`, `"1234 ms"`, `"2412 MHz"`.
///
/// Takes the FIRST whitespace-separated token rather than stripping a known unit suffix, so a unit
/// this parser has not seen before does not silently produce `None`.
fn leading_number<T: std::str::FromStr>(value: &str) -> Option<T> {
    value.split_whitespace().next()?.parse().ok()
}

/// Parse the text of `iw dev <iface> survey dump`.
///
/// PURE — the whole point. The live command is a thin wrapper in [`crate::cli`]; every correctness
/// question about this tier is answerable from a fixture with no radio present.
///
/// Empty (or whitespace-only) input maps to [`SurveyReading::Unsupported`]: see the module docs for
/// why that is a measured reality and not a defensive guess.
pub fn parse_survey(text: &str) -> SurveyReading {
    if text.trim().is_empty() {
        return SurveyReading::Unsupported;
    }

    let mut out: Vec<ChannelSurvey> = Vec::new();
    let mut cur: Option<ChannelSurvey> = None;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // "Survey data from wlan0" opens a record. The frequency line inside it is what actually
        // identifies the channel, so the header only flushes the previous record.
        if trimmed.starts_with("Survey data from") {
            if let Some(c) = cur.take() {
                out.push(c);
            }
            cur = Some(ChannelSurvey::default());
            continue;
        }

        let Some((key, value)) = trimmed.split_once(':') else { continue };
        let key = key.trim();
        let value = value.trim();
        let Some(c) = cur.as_mut() else { continue };

        match key {
            // "2412 MHz" or "2412 MHz [in use]" — the marker is the only way to know which channel
            // the counters actually describe.
            "frequency" => {
                c.in_use = value.contains("[in use]");
                if let Some(f) = leading_number(value) {
                    c.frequency_mhz = f;
                }
            }
            "noise" => c.noise_dbm = leading_number(value),
            "channel active time" => c.active_ms = leading_number(value),
            "channel busy time" => c.busy_ms = leading_number(value),
            "channel receive time" => c.rx_ms = leading_number(value),
            "channel transmit time" => c.tx_ms = leading_number(value),
            "channel extension busy time" => c.ext_busy_ms = leading_number(value),
            _ => {}
        }
    }
    if let Some(c) = cur.take() {
        out.push(c);
    }

    // Text that parsed into nothing is still text the driver produced — treat it as an empty channel
    // list rather than as "unsupported", because the two came from different situations and the
    // caller is entitled to tell them apart.
    SurveyReading::Channels(out)
}

/// The 802.11 channel number for a centre frequency, for display only.
///
/// Returns `None` outside the bands this tool observes rather than guessing — a frequency we cannot
/// name is reported by its frequency, which is never wrong.
pub fn channel_for(freq_mhz: u32) -> Option<u32> {
    match freq_mhz {
        2484 => Some(14),
        2412..=2472 if (freq_mhz - 2412).is_multiple_of(5) => Some((freq_mhz - 2407) / 5),
        5160..=5885 if (freq_mhz - 5000).is_multiple_of(5) => Some((freq_mhz - 5000) / 5),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim shape of `iw` 6.9's survey output for a radio parked on channel 6.
    const CONGESTED: &str = "\
Survey data from wlan0
\tfrequency:\t\t\t2437 MHz [in use]
\tnoise:\t\t\t\t-95 dBm
\tchannel active time:\t\t60000 ms
\tchannel busy time:\t\t42000 ms
\tchannel receive time:\t\t31000 ms
\tchannel transmit time:\t\t2000 ms
";

    #[test]
    fn parses_the_in_use_channel_and_every_counter() {
        let r = parse_survey(CONGESTED);
        let c = r.in_use().expect("the [in use] marker identifies the tuned channel");
        assert_eq!(c.frequency_mhz, 2437);
        assert_eq!(c.noise_dbm, Some(-95));
        assert_eq!(c.active_ms, Some(60000));
        assert_eq!(c.busy_ms, Some(42000));
        assert_eq!(c.rx_ms, Some(31000));
        assert_eq!(c.tx_ms, Some(2000));
    }

    /// The MEASURED behaviour of both radios on the development box: exit 0, no output. It must not
    /// come back as a quiet channel — that would read "this driver cannot measure" as "the band is
    /// clear", which is the inversion this whole surface exists to prevent.
    #[test]
    fn empty_output_is_unsupported_and_never_a_quiet_channel() {
        assert_eq!(parse_survey(""), SurveyReading::Unsupported);
        assert_eq!(parse_survey("   \n  \n"), SurveyReading::Unsupported);
        // And the distinction is visible to a caller, not merely internal.
        assert!(parse_survey("").channels().is_empty());
        assert!(matches!(parse_survey(""), SurveyReading::Unsupported));
    }

    /// A driver that fills only some lines must leave the rest ABSENT. If these became `Some(0)` the
    /// scorer would read a radio with no receive-time counter as one decoding nothing.
    #[test]
    fn a_missing_counter_stays_none_rather_than_becoming_zero() {
        let partial = "\
Survey data from wlan0
\tfrequency:\t\t\t2412 MHz [in use]
\tnoise:\t\t\t\t-89 dBm
";
        let r = parse_survey(partial);
        let c = r.in_use().unwrap();
        assert_eq!(c.noise_dbm, Some(-89));
        assert_eq!(c.busy_ms, None, "absent must stay absent");
        assert_eq!(c.rx_ms, None, "absent must stay absent");
        assert_eq!(c.active_ms, None, "absent must stay absent");
    }

    #[test]
    fn parses_every_channel_in_a_multi_channel_dump() {
        let multi = "\
Survey data from wlan0
\tfrequency:\t\t\t2412 MHz
\tnoise:\t\t\t\t-95 dBm
Survey data from wlan0
\tfrequency:\t\t\t2437 MHz [in use]
\tnoise:\t\t\t\t-92 dBm
\tchannel active time:\t\t1000 ms
Survey data from wlan0
\tfrequency:\t\t\t2462 MHz
";
        let r = parse_survey(multi);
        assert_eq!(r.channels().len(), 3);
        assert_eq!(r.channels().iter().filter(|c| c.in_use).count(), 1);
        assert_eq!(r.in_use().unwrap().frequency_mhz, 2437);
        // The channels that are not in use still carry what the driver said about them.
        assert_eq!(r.channels()[0].noise_dbm, Some(-95));
    }

    #[test]
    fn channel_numbers_are_derived_only_where_they_are_real() {
        assert_eq!(channel_for(2412), Some(1));
        assert_eq!(channel_for(2437), Some(6));
        assert_eq!(channel_for(2462), Some(11));
        assert_eq!(channel_for(2484), Some(14), "channel 14 breaks the 5 MHz spacing rule");
        assert_eq!(channel_for(5220), Some(44));
        // A frequency outside the bands is reported by frequency rather than mislabelled.
        assert_eq!(channel_for(1000), None);
        assert_eq!(channel_for(2413), None, "off-grid frequencies are not guessed at");
    }
}
