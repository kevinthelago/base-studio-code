//! The ONE import scan — what a record's source actually `require()`s once the bundler is done with it.
//!
//! # Why this exists
//!
//! This repo was running THREE import scanners and they disagreed on 7 of the 11 cases first measured,
//! with no one of them right on all:
//!
//! | case              | TS `parseImports`  | [`crate::emit`] `import_specifiers` | [`crate::harvest`] `internal_imports` |
//! |-------------------|--------------------|-------------------------------------|---------------------------------------|
//! | `export … from`   | seen               | seen                                | **MISS**                              |
//! | `export *`        | seen               | seen                                | **MISS**                              |
//! | type-only         | erased             | **FALSE POSITIVE**                   | flagged                               |
//! | dynamic `import()`| **MISS**           | seen                                | **MISS**                              |
//! | `from` in comment | ignored            | **FALSE POSITIVE**                   | ignored                               |
//! | `from` in string  | ignored            | **FALSE POSITIVE**                   | ignored                               |
//!
//! `import_specifiers` WAS a raw keyword-SUBSTRING scan, so prose and string literals read as imports and
//! type-only imports the bundler erases were counted; slice 2 pointed emit here and DELETED it, so the
//! third column above is history. `internal_imports` is tree-sitter and clean but walks
//! only `import_statement`, so every re-export is invisible — the exact gap the TypeScript names as
//! having shipped `projectspage` broken (#3874). Both were on LIVE paths: emit resolved a component's
//! closure from the first (fixed — `emit-vendors-a-closure-from-a-substring-scan`), harvest still computes
//! its buildability verdict from the second.
//!
//! # What "right" means here, precisely
//!
//! An import counts when the COMPILED module will `require()` it. That is a syntactic question with an
//! exact answer, which is why this is a parser and not a regex:
//!
//! * A re-export IS an import. esbuild compiles `export { X } from "./y"` to the same `require("./y")`,
//!   so a scanner blind to it certifies a closure that cannot load.
//! * A syntactically type-only import is NOT one. `import type { T } from "./t"` and a clause whose every
//!   binding carries the inline `type` modifier are both erased before anything resolves, so the module
//!   need not exist. SYNTACTIC on purpose, never inferred from the target: `import { X } from "./y"` where
//!   `X` happens to be a type is NOT erasable, because esbuild has no type information and keeps it.
//! * A dynamic `import()` IS one, and is the thing the anchored regex cannot see.
//! * A `from` inside a comment or a string is not anything. This is not hypothetical — records in this
//!   tree carry provenance headers that name a specifier in prose.
//!
//! # Its relationship to the TypeScript
//!
//! `importScan.fixtures.json` is generated from the live `parseImports` and this scanner is proved
//! against it case by case, so "right" gets an independent second opinion rather than resting on the
//! author's reading. Two cases diverge DELIBERATELY, and the fixture records the TypeScript's own answer
//! for both so the divergence lives in the artifact instead of in a Rust-only expectation: the dynamic
//! import (the regex cannot see it) and the ordering of a bare import (the TypeScript runs its two
//! regexes in sequence, so a leading side-effect import is reported last). Both are the TypeScript being
//! wrong, and both are pinned so a future edit cannot quietly change which side moved.

use tree_sitter::{Language, Node, Parser};

/// One module specifier a source imports, and the symbols it takes from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportRef {
    pub specifier: String,
    /// Imported names as written on the MODULE's side (`{ a as b }` → `a`). A namespace import is `*`,
    /// a default import is `default`, and a bare side-effect import has none.
    pub symbols: Vec<String>,
}

/// Every module specifier `source` will `require()` at runtime, in SOURCE order.
///
/// Returns an empty vec when the source cannot be parsed at all — a scan is a report, and a caller
/// sweeping hundreds of records must not stop at one bad file. (Note that tree-sitter is
/// error-tolerant, so this is close to unreachable in practice: a syntactically broken file still
/// yields a tree, and the imports it *can* see are still reported.)
pub fn scan_imports(source: &str) -> Vec<ImportRef> {
    let mut parser = Parser::new();
    let language: Language = tree_sitter_typescript::LANGUAGE_TSX.into();
    if parser.set_language(&language).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(source, None) else { return Vec::new() };
    let src = source.as_bytes();
    let mut out = Vec::new();
    walk(tree.root_node(), src, &mut out);
    out
}

