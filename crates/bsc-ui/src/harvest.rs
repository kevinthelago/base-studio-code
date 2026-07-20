//! Tree-sitter COMPONENT harvest (#3471, epic #3087) — the component half of `bsc graph harvest`
//! (`bsc-graph/src/extract.rs`). Parse a repo's real `.tsx`/`.ts` source and lift each React component
//! into a CANDIDATE component record, so a project that gets built FILLS the component graph instead of
//! the library being hand-authored one `bsc ui set` at a time. Deterministic + zero egress: tree-sitter
//! parses locally, no network, and the walk is order-stable (sorted traversal). It EMITS candidates
//! only — storing them is the curation gate, never here.
//!
//! ── WHY THIS IS NOT A COPY OF THE ALGORITHMS HARVEST ─────────────────────────────────────────────────
//! `graph harvest` lifts a function's node text verbatim, which is fine for a self-contained algorithm.
//! A React component is NOT self-contained: its module has imports, type declarations and sibling
//! helpers, and its stored `srcText` must be a module the preview can actually COMPILE. So this
//! extractor computes a CLOSURE — the component, plus the same-file declarations it transitively
//! references, plus exactly the imports those need — rather than a node slice.
//!
//! And it says so when it fails. A `srcText` that keeps unresolved `@/…` imports is stored today with no
//! complaint at all (#3470: `looks_buildable_module` returns false, which makes the syntax gate SKIP),
//! surfacing much later as an unbuildable component. So every candidate carries an honest `buildable`
//! flag with reasons; a candidate that could not be closed is emitted flagged, never quietly degraded.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use tree_sitter::{Language, Node, Parser};

/// A candidate component harvested from real source (#3471) — the store's component-record shape, so
/// the curation gate can review it straight into the library via `bsc ui set`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// Candidate id — the store's convention is the lowercased name with separators dropped
    /// (`AnalyticsPage` → `analyticspage`), matching the records already in the library.
    pub id: String,
    /// The component's source name, verbatim (`Button`, `BarChart`).
    pub name: String,
    /// The kit this candidate would join (`--kit`, else [`DEFAULT_KIT`]).
    pub kit_id: String,
    /// `"primitive"` | `"composite"` | `"page"` — the #2863 role tier, by heuristic.
    pub role: &'static str,
    /// NAMES of the other harvested components this one renders. The component graph composes by
    /// NAME, not by id (`graph_health::parse_node`) — deliberately unlike `graph harvest`'s id form.
    pub composes: Vec<String>,
    /// The component's source CLOSURE — a module, not a node slice (see the module docs).
    pub src_text: String,
    /// Repo-relative path the component was harvested from.
    pub src: String,
    /// Is `src_text` a module the preview could compile? Honest, and never silently assumed (#3470).
    pub buildable: bool,
    /// Why `buildable` is false — empty when it is true.
    pub unbuildable_reasons: Vec<String>,
    /// The reusability classification — library-worthy vs. project glue, with reasons.
    pub classification: Classification,
}

/// The kit a harvest lands in when `--kit` is not given. Deliberately NOT an existing kit: harvested
/// candidates are unreviewed, and defaulting them into `react-ui` would contaminate a curated kit.
pub const DEFAULT_KIT: &str = "harvested";

/// Path segments we never descend into — vendored deps, build output, VCS/tooling dirs.
const SKIP_DIRS: &[&str] = &["node_modules", "target", ".git", ".claude", "dist", "build"];

/// The reusability classification of a harvested candidate — mirrors the algorithms classifier's shape
/// (`bsc_graph::extract::Classification`) so the two pillars behave alike.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Classification {
    /// The candidate cleared the worthiness threshold (a net-positive score).
    pub worthy: bool,
    /// The weighted signal score.
    pub score: i32,
    /// One human-readable reason per signal that fired.
    pub reasons: Vec<String>,
}

/// Test/story files carry no production component.
fn is_test_file(name: &str) -> bool {
    [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".stories.tsx"].iter().any(|s| name.ends_with(s))
}

/// The store's component id for a source name — lowercased, non-alphanumerics dropped
/// (`AnalyticsPage` → `analyticspage`), matching the records already in the library.
fn component_id(name: &str) -> String {
    name.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase()
}

/// Is this a React COMPONENT name? React requires a capitalized identifier — a lowercase name is
/// treated as an intrinsic tag and can never be a component, so this is a real signal, not a style rule.
fn is_component_name(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
}

