//! Reading the radio's own spectrum — the part that touches the machine.
//!
//! Decoding and aggregation live in [`bsc_rf::spectral`] and are tested against
//! a real 252,928-byte capture. This module is the half that finds the debugfs
//! path, drives the control file, and reads the sample stream.
//!
//! ## The path is discovered, never hardcoded
//!
//! Measured this session: reloading `ath9k_htc` renumbered the radio from
//! `phy1` to `phy2`. Every hardcoded `phy1` query written that day silently
//! returned nothing, while the code that discovers reported correctly. **A phy
//! index is not stable across a module reload**, so a hardcoded path is a bug
//! that hides until the next reload and then reads as "no spectral support".
//!
//! ## Reading and triggering are separate, deliberately
//!
//! Reading debugfs is harmless. Writing `spectral_scan_ctl` changes how the
//! radio behaves. `guardrails.md` puts observation before mutation, so that
//! distinction is expressed in the API rather than left to a caller's
//! discipline: [`read_samples`] never writes, and [`trigger`] is the only thing
//! that does.

use bsc_rf::spectral::{aggregate, decode, ChannelSpectrum, SpectralError};
use std::path::{Path, PathBuf};

/// Where the kernel exposes a phy's driver knobs.
const DEBUGFS_IEEE80211: &str = "/sys/kernel/debug/ieee80211";

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum SpectrumError {
    #[error("no spectral debugfs path under {root} — this driver was not built with spectral scan (ath9k needs CONFIG_ATH9K_COMMON_SPECTRAL and, for the USB part, CONFIG_ATH9K_HTC_DEBUGFS)")]
    Unsupported { root: String },
    #[error("cannot read {path}: {reason} — debugfs is root-only, so this usually means the caller is not privileged")]
    Unreadable { path: String, reason: String },
    #[error("cannot write {path}: {reason}")]
    Unwritable { path: String, reason: String },
    #[error("the sample stream was malformed: {0}")]
    Malformed(#[from] SpectralError),
}

/// One radio's spectral control surface, located by discovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpectralPath {
    /// e.g. `/sys/kernel/debug/ieee80211/phy2/ath9k_htc`
    pub dir: PathBuf,
}

impl SpectralPath {
    pub fn ctl(&self) -> PathBuf {
        self.dir.join("spectral_scan_ctl")
    }
    pub fn samples(&self) -> PathBuf {
        self.dir.join("spectral_scan0")
    }
}

/// Find the first phy exposing a spectral control file.
///
/// Walks `root` rather than assuming an index, for the reason in the module
/// docs. Driver family is also discovered — `ath9k_htc` for the USB part,
/// `ath9k` for PCI — so this does not need to know which is present.
pub fn discover_in(root: &Path) -> Result<SpectralPath, SpectrumError> {
    let families = ["ath9k_htc", "ath9k", "ath10k"];
    let Ok(entries) = std::fs::read_dir(root) else {
        return Err(SpectrumError::Unsupported { root: root.display().to_string() });
    };
    let mut phys: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    // Deterministic order: two radios must not make this answer differ run to run.
    phys.sort();

    for phy in phys {
        for fam in families {
            let dir = phy.join(fam);
            if dir.join("spectral_scan_ctl").exists() {
                return Ok(SpectralPath { dir });
            }
        }
    }
    Err(SpectrumError::Unsupported { root: root.display().to_string() })
}

/// Find the spectral path on this host.
pub fn discover() -> Result<SpectralPath, SpectrumError> {
    discover_in(Path::new(DEBUGFS_IEEE80211))
}

/// What a read produced.
///
/// `samples` is the count that justified the spectra, carried because a
/// spectrum from two sweeps and one from two thousand are different claims.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpectrumRead {
    pub channels: Vec<ChannelSpectrum>,
    pub samples: usize,
    /// Bytes read from the sample file. Zero is reported rather than smoothed
    /// away: an empty read is NOT a quiet band, it is no observation at all.
    pub bytes: usize,
    /// Present when the stream ended badly. The channels before it still stand.
    pub malformed_tail: Option<SpectralError>,
}

impl SpectrumRead {
    /// Whether anything was actually observed. A caller must be able to tell
    /// "the air is quiet" from "I read nothing", which look identical on a
    /// spectrum display and are not remotely the same claim.
    pub fn observed(&self) -> bool {
        self.samples > 0
    }
}

/// Drain whatever the driver has buffered. **Never writes.**
pub fn read_samples(path: &SpectralPath) -> Result<SpectrumRead, SpectrumError> {
    let p = path.samples();
    let raw = std::fs::read(&p).map_err(|e| SpectrumError::Unreadable {
        path: p.display().to_string(),
        reason: e.to_string(),
    })?;
    Ok(from_bytes(&raw))
}

/// Decode and aggregate an already-read sample stream. Pure, so the whole
/// reduction is testable against the committed capture with no radio.
pub fn from_bytes(raw: &[u8]) -> SpectrumRead {
    let (samples, err) = decode(raw);
    SpectrumRead {
        channels: aggregate(&samples),
        samples: samples.len(),
        bytes: raw.len(),
        malformed_tail: err,
    }
}

