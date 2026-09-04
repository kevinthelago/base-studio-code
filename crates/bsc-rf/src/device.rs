//! Wireless device enumeration — **rootless**, from sysfs, and honest about what it cannot know.
//!
//! # Why this is the first command and not an afterthought
//!
//! MEASURED 2026-09-04, and it cost real time: an AR9271 adapter presented as completely dead — no
//! LED, `nmcli` reporting the device `unavailable`, every interface `DOWN`. The adapter was fine.
//! Both phys were **rfkill soft-blocked** (`soft=1`), and every downstream symptom of a soft block
//! is indistinguishable from broken hardware unless something reports the block itself.
//!
//! So this command reports the states that MIMIC failure — rfkill, link-down, a driver bound but a
//! capability missing — rather than only the states that are failure.
//!
//! # Honest degradation
//!
//! Supported interface modes (is monitor mode available?) live in nl80211 and have no sysfs
//! equivalent. Rather than pretend, [`Tristate::Unknown`] is a first-class answer: an unreadable
//! capability reads as unknown, never as `false`. A tool that reports "monitor mode: no" because it
//! could not ask is worse than one that says it could not ask.

use serde::Serialize;

/// A three-valued answer, because "I could not determine this" is not "no".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Tristate {
    Yes,
    No,
    /// Could not be determined with the access or tools available.
    Unknown,
}

impl Tristate {
    pub const fn as_str(self) -> &'static str {
        match self {
            Tristate::Yes => "yes",
            Tristate::No => "no",
            Tristate::Unknown => "unknown",
        }
    }
}

/// Whether the kernel is blocking this radio, and how.
///
/// A SOFT block is software state — `nmcli radio wifi on` clears it without root, via polkit. A HARD
/// block is a physical switch or BIOS setting and no amount of software will clear it. Reporting
/// them separately is the difference between a one-command fix and a trip to the BIOS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
pub struct Rfkill {
    pub soft_blocked: Option<bool>,
    pub hard_blocked: Option<bool>,
}

impl Rfkill {
    /// Whether anything is blocking the radio.
    pub fn blocked(&self) -> bool {
        self.soft_blocked.unwrap_or(false) || self.hard_blocked.unwrap_or(false)
    }

    /// The remedy, when there is one — the actionable half of the report.
    pub fn remedy(&self) -> Option<&'static str> {
        match (self.soft_blocked, self.hard_blocked) {
            (_, Some(true)) => Some("HARD blocked — a physical switch or BIOS setting; software cannot clear it"),
            (Some(true), _) => Some("SOFT blocked — clear with `nmcli radio wifi on` (no root needed)"),
            _ => None,
        }
    }
}

/// Whether real FFT spectral data can be obtained from this radio, and if not, WHY not.
///
/// The distinction that matters is between silicon that never had the feature and silicon that has
/// it behind a kernel build option. The first is a hardware purchase; the second is a module
/// rebuild. A bare "no" conflates them and sends the reader shopping unnecessarily.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Spectral {
    /// The debugfs interface is present and readable.
    Available { path: String },
    /// The silicon supports it, but this kernel was not built with the path to reach it. Names the
    /// config symbol so the fix is a specific rebuild rather than a search.
    KernelPathMissing { driver: String, config_symbol: &'static str },
    /// This driver has never exposed spectral scan. No kernel rebuild helps.
    DriverUnsupported { driver: String },
    /// No driver bound, or the driver could not be identified.
    Unknown,
}

impl Spectral {
    /// One line for a human.
    pub fn explain(&self) -> String {
        match self {
            Spectral::Available { path } => format!("available at {path}"),
            Spectral::KernelPathMissing { driver, config_symbol } => format!(
                "unavailable — {driver} silicon supports it, but this kernel ships `# {config_symbol} is not set`. \
                 Rebuilding the module out-of-tree with {config_symbol}=y enables it; no new hardware is needed"
            ),
            Spectral::DriverUnsupported { driver } => {
                format!("unavailable — the {driver} driver has never exposed spectral scan; an SDR is the alternative")
            }
            Spectral::Unknown => "unknown — no driver identified".into(),
        }
    }
}