/// App-glue component names that aren't reusable library pieces.
const GLUE_NAMES: &[&str] = &["App", "Root", "Main", "Index", "Wrapper", "Provider", "Layout"];

fn is_glue_name(name: &str) -> bool {
    GLUE_NAMES.contains(&name) || name.ends_with("Provider") || name.ends_with("Context")
}

/// Does the closure render nothing but a single element with no logic? Nothing worth storing.
fn is_trivial(src_text: &str) -> bool {
    src_text.lines().filter(|l| {
        let t = l.trim();
        !t.is_empty() && !t.starts_with("//") && !t.starts_with("import ") && t != "}" && t != "{"
    }).count() <= 2
}

/// Classify a candidate's reusability: a weighted score over cheap, tree-sitter-derivable signals.
/// `worthy` when the score is net-positive (the curation gate reviews only these).
pub fn classify(c: &Candidate) -> Classification {
    let mut score = 0;
    let mut reasons = Vec::new();
    if !c.composes.is_empty() {
        score += 1;
        reasons.push(format!("composes {} component(s)", c.composes.len()));
    }
    if c.buildable {
        score += 1;
        reasons.push("self-contained module — compiles on its own".to_string());
    } else {
        score -= 1;
        reasons.push("not a self-contained module".to_string());
    }
    if is_glue_name(&c.name) {
        score -= 2;
        reasons.push("app-glue / provider name".to_string());
    }
    if is_trivial(&c.src_text) {
        score -= 2;
        reasons.push("trivial body — nothing to store".to_string());
    }
    Classification { worthy: score >= 1, score, reasons }
}

/// Resolve a source file to its tree-sitter language, or `None` for a file we don't parse.
fn language_for(path: &Path) -> Option<Language> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if is_test_file(name) {
        return None;
    }
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        // Both parse as TSX: a `.ts` file cannot contain JSX, so using the TSX grammar for it is
        // harmless, and it keeps one code path.
        "ts" | "tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        _ => None,
    }
}

/// Read + tree-sitter-parse `path`. `None` on an unparsable/unknown file or any read/parse error.
fn parse(path: &Path) -> Option<(Vec<u8>, tree_sitter::Tree)> {
    let language = language_for(path)?;
    let src = std::fs::read(path).ok()?;
    let mut parser = Parser::new();
    parser.set_language(&language).ok()?;
    let tree = parser.parse(&src, None)?;
    Some((src, tree))
}

/// Harvest `dir` into candidate components (#3471): every React component becomes a `Candidate`
/// carrying its source CLOSURE, a heuristic role, an honest `buildable` verdict, and the NAMES of the
/// other harvested components it renders (`composes`). Order-stable; skips vendored/build/VCS dirs and
/// test files. Storing candidates is the curation gate's job, not this function's.
pub fn harvest(dir: &Path, kit_id: &str) -> Vec<Candidate> {
    let mut found: Vec<Found> = Vec::new();
    walk(dir, dir, &mut found);
    // Which component NAMES were harvested — so `composes` only links in-set candidates.
    let in_set: HashSet<String> = found.iter().map(|f| f.name.clone()).collect();
    found
        .into_iter()
        .map(|f| {
            // Rendered tags that are themselves harvested components, minus self-recursion.
            let mut composes: Vec<String> = Vec::new();
            for tag in &f.tags {
                if tag != &f.name && in_set.contains(tag) && !composes.contains(tag) {
                    composes.push(tag.clone());
                }
            }
            let role = if f.name.ends_with("Page") {
                "page"
            } else if composes.is_empty() {
                "primitive"
            } else {
                "composite"
            };
            let (buildable, unbuildable_reasons) = buildability(&f.src_text);
            let mut c = Candidate {
                id: component_id(&f.name),
                name: f.name,
                kit_id: kit_id.to_string(),
                role,
                composes,
                src_text: f.src_text,
                src: f.src,
                buildable,
                unbuildable_reasons,
                classification: Classification::default(),
            };
            c.classification = classify(&c);
            c
        })
        .collect()
}

