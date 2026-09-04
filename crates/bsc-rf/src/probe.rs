//! The IO layer — reads sysfs and shells out to `iw`. Everything it learns is handed to the pure
//! classifiers in [`crate::device`], so this module holds no decisions worth testing and every
//! decision worth testing holds no IO.

use std::path::{Path, PathBuf};

use crate::device::{
    classify_spectral, iface_up, monitor_from_modes, parse_phy_modes, Rfkill, Spectral, Tristate,
    WirelessDevice,
};

/// Where `iw` actually lives, searched by ABSOLUTE PATH rather than through `$PATH`.
///
/// MEASURED 2026-09-04: Debian installs `iw` to `/usr/sbin/iw`, and `/usr/sbin` is not on a non-root
/// user's `$PATH`. A `$PATH` lookup therefore reports the tool MISSING while the package is
/// installed and working — the tool would have lied about its own dependency, and blamed the user
/// for not installing something they had.
const IW_CANDIDATES: &[&str] = &["/usr/sbin/iw", "/sbin/iw", "/usr/bin/iw", "/bin/iw", "/usr/local/sbin/iw"];

/// The first `iw` that exists, or `None`.
pub fn find_iw() -> Option<PathBuf> {
    IW_CANDIDATES.iter().map(PathBuf::from).find(|p| p.exists())
}

/// Read a sysfs file, trimmed. `None` for anything unreadable — sysfs is full of files that exist
/// but error on read depending on device state.
fn read_trimmed(path: impl AsRef<Path>) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

/// Run `iw` with `args`, returning stdout on success.
///
/// A non-zero exit or a missing binary is `None`. Note that an EMPTY stdout with exit 0 is
/// `Some("")` — that distinction is load-bearing for survey, where empty-and-successful means the
/// driver has no survey op. Collapsing it into `None` would lose the only evidence of that.
pub fn run_iw(args: &[&str]) -> Option<String> {
    let iw = find_iw()?;
    let out = std::process::Command::new(iw).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The rfkill state for a phy, by matching `/sys/class/rfkill/*/name` against the phy name.
///
/// The rfkill index is not derivable from the phy index — they are separate registries and drift
/// apart as devices come and go — so the name is the only reliable join.
pub fn read_rfkill(phy: &str) -> Rfkill {
    let Ok(entries) = std::fs::read_dir("/sys/class/rfkill") else { return Rfkill::default() };
    for e in entries.flatten() {
        let p = e.path();
        if read_trimmed(p.join("name")).as_deref() != Some(phy) {
            continue;
        }
        return Rfkill {
            soft_blocked: read_trimmed(p.join("soft")).map(|v| v == "1"),
            hard_blocked: read_trimmed(p.join("hard")).map(|v| v == "1"),
        };
    }
    Rfkill::default()
}

/// Whether the running kernel carries the ath9k common spectral layer.
///
/// Reads `/proc/kallsyms`, which is readable by an unprivileged user for symbol NAMES (the addresses
/// are zeroed, which is irrelevant here). The absence of `ath9k_cmn_spectral*` is direct evidence
/// the layer was not compiled — better than reading `/boot/config-*`, which may be absent and only
/// describes what was CONFIGURED rather than what is loaded.
pub fn kernel_has_spectral_symbols() -> bool {
    std::fs::read_to_string("/proc/kallsyms")
        .map(|s| s.contains("ath9k_cmn_spectral"))
        .unwrap_or(false)
}

/// A readable `spectral_scan_ctl` for a phy, if the debugfs path exists.
///
/// Almost always unreadable without root even when present; existence alone is what we report, and
/// the caller learns about the permission separately when it tries to use it.
fn spectral_debugfs_path(phy: &str) -> Option<String> {
    for family in ["ath9k", "ath9k_htc", "ath10k"] {
        let p = format!("/sys/kernel/debug/ieee80211/{phy}/{family}/spectral_scan_ctl");
        if Path::new(&p).exists() {
            return Some(p);
        }
    }
    None
}

/// The supported interface modes for a phy, via `iw`. Empty when `iw` is unavailable — which
/// [`monitor_from_modes`] turns into [`Tristate::Unknown`] rather than a false negative.
fn phy_modes(phy: &str) -> Vec<String> {
    run_iw(&["phy", phy, "info"]).map(|t| parse_phy_modes(&t)).unwrap_or_default()
}

/// Every wireless interface the kernel knows about.
///
/// A netdev is wireless iff it has a `phy80211` symlink — the same test `iw` itself applies, and
/// more reliable than matching on name prefixes, which fail for predictable names like
/// `wlx00c0ca98b296`.
pub fn enumerate() -> Vec<WirelessDevice> {
    let Ok(entries) = std::fs::read_dir("/sys/class/net") else { return Vec::new() };

    let mut devices: Vec<WirelessDevice> = Vec::new();
    let mut mode_cache: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();

    for e in entries.flatten() {
        let dir = e.path();
        let iface = e.file_name().to_string_lossy().into_owned();

        let phy_link = dir.join("phy80211");
        if !phy_link.exists() {
            continue; // not a wireless interface
        }

        let phy = std::fs::canonicalize(&phy_link)
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()));

        let driver = std::fs::canonicalize(dir.join("device/driver"))
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()));

        let mac = read_trimmed(dir.join("address"));
        // Reported only when it DIFFERS — an equal permanent address is noise, while a differing one
        // means randomization is active and captures will not correlate across sessions.
        let permanent_mac = read_trimmed(dir.join("perm_address")).filter(|p| Some(p) != mac.as_ref());

        let up = dir
            .join("flags")
            .pipe_read()
            .and_then(|f| iface_up(&f))
            .unwrap_or(false);

        let (rfkill, spectral, monitor_capable) = match phy.as_deref() {
            Some(p) => {
                let modes = mode_cache.entry(p.to_string()).or_insert_with(|| phy_modes(p)).clone();
                (
                    read_rfkill(p),
                    classify_spectral(
                        driver.as_deref(),
                        kernel_has_spectral_symbols(),
                        spectral_debugfs_path(p).as_deref(),
                    ),
                    monitor_from_modes(&modes),
                )
            }
            None => (Rfkill::default(), Spectral::Unknown, Tristate::Unknown),
        };

        devices.push(WirelessDevice {
            iface,
            phy,
            driver,
            mac,
            permanent_mac,
            up,
            operstate: read_trimmed(dir.join("operstate")),
            rfkill,
            monitor_capable,
            spectral,
        });
    }

    devices.sort_by(|a, b| a.iface.cmp(&b.iface));
    devices
}

