//! A PATTERN — the library's structural conventions, given an id
//! (#a-pattern-has-no-id-so-the-only-way-to-author-a-sibling-is-to-copy-one).
//!
//! `bsc ui patterns` finds the conventions a kit already has, but a cluster is a REPORT: recomputed
//! every sweep, with nothing to point at. So the only way to author into an existing convention is to
//! find a sibling and copy it — which is how the convention drifts, and how a fifth copy gets written
//! by a session that believed it was writing a first.
//!
//! An id changes the request. "Author a telemetry settings card" becomes "add a member to
//! `settings-toggle-card`", and a pattern you are instantiating is not one you can duplicate. That is
//! the difference between removing the OPPORTUNITY and catching the ACT: a write-time warning still
//! produces the duplicate whenever it is ignored.
//!
//! ## Two ways a pattern comes to exist, and why conformance differs between them
//!
//! A pattern is either **derived** — promoted from a cluster `bsc ui patterns` found, so real members
//! define it — or **declared** by an author up front, before any member exists. The record says which
//! (`signatureSource`), because the two cannot be told apart afterwards and they are tested differently:
//!
//! - **derived** ⇒ a record conforms when it SCORES at or above the pattern's threshold against any
//!   exemplar, using the same shape measure the sweep clustered on. Tight, and consistent with how the
//!   pattern was found in the first place.
//! - **declared** ⇒ there is nothing to score against, so a record conforms when it CONTAINS the
//!   declared signature: every named `composes` entry and every named skeleton tag is present. This is
//!   looser — anything composing `Card` + `ToggleRow` matches a signature naming only those two — and
//!   that looseness is the honest price of naming a convention before it has members. [`Conformance`]
//!   carries `basis` so a caller is never guessing which test produced the answer.
//!
//! A derived pattern that loses its exemplars (all merged away, say) falls back to containment rather
//! than reporting an empty library, and says so through the same field.
//!
//! ## Membership is computed, never stored
//!
//! A frozen member list is wrong the moment anything is authored — which is exactly when the question
//! is being asked. So a pattern record stores its `exemplars` (the evidence it was promoted from) and
//! nothing else about membership; [`conforming`] recomputes against the live store on every read.

use serde_json::Value;
use std::collections::BTreeSet;

/// Which test decided membership — see the module docs. Reported, never inferred by the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Basis {
    /// Scored against the pattern's exemplars with the shape measure.
    Exemplar,
    /// Matched by containment of a declared signature — looser, and only when there is nothing to score.
    Signature,
}

impl Basis {
    pub fn as_str(self) -> &'static str {
        match self {
            // NOT "exemplar"/"signature": a member row also carries an `exemplar` FLAG, and
            // `basis: "exemplar"` on a row whose flag is false reads as a contradiction. These name
            // the TEST that was applied, which is the thing a caller needs to know.
            Basis::Exemplar => "scored",
            Basis::Signature => "containment",
        }
    }
}

/// One record's membership verdict.
#[derive(Debug, Clone)]
pub struct Conformance {
    pub id: String,
    pub name: String,
    pub kit: String,
    /// The shape score against the best-matching exemplar, when the basis is [`Basis::Exemplar`].
    pub score: Option<f64>,
    pub basis: Basis,
    /// Whether this record is one of the pattern's own exemplars.
    pub exemplar: bool,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn set_of(v: &Value, path: &[&str]) -> BTreeSet<String> {
    let mut cur = v;
    for p in path {
        match cur.get(p) {
            Some(next) => cur = next,
            None => return BTreeSet::new(),
        }
    }
    cur.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(str::to_string).collect())
        .unwrap_or_default()
}

/// The default bar a promoted pattern inherits — the same one `bsc ui patterns` clusters at, so a
/// pattern's members are the cluster it was promoted from rather than a differently-drawn set.
pub const DEFAULT_CONFORMANCE: f64 = 0.90;

