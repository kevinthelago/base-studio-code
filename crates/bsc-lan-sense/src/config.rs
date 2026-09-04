//! Where the stream's keys live, and why that is a file rather than a flag.
//!
//! ## argv is published, and there is no way to opt out of that
//!
//! Every key this stream uses started life as hex on a command line. On Linux
//! `/proc/<pid>/cmdline` is world-readable, so any local account can read the
//! group key out of a running `bsc lan watch` for as long as it runs; a
//! systemd unit is worse, because `systemctl show` hands out its `ExecStart`
//! to anyone who asks and the unit file itself is usually mode 644. The group
//! key is the confidentiality half of the stream — whoever holds it reads
//! everything the sensor says. The sensor's signing key is worse still: it
//! forges.
//!
//! That mattered less while both halves were things a person typed. It stops
//! being tolerable the moment either end runs unattended, which is the whole
//! point of the two slices this one unblocks: a unit on the Pi and a
//! background subscription inside the desktop app. Neither has a shell to type
//! a flag into, so something has to hold the keys — and a file whose mode can
//! be checked is the smaller disclosure.
//!
//! ## Two documents, because one field that accepts either half is a trap
//!
//! [`SubscriberConfig`] and [`SensorConfig`] are separate types in separate
//! files, and neither has a field the other's secrets could land in. This is
//! not tidiness: `bsc lan sense` shipped for part of an afternoon reading the
//! sensor's PRIVATE key out of `--sensor-public-key`, because one field looked
//! like it could serve both roles. A single document with an optional
//! `sensorKey` would reintroduce exactly that — handing a subscriber the
//! signing key would become a typo rather than an impossibility. Both types
//! are `deny_unknown_fields`, so pointing the subscriber loader at a sensor
//! document is an error that names the offending field instead of quietly
//! ignoring it.
//!
//! ## Nothing here writes
//!
//! `bsc lan keygen` prints and does not write, deliberately — placing a
//! private key is the operator's decision. A `config set --group-key <hex>`
//! verb would put the key back on the command line for the sole purpose of
//! getting it off the command line, so there isn't one. The operator authors
//! the file (on the Pi, at SD-card time, which is that device's whole
//! management model); this module reads it, checks its mode, and refuses.

use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::{Path, PathBuf};

/// The subscriber document's filename inside [`config_dir`].
pub const SUBSCRIBER_FILE: &str = "subscriber.json";
/// The sensor document's filename inside [`config_dir`].
pub const SENSOR_FILE: &str = "sensor.json";
/// Overrides [`config_dir`] entirely — the seam every test writes through, and
/// the way a Pi points at `/etc/bsc-lan` instead of a home directory.
pub const DIR_ENV: &str = "BSC_LAN_DIR";

/// What a secret renders as. Never the first few characters of the real one:
/// a prefix narrows a search, and a 32-byte key shown eight characters at a
/// time across a few log lines is not a secret any more.
pub const REDACTED: &str = "<redacted>";

/// Where both documents live. `$BSC_LAN_DIR` wins; otherwise `lan/` under the
/// app's base directory, beside every other store.
pub fn config_dir() -> Option<PathBuf> {
    match std::env::var(DIR_ENV) {
        Ok(s) if !s.trim().is_empty() => Some(PathBuf::from(s)),
        Ok(_) | Err(_) => bsc_util::bsc_base_dir().map(|d| d.join("lan")),
    }
}

/// Path to the subscriber document.
pub fn subscriber_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join(SUBSCRIBER_FILE))
}

/// Path to the sensor document.
pub fn sensor_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join(SENSOR_FILE))
}

/// What a subscriber needs to hear the stream. Holds NO signing key, by
/// construction — see the module note.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SubscriberConfig {
    /// `addr:port` to listen on. A multicast group joins; anything else binds
    /// unicast, because multicast does not cross a VLAN without a router.
    pub group: String,
    /// Local interface address for a multicast join. Absent means unspecified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iface: Option<String>,
    /// The sensor's PUBLIC key, hex. Not a secret; it only verifies.
    pub sensor_public_key: String,
    /// The group key, hex. **SECRET** — confidentiality for the whole stream.
    pub group_key: String,
}

