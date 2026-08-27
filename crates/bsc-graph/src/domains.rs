//! `domain`, measured — grouping, fan-in, and what the baseline is missing.
//!
//! ## READ THIS BEFORE TREATING `domain` AS THE FEATURE AXIS — IT IS NOT ONE
//!
//! `epic-the-graphs-are-split-by-feature-over-a-core` was written on the premise that the algorithms
//! library already carried the feature axis, because its `domain` values *look* feature-shaped
//! (`planner`, `glance`, `fleet`, `core`, …). That premise is wrong, and this module is where it was
//! caught.
//!
//! `domain` is the CURATED CROSS-LANGUAGE COLLECTION facet (#3120), and it is deliberately PARTIAL:
//! `logistics` is the graph-traversal/pathfinding set, `graphics` the in-place matrix transforms,
//! `signal-processing` is `fft.rs`. `the_packaged_seed_carries_domain_collections` pins the exclusions
//! on purpose — general-purpose sorts and searches stay UNTAGGED "so a domain collection never
//! surfaces an unrelated algorithm", and "primitives are language built-ins, never domain members".
//!
//! So the field already carries two readings at once: subsystem tags applied by directory harvest
//! (the large values), and hand-curated topical collections (the small classical ones). A feature axis
//! is a third thing, and it must be TOTAL — every record placed — which is exactly what the collection
//! facet must not be.
//!
//! This module therefore measures `domain` AS IT IS. It does not assert that `domain` means feature,
//! and nothing here should be used to backfill it as one.
//!
//! ## What it measures, and why fan-in
//!
//! The numbers that motivated the epic still stand and are still worth having:
//!
//! | | components (`domain` = feature) | algorithms (`domain` = collection) |
//! |---|---|---|
//! | records | 448 | 670 |
//! | in `core` | 152 (34%) | 24 (3.6%) |
//! | edges crossing a group | 6 | 115 |
//!
//! FOREIGN-DOMAIN FAN-IN is the discriminator: how many *different* domains compose a record. A record
//! pulled in by seven is shared infrastructure whatever folder it lives in; one pulled in by one is
//! that group's own business however often it is used. Raw usage counts cannot tell those apart.
//!
//! Fan-in RANKS candidates; it never promotes one. "Many groups use it" is evidence, not a decision —
//! a record can be widely used and still be one feature's concern that others reach into wrongly,
//! which is the finding worth keeping rather than sweeping away.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// The baseline domain — the tier everything may depend on. Same word the component graph uses for its
/// feature baseline, and on THIS graph one collection value among 35 rather than a defined tier. Named
/// here because the report has to classify edges into it; naming it is not a claim that it is total.
pub const CORE: &str = "core";

/// One record's fan-in: how many DISTINCT foreign domains compose it, and which.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    /// The domain it is in today. Empty when it has none — and on this graph that is the NORMAL state
    /// for a primitive or a general-purpose algorithm, which the collection facet excludes on purpose.
    pub domain: String,
    /// The distinct OTHER domains that compose it, sorted. Its own domain never appears.
    pub from: Vec<String>,
}

/// The whole report, in one pass over the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub total: usize,
    /// Records per domain, `""` for the domain-less.
    pub by_domain: BTreeMap<String, usize>,
    /// Ids carrying no domain. NOT a defect list: the collection facet is partial by design, so this is
    /// "what no curated collection claims", which is most of the library.
    pub domainless: Vec<String>,
    /// `composes` edges whose two ends sit in different, non-empty domains.
    pub cross_domain_edges: usize,
    /// Edges pointing INTO the baseline — the legal, encouraged shape, reported so the cross-domain
    /// count is read against something rather than in isolation.
    pub edges_into_core: usize,
    /// Records ranked by foreign-domain fan-in, highest first, ties broken by id so the report is
    /// stable enough to diff between runs.
    pub candidates: Vec<Candidate>,
}

fn field<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("").trim()
}

