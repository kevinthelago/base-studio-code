//! The record CLOSURE a test materialization writes around a record
//! (materialize-a-records-record-closure).
//!
//! `bsc ui test` materialized ONE record into an empty directory, so only 14 of a 130-record tested
//! library could pass: 108 of the 116 failures were the record's own CODE importing another app module.
//! That is structural rather than incidental — **components compose other components**, so a strict
//! one-record materialization can only ever verify leaves, and most of a UI library is not leaves.
//!
//! But those dependencies are usually RECORDS ALREADY, so they resolve exactly the way the running app
//! resolves them. This mirrors `resolveGraphSource`
//! (`src/shared/lib/runtime/graphResolver.ts`) verb for verb, INCLUDING its order:
//!
//! 1. `@/components/<id>` — a SIBLING by id (a page composing its panels, #3606).
//! 2. a COMPONENT whose `provides` equals the specifier — a UI record overriding a platform module (#3660).
//! 3. an ALGORITHM IMPL whose `provides` equals the specifier — a logic module authored as a record.
//!
//! Impls are LAST for the reason they are last there: a component claiming a specifier means a UI record
//! overriding a registered platform module, and letting an impl win would silently shadow a rendering
//! component with a non-rendering module — a failure at mount rather than at resolution.
//!
//! What isolation withholds is unchanged: the repo tree, the app's aliases, the store. What it now
//! supplies is the record's DECLARED dependency graph, written into a MIRROR of `src/` that `@` is
//! aliased to — so a member sits at its real position and its own `@/…` (and relative) imports resolve
//! against the same mirror without rewriting a single line of anyone's source.
//!
//! A specifier NO record claims is deliberately left unwritten and the run fails on it. That is the
//! point: the honest signal is "this record's dependency is not a record yet", not "everything
//! resolves".

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Which store answered for a member — reported so a failure names the store to fix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Origin {
    /// `@/components/<id>` — a component record addressed by id.
    Sibling,
    /// A component record whose `provides` is the specifier.
    Component,
    /// An algorithm impl whose `provides` is the specifier.
    Impl,
}

impl Origin {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Origin::Sibling => "sibling",
            Origin::Component => "component",
            Origin::Impl => "impl",
        }
    }
}

/// One record written into the mirror.
#[derive(Debug, Clone)]
pub(crate) struct Member {
    /// The specifier that pulled it in — `@/shared/ui/feedback/EmptyState`.
    pub specifier: String,
    pub id: String,
    pub origin: Origin,
    /// Its path INSIDE the mirror, extension included — `shared/ui/feedback/EmptyState.tsx`.
    pub rel: String,
    pub source: String,
}

/// What a root record's imports resolved to.
#[derive(Debug, Default)]
pub(crate) struct Closure {
    /// The records to write, sorted by mirror path so a run is byte-reproducible.
    pub members: Vec<Member>,
    /// Specifiers that name the ROOT itself — a cycle back into the record under test. These are
    /// ALIASED to the root module rather than written, so the record exists once and one module
    /// instance serves both the test's `./Thing` import and the closure's `@/…` one.
    pub self_specifiers: Vec<String>,
    /// Internal specifiers no record claims, deduped + sorted. Left unwritten ON PURPOSE — the run
    /// fails on them, which is the signal that the closure is incomplete.
    pub missing: Vec<String>,
}

/// The three resolution paths, indexed once per sweep rather than per record.
pub(crate) struct Index<'a> {
    by_id: BTreeMap<&'a str, &'a Value>,
    comp_provides: BTreeMap<&'a str, &'a Value>,
    impl_provides: BTreeMap<&'a str, &'a Value>,
}

/// A component's source field; an impl's is `code` — its module IS the code (`bsc graph harvest
/// --module`), so it vendors exactly like a component's `srcText`.
fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn id_of(v: &Value) -> &str {
    v.get("id").and_then(Value::as_str).unwrap_or_default()
}

