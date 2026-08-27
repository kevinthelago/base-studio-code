//! The OWNERSHIP RULE — what a feature may depend on, checked over the `composes` edges both graphs
//! already hold (`core-may-not-depend-on-a-feature`).
//!
//! ## The rule, and the tiers it needs
//!
//! "Core may not depend on a feature" is the headline, and on its own it would be nearly vacuous —
//! both baselines were already clean when this was written. The rule that has teeth is the pair:
//!
//! 1. A **baseline** record may depend only on baseline records.
//! 2. A **feature** record may not depend on a *different* feature.
//!
//! Stating (2) honestly needs three tiers, because the measurements showed two kinds of record that
//! are not features and would otherwise fail it by construction:
//!
//! - [`BASELINE`] — `core`, `reference`. Usable anywhere, depends on nothing above itself. `reference`
//!   is library content (the classic algorithms) owned by no application feature.
//! - [`INFRASTRUCTURE`] — `shell`, `store`. These COMPOSE the application: the shell mounts every
//!   feature, and the Zustand store composes their slices. Depending on a feature is their job, and
//!   every feature depends on them in turn. Measured: 20 `store -> planner`, 10 `store -> shell`.
//! - [`SHARED_DOMAIN`] — `planner`. The plan MODEL, and the codebase already treats it as shared:
//!   CLAUDE.md records that `features/planner/` is domain-only and that "eleven modules outside the
//!   feature import through it". Measured: 8 `glance -> planner` edges, every one of them that
//!   sanctioned import. Naming it a tier is describing what is already true; leaving it out would mean
//!   allow-listing those eight one at a time.
//!
//! Everything else is a feature.
//!
//! ## Registrars are exempt STRUCTURALLY, not by allow-list
//!
//! A `*-graph-platform.ts` is a feature's module-REGISTRATION point: its whole job is naming modules
//! across the app so the runtime loader can resolve them. Seven of the eighteen cross-feature edges
//! come from these. They are exempt by shape rather than by name, because listing them individually
//! would grow with every feature and say nothing — the exemption is about what the record IS.
//!
//! ## THIS IS A WRITE SCOPE, NOT A READ PARTITION
//!
//! The rule constrains what a record may DEPEND ON. It never constrains what may be listed, queried or
//! rendered: `--feature` narrows a listing, and the graph still draws every edge, including the ones
//! this module reports. Measured at the split, 577 of 927 component edges point at the baseline — a
//! filter that hid them would misrepresent the library rather than scope it, and would rebuild the
//! silo epic #3114 removed. If a future change makes this a filter, that is the regression.

/// Tiers that may be depended on by anything, and may depend only on each other.
pub const BASELINE: [&str; 2] = ["core", "reference"];

/// Tiers whose job is composing the application — they may depend on anything, and anything may
/// depend on them.
pub const INFRASTRUCTURE: [&str; 2] = ["shell", "store"];

/// Shared domains: a feature's records that the codebase deliberately publishes to other features.
///
/// Kept deliberately SHORT. Every entry is a standing decision that some feature's internals are
/// public, and the cost of a wrong one is that a real violation stops being reported.
pub const SHARED_DOMAIN: [&str; 1] = ["planner"];

/// One edge that breaks the rule.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Violation {
    pub from_feature: String,
    pub from_id: String,
    pub to_feature: String,
    pub to_id: String,
    /// Which half of the rule it breaks, for the failure message.
    pub kind: ViolationKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ViolationKind {
    /// A baseline record depends on something above it. The rule's headline.
    BaselineDependsOnFeature,
    /// A feature depends on a different feature.
    FeatureDependsOnFeature,
}

impl Violation {
    /// The failure line — NAMES BOTH ENDS, because "there is a violation" is not actionable and the
    /// first thing anyone does with such a failure is go looking for which record it meant.
    pub fn describe(&self) -> String {
        let why = match self.kind {
            ViolationKind::BaselineDependsOnFeature =>
                "a BASELINE record may depend only on baseline — move it out of the baseline, or move what it needs in",
            ViolationKind::FeatureDependsOnFeature =>
                "a feature may not depend on another feature — move the shared part to `core`, or record the edge in ALLOWED with why",
        };
        format!("{}/{} -> {}/{}: {why}", self.from_feature, self.from_id, self.to_feature, self.to_id)
    }
}

fn is(list: &[&str], f: &str) -> bool {
    list.contains(&f)
}

/// A record's module-registration point, exempt by shape.
///
/// `*-graph-platform.ts` (and the `graphPlatform` component) exists to name modules across the app for
/// the runtime loader. Composing across features is what it is FOR.
pub fn is_registrar(id: &str) -> bool {
    id.ends_with("graph-platform.ts") || id.ends_with("graphPlatform.ts") || id == "graphplatform"
}