/// What the sensor needs to transmit. Holds the signing key, and so must never
/// be read by anything that only subscribes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SensorConfig {
    /// Where to send: a multicast group for this segment, or a unicast
    /// collector to cross a VLAN.
    pub destination: String,
    /// Local interface address to send from. Absent means unspecified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iface: Option<String>,
    /// The sensor's PRIVATE signing key, hex. **SECRET** — it forges.
    pub sensor_key: String,
    /// The group key, hex. **SECRET**.
    pub group_key: String,
    /// The radio to put into monitor mode before sensing, if any.
    ///
    /// Optional because a sensor with no radio is a legitimate configuration —
    /// it still attests its posture — and because the interface name is
    /// device-specific in a way nothing else here is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radio: Option<RadioConfig>,
}

/// Which interface to tune, and to what.
///
/// MEASURED, and this is why it is configuration rather than an afterthought:
/// with the USB adapter left `type managed` and unassociated after a reboot,
/// the sensor produced **5 spectrum records in 30 seconds**; with the same
/// adapter in monitor mode on channel 6, **30 in 30 seconds** — one per window,
/// which is the design rate. Monitor mode does not survive a reboot, so
/// without this the analyzer is sparse after every power cycle and nothing
/// says why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RadioConfig {
    /// Interface name, e.g. `wlan1`.
    pub iface: String,
    /// Channel to park on.
    pub channel: u16,
}

impl RadioConfig {
    /// Reject an interface name that is not one.
    ///
    /// This value is rendered into a systemd unit's `ExecStart`, so a name
    /// carrying a newline would append directives of the attacker's choosing
    /// to a file that runs as root. The kernel's own limit is `IFNAMSIZ` (16
    /// including the terminator) and the character set is deliberately
    /// narrower than what Linux would technically accept: nothing here needs
    /// an interface called `eth 0`.
    pub fn validate(&self) -> Result<(), String> {
        let n = &self.iface;
        if n.is_empty() || n.len() > 15 {
            return Err(format!("radio.iface must be 1..=15 characters, got {n:?}"));
        }
        if !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.') {
            return Err(format!(
                "radio.iface may only contain letters, digits, '_', '-' and '.', got {n:?} —                  this value is rendered into a unit file that runs as root"
            ));
        }
        if self.channel == 0 || self.channel > 196 {
            return Err(format!("radio.channel must be 1..=196, got {}", self.channel));
        }
        Ok(())
    }
}

/// A document together with where it came from, so a command can say which
/// source it used rather than leaving the operator to guess whether a flag or
/// a file won.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Loaded<T> {
    pub value: T,
    pub path: PathBuf,
}

/// Refuse a key file that anyone but its owner can read.
///
/// A key does not become protected by living in a file — it becomes protected
/// by the mode on that file. Mode `0o077` is every group and other bit: read,
/// write or execute. Any of them set means someone else can get at it, or can
/// replace it with a key of their choosing, which is the write half and just
/// as bad.
///
/// **Only unix can answer this.** Windows ACLs are not a mode and this cannot
/// be approximated from `PermissionsExt`, so on other platforms the check is
/// absent rather than faked — a guard that always passes is worse than one
/// that is honestly missing, because it reads as protection.
#[cfg(unix)]
pub fn refuse_if_readable_by_others(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(format!(
            "{} is mode {:04o} — it holds a key, so it must be readable by its owner only.\n  Fix it with: chmod 600 {}",
            path.display(),
            mode,
            path.display()
        ));
    }
    Ok(())
}

