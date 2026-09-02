//! DECIDE what to emit, writing nothing.
//!
//! Split from the writing half so a guard can ask "would this record's test actually run?" without
//! triggering an emit. [`crate::emit::emit_records`] also PRUNES what it no longer intends, so a test
//! that called it mid-suite would delete files out from under every other file being collected in
//! parallel — the same race `vite/bscRecords.ts` documents for the worker sub-build.

use bsc_record::record_source::{alias_for_dir, relative_specifiers};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// A seed big enough to be the generated kit closure rather than a per-record seed.
const KIT_CLOSURE_BYTES: u64 = 4_000_000;

/// The extensions a `@/…` specifier can resolve through, in the order the resolvers try them.
const MODULE_EXTS: [&str; 6] = [".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"];
const TEST_EXTS: [&str; 4] = [".test.tsx", ".test.ts", ".spec.tsx", ".spec.ts"];

/// One retired module the plan will materialize.
#[derive(Clone, Debug, PartialEq)]
pub struct PlannedModule {
    pub spec: String,
    pub id: String,
    /// The specifier with `@/` stripped — the path under the emitted tree.
    pub rel: String,
    pub code: String,
}

/// One carried test the plan will materialize beside its module.
#[derive(Clone, Debug, PartialEq)]
pub struct PlannedTest {
    pub spec: String,
    pub name: String,
    pub rel: String,
    /// The extension the RECORD stated, when it stated a usable one — `None` means the `ext_for`
    /// guess was used instead. Kept distinct from `rel` because a guard asks which records know
    /// their own extension, and folding it into the path would destroy that.
    pub ext: Option<String>,
    /// Already rewritten: relative imports absolutized to `@/…`.
    pub src: String,
    pub detail: String,
}

/// A carried test whose relative imports do not land on anything this plan emits.
#[derive(Clone, Debug, PartialEq)]
pub struct Unresolvable {
    pub spec: String,
    pub name: String,
    pub missing: Vec<String>,
    pub detail: String,
}

/// One edge test — an integration test that spans SEVERAL records.
#[derive(Clone, Debug, PartialEq)]
pub struct EdgeTest {
    pub id: String,
    pub members: Vec<String>,
    pub rel: String,
    pub src: String,
    pub detail: String,
}

/// Everything the emitter would do, decided without touching the output tree.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plan {
    pub modules: Vec<PlannedModule>,
    pub tests: Vec<PlannedTest>,
    /// Specifiers whose carried test a colocated `src/` file still shadows.
    pub shadowed: Vec<String>,
    pub unresolvable: Vec<Unresolvable>,
    pub edge_tests: Vec<EdgeTest>,
    pub edge_shadowed: Vec<String>,
    pub edge_unresolvable: Vec<(String, String)>,
}

/// A seed entry: the source to serve for one specifier, plus its carried tests.
struct Seed {
    id: String,
    code: String,
    tests: Vec<Value>,
}

/// Every specifier a packaged seed can serve, with the source to serve for it.
///
/// COMPONENTS WIN A COLLISION — `resolveGraphSource` checks them first, so the emitted tree must
/// agree with what the runtime loader would have picked.
///
/// `BTreeMap`, not insertion order: see the crate header. The JavaScript's order was `readdirSync`
/// order, which is filesystem order, already machine-dependent, and load-bearing nowhere.
fn collect_seeds(repo: &Path) -> BTreeMap<String, Seed> {
    let mut out: BTreeMap<String, Seed> = BTreeMap::new();

    for path in walk_json(&repo.join("src-tauri").join("data").join("components")) {
        // The generated kit closure, not a per-record seed.
        if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > KIT_CLOSURE_BYTES {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(rec) = serde_json::from_str::<Value>(&text) else { continue };
        let spec = rec.get("provides").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let code = rec.get("srcText").and_then(Value::as_str).unwrap_or("").to_string();
        let id = rec.get("id").and_then(Value::as_str).unwrap_or("");
        if spec.starts_with("@/") && !code.trim().is_empty() && !id.is_empty() {
            out.entry(spec).or_insert_with(|| Seed {
                id: id.to_string(),
                code,
                tests: rec.get("tests").and_then(Value::as_array).cloned().unwrap_or_default(),
            });
        }
    }

    // A checkout without the algorithm seed is still valid.
    if let Some(k) = read_json(&repo.join("src-tauri").join("data").join("knowledge").join("algorithms.json")) {
        for im in k.get("implementations").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
            let spec = im.get("provides").and_then(Value::as_str).unwrap_or("").trim().to_string();
            let code = im.get("code").and_then(Value::as_str).unwrap_or("").to_string();
            let id = im.get("id").and_then(Value::as_str).unwrap_or("");
            if spec.starts_with("@/") && !code.trim().is_empty() && !id.is_empty() && !out.contains_key(&spec) {
                out.insert(
                    spec,
                    Seed {
                        id: id.to_string(),
                        code,
                        tests: im.get("tests").and_then(Value::as_array).cloned().unwrap_or_default(),
                    },
                );
            }
        }
    }
    out
}

