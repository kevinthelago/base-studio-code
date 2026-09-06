//! The estate module against the REAL management segment.
//!
//! `fixtures/monitor-pi/eve-mgmt-flows.json` is 397 flow records captured from
//! the live sensor on 2026-09-04, reduced to the fields this module reads —
//! no DNS names, no HTTP, no TLS, no payload of any kind. It is real traffic
//! between real machines, which is the point: the estate is supposed to be
//! derived from observation, so the test has to observe something real.
//!
//! The six hosts in it are the documented management estate:
//!
//! ```text
//! 10.99.2.1    OPNsense — firewall, Unbound DNS, Kea DHCP
//! 10.99.2.2    TL-SG2008P switch
//! 10.99.2.100  assistant Pi — Omada controller, FreeRADIUS, NAC
//! 10.99.2.102  EAP650 access point
//! 10.99.2.104  Kali Pi
//! 10.99.2.118  admin PC
//! ```

use bsc_lan_sense::estate::{assess, observe};
use std::collections::BTreeSet;

const SEGMENT: &str = "10.99.2.";

fn eve() -> String {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/monitor-pi/eve-mgmt-flows.json"),
    )
    .expect("the captured MGMT flow fixture is readable")
}

fn documented() -> BTreeSet<String> {
    ["10.99.2.1", "10.99.2.2", "10.99.2.100", "10.99.2.102", "10.99.2.104", "10.99.2.118"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

#[test]
fn the_real_capture_yields_the_six_documented_management_hosts() {
    let (hosts, examined) = observe(&eve(), SEGMENT);
    // Evidence first: a conclusion from zero records is not a clean segment.
    assert!(examined > 300, "only {examined} records examined from the real capture");

    let found: BTreeSet<String> = hosts.keys().cloned().collect();
    assert_eq!(
        found,
        documented(),
        "the estate observed on the wire differs from the documented management roster"
    );
}

#[test]
fn every_host_carries_the_evidence_that_justifies_it() {
    let (hosts, _) = observe(&eve(), SEGMENT);
    for (addr, h) in &hosts {
        assert!(h.observations > 0, "{addr} was listed with no observations behind it");
        assert_eq!(&h.addr, addr);
    }
}

/// Against the documented roster, the real segment is fully accounted for —
/// which is the good outcome, and NOT the one to assume: the kickoff records
/// this documentation set as stale and wrong in specific places.
#[test]
fn the_real_management_segment_holds_no_unexpected_host() {
    let e = assess(&eve(), SEGMENT, &documented());
    assert!(
        e.unexpected.is_empty(),
        "an undocumented host is present on the management VLAN: {:?}",
        e.unexpected.iter().map(|h| (&h.addr, h.observations)).collect::<Vec<_>>()
    );
    assert!(e.missing.is_empty(), "documented but never seen: {:?}", e.missing);
    assert_eq!(e.accounted.len(), 6);
    assert!(!e.needs_attention());
}

/// The capability this exists for, proven on real data: drop a host from the
/// roster and it must surface as the finding rather than blend in.
#[test]
fn a_rogue_host_on_the_real_segment_is_surfaced_and_leads() {
    let mut roster = documented();
    roster.remove("10.99.2.104"); // pretend Kali was never authorised here

    let e = assess(&eve(), SEGMENT, &roster);
    assert_eq!(e.unexpected.len(), 1);
    assert_eq!(e.unexpected[0].addr, "10.99.2.104");
    assert!(
        e.unexpected[0].observations > 0,
        "the finding must carry the evidence a human will be asked to act on"
    );
    assert!(e.needs_attention());
    assert_eq!(e.accounted.len(), 5);
}

/// A neighbouring segment must not leak in. The sensor sees every VLAN, so
/// this is a live risk rather than a theoretical one — the same capture
/// contains 10.99.5.x and public addresses.
#[test]
fn other_segments_in_the_same_capture_are_excluded() {
    let (hosts, _) = observe(&eve(), SEGMENT);
    for addr in hosts.keys() {
        assert!(addr.starts_with(SEGMENT), "{addr} is not on the management segment");
    }
    // And the capture genuinely does contain other addresses, so the filter is
    // doing work rather than passing vacuously.
    assert!(
        eve().contains("10.99.5.") || eve().lines().any(|l| !l.contains("10.99.2.")),
        "the fixture contains no off-segment traffic, so this test proves nothing"
    );
}
