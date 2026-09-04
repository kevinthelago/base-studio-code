//! What is actually on a segment, derived from what the sensor saw.
//!
//! ## Why observation rather than a roster
//!
//! Configuration cannot be simplified across systems that cannot be reliably
//! enumerated, and every roster in this project is hand-maintained and has
//! drifted — the operator documentation was measured stale in specific,
//! load-bearing places. The sensor sees every host on every VLAN through the
//! SPAN, which makes it the one authority that cannot go stale by neglect.
//!
//! ## The third category is the one that matters
//!
//! A host that is expected and seen is unremarkable. A host that is expected
//! and **not** seen may be retired, powered off, or quietly broken. A host
//! that is **seen and not expected** on the management VLAN is a security
//! finding — the shape of an unauthorised device, a forgotten test box, or a
//! compromise — and it is precisely what a hand-maintained roster can never
//! surface, because the roster is the thing that would have had to be updated.
//!
//! So the three are kept distinct and the unexpected one leads.

use std::collections::{BTreeMap, BTreeSet};

/// One host the sensor observed, with the evidence for it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SeenHost {
    pub addr: String,
    /// How many EVE records mentioned it. A host seen twice and a host seen
    /// ten thousand times are different claims, and a reader should be able to
    /// tell them apart rather than see an undifferentiated address.
    pub observations: u64,
    /// Ports it was observed on, as either endpoint.
    pub ports: BTreeSet<u16>,
}

/// What the segment looks like, against what was expected.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct Estate {
    /// Seen and not expected. THE security finding, and the reason this exists.
    pub unexpected: Vec<SeenHost>,
    /// Expected and seen.
    pub accounted: Vec<SeenHost>,
    /// Expected and never seen: retired, off, or broken — a different problem
    /// from an unexpected host, and reported separately for that reason.
    pub missing: Vec<String>,
    /// EVE records examined. A conclusion drawn from zero records is not a
    /// clean segment, and carrying the count is what lets a reader tell those
    /// two apart.
    pub records_examined: u64,
}

impl Estate {
    /// Whether anything here warrants a human. An unexpected host on the
    /// management VLAN always does.
    pub fn needs_attention(&self) -> bool {
        !self.unexpected.is_empty()
    }
}

/// Whether `addr` falls inside a dotted-quad `/24` prefix such as `10.99.2.`.
///
/// Deliberately a prefix match on the first three octets rather than CIDR
/// arithmetic: every segment in this network is a /24, and a string prefix
/// cannot silently mis-mask the way a hand-rolled netmask can.
///
/// The trailing-digit check is NOT what stops `10.99.2.` matching
/// `192.168.20.5` — an earlier comment here claimed that and it was wrong, as
/// a bite test showed by failing to go red. `starts_with` already rejects that
/// case, because the prefix's final `.` meets a `0`. What the check actually
/// does is reject a remainder that is not purely a host number, such as
/// `10.99.2.1%eth0` or a truncated `10.99.2.1abc` in malformed input —
/// narrower than advertised, and kept because it is free.
fn in_segment(addr: &str, prefix: &str) -> bool {
    addr.starts_with(prefix) && addr[prefix.len()..].chars().all(|c| c.is_ascii_digit())
}

/// Extract hosts on `prefix` from EVE output.
///
/// Pure text in, structure out. Lines that are not JSON are skipped — an EVE
/// file legitimately interleaves records this sensor does not forward — but
/// the count of records actually examined is returned so a caller can tell
/// "nothing on this segment" from "nothing parsed at all".
pub fn observe(eve: &str, prefix: &str) -> (BTreeMap<String, SeenHost>, u64) {
    let mut hosts: BTreeMap<String, SeenHost> = BTreeMap::new();
    let mut examined = 0u64;

    for line in eve.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        examined += 1;

        for (addr_key, port_key) in [("src_ip", "src_port"), ("dest_ip", "dest_port")] {
            let Some(addr) = v.get(addr_key).and_then(|x| x.as_str()) else {
                continue;
            };
            if !in_segment(addr, prefix) {
                continue;
            }
            let e = hosts.entry(addr.to_string()).or_insert_with(|| SeenHost {
                addr: addr.to_string(),
                observations: 0,
                ports: BTreeSet::new(),
            });
            e.observations += 1;
            if let Some(p) = v.get(port_key).and_then(|x| x.as_u64()) {
                if let Ok(p) = u16::try_from(p) {
                    e.ports.insert(p);
                }
            }
        }
    }
    (hosts, examined)
}

