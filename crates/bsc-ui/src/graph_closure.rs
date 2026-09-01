//! CLOSING A PROMOTION'S `composes` GRAPH — ported from `scripts/lib/graphClosure.mjs`.
//!
//! WHY IT IS NEEDED. `knowledge.test.ts` asserts that every id in an impl's `composes` is a REAL impl in
//! the seed, of the same tech. So promoting an impl whose `composes` points at something still store-only
//! breaks the seed the moment it lands — the first unfiltered run promoted 35 impls and left 33 dangling
//! references. `promote-seed` therefore REFUSES such an impl, which is correct but pessimal: measured on
//! the drained tree, `unclosed-composes` was the biggest wall at 32 modules.
//!
//! Most of those refusals are ordering that resolves itself. The rest are not: 10 were blocked on
//! function records harvested out of the SAME FILE as their consumer (`fnv1a32.ts` from `hash.ts`), and
//! those in turn compose the TypeScript language PRIMITIVES — of which the seed had exactly one,
//! `typescript.number`, while the store had six. The wall was mostly a seed gap in the language kit.
//!
//! THE RULE, and the safety argument for it: a record with NO `provides` is a pure LIBRARY entry. It
//! answers no specifier, so the runtime never serves it in place of a module and shipping it cannot
//! change what the app renders — it only makes the graph's own references resolve. A record WITH
//! `provides` is a global override and must earn its place through the normal promotion gate; it is never
//! carried in on the strength of being composed.

use std::collections::{BTreeMap, HashMap, HashSet};

/// One store record, as this closure needs to see it.
pub struct Rec {
    pub provides: Option<String>,
    pub composes: Vec<String>,
}

/// `carry` is in DEPENDENCY ORDER — a record always follows the ones it composes — and `blocked` maps an
/// id that could not be carried to the reason.
pub struct Closure {
    pub carry: Vec<String>,
    pub blocked: BTreeMap<String, String>,
}

/// The store-only LIBRARY records that must ride along so `roots`' composes graph closes in the seed.
pub fn library_carry_closure(
    roots: &[String],
    by_id: &HashMap<String, Rec>,
    seeded: &HashSet<String>,
) -> Closure {
    let mut out = Closure { carry: Vec::new(), blocked: BTreeMap::new() };
    // Memoized across roots, so one blocked record stays blocked for every consumer.
    let mut state: HashMap<String, bool> = HashMap::new();
    for r in roots {
        visit(r, &mut HashSet::new(), by_id, seeded, &mut state, &mut out);
    }
    out
}

