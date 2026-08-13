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
//! **The DECLARED BOUNDARY is the second half of that contract** (maintainer decision, 2026-08-12).
//! The loader has always had two halves: a record, else a module the PLATFORM REGISTRY
//! (`platform-modules.json`) declares. Records-only capped the runner at 30 of 130 records, because
//! every remaining unresolved specifier — all 58 of them — was a registered platform module rather than
//! an unmigrated record. So a dependency may be a record OR a declared boundary module, and anything
//! else still fails.
//!
//! The two halves stay VISIBLY distinct, and that is deliberate: a record is COPIED out of the store
//! into the mirror, a boundary module is ALIASED to the app's real file. One exact alias per specifier
//! actually reached — never a blanket `@` onto `src/`, which would resolve everything and leave the run
//! proving nothing. Every run reports `boundary`, which IS the per-record migration list: everything on
//! it is a dependency the app still supplies from a file instead of a record.

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

/// A module supplied from the DECLARED PLATFORM BOUNDARY rather than from a store — aliased to its
/// real file, never copied. The distinction is the point: a record is what the store holds, and the
/// boundary is unmistakably the app's own module.
#[derive(Debug, Clone)]
pub(crate) struct Boundary {
    pub specifier: String,
    /// Absolute, forward-slashed — what the generated config aliases the specifier to.
    pub path: String,
    /// Is this specifier in `platform-modules.json`? A `false` here is only ever reached from INSIDE
    /// another boundary module (see [`resolve_closure`]) and is reported so the registry's drift from
    /// what the platform actually pulls in stays visible instead of being quietly absorbed.
    pub registered: bool,
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
    /// Declared-boundary modules to ALIAS, sorted by specifier. Never copied — see [`Boundary`].
    pub boundary: Vec<Boundary>,
    /// Specifiers that name the ROOT itself — a cycle back into the record under test. These are
    /// ALIASED to the root module rather than written, so the record exists once and one module
    /// instance serves both the test's `./Thing` import and the closure's `@/…` one.
    pub self_specifiers: Vec<String>,
    /// Internal specifiers no record claims, deduped + sorted. Left unwritten ON PURPOSE — the run
    /// fails on them, which is the signal that the closure is incomplete.
    pub missing: Vec<String>,
}

/// The resolution paths, indexed once per sweep rather than per record.
pub(crate) struct Index<'a> {
    by_id: BTreeMap<&'a str, &'a Value>,
    comp_provides: BTreeMap<&'a str, &'a Value>,
    impl_provides: BTreeMap<&'a str, &'a Value>,
    /// The DECLARED boundary — `platform-modules.json`. Empty disables boundary supply entirely, which
    /// is what makes the records-only contract still expressible.
    platform: &'a std::collections::BTreeSet<String>,
    /// The repo's `src/`. `None` when it cannot be found, and then the boundary simply is not
    /// available and its specifiers stay MISSING — a runner that cannot find the tree reports the gap
    /// rather than inventing a resolution.
    src_root: Option<std::path::PathBuf>,
}