/// Depth-first over the whole tree. `import`/`export` statements are top-level in ESM, but a dynamic
/// `import()` is an ordinary expression and can be anywhere, so the walk cannot stop at the root's
/// children — which is one of the two things `internal_imports` gets wrong.
fn walk(node: Node, src: &[u8], out: &mut Vec<ImportRef>) {
    match node.kind() {
        "import_statement" => {
            if let Some(r) = import_statement(node, src) {
                out.push(r);
            }
            return; // nothing inside an import statement is another import
        }
        "export_statement" => {
            // Only a re-export — one with a `source` — is an import. A plain `export function f() {}`
            // has no source and is not.
            if node.child_by_field_name("source").is_some() {
                if let Some(r) = export_statement(node, src) {
                    out.push(r);
                }
                return;
            }
            // `export function f() { await import("./x") }` — fall through and keep walking.
        }
        "call_expression" => {
            if let Some(r) = dynamic_import(node, src) {
                out.push(r);
                // Keep walking: the ARGUMENT may itself contain another call.
            }
        }
        _ => {}
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk(child, src, out);
    }
}

/// `import … from "x"` / `import "x"`. `None` when the import is syntactically type-only.
fn import_statement(node: Node, src: &[u8]) -> Option<ImportRef> {
    let specifier = source_text(node, src)?;
    if is_type_only(node, src) {
        return None;
    }
    let mut symbols = Vec::new();
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "import_clause" {
            clause_symbols(child, src, &mut symbols);
        }
    }
    Some(ImportRef { specifier, symbols })
}

/// `export { X } from "y"` / `export * from "y"` / `export * as ns from "y"`. `None` when type-only.
fn export_statement(node: Node, src: &[u8]) -> Option<ImportRef> {
    let specifier = source_text(node, src)?;
    if is_type_only(node, src) {
        return None;
    }
    let mut symbols = Vec::new();
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            // `export * from` — the star is a bare token; `export * as ns from` is a namespace_export.
            // Both take everything, so both are `*`, matching the TypeScript's head-starts-with-`*` rule.
            "*" | "namespace_export" => symbols.push("*".to_string()),
            "export_clause" => named_symbols(child, src, &mut symbols),
            _ => {}
        }
    }
    Some(ImportRef { specifier, symbols })
}

/// `import("x")` with a literal specifier. A computed one (`import(name)`) is unknowable statically and
/// is reported as nothing rather than guessed — the honest answer, and the same one every bundler gives.
fn dynamic_import(node: Node, src: &[u8]) -> Option<ImportRef> {
    let func = node.child_by_field_name("function")?;
    if func.kind() != "import" {
        return None;
    }
    let args = node.child_by_field_name("arguments")?;
    let mut cursor = args.walk();
    for child in args.children(&mut cursor) {
        if child.kind() == "string" {
            return Some(ImportRef { specifier: unquote(child.utf8_text(src).ok()?), symbols: Vec::new() });
        }
    }
    None
}

/// The statement's quoted module specifier, unquoted.
fn source_text(node: Node, src: &[u8]) -> Option<String> {
    Some(unquote(node.child_by_field_name("source")?.utf8_text(src).ok()?))
}

fn unquote(s: &str) -> String {
    s.trim_matches(|c| c == '"' || c == '\'').to_string()
}

