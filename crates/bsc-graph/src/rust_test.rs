//! The Rust half of `bsc graph test` — materialize ONE record into its own crate and compile it there.
//!
//! `single_record_test` was hardcoded TypeScript: it wrote `{stem}.ts`, generated a `vitest.config.ts`
//! and shelled to `npx vitest`. Handed a Rust node it wrote Rust source into a `.ts` file, so no Rust
//! record in this library had ever been compiled — which is how `unquote.rs` shipped carrying a unicode
//! escape inside a byte literal, something rustc rejects outright.
//!
//! # The materialization convention is FLAT, and that is measured rather than chosen
//!
//! The obvious shape — one composed record per submodule — is wrong here, and wrong in the expensive
//! direction: it reports the RECORDS as broken when the harness is. Measured over the 83 rust nodes in
//! this repo's store, nesting gave 65/83 while the flat convention plus derived imports gives 83/83.
//!
//! * Records call composed siblings by **bare name** (`magnitude` calls `dot_product(v, v)`), so the
//!   whole `role: algorithm` closure is concatenated into ONE scope. A `use crate::…` line — the one
//!   record that carries one — is dropped, because under a flat scope the sibling is already in scope.
//! * A `role: primitive` member is never materialized: it DESCRIBES a language built-in via `--ref`
//!   (#2972). Instead its `ref` supplies the import, so `composes: [rust.hashmap]` yields
//!   `use std::collections::HashMap;`. A `ref` with no `::` (`i64`, `bool`, `&[T]`) needs none.
//! * Those derived imports are deduped against what the code already imports, by LEAF name and
//!   handling the braced form, or rustc rejects the duplicate (E0252).
//!
//! The consequence worth stating: a node's compile closure is fully determined by data already on the
//! node. Nothing has to be guessed, which is what makes a compile a trustworthy verdict here.
//!
//! # Why a compile counts as a verdict
//!
//! The TypeScript path refuses a record with no paired test, because a vacuous pass is worse than a
//! refusal. Rust is different: a compile is itself a real check — it is exactly what catches the
//! byte-literal defect above — so a testless Rust node is COMPILED and reported as compiled. Only 18 of
//! this store's 96 Rust nodes carry a test at all.
//!
//! # And why most of those 18 tests do not run
//!
//! Every one of them carries the WHOLE harvested source file as its "test" (`levenshtein-distance.rs`
//! is paired with all of `similarity.rs`), because Rust keeps tests inline in `#[cfg(test)] mod tests`
//! and the colocated-test harvest — correct for a separate `*.test.ts` — takes the file. So the
//! `#[cfg(test)]` blocks are EXTRACTED and the surrounding module is left behind. A block that then
//! reaches for functions the record does not carry fails to compile, and that failure is the honest
//! answer: this record is not self-contained enough to be tested alone.

use serde_json::Value;
use std::collections::HashSet;

/// A record's transitive closure, split by what each half contributes to the materialized crate.
pub struct Closure<'a> {
    /// `role: algorithm` members — concatenated into one flat scope, the root last.
    pub algorithms: Vec<&'a Value>,
    /// `role: primitive` members — never re-coded; each contributes its `ref` as an import.
    pub primitives: Vec<&'a Value>,
}

fn field<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// Walk `composes` transitively. Cycle-safe: a record already seen is never re-entered, so a mutual
/// `composes` pair terminates instead of spinning.
pub fn closure_of<'a>(impls: &[&'a Value], root_id: &str) -> Closure<'a> {
    let find = |id: &str| impls.iter().find(|i| field(i, "id") == Some(id)).copied();
    let mut seen: HashSet<String> = HashSet::new();
    let (mut algorithms, mut primitives) = (Vec::new(), Vec::new());
    let mut stack = vec![root_id.to_string()];
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some(rec) = find(&id) else { continue };
        if field(rec, "role") == Some("primitive") {
            primitives.push(rec);
            continue;
        }
        for dep in rec.get("composes").and_then(Value::as_array).into_iter().flatten() {
            if let Some(d) = dep.as_str() {
                stack.push(d.to_string());
            }
        }
        algorithms.push(rec);
    }
    // The root goes LAST so the file reads dependencies-first. Order is irrelevant to rustc.
    algorithms.sort_by_key(|r| field(r, "id") == Some(root_id));
    Closure { algorithms, primitives }
}

/// Names a body already imports, including the braced form `use std::collections::{HashMap, HashSet};`.
pub fn imported_names(code: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    for line in code.lines() {
        let t = line.trim();
        let Some(rest) = t.strip_prefix("use ") else { continue };
        let Some(path) = rest.split(';').next() else { continue };
        match (path.find('{'), path.rfind('}')) {
            (Some(a), Some(b)) if b > a => {
                for part in path[a + 1..b].split(',') {
                    if let Some(leaf) = part.trim().rsplit("::").next() {
                        if !leaf.is_empty() {
                            names.insert(leaf.to_string());
                        }
                    }
                }
            }
            _ => {
                if let Some(leaf) = path.trim().rsplit("::").next() {
                    if !leaf.is_empty() {
                        names.insert(leaf.to_string());
                    }
                }
            }
        }
    }
    names
}

