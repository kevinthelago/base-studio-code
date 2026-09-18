//! `bsc inventory` — every device on the LAN, what it is, and when each source last saw it.
//!
//! The asset inventory the cyber roadmap names as the join table everything else needs: a CVE
//! result, a posture verdict or an RF finding is only actionable once it can say WHICH of my things
//! it is about. Slice 2 of `epic-the-lan-workspace`, and the store the LAN screen and a device's
//! keeper session read.
//!
//! ## Three kinds of knowledge, kept apart
//!
//! - **Declared** — a [`Device`]: its name, role, owner, VLAN and whether it is expected, and the
//!   addresses (IPs and MACs) claimed for it. Written by a person or an agent, never inferred.
//! - **Observed** — a [`Sighting`]: an address the sensor saw on the wire, from `bsc lan graph`,
//!   with when and what it served. Written only by [`Inventory::observe`].
//! - **Segments** — which subnet is which VLAN. Declared, because MGMT is the untagged native VLAN
//!   and its frames carry no tag: a host's VLAN cannot be read off the wire for the one segment it
//!   matters most on (measured 2026-09-18 — a MGMT host's tag set was the VLANs it TALKED TO).
//!
//! An observed private address no device claims is **unclaimed** — the seen-but-not-expected finding
//! `bsc lan estate` exists to surface, now durable instead of recomputed per log.
//!
//! This crate is deliberately NOT part of `bsc lan`: the `bsc-lan` binary runs on the 4 GB monitor
//! Pi and `crates/bsc-lan/tests/lean.rs` forbids it SQLite. A store lives where a store may live.

pub mod cli;
mod store;

pub use store::{Inventory, ObserveReport};

use bsc_lan_sense::graph::{LanName, Scope};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr};

/// A declared device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    /// A stable slug — `[a-z0-9-]`, 1–60 chars. Addresses change; this does not.
    pub id: String,
    pub name: Option<String>,
    pub role: Option<String>,
    pub owner: Option<String>,
    /// The VLAN it BELONGS on, as declared. `None` falls back to its address's [`Segment`].
    pub vlan: Option<u16>,
    /// Whether it is supposed to be here. `None` is "nobody said", which is not "yes".
    pub expected: Option<bool>,
    pub notes: Option<String>,
    pub created_ms: i64,
    pub updated_ms: i64,
    pub addresses: Vec<Address>,
}

/// An address claimed for a device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Address {
    /// Normalised: an IP as `IpAddr` prints it, a MAC lower-case colon-separated.
    pub addr: String,
    pub kind: AddrKind,
    /// A MAC with the locally-administered bit set — the privacy-MAC pattern phones rotate through.
    /// Said wherever the address appears, so nobody reads continuity into a MAC that has none.
    pub randomized: bool,
    pub claimed_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AddrKind {
    Ip,
    Mac,
}

/// What the sensor saw at one address. Private and link-local addresses only: a visited website
/// is a destination on the graph, not an asset of ours.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sighting {
    pub addr: String,
    pub scope: Scope,
    /// Every 802.1Q tag it has been seen under, across observations.
    pub vlans: BTreeSet<u16>,
    /// Every port it has been seen ANSWERING on, across observations.
    pub serves: BTreeSet<u16>,
    /// The names the latest observation carried for it.
    pub names: Vec<LanName>,
    /// Flow records in the latest observation — a snapshot, not a running total, because two
    /// overlapping logs would otherwise count the same flows twice.
    pub records: u64,
    /// Wire time, from the flows themselves: earliest ever seen.
    pub first_seen_ms: Option<i64>,
    /// Wire time: latest ever seen.
    pub last_seen_ms: Option<i64>,
    /// When `observe` last recorded it — ingest time, distinct from wire time.
    pub observed_ms: i64,
    /// The device claiming this address, if any. `None` is the finding.
    pub device: Option<String>,
}

/// One subnet and the VLAN it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    /// IPv4 CIDR, e.g. `10.99.2.0/24`, stored normalised to its network address.
    pub cidr: String,
    pub vlan: u16,
    pub name: String,
}

/// A device id is a slug: it names a folder-free key the screen, a session and a plan note can
/// all use, so it must survive a shell and a URL untouched.
pub fn valid_id(id: &str) -> bool {
    (1..=60).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !id.starts_with('-')
        && !id.ends_with('-')
}

/// Normalise an address as the kind it is, or say why it is neither.
pub fn parse_addr(raw: &str) -> Result<(String, AddrKind, bool), String> {
    let s = raw.trim();
    if let Ok(ip) = s.parse::<IpAddr>() {
        return Ok((ip.to_string(), AddrKind::Ip, false));
    }
    match s.parse::<bsc_lan_core::primitives::MacAddr>() {
        Ok(mac) => Ok((mac.to_string(), AddrKind::Mac, mac.is_locally_administered())),
        Err(_) => Err(format!("`{s}` is neither an IP address nor a MAC address")),
    }
}

