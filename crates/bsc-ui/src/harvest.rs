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
//! And it says so when it fails. A `srcText` that keeps unresolved `@/…` imports USED to be stored with
//! no complaint at all (#3470: `looks_buildable_module` returned false, which made the syntax gate SKIP),
//! surfacing much later as an unbuildable component; `bsc ui set` now warns with these same reasons. So every candidate carries an honest `buildable`
//! flag with reasons; a candidate that could not be closed is emitted flagged, never quietly degraded.
//!
//! ── SIBLING IMPORTS ARE COMPOSITION, NOT DAMAGE ──────────────────────────────────────────────────────
//! A harvest is a SET, and the preview knows it: `componentPreviewFiles` (componentPreview.ts, #3112 —
//! mirrored by `graph_health::is_preview_buildable`) vendors the transitive closure of the SIBLINGS a
//! component imports into its build, so an internal import that lands on a sibling of the same kit is
//! resolvable. Judging each candidate alone therefore under-reports, measurably: harvesting this repo's
//! own `src/shared/ui` produced 93 candidates of which 51 were `buildable: false` purely for `@/…`
//! imports — and 129 of the 150 `@/…` specifiers in that harvest pointed at OTHER components in it. So
//! buildability is decided against the in-set candidates: an `@/…` import that lands on a harvested
//! sibling MODULE is a `composes` edge, not a defect. Anything else — app state, a store, a feature's
//! logic, a shared hook — still makes the candidate unbuildable, with its reason naming the specifier.
//! Same harvest after: 76 of 93 buildable, and every one of the 17 remaining is held back by a genuine
//! non-component module (`@/shared/hooks/useDragResize`, `@/shared/lib/core/format`, …).

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

/// Test/story files carry no production component. Extension-agnostic (#3571): the same `.test` / `.spec`
/// / `.stories` marker excludes a `.js`/`.jsx` test as well as a `.ts`/`.tsx` one. Checks the stem before
/// the final extension so `Foo.test.tsx` matches while `latest.tsx` (no dot before `test`) does not.
fn is_test_file(name: &str) -> bool {
    let stem = name.rsplit_once('.').map_or(name, |(s, _)| s);
    stem.ends_with(".test") || stem.ends_with(".spec") || stem.ends_with(".stories")
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
        // All four parse with the TSX grammar — a strict superset of JS+JSX+TS, so a `.ts`/`.js` file
        // that contains no JSX is parsed harmlessly and JS/JSX components are lifted just like TS ones.
        // Without `.jsx`/`.js` a JavaScript React project harvested to ZERO candidates (#3571).
        "ts" | "tsx" | "jsx" | "js" | "mjs" | "cjs" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
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
    build_candidates(found, kit_id)
}

/// Harvest a SINGLE file (#3722) — parse just `file` and lift its components, `composes` resolved within
/// the file. For targeting ONE component's module instead of a whole tree (and pairing with `--out` so a
/// large candidate's `srcText` is recoverable). A non-parseable path (a test/story file, a non-source
/// extension) yields no candidates, exactly as the dir walk skips it. The recorded `src` is the file's
/// own name — a single-file harvest has no root to make the path relative to.
pub fn harvest_file(file: &Path, kit_id: &str) -> Vec<Candidate> {
    let mut found: Vec<Found> = Vec::new();
    if let Some((src, tree)) = parse(file) {
        let rel = file.file_name().and_then(|n| n.to_str()).unwrap_or("").replace('\\', "/");
        collect_file(tree.root_node(), &src, &rel, &mut found);
    }
    build_candidates(found, kit_id)
}

