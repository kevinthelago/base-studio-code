//! Tree-sitter extraction (#2775, Phase 2 slice 1) — parse real source code, extract function
//! definitions, and map each onto a concept id from the seed. This produces the `implements` join
//! ("Graph 2": reality, extracted from code) over the curated concept spine ("Graph 1"), plus a
//! dedup lens (concepts matched at more than one site). Deterministic + zero egress: tree-sitter
//! parses locally, no network, and the walk is order-stable (directory entries are sorted).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tree_sitter::{Language, Node, Parser};

/// One extracted function definition, optionally resolved to a seed concept id.
#[derive(Debug)]
pub struct ExtractedFn {
    /// The source name of the function, verbatim (e.g. `quickSort`, `quick_sort`).
    pub name: String,
    /// The concept node id it maps onto (`concept_of(name)`), or `None` when no concept matches.
    pub concept: Option<String>,
    /// The language it was extracted from: `"typescript"` | `"rust"`.
    pub tech: String,
    /// The file it was found in (the path as walked).
    pub file: String,
    /// 1-based start line of the definition.
    pub line: usize,
}

/// Path segments we never descend into or parse — vendored deps, build output, VCS/tooling dirs.
const SKIP_DIRS: &[&str] = &["node_modules", "target", ".git", ".claude", "dist", "build"];

/// Test files carry no production concept implementation — skip them.
fn is_test_file(name: &str) -> bool {
    name.ends_with(".test.ts") || name.ends_with(".test.tsx") || name.ends_with(".spec.ts")
}

/// Normalize a function name to a candidate kebab-case concept id: split camelCase / PascalCase
/// humps and snake_case underscores, lowercase everything. A run of uppercase letters stays fused
/// (so `FFT` → `fft`, not `f-f-t`). Leading/trailing separators are trimmed.
fn kebab(name: &str) -> String {
    let mut out = String::new();
    // Whether the previous emitted char was a lowercase letter or a digit — a hump boundary is only
    // inserted before an uppercase letter that follows one of those (so acronym runs don't split).
    let mut prev_lower_or_digit = false;
    for ch in name.chars() {
        if ch == '_' || ch == '-' || ch == ' ' {
            if !out.is_empty() && !out.ends_with('-') {
                out.push('-');
            }
            prev_lower_or_digit = false;
        } else if ch.is_ascii_uppercase() {
            if prev_lower_or_digit {
                out.push('-');
            }
            out.push(ch.to_ascii_lowercase());
            prev_lower_or_digit = false;
        } else {
            out.push(ch);
            prev_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        }
    }
    out.trim_matches('-').to_string()
}

/// Map a function name onto a seed concept id: normalize to kebab-case and return it IF it is a
/// concept node id in the seed (`crate::nodes()`), else `None`.
pub fn concept_of(name: &str) -> Option<String> {
    let candidate = kebab(name);
    if candidate.is_empty() {
        return None;
    }
    let is_node = crate::nodes()
        .iter()
        .any(|n| n.get("id").and_then(serde_json::Value::as_str) == Some(candidate.as_str()));
    is_node.then_some(candidate)
}

/// Recursively walk `dir`, tree-sitter-parse every `.ts`/`.tsx` (tech `"typescript"`) and `.rs`
/// (tech `"rust"`) file, and collect the function definitions (name + 1-based start line, resolved
/// to a concept where one matches). Skips vendored/build/VCS dirs and test files; a read or parse
/// error skips that file rather than panicking. Order-stable (sorted directory traversal).
pub fn extract_dir(dir: &Path) -> Vec<ExtractedFn> {
    let mut out = Vec::new();
    walk(dir, &mut out);
    out
}

fn walk(dir: &Path, out: &mut Vec<ExtractedFn>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.is_dir() {
            if !SKIP_DIRS.contains(&name) {
                walk(&path, out);
            }
        } else {
            extract_file(&path, out);
        }
    }
}