/// Parse `a.b.c.d/n` into (network, prefix). IPv4 only — every segment here is.
pub fn parse_cidr(raw: &str) -> Result<(Ipv4Addr, u8), String> {
    let (ip, len) = raw.trim().split_once('/').ok_or_else(|| format!("`{raw}` is not a CIDR (a.b.c.d/n)"))?;
    let ip: Ipv4Addr = ip.parse().map_err(|_| format!("`{raw}`: `{ip}` is not an IPv4 address"))?;
    let len: u8 = len.parse().ok().filter(|l| *l <= 32).ok_or_else(|| format!("`{raw}`: prefix must be 0–32"))?;
    let mask = if len == 0 { 0 } else { u32::MAX << (32 - len) };
    Ok((Ipv4Addr::from(u32::from(ip) & mask), len))
}

/// The segment an address falls in — the most specific match, so a /25 carved out of a /24 wins.
pub fn segment_of<'a>(addr: &str, segments: &'a [Segment]) -> Option<&'a Segment> {
    let ip: Ipv4Addr = addr.parse().ok()?;
    segments
        .iter()
        .filter_map(|s| parse_cidr(&s.cidr).ok().map(|(net, len)| (s, net, len)))
        .filter(|(_, net, len)| {
            let mask = if *len == 0 { 0 } else { u32::MAX << (32 - len) };
            u32::from(ip) & mask == u32::from(*net)
        })
        .max_by_key(|(_, _, len)| *len)
        .map(|(s, _, _)| s)
}

/// Whether `addr` is the directed-broadcast address of a declared segment (`10.99.6.255` in a
/// /24). The graph cannot know — by range it is just a private address — but the inventory knows the
/// segments, and a broadcast address listed as an unclaimed "device" is noise in the one list that
/// is supposed to be all signal. A /31 or /32 has no broadcast address.
pub fn is_segment_broadcast(addr: &str, segments: &[Segment]) -> bool {
    let Ok(ip) = addr.parse::<Ipv4Addr>() else { return false };
    segments.iter().filter_map(|s| parse_cidr(&s.cidr).ok()).any(|(net, len)| {
        len <= 30 && {
            let host_bits = u32::MAX >> len;
            u32::from(ip) == u32::from(net) | host_bits
        }
    })
}

/// Whether the inventory keeps a sighting for this scope. Ours are private and link-local.
pub fn is_asset_scope(scope: Scope) -> bool {
    match scope {
        Scope::Private | Scope::LinkLocal => true,
        Scope::Public | Scope::Loopback | Scope::Multicast | Scope::Broadcast | Scope::Unspecified => false,
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_is_a_slug() {
        for ok in ["assistant-pi", "eap650", "a", "candy-kingdom"] {
            assert!(valid_id(ok), "{ok}");
        }
        for bad in ["", "Assistant", "has space", "-lead", "trail-", "a/b", &"x".repeat(61)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn an_address_is_normalised_as_what_it_is() {
        assert_eq!(parse_addr(" 10.99.2.100 ").unwrap(), ("10.99.2.100".into(), AddrKind::Ip, false));
        let (mac, kind, randomized) = parse_addr("DC:A6:32:01:02:03").unwrap();
        assert_eq!((mac.as_str(), kind, randomized), ("dc:a6:32:01:02:03", AddrKind::Mac, false));
        assert!(parse_addr("da:a6:32:01:02:03").unwrap().2, "locally administered = a privacy MAC");
        assert!(parse_addr("not-an-address").unwrap_err().contains("neither"));
    }

    #[test]
    fn a_cidr_normalises_to_its_network() {
        assert_eq!(parse_cidr("10.99.2.77/24").unwrap(), (Ipv4Addr::new(10, 99, 2, 0), 24));
        assert!(parse_cidr("10.99.2.0").is_err());
        assert!(parse_cidr("10.99.2.0/33").is_err());
    }

    #[test]
    fn the_most_specific_segment_wins() {
        let segs = vec![
            Segment { cidr: "192.168.0.0/16".into(), vlan: 1, name: "all".into() },
            Segment { cidr: "10.99.2.0/24".into(), vlan: 2, name: "MGMT".into() },
        ];
        assert_eq!(segment_of("10.99.2.100", &segs).unwrap().name, "MGMT");
        assert_eq!(segment_of("192.168.9.1", &segs).unwrap().name, "all");
        assert!(segment_of("10.0.0.1", &segs).is_none());
        assert!(segment_of("fe80::1", &segs).is_none());
    }

    #[test]
    fn a_segment_broadcast_is_recognised_and_a_host_is_not() {
        let segs = vec![
            Segment { cidr: "10.99.6.0/24".into(), vlan: 6, name: "LAB".into() },
            Segment { cidr: "10.9.0.0/31".into(), vlan: 9, name: "p2p".into() },
        ];
        assert!(is_segment_broadcast("10.99.6.255", &segs));
        assert!(!is_segment_broadcast("10.99.6.254", &segs));
        assert!(!is_segment_broadcast("10.99.3.255", &segs), "an undeclared segment is not assumed");
        assert!(!is_segment_broadcast("10.9.0.1", &segs), "a /31 has no broadcast address");
        assert!(!is_segment_broadcast("fe80::1", &segs));
    }

    #[test]
    fn only_our_own_scopes_are_assets() {
        assert!(is_asset_scope(Scope::Private) && is_asset_scope(Scope::LinkLocal));
        assert!(!is_asset_scope(Scope::Public) && !is_asset_scope(Scope::Broadcast));
    }
}