/// See the unix version — this platform cannot check a mode, so it does not
/// pretend to.
#[cfg(not(unix))]
pub fn refuse_if_readable_by_others(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Whether [`refuse_if_readable_by_others`] can actually answer here. Reported
/// by `bsc lan config` so a Windows operator is told the check did not run
/// rather than shown a clean bill of health it never earned.
pub const PERMISSIONS_ARE_CHECKED: bool = cfg!(unix);

fn read_document(path: &Path, what: &str) -> Result<String, String> {
    if !path.exists() {
        return Err(format!(
            "no {what} config at {} — author one there, or pass the keys as flags.\n  It must be mode 600: it holds a key.",
            path.display()
        ));
    }
    refuse_if_readable_by_others(path)?;
    std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))
}

/// Parse a subscriber document. Split from the load so every failure mode is
/// testable without a disk.
pub fn parse_subscriber(text: &str) -> Result<SubscriberConfig, String> {
    let c: SubscriberConfig =
        serde_json::from_str(text).map_err(|e| format!("not a valid subscriber config: {e}"))?;
    // Parse every field now rather than at first use: a config that is wrong
    // should say so when it is read, not several seconds into a listen loop
    // that then looks like a silent network.
    c.group_addr()?;
    c.iface_addr()?;
    c.sensor_public_key_bytes()?;
    c.group_key_bytes()?;
    Ok(c)
}

/// Parse a sensor document.
pub fn parse_sensor(text: &str) -> Result<SensorConfig, String> {
    let c: SensorConfig =
        serde_json::from_str(text).map_err(|e| format!("not a valid sensor config: {e}"))?;
    c.destination_addr()?;
    c.iface_addr()?;
    c.sensor_key_bytes()?;
    c.group_key_bytes()?;
    if let Some(r) = &c.radio {
        r.validate()?;
    }
    Ok(c)
}

/// Load the subscriber document from [`subscriber_path`].
pub fn load_subscriber() -> Result<Loaded<SubscriberConfig>, String> {
    let path = subscriber_path().ok_or("cannot locate the base directory")?;
    let text = read_document(&path, "subscriber")?;
    Ok(Loaded { value: parse_subscriber(&text)?, path })
}

/// Load the sensor document from [`sensor_path`].
pub fn load_sensor() -> Result<Loaded<SensorConfig>, String> {
    let path = sensor_path().ok_or("cannot locate the base directory")?;
    let text = read_document(&path, "sensor")?;
    Ok(Loaded { value: parse_sensor(&text)?, path })
}

fn parse_socket(s: &str, field: &str) -> Result<SocketAddrV4, String> {
    s.parse().map_err(|_| format!("{field} must be <ipv4-addr>:<port>, got {s:?}"))
}

fn parse_iface(s: Option<&str>) -> Result<Ipv4Addr, String> {
    match s {
        Some(v) => v.parse().map_err(|_| format!("iface must be an IPv4 address, got {v:?}")),
        None => Ok(Ipv4Addr::UNSPECIFIED),
    }
}

/// 32 bytes from 64 hex characters. Rejects odd lengths and non-hex loudly,
/// because a key that silently truncates verifies nothing and looks like a
/// network fault.
pub fn unhex32(s: &str, field: &str) -> Result<[u8; 32], String> {
    let s = s.trim();
    if s.len() != 64 {
        return Err(format!("{field} must be 64 hex characters, got {}", s.len()));
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
            .map_err(|_| format!("{field} is not hex"))?;
    }
    Ok(out)
}

impl SubscriberConfig {
    /// The address to listen on.
    pub fn group_addr(&self) -> Result<SocketAddrV4, String> {
        parse_socket(&self.group, "group")
    }
    /// The local interface for a multicast join.
    pub fn iface_addr(&self) -> Result<Ipv4Addr, String> {
        parse_iface(self.iface.as_deref())
    }
    /// The sensor's public key, as bytes.
    pub fn sensor_public_key_bytes(&self) -> Result<[u8; 32], String> {
        unhex32(&self.sensor_public_key, "sensorPublicKey")
    }
    /// The group key, as bytes. **SECRET.**
    pub fn group_key_bytes(&self) -> Result<[u8; 32], String> {
        unhex32(&self.group_key, "groupKey")
    }
    /// This document with every secret replaced by [`REDACTED`]. What any
    /// command prints, and what may be pasted into a bug report.
    pub fn redacted(&self) -> serde_json::Value {
        serde_json::json!({
            "group": self.group,
            "iface": self.iface,
            "sensorPublicKey": self.sensor_public_key,
            "groupKey": REDACTED,
        })
    }
}