/// Is the closure a module the preview could compile, and if not, exactly why? The predicate mirrors
/// `bsc_component::graph_health::looks_buildable_module` (export present · no elision marker · no
/// unresolved internal import) but REPORTS its reasons instead of collapsing to a bool — the whole
/// point of #3470 is that "not buildable" must be a stated outcome, never a silent one.
fn buildability(src_text: &str) -> (bool, Vec<String>) {
    let mut why = Vec::new();
    if !src_text.contains("export ") {
        why.push("no `export` — nothing for the preview to mount".to_string());
    }
    if has_code_elision(src_text) {
        why.push("contains an elision marker (`…`) — a sketch, not code".to_string());
    }
    let unresolved: BTreeSet<&str> = src_text
        .lines()
        .filter(|l| l.trim_start().starts_with("import "))
        .filter_map(|l| l.split("\"@/").nth(1).or_else(|| l.split("'@/").nth(1)))
        .filter_map(|rest| rest.split(['"', '\'']).next())
        .collect();
    if !unresolved.is_empty() {
        let list = unresolved.iter().map(|m| format!("`@/{m}`")).collect::<Vec<_>>().join(", ");
        why.push(format!("unresolved internal import(s): {list} — resolve or vendor them"));
    }
    (why.is_empty(), why)
}

/// Does `…` appear in real CODE (not in a string literal or a comment)? Only then is it an elision
/// marker standing in for omitted code. A plain substring test — which is what
/// `looks_buildable_module` does — is WRONG here and was measurably so: harvesting this repo's own
/// `src/shared/ui` flagged 13 perfectly good components as "a sketch", because `…` is ordinary UI copy
/// (`placeholder = "Select…"`) and ordinary prose in a doc comment (`<button style={{…}}>`). Condemning
/// a real component over an ellipsis in its placeholder text would be a false accusation the curator
/// then has to overrule, so the scanner skips both contexts.
fn has_code_elision(src: &str) -> bool {
    let b: Vec<char> = src.chars().collect();
    let (mut i, mut n) = (0usize, b.len());
    n = n.min(b.len());
    while i < n {
        let c = b[i];
        match c {
            '/' if i + 1 < n && b[i + 1] == '/' => {
                while i < n && b[i] != '\n' {
                    i += 1;
                }
            }
            '/' if i + 1 < n && b[i + 1] == '*' => {
                i += 2;
                while i + 1 < n && !(b[i] == '*' && b[i + 1] == '/') {
                    i += 1;
                }
                i = (i + 2).min(n);
            }
            '"' | '\'' | '`' => {
                let quote = c;
                i += 1;
                while i < n && b[i] != quote {
                    // A backslash escapes the next char, so an escaped quote doesn't end the literal.
                    i += if b[i] == '\\' { 2 } else { 1 };
                }
                i += 1;
            }
            '…' => return true,
            _ => i += 1,
        }
    }
    false
}

/// One component located in one file, before cross-file `composes` resolution.
struct Found {
    name: String,
    src_text: String,
    src: String,
    /// PascalCase JSX tags rendered anywhere in the component.
    tags: Vec<String>,
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<Found>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.is_dir() {
            if !SKIP_DIRS.contains(&name) {
                walk(root, &path, out);
            }
        } else if let Some((src, tree)) = parse(&path) {
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            collect_file(tree.root_node(), &src, &rel, out);
        }
    }
}

/// Lift every React component defined at any depth in one parsed file.
fn collect_file(root: Node, src: &[u8], rel: &str, out: &mut Vec<Found>) {
    let imports = import_lines(root, src);
    let decls = top_level_decls(root, src);
    let mut defs: Vec<(String, Node)> = Vec::new();
    collect_component_defs(root, src, &mut defs);
    for (name, node) in defs {
        let own = exported_text(node, src);
        let src_text = close_over(&own, &imports, &decls, &name);
        out.push(Found {
            name,
            tags: jsx_tags(node, src),
            src_text,
            src: rel.to_string(),
        });
    }
}