/// Tiny helper so the `flags` read reads in one line above without a nested `and_then` chain.
trait PipeRead {
    fn pipe_read(&self) -> Option<String>;
}

impl PipeRead for PathBuf {
    fn pipe_read(&self) -> Option<String> {
        read_trimmed(self)
    }
}

/// A live survey reading for one interface.
///
/// Empty stdout with exit 0 becomes [`crate::survey::SurveyReading::Unsupported`] inside
/// [`crate::survey::parse_survey`] — this function deliberately does no interpreting of its own.
pub fn survey(iface: &str) -> Option<crate::survey::SurveyReading> {
    run_iw(&["dev", iface, "survey", "dump"]).map(|t| crate::survey::parse_survey(&t))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Debian lesson, pinned: every candidate is ABSOLUTE. A relative entry would fall back to
    /// `$PATH` resolution inside `Command::new` and reintroduce the bug this list exists to fix.
    #[test]
    fn every_iw_candidate_is_an_absolute_path() {
        assert!(!IW_CANDIDATES.is_empty());
        for c in IW_CANDIDATES {
            assert!(Path::new(c).is_absolute(), "{c} must be absolute — a bare name would use $PATH");
        }
    }

    /// `/usr/sbin` must be searched, and searched BEFORE `/usr/bin`. This is the exact path Debian
    /// installs to and the exact directory missing from a non-root `$PATH`.
    #[test]
    fn the_debian_sbin_location_is_searched_first() {
        let sbin = IW_CANDIDATES.iter().position(|c| *c == "/usr/sbin/iw");
        let bin = IW_CANDIDATES.iter().position(|c| *c == "/usr/bin/iw");
        assert!(sbin.is_some(), "/usr/sbin/iw is where Debian puts it");
        assert!(bin.is_some());
        assert!(sbin < bin, "the sbin location is the one a $PATH lookup misses, so it is searched first");
    }

    /// Enumeration must not panic on a machine with no wireless hardware, and must not invent one.
    #[test]
    fn enumeration_is_safe_on_a_box_with_no_radios() {
        let devices = enumerate();
        for d in &devices {
            assert!(!d.iface.is_empty());
        }
    }
}
