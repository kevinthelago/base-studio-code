//! `bsc rf` — **defensive** RF monitoring: detect radio jamming and RF denial-of-service against
//! 2.4/5 GHz WiFi, using a commodity adapter and the radio's own telemetry.
//!
//! # The claim this surface can and cannot make
//!
//! A WiFi card is **not a spectrum analyzer**. It is an 802.11 demodulator, and it reports only on
//! energy it can characterize. That bounds what any tool built on one may honestly claim, and the
//! bound is stated here rather than discovered by a reader who trusted an alarm too far:
//!
//! * It can observe energy holding a channel busy without decoding into frames — the strongest
//!   jamming evidence available short of an FFT.
//! * It can observe frames that arrive corrupted, absent, or hostile — [`detect`] over monitor-mode
//!   statistics.
//! * It **cannot** see a jammer that is not on a channel the radio is tuned to, and it cannot
//!   characterize a non-802.11 emitter at all. Only real spectral data — chipset FFT bins or an SDR
//!   — reaches those, and where that is unavailable this surface says so instead of guessing.
//!
//! # Three tiers, in descending order of availability
//!
//! 1. **Channel occupancy** ([`survey`]) — busy vs. decoded time from nl80211. Needs no monitor
//!    mode and no root. Unavailable on drivers with no `get_survey` op, which is more of them than
//!    one would hope; see that module.
//! 2. **Monitor-mode frame statistics** — radiotap per frame: FCS errors, retry rate, beacon gaps,
//!    PHY-rate collapse. Also the only tier that sees deauth floods and NAV/duration attacks, which
//!    are jamming performed with entirely legal frames and produce no excess energy at all.
//! 3. **Spectral FFT bins** — ath9k/ath10k debugfs, or an SDR. [`device::Spectral`] reports which of
//!    those is reachable and, when neither is, distinguishes silicon that cannot from a kernel that
//!    was not built for it.
//!
//! # Nothing here transmits
//!
//! There is no injection path, no deauthentication path, and no active probing. The surface is
//! read-only with respect to the radio: it observes a medium it never contributes to. This is not
//! merely a convention — [`tests::the_crate_has_no_transmit_path`] asserts it against the source, so
//! a send primitive cannot be added quietly.

pub mod cli;
pub mod deauth;
pub mod detect;
pub mod device;
pub mod probe;
pub mod spectral;
pub mod survey;

#[cfg(test)]
mod tests {
    /// Each needle is SPLIT and rejoined at compile time, so this file does not itself contain the
    /// literals it searches for. The first version did, and the guard failed against its own
    /// forbidden list — a scanner that cannot be run over its own crate has a blind spot exactly
    /// where the list lives.
    const FORBIDDEN: &[&str] = &[
        concat!("pcap", "_inject"),
        concat!("pcap", "_sendpacket"),
        concat!("aire", "play"),
        concat!("send", "to("),
        concat!("send", "_to("),
        concat!("send", "msg("),
        concat!("\"--in", "ject\""),
    ];

    /// Every `.rs` file in this crate, as `(name, text)`.
    fn sources() -> Vec<(String, String)> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        std::fs::read_dir(&dir)
            .expect("the crate's own src/ must be readable")
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "rs"))
            .map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                (name, std::fs::read_to_string(e.path()).expect("a source file must be readable"))
            })
            .collect()
    }

    /// The scan itself, as a PURE function over `(name, text)` pairs — so the guard can be run
    /// against a known-bad input and observed to FAIL, rather than only ever observed to pass.
    fn scan_for_transmit(sources: &[(String, String)]) -> Vec<String> {
        let mut offences = Vec::new();
        for (name, text) in sources {
            for needle in FORBIDDEN {
                if text.contains(needle) {
                    offences.push(format!("{name}: {needle}"));
                }
            }
        }
        offences
    }

    /// The defensive-only guarantee, asserted against the source rather than trusted.
    ///
    /// Nothing at run time can observe the ABSENCE of a transmit path, so this is a source scan —
    /// the same shape as `every_store_env_mutation_is_inside_the_store_lock` in `bsc-graph`, and
    /// for the same reason.
    ///
    /// The forbidden set is deliberately the SEND PRIMITIVES, not the vocabulary. This crate must
    /// be free to *say* "deauthentication flood" in a doc comment and to *detect* one; what it must
    /// not do is emit a frame.
    #[test]
    fn the_crate_has_no_transmit_path() {
        let sources = sources();
        // Assert the POPULATION first. A scanner that stopped finding files would report zero
        // offenders, which reads exactly like a pass.
        assert!(
            sources.len() >= 5,
            "expected the crate's 5+ modules; found {} — the scanner is broken, not the crate clean",
            sources.len()
        );
        let offences = scan_for_transmit(&sources);
        assert!(
            offences.is_empty(),
            "bsc-rf is DEFENSIVE-ONLY and must never transmit; found: {offences:?}"
        );
    }

    /// THE BITE TEST. The guard above is only evidence if it can fail, so the same scan is run over
    /// a synthetic module that DOES transmit, and must catch every primitive.
    ///
    /// The bad source is assembled at run time from split fragments for the same reason the needles
    /// are: a literal here would be found by the real scan when it reads this very file.
    #[test]
    fn the_transmit_scanner_actually_bites() {
        let bad: String = FORBIDDEN.iter().map(|n| format!("fn bad() {{ {n} }}\n")).collect();
        let synthetic = vec![("evil.rs".to_string(), bad)];

        let offences = scan_for_transmit(&synthetic);
        assert_eq!(
            offences.len(),
            FORBIDDEN.len(),
            "every forbidden primitive must be caught, not merely some: {offences:?}"
        );

        // And a clean module produces nothing, so the scan is not simply always-positive.
        let clean = vec![("good.rs".to_string(), "fn observe() { let _ = 1; }".to_string())];
        assert!(scan_for_transmit(&clean).is_empty());
    }
}