/// Build a pattern record from a cluster: `id` + the members that define it.
///
/// The signature is the INTERSECTION across the members — what every one of them has — which is the
/// same thing `shape_clusters` reports and the only description that is true of all of them.
pub fn derive(id: &str, name: &str, members: &[Value], threshold: f64) -> Value {
    let mut composes: Option<BTreeSet<String>> = None;
    let mut skeleton: Option<BTreeSet<String>> = None;
    for m in members {
        let sig = crate::similarity::shape_signature(m);
        let (c, k) = (set_of(&sig, &["composes"]), set_of(&sig, &["skeleton"]));
        composes = Some(composes.map_or(c.clone(), |acc: BTreeSet<String>| acc.intersection(&c).cloned().collect()));
        skeleton = Some(skeleton.map_or(k.clone(), |acc: BTreeSet<String>| acc.intersection(&k).cloned().collect()));
    }
    let kits: BTreeSet<String> = members.iter().map(|m| s(m, "kitId")).filter(|k| !k.is_empty()).collect();
    serde_json::json!({
        "id": id,
        "name": name,
        "signatureSource": "derived",
        "threshold": threshold,
        "signature": {
            "composes": composes.unwrap_or_default().into_iter().collect::<Vec<_>>(),
            "skeleton": skeleton.unwrap_or_default().into_iter().collect::<Vec<_>>(),
        },
        "exemplars": members.iter().map(|m| s(m, "id")).filter(|i| !i.is_empty()).collect::<Vec<_>>(),
        "kits": kits.into_iter().collect::<Vec<_>>(),
    })
}