/// Every React component definition under `node`: a PascalCase-named function that renders JSX.
fn collect_component_defs<'a>(node: Node<'a>, src: &[u8], out: &mut Vec<(String, Node<'a>)>) {
    if let Some(name) = fn_def_name(node, src) {
        if is_component_name(&name) && contains_jsx(node) {
            out.push((name, node));
            // A component's inner closures are part of IT, never separate candidates.
            return;
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_component_defs(child, src, out);
    }
}

/// The source name of the function `node` DEFINES, or `None` if it isn't a function definition.
fn fn_def_name(node: Node, src: &[u8]) -> Option<String> {
    match node.kind() {
        "function_declaration" | "function_item" | "method_definition" => field_text(node, "name", src),
        "variable_declarator" => {
            let bound_to_fn = node
                .child_by_field_name("value")
                .map(|v| matches!(v.kind(), "arrow_function" | "function" | "function_expression"))
                .unwrap_or(false);
            bound_to_fn.then(|| field_text(node, "name", src)).flatten()
        }
        _ => None,
    }
}

fn field_text(node: Node, field: &str, src: &[u8]) -> Option<String> {
    node.child_by_field_name(field).and_then(|n| n.utf8_text(src).ok()).map(str::to_string)
}

/// Does this subtree render JSX? The other half of the component test — a capitalized function that
/// returns no JSX is a factory/hook/class, not a component.
fn contains_jsx(node: Node) -> bool {
    if matches!(node.kind(), "jsx_element" | "jsx_self_closing_element" | "jsx_fragment") {
        return true;
    }
    let mut cursor = node.walk();
    let found = node.children(&mut cursor).any(contains_jsx);
    found
}

/// The PascalCase JSX tag names rendered under `node`, in first-appearance order. Lowercase tags are
/// intrinsics (`div`, `span`) and are never components.
fn jsx_tags(node: Node, src: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    collect_tags(node, src, &mut out);
    out
}

fn collect_tags(node: Node, src: &[u8], out: &mut Vec<String>) {
    if matches!(node.kind(), "jsx_opening_element" | "jsx_self_closing_element") {
        if let Some(name) = field_text(node, "name", src) {
            if is_component_name(&name) && !out.contains(&name) {
                out.push(name);
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_tags(child, src, out);
    }
}

/// The node's text INCLUDING a wrapping `export` (tree-sitter puts `export` in a parent
/// `export_statement`, so the bare node text would silently drop it and the module would export nothing).
fn exported_text(node: Node, src: &[u8]) -> String {
    let mut top = node;
    // Climb out of `variable_declarator` → `lexical_declaration` → `export_statement`.
    while let Some(parent) = top.parent() {
        if matches!(parent.kind(), "lexical_declaration" | "variable_declaration" | "export_statement") {
            top = parent;
        } else {
            break;
        }
    }
    let text = top.utf8_text(src).unwrap_or("").to_string();
    if text.trim_start().starts_with("export ") { text } else { format!("export {text}") }
}

/// One top-level declaration in a file: the names it binds and its full source text.
struct Decl {
    names: Vec<String>,
    text: String,
}

/// Top-level type/const/function declarations, so a component's local helpers can be pulled into its
/// closure. (Component declarations are included too — a sibling component used by this one is a
/// `composes` edge AND may need its source when it isn't separately harvested.)
fn top_level_decls(root: Node, src: &[u8]) -> Vec<Decl> {
    let mut out = Vec::new();
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        let inner = if child.kind() == "export_statement" {
            child.named_child(0).unwrap_or(child)
        } else {
            child
        };
        let names = match inner.kind() {
            "function_declaration" | "class_declaration" | "type_alias_declaration"
            | "interface_declaration" | "enum_declaration" => {
                field_text(inner, "name", src).into_iter().collect()
            }
            "lexical_declaration" | "variable_declaration" => {
                let mut n = Vec::new();
                let mut c = inner.walk();
                for d in inner.children(&mut c) {
                    if d.kind() == "variable_declarator" {
                        if let Some(name) = field_text(d, "name", src) {
                            n.push(name);
                        }
                    }
                }
                n
            }
            _ => Vec::new(),
        };
        if !names.is_empty() {
            if let Ok(text) = child.utf8_text(src) {
                out.push(Decl { names, text: text.to_string() });
            }
        }
    }
    out
}

/// The file's import statements, each with the identifiers it binds.
fn import_lines(root: Node, src: &[u8]) -> Vec<Decl> {
    let mut out = Vec::new();
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if child.kind() != "import_statement" {
            continue;
        }
        let Ok(text) = child.utf8_text(src) else { continue };
        let mut names = Vec::new();
        collect_idents(child, src, &mut names);
        out.push(Decl { names, text: text.to_string() });
    }
    out
}

/// Every identifier token under `node` (used both for import bindings and for reference scanning).
fn collect_idents(node: Node, src: &[u8], out: &mut Vec<String>) {
    if matches!(node.kind(), "identifier" | "type_identifier" | "shorthand_property_identifier_pattern") {
        if let Ok(t) = node.utf8_text(src) {
            let t = t.to_string();
            if !out.contains(&t) {
                out.push(t);
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_idents(child, src, out);
    }
}

/// Build the component's module CLOSURE: the imports it actually uses + the same-file declarations it
/// transitively references + the component itself. Only what is REFERENCED is pulled in, so a harvested
/// component doesn't drag its whole file along — but nothing it needs is left behind either, which is
/// the failure the algorithms extractor's node-slice strategy would produce here.
fn close_over(own: &str, imports: &[Decl], decls: &[Decl], self_name: &str) -> String {
    let mut wanted: HashSet<String> = idents_in(own);
    // Transitively pull in local declarations, re-scanning each one for further references.
    let mut taken: Vec<usize> = Vec::new();
    loop {
        let mut grew = false;
        for (i, d) in decls.iter().enumerate() {
            if taken.contains(&i) || d.names.iter().any(|n| n == self_name) {
                continue;
            }
            if d.names.iter().any(|n| wanted.contains(n)) {
                for id in idents_in(&d.text) {
                    wanted.insert(id);
                }
                taken.push(i);
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    taken.sort_unstable();
    let mut parts: Vec<String> = Vec::new();
    for imp in imports.iter().filter(|i| i.names.iter().any(|n| wanted.contains(n))) {
        parts.push(imp.text.clone());
    }
    if !parts.is_empty() {
        parts.push(String::new()); // blank line between imports and body
    }
    for i in taken {
        parts.push(decls[i].text.clone());
    }
    parts.push(own.to_string());
    parts.join("\n")
}

/// The identifier-ish words in a chunk of source — a cheap scanner used to decide what a closure needs.
/// Deliberately over-inclusive: pulling in one unused local declaration is harmless, whereas MISSING one
/// produces an uncompilable component, which is the failure mode that matters.
fn idents_in(text: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut cur = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '$' {
            cur.push(ch);
        } else {
            if !cur.is_empty() && !cur.chars().next().unwrap().is_ascii_digit() {
                out.insert(std::mem::take(&mut cur));
            }
            cur.clear();
        }
    }
    if !cur.is_empty() {
        out.insert(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("harvest")
    }

    fn run() -> Vec<Candidate> {
        harvest(&fixtures(), DEFAULT_KIT)
    }

    fn by_name(name: &str) -> Candidate {
        run().into_iter().find(|c| c.name == name).unwrap_or_else(|| panic!("{name} not harvested"))
    }

    #[test]
    fn lifts_react_components_and_nothing_else() {
        let names: Vec<String> = run().into_iter().map(|c| c.name).collect();
        assert!(names.contains(&"Button".to_string()));
        assert!(names.contains(&"Card".to_string()));
        assert!(names.contains(&"DashboardPage".to_string()));
        // `formatDate` renders no JSX and isn't PascalCase — not a component.
        assert!(!names.iter().any(|n| n == "formatDate"), "a plain util is not a component: {names:?}");
        // A test file defines a component too — it must be skipped as a FILE, not rescued by name.
        assert!(!names.iter().any(|n| n == "NeverHarvested"), "test files are skipped: {names:?}");
    }

    #[test]
    fn the_closure_pulls_in_the_imports_types_and_helpers_the_component_uses() {
        // THE core difference from the algorithms harvest: a node slice would lose all of these and the
        // stored component would not compile.
        let b = by_name("Button");
        assert!(b.src_text.contains(r#"import { cx } from "clsx";"#), "keeps the used import:\n{}", b.src_text);
        assert!(b.src_text.contains("type ButtonProps"), "keeps the referenced type:\n{}", b.src_text);
        assert!(b.src_text.contains("function toneClass"), "keeps the referenced helper:\n{}", b.src_text);
        assert!(b.src_text.contains("export function Button"), "keeps the component itself:\n{}", b.src_text);
        // …and only what is referenced: an unrelated sibling declaration stays behind.
        assert!(!b.src_text.contains("UNUSED_ELSEWHERE"), "unreferenced decls are not dragged along:\n{}", b.src_text);
    }

    #[test]
    fn an_arrow_component_is_lifted_and_stays_exported() {
        // tree-sitter puts `export` in a PARENT node, so the bare declarator text would export nothing.
        let c = by_name("Card");
        assert!(c.src_text.contains("export const Card"), "arrow component keeps its export:\n{}", c.src_text);
    }

    #[test]
    fn composes_lists_sibling_component_names_not_ids() {
        // The component graph composes by NAME (`graph_health::parse_node`), deliberately unlike the
        // algorithms harvest's id-based edges.
        let c = by_name("Card");
        assert_eq!(c.composes, vec!["Button".to_string()]);
        assert_eq!(c.role, "composite", "a component that renders another is composite");
    }

    #[test]
    fn an_unresolved_internal_import_is_flagged_never_silently_accepted() {
        // #3470: such a srcText is stored today with NO complaint (looks_buildable_module is false, so
        // the syntax gate is skipped entirely). Harvest must state it instead.
        let c = by_name("Card");
        assert!(!c.buildable, "a component with an unresolved @/ import is not buildable");
        let why = c.unbuildable_reasons.join(" ");
        assert!(why.contains("@/shared/ui/controls/Button"), "the reason NAMES the import: {why}");
    }

    #[test]
    fn a_self_contained_component_is_reported_buildable() {
        let b = by_name("Button");
        assert!(b.buildable, "reasons: {:?}", b.unbuildable_reasons);
        assert!(b.unbuildable_reasons.is_empty());
    }

    #[test]
    fn role_and_id_follow_the_stores_conventions() {
        let p = by_name("DashboardPage");
        assert_eq!(p.role, "page");
        // The live store keys components as the lowercased name with separators dropped.
        assert_eq!(p.id, "dashboardpage");
        assert_eq!(by_name("Button").id, "button");
        assert_eq!(by_name("Button").role, "primitive", "renders no sibling component");
    }

    #[test]
    fn every_candidate_carries_its_source_path_and_kit() {
        for c in run() {
            assert!(c.src.ends_with(".tsx"), "{} -> {}", c.name, c.src);
            assert_eq!(c.kit_id, DEFAULT_KIT);
            assert!(!c.src_text.is_empty());
        }
    }

    #[test]
    fn the_walk_is_order_stable() {
        // Sorted traversal — a harvest diffed against a previous run must not churn on directory order.
        assert_eq!(run(), run());
    }

    #[test]
    fn the_default_kit_is_not_an_existing_curated_kit() {
        // Unreviewed candidates must not contaminate react-ui (or any curated kit) by default.
        assert_ne!(DEFAULT_KIT, "react-ui");
        assert_ne!(DEFAULT_KIT, "base");
    }

    #[test]
    fn classify_scores_composition_and_buildability_up_glue_down() {
        let card = by_name("Card");
        assert!(card.classification.reasons.iter().any(|r| r.contains("composes")));
        // A glue-named, unbuildable, trivial candidate must not be worthy.
        let glue = Candidate {
            id: "provider".into(), name: "Provider".into(), kit_id: DEFAULT_KIT.into(),
            role: "primitive", composes: vec![], src_text: "export const Provider = () => <div />;".into(),
            src: "Provider.tsx".into(), buildable: true, unbuildable_reasons: vec![],
            classification: Classification::default(),
        };
        assert!(!classify(&glue).worthy, "app-glue is not library-worthy: {:?}", classify(&glue));
    }

    #[test]
    fn an_ellipsis_in_copy_or_a_comment_is_not_an_elision_marker() {
        // A MEASURED false positive, not a hypothetical: harvesting this repo's own src/shared/ui
        // condemned 13 real components as "a sketch" because `…` is ordinary UI copy and ordinary prose
        // in a doc comment. A plain substring test (what `looks_buildable_module` does) is wrong here.
        assert!(buildability(r#"export const A = () => <input placeholder="Select…" />;"#).0, "UI copy");
        assert!(buildability("// mentions …
export function A() { return null; }").0, "line comment");
        assert!(buildability("/* block … */
export function A() { return null; }").0, "block comment");
        assert!(buildability("export const A = () => <b>{`tpl …`}</b>;").0, "template literal");
        // …but a real elision standing in for omitted CODE still fails.
        assert!(!buildability("export function A() { … }").0, "a genuine code elision");
    }

    #[test]
    fn buildability_names_each_distinct_failure() {
        let (ok, why) = buildability("export function A() { return null; }");
        assert!(ok, "{why:?}");
        let (no_export, why) = buildability("function A() { return null; }");
        assert!(!no_export);
        assert!(why.iter().any(|r| r.contains("export")), "{why:?}");
        let (elided, why) = buildability("export function A() { … }");
        assert!(!elided);
        assert!(why.iter().any(|r| r.contains('…')), "{why:?}");
    }
}
