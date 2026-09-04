//! The device roster — which machines this app drives, and how to reach each one.
//!
//! Small, hand-edited, and deliberately a plain JSON file rather than a database: four machines, read
//! on every command, and a human has to be able to fix it with an editor when SSH is the thing that is
//! broken.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// A machine this app deploys to.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Device {
    /// Short name — how a human names it on the command line (`monitor`, `lumpy-space`).
    pub name: String,
    /// `user@host` for SSH. No port field: put it in `~/.ssh/config`, which is where a human already
    /// looks and which `scp` and `ssh` both honour without this crate reimplementing either.
    pub ssh: String,
    /// The device's CPU architecture, as `uname -m` reports it (`x86_64`, `aarch64`).
    ///
    /// RECORDED, not probed, so a plan can refuse a mismatched artifact WITHOUT first reaching the
    /// device — an offline machine must still get a correct answer rather than an unknown one.
    /// [`crate::remote::probe_arch`] checks the record against reality at deploy time.
    pub arch: String,
    /// Optional systemd unit to restart after a swap. `None` means the binary is invoked on demand and
    /// nothing needs restarting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
}

/// Where the roster lives. Under the app's base dir, beside every other store.
pub fn roster_path() -> Option<PathBuf> {
    bsc_util::bsc_base_dir().map(|d| d.join("deploy").join("devices.json"))
}

/// Read the roster. A MISSING file is an empty roster, not an error — a fresh install has no devices
/// and should say so plainly rather than fail. A malformed file IS an error, because silently
/// treating "I could not parse your roster" as "you have no devices" would report every machine as
/// absent and invite a deploy to nowhere.
pub fn load() -> Result<Vec<Device>, String> {
    let p = roster_path().ok_or("cannot locate the base directory")?;
    if !p.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
    parse(&text)
}

/// Parse a roster document. Split out from [`load`] so the failure modes are testable without a disk.
pub fn parse(text: &str) -> Result<Vec<Device>, String> {
    let devices: Vec<Device> =
        serde_json::from_str(text).map_err(|e| format!("roster is not valid JSON: {e}"))?;
    let mut seen = std::collections::BTreeSet::new();
    for d in &devices {
        if d.name.trim().is_empty() {
            return Err("a device has an empty name".into());
        }
        if d.ssh.trim().is_empty() {
            return Err(format!("device '{}' has no ssh target", d.name));
        }
        if d.arch.trim().is_empty() {
            return Err(format!("device '{}' has no arch", d.name));
        }
        if !seen.insert(&d.name) {
            return Err(format!("device '{}' is listed twice", d.name));
        }
    }
    Ok(devices)
}

/// Find one device by name.
pub fn find<'a>(devices: &'a [Device], name: &str) -> Result<&'a Device, String> {
    devices.iter().find(|d| d.name == name).ok_or_else(|| {
        let known: Vec<&str> = devices.iter().map(|d| d.name.as_str()).collect();
        if known.is_empty() {
            format!("no device named '{name}' — the roster is empty; add one to {}", 
                roster_path().map(|p| p.display().to_string()).unwrap_or_else(|| "the roster".into()))
        } else {
            format!("no device named '{name}' — the roster has: {}", known.join(", "))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO: &str = r#"[
      {"name":"lumpy-space","ssh":"lumpy-space-princess@10.99.6.10","arch":"x86_64"},
      {"name":"monitor","ssh":"lan@10.99.5.10","arch":"aarch64","service":"bsc-net"}
    ]"#;

    #[test]
    fn parses_a_roster_and_keeps_the_optional_service() {
        let d = parse(TWO).expect("parses");
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].arch, "x86_64");
        assert_eq!(d[0].service, None, "a device with nothing to restart carries no unit");
        assert_eq!(d[1].service.as_deref(), Some("bsc-net"));
    }

    #[test]
    fn a_missing_field_is_an_error_naming_the_device() {
        // Not a default. A device with no ssh target is unreachable, and defaulting it to something
        // would produce a deploy aimed at the wrong machine — which is worse than refusing.
        let e = parse(r#"[{"name":"monitor","ssh":"","arch":"aarch64"}]"#).unwrap_err();
        assert!(e.contains("monitor") && e.contains("ssh"), "got: {e}");
    }

    #[test]
    fn a_duplicate_name_is_refused() {
        // Two entries with one name means `deploy push monitor` is ambiguous, and picking the first
        // silently would deploy to whichever happened to be written first.
        let dup = r#"[{"name":"a","ssh":"u@h","arch":"x86_64"},{"name":"a","ssh":"u@i","arch":"x86_64"}]"#;
        assert!(parse(dup).unwrap_err().contains("twice"));
    }

    #[test]
    fn malformed_json_is_an_error_never_an_empty_roster() {
        // The dangerous direction: reading "I cannot parse this" as "you have no devices" reports
        // every machine as absent, which looks like a fresh install rather than a broken file.
        assert!(parse("{not json").is_err());
    }

    #[test]
    fn an_unknown_name_lists_what_it_does_know() {
        let d = parse(TWO).unwrap();
        let e = find(&d, "nope").unwrap_err();
        assert!(e.contains("lumpy-space") && e.contains("monitor"), "got: {e}");
    }
}