impl SensorConfig {
    /// Where to transmit.
    pub fn destination_addr(&self) -> Result<SocketAddrV4, String> {
        parse_socket(&self.destination, "destination")
    }
    /// The local interface to send from.
    pub fn iface_addr(&self) -> Result<Ipv4Addr, String> {
        parse_iface(self.iface.as_deref())
    }
    /// The signing key, as bytes. **SECRET.**
    pub fn sensor_key_bytes(&self) -> Result<[u8; 32], String> {
        unhex32(&self.sensor_key, "sensorKey")
    }
    /// The group key, as bytes. **SECRET.**
    pub fn group_key_bytes(&self) -> Result<[u8; 32], String> {
        unhex32(&self.group_key, "groupKey")
    }
    /// This document with every secret replaced by [`REDACTED`]. Both keys go,
    /// not just the signing one — the group key reads the whole stream.
    pub fn redacted(&self) -> serde_json::Value {
        serde_json::json!({
            "destination": self.destination,
            "iface": self.iface,
            "sensorKey": REDACTED,
            "groupKey": REDACTED,
            "radio": self.radio.as_ref().map(|r| serde_json::json!({
                "iface": r.iface,
                "channel": r.channel,
            })),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUB: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const GROUP: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const SIGN: &str = "3333333333333333333333333333333333333333333333333333333333333333";

    fn subscriber_doc() -> String {
        format!(
            r#"{{"group":"239.10.20.30:5140","sensorPublicKey":"{PUB}","groupKey":"{GROUP}"}}"#
        )
    }

    fn sensor_doc() -> String {
        format!(
            r#"{{"destination":"239.10.20.30:5140","sensorKey":"{SIGN}","groupKey":"{GROUP}"}}"#
        )
    }

    #[test]
    fn a_subscriber_document_parses_into_its_typed_parts() {
        let c = parse_subscriber(&subscriber_doc()).expect("parses");
        assert_eq!(c.group_addr().unwrap().port(), 5140);
        assert!(c.group_addr().unwrap().ip().is_multicast());
        // Absent iface is unspecified, not an error: a unicast subscriber never
        // needs one, and demanding it would make the common case harder.
        assert_eq!(c.iface_addr().unwrap(), Ipv4Addr::UNSPECIFIED);
        assert_eq!(c.sensor_public_key_bytes().unwrap()[0], 0x11);
        assert_eq!(c.group_key_bytes().unwrap()[0], 0x22);
    }

    #[test]
    fn a_sensor_document_parses_into_its_typed_parts() {
        let c = parse_sensor(&sensor_doc()).expect("parses");
        assert_eq!(c.destination_addr().unwrap().port(), 5140);
        assert_eq!(c.sensor_key_bytes().unwrap()[0], 0x33);
        assert_eq!(c.group_key_bytes().unwrap()[0], 0x22);
    }

    #[test]
    fn a_sensor_document_is_refused_as_a_subscriber_config() {
        // THE POINT OF TWO TYPES. A loader that accepted this would have the
        // desktop app holding the sensor's signing key, and the one property
        // the signature exists for -- that a subscriber cannot forge -- would
        // be gone. It must be an ERROR, not a parse that ignores the extra
        // field, which is what `deny_unknown_fields` buys.
        let e = parse_subscriber(&sensor_doc()).unwrap_err();
        assert!(e.contains("sensorKey") || e.contains("destination"), "got: {e}");
        // And the reverse, so neither direction is the accident.
        let e = parse_sensor(&subscriber_doc()).unwrap_err();
        assert!(e.contains("sensorPublicKey") || e.contains("group"), "got: {e}");

        // THE SHAPE THAT ACTUALLY BITES: a document with every subscriber
        // field present AND a signing key alongside. Missing-field validation
        // cannot see this one -- nothing is missing. Only
        // `deny_unknown_fields` refuses it, and without that the desktop app
        // would load this file, ignore the extra key, and report success
        // while a signing key sat in a file it just read.
        let merged = format!(
            r#"{{"group":"239.10.20.30:5140","sensorPublicKey":"{PUB}","groupKey":"{GROUP}","sensorKey":"{SIGN}"}}"#
        );
        let e = parse_subscriber(&merged).unwrap_err();
        assert!(e.contains("sensorKey"), "a signing key smuggled into a subscriber config was accepted: {e}");
    }

    #[test]
    fn a_subscriber_config_has_no_field_a_signing_key_could_land_in() {
        // Asserted over the SHAPE rather than one document: a future field
        // named for the private half would fail here even if no test document
        // ever carried it.
        let c = parse_subscriber(&subscriber_doc()).unwrap();
        let v = serde_json::to_value(&c).unwrap();
        let obj = v.as_object().expect("an object");
        for k in obj.keys() {
            assert_ne!(k, "sensorKey", "the subscriber document grew a signing-key field");
            assert_ne!(k, "signingKey", "the subscriber document grew a signing-key field");
        }
        assert!(obj.contains_key("sensorPublicKey"), "fields: {:?}", obj.keys().collect::<Vec<_>>());
    }

    #[test]
    fn redaction_removes_every_secret_and_is_checked_against_the_key_itself() {
        // Asserting the rendered text does not CONTAIN the key, rather than
        // that some field equals "<redacted>": a second copy of the key
        // somewhere else in the document would pass the weaker check.
        let s = parse_subscriber(&subscriber_doc()).unwrap();
        let out = serde_json::to_string(&s.redacted()).unwrap();
        assert!(!out.contains(GROUP), "the group key survived redaction: {out}");
        assert!(out.contains(PUB), "the PUBLIC key is not a secret and should still be shown");

        let n = parse_sensor(&sensor_doc()).unwrap();
        let out = serde_json::to_string(&n.redacted()).unwrap();
        assert!(!out.contains(SIGN), "the signing key survived redaction: {out}");
        assert!(!out.contains(GROUP), "the group key survived redaction: {out}");
    }

    #[test]
    fn a_bad_key_is_caught_when_the_config_is_read_not_at_first_use() {
        // A listen loop that starts and hears nothing is indistinguishable
        // from a quiet network. The key has to fail at load.
        let short = format!(r#"{{"group":"1.2.3.4:1","sensorPublicKey":"aabb","groupKey":"{GROUP}"}}"#);
        let e = parse_subscriber(&short).unwrap_err();
        assert!(e.contains("sensorPublicKey") && e.contains("64"), "got: {e}");

        let nonhex = format!(
            r#"{{"group":"1.2.3.4:1","sensorPublicKey":"{PUB}","groupKey":"{}"}}"#,
            "z".repeat(64)
        );
        let e = parse_subscriber(&nonhex).unwrap_err();
        assert!(e.contains("groupKey") && e.contains("hex"), "got: {e}");
    }

    #[test]
    fn a_malformed_address_is_named_by_its_field() {
        let bad = format!(
            r#"{{"group":"239.10.20.30","sensorPublicKey":"{PUB}","groupKey":"{GROUP}"}}"#
        );
        let e = parse_subscriber(&bad).unwrap_err();
        assert!(e.contains("group") && e.contains("port"), "got: {e}");
    }

    #[test]
    fn malformed_json_is_an_error_never_an_empty_config() {
        // The dangerous direction: a config that fell through to defaults
        // would have a subscriber listening on nothing with a zero key, and
        // report a silent stream rather than a broken file.
        assert!(parse_subscriber("{not json").is_err());
        assert!(parse_sensor("").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_key_file_anyone_can_read_is_refused_by_its_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("bsc-lan-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("perm.json");
        std::fs::write(&p, subscriber_doc()).unwrap();

        for (mode, want_refused) in [(0o600, false), (0o640, true), (0o644, true), (0o604, true), (0o400, false)] {
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
            let r = refuse_if_readable_by_others(&p);
            assert_eq!(
                r.is_err(),
                want_refused,
                "mode {mode:04o} should {} be refused, got {r:?}",
                if want_refused { "" } else { "NOT" }
            );
            if let Err(e) = r {
                // The mode it FOUND, so the operator does not have to go look.
                assert!(e.contains(&format!("{mode:04o}")), "the error hides the mode: {e}");
                assert!(e.contains("chmod 600"), "the error does not say how to fix it: {e}");
            }
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_interface_name_that_could_inject_unit_directives_is_refused() {
        use super::RadioConfig;
        // This value lands in a systemd ExecStart line in a file that runs as
        // root. A newline in it appends directives of the writer's choosing.
        for bad in [
            "wlan1\nExecStart=/bin/sh -c evil",
            "wlan 1",
            "",
            "abcdefghijklmnopq",
            "wlan1;reboot",
            "../../etc/passwd",
        ] {
            let r = RadioConfig { iface: bad.into(), channel: 6 };
            assert!(r.validate().is_err(), "accepted {bad:?} as an interface name");
        }
        for good in ["wlan1", "wlp2s0", "mon.0", "en-1"] {
            RadioConfig { iface: good.into(), channel: 6 }
                .validate()
                .unwrap_or_else(|e| panic!("rejected the ordinary name {good:?}: {e}"));
        }
        assert!(RadioConfig { iface: "wlan1".into(), channel: 0 }.validate().is_err());
        assert!(RadioConfig { iface: "wlan1".into(), channel: 300 }.validate().is_err());
    }

    #[test]
    fn a_radio_is_optional_and_survives_the_round_trip() {
        // A sensor with no radio is legitimate: it still attests its posture.
        let none = parse_sensor(&sensor_doc()).unwrap();
        assert!(none.radio.is_none());
        let with = format!(
            r#"{{"destination":"1.2.3.4:5","sensorKey":"{SIGN}","groupKey":"{GROUP}","radio":{{"iface":"wlan1","channel":6}}}}"#
        );
        let c = parse_sensor(&with).expect("parses");
        let r = c.radio.as_ref().expect("the radio survived");
        assert_eq!((r.iface.as_str(), r.channel), ("wlan1", 6));
        // And it is still not a place a key could hide.
        let out = serde_json::to_string(&c.redacted()).unwrap();
        assert!(!out.contains(SIGN) && !out.contains(GROUP), "{out}");
        assert!(out.contains("wlan1"), "the radio is not a secret and should be shown: {out}");
    }

    #[test]
    fn a_bad_radio_is_caught_when_the_config_is_read() {
        let bad = format!(
            r#"{{"destination":"1.2.3.4:5","sensorKey":"{SIGN}","groupKey":"{GROUP}","radio":{{"iface":"wlan 1","channel":6}}}}"#
        );
        assert!(parse_sensor(&bad).unwrap_err().contains("radio.iface"));
    }

    #[test]
    fn the_directory_follows_the_env_override() {
        // Not read through the process env here -- these tests run in parallel
        // processes under nextest but `cargo test` threads them, and a
        // set_var race is exactly the class this repo has been bitten by. The
        // override is exercised end to end by the CLI tests, which own the
        // lock; what is asserted here is that the two filenames are distinct
        // and that neither is a path.
        assert_ne!(SUBSCRIBER_FILE, SENSOR_FILE);
        for f in [SUBSCRIBER_FILE, SENSOR_FILE] {
            assert!(!f.contains('/'), "{f} is a path, not a filename");
        }
        assert_eq!(PERMISSIONS_ARE_CHECKED, cfg!(unix));
    }
}