/// Resolve `composes` edges + buildability across a harvested `Found` set and render each into a
/// `Candidate`. Shared by the directory [`harvest`] and the single-file [`harvest_file`], so both apply
/// the same in-set sibling resolution (a single file's siblings are simply the components defined beside
/// it in that one module).
fn build_candidates(found: Vec<Found>, kit_id: &str) -> Vec<Candidate> {
    // Which component NAMES were harvested, and from which MODULE — `composes` only links in-set
    // candidates, and a sibling import must agree on BOTH (see `SiblingIndex`).
    let mut in_set = SiblingIndex::default();
    for f in &found {
        in_set.0.entry(f.name.clone()).or_default().push(module_base(&f.src));
    }
    found
        .into_iter()
        .map(|f| {
            let imports = internal_imports(&f.src_text);
            // Rendered tags that are themselves harvested components, minus self-recursion.
            let mut composes: Vec<String> = Vec::new();
            for tag in &f.tags {
                if tag != &f.name && in_set.has(tag) && !composes.contains(tag) {
                    composes.push(tag.clone());
                }
            }
            // …plus the harvested siblings it IMPORTS. Usually the same set (you import what you render),
            // but a sibling handed on as a prop (`icon={Icon}`) or rendered through an alias is a real
            // composition edge that no JSX tag records — and the whole point of resolving sibling imports
            // is that they become edges rather than dangling.
            for name in imports.iter().flat_map(|i| &i.names) {
                if name != &f.name && in_set.has(name) && !composes.contains(name) {
                    composes.push(name.clone());
                }
            }
            let role = if f.name.ends_with("Page") {
                "page"
            } else if composes.is_empty() {
                "primitive"
            } else {
                "composite"
            };
            let (buildable, unbuildable_reasons) = buildability(&f.src_text, &imports, &in_set, &f.src);
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

/// The names of TOP-LEVEL functional/algorithmic definitions under `path` that are NOT React components
/// (#3740) — named functions, and arrow-const utils/hooks. A component harvest lifts only PascalCase JSX
/// components, so these plain function/hook/util modules fall through silently; but they belong in the
/// ALGORITHMS graph (`bsc graph harvest`, which lifts exactly this shape). So `bsc ui harvest` surfaces
/// them (and points at `bsc graph harvest`) rather than dropping them between the two harvests. A
/// PascalCase name that renders JSX is a component (excluded); a data const (`export const x = {…}`) and a
/// component-internal local are correctly not listed (only top-level function-shaped defs). Handles a
/// single FILE or a DIR (#3722), order-stable + deduped, same dir/test-file skips as the component walk.
pub fn functional_module_names(path: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if path.is_file() {
        if let Some((src, tree)) = parse(path) {
            collect_functional_defs(tree.root_node(), &src, &mut out);
        }
    } else {
        functional_walk(path, &mut out);
    }
    out.sort();
    out.dedup();
    out
}

fn functional_walk(dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.is_dir() {
            if !SKIP_DIRS.contains(&name) && !is_nested_git_root(&path) {
                functional_walk(&path, out);
            }
        } else if let Some((src, tree)) = parse(&path) {
            collect_functional_defs(tree.root_node(), &src, out);
        }
    }
}

/// Collect the file's TOP-LEVEL (module-level) function/arrow-const definition names that are not
/// components — the reusable functional units. Only direct children of the module (optionally wrapped in
/// `export …`), never nested helpers, so the list is the module's public functional surface.
fn collect_functional_defs(root: Node, src: &[u8], out: &mut Vec<String>) {
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        let inner = if child.kind() == "export_statement" {
            child.named_child(0).unwrap_or(child)
        } else {
            child
        };
        match inner.kind() {
            "function_declaration" => {
                if let Some(name) = field_text(inner, "name", src) {
                    push_functional(name, inner, out);
                }
            }
            "lexical_declaration" | "variable_declaration" => {
                let mut c = inner.walk();
                for d in inner.children(&mut c) {
                    if d.kind() != "variable_declarator" {
                        continue;
                    }
                    // Only a def bound to a FUNCTION/ARROW is a functional module — a data const
                    // (`= {…}` / a value / a `call()` result) is not, and is correctly skipped.
                    let is_fn = d
                        .child_by_field_name("value")
                        .is_some_and(|v| matches!(v.kind(), "arrow_function" | "function" | "function_expression"));
                    if is_fn {
                        if let Some(name) = field_text(d, "name", src) {
                            push_functional(name, d, out);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

/// Push `name` as a functional module unless it is a React component (PascalCase + renders JSX — the
/// component harvest's job) or already collected. `node` is the def whose JSX is checked.
fn push_functional(name: String, node: Node, out: &mut Vec<String>) {
    let is_component = is_component_name(&name) && contains_jsx(node);
    if !(is_component || out.contains(&name)) {
        out.push(name);
    }
}

/// Is the closure a module the preview could compile, and if not, exactly why? The predicate mirrors
/// `bsc_component::graph_health::is_preview_buildable` (export present · no elision marker · no internal
/// import that resolves to nothing) but REPORTS its reasons instead of collapsing to a bool — the whole
/// point of #3470 is that "not buildable" must be a stated outcome, never a silent one.
///
/// `siblings` is what this harvest produced. An `@/…` import that lands on a sibling MODULE is NOT
/// counted against buildability — the preview vendors the closure of the siblings a component imports,
/// so that import resolves once the set is curated into one kit.
///
/// ── THE IMPORT IS KEPT IN `src_text`, NOT DROPPED ────────────────────────────────────────────────────
/// The other option was to elide a resolved sibling import from the emitted closure and lean on kit
/// resolution to supply the binding. It would be wrong, because that is not how the preview resolves a
/// sibling: `componentPreviewFiles` walks the source's OWN import specifiers (`importSpecs` → BFS),
/// resolves each against the sibling `src` paths (`resolveInternalBase`: `@/x` → `x`), and vendors the
/// modules it lands on. The import statement is therefore load-bearing TWICE — it is the only record of
/// which sibling to vendor, and it is what binds the identifier the JSX then renders. Drop it and esbuild
/// still bundles the module happily (a free identifier is just a global reference), so the candidate
/// would report `buildable: true` and then throw `ReferenceError: Button is not defined` at render —
/// trading an honest flag for a silent runtime failure, which is exactly the degradation this harvester
/// exists to prevent. Keeping the import also keeps the closure a faithful copy of the real source.
fn buildability(
    src_text: &str,
    imports: &[InternalImport],
    siblings: &SiblingIndex,
    from_rel: &str,
) -> (bool, Vec<String>) {
    let mut why = Vec::new();
    if !src_text.contains("export ") {
        why.push("no `export` — nothing for the preview to mount".to_string());
    }
    // The context-aware scanner now lives in the crate that owns the buildability predicates, so the
    // write-time gate and this harvest share ONE implementation rather than drifting copies (#3470).
    if bsc_component::graph_health::has_code_elision(src_text) {
        why.push("contains an elision marker (`…`) — a sketch, not code".to_string());
    }
    let unresolved: BTreeSet<&str> =
        imports.iter().filter(|i| !i.is_sibling(siblings, from_rel)).map(|i| i.spec.as_str()).collect();
    if !unresolved.is_empty() {
        let list = unresolved.iter().map(|m| format!("`{m}`")).collect::<Vec<_>>().join(", ");
        why.push(format!("unresolved internal import(s): {list} — resolve or vendor them"));
    }
    (why.is_empty(), why)
}

/// One INTERNAL (`@/…` alias OR relative `./`/`../`) import in a closure: the specifier and the names it
/// imports. `names` holds the IMPORTED names (`import { Button as Btn }` imports `Button`) — the identity
/// that matches a harvested component — and is EMPTY for a form whose bindings can't be attributed to
/// named exports (`import * as X`, a bare side-effect import), which therefore never counts as a sibling
/// import.
struct InternalImport {
    spec: String,
    names: Vec<String>,
}

/// The harvested set indexed for import resolution: component NAME → the module BASE(s) it was
/// harvested from (its `src` minus the extension). Both halves are needed. A name alone would forgive
/// `import { Button, useAppStore } from "@/store"` merely because some `Button` exists elsewhere; a path
/// alone can't be compared across roots. Together they answer the only question that matters — does this
/// specifier name a module this harvest produced?
#[derive(Default)]
struct SiblingIndex(std::collections::HashMap<String, Vec<String>>);

impl SiblingIndex {
    /// Was a component of this name harvested? (The `composes` membership test — by NAME, the component
    /// graph's key.)
    fn has(&self, name: &str) -> bool {
        self.0.contains_key(name)
    }

    /// Does an import of `names` from module base `spec_base` land on a harvested sibling module?
    fn resolves(&self, spec_base: &str, names: &[String]) -> bool {
        names.iter().any(|n| {
            self.0.get(n).is_some_and(|bases| bases.iter().any(|b| same_module(spec_base, b)))
        })
    }
}

/// A module's import base — its harvested `src` minus the TS/TSX extension, which is what an import
/// specifier resolves to (`resolve_internal_base`: `@/x` → `x`).
fn module_base(src: &str) -> String {
    src.trim_end_matches(".tsx").trim_end_matches(".ts").to_string()
}

/// Do two module bases name the same module? Equal, or one a SEGMENT-ALIGNED suffix of the other — the
/// harvest root is rarely the alias root, so a candidate harvested from `src/shared/ui` carries
/// `controls/Button` while the specifier says `@/shared/ui/controls/Button`. Comparing the shared tail
/// is what makes the two roots commensurable; requiring a `/` boundary keeps `…/IconButton` from
/// matching `…/Button`.
fn same_module(a: &str, b: &str) -> bool {
    a == b || a.ends_with(&format!("/{b}")) || b.ends_with(&format!("/{a}"))
}

impl InternalImport {
    /// Does this import land on a harvested sibling module? True when ANY imported binding is a
    /// harvested component AND the specifier names that component's module — at which point the WHOLE
    /// import resolves, because the preview vendors the module wholesale: the other bindings on the same
    /// specifier (`import { KeyValueList, type KeyValueItem } from "@/shared/ui/data/KeyValueList"`, a
    /// real and common shape here) come from that same vendored file. An `import * as X` is opaque
    /// (`names` empty) and never resolves, and nor does a specifier no harvested module answers to.
    ///
    /// `from_rel` is the IMPORTING candidate's own harvested `src` — needed to resolve a RELATIVE
    /// (`./`, `../`) specifier against the importer's directory (an `@/…` alias needs no such anchor).
    /// Shares `bsc_component::graph_health::resolve_internal_base` — the exact join/collapse rule
    /// `doctor` judges the same specifier by later, so harvest's `buildable` verdict can never disagree
    /// with `doctor`'s over how a `./…` import resolves (the #4 gap: a promoted component that harvest
    /// certified `buildable: true` reporting `no-implementation` in `doctor` with no way to tell why).
    fn is_sibling(&self, siblings: &SiblingIndex, from_rel: &str) -> bool {
        let Some(base) = bsc_component::graph_health::resolve_internal_base(&self.spec, from_rel) else {
            return false;
        };
        siblings.resolves(&base, &self.names)
    }
}

/// The internal (`@/…` alias OR relative `./`/`../`) imports of a module, with the names each binds.
/// Parsed rather than line-scanned: a multi-line `import {\n  Button,\n} from "@/…";` has no line that
/// both starts with `import ` and carries the specifier, so the line scan this replaced missed it
/// entirely and silently called such a closure buildable.
///
/// Relative imports USED to be skipped entirely here on the assumption that "the closure is built from
/// ONE file, so it never emits one" — false in practice: the closure only inlines SAME-FILE helpers, so a
/// component that genuinely imports a sibling MODULE via a relative path (`import { space } from
/// "./space"`) keeps that import verbatim, and it was silently exempted from the buildability check —
/// certifying `buildable: true` for a candidate `doctor`'s stricter, sibling-aware check then correctly
/// flags `no-implementation` on (#4). Scanning `./`/`../` here too closes that gap.
fn internal_imports(src_text: &str) -> Vec<InternalImport> {
    let mut out = Vec::new();
    let mut parser = Parser::new();
    let language: Language = tree_sitter_typescript::LANGUAGE_TSX.into();
    if parser.set_language(&language).is_err() {
        return out;
    }
    let Some(tree) = parser.parse(src_text, None) else { return out };
    let src = src_text.as_bytes();
    let root = tree.root_node();
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if child.kind() != "import_statement" {
            continue;
        }
        let Some(raw) = field_text(child, "source", src) else { continue };
        let spec = raw.trim_matches(|c| c == '"' || c == '\'').to_string();
        if !bsc_component::graph_health::is_internal_specifier(&spec) {
            continue;
        }
        let (mut names, mut opaque) = (Vec::new(), false);
        collect_imported_names(child, src, &mut names, &mut opaque);
        out.push(InternalImport { spec, names: if opaque { Vec::new() } else { names } });
    }
    out
}

/// The names an import statement pulls from its module. `opaque` is set by a namespace import
/// (`* as X`), whose bindings can't be attributed to individual exports — the caller then treats the
/// whole import as unattributable rather than guessing.
fn collect_imported_names(node: Node, src: &[u8], out: &mut Vec<String>, opaque: &mut bool) {
    match node.kind() {
        "namespace_import" => {
            *opaque = true;
            return;
        }
        // `{ Button }` / `{ Button as Btn }` — the `name` field is the EXPORTED name either way.
        "import_specifier" => {
            if let Some(n) = field_text(node, "name", src) {
                out.push(n);
            }
            return;
        }
        // A default import is a bare identifier directly under the clause (`import Button from "…"`).
        "import_clause" => {
            let mut c = node.walk();
            for ch in node.children(&mut c) {
                if ch.kind() == "identifier" {
                    if let Ok(t) = ch.utf8_text(src) {
                        out.push(t.to_string());
                    }
                }
            }
        }
        _ => {}
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_imported_names(child, src, out, opaque);
    }
}

/// One component located in one file, before cross-file `composes` resolution.
struct Found {
    name: String,
    src_text: String,
    src: String,
    /// PascalCase JSX tags rendered anywhere in the component.
    tags: Vec<String>,
}

/// Is `dir` the root of a NESTED git tree — a worktree, submodule, or vendored clone (#3571)? A git
/// worktree/submodule marks its root with a `.git` FILE (a `gitdir:` pointer), a standalone clone with a
/// `.git` DIRECTORY; either presence means a separate git root whose sources duplicate the primary tree.
fn is_nested_git_root(dir: &Path) -> bool {
    dir.join(".git").exists()
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<Found>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.is_dir() {
            // Never descend a vendored/build/VCS dir, NOR a NESTED git root (#3571): a subdir carrying its
            // own `.git` is a worktree or submodule — its `src/` is a duplicate copy of components already
            // harvested from the primary tree, so walking it double-counts every one. base-studio-code
            // keeps its issue worktrees (`wt3568/`, …) right beside `src/`, so harvesting the repo root was
            // reporting each component once per live worktree. (`.git` itself is in SKIP_DIRS, so this only
            // affects the CHILD dir that contains one — the root's own `.git` is never in play here.)
            if !SKIP_DIRS.contains(&name) && !is_nested_git_root(&path) {
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
            // A component bound to a variable: either DIRECTLY (`const X = () => …`) or WRAPPED in a
            // higher-order call (`const X = memo(…)` / `forwardRef(…)` / `observer(…)`) — a
            // `call_expression` value (#3571). The wrapped form was invisible before: the name still names
            // a component, and the JSX gate in `collect_component_defs` (`contains_jsx`) keeps a non-render
            // call like `const X = loadConfig()` out, since its subtree has no JSX. A bare JSX-element value
            // (`const X = <div/>`) is deliberately NOT matched — that is an element constant, not a
            // component the preview can mount.
            let bound_to_component = node
                .child_by_field_name("value")
                .map(|v| matches!(v.kind(), "arrow_function" | "function" | "function_expression" | "call_expression"))
                .unwrap_or(false);
            bound_to_component.then(|| field_text(node, "name", src)).flatten()
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

    /// Buildability of a standalone module — no harvest around it, so it has no siblings to resolve
    /// against (the pre-#3471 single-module judgement). `from_rel` is a placeholder path (its own
    /// existing tests only exercise `@/…` specifiers, which resolve independently of it).
    fn buildability_of(src: &str) -> (bool, Vec<String>) {
        buildability(src, &internal_imports(src), &SiblingIndex::default(), "user/Standalone.tsx")
    }

    /// Buildability of a module harvested alongside `siblings`, each given as `(name, src)`, as if this
    /// module itself lived at `from_rel` — needed to resolve any RELATIVE (`./`, `../`) import in `src`.
    fn buildability_with_at(src: &str, siblings: &[(&str, &str)], from_rel: &str) -> (bool, Vec<String>) {
        let mut idx = SiblingIndex::default();
        for (name, at) in siblings {
            idx.0.entry((*name).to_string()).or_default().push(module_base(at));
        }
        buildability(src, &internal_imports(src), &idx, from_rel)
    }

    /// [`buildability_with_at`] for the common case — the module's own path doesn't matter because `src`
    /// only imports by `@/…` alias (unaffected by `from_rel`).
    fn buildability_with(src: &str, siblings: &[(&str, &str)]) -> (bool, Vec<String>) {
        buildability_with_at(src, siblings, "user/Standalone.tsx")
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
        // #3470: such a srcText USED to store with NO complaint (looks_buildable_module was false, so
        // the syntax gate skipped entirely). Both the harvest and `bsc ui set` state it now. `Panel` imports a
        // harvested sibling AND the app store — the store binding is a real dangling import.
        let c = by_name("Panel");
        assert!(!c.buildable, "a component with an unresolved @/ import is not buildable");
        let why = c.unbuildable_reasons.join(" ");
        assert!(why.contains("`@/store`"), "the reason NAMES the import: {why}");
        // …and it does NOT condemn the sibling import alongside it.
        assert!(!why.contains("controls/Button"), "a sibling import is not a defect: {why}");
    }

    #[test]
    fn a_sibling_import_is_a_composes_edge_not_a_dangling_import() {
        // #3471 AC. `Card` imports `@/shared/ui/controls/Button`, and `Button` IS in this harvest — the
        // preview vendors the siblings a component imports (#3112), so judging `Card` alone was
        // pessimistic. MEASURED: 51 of 93 candidates harvested from this repo's own src/shared/ui were
        // unbuildable purely for `@/` imports, most of them pointing at other components in the set.
        let c = by_name("Card");
        assert!(c.buildable, "a harvested sibling import resolves: {:?}", c.unbuildable_reasons);
        assert!(c.unbuildable_reasons.is_empty());
        assert_eq!(c.composes, vec!["Button".to_string()], "it is an edge instead");
        // The import STAYS in the closure: it is what the preview's vendoring walk resolves and what
        // binds the identifier the JSX renders. Dropping it would build and then throw at render.
        assert!(
            c.src_text.contains(r#"import { Button } from "@/shared/ui/controls/Button";"#),
            "the sibling import is kept, not elided:\n{}",
            c.src_text
        );
    }

    #[test]
    fn an_imported_sibling_is_a_composes_edge_even_when_no_jsx_tag_renders_it() {
        // `Toolbar` hands `Button` to a render prop rather than rendering `<Button/>`, so the tag scan
        // sees nothing. The import is still a composition edge.
        let c = by_name("Toolbar");
        assert_eq!(c.composes, vec!["Button".to_string()]);
        assert_eq!(c.role, "composite");
    }

    #[test]
    fn only_imports_that_land_on_a_harvested_module_are_forgiven() {
        let harvest = [("Button", "controls/Button.tsx")];
        let render = "\nexport const A = () => <Button />;";
        // The specifier names the harvested module (across roots — `controls/Button` is the tail of
        // `@/shared/ui/controls/Button`).
        assert!(buildability_with(&format!("import {{ Button }} from \"@/shared/ui/controls/Button\";{render}"), &harvest).0);
        // Nothing of that name was harvested.
        assert!(!buildability_with(&format!("import {{ Button }} from \"@/shared/ui/controls/Button\";{render}"), &[("Card", "data/Card.tsx")]).0);
        // The name matches but the MODULE doesn't — the app store is not the harvested `Button` module,
        // so this is the app-state import that must stay a defect (a name-only rule would forgive it).
        let (ok, why) = buildability_with(&format!("import {{ Button, useAppStore }} from \"@/store\";{render}"), &harvest);
        assert!(!ok, "a name match on the wrong module is not a sibling import");
        assert!(why.iter().any(|r| r.contains("`@/store`")), "{why:?}");
        // A near-miss path must not match on a bare substring.
        assert!(!buildability_with(&format!("import {{ Button }} from \"@/ui/IconButton\";{render}"), &harvest).0);
        // A namespace import can't be attributed to named exports, so it is never assumed to be a sibling.
        assert!(!buildability_with(&format!("import * as Button from \"@/shared/ui/controls/Button\";{render}"), &harvest).0);
        // A type imported ALONGSIDE a harvested component resolves with it: the preview vendors the
        // module whole, so every binding on that specifier comes from the same file. (Real and common —
        // `import { KeyValueList, type KeyValueItem } from "@/shared/ui/data/KeyValueList"` accounts for
        // several of this repo's own pages.)
        assert!(buildability_with(&format!("import {{ Button, type ButtonProps }} from \"@/shared/ui/controls/Button\";{render}"), &harvest).0);
    }

    #[test]
    fn a_relative_import_to_no_harvested_sibling_is_flagged_not_silently_forgiven() {
        // #4: this is the exact class harvest used to be blind to — `internal_imports` only scanned
        // `@/…` specifiers, so a component keeping a genuine RELATIVE import to a module that was never
        // harvested (a real, common shape: `src/shared/ui/layout/Box.tsx` importing the sibling constants
        // module `./space`) was certified `buildable: true` regardless. `doctor`'s stricter, sibling-aware
        // check then correctly flagged it `no-implementation` once promoted — with harvest's own verdict
        // giving no hint why. Scanning `./`/`../` here closes that gap.
        let src = "import { space } from \"./space\";\nexport function Box() { return space; }";
        let (ok, why) = buildability_with_at(src, &[], "src/shared/ui/layout/Box.tsx");
        assert!(!ok, "an unresolved relative import is not buildable: {why:?}");
        assert!(why.iter().any(|r| r.contains("`./space`")), "the reason NAMES the import: {why:?}");
    }

    #[test]
    fn a_relative_import_landing_on_a_harvested_sibling_resolves() {
        // The same import, but `space` WAS harvested (from the same directory) — a real composing sibling,
        // resolved with the SAME join/collapse rule `doctor` uses (`graph_health::resolve_internal_base`),
        // so harvest and doctor can never disagree over whether `./space` resolves.
        let src = "import { space } from \"./space\";\nexport function Box() { return space; }";
        let siblings = [("space", "src/shared/ui/layout/space.ts")];
        let (ok, why) = buildability_with_at(src, &siblings, "src/shared/ui/layout/Box.tsx");
        assert!(ok, "a harvested relative sibling resolves: {why:?}");
        assert!(why.is_empty());
    }

    #[test]
    fn a_parent_relative_import_resolves_against_the_importers_directory() {
        // `../typography/Text` from `src/shared/ui/layout/Eyebrow.tsx` must resolve against
        // `src/shared/ui/typography/Text.tsx` — exercising the `..` segment collapse, not just `./`.
        let src = "import { Text } from \"../typography/Text\";\nexport function Eyebrow() { return <Text/>; }";
        let siblings = [("Text", "src/shared/ui/typography/Text.tsx")];
        let (ok, why) = buildability_with_at(src, &siblings, "src/shared/ui/layout/Eyebrow.tsx");
        assert!(ok, "a `../` import resolves against the importer's own directory: {why:?}");
    }

    #[test]
    fn a_multiline_import_is_seen() {
        // The line scanner this replaced only looked at lines STARTING with `import `, so a wrapped
        // import statement carried its specifier on an invisible line and the closure was silently
        // called buildable.
        let (ok, why) = buildability_of("import {\n  useAppStore,\n} from \"@/store\";\nexport const A = () => <b />;");
        assert!(!ok, "a wrapped import is still an import");
        assert!(why.iter().any(|r| r.contains("`@/store`")), "{why:?}");
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
            assert!(
                [".tsx", ".ts", ".jsx", ".js"].iter().any(|e| c.src.ends_with(e)),
                "{} -> {}", c.name, c.src,
            );
            assert_eq!(c.kit_id, DEFAULT_KIT);
            assert!(!c.src_text.is_empty());
        }
    }

    #[test]
    fn a_higher_order_wrapped_component_is_lifted() {
        // #3571: `export const Badge = memo(({text}) => <span/>)` — the value is a `call_expression`, so
        // the harvester skipped it before. The name still names a component and the closure renders JSX.
        let names: Vec<String> = run().into_iter().map(|c| c.name).collect();
        assert!(names.contains(&"Badge".to_string()), "a memo()-wrapped component is harvested: {names:?}");
        let b = by_name("Badge");
        assert!(b.src_text.contains("export const Badge = memo("), "keeps the wrapping call:\n{}", b.src_text);
    }

    #[test]
    fn a_plain_javascript_jsx_component_is_lifted() {
        // #3571: a `.jsx` file — a JS-React project harvested to ZERO candidates before .jsx/.js parsed.
        let c = by_name("LegacyChip");
        assert!(c.src.ends_with(".jsx"), "harvested from the .jsx source: {}", c.src);
        assert!(c.buildable, "a self-contained JS component is buildable: {:?}", c.unbuildable_reasons);
    }

    #[test]
    fn a_nested_git_worktree_is_not_walked() {
        // #3571: a subdir carrying its own `.git` is a worktree/submodule whose src is a DUPLICATE of the
        // primary tree — walking it double-counts every component. base-studio-code keeps `wt####/` beside
        // `src/`, so harvesting the repo root reported each component once per live worktree.
        let base = std::env::temp_dir().join(format!("bsc-harvest-nested-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // Primary tree: one real component.
        std::fs::create_dir_all(base.join("src")).unwrap();
        std::fs::write(base.join("src").join("Real.tsx"), "export const Real = () => <div/>;").unwrap();
        // A nested worktree with a `.git` marker (a file, as a real git worktree uses) and a duplicate.
        let wt = base.join("wt1234");
        std::fs::create_dir_all(wt.join("src")).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: ../.git/worktrees/wt1234").unwrap();
        std::fs::write(wt.join("src").join("Real.tsx"), "export const Real = () => <div/>;").unwrap();

        let names: Vec<String> = harvest(&base, DEFAULT_KIT).into_iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["Real".to_string()], "the worktree copy is skipped — no duplicate: {names:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn harvest_file_lifts_components_from_a_single_module() {
        // #3722: scope a harvest to ONE file. Two components in one module; `composes` resolves within it.
        let base = std::env::temp_dir().join(format!("bsc-harvest-file-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let file = base.join("Widgets.tsx");
        std::fs::write(&file, "export const Chip = () => <span/>;\nexport const Bar = () => <Chip/>;").unwrap();

        let cands = harvest_file(&file, DEFAULT_KIT);
        let names: Vec<&str> = cands.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"Chip") && names.contains(&"Bar"), "both components lifted: {names:?}");
        let bar = cands.iter().find(|c| c.name == "Bar").unwrap();
        assert_eq!(bar.composes, vec!["Chip".to_string()], "a sibling in the same file is a composes edge");
        assert_eq!(bar.src, "Widgets.tsx", "src is the file name for a single-file harvest");

        // A non-parseable single file (a test file) yields nothing — same skip the dir walk applies.
        let test = base.join("Widgets.test.tsx");
        std::fs::write(&test, "export const T = () => <span/>;").unwrap();
        assert!(harvest_file(&test, DEFAULT_KIT).is_empty(), "a test file yields no candidates");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn functional_module_names_lists_functions_and_hooks_not_components_or_data() {
        // #3740: the functional/algorithmic surface a COMPONENT harvest skips — routed to the algorithms
        // graph. Functions + arrow utils + hooks are listed; a component and a data const are not.
        let base = std::env::temp_dir().join(format!("bsc-functional-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(
            base.join("mix.tsx"),
            concat!(
                "export function Card() { return <div/>; }\n",                   // a component — excluded
                "export function formatDate(d: number) { return String(d); }\n", // a util fn — listed
                "export const clamp = (x: number) => Math.max(0, x);\n",         // an arrow util — listed
                "export function useThing() { return 1; }\n",                    // a hook — listed
                "export const SPACING = { sm: 4, md: 8 };\n",                    // a data const — excluded
            ),
        )
        .unwrap();

        let names = functional_module_names(&base);
        assert!(names.contains(&"formatDate".to_string()), "a util fn is listed: {names:?}");
        assert!(names.contains(&"clamp".to_string()), "an arrow util is listed: {names:?}");
        assert!(names.contains(&"useThing".to_string()), "a hook is listed: {names:?}");
        assert!(!names.contains(&"Card".to_string()), "a component is NOT listed (the component graph's job): {names:?}");
        assert!(!names.contains(&"SPACING".to_string()), "a data const is NOT a functional module: {names:?}");
        let _ = std::fs::remove_dir_all(&base);
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
        // in a doc comment. A plain substring test is wrong here — `looks_buildable_module` shared the
        // same flaw until #3470 moved this scanner down into bsc-component for both to use.
        assert!(buildability_of(r#"export const A = () => <input placeholder="Select…" />;"#).0, "UI copy");
        assert!(buildability_of("// mentions …
export function A() { return null; }").0, "line comment");
        assert!(buildability_of("/* block … */
export function A() { return null; }").0, "block comment");
        assert!(buildability_of("export const A = () => <b>{`tpl …`}</b>;").0, "template literal");
        // …but a real elision standing in for omitted CODE still fails.
        assert!(!buildability_of("export function A() { … }").0, "a genuine code elision");
    }

    #[test]
    fn buildability_names_each_distinct_failure() {
        let (ok, why) = buildability_of("export function A() { return null; }");
        assert!(ok, "{why:?}");
        let (no_export, why) = buildability_of("function A() { return null; }");
        assert!(!no_export);
        assert!(why.iter().any(|r| r.contains("export")), "{why:?}");
        let (elided, why) = buildability_of("export function A() { … }");
        assert!(!elided);
        assert!(why.iter().any(|r| r.contains('…')), "{why:?}");
    }
}