/// Is this statement SYNTACTICALLY type-only — `import type { T } from …` / `export type { T } from …`,
/// or a named clause whose every binding carries the inline `type` modifier?
///
/// A clause with a default or namespace binding is never type-only, and an EMPTY named clause is not
/// either: `import {} from "./x"` still emits a require.
fn is_type_only(node: Node, src: &[u8]) -> bool {
    let mut cursor = node.walk();
    let mut named: Option<Node> = None;
    for child in node.children(&mut cursor) {
        match child.kind() {
            // The statement-level `type` keyword, before any clause.
            _ if child.utf8_text(src).map(str::trim) == Ok("type") && child.kind() == "type" => return true,
            "import_clause" => {
                let mut cc = child.walk();
                for g in child.children(&mut cc) {
                    match g.kind() {
                        "named_imports" => named = Some(g),
                        "identifier" | "namespace_import" => return false,
                        _ => {}
                    }
                }
            }
            "export_clause" => named = Some(child),
            "namespace_export" | "*" => return false,
            _ => {}
        }
    }
    let Some(named) = named else { return false };
    let mut any = false;
    let mut nc = named.walk();
    for spec in named.children(&mut nc) {
        if !matches!(spec.kind(), "import_specifier" | "export_specifier") {
            continue;
        }
        any = true;
        if !spec.utf8_text(src).unwrap_or_default().trim_start().starts_with("type ") {
            return false;
        }
    }
    any
}

/// The names an `import_clause` binds: a default import contributes `default`, a namespace import `*`,
/// and a named list contributes each binding's module-side name.
fn clause_symbols(clause: Node, src: &[u8], out: &mut Vec<String>) {
    let mut cursor = clause.walk();
    for child in clause.children(&mut cursor) {
        match child.kind() {
            "identifier" => out.push("default".to_string()),
            "namespace_import" => out.push("*".to_string()),
            "named_imports" => named_symbols(child, src, out),
            _ => {}
        }
    }
}