/// The graph's EDGES (`integration-tests-become-graph-edges`), or an empty list.
///
/// Read separately from [`collect_seeds`] because an edge is not a module: it has no `provides`,
/// emits no source, and is keyed by its own id rather than by a specifier. Folding it into the
/// specifier map would make an edge compete with a record for a key it does not own.
fn collect_edges(repo: &Path) -> Vec<Value> {
    read_json(&repo.join("src-tauri").join("data").join("knowledge").join("algorithms.json"))
        .and_then(|k| k.get("edges").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Every `.json` under `dir`, recursively, in SORTED order. An unreadable directory yields nothing,
/// which is the conservative direction: a seed that cannot be read is simply not emitted.
fn walk_json(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        let mut dirs = Vec::new();
        let mut files = Vec::new();
        for e in entries.flatten() {
            let p = e.path();
            match e.file_type() {
                Ok(t) if t.is_dir() => dirs.push(p),
                Ok(_) if p.extension().is_some_and(|x| x == "json") => files.push(p),
                _ => {}
            }
        }
        files.sort();
        out.extend(files);
        dirs.sort();
        // Reversed: `stack.pop()` takes the last, so pushing in reverse visits in sorted order.
        stack.extend(dirs.into_iter().rev());
    }
    out.sort();
    out
}

/// Does `src/` still hold this specifier? If so the record must NOT be emitted — the file wins.
fn file_exists(repo: &Path, spec: &str) -> bool {
    let base = repo.join("src").join(spec.trim_start_matches("@/"));
    MODULE_EXTS.iter().any(|e| suffixed(&base, e).exists())
}

/// Does `src/` still hold a COLOCATED TEST for this specifier?
///
/// The same "src wins" rule the module itself follows, and it is what makes the migration incremental
/// rather than a flag day. While `src/x/y.test.tsx` exists it is the copy that RUNS; emitting the
/// record's carried test as well would run the same assertions TWICE and double-count them, so a
/// record's tests are emitted only once the file is gone. Deleting the file is therefore the whole
/// handover, with no third state in between.
fn test_file_exists(repo: &Path, spec: &str) -> bool {
    let base = repo.join("src").join(spec.trim_start_matches("@/"));
    TEST_EXTS.iter().any(|e| suffixed(&base, e).exists())
}

/// `base` with `suffix` APPENDED to the whole filename — never `set_extension`, which REPLACES.
fn suffixed(base: &Path, suffix: &str) -> PathBuf {
    let mut s = base.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

/// JSX needs `.tsx`; a module without it gets `.ts` so `tsc` does not widen every generic to a JSX tag.
pub fn ext_for(code: &str) -> &'static str {
    // The JavaScript is `/<[A-Za-z][^>]*>/`: a `<`, an ASCII letter, then any run of non-`>`, then `>`.
    let b = code.as_bytes();
    for i in 0..b.len() {
        if b[i] != b'<' {
            continue;
        }
        let Some(&next) = b.get(i + 1) else { continue };
        if !next.is_ascii_alphabetic() {
            continue;
        }
        // `[^>]*>` — any run without `>`, then a `>`. Scanning forward for the first `>` is the same
        // language, because the run may not contain one.
        if b[i + 1..].contains(&b'>') {
            return ".tsx";
        }
    }
    ".ts"
}

/// Normalize a relative specifier against the directory it is imported FROM, in specifier terms.
/// `./Button` from `shared/ui/controls` → `shared/ui/controls/Button`.
///
/// Delegates to the shared `alias_for_dir` and strips the `@/` back off, so the emitter's idea of
/// where a relative import LANDS cannot drift from the guard's.
fn resolve_rel(from_dir: &str, rel: &str) -> String {
    alias_for_dir(from_dir, rel).trim_start_matches("@/").to_string()
}

/// Is this normalized path something `@/…` can reach — a module still in `src/`, one being emitted,
/// or a colocated ASSET the test reads as data?
///
/// The asset arm is why one earlier attempt could not carry `projectPaths`: a test importing a
/// COLOCATED NON-MODULE ASSET cannot move, because the asset does not.
/// `./projectSlug.fixtures.json` names an exact file, and appending `.ts` to it asks for something
/// nobody wrote — so the specifier resolved to nothing and the carried test was declined.
///
/// Checked LAST and never INSTEAD. A dotted tail does not prove an extension —
/// `./platformModules.gen` and `./styleContract.gen` are ordinary modules whose names contain a dot —
/// so sniffing the tail first would decline the very imports that resolve today. Trying the module
/// extensions first makes this purely additive.
fn reachable(repo: &Path, rel_path: &str, will_emit: &BTreeSet<String>) -> bool {
    if will_emit.contains(rel_path) {
        return true;
    }
    let base = repo.join("src").join(rel_path);
    if MODULE_EXTS.iter().any(|e| suffixed(&base, e).exists()) {
        return true;
    }
    base.exists()
}

/// Rewrite a carried test's RELATIVE imports to absolute `@/…` specifiers.
///
/// A carried test was harvested beside its module, so it says `./LabelChip`. Emitted into
/// `.bsc-records/`, that resolves only if `LabelChip` is ALSO a record — a sibling still under `src/`
/// is unreachable from there, because nothing bridges the two trees relatively. `@/shared/ui/data/…`
/// reaches both: the alias finds `src/` first and the record fallback answers when the file is gone.
///
/// SPLICED BACK TO FRONT, so an earlier splice cannot shift a later index.
fn rewrite_relative_imports(src: &str, dir: &str) -> String {
    let mut out = src.to_string();
    for r in relative_specifiers(src).into_iter().rev() {
        out = format!("{}{}{}", &out[..r.at], alias_for_dir(dir, &r.spec), &out[r.at + r.spec.len()..]);
    }
    out
}

/// Where an edge test is emitted, as a `.bsc-records/`-relative path.
///
/// PURE, and public so a guard can exercise the rule with no edges in the seed — otherwise "every
/// edge is handled" passes by there being none, which is the vacuous green this repo keeps getting
/// caught by.
///
/// The address is the edge's PROVENANCE (`src`), mirrored. An edge spans several records and so has
/// no home specifier to sit beside, and the alternative — one synthetic folder — would silently
/// re-classify every pure-domain integration test: the vitest `node` project selects on a path
/// containing `/lib/`, and losing that costs 488.56s of DOM construction against 13.93s of tests on
/// this subset.
///
/// `i` disambiguates an edge carrying more than one test file, exactly as the node path does.
pub fn edge_test_path(from: &str, i: usize, ext: Option<&str>, code: &str) -> String {
    let rel_base = strip_test_suffix(from.strip_prefix("src/").unwrap_or(from));
    let suffix = if i == 0 { String::new() } else { format!(".{i}") };
    let chosen = ext.filter(|e| is_module_ext(e)).unwrap_or_else(|| ext_for(code));
    format!("{rel_base}{suffix}.test{chosen}")
}

/// `/\.(test|spec)\.tsx?$/` removed from the end.
fn strip_test_suffix(s: &str) -> &str {
    for tail in [".test.tsx", ".test.ts", ".spec.tsx", ".spec.ts"] {
        if let Some(base) = s.strip_suffix(tail) {
            return base;
        }
    }
    s
}

/// `/^\.[jt]sx?$/` — the extensions a record may state for its carried test.
fn is_module_ext(e: &str) -> bool {
    matches!(e, ".js" | ".jsx" | ".ts" | ".tsx")
}

/// The carried extension WINS over the guess.
///
/// [`ext_for`] reads `<T>(a: readonly T[])` — an ordinary TypeScript generic, and test files are full
/// of them — as a JSX tag, names the file `.tsx`, and the parser then fails on it. Measured at 177 of
/// 376 algorithm-subject tests, so the guess is wrong about HALF the time on this corpus. A record
/// that knows its source extension states it; `ext_for` stays the fallback for records that predate
/// the field.
fn test_ext(t: &Value, src: &str) -> String {
    t.get("ext")
        .and_then(Value::as_str)
        .filter(|e| is_module_ext(e))
        .map(String::from)
        .unwrap_or_else(|| ext_for(src).to_string())
}

/// Dedupe preserving first occurrence — the JavaScript's
/// `.filter((r, idx, all) => all.indexOf(r) === idx)`.
fn dedupe_in_order(v: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    v.into_iter().filter(|s| seen.insert(s.clone())).collect()
}

/// DECIDE what to emit, writing nothing.
///
/// ⚠️ A CARRIED TEST IS NOT NECESSARILY THIS RECORD'S TEST. `bsc ui harvest` attached whatever
/// colocated `*.test.*` it found, so the seed holds records paired with a test for something else
/// entirely — `@/components/typechip` carries the test for `ScanViews`, and four separate records all
/// carry the one `bodyStyles` test. Emitting those verbatim puts a broken import into the gate:
/// measured, 15 of the first 21 emitted failed to resolve, all of them mispairs.
///
/// So the pairing is VERIFIED rather than trusted: every relative import the test makes must land on
/// a module this same plan is emitting. Checking against the PLAN rather than the filesystem keeps it
/// pure and order-independent — a test may name a record that would be written later in the run.
/// `@/…` imports are not checked; they go through the alias and the record fallback, exactly as the
/// module's own do.
pub fn plan_records(repo: &Path) -> Plan {
    let seeds = collect_seeds(repo);
    let mut modules = Vec::new();
    let mut carried: Vec<(String, String, Vec<Value>)> = Vec::new(); // (spec, rel, tests)
    for (spec, seed) in &seeds {
        if file_exists(repo, spec) {
            continue; // the file is still there and authoritative
        }
        let rel = spec.trim_start_matches("@/").to_string();
        modules.push(PlannedModule {
            spec: spec.clone(),
            id: seed.id.clone(),
            rel: rel.clone(),
            code: seed.code.clone(),
        });
        carried.push((spec.clone(), rel, seed.tests.clone()));
    }
    let will_emit: BTreeSet<String> = modules.iter().map(|m| m.rel.clone()).collect();

    let mut tests = Vec::new();
    let mut shadowed = Vec::new();
    let mut unresolvable = Vec::new();
    for (spec, rel, rec_tests) in &carried {
        if rec_tests.is_empty() {
            continue;
        }
        if test_file_exists(repo, spec) {
            // `src/` still runs this test — do not plan a second, duplicate copy of the assertions.
            shadowed.push(spec.clone());
            continue;
        }
        let dir = rel.rfind('/').map_or("", |i| &rel[..i]);
        for (i, t) in rec_tests.iter().enumerate() {
            let src = t.get("src").and_then(Value::as_str).unwrap_or("");
            if src.trim().is_empty() {
                continue;
            }
            let name = t.get("name").and_then(Value::as_str).unwrap_or("(unnamed)").to_string();
            let missing: Vec<String> =
                dedupe_in_order(relative_specifiers(src).into_iter().map(|r| r.spec).collect())
                    .into_iter()
                    .filter(|r| !reachable(repo, &resolve_rel(dir, r), &will_emit))
                    .collect();
            if !missing.is_empty() {
                unresolvable.push(Unresolvable {
                    spec: spec.clone(),
                    name: name.clone(),
                    detail: format!("{spec} → {name} — cannot resolve {}", missing.join(", ")),
                    missing,
                });
                continue;
            }
            // One entry per FILE (#3907), so >1 entry means the record carried more than one test
            // file. Keep them distinct rather than letting the second silently overwrite the first.
            let suffix = if i == 0 { String::new() } else { format!(".{i}") };
            tests.push(PlannedTest {
                detail: format!("{spec} → {name}"),
                ext: t.get("ext").and_then(Value::as_str).filter(|e| is_module_ext(e)).map(String::from),
                rel: format!("{rel}{suffix}.test{}", test_ext(t, src)),
                src: rewrite_relative_imports(src, dir),
                spec: spec.clone(),
                name,
            });
        }
    }

    // ── EDGE tests (integration-tests-become-graph-edges) ────────────────────────────────────────
    let mut edge_tests = Vec::new();
    let mut edge_shadowed = Vec::new();
    let mut edge_unresolvable = Vec::new();
    for e in collect_edges(repo) {
        let id = e.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let list = e.get("tests").and_then(Value::as_array).cloned().unwrap_or_default();
        if id.is_empty() || list.is_empty() {
            continue;
        }
        let from = e.get("src").and_then(Value::as_str).unwrap_or("").trim().to_string();
        // Provenance is REQUIRED to emit, not optional. Without it there is no honest path to write
        // to, and guessing one is how a lib/ test loses its environment.
        if !from.starts_with("src/") {
            edge_unresolvable.push((
                id.clone(),
                format!("{id} — no `src` provenance, so there is no path to emit it at"),
            ));
            continue;
        }
        // The file still exists ⇒ IT is the copy that runs, exactly as for a node test.
        if repo.join(&from).exists() {
            edge_shadowed.push(id.clone());
            continue;
        }
        let members: Vec<String> = e
            .get("members")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|m| m.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let rel_base = strip_test_suffix(&from["src/".len()..]).to_string();
        let dir = rel_base.rfind('/').map_or("", |i| &rel_base[..i]).to_string();
        for (i, t) in list.iter().enumerate() {
            let src = t.get("src").and_then(Value::as_str).unwrap_or("");
            if src.trim().is_empty() {
                continue;
            }
            let missing: Vec<String> =
                dedupe_in_order(relative_specifiers(src).into_iter().map(|r| r.spec).collect())
                    .into_iter()
                    .filter(|r| !reachable(repo, &resolve_rel(&dir, r), &will_emit))
                    .collect();
            if !missing.is_empty() {
                edge_unresolvable
                    .push((id.clone(), format!("{id} — cannot resolve {}", missing.join(", "))));
                continue;
            }
            edge_tests.push(EdgeTest {
                detail: format!("{id} [{}]", members.join(" × ")),
                rel: edge_test_path(&from, i, t.get("ext").and_then(Value::as_str), src),
                src: rewrite_relative_imports(src, &dir),
                id: id.clone(),
                members: members.clone(),
            });
        }
    }

    Plan { modules, tests, shadowed, unresolvable, edge_tests, edge_shadowed, edge_unresolvable }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ext_for_names_tsx_only_for_something_shaped_like_a_tag() {
        assert_eq!(ext_for("const a = <div>x</div>;"), ".tsx");
        assert_eq!(ext_for("export function C() { return <Foo bar={1} />; }"), ".tsx");
        assert_eq!(ext_for("export const add = (a: number, b: number) => a + b;"), ".ts");
        assert_eq!(ext_for("if (a < b && c > d) {}"), ".ts", "a comparison is not a tag");
        assert_eq!(ext_for(""), ".ts");
        // THE FALSE POSITIVE THE CARRIED EXTENSION EXISTS TO OVERRIDE — an ordinary generic, which
        // this heuristic calls JSX. Measured wrong on 177 of 376 algorithm-subject tests.
        assert_eq!(ext_for("<T>(a: readonly T[]) => a"), ".tsx", "the known false positive");
    }

    #[test]
    fn edge_test_path_mirrors_the_provenance_and_disambiguates_a_second_file() {
        assert_eq!(edge_test_path("src/features/a/lib/x.test.ts", 0, None, "const a = 1;"), "features/a/lib/x.test.ts");
        assert_eq!(edge_test_path("src/features/a/lib/x.test.ts", 1, None, "const a = 1;"), "features/a/lib/x.1.test.ts");
        // The `/lib/` in the path is load-bearing: the vitest `node` project selects on it, and
        // parking edge tests under one synthetic folder would hand each a jsdom it does not need.
        assert!(edge_test_path("src/features/a/lib/x.test.ts", 0, None, "").contains("/lib/"));
    }

    #[test]
    fn edge_test_path_prefers_the_carried_extension_over_the_guess() {
        // `<T,>(a: readonly T[])` guesses `.tsx`; a record that KNOWS says `.ts` and wins.
        assert_eq!(edge_test_path("src/z.test.ts", 0, Some(".ts"), "<T,>(a: readonly T[]) => a"), "z.test.ts");
        // ...and a nonsense extension falls back to the guess rather than being trusted.
        assert_eq!(edge_test_path("src/z.test.ts", 0, Some(".exe"), "const a = 1;"), "z.test.ts");
        assert_eq!(edge_test_path("src/z.test.ts", 0, Some(".jsx"), "const a = 1;"), "z.test.jsx");

        // THE EXACT CASES carried over from `src/app/runtime/retiredTests.test.ts`, whose
        // `edgeTestPath` block this replaces. A generic arrow named `.tsx` fails to parse and
        // reports as a DEAD SUITE, which is the failure the carried extension exists to prevent.
        assert_eq!(edge_test_path("src/a/b.test.ts", 1, Some(".ts"), ""), "a/b.1.test.ts");
        assert_eq!(edge_test_path("src/a/b.test.ts", 0, None, "const f = <T>(x: T) => x;"), "a/b.test.tsx");
        assert_eq!(edge_test_path("src/a/b.test.ts", 0, Some(".ts"), "const f = <T>(x: T) => x;"), "a/b.test.ts");

        // The two REAL provenances the JavaScript block asserted, kept because they are the cases the
        // rule exists for: a `lib/` test must keep a path the vitest `node` project still selects, and
        // a `ui/` test must keep its `.tsx`.
        assert_eq!(
            edge_test_path("src/shared/lib/security/roleProfileConsistency.test.ts", 0, Some(".ts"), ""),
            "shared/lib/security/roleProfileConsistency.test.ts"
        );
        assert_eq!(
            edge_test_path("src/shared/ui/overlay/modalFocus.test.tsx", 0, Some(".tsx"), ""),
            "shared/ui/overlay/modalFocus.test.tsx"
        );
    }

    #[test]
    fn strip_test_suffix_removes_only_a_real_test_tail() {
        assert_eq!(strip_test_suffix("features/a/x.test.ts"), "features/a/x");
        assert_eq!(strip_test_suffix("features/a/x.spec.tsx"), "features/a/x");
        assert_eq!(strip_test_suffix("features/a/x.ts"), "features/a/x.ts", "not a test tail");
        assert_eq!(strip_test_suffix("features/testing/x.test.ts"), "features/testing/x");
    }

    #[test]
    fn resolve_rel_walks_the_directory_and_drops_the_alias() {
        assert_eq!(resolve_rel("shared/ui/controls", "./Button"), "shared/ui/controls/Button");
        assert_eq!(resolve_rel("shared/ui/controls", "../lib/x"), "shared/ui/lib/x");
        assert_eq!(resolve_rel("", "./Top"), "Top");
    }

    #[test]
    fn dedupe_in_order_keeps_the_first_occurrence() {
        assert_eq!(
            dedupe_in_order(vec!["./b".into(), "./a".into(), "./b".into(), "./c".into()]),
            vec!["./b", "./a", "./c"]
        );
    }

    #[test]
    fn suffixed_appends_rather_than_replacing_an_extension() {
        // `set_extension` would turn `x.fixtures` into `x.tsx` and probe a path nobody wrote.
        assert_eq!(suffixed(Path::new("/a/x.fixtures"), ".ts"), PathBuf::from("/a/x.fixtures.ts"));
        assert_eq!(suffixed(Path::new("/a/x"), "/index.tsx"), PathBuf::from("/a/x/index.tsx"));
    }

    #[test]
    fn rewrite_relative_imports_absolutizes_and_leaves_the_rest_alone() {
        let src = "import { A } from \"./A\";\nimport { B } from \"../lib/B\";\nimport { C } from \"@/x/C\";\n";
        let got = rewrite_relative_imports(src, "shared/ui/controls");
        assert!(got.contains("\"@/shared/ui/controls/A\""), "{got}");
        assert!(got.contains("\"@/shared/ui/lib/B\""), "{got}");
        assert!(got.contains("\"@/x/C\""), "an already-absolute specifier is untouched: {got}");
    }
}
