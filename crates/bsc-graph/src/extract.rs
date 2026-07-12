//! Tree-sitter extraction (#2745) — the library's HARVEST feeder: parse a project's real source code
//! and lift each function definition into a CANDIDATE library implementation (the seed's
//! `implementations` shape), so proven code bits can be reviewed into the generative library (#2760).
//! Deterministic + zero egress: tree-sitter parses locally, no network, and the walk is order-stable
//! (sorted directory traversal). It EMITS candidates only — storing them is the curation gate (a later
//! #2745 slice), never here.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tree_sitter::{Language, Node, Parser};

/// A candidate library implementation harvested from real code (#2745) — the seed's `implementations`
/// shape, so the curation gate can review it straight into the library. `concept` is set when the
/// function name maps onto a seed concept, else `None` (a genuinely new building block). `role` is a
/// heuristic: a function that composes no other harvested candidate is a `primitive`, one that calls
/// other harvested candidates is an `algorithm`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// Candidate id — `<kebab(name)>.<ext>` (the curation gate may re-key it).
    pub id: String,
    /// The source name of the function, verbatim (e.g. `quickSort`, `quick_sort`).
    pub name: String,
    /// The language it was harvested from: `"typescript"` | `"rust"`.
    pub tech: String,
    /// The seed concept id the name maps onto (`concept_of(name)`), or `None`.
    pub concept: Option<String>,
    /// `"primitive"` | `"algorithm"` — the #2863 role tier, by the compose heuristic.
    pub role: &'static str,
    /// Ids of the same-tech harvested candidates this one calls (intra-project call edges).
    pub composes: Vec<String>,
    /// The function's full source text.
    pub code: String,
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

/// The file extension (impl id suffix) for a tech.
fn ext_of(tech: &str) -> &'static str {
    match tech {
        "rust" => "rs",
        _ => "ts",
    }
}

/// Harvest `dir` into candidate library implementations (#2745): every function definition becomes a
/// `Candidate` carrying its source, an optional seed concept, a heuristic role, and the ids of the
/// same-tech candidates it calls (`composes`). Order-stable; skips vendored/build/VCS dirs + test
/// files. Storing candidates is the curation gate's job, not this function's.
pub fn harvest(dir: &Path) -> Vec<Candidate> {
    let defs = harvest_defs(dir);
    // Raw intra-project call edges (caller name → callee name, per tech), reused for `composes`.
    let mut raw: Vec<(String, String, String)> = Vec::new();
    walk_calls(dir, &mut raw);
    // Which (name, tech) pairs were actually harvested — so `composes` only links in-set candidates.
    let in_set: HashSet<(String, String)> =
        defs.iter().map(|(n, t, _)| (n.clone(), t.clone())).collect();
    defs.into_iter()
        .map(|(name, tech, code)| {
            let mut composes: Vec<String> = Vec::new();
            for (caller, callee, ctech) in &raw {
                if caller == &name
                    && ctech == &tech
                    && callee != &name // a self-call (recursion) is not composition
                    && in_set.contains(&(callee.clone(), tech.clone()))
                {
                    let cid = format!("{}.{}", kebab(callee), ext_of(&tech));
                    if !composes.contains(&cid) {
                        composes.push(cid);
                    }
                }
            }
            let role = if composes.is_empty() { "primitive" } else { "algorithm" };
            Candidate {
                id: format!("{}.{}", kebab(&name), ext_of(&tech)),
                concept: concept_of(&name),
                role,
                composes,
                tech,
                name,
                code,
            }
        })
        .collect()
}

/// Collect every function definition under `dir` as `(name, tech, full source text)`. Order-stable.
fn harvest_defs(dir: &Path) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    harvest_walk(dir, &mut out);
    out
}

fn harvest_walk(dir: &Path, out: &mut Vec<(String, String, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.is_dir() {
            if !SKIP_DIRS.contains(&name) {
                harvest_walk(&path, out);
            }
        } else if let Some((tech, src, tree)) = parse(&path) {
            collect_defs(tree.root_node(), &src, tech, out);
        }
    }
}

/// Recursively collect `(name, tech, source text)` for every function definition under `node`.
fn collect_defs(node: Node, src: &[u8], tech: &str, out: &mut Vec<(String, String, String)>) {
    if let Some(name) = fn_def_name(node, src) {
        if let Ok(code) = node.utf8_text(src) {
            out.push((name, tech.to_string(), code.to_string()));
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_defs(child, src, tech, out);
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

/// The UTF-8 text of `node`'s `field` child, if present and valid UTF-8.
fn field_text(node: Node, field: &str, src: &[u8]) -> Option<String> {
    node.child_by_field_name(field)
        .and_then(|n| n.utf8_text(src).ok())
        .map(str::to_string)
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
    fn harvest_lifts_functions_into_library_candidates() {
        let cands = harvest(&fixtures());
        let find = |name: &str, tech: &str| cands.iter().find(|c| c.name == name && c.tech == tech);

        // A Rust merge_sort is harvested with its code, mapped onto the merge-sort concept, role algorithm.
        let ms = find("merge_sort", "rust").expect("rust merge_sort harvested");
        assert_eq!(ms.id, "merge-sort.rs");
        assert_eq!(ms.concept.as_deref(), Some("merge-sort"));
        assert_eq!(ms.role, "algorithm");
        assert!(ms.code.contains("fn merge_sort"), "the candidate carries its full source");
        // merge_sort calls merge(...) in-set (its self-recursion is dropped) → composes the merge candidate.
        assert_eq!(ms.composes, vec!["merge.rs".to_string()]);

        // The merge primitive composes no in-set candidate → role primitive.
        let merge = find("merge", "rust").expect("rust merge harvested");
        assert_eq!(merge.role, "primitive");
        assert!(merge.composes.is_empty());

        // A non-concept helper is still harvested — concept None (a genuinely new building block).
        let helper = cands.iter().find(|c| c.name == "helperThing").expect("helperThing harvested");
        assert!(helper.concept.is_none());
        assert_eq!(helper.tech, "typescript");

        // Every candidate carries non-empty code, a known tech, and a role.
        assert!(cands.iter().all(|c| !c.code.trim().is_empty()));
        assert!(cands.iter().all(|c| c.tech == "typescript" || c.tech == "rust"));
        assert!(cands.iter().all(|c| c.role == "primitive" || c.role == "algorithm"));
    }
}