/// Measure the `domain` facet over a set of implementation records — grouping, fan-in, edge classes.
///
/// Takes the records rather than loading them so the whole analysis is testable without a store — the
/// numbers this produces are the argument for moving records around, and an untestable argument is
/// one nobody can check.
///
/// An edge naming an id the store does not hold is IGNORED rather than counted as cross-domain: a
/// dangling `composes` entry is a different defect (`bsc graph doctor`'s), and folding it in here
/// would inflate the very number this exists to drive down.
pub fn measure(impls: &[Value]) -> Report {
    let domain_of: BTreeMap<&str, &str> =
        impls.iter().map(|im| (field(im, "id"), field(im, "domain"))).collect();

    let mut by_domain: BTreeMap<String, usize> = BTreeMap::new();
    let mut domainless: Vec<String> = Vec::new();
    let mut foreign: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    let (mut cross, mut into_core) = (0usize, 0usize);

    for im in impls {
        let id = field(im, "id");
        let dom = field(im, "domain");
        *by_domain.entry(dom.to_string()).or_default() += 1;
        if dom.is_empty() && !id.is_empty() {
            domainless.push(id.to_string());
        }
        let Some(edges) = im.get("composes").and_then(Value::as_array) else { continue };
        for t in edges.iter().filter_map(Value::as_str) {
            // A `composes` naming an id the store does not hold is `bsc graph doctor`'s finding, not
            // this one's — ignored so a dangling edge cannot inflate the number this drives down.
            let Some(&target) = domain_of.get(t) else { continue };
            if dom.is_empty() || target == dom {
                continue;   // an unplaced COMPOSER says nothing; same-domain use is not sharing
            }

            // FAN-IN is recorded even when the TARGET is unplaced, and that is the whole point.
            //
            // Classifying an edge needs both ends; measuring who reaches for a record needs only the
            // caller's domain. Requiring both hid exactly the records that most needed placing: the
            // four most-composed records in the real library — `typescript.number`, `.string`,
            // `.array`, `.map`, each pulled in by 6-7 domains — carry NO domain, so they were absent
            // from a ranking whose entire job is to say what belongs in the baseline.
            foreign.entry(t).or_default().insert(dom);

            // Classification still needs a placed target: an edge into an unplaced record is neither a
            // crossing nor a use of the baseline until someone decides which.
            if target.is_empty() {
                continue;
            }
            if target == CORE {
                into_core += 1;
            } else {
                cross += 1;
            }
        }
    }

    let mut candidates: Vec<Candidate> = foreign
        .into_iter()
        .map(|(id, from)| Candidate {
            id: id.to_string(),
            domain: domain_of.get(id).copied().unwrap_or("").to_string(),
            from: from.into_iter().map(str::to_owned).collect(),
        })
        .collect();
    candidates.sort_by(|a, b| b.from.len().cmp(&a.from.len()).then_with(|| a.id.cmp(&b.id)));

    domainless.sort();
    Report { total: impls.len(), by_domain, domainless, cross_domain_edges: cross, edges_into_core: into_core, candidates }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn im(id: &str, domain: &str, composes: &[&str]) -> Value {
        serde_json::json!({ "id": id, "domain": domain, "composes": composes })
    }

    #[test]
    fn ranks_by_how_many_domains_reach_in_not_by_how_often() {
        // THE MEASUREMENT THAT MATTERS. `shared` is composed twice, both times from ONE other domain;
        // `spread` is composed twice from TWO. Raw usage would tie them; fan-in separates them, and
        // `spread` is the one that is actually shared infrastructure.
        let r = measure(&[
            im("shared", "a", &[]),
            im("spread", "a", &[]),
            im("b1", "b", &["shared", "spread"]),
            im("b2", "b", &["shared"]),
            im("c1", "c", &["spread"]),
        ]);
        assert_eq!(r.candidates[0].id, "spread");
        assert_eq!(r.candidates[0].from, vec!["b", "c"]);
        assert_eq!(r.candidates[1].id, "shared");
        assert_eq!(r.candidates[1].from, vec!["b"]);
    }

    #[test]
    fn a_records_own_domain_is_never_foreign_to_it() {
        let r = measure(&[im("x", "a", &[]), im("y", "a", &["x"])]);
        assert!(r.candidates.is_empty(), "same-domain use is not evidence of sharing");
        assert_eq!(r.cross_domain_edges, 0);
    }

    #[test]
    fn an_edge_into_core_is_counted_separately_and_never_as_a_crossing() {
        // The legal, encouraged shape. Folding it into the cross-domain count would make the number
        // this report exists to drive down go UP as the baseline grows, which is backwards.
        let r = measure(&[im("util", CORE, &[]), im("f", "feature", &["util"])]);
        assert_eq!(r.edges_into_core, 1);
        assert_eq!(r.cross_domain_edges, 0);
    }

    #[test]
    fn a_domainless_record_is_listed_and_its_edges_are_not_classified() {
        // It surfaces as an owed decision rather than being treated as a domain called "".
        let r = measure(&[im("nodomain", "", &[]), im("f", "feature", &["nodomain"])]);
        assert_eq!(r.domainless, vec!["nodomain"]);
        assert_eq!(r.cross_domain_edges, 0, "an unplaced end cannot make an edge a crossing");
        assert_eq!(r.edges_into_core, 0, "nor a use of the baseline");
        assert_eq!(r.by_domain[""], 1);
    }

    #[test]
    fn a_domainless_record_is_still_ranked_because_the_callers_are_placed() {
        // FOUND BY RUNNING IT. The first version required both ends placed before recording fan-in,
        // which silently hid the four most-composed records in the real library — `typescript.number`,
        // `.string`, `.array`, `.map`, each pulled in by 6-7 domains and each carrying no domain. A
        // ranking whose job is "what belongs in the baseline" that cannot see the strongest candidates
        // is worse than none: it looks complete.
        //
        // Classifying an EDGE needs both ends. Measuring who reaches for a RECORD needs only the
        // caller's domain, and that is always known here.
        let r = measure(&[
            im("unplaced", "", &[]),
            im("a1", "a", &["unplaced"]),
            im("b1", "b", &["unplaced"]),
            im("c1", "c", &["unplaced"]),
        ]);
        assert_eq!(r.candidates.len(), 1);
        assert_eq!(r.candidates[0].id, "unplaced");
        assert_eq!(r.candidates[0].domain, "", "still unplaced — the ranking does not place it");
        assert_eq!(r.candidates[0].from, vec!["a", "b", "c"], "three domains reach for it");
        assert_eq!(r.cross_domain_edges, 0, "and none of those edges is classified yet");
    }

    #[test]
    fn a_dangling_compose_is_ignored_rather_than_counted() {
        // A `composes` naming an id the store does not hold is `bsc graph doctor`'s finding. Counting
        // it here would inflate exactly the number this report exists to reduce.
        let r = measure(&[im("f", "feature", &["ghost"])]);
        assert_eq!(r.cross_domain_edges, 0);
        assert!(r.candidates.is_empty());
    }

    #[test]
    fn counts_every_record_by_domain_including_the_unplaced() {
        let r = measure(&[im("a", "x", &[]), im("b", "x", &[]), im("c", "", &[])]);
        assert_eq!(r.total, 3);
        assert_eq!(r.by_domain["x"], 2);
        assert_eq!(r.by_domain[""], 1);
    }

    #[test]
    fn the_ranking_is_stable_so_two_runs_can_be_diffed() {
        let recs =
            [im("p", "a", &[]), im("q", "a", &[]), im("b", "b", &["p", "q"]), im("c", "c", &["p", "q"])];
        let first = measure(&recs);
        let second = measure(&recs);
        assert_eq!(first.candidates, second.candidates);
        // Equal fan-in ⇒ id order, so a re-run does not reshuffle the report.
        assert_eq!(first.candidates.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["p", "q"]);
    }
}