/// One wireless interface, as far as sysfs and the available tools can describe it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WirelessDevice {
    pub iface: String,
    /// The `phyN` this interface belongs to. Several interfaces can share one phy.
    pub phy: Option<String>,
    pub driver: Option<String>,
    /// The MAC currently in use — which may be randomized by NetworkManager.
    pub mac: Option<String>,
    /// The burned-in MAC, when it differs from `mac`. A difference means randomization is active,
    /// which matters when correlating captures across sessions.
    pub permanent_mac: Option<String>,
    /// `IFF_UP` — whether the interface is administratively up. Distinct from `operstate`: an
    /// unassociated station is UP with operstate `down`, which reads alarmingly and is normal.
    pub up: bool,
    pub operstate: Option<String>,
    pub rfkill: Rfkill,
    /// Requires nl80211; [`Tristate::Unknown`] when `iw` is unavailable.
    pub monitor_capable: Tristate,
    pub spectral: Spectral,
}

impl WirelessDevice {
    /// Whether this device can currently be used for monitoring, and what stands in the way.
    ///
    /// Returns the FIRST blocking reason rather than a boolean, because the reasons have different
    /// remedies and a caller that only learns "no" has to rediscover which.
    pub fn blocker(&self) -> Option<String> {
        if let Some(r) = self.rfkill.remedy() {
            return Some(r.to_string());
        }
        if !self.up {
            return Some(format!("interface is DOWN — `sudo ip link set {} up`", self.iface));
        }
        if self.monitor_capable == Tristate::No {
            return Some("this phy does not support monitor mode".into());
        }
        None
    }
}

/// Decide the spectral-scan story for a driver, given what the running kernel exposes.
///
/// PURE — the two facts it needs are passed in, so every branch is testable without a radio.
///
/// * `has_spectral_symbols` — whether `ath9k_cmn_spectral*` appears in `/proc/kallsyms`. Its absence
///   is what proves the common spectral layer was not compiled, independently of any config file.
/// * `debugfs_path` — a readable `spectral_scan_ctl`, when one was found.
pub fn classify_spectral(
    driver: Option<&str>,
    has_spectral_symbols: bool,
    debugfs_path: Option<&str>,
) -> Spectral {
    let Some(driver) = driver else { return Spectral::Unknown };

    if let Some(p) = debugfs_path {
        return Spectral::Available { path: p.to_string() };
    }

    // The ath9k/ath10k families are the only commodity silicon that exposes per-channel FFT bins.
    // Which config symbol gates it depends on the bus, and naming the wrong one sends the reader to
    // a rebuild that changes nothing.
    match driver {
        "ath9k_htc" => Spectral::KernelPathMissing {
            driver: driver.into(),
            config_symbol: "CONFIG_ATH9K_HTC_DEBUGFS",
        },
        "ath9k" => Spectral::KernelPathMissing {
            driver: driver.into(),
            config_symbol: "CONFIG_ATH9K_DEBUGFS",
        },
        "ath10k_pci" | "ath10k_sdio" | "ath10k_usb" | "ath10k_core" => Spectral::KernelPathMissing {
            driver: driver.into(),
            config_symbol: "CONFIG_ATH10K_SPECTRAL",
        },
        // A spectral-capable family whose common layer IS compiled, yet with no debugfs node found,
        // is a different situation from one whose layer is absent — but both leave the caller
        // without FFT bins, and we do not have enough to distinguish further.
        other if has_spectral_symbols && other.starts_with("ath") => {
            Spectral::KernelPathMissing { driver: other.into(), config_symbol: "CONFIG_ATH9K_DEBUGFS" }
        }
        other => Spectral::DriverUnsupported { driver: other.into() },
    }
}

/// `IFF_UP` out of the hex flags word in `/sys/class/net/<if>/flags`.
///
/// Pure, and separate from the read because the parse is the part that can be wrong.
pub fn iface_up(flags_hex: &str) -> Option<bool> {
    let s = flags_hex.trim();
    let s = s.strip_prefix("0x").unwrap_or(s);
    u32::from_str_radix(s, 16).ok().map(|f| f & 0x1 != 0)
}