/// Resolve a source file to its `(tech, tree-sitter language)`, or `None` for a file we don't parse
/// (unknown extension, or a test file). Shared by the definition walk and the call walk.
fn language_for(path: &Path) -> Option<(&'static str, Language)> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if is_test_file(name) {
        return None;
    }
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "ts" => Some(("typescript", tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())),
        "tsx" => Some(("typescript", tree_sitter_typescript::LANGUAGE_TSX.into())),
        "rs" => Some(("rust", tree_sitter_rust::LANGUAGE.into())),
        _ => None,
    }
}

/// Read + tree-sitter-parse `path`, returning `(tech, source bytes, parse tree)`. `None` on an
/// unparsable/unknown file or any read/parse error (the caller skips it). Shared by both walks.
fn parse(path: &Path) -> Option<(&'static str, Vec<u8>, tree_sitter::Tree)> {
    let (tech, language) = language_for(path)?;
    let src = std::fs::read(path).ok()?;
    let mut parser = Parser::new();
    parser.set_language(&language).ok()?;
    let tree = parser.parse(&src, None)?;
    Some((tech, src, tree))
}

fn extract_file(path: &Path, out: &mut Vec<ExtractedFn>) {
    let Some((tech, src, tree)) = parse(path) else { return };
    let file = path.to_string_lossy().to_string();
    collect_fns(tree.root_node(), &src, tech, &file, out);
}

