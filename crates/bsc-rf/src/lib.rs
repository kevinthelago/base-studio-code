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
//! a send primitive cannot be added quietly. This crate's modules are RECORDS in
//! `graph/algorithms.json`, so that guard reads what rustc reads — the materialized
//! `$OUT_DIR/crate.rs` plus the files that survive under `src/` — and names an offender by its
//! record id. Adding a module to the graph therefore does not escape it.

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/deauth.rs, src/detect.rs, src/device.rs, src/probe.rs, src/spectral.rs, src/survey.rs, src/tests.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-rf--<module>.rs
//     bsc graph impl set --id bsc-rf--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-rf--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-rf--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));