/// Post-order, so a carried record is always written after everything it composes.
fn visit(
    id: &str,
    stack: &mut HashSet<String>,
    by_id: &HashMap<String, Rec>,
    seeded: &HashSet<String>,
    state: &mut HashMap<String, bool>,
    out: &mut Closure,
) -> bool {
    if seeded.contains(id) {
        return true;
    }
    if let Some(seen) = state.get(id) {
        return *seen;
    }
    // A CYCLE is not a failure — `composes` is a knowledge graph and may loop. Treat the back-edge as
    // satisfied by the in-progress visit; the post-order push below still orders the rest.
    if stack.contains(id) {
        return true;
    }

    let Some(rec) = by_id.get(id) else {
        out.blocked.insert(id.to_string(), "no record in the store".to_string());
        state.insert(id.to_string(), false);
        return false;
    };
    if let Some(p) = rec.provides.as_ref().filter(|p| !p.is_empty()) {
        // An OVERRIDE. It must pass the normal gate; carrying it would ship a record that claims a
        // specifier without anything having checked it against the file it shadows.
        out.blocked.insert(id.to_string(), format!("claims {p} — must be promoted, not carried"));
        state.insert(id.to_string(), false);
        return false;
    }

    stack.insert(id.to_string());
    let mut ok = true;
    for c in &rec.composes {
        if !visit(c, stack, by_id, seeded, state, out) {
            ok = false;
        }
    }
    stack.remove(id);
    if !ok {
        out.blocked.insert(id.to_string(), "its own composes do not close".to_string());
        state.insert(id.to_string(), false);
        return false;
    }

    state.insert(id.to_string(), true);
    out.carry.push(id.to_string());
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(recs: &[(&str, Option<&str>, &[&str])]) -> HashMap<String, Rec> {
        recs.iter()
            .map(|(id, provides, composes)| {
                (
                    (*id).to_string(),
                    Rec {
                        provides: provides.map(str::to_string),
                        composes: composes.iter().map(|c| (*c).to_string()).collect(),
                    },
                )
            })
            .collect()
    }
    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| (*s).to_string()).collect()
    }
    fn roots(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| (*s).to_string()).collect()
    }

    /// The real shape: `fnv1a32.ts` is a function harvested out of `hash.ts`, and it composes the
    /// TypeScript language primitives — of which the seed had exactly one.
    #[test]
    fn carries_a_library_record_and_everything_it_composes_dependencies_first() {
        let by_id = mk(&[
            ("fnv1a32.ts", None, &["typescript.string", "typescript.number"][..]),
            ("typescript.string", None, &[][..]),
        ]);
        let c = library_carry_closure(&roots(&["fnv1a32.ts"]), &by_id, &set(&["typescript.number"]));
        assert_eq!(c.blocked.len(), 0);
        assert_eq!(c.carry, vec!["typescript.string".to_string(), "fnv1a32.ts".to_string()]);
    }

    #[test]
    fn refuses_to_carry_a_record_that_claims_a_specifier() {
        let by_id = mk(&[("role-model.ts", Some("@/shared/lib/session/roleModel"), &[][..])]);
        let c = library_carry_closure(&roots(&["role-model.ts"]), &by_id, &set(&[]));
        assert!(c.carry.is_empty());
        assert!(
            c.blocked["role-model.ts"].contains("must be promoted, not carried"),
            "{}",
            c.blocked["role-model.ts"]
        );
    }

    #[test]
    fn blocks_a_consumer_whose_own_composes_cannot_close() {
        let by_id =
            mk(&[("leaf.ts", None, &["missing.ts"][..]), ("mid.ts", None, &["leaf.ts"][..])]);
        let c = library_carry_closure(&roots(&["mid.ts"]), &by_id, &set(&[]));
        assert!(c.carry.is_empty());
        assert_eq!(c.blocked["missing.ts"], "no record in the store");
        assert_eq!(c.blocked["mid.ts"], "its own composes do not close");
    }

    #[test]
    fn treats_an_already_seeded_id_as_satisfied_and_does_not_recarry_it() {
        let by_id = mk(&[("a.ts", None, &["b.ts"][..])]);
        let c = library_carry_closure(&roots(&["a.ts"]), &by_id, &set(&["b.ts"]));
        assert_eq!(c.carry, vec!["a.ts".to_string()]);
    }

    /// A CYCLE is not a failure — `composes` is a knowledge graph and may loop.
    #[test]
    fn survives_a_cycle() {
        let by_id = mk(&[("a.ts", None, &["b.ts"][..]), ("b.ts", None, &["a.ts"][..])]);
        let c = library_carry_closure(&roots(&["a.ts"]), &by_id, &set(&[]));
        assert_eq!(c.blocked.len(), 0);
        let mut got = c.carry.clone();
        got.sort();
        assert_eq!(got, vec!["a.ts".to_string(), "b.ts".to_string()]);
    }

    /// ONE VERDICT SHARED ACROSS ROOTS — a blocked record stays blocked for every consumer.
    #[test]
    fn shares_one_verdict_across_roots() {
        let by_id = mk(&[
            ("override.ts", Some("@/x"), &[][..]),
            ("one.ts", None, &["override.ts"][..]),
            ("two.ts", None, &["override.ts"][..]),
        ]);
        let c = library_carry_closure(&roots(&["one.ts", "two.ts"]), &by_id, &set(&[]));
        assert!(c.carry.is_empty());
        assert_eq!(c.blocked["one.ts"], "its own composes do not close");
        assert_eq!(c.blocked["two.ts"], "its own composes do not close");
    }
}