/// What to write to `spectral_scan_ctl`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Sample continuously while the radio is on channel.
    Background,
    /// Begin sampling now.
    Trigger,
    /// Stop. Left as an explicit mode rather than a side effect of dropping,
    /// because a spectral scan left running costs a thermally-saturated box
    /// work nobody asked for.
    Disable,
}

impl Mode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Mode::Background => "background",
            Mode::Trigger => "trigger",
            Mode::Disable => "disable",
        }
    }
}

/// Write one mode to the control file. **The only function here that mutates
/// the radio**, kept separate so an observe-only caller cannot reach it by
/// accident.
pub fn trigger(path: &SpectralPath, mode: Mode) -> Result<(), SpectrumError> {
    let p = path.ctl();
    std::fs::write(&p, mode.as_str()).map_err(|e| SpectrumError::Unwritable {
        path: p.display().to_string(),
        reason: e.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("bsc-spectrum-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake_phy(root: &Path, phy: &str, family: &str) -> PathBuf {
        let d = root.join(phy).join(family);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("spectral_scan_ctl"), "disable").unwrap();
        d
    }

    #[test]
    fn the_path_is_discovered_whatever_the_phy_index() {
        // The measured failure: a module reload renumbered phy1 to phy2 and
        // every hardcoded query silently returned nothing.
        for phy in ["phy0", "phy2", "phy11"] {
            let root = tmp();
            let want = fake_phy(&root, phy, "ath9k_htc");
            assert_eq!(discover_in(&root).unwrap().dir, want, "failed to find {phy}");
            std::fs::remove_dir_all(&root).ok();
        }
    }

    #[test]
    fn the_driver_family_is_discovered_too() {
        let root = tmp();
        let want = fake_phy(&root, "phy0", "ath9k");
        assert_eq!(discover_in(&root).unwrap().dir, want);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn discovery_is_deterministic_when_two_radios_expose_spectral() {
        // Two radios must not make this answer differ between runs.
        let root = tmp();
        let first = fake_phy(&root, "phy0", "ath9k_htc");
        fake_phy(&root, "phy1", "ath9k_htc");
        for _ in 0..5 {
            assert_eq!(discover_in(&root).unwrap().dir, first);
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_driver_without_spectral_is_reported_as_unsupported_not_as_quiet() {
        let root = tmp();
        std::fs::create_dir_all(root.join("phy0").join("ath9k_htc")).unwrap(); // no ctl file
        let e = discover_in(&root).unwrap_err();
        assert!(matches!(e, SpectrumError::Unsupported { .. }), "{e:?}");
        // And the message must name the two config symbols, since one alone
        // produces a module that will not load.
        assert!(e.to_string().contains("CONFIG_ATH9K_COMMON_SPECTRAL"));
        assert!(e.to_string().contains("CONFIG_ATH9K_HTC_DEBUGFS"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_empty_read_is_not_a_quiet_band() {
        let r = from_bytes(&[]);
        assert_eq!(r.samples, 0);
        assert_eq!(r.bytes, 0);
        assert!(r.channels.is_empty());
        assert!(!r.observed(), "zero samples must not read as an observation");
    }

    #[test]
    fn a_read_carries_the_evidence_behind_its_channels() {
        let raw = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../bsc-rf/tests/fixtures/ath9k-ht20-channel6.bin"),
        )
        .expect("the real capture fixture is readable from here");

        let r = from_bytes(&raw);
        assert!(r.observed());
        assert_eq!(r.bytes, raw.len());
        assert!(r.samples >= 100, "only {} samples", r.samples);
        assert_eq!(r.channels.len(), 1, "the capture was single-channel");
        assert_eq!(r.channels[0].freq_mhz, 2437);
        assert_eq!(r.channels[0].sweeps as usize, r.samples);
        assert!(r.malformed_tail.is_none());
    }

    #[test]
    fn a_malformed_tail_is_reported_and_the_good_channels_survive() {
        let mut raw = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../bsc-rf/tests/fixtures/ath9k-ht20-channel6.bin"),
        )
        .unwrap();
        raw.truncate(76 * 10 + 30); // ten whole records then a cut one
        let r = from_bytes(&raw);
        assert_eq!(r.samples, 10);
        assert!(r.malformed_tail.is_some(), "a truncated tail must be reported");
        assert!(!r.channels.is_empty(), "the intact records must still aggregate");
    }

    #[test]
    fn every_mode_writes_the_exact_token_the_kernel_expects() {
        assert_eq!(Mode::Background.as_str(), "background");
        assert_eq!(Mode::Trigger.as_str(), "trigger");
        assert_eq!(Mode::Disable.as_str(), "disable");
    }

    #[test]
    fn reading_never_touches_the_control_file() {
        // The observe-first guarantee, asserted rather than trusted: a read
        // against a path whose ctl file is read-only must still succeed.
        let root = tmp();
        let dir = fake_phy(&root, "phy0", "ath9k_htc");
        std::fs::write(dir.join("spectral_scan0"), Vec::<u8>::new()).unwrap();
        let path = discover_in(&root).unwrap();

        let before = std::fs::read_to_string(path.ctl()).unwrap();
        let r = read_samples(&path).unwrap();
        let after = std::fs::read_to_string(path.ctl()).unwrap();

        assert!(!r.observed());
        assert_eq!(before, after, "read_samples must never write to the control file");
        std::fs::remove_dir_all(&root).ok();
    }
}