/// `use` lines the closure's primitives imply, minus anything the code already imports.
///
/// A `ref` without `::` is a language primitive (`i64`, `bool`, `f64`, `&[T]`) — it names a type that
/// needs no import, and emitting one would not even parse.
pub fn imports_for(primitives: &[&Value], existing: &HashSet<String>) -> Vec<String> {
    let mut paths: Vec<String> = primitives
        .iter()
        .filter_map(|p| field(p, "ref"))
        .filter(|r| r.contains("::"))
        .filter(|r| !existing.contains(r.rsplit("::").next().unwrap_or_default()))
        .map(str::to_string)
        .collect();
    paths.sort();
    paths.dedup();
    paths.into_iter().map(|p| format!("use {p};")).collect()
}

/// Drop a qualified sibling import — under a flat scope the sibling is already in scope, and the
/// module path it names (`crate::merge::merge`) does not exist in the materialized crate.
pub fn drop_crate_uses(code: &str) -> String {
    code.lines()
        .filter(|l| {
            let t = l.trim();
            !(t.starts_with("use crate::") || t.starts_with("use super::") || t.starts_with("use self::"))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Extract every `#[cfg(test)]`-attributed module from a paired test, by balanced braces.
///
/// A Rust record's "test" is the whole harvested FILE (tests live inline in Rust), so appending it
/// verbatim would bring the entire original module — imports, types, siblings — into a crate meant to
/// hold one implementation. Only the test modules are wanted.
pub fn extract_test_modules(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes: Vec<char> = src.chars().collect();
    let mut search_from = 0usize;
    while let Some(rel) = src[search_from..].find("#[cfg(test)]") {
        let attr_at = search_from + rel;
        // The module's opening brace is the first `{` after the attribute.
        let Some(brace_rel) = src[attr_at..].find('{') else { break };
        let open = attr_at + brace_rel;
        let open_idx = src[..open].chars().count();
        let mut depth = 0i32;
        let mut end_idx = None;
        for (i, ch) in bytes.iter().enumerate().skip(open_idx) {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end_idx = Some(i);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(end_idx) = end_idx else { break };
        let start_byte = attr_at;
        let end_byte = bytes[..=end_idx].iter().map(|c| c.len_utf8()).sum::<usize>();
        out.push(src[start_byte..end_byte].to_string());
        search_from = end_byte;
    }
    out
}

/// The `src/lib.rs` of the materialized crate: derived imports, then the flat closure, then any
/// extracted test modules.
pub fn materialize(closure: &Closure, test_modules: &[String]) -> String {
    let bodies: Vec<String> = closure
        .algorithms
        .iter()
        .map(|a| drop_crate_uses(field(a, "code").unwrap_or_default()))
        .collect();
    let joined = bodies.join("\n");
    let mut out = String::from("#![allow(dead_code, unused_imports, unused_mut)]\n");
    for imp in imports_for(&closure.primitives, &imported_names(&joined)) {
        out.push_str(&imp);
        out.push('\n');
    }
    out.push('\n');
    out.push_str(&joined);
    out.push('\n');
    for m in test_modules {
        out.push('\n');
        out.push_str(m);
        out.push('\n');
    }
    out
}

/// A crate name rustc will accept: the id already carries `.rs`, and a second one makes the crate name
/// `merge.rs`, which is refused outright ("invalid character '.' in crate name").
pub fn crate_name(id: &str) -> String {
    let stem = id.strip_suffix(".rs").unwrap_or(id);
    let s: String =
        stem.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    if s.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        format!("n{s}")
    } else {
        s
    }
}

/// The manifest for a materialized record. No dependencies by construction: a `role: algorithm` record
/// composes only other records and language primitives, so anything it needs is either in the flat
/// scope or in std. A record that reached for an external crate would fail to compile here, which is
/// the isolation working rather than a gap in it.
pub fn cargo_toml(name: &str) -> String {
    format!("[package]\nname = \"{name}\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\n[dependencies]\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn algo(id: &str, code: &str, composes: &[&str]) -> Value {
        json!({ "id": id, "role": "algorithm", "tech": "rust", "code": code, "composes": composes })
    }
    fn prim(id: &str, r: &str) -> Value {
        json!({ "id": id, "role": "primitive", "tech": "rust", "ref": r })
    }
    fn refs(v: &[Value]) -> Vec<&Value> {
        v.iter().collect()
    }

    #[test]
    fn closure_walks_composes_and_keeps_primitives_out_of_the_materialized_set() {
        let v = vec![
            algo("a.rs", "fn a() {}", &["b.rs", "rust.vec"]),
            algo("b.rs", "fn b() {}", &["rust.hashmap"]),
            prim("rust.vec", "std::vec::Vec"),
            prim("rust.hashmap", "std::collections::HashMap"),
        ];
        let c = closure_of(&refs(&v), "a.rs");
        let mut ids: Vec<&str> = c.algorithms.iter().filter_map(|r| field(r, "id")).collect();
        ids.sort();
        assert_eq!(ids, vec!["a.rs", "b.rs"]);
        let mut prims: Vec<&str> = c.primitives.iter().filter_map(|r| field(r, "id")).collect();
        prims.sort();
        assert_eq!(prims, vec!["rust.hashmap", "rust.vec"]);
        // The root is materialized LAST so the file reads dependencies-first.
        assert_eq!(field(c.algorithms.last().unwrap(), "id"), Some("a.rs"));
    }

    #[test]
    fn a_composes_cycle_terminates_rather_than_spinning() {
        let v = vec![algo("a.rs", "fn a() {}", &["b.rs"]), algo("b.rs", "fn b() {}", &["a.rs"])];
        assert_eq!(closure_of(&refs(&v), "a.rs").algorithms.len(), 2);
    }

    #[test]
    fn a_composes_entry_the_store_does_not_have_is_ignored() {
        let v = vec![algo("a.rs", "fn a() {}", &["ghost.rs"])];
        assert_eq!(closure_of(&refs(&v), "a.rs").algorithms.len(), 1);
    }

    #[test]
    fn imported_names_reads_the_braced_form_the_real_records_use() {
        let n = imported_names("use std::collections::{HashMap, HashSet};");
        assert!(n.contains("HashMap") && n.contains("HashSet"), "{n:?}");
        assert!(imported_names("use std::collections::VecDeque;").contains("VecDeque"));
    }

    #[test]
    fn a_primitive_supplies_its_import_and_a_language_type_supplies_none() {
        let v = vec![prim("rust.hashmap", "std::collections::HashMap"), prim("rust.i64", "i64")];
        let got = imports_for(&refs(&v), &HashSet::new());
        assert_eq!(got, vec!["use std::collections::HashMap;"]);
    }

    /// The duplicate rustc rejects (E0252) — and the harness's error to avoid, not the record's.
    #[test]
    fn a_derived_import_is_not_restated_when_the_code_already_has_it() {
        let v = vec![prim("rust.hashmap", "std::collections::HashMap")];
        let existing = imported_names("use std::collections::{HashMap, HashSet};");
        assert!(imports_for(&refs(&v), &existing).is_empty());
    }

    #[test]
    fn a_qualified_sibling_import_is_dropped_because_the_scope_is_flat() {
        let got = drop_crate_uses("use crate::merge::merge;\nfn merge_sort() { merge(); }");
        assert!(!got.contains("use crate::"), "{got}");
        assert!(got.contains("fn merge_sort()"));
    }

    /// The whole point of the flat convention: a bare sibling call must resolve.
    #[test]
    fn the_closure_materializes_flat_with_no_submodule_wrapper() {
        let v = vec![
            algo("magnitude.rs", "fn magnitude(v: &[f64]) -> f64 { dot_product(v, v).sqrt() }", &["dot-product.rs"]),
            algo("dot-product.rs", "fn dot_product(a: &[f64], b: &[f64]) -> f64 { 0.0 }", &[]),
        ];
        let out = materialize(&closure_of(&refs(&v), "magnitude.rs"), &[]);
        assert!(out.contains("fn dot_product"), "{out}");
        assert!(out.contains("fn magnitude"), "{out}");
        assert!(!out.contains("mod dot_product"), "must NOT nest: {out}");
    }

    #[test]
    fn a_primitives_import_reaches_the_materialized_file() {
        let v = vec![
            algo("wf.rs", "fn wf() -> HashMap<String, u64> { HashMap::new() }", &["rust.hashmap"]),
            prim("rust.hashmap", "std::collections::HashMap"),
        ];
        let out = materialize(&closure_of(&refs(&v), "wf.rs"), &[]);
        assert!(out.contains("use std::collections::HashMap;"), "{out}");
    }

    #[test]
    fn only_the_cfg_test_module_is_taken_from_a_whole_harvested_file() {
        let file = "//! docs\nuse crate::thing;\n\npub fn f() {}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn t() { assert!(f() == ()); }\n}\n";
        let got = extract_test_modules(file);
        assert_eq!(got.len(), 1, "{got:?}");
        assert!(got[0].starts_with("#[cfg(test)]"));
        assert!(got[0].ends_with('}'));
        assert!(got[0].contains("fn t()"));
        // The surrounding module is left behind — that is the whole reason to extract.
        assert!(!got[0].contains("use crate::thing"), "{}", got[0]);
    }

    #[test]
    fn a_file_with_no_test_module_yields_none() {
        assert!(extract_test_modules("pub fn f() {}\n").is_empty());
    }

    #[test]
    fn nested_braces_inside_a_test_module_do_not_end_it_early() {
        let file = "#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { if true { assert!(true); } }\n}\n";
        let got = extract_test_modules(file);
        assert_eq!(got.len(), 1);
        assert!(got[0].contains("assert!(true)"), "{}", got[0]);
        assert!(got[0].ends_with('}'));
    }

    #[test]
    fn crate_name_strips_the_id_extension_rustc_refuses() {
        assert_eq!(crate_name("merge.rs"), "merge");
        assert_eq!(crate_name("merge-sort.rs"), "merge_sort");
        assert_eq!(crate_name("a-star.rs"), "a_star");
    }
}