/// Every LIVE record conforming to `pattern`, best-matching first.
///
/// Suppressed records never appear — a tombstone keeps its id and drops its content, so it would match
/// a declared signature vacuously and score as unknown against an exemplar. Consistent with the rest of
/// the similarity surface.
pub fn conforming(pattern: &Value, components: &[Value], live_only: bool) -> Vec<Conformance> {
    let threshold = pattern.get("threshold").and_then(Value::as_f64).unwrap_or(DEFAULT_CONFORMANCE);
    let exemplar_ids: BTreeSet<String> = set_of(pattern, &["exemplars"]);
    let exemplars: Vec<&Value> = components
        .iter()
        .filter(|c| exemplar_ids.contains(&s(c, "id")))
        .collect();
    let want_composes = set_of(pattern, &["signature", "composes"]);
    let want_skeleton = set_of(pattern, &["signature", "skeleton"]);

    let mut out: Vec<Conformance> = Vec::new();
    for c in components {
        let id = s(c, "id");
        if id.is_empty() {
            continue;
        }
        if live_only && c.get("suppressed").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        // Score against the exemplars when there are any — the same measure the cluster was drawn with.
        let best = exemplars
            .iter()
            .filter(|e| s(e, "id") != id)
            .filter_map(|e| crate::similarity::shape_score(c, e))
            .fold(None::<f64>, |acc, v| Some(acc.map_or(v, |a: f64| a.max(v))));
        let is_exemplar = exemplar_ids.contains(&id);
        if !exemplars.is_empty() {
            if is_exemplar || best.is_some_and(|b| b >= threshold) {
                out.push(Conformance { id, name: s(c, "name"), kit: s(c, "kitId"), score: best, basis: Basis::Exemplar, exemplar: is_exemplar });
            }
            continue;
        }
        // Nothing to score against — a declared pattern, or a derived one whose exemplars are gone.
        // Containment of the signature is the fallback, and it is LOOSER; the basis says so.
        let sig = crate::similarity::shape_signature(c);
        let (have_c, have_k) = (set_of(&sig, &["composes"]), set_of(&sig, &["skeleton"]));
        if want_composes.is_empty() && want_skeleton.is_empty() {
            continue; // a signature naming nothing would match every record in the library
        }
        if want_composes.is_subset(&have_c) && want_skeleton.is_subset(&have_k) {
            out.push(Conformance { id, name: s(c, "name"), kit: s(c, "kitId"), score: None, basis: Basis::Signature, exemplar: is_exemplar });
        }
    }
    out.sort_by(|a, b| {
        b.exemplar
            .cmp(&a.exemplar)
            .then_with(|| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn card(id: &str, name: &str, extra_tag: &str) -> Value {
        json!({
            "id": id, "name": name, "kitId": "k", "role": "composite", "composes": ["Card", "ToggleRow"],
            "srcText": format!("export const {name} = () => <Card title=\"x\"><ToggleRow on={{a}} onToggle={{b}} title=\"t\"/>{extra_tag}</Card>;"),
        })
    }

    #[test]
    fn a_derived_pattern_carries_what_every_member_shares() {
        let members = vec![card("a", "AlphaCard", ""), card("b", "BetaCard", ""), card("c", "GammaCard", "<Hint/>")];
        let p = derive("settings-toggle-card", "Settings toggle card", &members, 0.9);
        assert_eq!(p["signatureSource"], "derived");
        let sig = &p["signature"];
        let strs = |v: &Value| v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(strs(&sig["composes"]), vec!["card", "togglerow"]);
        // `<Hint/>` is on ONE member, so it is not part of what the pattern IS.
        assert!(!strs(&sig["skeleton"]).iter().any(|x| x.starts_with("hint")), "{sig:?}");
        assert!(strs(&sig["skeleton"]).iter().any(|x| x.starts_with("togglerow(")), "{sig:?}");
        assert_eq!(strs(&p["exemplars"]), vec!["a", "b", "c"]);
    }

    #[test]
    fn a_new_sibling_conforms_without_the_pattern_being_rewritten() {
        // The whole point: membership is COMPUTED. A record authored after the pattern was promoted is
        // a member immediately, with no edit to the pattern record.
        let members = vec![card("a", "AlphaCard", ""), card("b", "BetaCard", "")];
        let p = derive("settings-toggle-card", "Settings toggle card", &members, 0.9);
        let mut store = members.clone();
        store.push(card("new", "TelemetryCard", ""));
        store.push(json!({ "id": "chart", "name": "Chart", "kitId": "k", "composes": ["Axis"],
                           "srcText": "export const Chart = () => <Axis scale={s}><Line points={p}/></Axis>;" }));

        let m = conforming(&p, &store, true);
        let ids: Vec<&str> = m.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"new"), "the newly authored sibling is a member: {ids:?}");
        assert!(!ids.contains(&"chart"), "an unrelated record is not: {ids:?}");
        assert!(m.iter().all(|c| c.basis == Basis::Exemplar), "exemplars exist, so scoring is the basis");
        assert!(m.iter().filter(|c| c.exemplar).count() == 2, "both exemplars are listed as such");
    }

    #[test]
    fn a_declared_pattern_matches_by_containment_and_says_so() {
        // No exemplars — the convention was named before anything implemented it. Containment is the
        // only test available, it is looser, and `basis` is what tells the caller that.
        let p = json!({
            "id": "settings-toggle-card", "name": "Settings toggle card", "signatureSource": "declared",
            "threshold": 0.9,
            "signature": { "composes": ["card", "togglerow"], "skeleton": [] },
            "exemplars": [],
        });
        let store = vec![card("a", "AlphaCard", ""), json!({ "id": "x", "name": "X", "kitId": "k", "composes": ["Axis"], "srcText": "export const X = () => <Axis/>;" })];
        let m = conforming(&p, &store, true);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].id, "a");
        assert_eq!(m[0].basis, Basis::Signature, "no exemplars ⇒ containment, and it must be reported");
        assert_eq!(m[0].basis.as_str(), "containment", "the label names the TEST, not the member's role");
        assert!(m[0].score.is_none(), "containment yields no score to report");
    }

    #[test]
    fn a_signature_naming_nothing_matches_nothing() {
        // Guard: an empty declared signature is a subset of everything, so it would silently claim the
        // entire library as members.
        let p = json!({ "id": "p", "name": "P", "signatureSource": "declared", "threshold": 0.9,
                        "signature": { "composes": [], "skeleton": [] }, "exemplars": [] });
        assert!(conforming(&p, &[card("a", "AlphaCard", "")], true).is_empty());
    }

    #[test]
    fn a_tombstone_is_never_a_member() {
        let members = vec![card("a", "AlphaCard", ""), card("b", "BetaCard", "")];
        let p = derive("p", "P", &members, 0.9);
        let mut store = members.clone();
        store.push(json!({ "id": "old", "suppressed": true, "supersededBy": "a" }));
        assert!(conforming(&p, &store, true).iter().all(|c| c.id != "old"));
    }
}
