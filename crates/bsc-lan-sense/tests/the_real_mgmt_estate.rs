//! The estate module against the REAL management segment.
//!
//! The capture is `eve-mgmt-flows.json` — flow records reduced to the fields this module
//! reads (no DNS names, no HTTP, no TLS, no payload of any kind). It is real traffic between
//! real machines, which is the point: the estate is supposed to be derived from observation,
//! so the test has to observe something real.
//!
//! **It therefore does not live in this repo.** The capture and the roster it is checked
//! against are this network's actual topology, so they live in the hub beside the rest of the
//! project's private data — `projects/lan/fixtures/monitor-pi/`, described by
//! `projects/lan/estate.md`. These tests resolve them and SKIP when they are absent, so a
//! fresh clone and CI are green without data they were never given.
//!
//! The roster is READ from the capture rather than written here, so no real address appears in
//! this file. `segment()` derives the /24 from it for the same reason.

mod common;

use bsc_lan_sense::estate::{assess, observe};
use std::collections::BTreeSet;

/// The capture, the roster and the segment — or `None`, meaning skip.
fn capture() -> Option<(String, BTreeSet<String>, String)> {
    let eve = common::fixture("eve-mgmt-flows.json")?;
    let roster = common::roster()?;
    assert!(
        roster.len() >= 2,
        "the roster must name at least two hosts or the exclusion tests prove nothing"
    );
    let segment = common::segment(&roster);
    Some((eve, roster, segment))
}

#[test]
fn the_real_capture_yields_the_documented_management_hosts() {
    let Some((eve, roster, segment)) = capture() else {
        return common::skip("the_real_capture_yields_the_documented_management_hosts");
    };
    let (hosts, examined) = observe(&eve, &segment);
    // Evidence first: a conclusion from zero records is not a clean segment.
    assert!(examined > 300, "only {examined} records examined from the real capture");

    let found: BTreeSet<String> = hosts.keys().cloned().collect();
    assert_eq!(
        found, roster,
        "the estate observed on the wire differs from the documented management roster"
    );
}

#[test]
fn every_host_carries_the_evidence_that_justifies_it() {
    let Some((eve, _, segment)) = capture() else {
        return common::skip("every_host_carries_the_evidence_that_justifies_it");
    };
    let (hosts, _) = observe(&eve, &segment);
    assert!(!hosts.is_empty(), "no hosts observed, so this test would pass vacuously");
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
    let Some((eve, roster, segment)) = capture() else {
        return common::skip("the_real_management_segment_holds_no_unexpected_host");
    };
    let n = roster.len();
    let e = assess(&eve, &segment, &roster);
    assert!(
        e.unexpected.is_empty(),
        "an undocumented host is present on the management VLAN: {:?}",
        e.unexpected.iter().map(|h| (&h.addr, h.observations)).collect::<Vec<_>>()
    );
    assert!(e.missing.is_empty(), "documented but never seen: {:?}", e.missing);
    assert_eq!(e.accounted.len(), n);
    assert!(!e.needs_attention());
}

/// The capability this exists for, proven on real data: drop a host from the
/// roster and it must surface as the finding rather than blend in.
#[test]
fn a_rogue_host_on_the_real_segment_is_surfaced_and_leads() {
    let Some((eve, roster, segment)) = capture() else {
        return common::skip("a_rogue_host_on_the_real_segment_is_surfaced_and_leads");
    };
    // Whichever host sorts last — pretend it was never authorised here. Picking it from the
    // roster rather than naming one keeps the real addresses out of this file.
    let rogue = roster.iter().next_back().expect("a non-empty roster").clone();
    let mut reduced = roster.clone();
    reduced.remove(&rogue);

    let e = assess(&eve, &segment, &reduced);
    assert_eq!(e.unexpected.len(), 1);
    assert_eq!(e.unexpected[0].addr, rogue);
    assert!(
        e.unexpected[0].observations > 0,
        "the finding must carry the evidence a human will be asked to act on"
    );
    assert!(e.needs_attention());
    assert_eq!(e.accounted.len(), roster.len() - 1);
}

/// A neighbouring segment must not leak in. The sensor sees every VLAN, so
/// this is a live risk rather than a theoretical one — the same capture
/// contains other segments and public addresses.
#[test]
fn other_segments_in_the_same_capture_are_excluded() {
    let Some((eve, _, segment)) = capture() else {
        return common::skip("other_segments_in_the_same_capture_are_excluded");
    };
    let (hosts, _) = observe(&eve, &segment);
    for addr in hosts.keys() {
        assert!(addr.starts_with(&segment), "{addr} is not on the management segment");
    }
    // And the capture genuinely does contain off-segment ADDRESSES, so the filter is doing
    // work rather than passing vacuously. Counted per address, not per line: every line of this
    // capture mentions the management segment, because one endpoint of every flow is on it.
    let off = addresses_in(&eve).filter(|a| !a.starts_with(&segment)).count();
    assert!(off > 0, "the fixture contains no off-segment address, so this test proves nothing");
}

/// Every dotted quad in the text, found without a regex dependency: split on anything that
/// cannot appear in an IPv4 literal, then keep the pieces that actually parse as one.
fn addresses_in(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_ascii_digit() && c != '.')
        .filter(|t| t.parse::<std::net::Ipv4Addr>().is_ok())
        .map(str::to_string)
}