/// Supported interface modes out of `iw phy <phy> info`.
///
/// The block is introduced by `Supported interface modes:` and each mode is a ` * <name>` bullet;
/// the list ends at the first line that is not a bullet. Pure.
pub fn parse_phy_modes(text: &str) -> Vec<String> {
    let mut modes = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("Supported interface modes") {
            inside = true;
            continue;
        }
        if inside {
            match t.strip_prefix("* ") {
                Some(m) => modes.push(m.trim().to_string()),
                // The block is over. Stop rather than continue, so a later `* ` bullet from a
                // different section (there are several) cannot leak in as an interface mode.
                None => break,
            }
        }
    }
    modes
}

/// Whether a phy's mode list includes monitor mode.
pub fn monitor_from_modes(modes: &[String]) -> Tristate {
    if modes.is_empty() {
        return Tristate::Unknown;
    }
    if modes.iter().any(|m| m == "monitor") {
        Tristate::Yes
    } else {
        Tristate::No
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The measured configuration of the development box: AR9271 silicon that CAN do spectral scan,
    /// on a Debian kernel that did not build the path. The report must send the reader to a module
    /// rebuild, not to a shop.
    #[test]
    fn ath9k_htc_without_the_debugfs_build_names_the_config_symbol() {
        let s = classify_spectral(Some("ath9k_htc"), false, None);
        assert_eq!(
            s,
            Spectral::KernelPathMissing {
                driver: "ath9k_htc".into(),
                config_symbol: "CONFIG_ATH9K_HTC_DEBUGFS"
            }
        );
        let e = s.explain();
        assert!(e.contains("CONFIG_ATH9K_HTC_DEBUGFS"), "the fix must be named, not merely implied");
        assert!(e.contains("no new hardware"), "and distinguished from a hardware limitation");
    }

    /// The other radio on the same box. Realtek has never had spectral scan, so the honest answer
    /// points at an SDR rather than at a rebuild that would achieve nothing.
    #[test]
    fn a_driver_that_never_had_spectral_is_not_reported_as_a_kernel_problem() {
        let s = classify_spectral(Some("rtw89_8851be"), false, None);
        assert_eq!(s, Spectral::DriverUnsupported { driver: "rtw89_8851be".into() });
        assert!(s.explain().contains("SDR"), "the reader needs the alternative, not just a refusal");
        assert!(!s.explain().contains("CONFIG_"), "naming a config symbol here would be a false lead");
    }

    #[test]
    fn a_present_debugfs_node_wins_over_every_heuristic() {
        let s = classify_spectral(Some("ath9k_htc"), true, Some("/sys/kernel/debug/.../spectral_scan_ctl"));
        assert!(matches!(s, Spectral::Available { .. }));
    }

    #[test]
    fn no_driver_is_unknown_rather_than_unsupported() {
        assert_eq!(classify_spectral(None, false, None), Spectral::Unknown);
    }

    #[test]
    fn ath10k_gets_its_own_config_symbol() {
        let s = classify_spectral(Some("ath10k_pci"), false, None);
        assert_eq!(
            s,
            Spectral::KernelPathMissing {
                driver: "ath10k_pci".into(),
                config_symbol: "CONFIG_ATH10K_SPECTRAL"
            }
        );
    }

    #[test]
    fn iff_up_is_read_out_of_the_hex_flags_word() {
        // The measured value for an UP but unassociated interface.
        assert_eq!(iface_up("0x1003"), Some(true));
        assert_eq!(iface_up("0x1002"), Some(false));
        assert_eq!(iface_up("1003"), Some(true), "the 0x prefix is optional");
        assert_eq!(iface_up("nonsense"), None, "an unparseable word is unknown, not false");
    }

    /// Verbatim shape of `iw phy phy2 info` for the AR9271 on the development box.
    const PHY_INFO: &str = "\
Wiphy phy2
\tmax # scan SSIDs: 4
\tSupported interface modes:
\t\t * IBSS
\t\t * managed
\t\t * AP
\t\t * AP/VLAN
\t\t * monitor
\t\t * mesh point
\tBand 1:
\t\tCapabilities: 0x107e
\t\tFrequencies:
\t\t\t* 2412.0 MHz [1] (20.0 dBm)
";

    #[test]
    fn parses_the_supported_mode_block_and_stops_at_its_end() {
        let modes = parse_phy_modes(PHY_INFO);
        assert_eq!(modes, vec!["IBSS", "managed", "AP", "AP/VLAN", "monitor", "mesh point"]);
        assert!(
            !modes.iter().any(|m| m.contains("MHz")),
            "the frequency bullets are a different section and must not leak in as interface modes"
        );
        assert_eq!(monitor_from_modes(&modes), Tristate::Yes);
    }

    /// The honest-degradation rule: no mode list means we could not ask, which is not a no.
    #[test]
    fn an_absent_mode_list_is_unknown_and_never_no() {
        assert_eq!(monitor_from_modes(&[]), Tristate::Unknown);
        assert_eq!(parse_phy_modes(""), Vec::<String>::new());
        assert_eq!(monitor_from_modes(&parse_phy_modes("")), Tristate::Unknown);
    }

    #[test]
    fn a_phy_without_monitor_mode_is_a_real_no() {
        let modes = parse_phy_modes("Supported interface modes:\n\t\t * managed\n\tBand 1:\n");
        assert_eq!(monitor_from_modes(&modes), Tristate::No);
    }

    /// The dark-LED case, which read as dead hardware and was not. A soft block must come back with
    /// its rootless remedy attached.
    #[test]
    fn a_soft_block_reports_the_rootless_remedy() {
        let r = Rfkill { soft_blocked: Some(true), hard_blocked: Some(false) };
        assert!(r.blocked());
        let remedy = r.remedy().unwrap();
        assert!(remedy.contains("nmcli radio wifi on"));
        assert!(remedy.contains("no root"));
    }

    #[test]
    fn a_hard_block_does_not_offer_a_software_fix() {
        let r = Rfkill { soft_blocked: Some(true), hard_blocked: Some(true) };
        let remedy = r.remedy().unwrap();
        assert!(remedy.contains("HARD"));
        assert!(!remedy.contains("nmcli"), "offering a software fix for a physical switch is a false lead");
    }

    #[test]
    fn an_unknown_rfkill_state_is_not_treated_as_blocked() {
        let r = Rfkill::default();
        assert!(!r.blocked());
        assert_eq!(r.remedy(), None);
    }

    /// The blocker chain reports the FIRST thing standing in the way, most-fundamental first — an
    /// rfkill block makes the down interface irrelevant, and saying so in the wrong order sends the
    /// reader to a command that will fail.
    #[test]
    fn the_blocker_reports_rfkill_before_link_state() {
        let d = WirelessDevice {
            iface: "wlan0".into(),
            phy: Some("phy0".into()),
            driver: Some("ath9k_htc".into()),
            mac: None,
            permanent_mac: None,
            up: false,
            operstate: Some("down".into()),
            rfkill: Rfkill { soft_blocked: Some(true), hard_blocked: Some(false) },
            monitor_capable: Tristate::Yes,
            spectral: Spectral::Unknown,
        };
        assert!(d.blocker().unwrap().contains("nmcli"), "rfkill outranks the down interface");

        let unblocked = WirelessDevice {
            rfkill: Rfkill { soft_blocked: Some(false), hard_blocked: Some(false) },
            ..d.clone()
        };
        assert!(unblocked.blocker().unwrap().contains("ip link set"));

        let usable = WirelessDevice { up: true, ..unblocked };
        assert_eq!(usable.blocker(), None);
    }

    /// An unknown capability must not be reported as a blocker — that would refuse to run on every
    /// box where `iw` is missing.
    #[test]
    fn an_unknown_monitor_capability_does_not_block() {
        let d = WirelessDevice {
            iface: "wlan0".into(),
            phy: None,
            driver: None,
            mac: None,
            permanent_mac: None,
            up: true,
            operstate: None,
            rfkill: Rfkill::default(),
            monitor_capable: Tristate::Unknown,
            spectral: Spectral::Unknown,
        };
        assert_eq!(d.blocker(), None);
    }
}