/// Each specifier's module-side name, with an inline `type ` modifier stripped — matching the
/// TypeScript, which keeps a mixed clause and reports its value bindings under their bare names.
fn named_symbols(list: Node, src: &[u8], out: &mut Vec<String>) {
    let mut cursor = list.walk();
    for spec in list.children(&mut cursor) {
        if !matches!(spec.kind(), "import_specifier" | "export_specifier") {
            continue;
        }
        let Some(name) = spec.child_by_field_name("name") else { continue };
        if let Ok(text) = name.utf8_text(src) {
            out.push(text.trim().to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fixture is GENERATED from the live TypeScript (`importScan.fixtures.gen.test.ts`), so this
    /// proves Rust equals what the renderer actually does today — not what its author believed it did.
    /// Located by filename under `src/`, the convention the tunnel and planner contracts already use, so
    /// moving a feature slice does not break this test but RENAMING the fixture does (deliberately).
    fn fixture() -> serde_json::Value {
        fn find(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    find(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("importScan.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        find(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one importScan.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// The two labels whose TypeScript answer this scanner deliberately does NOT reproduce, because on
    /// both the TypeScript is wrong. Named by their fixture label so the exemption cannot silently widen
    /// to a case it was never argued for — adding a third requires editing this list and saying why.
    const INTENDED_DIVERGENCES: &[(&str, &str)] = &[
        (
            "a dynamic import — the regex cannot see it",
            "the anchored regex cannot see `import(\"x\")`; a dynamic import IS a require and this scanner reports it",
        ),
        (
            "a bare import BEFORE a named one",
            "the TypeScript runs its two regexes in sequence, so a leading side-effect import is reported LAST; this scanner reports source order",
        ),
    ];

    fn parsed(case: &serde_json::Value) -> Vec<ImportRef> {
        case["imports"]
            .as_array()
            .expect("imports")
            .iter()
            .map(|i| ImportRef {
                specifier: i["specifier"].as_str().unwrap().to_string(),
                symbols: i["symbols"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_str().unwrap().to_string())
                    .collect(),
            })
            .collect()
    }

    /// Reports EVERY mismatch at once rather than dying on the first — when a port is wrong it is
    /// usually wrong in a PATTERN, and one failing assertion hides the shape of it.
    #[test]
    fn the_scanner_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 25, "fixture shrank to {} cases — regenerate it", cases.len());

        let mut mismatches = Vec::new();
        let mut checked = 0usize;
        for case in cases {
            let label = case["label"].as_str().unwrap();
            if INTENDED_DIVERGENCES.iter().any(|(l, _)| *l == label) {
                continue;
            }
            checked += 1;
            let want = parsed(case);
            let got = scan_imports(case["source"].as_str().unwrap());
            if got != want {
                mismatches.push(format!("  {label}\n    ts   {want:?}\n    rust {got:?}"));
            }
        }
        assert!(
            checked >= 25,
            "only {checked} cases were actually compared — an exemption list that swallowed the suite \
             would make this test vacuous"
        );
        assert!(
            mismatches.is_empty(),
            "the Rust scanner disagrees with the live TypeScript on {} of {checked} cases:\n{}",
            mismatches.len(),
            mismatches.join("\n")
        );
    }

    /// The exempted cases must ACTUALLY diverge. Without this, an exemption is a place a real regression
    /// can hide: if the scanner were "fixed" to reproduce the TypeScript's bug, the parity test above
    /// would skip it and stay green.
    #[test]
    fn every_intended_divergence_actually_diverges() {
        let doc = fixture();
        let cases = doc["cases"].as_array().expect("cases");
        for (label, why) in INTENDED_DIVERGENCES {
            let case = cases
                .iter()
                .find(|c| c["label"].as_str() == Some(label))
                .unwrap_or_else(|| panic!("no fixture case labelled {label:?} — the exemption is stale"));
            let ts = parsed(case);
            let rust = scan_imports(case["source"].as_str().unwrap());
            assert_ne!(rust, ts, "{label}: expected to diverge ({why}) but the two now agree");
        }
    }

    /// Each intended divergence, pinned to the value this scanner gives — an inequality alone would let
    /// the answer be anything at all as long as it was not the TypeScript's.
    #[test]
    fn the_divergences_give_the_right_answer_not_merely_a_different_one() {
        let dynamic = scan_imports("const m = await import(\"./lazy\");\n");
        assert_eq!(dynamic, vec![ImportRef { specifier: "./lazy".into(), symbols: vec![] }]);

        let ordered = scan_imports("import \"./a.css\";\nimport { B } from \"./b\";\n");
        assert_eq!(
            ordered.iter().map(|i| i.specifier.as_str()).collect::<Vec<_>>(),
            vec!["./a.css", "./b"],
            "source order, not regex-pass order"
        );
    }

    /// The three cases the OTHER two Rust scanners get wrong, asserted directly. The parity test covers
    /// them through the fixture, but naming them here is what a reader of slices 2 and 3 comes looking
    /// for — this is the behaviour those flips are buying.
    #[test]
    fn it_fixes_what_the_other_two_rust_scanners_get_wrong() {
        // harvest::internal_imports walks only `import_statement`, so both of these are invisible to it.
        assert_eq!(
            scan_imports("export { ProjectRow } from \"./published/ProjectRow\";\n"),
            vec![ImportRef { specifier: "./published/ProjectRow".into(), symbols: vec!["ProjectRow".into()] }],
            "a re-export compiles to the same require an import does (#3874)"
        );
        assert_eq!(
            scan_imports("export * from \"./a\";\n"),
            vec![ImportRef { specifier: "./a".into(), symbols: vec!["*".into()] }]
        );

        // All three of these were false positives in emit's old substring scan.
        assert!(
            scan_imports("// see the note from \"./ghost\" for why\n").is_empty(),
            "prose is not an import — records in this tree carry provenance headers"
        );
        assert!(scan_imports("const s = 'from \"./strghost\"';\n").is_empty(), "a string literal is not an import");
        assert!(
            scan_imports("import type { T } from \"./t\";\n").is_empty(),
            "a type-only import is erased before anything resolves"
        );
    }

    /// Type-only detection is SYNTACTIC, never inferred from the target — esbuild has no type
    /// information, so an import of something that happens to be a type still emits a require.
    #[test]
    fn type_only_is_syntactic_and_a_mixed_clause_survives() {
        assert!(scan_imports("import { type A, type B } from \"./ab\";\n").is_empty());
        assert_eq!(
            scan_imports("import { type A, b } from \"./ab\";\n"),
            vec![ImportRef { specifier: "./ab".into(), symbols: vec!["A".into(), "b".into()] }],
            "one value binding keeps the whole import"
        );
        assert_eq!(
            scan_imports("import { T } from \"./t\";\n").len(),
            1,
            "a value-syntax import of a type is NOT erasable"
        );
        assert!(scan_imports("export type { T } from \"./t\";\n").is_empty());
        assert_eq!(
            scan_imports("import {} from \"./x\";\n").len(),
            1,
            "an EMPTY clause is not type-only — it still emits a require"
        );
    }

    /// A dynamic import nested inside a function body — the reason the walk cannot stop at the root's
    /// children, and a shape a lazy-loaded page actually has.
    #[test]
    fn a_nested_dynamic_import_is_found_and_a_computed_one_is_not_guessed() {
        let nested = scan_imports("export function load() {\n  return import(\"./page\");\n}\n");
        assert_eq!(nested, vec![ImportRef { specifier: "./page".into(), symbols: vec![] }]);
        assert!(
            scan_imports("const n = \"x\";\nconst m = await import(n);\n").is_empty(),
            "a computed specifier is unknowable statically and is reported as nothing, never guessed"
        );
    }

    /// An unparseable source reports what it can rather than throwing — a sweep over hundreds of records
    /// must not stop at one bad file.
    #[test]
    fn a_broken_source_still_reports_what_it_can() {
        let got = scan_imports("import { X } from \"./x\";\nfunction ( { { {\n");
        assert_eq!(got.len(), 1, "the valid import above the damage is still reported: {got:?}");
    }
}

/// WHAT THE OTHER TWO SCANNERS ANSWER TODAY — a characterization test, not an aspiration.
///
/// Slices 2 and 3 flip [`crate::emit`] and [`crate::harvest`] onto [`scan_imports`]. The value of a flip
/// is the set of answers it CHANGES, and that set is only legible if today's answers are written down
/// before it happens. So this pins the current behaviour of both, defects included, and each defective
/// expectation says so in place.
///
/// It is deliberately not phrased as "these are wrong". A characterization test that asserted the right
/// answer would be red from the moment it was written and would have to be disabled to land, which is how
/// a known defect becomes an ignored one.
#[cfg(test)]
mod existing_scanners {
    use super::scan_imports;
    use crate::harvest::internal_imports;

    /// The four cases emit used to get wrong, now stated as the answers it gives.
    ///
    /// THIS IS THE SAME TEST, UPDATED — not a new one, and not the old one deleted. It was written as a
    /// characterization test asserting emit's WRONG answers (`import_specifiers` was a keyword-SUBSTRING
    /// scan: `./ghost` out of a comment, `./strghost` out of a string literal, and two type-only imports
    /// the bundler erases), so that the defect could not change unnoticed. Slice 2 pointed emit at
    /// `scan_imports` and deleted that scanner, so the four cases keep their place here and their
    /// expectations flip. Reading the diff of this function IS the behaviour change.
    ///
    /// What emit got right — a re-export and a dynamic import — is asserted below, because a flip that
    /// fixed the false positives by losing a true positive would be a worse scanner, not a better one.
    #[test]
    fn emit_no_longer_reports_the_four_things_that_are_not_imports() {
        let specs = |src: &str| -> Vec<String> { scan_imports(src).into_iter().map(|i| i.specifier).collect() };

        assert_eq!(
            specs("// see the note from \"./ghost\" for why\nimport { X } from \"./x\";\n"),
            vec!["./x"],
            "was [./ghost, ./x] — prose is not an import"
        );
        assert_eq!(
            specs("const s = 'from \"./strghost\"';\nimport { X } from \"./x\";\n"),
            vec!["./x"],
            "was [./strghost, ./x] — a string literal is not an import"
        );
        assert!(
            specs("import type { T } from \"./t\";\n").is_empty(),
            "was [./t] — a type-only import is erased by the bundler and never required"
        );
        assert!(
            specs("import { type A, type B } from \"./ab\";\n").is_empty(),
            "was [./ab] — an all-inline-type clause is erased too"
        );

        // What it already got right, and what the flip had to PRESERVE.
        assert_eq!(specs("export { X } from \"./y\";\n"), vec!["./y"], "re-export: still seen");
        assert_eq!(specs("const m = await import(\"./lazy\");\n"), vec!["./lazy"], "dynamic: still seen");
    }

    /// `harvest::internal_imports` is tree-sitter and therefore immune to the prose and string cases, but
    /// it iterates only the root's `import_statement` children.
    #[test]
    fn harvest_scanner_cannot_see_a_re_export_or_a_dynamic_import() {
        let specs = |src: &str| -> Vec<String> { internal_imports(src).into_iter().map(|i| i.spec).collect() };

        assert!(
            specs("export { ProjectRow } from \"./published/ProjectRow\";\n").is_empty(),
            "DEFECT: a re-export compiles to the same require an import does, so a component whose \
             closure needs a re-exported sibling is certified buildable when it is not (#3874)"
        );
        assert!(specs("export * from \"./a\";\n").is_empty(), "DEFECT: export-star is invisible too");
        assert!(
            specs("export function load() {\n  return import(\"./page\");\n}\n").is_empty(),
            "DEFECT: a dynamic import is invisible — the walk stops at the root's children"
        );

        // Immune to the two cases that fool the substring scan, and correct on type-only.
        assert_eq!(specs("// lifted from \"./ghost\"\nimport { X } from \"./x\";\n"), vec!["./x"]);
        assert!(internal_imports("import type { T } from \"./t\";\n")[0].type_only, "type-only: flagged");
    }

    /// The roll-up: on the eleven cases first measured, how many of the remaining scanners disagree with
    /// the canonical one. This is the number slices 2 and 3 move, and pinning it means a partial flip
    /// cannot be mistaken for a whole one.
    ///
    /// SLICE 2 MOVED IT FROM SEVEN TO THREE. Emit had four disagreements, all false positives, and it no
    /// longer has a scanner of its own to disagree with — `import_specifiers` is deleted, so its column
    /// is not zero, it is absent. What is left is harvest's three, all misses, which is slice 3.
    #[test]
    fn one_remaining_scanner_disagrees_with_the_canonical_one_on_three_of_eleven_cases() {
        const CASES: &[&str] = &[
            "export { ProjectRow } from \"./published/ProjectRow\";\n",
            "export * from \"./a\";\n",
            "import { X } from \"./x\";\n",
            "import type { T } from \"./t\";\n",
            "import { type A, type B } from \"./ab\";\n",
            "import { type A, b } from \"./ab\";\n",
            "import \"./a.css\";\n",
            "const m = await import(\"./lazy\");\n",
            "// see the note from \"./ghost\" for why\nimport { X } from \"./x\";\n",
            "const s = 'from \"./strghost\"';\nimport { X } from \"./x\";\n",
            "function f() {\n  const m = require(\"./r\");\n}\nimport { X } from \"./x\";\n",
        ];
        let mut harvest_differs = 0;
        for src in CASES {
            let canonical: Vec<String> = scan_imports(src).into_iter().map(|i| i.specifier).collect();
            // Harvest is compared on its NON-type-only imports, which is the fair comparison: its
            // contract is a spec plus a `type_only` FLAG and its caller filters on that, so counting a
            // correctly-flagged type-only import as a disagreement would charge it for being right.
            let harvested: Vec<String> =
                internal_imports(src).into_iter().filter(|i| !i.type_only).map(|i| i.spec).collect();
            if harvested != canonical {
                harvest_differs += 1;
            }
        }
        assert_eq!(harvest_differs, 3, "harvest disagrees on three — all misses");
        // Emit's four and harvest's three overlapped nowhere, which is why the count was SEVEN of eleven
        // rather than six — the first pass of this arithmetic said six and this assertion caught it.
        // With emit on the canonical scanner, the four are gone and the three that remain are harvest's.
        let mut disagreeing = 0;
        for src in CASES {
            let canonical: Vec<String> = scan_imports(src).into_iter().map(|i| i.specifier).collect();
            let harvested: Vec<String> =
                internal_imports(src).into_iter().filter(|i| !i.type_only).map(|i| i.spec).collect();
            if harvested != canonical {
                disagreeing += 1;
            }
        }
        assert_eq!(disagreeing, 3, "three of the eleven cases still have a scanner disagreeing — all harvest\'s");
    }
}