/// Resolve a `src/`-relative module base to a real file, trying the specifier AS WRITTEN first and then
/// the extensions and directory index in the order Vite's resolver does.
///
/// As-written comes first because a specifier can already carry its extension — a CSS side-effect import
/// (`import "@/features/algorithms/algorithms.css"`) is a real dependency of a real component, and
/// extension-guessing alone left two page records failing on their stylesheets.
fn file_for(src_root: &std::path::Path, base: &str) -> Option<std::path::PathBuf> {
    for cand in [
        base.to_string(),
        format!("{base}.ts"),
        format!("{base}.tsx"),
        format!("{base}/index.ts"),
        format!("{base}/index.tsx"),
    ] {
        let p = src_root.join(cand.replace('/', std::path::MAIN_SEPARATOR_STR));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Absolute + forward-slashed, the shape the generated vitest config embeds.
fn abs_posix(p: &std::path::Path) -> String {
    let a = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().map(|c| c.join(p)).unwrap_or_else(|_| p.to_path_buf())
    };
    a.to_string_lossy().replace('\\', "/")
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
    pub(crate) fn new(
        components: &'a [Value],
        impls: &'a [Value],
        platform: &'a std::collections::BTreeSet<String>,
        repo_root: Option<&std::path::Path>,
    ) -> Self {
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
        let src_root = repo_root.map(|r| r.join("src")).filter(|p| p.is_dir());
        Index { by_id, comp_provides, impl_provides, platform, src_root }
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

/// The transitive closure of `root_src` over RECORDS plus the DECLARED PLATFORM BOUNDARY.
///
/// `root_id`/`root_provides` identify the record under test so a cycle back into it aliases rather than
/// copies. `root_rel` is where the root logically sits in the mirror (its `provides` minus `@/`, else
/// ""), which is what a RELATIVE import in the root resolves against.
///
/// **Two depths, two rules, and the difference is the whole contract.** The record under test is JUDGED:
/// each of its imports must be a record or a REGISTERED boundary module, and anything else is `missing`
/// and fails the run. A boundary module is SUPPLIED, not judged — it is aliased to the app's real file,
/// so from inside it the app's own resolution applies and its imports are followed to real files whether
/// registered or not (they are reported with `registered: false`). Judging the platform's internals
/// would fail records over modules the app resolves perfectly well, which measures the registry rather
/// than the record.
///
/// Cycle-safe by construction: a record's source is walked at most once (`walked`), a record is written
/// at most once per mirror path (`written`), and a boundary file is walked at most once (`walked_files`).
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
    let mut aliased: BTreeMap<String, Boundary> = BTreeMap::new();
    let mut walked_files: BTreeSet<std::path::PathBuf> = BTreeSet::new();
    // (source, the path its RELATIVE imports resolve against, is this a boundary module?)
    let mut stack: Vec<(String, String, bool)> = vec![(root_src.to_string(), root_rel, false)];
    while let Some((src, from_rel, in_boundary)) = stack.pop() {
        for spec in crate::graph_health::live_specifiers(&src) {
            if !crate::graph_health::is_internal_specifier(&spec) {
                continue;
            }
            let Some(base) = crate::graph_health::resolve_internal_base(&spec, &from_rel) else {
                continue;
            };
            let key = format!("@/{base}");
            // A record ALWAYS wins over the boundary — the same precedence the runtime resolver runs,
            // where a record carrying `provides` is a deliberate override of the platform module.
            match index.lookup(&key, &base) {
                Some((id, _, _, _)) if id == root_id => {
                    // The record under test, reached from its own closure. Alias, never copy: a second
                    // copy is a second module instance, and the test would be asserting about one of
                    // them while the closure composed the other.
                    selfs.insert(key);
                    continue;
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
                        stack.push((source, rel, false));
                    }
                    continue;
                }
                None => {}
            }
            // Not a record. The boundary answers only for a REGISTERED specifier — unless we are already
            // inside a boundary module, where the app's own resolution applies.
            let registered = index.platform.contains(&key);
            let Some(src_root) = index.src_root.as_deref() else {
                missing.insert(key);
                continue;
            };
            if !registered && !in_boundary {
                missing.insert(key);
                continue;
            }
            let Some(file) = file_for(src_root, &base) else {
                // Registered but absent from the tree — a stale registry entry, and a real miss.
                missing.insert(key);
                continue;
            };
            aliased.entry(key.clone()).or_insert_with(|| Boundary {
                specifier: key,
                path: abs_posix(&file),
                registered,
            });
            if walked_files.insert(file.clone()) {
                if let Ok(text) = std::fs::read_to_string(&file) {
                    // Anchor relative imports at the file that was ACTUALLY resolved, not at the
                    // specifier's base. `@/store` resolves to `store/index.ts`, whose `./slices/console`
                    // is `store/slices/console` — anchoring at the base `store` makes it `slices/console`,
                    // a path that does not exist, and the record fails on a miss the runner invented.
                    let anchor = file
                        .strip_prefix(src_root)
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                        .unwrap_or_else(|_| base.clone());
                    stack.push((text, anchor, true));
                }
            }
        }
    }
    out.members.sort_by(|a, b| a.rel.cmp(&b.rel));
    out.boundary = aliased.into_values().collect();
    out.self_specifiers = selfs.into_iter().collect();
    out.missing = missing.into_iter().collect();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A closure with NO boundary available — the records-only contract, which every test below
    /// asserts against so a boundary regression cannot hide behind a record resolving anyway.
    fn no_platform() -> &'static BTreeSet<String> {
        static E: std::sync::OnceLock<BTreeSet<String>> = std::sync::OnceLock::new();
        E.get_or_init(BTreeSet::new)
    }

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
        let index = Index::new(&comps, &[], no_platform(), None);
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
        let index = Index::new(&comps, &[], no_platform(), None);
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
        let index = Index::new(&comps, &[], no_platform(), None);
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
        let index = Index::new(&comps, &[], no_platform(), None);
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
        let index = Index::new(&comps, &[], no_platform(), None);
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
        let index = Index::new(&comps, &impls, no_platform(), None);
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
        let index = Index::new(&comps, &[], no_platform(), None);
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
        let index = Index::new(&comps, &[], no_platform(), None);
        let c = resolve_closure("import { A } from \"@/shared/ui/A\";\nexport const R = A;", "root", None, &index);
        let rels: Vec<&str> = c.members.iter().map(|m| m.rel.as_str()).collect();
        assert_eq!(
            rels,
            vec!["shared/ui/A.tsx", "shared/ui/B.tsx"],
            "the mirror is what makes a member's OWN relative import resolve, with no source rewriting"
        );
    }

    /// A temp `src/` tree — the boundary is supplied from real files, so testing it needs real files.
    fn fake_src(tag: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("bsc-closure-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (rel, body) in files {
            let p = root.join("src").join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, body).unwrap();
        }
        root
    }

    fn plat(specs: &[&str]) -> BTreeSet<String> {
        specs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_registered_boundary_module_is_aliased_to_its_real_file_and_never_copied() {
        let root = fake_src("bnd-alias", &[("shared/ui/layout/space.ts", "export const pad = 4;\n")]);
        let p = plat(&["@/shared/ui/layout/space"]);
        let index = Index::new(&[], &[], &p, Some(&root));
        let c = resolve_closure("import { pad } from \"@/shared/ui/layout/space\";\nexport const R = pad;",
                                "root", None, &index);
        assert!(c.missing.is_empty(), "a declared boundary module is supplied, not missing");
        assert!(c.members.is_empty(), "and it is NOT copied into the mirror — records are, the boundary is not");
        assert_eq!(c.boundary.len(), 1);
        assert_eq!(c.boundary[0].specifier, "@/shared/ui/layout/space");
        assert!(c.boundary[0].registered, "it came from the registry");
        assert!(
            c.boundary[0].path.ends_with("src/shared/ui/layout/space.ts"),
            "aliased to the app's REAL file: {}",
            c.boundary[0].path
        );
    }

    #[test]
    fn an_unregistered_module_the_record_imports_stays_missing_even_though_the_file_exists() {
        // The whole contract in one test: the boundary is a DECLARED list, not "whatever is on disk".
        // A blanket alias onto src/ would resolve this and the run would prove nothing.
        let root = fake_src("bnd-undeclared", &[("features/secret/thing.ts", "export const t = 1;\n")]);
        let p = plat(&["@/shared/ui/layout/space"]);
        let index = Index::new(&[], &[], &p, Some(&root));
        let c = resolve_closure("import { t } from \"@/features/secret/thing\";\nexport const R = t;",
                                "root", None, &index);
        assert_eq!(c.missing, vec!["@/features/secret/thing".to_string()]);
        assert!(c.boundary.is_empty(), "an undeclared module is not supplied just because the file is there");
    }

    #[test]
    fn a_record_beats_the_boundary_for_the_same_specifier() {
        // Same precedence the runtime resolver runs: a record carrying `provides` is a deliberate
        // OVERRIDE of the platform module, so migrating a module must change what the runner supplies.
        let root = fake_src("bnd-override", &[("shared/ui/layout/space.ts", "export const pad = 999;\n")]);
        let p = plat(&["@/shared/ui/layout/space"]);
        let comps = vec![comp("space", "@/shared/ui/layout/space", "src/shared/ui/layout/space.ts",
                              "export const pad = 4;")];
        let index = Index::new(&comps, &[], &p, Some(&root));
        let c = resolve_closure("import { pad } from \"@/shared/ui/layout/space\";\nexport const R = pad;",
                                "root", None, &index);
        assert_eq!(c.members.len(), 1, "the RECORD is what gets supplied");
        assert_eq!(c.members[0].origin, Origin::Component);
        assert!(c.boundary.is_empty(), "and the file is not aliased alongside it — one copy, not two");
    }

    #[test]
    fn inside_a_boundary_module_the_apps_own_resolution_applies_and_is_reported() {
        // A boundary module is SUPPLIED, not judged. Failing a record because a platform module reaches
        // a module the registry forgot would measure the registry, not the record — but the reach is
        // reported (`registered: false`) rather than absorbed.
        let root = fake_src(
            "bnd-inner",
            &[
                ("shared/ui/layout/space.ts", "import { u } from \"@/shared/lib/units\";\nexport const pad = u;\n"),
                ("shared/lib/units.ts", "export const u = 4;\n"),
            ],
        );
        let p = plat(&["@/shared/ui/layout/space"]);
        let index = Index::new(&[], &[], &p, Some(&root));
        let c = resolve_closure("import { pad } from \"@/shared/ui/layout/space\";\nexport const R = pad;",
                                "root", None, &index);
        assert!(c.missing.is_empty(), "the platform's own internals must not fail the record under test");
        let by: BTreeMap<&str, &Boundary> = c.boundary.iter().map(|b| (b.specifier.as_str(), b)).collect();
        assert!(by["@/shared/ui/layout/space"].registered);
        assert!(
            !by["@/shared/lib/units"].registered,
            "reached only from inside the boundary — reported so the registry's drift stays visible"
        );
    }

    /// Regression: a boundary module resolved via its DIRECTORY INDEX anchors relative imports at the
    /// resolved FILE, not at the specifier's base. `@/store` → `store/index.ts`, whose `./slices/console`
    /// is `store/slices/console`. Anchoring at `store` produced `slices/console` — a path that exists
    /// nowhere, so the record failed on a miss the runner had invented. It showed up as four records
    /// reporting nonsense specifiers (`@/slices/console`, `@/constants`, `@/helpers`) in a real sweep.
    #[test]
    fn a_boundary_index_module_anchors_its_relative_imports_at_the_resolved_file() {
        let root = fake_src(
            "bnd-anchor",
            &[
                ("store/index.ts", "export { c } from \"./slices/console\";\n"),
                ("store/slices/console.ts", "export const c = 1;\n"),
            ],
        );
        let p = plat(&["@/store"]);
        let index = Index::new(&[], &[], &p, Some(&root));
        let c = resolve_closure("import { c } from \"@/store\";\nexport const R = c;", "root", None, &index);
        assert!(c.missing.is_empty(), "nothing should be missing — got {:?}", c.missing);
        let specs: Vec<&str> = c.boundary.iter().map(|b| b.specifier.as_str()).collect();
        assert_eq!(specs, vec!["@/store", "@/store/slices/console"], "the sibling resolves under store/");
    }

    /// A CSS side-effect import is a real dependency, and its specifier already carries its extension —
    /// so resolution must try the specifier AS WRITTEN, not only guess `.ts`/`.tsx` onto it.
    #[test]
    fn a_stylesheet_side_effect_import_resolves_from_the_boundary() {
        let root = fake_src("bnd-css", &[("features/algorithms/algorithms.css", ".a{color:red}\n")]);
        let p = plat(&["@/features/algorithms/algorithms.css"]);
        let index = Index::new(&[], &[], &p, Some(&root));
        let c = resolve_closure("import \"@/features/algorithms/algorithms.css\";\nexport const R = 1;",
                                "root", None, &index);
        assert!(c.missing.is_empty(), "got {:?}", c.missing);
        assert!(c.boundary[0].path.ends_with("algorithms.css"), "{}", c.boundary[0].path);
    }

    #[test]
    fn an_empty_registry_restores_the_records_only_contract() {
        // `--records-only`: the migration's own progress measure. The file is right there and still
        // does not resolve, because the question is "is this dependency a RECORD yet".
        let root = fake_src("bnd-recordsonly", &[("shared/ui/layout/space.ts", "export const pad = 4;\n")]);
        let index = Index::new(&[], &[], no_platform(), Some(&root));
        let c = resolve_closure("import { pad } from \"@/shared/ui/layout/space\";\nexport const R = pad;",
                                "root", None, &index);
        assert_eq!(c.missing, vec!["@/shared/ui/layout/space".to_string()]);
        assert!(c.boundary.is_empty());
    }

    #[test]
    fn a_registered_specifier_with_no_file_is_a_real_miss_not_a_silent_pass() {
        // A stale registry entry must not read as "supplied".
        let root = fake_src("bnd-stale", &[("shared/ui/layout/space.ts", "export const pad = 4;\n")]);
        let p = plat(&["@/shared/ui/gone"]);
        let index = Index::new(&[], &[], &p, Some(&root));
        let c = resolve_closure("import \"@/shared/ui/gone\";\nexport const R = 1;", "root", None, &index);
        assert_eq!(c.missing, vec!["@/shared/ui/gone".to_string()]);
        assert!(c.boundary.is_empty());
    }

    #[test]
    fn an_external_package_is_never_pulled_into_the_closure() {
        let comps = vec![comp("a", "@/x/A", "src/x/A.tsx", "export const A = 1;")];
        let index = Index::new(&comps, &[], no_platform(), None);
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