/// The extension a record's module must be written under. Taken from its `src`, never guessed, because
/// the two are NOT interchangeable to the loader: JSX only parses in `.tsx`, and the angle-bracket cast
/// (`<T>x`) only parses in `.ts`. A record with no `src` falls back to the tier default — `.tsx` for a
/// component (it renders), `.ts` for an impl (it does not).
fn ext_of(v: &Value, default: &'static str) -> &'static str {
    let src = v.get("src").and_then(Value::as_str).unwrap_or_default();
    match () {
        _ if src.ends_with(".tsx") => "tsx",
        _ if src.ends_with(".ts") => "ts",
        _ => default,
    }
}

impl<'a> Index<'a> {
    /// Build the index. A `provides` COLLISION (two records claiming one specifier) keeps the FIRST,
    /// matching the `components.find(…)` the runtime resolver runs over the same store order — `bsc ui
    /// doctor` is what REPORTS a collision; resolving it differently here would just make the runner
    /// disagree with the app.
    pub(crate) fn new(components: &'a [Value], impls: &'a [Value]) -> Self {
        let mut by_id = BTreeMap::new();
        let mut comp_provides = BTreeMap::new();
        let mut impl_provides = BTreeMap::new();
        for c in components {
            by_id.entry(id_of(c)).or_insert(c);
            let p = c.get("provides").and_then(Value::as_str).unwrap_or_default().trim();
            if !p.is_empty() {
                comp_provides.entry(p).or_insert(c);
            }
        }
        for im in impls {
            let p = im.get("provides").and_then(Value::as_str).unwrap_or_default().trim();
            if !p.is_empty() {
                impl_provides.entry(p).or_insert(im);
            }
        }
        Index { by_id, comp_provides, impl_provides }
    }

    /// Resolve one `@/…` specifier through the loader's chain. `base` is the specifier minus the alias.
    fn lookup(&self, spec: &str, base: &str) -> Option<(String, Origin, String, &'static str)> {
        if let Some(id) = base.strip_prefix("components/") {
            if let Some(c) = self.by_id.get(id) {
                return Some((id_of(c).to_string(), Origin::Sibling, text(c, "srcText"), ext_of(c, "tsx")));
            }
        }
        if let Some(c) = self.comp_provides.get(spec) {
            return Some((id_of(c).to_string(), Origin::Component, text(c, "srcText"), ext_of(c, "tsx")));
        }
        if let Some(im) = self.impl_provides.get(spec) {
            return Some((id_of(im).to_string(), Origin::Impl, text(im, "code"), ext_of(im, "ts")));
        }
        None
    }
}

/// The transitive record closure of `root_src`.
///
/// `root_id`/`root_provides` identify the record under test so a cycle back into it aliases rather than
/// copies. `root_rel` is where the root logically sits in the mirror (its `provides` minus `@/`, else
/// ""), which is what a RELATIVE import in the root resolves against.
///
/// Cycle-safe by construction: a record's source is walked at most once (`walked`), and a record is
/// written at most once per mirror path (`written`). Both matter — a record reachable under two
/// specifiers must exist at both paths for both imports to resolve, but must not be walked twice.
pub(crate) fn resolve_closure(
    root_src: &str,
    root_id: &str,
    root_provides: Option<&str>,
    index: &Index<'_>,
) -> Closure {
    let root_rel = root_provides.and_then(|p| p.strip_prefix("@/")).unwrap_or("").to_string();
    let mut out = Closure::default();
    let mut walked: BTreeSet<String> = BTreeSet::new();
    let mut written: BTreeSet<String> = BTreeSet::new();
    let mut missing: BTreeSet<String> = BTreeSet::new();
    let mut selfs: BTreeSet<String> = BTreeSet::new();
    // (source, the mirror path it was written at — what its relative imports resolve against)
    let mut stack: Vec<(String, String)> = vec![(root_src.to_string(), root_rel)];
    while let Some((src, from_rel)) = stack.pop() {
        for spec in crate::graph_health::live_specifiers(&src) {
            if !crate::graph_health::is_internal_specifier(&spec) {
                continue;
            }
            let Some(base) = crate::graph_health::resolve_internal_base(&spec, &from_rel) else {
                continue;
            };
            let key = format!("@/{base}");
            match index.lookup(&key, &base) {
                None => {
                    missing.insert(key);
                }
                Some((id, _, _, _)) if id == root_id => {
                    // The record under test, reached from its own closure. Alias, never copy: a second
                    // copy is a second module instance, and the test would be asserting about one of
                    // them while the closure composed the other.
                    selfs.insert(key);
                }
                Some((id, origin, source, ext)) => {
                    let rel = format!("{base}.{ext}");
                    if written.insert(rel.clone()) {
                        out.members.push(Member {
                            specifier: key,
                            id: id.clone(),
                            origin,
                            rel: rel.clone(),
                            source: source.clone(),
                        });
                    }
                    if walked.insert(id) {
                        stack.push((source, rel));
                    }
                }
            }
        }
    }
    out.members.sort_by(|a, b| a.rel.cmp(&b.rel));
    out.self_specifiers = selfs.into_iter().collect();
    out.missing = missing.into_iter().collect();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn comp(id: &str, provides: &str, src: &str, src_text: &str) -> Value {
        json!({ "id": id, "provides": provides, "src": src, "srcText": src_text })
    }

    #[test]
    fn resolves_a_composing_records_import_through_provides() {
        let comps = vec![comp(
            "ui-empty-state",
            "@/shared/ui/feedback/EmptyState",
            "src/shared/ui/feedback/EmptyState.tsx",
            "export function EmptyState() { return null; }",
        )];
        let index = Index::new(&comps, &[]);
        let c = resolve_closure(
            "import { EmptyState } from \"@/shared/ui/feedback/EmptyState\";\nexport const F = EmptyState;",
            "activityfeed",
            None,
            &index,
        );
        assert_eq!(c.missing, Vec::<String>::new(), "the import IS a record — nothing is missing");
        assert_eq!(c.members.len(), 1);
        assert_eq!(c.members[0].rel, "shared/ui/feedback/EmptyState.tsx", "written at its REAL position");
        assert_eq!(c.members[0].origin, Origin::Component);
    }

    #[test]
    fn the_closure_is_transitive() {
        let comps = vec![
            comp("a", "@/x/A", "src/x/A.tsx", "import { B } from \"@/x/B\";\nexport const A = B;"),
            comp("b", "@/x/B", "src/x/B.tsx", "import { C } from \"@/x/C\";\nexport const B = C;"),
            comp("c", "@/x/C", "src/x/C.tsx", "export const C = 1;"),
        ];
        let index = Index::new(&comps, &[]);
        let c = resolve_closure("import { A } from \"@/x/A\";\nexport const R = A;", "root", None, &index);
        let rels: Vec<&str> = c.members.iter().map(|m| m.rel.as_str()).collect();
        assert_eq!(rels, vec!["x/A.tsx", "x/B.tsx", "x/C.tsx"], "the whole chain, not just the first hop");
    }

    #[test]
    fn a_cycle_terminates_and_writes_each_record_once() {
        // A ↔ B, and B also reaches back to the ROOT. Without both guards this never returns.
        let comps = vec![
            comp("a", "@/x/A", "src/x/A.tsx", "import { B } from \"@/x/B\";\nexport const A = B;"),
            comp(
                "b",
                "@/x/B",
                "src/x/B.tsx",
                "import { A } from \"@/x/A\";\nimport { R } from \"@/x/R\";\nexport const B = [A, R];",
            ),
            comp("root", "@/x/R", "src/x/R.tsx", "unused — the root's source is passed in"),
        ];
        let index = Index::new(&comps, &[]);
        let c = resolve_closure(
            "import { A } from \"@/x/A\";\nexport const R = A;",
            "root",
            Some("@/x/R"),
            &index,
        );
        let rels: Vec<&str> = c.members.iter().map(|m| m.rel.as_str()).collect();
        assert_eq!(rels, vec!["x/A.tsx", "x/B.tsx"], "each member once; the root is NOT copied in");
        assert_eq!(c.self_specifiers, vec!["@/x/R".to_string()], "the cycle back to the root aliases");
    }

    #[test]
    fn an_import_that_resolves_to_no_record_is_reported_missing_not_invented() {
        let comps = vec![comp("a", "@/x/A", "src/x/A.tsx", "import \"@/shared/ui/layout/space\";\nexport const A = 1;")];
        let index = Index::new(&comps, &[]);
        let c = resolve_closure("import { A } from \"@/x/A\";\nexport const R = A;", "root", None, &index);
        assert_eq!(c.members.len(), 1, "the record that IS a record is still written");
        assert_eq!(
            c.missing,
            vec!["@/shared/ui/layout/space".to_string()],
            "a specifier no record claims is named, and left unwritten so the run fails on it"
        );
    }

    #[test]
    fn a_sibling_by_id_resolves_and_lands_under_the_specifier_it_was_imported_by() {
        let comps = vec![comp("fleet-status", "", "src/features/fleet/FleetStatus.tsx", "export const S = 1;")];
        let index = Index::new(&comps, &[]);
        let c = resolve_closure(
            "import { S } from \"@/components/fleet-status\";\nexport const P = S;",
            "fleetpage",
            None,
            &index,
        );
        assert_eq!(c.members.len(), 1);
        assert_eq!(c.members[0].origin, Origin::Sibling);
        assert_eq!(c.members[0].rel, "components/fleet-status.tsx", "the mirror path IS the specifier");
    }

    #[test]
    fn an_algorithm_impl_resolves_but_only_where_no_component_claims_the_specifier() {
        let comps = vec![comp("ui-thing", "@/shared/lib/thing", "src/shared/lib/Thing.tsx", "export const T = 1;")];
        let impls = vec![
            json!({ "id": "thing.ts", "provides": "@/shared/lib/thing", "src": "src/shared/lib/thing.ts",
                    "code": "export const T = 2;" }),
            json!({ "id": "heat-fill.ts", "provides": "@/features/github/heatFill",
                    "src": "src/features/github/heatFill.ts", "code": "export const heatFill = () => 0;" }),
        ];
        let index = Index::new(&comps, &impls);
        let c = resolve_closure(
            "import \"@/shared/lib/thing\";\nimport \"@/features/github/heatFill\";\nexport const R = 1;",
            "root",
            None,
            &index,
        );
        let by_spec: BTreeMap<&str, &Member> = c.members.iter().map(|m| (m.specifier.as_str(), m)).collect();
        assert_eq!(
            by_spec["@/shared/lib/thing"].origin,
            Origin::Component,
            "a component claiming the specifier WINS — an impl must never shadow a rendering record"
        );
        assert_eq!(by_spec["@/features/github/heatFill"].origin, Origin::Impl);
        assert_eq!(by_spec["@/features/github/heatFill"].rel, "features/github/heatFill.ts", ".ts, not .tsx");
    }

    #[test]
    fn a_type_only_import_is_not_materialized() {
        // Erased before resolution, so writing a file for it would be writing one nothing asks for.
        let comps = vec![comp("p", "@/x/Props", "src/x/Props.ts", "export type P = 1;")];
        let index = Index::new(&comps, &[]);
        let c = resolve_closure("import type { P } from \"@/x/Props\";\nexport const R: P = 1;", "root", None, &index);
        assert!(c.members.is_empty(), "a type-only import is erased, not a dependency");
        assert!(c.missing.is_empty(), "and it is not a MISS either");
    }

    #[test]
    fn a_relative_import_inside_a_member_resolves_against_its_mirrored_position() {
        let comps = vec![
            comp("a", "@/shared/ui/A", "src/shared/ui/A.tsx", "import { B } from \"./B\";\nexport const A = B;"),
            comp("b", "@/shared/ui/B", "src/shared/ui/B.tsx", "export const B = 1;"),
        ];
        let index = Index::new(&comps, &[]);
        let c = resolve_closure("import { A } from \"@/shared/ui/A\";\nexport const R = A;", "root", None, &index);
        let rels: Vec<&str> = c.members.iter().map(|m| m.rel.as_str()).collect();
        assert_eq!(
            rels,
            vec!["shared/ui/A.tsx", "shared/ui/B.tsx"],
            "the mirror is what makes a member's OWN relative import resolve, with no source rewriting"
        );
    }

    #[test]
    fn an_external_package_is_never_pulled_into_the_closure() {
        let comps = vec![comp("a", "@/x/A", "src/x/A.tsx", "export const A = 1;")];
        let index = Index::new(&comps, &[]);
        let c = resolve_closure(
            "import React from \"react\";\nimport { A } from \"@/x/A\";\nexport const R = [React, A];",
            "root",
            None,
            &index,
        );
        assert_eq!(c.members.len(), 1, "only first-party specifiers are records");
        assert!(c.missing.is_empty(), "`react` is the harness, not a missing record");
    }
}