/// The source name of the function `node` DEFINES, or `None` if it isn't a function definition. TS:
/// `function_declaration`, `method_definition`, and a `variable_declarator` whose value is an
/// arrow/function expression. Rust: `function_item`. The name is the node's `name` field. Shared by
/// the definition collector and the call walk (which uses it to track the nearest enclosing function).
fn fn_def_name(node: Node, src: &[u8]) -> Option<String> {
    match node.kind() {
        "function_declaration" | "function_item" | "method_definition" => field_text(node, "name", src),
        "variable_declarator" => {
            let bound_to_fn = node
                .child_by_field_name("value")
                .map(|v| matches!(v.kind(), "arrow_function" | "function" | "function_expression"))
                .unwrap_or(false);
            if bound_to_fn {
                field_text(node, "name", src)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Recursively collect the function definitions under `node`, resolving each name onto a concept.
fn collect_fns(node: Node, src: &[u8], tech: &str, file: &str, out: &mut Vec<ExtractedFn>) {
    if let Some(name) = fn_def_name(node, src) {
        out.push(ExtractedFn {
            concept: concept_of(&name),
            name,
            tech: tech.to_string(),
            file: file.to_string(),
            line: node.start_position().row + 1,
        });
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_fns(child, src, tech, file, out);
    }
}

/// The UTF-8 text of `node`'s `field` child, if present and valid UTF-8.
fn field_text(node: Node, field: &str, src: &[u8]) -> Option<String> {
    node.child_by_field_name(field)
        .and_then(|n| n.utf8_text(src).ok())
        .map(str::to_string)
}

/// Group the matched functions by concept and return only concepts with more than one site — the
/// dedup lens (the same concept implemented in multiple places). Stable, first-seen order.
pub fn dedup(fns: &[ExtractedFn]) -> Vec<(String, Vec<&ExtractedFn>)> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<&ExtractedFn>> = HashMap::new();
    for f in fns {
        if let Some(concept) = &f.concept {
            if !groups.contains_key(concept) {
                order.push(concept.clone());
            }
            groups.entry(concept.clone()).or_default().push(f);
        }
    }
    order
        .into_iter()
        .filter_map(|concept| {
            let sites = groups.remove(&concept).unwrap_or_default();
            (sites.len() > 1).then_some((concept, sites))
        })
        .collect()
}

/// One concept→concept CALL edge lifted from real code (#2779): the function mapping onto `from`
/// contains a call to the function mapping onto `to`, in language `tech`. This is the reverse of the
/// `implements` join — not "which concept is this code" but "which concept does this code invoke",
/// so the page can overlay real-code composition on the curated spine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallEdge {
    /// The concept id of the enclosing (caller) function.
    pub from: String,
    /// The concept id of the called (callee) function.
    pub to: String,
    /// The language the call was found in: `"typescript"` | `"rust"`.
    pub tech: String,
}

/// Walk `dir` and lift the concept→concept call edges: for every `call_expression` inside a named
/// function, resolve BOTH the enclosing function name and the callee name via `concept_of` and, when
/// both map to a concept, record a `from → to` edge in that file's tech. Self-edges (a concept
/// calling itself — recursion) are dropped: they're self-reference, not concept→concept composition.
/// The result is **deduped** (on the full `(from, to, tech)` triple) and order-stable (sorted walk +
/// deterministic tree traversal). Skips vendored/build/VCS dirs and test files, like `extract_dir`.
pub fn extract_calls(dir: &Path) -> Vec<CallEdge> {
    let mut raw: Vec<(String, String, String)> = Vec::new();
    walk_calls(dir, &mut raw);
    let mut out: Vec<CallEdge> = Vec::new();
    for (caller, callee, tech) in raw {
        let (Some(from), Some(to)) = (concept_of(&caller), concept_of(&callee)) else { continue };
        if from == to {
            continue; // recursion self-edge — not a concept→concept composition edge
        }
        let edge = CallEdge { from, to, tech };
        if !out.contains(&edge) {
            out.push(edge);
        }
    }
    out
}

fn walk_calls(dir: &Path, out: &mut Vec<(String, String, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.is_dir() {
            if !SKIP_DIRS.contains(&name) {
                walk_calls(&path, out);
            }
        } else if let Some((tech, src, tree)) = parse(&path) {
            collect_calls(tree.root_node(), &src, tech, None, out);
        }
    }
}

/// Recursively collect raw `(caller_name, callee_name, tech)` call sites, threading the NEAREST
/// enclosing named function through the walk. A function-definition node sets `enclosing` to its own
/// name for its whole subtree; a `call_expression` reached while inside a named function records an
/// edge from that function to the callee (when a callee name can be read).
fn collect_calls(node: Node, src: &[u8], tech: &str, enclosing: Option<&str>, out: &mut Vec<(String, String, String)>) {
    let defined = fn_def_name(node, src);
    let current = defined.as_deref().or(enclosing);
    if node.kind() == "call_expression" {
        if let (Some(caller), Some(callee)) = (current, callee_name(node, src, tech)) {
            out.push((caller.to_string(), callee, tech.to_string()));
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_calls(child, src, tech, current, out);
    }
}

/// The callee's source name for a `call_expression`, read from its `function` field. TS: an
/// `identifier` yields its text, a `member_expression` yields its `property` (`a.b(…)` → `b`). Rust:
/// an `identifier` yields its text; a `scoped_identifier` (`a::b(…)`) or `field_expression`
/// (`x.f(…)`) yields its LAST segment (the `name`/`field` field). Anything else → `None`.
fn callee_name(call: Node, src: &[u8], tech: &str) -> Option<String> {
    let f = call.child_by_field_name("function")?;
    match (tech, f.kind()) {
        (_, "identifier") => f.utf8_text(src).ok().map(str::to_string),
        ("typescript", "member_expression") => field_text(f, "property", src),
        ("rust", "scoped_identifier") => field_text(f, "name", src),
        ("rust", "field_expression") => field_text(f, "field", src),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures")
    }

    #[test]
    fn concept_of_normalizes_camel_pascal_and_snake_case() {
        assert_eq!(concept_of("quickSort"), Some("quick-sort".to_string()));
        assert_eq!(concept_of("quick_sort"), Some("quick-sort".to_string()));
        assert_eq!(concept_of("QuickSort"), Some("quick-sort".to_string()));
        assert_eq!(concept_of("mergeSort"), Some("merge-sort".to_string()));
        assert_eq!(concept_of("binary_search"), Some("binary-search".to_string()));
        assert_eq!(concept_of("bfs"), Some("bfs".to_string()));
        // Non-concept names resolve to nothing.
        assert_eq!(concept_of("helperThing"), None);
        assert_eq!(concept_of("some_helper"), None);
        assert_eq!(concept_of(""), None);
    }

    #[test]
    fn extract_dir_maps_functions_onto_concepts_across_langs() {
        let fns = extract_dir(&fixtures());

        // A concept matched in a given tech is present.
        let matched = |concept: &str, tech: &str| {
            fns.iter().any(|f| f.concept.as_deref() == Some(concept) && f.tech == tech)
        };
        assert!(matched("quick-sort", "typescript"), "TS quickSort → quick-sort");
        assert!(matched("quick-sort", "rust"), "Rust quick_sort → quick-sort");
        assert!(matched("merge-sort", "typescript"), "TS arrow mergeSort → merge-sort");
        assert!(matched("binary-search", "typescript"), "TS binarySearch → binary-search");
        assert!(matched("bfs", "rust"), "Rust bfs → bfs");

        // Non-matching functions are extracted but carry no concept.
        let unmatched_named = |name: &str| {
            fns.iter().any(|f| f.name == name && f.concept.is_none())
        };
        assert!(unmatched_named("helperThing"), "helperThing has no concept");
        assert!(unmatched_named("some_helper"), "some_helper has no concept");

        // Every extracted fn carries a real 1-based line and a known tech.
        assert!(fns.iter().all(|f| f.line >= 1));
        assert!(fns.iter().all(|f| f.tech == "typescript" || f.tech == "rust"));
    }

    #[test]
    fn dedup_reports_only_multi_site_concepts() {
        let fns = extract_dir(&fixtures());
        let dups = dedup(&fns);

        // quick-sort, merge-sort, and merge are each implemented in BOTH ts and rust (#2779 gave the
        // fixtures a merge/merge_sort pair in each tech) → duplicates with 2 sites (one per tech).
        for concept in ["quick-sort", "merge-sort", "merge"] {
            let dup = dups.iter().find(|(c, _)| c == concept).unwrap_or_else(|| panic!("{concept} is a duplicate"));
            assert_eq!(dup.1.len(), 2, "{concept} has 2 sites (ts + rust)");
            let techs: Vec<&str> = dup.1.iter().map(|f| f.tech.as_str()).collect();
            assert!(techs.contains(&"typescript") && techs.contains(&"rust"), "{concept} spans both techs");
        }

        // Single-site concepts (binary-search is ts-only, bfs is rust-only) are NOT duplicates.
        assert!(dups.iter().all(|(c, _)| c != "binary-search"), "binary-search is single-site");
        assert!(dups.iter().all(|(c, _)| c != "bfs"), "bfs is single-site");
    }

    #[test]
    fn extract_calls_lifts_concept_to_concept_edges_and_drops_the_rest() {
        let calls = extract_calls(&fixtures());

        // The headline edge: mergeSort/merge_sort call merge(...) in BOTH techs → merge-sort → merge.
        let has = |from: &str, to: &str, tech: &str| {
            calls.iter().any(|c| c.from == from && c.to == to && c.tech == tech)
        };
        assert!(has("merge-sort", "merge", "typescript"), "TS mergeSort → merge");
        assert!(has("merge-sort", "merge", "rust"), "Rust merge_sort → merge");

        // Both ends of every emitted edge resolve to a real seed concept — so calls to non-concept
        // helpers (bfs → some_helper, and the .slice()/.filter() member calls) are dropped.
        assert!(
            calls.iter().all(|c| concept_of(&c.from).as_deref() == Some(&c.from) && concept_of(&c.to).as_deref() == Some(&c.to)),
            "every call edge is concept → concept",
        );
        assert!(calls.iter().all(|c| c.to != "some-helper"), "bfs → some_helper (non-concept) dropped");

        // Recursion (mergeSort/quickSort calling themselves) is NOT a concept→concept edge.
        assert!(calls.iter().all(|c| c.from != c.to), "self-edges (recursion) are dropped");
        assert!(!has("quick-sort", "quick-sort", "typescript"), "quick-sort recursion is not an edge");

        // Deduped on the full (from, to, tech) triple — mergeSort calls merge once per tech, not twice.
        let ms_merge = calls.iter().filter(|c| c.from == "merge-sort" && c.to == "merge").count();
        assert_eq!(ms_merge, 2, "one merge-sort → merge edge per tech (ts + rust), deduped");
    }
}