/// Check one graph's edges. `edges` is `(from_id, from_feature, to_id, to_feature)`, already resolved —
/// the caller owns how a `composes` entry maps to a record, because the two graphs address them
/// differently (algorithms by id, components by name).
///
/// `allowed` is the adjudicated exception list, as `"from_id -> to_id"`. Entries are matched exactly so
/// a stale one cannot silently cover a different edge.
pub fn violations(
    edges: &[(String, String, String, String)],
    allowed: &[&str],
) -> Vec<Violation> {
    let mut out: Vec<Violation> = Vec::new();
    for (from_id, from_f, to_id, to_f) in edges {
        if from_f.is_empty() || to_f.is_empty() || from_f == to_f {
            continue; // unplaced ends say nothing; same-feature use is not a crossing
        }
        if is(&INFRASTRUCTURE, from_f) || is(&INFRASTRUCTURE, to_f) {
            continue; // composition tiers, both directions
        }
        if is(&BASELINE, to_f) {
            continue; // depending on the baseline is the encouraged case
        }
        if is_registrar(from_id) {
            continue; // a registrar composes across features by construction
        }
        if allowed.iter().any(|a| *a == format!("{from_id} -> {to_id}")) {
            continue;
        }
        let kind = if is(&BASELINE, from_f) {
            ViolationKind::BaselineDependsOnFeature
        } else if is(&SHARED_DOMAIN, to_f) {
            continue; // a shared domain is published to features on purpose
        } else {
            ViolationKind::FeatureDependsOnFeature
        };
        out.push(Violation {
            from_feature: from_f.clone(),
            from_id: from_id.clone(),
            to_feature: to_f.clone(),
            to_id: to_id.clone(),
            kind,
        });
    }
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(fi: &str, ff: &str, ti: &str, tf: &str) -> (String, String, String, String) {
        (fi.into(), ff.into(), ti.into(), tf.into())
    }

    #[test]
    fn the_headline_rule_the_baseline_may_not_depend_on_a_feature() {
        let v = violations(&[e("util.ts", "core", "plan.ts", "planner")], &[]);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].kind, ViolationKind::BaselineDependsOnFeature);
        // The message names BOTH ends — "there is a violation" sends the reader hunting.
        assert!(v[0].describe().contains("core/util.ts -> planner/plan.ts"), "{}", v[0].describe());
    }

    #[test]
    fn a_feature_may_not_depend_on_a_different_feature() {
        let v = violations(&[e("a.ts", "glance", "b.ts", "logs")], &[]);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].kind, ViolationKind::FeatureDependsOnFeature);
    }

    #[test]
    fn depending_on_the_baseline_is_the_encouraged_case() {
        // 577 of 927 component edges point at the baseline. If this ever failed, the rule would be
        // telling the library not to be a library.
        for base in BASELINE {
            assert!(violations(&[e("a.ts", "glance", "u.ts", base)], &[]).is_empty(), "{base}");
        }
    }

    #[test]
    fn infrastructure_composes_features_and_features_depend_on_it_both_ways_legal() {
        // Measured: 20 `store -> planner`, 10 `store -> shell`. Composing feature slices is the store's
        // job and mounting features is the shell's; a rule that failed those would be describing a
        // different application.
        for infra in INFRASTRUCTURE {
            assert!(violations(&[e("s.ts", infra, "p.ts", "planner")], &[]).is_empty(), "{infra} ->");
            assert!(violations(&[e("p.ts", "planner", "s.ts", infra)], &[]).is_empty(), "-> {infra}");
        }
    }

    #[test]
    fn a_shared_domain_may_be_depended_on_by_a_feature() {
        // CLAUDE.md: `features/planner/` is domain-only and "eleven modules outside the feature import
        // through it". Measured: 8 `glance -> planner`. Naming the tier describes what is already true.
        assert!(violations(&[e("g.ts", "glance", "plan.ts", "planner")], &[]).is_empty());
    }

    #[test]
    fn but_a_shared_domain_is_still_a_feature_when_it_depends_outward() {
        // Being published does not make it a baseline. `planner -> logs` is still a crossing.
        let v = violations(&[e("p.ts", "planner", "l.ts", "logs")], &[]);
        assert_eq!(v.len(), 1, "a shared domain may be depended ON, not depend outward freely");
    }

    #[test]
    fn a_registrar_is_exempt_by_shape_not_by_name() {
        // 7 of 18 cross-feature edges come from these. Listing them would grow with every feature and
        // say nothing — the exemption is about what the record IS.
        assert!(violations(&[e("glance-graph-platform.ts", "glance", "d.ts", "designs")], &[]).is_empty());
        assert!(is_registrar("algorithms-graph-platform.ts"));
        assert!(!is_registrar("glance-index.ts"), "an ordinary module is not a registrar");
    }

    #[test]
    fn an_allowed_edge_is_matched_exactly_so_a_stale_entry_cannot_cover_a_different_one() {
        let edge = e("p.ts", "planner", "l.ts", "logs");
        assert!(violations(std::slice::from_ref(&edge), &["p.ts -> l.ts"]).is_empty());
        // A near-miss must NOT be covered — an allow-list that matched loosely would hide the next
        // real violation behind a decision made about a different edge.
        assert_eq!(violations(&[edge], &["p.ts -> other.ts"]).len(), 1);
    }

    #[test]
    fn an_unplaced_end_is_not_a_violation() {
        // Placement is a separate question; reporting an unplaced record here would blame the wrong
        // thing and the failure would say nothing about what to do.
        assert!(violations(&[e("a.ts", "", "b.ts", "logs")], &[]).is_empty());
        assert!(violations(&[e("a.ts", "glance", "b.ts", "")], &[]).is_empty());
    }

    #[test]
    fn same_feature_use_is_never_a_crossing() {
        assert!(violations(&[e("a.ts", "glance", "b.ts", "glance")], &[]).is_empty());
    }

    #[test]
    fn the_report_is_sorted_and_deduped_so_two_runs_can_be_diffed() {
        let edges = vec![e("z.ts", "glance", "a.ts", "logs"), e("a.ts", "teams", "b.ts", "mcp"), e("z.ts", "glance", "a.ts", "logs")];
        let v = violations(&edges, &[]);
        assert_eq!(v.len(), 2, "the duplicate collapsed");
        assert!(v[0] <= v[1], "sorted, so a diff between runs is meaningful");
    }
}