/// Compare what was observed against what was expected.
pub fn assess(eve: &str, prefix: &str, expected: &BTreeSet<String>) -> Estate {
    let (hosts, records_examined) = observe(eve, prefix);

    let mut unexpected = Vec::new();
    let mut accounted = Vec::new();
    for (addr, h) in &hosts {
        if expected.contains(addr) {
            accounted.push(h.clone());
        } else {
            unexpected.push(h.clone());
        }
    }
    // Loudest first: most-observed unexpected host at the top, since a device
    // that talks constantly is a more urgent question than one seen once.
    unexpected.sort_by(|a, b| b.observations.cmp(&a.observations).then(a.addr.cmp(&b.addr)));

    let missing = expected
        .iter()
        .filter(|a| !hosts.contains_key(*a) && in_segment(a, prefix))
        .cloned()
        .collect();

    Estate { unexpected, accounted, missing, records_examined }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expected(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    const LINE: &str = r#"{"event_type":"flow","src_ip":"10.99.2.104","src_port":50000,"dest_ip":"10.99.2.1","dest_port":53,"proto":"UDP","flow":{}}"#;

    #[test]
    fn hosts_are_extracted_with_the_evidence_for_them() {
        let (h, examined) = observe(LINE, "10.99.2.");
        assert_eq!(examined, 1);
        assert_eq!(h.len(), 2);
        assert_eq!(h["10.99.2.1"].ports.iter().copied().collect::<Vec<_>>(), vec![53]);
        assert_eq!(h["10.99.2.104"].observations, 1);
    }

    #[test]
    fn a_neighbouring_segment_is_not_matched() {
        assert!(in_segment("10.99.2.104", "10.99.2."));
        // Rejected by the prefix itself: the final `.` meets a `0`.
        assert!(!in_segment("192.168.20.5", "10.99.2."));
        assert!(!in_segment("10.99.5.10", "10.99.2."));
    }

    /// What the trailing-digit check ACTUALLY guards — narrower than the
    /// original comment claimed, and pinned so the claim now matches the code.
    #[test]
    fn a_remainder_that_is_not_a_host_number_is_rejected() {
        assert!(!in_segment("10.99.2.1%eth0", "10.99.2."));
        assert!(!in_segment("10.99.2.1abc", "10.99.2."));
        assert!(!in_segment("10.99.2.1:5000", "10.99.2."));
        assert!(in_segment("10.99.2.1", "10.99.2."));
    }

    #[test]
    fn a_host_seen_but_not_expected_is_the_finding_and_leads_the_output() {
        let e = assess(LINE, "10.99.2.", &expected(&["10.99.2.1"]));
        assert_eq!(e.unexpected.len(), 1);
        assert_eq!(e.unexpected[0].addr, "10.99.2.104");
        assert_eq!(e.accounted.len(), 1);
        assert!(e.needs_attention(), "an unexpected host on MGMT must want a human");
    }

    #[test]
    fn expected_but_unseen_is_a_different_category_from_unexpected() {
        // Retired, powered off and unauthorised are different problems and
        // must not be collapsed into one list.
        let e = assess(LINE, "10.99.2.", &expected(&["10.99.2.1", "10.99.2.104", "10.99.2.250"]));
        assert_eq!(e.missing, vec!["10.99.2.250".to_string()]);
        assert!(e.unexpected.is_empty());
        assert!(!e.needs_attention(), "a merely absent host is not a security finding");
    }

    #[test]
    fn the_loudest_unexpected_host_is_listed_first() {
        let many = std::iter::repeat_n(LINE, 5).collect::<Vec<_>>().join("\n");
        let quiet = r#"{"event_type":"flow","src_ip":"10.99.2.77","src_port":1,"dest_ip":"8.8.8.8","dest_port":53,"flow":{}}"#;
        let e = assess(&format!("{many}\n{quiet}"), "10.99.2.", &expected(&[]));
        assert_eq!(e.unexpected[0].addr, "10.99.2.1", "a constant talker outranks a one-off");
        assert!(e.unexpected.iter().any(|h| h.addr == "10.99.2.77"));
    }

    #[test]
    fn nothing_parsed_is_not_a_clean_segment() {
        // The failure this whole project keeps guarding against: a reader must
        // be able to tell "no hosts here" from "I read nothing at all".
        let e = assess("{not json\nalso not json", "10.99.2.", &expected(&[]));
        assert_eq!(e.records_examined, 0);
        assert!(e.accounted.is_empty() && e.unexpected.is_empty());

        let real = assess(LINE, "10.99.2.", &expected(&[]));
        assert_eq!(real.records_examined, 1);
        assert_ne!(
            real.records_examined, e.records_examined,
            "a real read and an unreadable one must not produce the same evidence count"
        );
    }
}
