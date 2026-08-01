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
/// shape, so the curation gate can review it straight into the library. `role` is a heuristic: a
/// function that composes no other harvested candidate is a `primitive`, one that calls other harvested
/// candidates is an `algorithm`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// Candidate id — `<kebab(name)>.<ext>` (the curation gate may re-key it).
    pub id: String,
    /// The source name of the function, verbatim (e.g. `quickSort`, `quick_sort`).
    pub name: String,
    /// The language it was harvested from: `"typescript"` | `"rust"`.
    pub tech: String,
    /// `"primitive"` | `"algorithm"` — the #2863 role tier, by the compose heuristic.
    pub role: &'static str,
    /// Ids of the same-tech harvested candidates this one calls (intra-project call edges).
    pub composes: Vec<String>,
    /// The function's full source text.
    pub code: String,
    /// The scanned-root-relative path of the file it came from, forward-slashed (#4091).
    ///
    /// PROVENANCE. Without it a harvested record cannot be traced to its file, deduped against a
    /// re-harvest, or joined back to the code that needs it — and ids collide freely, because they are
    /// derived from the bare function name (`dismiss.ts`, `approve.ts`, `app.ts` all recur across this
    /// repo's tree).
    pub src: String,
    /// The cross-language `domain` collection (#3120) this candidate belongs to, derived from [`Self::src`].
    ///
    /// Neither `harvest` nor `curate` used to set one, and per #3607 an impl with no domain does not
    /// surface in the graph UI — so a clean `curate --apply` landed records nobody could see.
    pub domain: String,
    /// The candidate's COLOCATED test file, carried at harvest time (#4126) — empty when it has none.
    ///
    /// Harvested WITH the candidate rather than by a later pass, so a `curate --apply` lands a node that
    /// is already testable-by-declaration. The separate `bsc graph tests harvest` stays for the records
    /// curated before this existed; a fresh harvest never needs it.
    pub tests: Vec<CandidateTest>,
    /// The reusability classification (#2745 slice 2) — library-worthy vs. project glue, with reasons.
    pub classification: Classification,
}

/// One colocated test file carried on a candidate — the `{name, src}` shape a stored impl's `tests`
/// array holds, identical to the component library's (#3907) so the two graphs read the same.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateTest {
    /// The file's first top-level `describe(…)` title, else its basename.
    pub name: String,
    /// The test file's contents, VERBATIM — one entry per FILE, never split per `it()`, because a
    /// file's meaning lives partly in its imports, `beforeEach` and local helpers.
    pub src: String,
}

/// One collected definition: `(name, tech, source text, root-relative path)`. Named so the extra
/// provenance field (#4091) doesn't turn every signature into an unreadable tuple.
type Def = (String, String, String, String);

/// Path segments we never descend into or parse — vendored deps, build output, VCS/tooling dirs.
const SKIP_DIRS: &[&str] = &["node_modules", "target", ".git", ".claude", "dist", "build"];

/// Test files carry no production implementation — skip them.
fn is_test_file(name: &str) -> bool {
    name.ends_with(".test.ts") || name.ends_with(".test.tsx") || name.ends_with(".spec.ts")
}

/// Normalize a function name to a candidate kebab-case id: split camelCase / PascalCase humps and
/// snake_case underscores, lowercase everything. A run of uppercase letters stays fused (so `FFT` →
/// `fft`, not `f-f-t`). Leading/trailing separators are trimmed.
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

/// The reusability classification of a harvested candidate (#2745 slice 2) — whether it's a
/// library-worthy building block vs. project-specific glue, the weighted score, and the reasons.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Classification {
    /// The candidate cleared the worthiness threshold (a net-positive score).
    pub worthy: bool,
    /// The weighted signal score (generics + composition raise it; a glue name or a trivial body
    /// lower it).
    pub score: i32,
    /// Human-readable reasons behind the score — one per signal that fired.
    pub reasons: Vec<String>,
}

/// App-glue / trait-boilerplate function names — entry points + Rust trait methods that are not
/// reusable algorithm building blocks (matched case-insensitively as an exact name).
const GLUE_NAMES: &[&str] = &[
    "main", "run", "dispatch", "register", "serve", "listen", "connect", "new", "default", "from",
    "into", "fmt", "drop", "next", "clone",
];

/// Does the function's name read as project glue / trait boilerplate rather than a reusable algorithm?
fn is_glue_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    GLUE_NAMES.contains(&n.as_str())
        || n.starts_with("handle")
        || n.starts_with("setup")
        || n.starts_with("init")
        || n.starts_with("on_")
        || n.contains("helper")
}

/// Does the function declare its OWN type parameters (a `<…>` in the signature, before the parameter
/// list)? A generic function is reusable across types rather than welded to one concrete app type.
fn is_generic(code: &str) -> bool {
    code.split_once('(').map(|(sig, _)| sig.contains('<')).unwrap_or(false)
}

/// Is the body empty of real statements (only comments / whitespace / braces)? Nothing worth storing.
/// A brace-less expression body (a one-liner arrow) is NOT trivial — it computes something.
fn is_trivial(code: &str) -> bool {
    match code.split_once('{') {
        Some((_, body)) => !body.lines().any(|l| {
            let t = l.trim();
            !t.is_empty() && !t.starts_with("//") && t != "}" && t != "{"
        }),
        None => false,
    }
}

/// Is `name` a React hook — `use` followed by an upper-case letter (`useFleetLive`, `usePageTabs`)?
///
/// A hook is bound to React's runtime AND, in practice, to this app's store and command surface. It is
/// not something another project reaches for, so it is app glue however clean it reads (#4091).
fn is_react_hook(name: &str) -> bool {
    name.strip_prefix("use").is_some_and(|rest| rest.starts_with(char::is_uppercase))
}

/// Identifiers that make a function EFFECTFUL or bound to this app's own vocabulary rather than a
/// portable computation — the host bridge, browser globals, and the app's store (#4091).
const APP_COUPLING: &[&str] = &[
    "useAppStore", "safeInvoke", "fireInvoke", "@tauri-apps", "localStorage",
    "document.", "window.", "fetch(", "process.env", "Command::new", "spawn(",
    // BOTH call shapes: a generic type argument (`invoke<LlmReply>(…)`) is the common form in this
    // codebase and a bare `invoke(` token misses every one of them.
    "invoke(", "invoke<",
];

/// Does the body reach for the host, the browser, or the app's own store? Such a function computes
/// nothing portable — it MOVES data across this app's boundaries, which is the host's job, not the
/// library's.
fn is_app_coupled(code: &str) -> bool {
    APP_COUPLING.iter().any(|tok| code.contains(tok))
}

/// Does `src` sit under a FEATURE slice — code written for one app's vocabulary by construction?
///
/// Deliberately a location signal, not a content one: `features/planner/lib/focusedPlan.ts` may be
/// clean, generic-looking TypeScript and still be meaningless outside this product. The bar #4091 sets
/// is "would another project reach for this?", and a feature-local module answers no by definition.
fn is_feature_local(src: &str) -> bool {
    src.contains("features/") || src.contains("/panes/") || src.starts_with("app/")
}

/// The cross-language `domain` (#3120) a candidate belongs to, derived from its source path — the
/// facet #3607 requires or the record is invisible in the graph UI.
///
/// `features/<x>/…` → `<x>`; `shared/<x>/…` → `<x>`; a crate path → the crate name; else the first
/// meaningful segment. Always non-empty, so a harvested record can never land un-faceted.
pub fn domain_of(src: &str) -> String {
    // `src`/`lib` are STRUCTURAL containers, not domains — `shared/lib/algorithms/orderByRank.ts` is
    // the `algorithms` domain, not the `lib` one. Dropping them is what makes the facet describe the
    // subject rather than the folder layout.
    const CONTAINERS: &[&str] = &["src", "lib"];
    let segs: Vec<&str> = src
        .split('/')
        .filter(|s| !s.is_empty() && !CONTAINERS.contains(s))
        .collect();
    // The LAST segment is the file itself, never a domain (a one-file `src` would otherwise be named
    // after its own filename).
    let dirs = &segs[..segs.len().saturating_sub(1)];
    let pick = |i: usize| dirs.get(i).copied().unwrap_or("misc");
    match dirs.first().copied() {
        Some("features") | Some("shared") | Some("crates") => pick(1),
        Some("app") => "shell",
        Some(first) => first,
        None => "misc",
    }
    .to_string()
}

/// Classify a candidate's reusability (#2745 slice 2, tightened #4091): a weighted score over cheap,
/// derivable signals — generics and real composition raise it; app glue lowers it.
///
/// **The bar is "would a DIFFERENT project reach for this?"**, not "does this look algorithmic". That
/// distinction became load-bearing with the host-API direction: a module that closes over this app's
/// vocabulary — its store shape, its command surface, its feature slices — belongs in the app as host
/// code, NOT in a reusable-knowledge library. Curating glue here would fill the library with things
/// meaningful in exactly one codebase.
///
/// The threshold stays net-positive; what changed is that the NEGATIVES now carry the discrimination.
/// Under the old signal set a single `composes` edge admitted anything that called anything — 1908 of
/// this repo's 3257 candidates read as worthy, the tree relabelled rather than a shortlist. Raising the
/// threshold instead was tried and is wrong: `generic` fires on only ~80 functions here, so a higher bar
/// starves out `shared/lib/algorithms/*` itself, which is by definition the library material.
///
/// This is a TRIAGE heuristic feeding a reviewer, not an oracle. It is tuned for a reviewable shortlist
/// with good recall; a curator still decides. Cheap textual signals cannot catch transitive coupling
/// (a pure-looking wrapper around an effectful call), and this does not pretend to.
pub fn classify(c: &Candidate) -> Classification {
    let mut score = 0;
    let mut reasons = Vec::new();
    if is_generic(&c.code) {
        score += 1;
        reasons.push("generic — reusable across types".to_string());
    }
    if !c.composes.is_empty() {
        score += 1;
        reasons.push(format!("composes {} building block(s)", c.composes.len()));
    }
    if is_glue_name(&c.name) {
        score -= 2;
        reasons.push("app-glue / boilerplate name".to_string());
    }
    if is_trivial(&c.code) {
        score -= 2;
        reasons.push("trivial body — nothing to store".to_string());
    }
    if is_react_hook(&c.name) {
        score -= 3;
        reasons.push("a React hook — bound to this app's runtime, not portable".to_string());
    }
    if is_app_coupled(&c.code) {
        score -= 3;
        reasons.push("reaches the host, the browser or the app store — glue, not a computation".to_string());
    }
    if is_feature_local(&c.src) {
        score -= 2;
        reasons.push(format!("lives in an app feature slice ({}) — written for one product", c.src));
    }
    Classification { worthy: score >= 1, score, reasons }
}

/// One curation decision (#2745 slice 3) — a worthy candidate to store, plus the existing library impl
/// it REPLACES (an optimize) or `None` (a fresh add).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurationItem {
    /// The candidate to store as a canonical library implementation.
    pub candidate: Candidate,
    /// `Some(id)` = optimize (the store already holds an impl with this id → replace it); `None` = add.
    pub replaces: Option<String>,
}

/// One `relink` decision (#4119) — what recovering an impl's `src` would do, before anything is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelinkOutcome {
    /// Exactly one harvested file carries this id — recover its `src` and the folder it derives.
    Link { id: String, src: String, folder: Option<String> },
    /// The id maps to SEVERAL harvested files. Never guessed: see [`relink_plan`].
    Ambiguous { id: String, candidates: Vec<String> },
    /// Nothing harvested under this id — the source may be gone, renamed, or outside the scanned dir.
    Unmatched { id: String },
    /// Already carries `src`; left alone, so a re-run is a no-op.
    AlreadyLinked { id: String },
    /// A `primitive` — it DESCRIBES a language built-in via `--ref` and is never re-coded (#2972), so
    /// it has no source file BY DESIGN. Skipped rather than counted a miss: reporting it unmatched
    /// implies provenance is missing when its absence is the contract, and matching it against a
    /// same-named function somewhere in the tree would invent one.
    Primitive { id: String },
}

/// Plan the recovery of `src` on stored impls by matching them to a fresh harvest (#4119). Pure —
/// APPLYING the plan (writing the store) is the caller's job, exactly like [`curation_plan`].
///
/// `by_id` maps a candidate id to the DISTINCT source paths harvested under it. More than one is
/// **ambiguous and is never resolved by picking**: a candidate id is `<kebab(name)>.<ext>`, and bare
/// function names collide freely across a real tree (`dismiss.ts`, `approve.ts`, `app.ts` all recur) —
/// which is precisely why an id cannot serve as identity and why `src` is needed at all. Writing a
/// plausibly-wrong provenance is worse than writing none: it would silently file the record under
/// another module's folder and defeat the dedupe it exists to enable.
pub fn relink_plan(
    stored: &[serde_json::Value],
    by_id: &std::collections::BTreeMap<String, std::collections::BTreeSet<String>>,
) -> Vec<RelinkOutcome> {
    stored
        .iter()
        .map(|im| {
            let id = im.get("id").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
            if im
                .get("src")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|s| !s.trim().is_empty())
            {
                return RelinkOutcome::AlreadyLinked { id };
            }
            if im.get("role").and_then(serde_json::Value::as_str) == Some("primitive") {
                return RelinkOutcome::Primitive { id };
            }
            match by_id.get(&id) {
                None => RelinkOutcome::Unmatched { id },
                Some(srcs) if srcs.len() > 1 => {
                    RelinkOutcome::Ambiguous { id, candidates: srcs.iter().cloned().collect() }
                }
                Some(srcs) => {
                    let src = srcs.iter().next().expect("non-empty").clone();
                    let folder = bsc_util::folder_from_src(&src);
                    RelinkOutcome::Link { id, src, folder }
                }
            }
        })
        .collect()
}

/// Plan the curation of worthy candidates into the library (#2745 slice 3): each becomes an `add`, or an
/// `optimize` when an implementation with the same id is already stored (the harvested version replaces
/// it — the "better version propagates"). Pure — APPLYING the plan (writing the store) is the caller's job.
pub fn curation_plan(worthy: &[Candidate], existing: &[serde_json::Value]) -> Vec<CurationItem> {
    let existing_ids: HashSet<&str> = existing
        .iter()
        .filter_map(|e| e.get("id").and_then(serde_json::Value::as_str))
        .collect();
    worthy
        .iter()
        .map(|c| CurationItem {
            replaces: existing_ids.contains(c.id.as_str()).then(|| c.id.clone()),
            candidate: c.clone(),
        })
        .collect()
}

/// The file extension (impl id suffix) for a tech.
fn ext_of(tech: &str) -> &'static str {
    match tech {
        "rust" => "rs",
        _ => "ts",
    }
}

/// Harvest `dir` into candidate library implementations (#2745): every function definition becomes a
/// `Candidate` carrying its source, a heuristic role, and the ids of the same-tech candidates it calls
/// (`composes`). Order-stable; skips vendored/build/VCS dirs + test
/// files. Storing candidates is the curation gate's job, not this function's.
pub fn harvest(dir: &Path) -> Vec<Candidate> {
    let defs = harvest_defs(dir);
    // Raw intra-project call edges (caller name → callee name, per tech), reused for `composes`.
    let mut raw: Vec<(String, String, String)> = Vec::new();
    walk_calls(dir, &mut raw);
    // Which (name, tech) pairs were actually harvested — so `composes` only links in-set candidates.
    let in_set: HashSet<(String, String)> =
        defs.iter().map(|(n, t, _, _)| (n.clone(), t.clone())).collect();
    // Colocated tests, read ONCE PER FILE (#4126). Many candidates share one source — this repo's
    // `sorts.test.ts` covers four impls and `graphAlgos.test.ts` five — so pairing per candidate would
    // re-read the same file dozens of times across a 1780-candidate walk.
    let mut test_cache: std::collections::BTreeMap<String, Vec<CandidateTest>> = Default::default();
    for (_, _, _, src_rel) in &defs {
        if test_cache.contains_key(src_rel) {
            continue;
        }
        let found = bsc_util::test_path_for(dir, src_rel)
            .and_then(|p| std::fs::read_to_string(&p).ok().map(|c| (p, c)))
            .map(|(p, contents)| {
                vec![CandidateTest { name: bsc_util::test_display_name(&p, &contents), src: contents }]
            })
            .unwrap_or_default();
        test_cache.insert(src_rel.clone(), found);
    }
    defs.into_iter()
        .map(|(name, tech, code, src_rel)| {
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
            let mut c = Candidate {
                id: format!("{}.{}", kebab(&name), ext_of(&tech)),
                role,
                composes,
                tech,
                name,
                code,
                domain: domain_of(&src_rel),
                tests: test_cache.get(&src_rel).cloned().unwrap_or_default(),
                src: src_rel,
                classification: Classification::default(),
            };
            c.classification = classify(&c);
            c
        })
        .collect()
}

/// Collect every function definition under `dir` as `(name, tech, source text, root-relative path)`.
/// Order-stable.
fn harvest_defs(dir: &Path) -> Vec<Def> {
    let mut out = Vec::new();
    harvest_walk(dir, dir, &mut out);
    out
}

/// `root` is the directory the scan STARTED at, so each def carries a path relative to it (#4091) —
/// stable across machines, unlike an absolute one.
fn harvest_walk(dir: &Path, root: &Path, out: &mut Vec<Def>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.is_dir() {
            if !SKIP_DIRS.contains(&name) {
                harvest_walk(&path, root, out);
            }
        } else if let Some((tech, src, tree)) = parse(&path) {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            collect_defs(tree.root_node(), &src, tech, false, &rel, &mut *out);
        }
    }
}

/// Recursively collect `(name, tech, source text)` for every function definition under `node`, SKIPPING
/// Rust inline test code — a `#[test]` fn or anything inside a `#[cfg(test)]` module — since tests
/// aren't reusable library bits (#2955).
fn collect_defs(node: Node, src: &[u8], tech: &str, in_test: bool, rel: &str, out: &mut Vec<Def>) {
    let name = fn_def_name(node, src);
    let could_be_test = node.kind() == "mod_item" || name.is_some();
    let in_test = in_test || (could_be_test && has_test_attr(node, src));
    if !in_test {
        if let Some(name) = name {
            // Only a MODULE-LEVEL function is a library candidate (#4091). A nested closure —
            // `step` inside `useDockEntrance`, `onKey` inside `useModalDismiss`, `tick` inside `usePoll`
            // — is not reusable by construction: nothing outside its parent can even name it. Harvesting
            // those was the bulk of the noise, and no scoring weight can fix a candidate that should
            // never have been a candidate.
            let module_level = is_module_level(node);
            // A function that renders JSX is a COMPONENT, and components are the component graph's
            // (`bsc ui harvest`) — not the algorithms library's (#4091). Without this the two harvests
            // claim the same tree: `bsc graph harvest src` was lifting `PathExposeBanner` and the whole
            // banner set as "algorithms". Skipped outright rather than scored down, because it is not a
            // weak algorithm — it is a different KIND of node, owned by a different store.
            if module_level && !renders_jsx(node) {
                if let Ok(code) = node.utf8_text(src) {
                    out.push((name, tech.to_string(), code.to_string(), rel.to_string()));
                }
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_defs(child, src, tech, in_test, rel, out);
    }
}

/// Is this definition at MODULE level — i.e. not declared inside another function's body?
///
/// The test is nesting, deliberately NOT export-ness. A private module-level helper (`function merge<T>`
/// in this crate's own fixture) is a real algorithm that simply isn't part of its module's public API,
/// and dropping it would lose exactly the kind of building block the library wants. What must go is the
/// nested CLOSURE — `step` inside `useDockEntrance`, `tick` inside `usePoll` — which nothing outside its
/// parent can name, so it cannot be reused by anyone under any circumstances.
///
/// Implemented by walking ancestors and stopping at the first function body: a `statement_block` (or a
/// Rust `block`) between the definition and the file means it was declared inside something.
fn is_module_level(node: Node) -> bool {
    let mut cur = node;
    while let Some(parent) = cur.parent() {
        if matches!(parent.kind(), "statement_block" | "block") {
            return false;
        }
        cur = parent;
    }
    true
}

/// Does the subtree under `node` contain JSX — i.e. does this function RENDER? Exact (a tree-sitter
/// node kind), never a `<` heuristic, which would mistake every TypeScript generic for markup.
fn renders_jsx(node: Node) -> bool {
    if matches!(node.kind(), "jsx_element" | "jsx_self_closing_element" | "jsx_fragment") {
        return true;
    }
    let mut cursor = node.walk();
    let kids: Vec<Node> = node.children(&mut cursor).collect();
    kids.into_iter().any(renders_jsx)
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

/// Does `node` carry a preceding Rust `#[test]` / `#[cfg(test)]` (or `::test`) attribute? Used to skip
/// inline test functions and test modules — they aren't reusable library bits (#2955). Walks the
/// preceding-sibling attributes (they stack and may be interleaved with comments).
fn has_test_attr(node: Node, src: &[u8]) -> bool {
    let mut prev = node.prev_sibling();
    while let Some(p) = prev {
        match p.kind() {
            "attribute_item" => {
                let t = p.utf8_text(src).unwrap_or("");
                if t.contains("test]") || t.contains("test)") {
                    return true;
                }
                prev = p.prev_sibling();
            }
            "line_comment" | "block_comment" => prev = p.prev_sibling(),
            _ => break,
        }
    }
    false
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
            collect_calls(tree.root_node(), &src, tech, false, None, out);
        }
    }
}

/// Recursively collect raw `(caller_name, callee_name, tech)` call sites, threading the NEAREST
/// enclosing named function through the walk. A function-definition node sets `enclosing` to its own
/// name for its whole subtree; a `call_expression` reached while inside a named function records an
/// edge from that function to the callee (when a callee name can be read).
fn collect_calls(node: Node, src: &[u8], tech: &str, in_test: bool, enclosing: Option<&str>, out: &mut Vec<(String, String, String)>) {
    let defined = fn_def_name(node, src);
    let could_be_test = node.kind() == "mod_item" || defined.is_some();
    let in_test = in_test || (could_be_test && has_test_attr(node, src));
    let current = defined.as_deref().or(enclosing);
    if !in_test && node.kind() == "call_expression" {
        if let (Some(caller), Some(callee)) = (current, callee_name(node, src, tech)) {
            out.push((caller.to_string(), callee, tech.to_string()));
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_calls(child, src, tech, in_test, current, out);
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
    fn harvest_lifts_functions_into_library_candidates() {
        let cands = harvest(&fixtures());
        let find = |name: &str, tech: &str| cands.iter().find(|c| c.name == name && c.tech == tech);

        // A Rust merge_sort is harvested with its full source, role algorithm.
        let ms = find("merge_sort", "rust").expect("rust merge_sort harvested");
        assert_eq!(ms.id, "merge-sort.rs");
        assert_eq!(ms.role, "algorithm");
        assert!(ms.code.contains("fn merge_sort"), "the candidate carries its full source");
        // merge_sort calls merge(...) in-set (its self-recursion is dropped) → composes the merge candidate.
        assert_eq!(ms.composes, vec!["merge.rs".to_string()]);

        // The merge primitive composes no in-set candidate → role primitive.
        let merge = find("merge", "rust").expect("rust merge harvested");
        assert_eq!(merge.role, "primitive");
        assert!(merge.composes.is_empty());

        // An app helper is still harvested as a candidate — the classifier decides its worthiness.
        let helper = cands.iter().find(|c| c.name == "helperThing").expect("helperThing harvested");
        assert_eq!(helper.tech, "typescript");

        // Every candidate carries non-empty code, a known tech, and a role.
        assert!(cands.iter().all(|c| !c.code.trim().is_empty()));
        assert!(cands.iter().all(|c| c.tech == "typescript" || c.tech == "rust"));
        assert!(cands.iter().all(|c| c.role == "primitive" || c.role == "algorithm"));
    }

    #[test]
    fn harvest_skips_rust_inline_test_functions() {
        // sample.rs has a `#[cfg(test)] mod tests` with a `#[test] fn test_only_helper` — it must NOT
        // leak into the harvest as a candidate (#2955).
        let cands = harvest(&fixtures());
        assert!(
            cands.iter().all(|c| c.name != "test_only_helper"),
            "inline #[test] fns / #[cfg(test)] mods are skipped",
        );
    }

    fn stored(id: &str, src: Option<&str>) -> serde_json::Value {
        match src {
            Some(sp) => serde_json::json!({ "id": id, "src": sp }),
            None => serde_json::json!({ "id": id }),
        }
    }

    fn index(pairs: &[(&str, &str)]) -> std::collections::BTreeMap<String, std::collections::BTreeSet<String>> {
        let mut m: std::collections::BTreeMap<String, std::collections::BTreeSet<String>> = Default::default();
        for (id, src) in pairs {
            m.entry((*id).to_string()).or_default().insert((*src).to_string());
        }
        m
    }

    #[test]
    fn harvest_carries_the_colocated_test_onto_every_candidate_from_that_file() {
        // #4126 — tests ride in WITH the harvest, so a `curate --apply` lands a node that already
        // declares its tests and no second pass is needed. The fixture dir has `sample.test.ts` beside
        // `sample.ts`, so every candidate lifted from that file carries it.
        let cands = harvest(&fixtures());
        let from_ts: Vec<&Candidate> = cands.iter().filter(|c| c.src == "sample.ts").collect();
        assert!(from_ts.len() > 1, "the fixture yields several candidates from one file");
        for c in &from_ts {
            assert_eq!(c.tests.len(), 1, "{} carries its colocated test", c.name);
            assert!(c.tests[0].src.contains("#4126"), "verbatim file contents, not a path");
        }
        // ONE file covering SEVERAL candidates is carried onto EACH — this repo's `graphAlgos.test.ts`
        // covers five impls, and per-impl attribution is not recoverable from the file.
        assert_eq!(
            from_ts[0].tests[0].name, from_ts[1].tests[0].name,
            "siblings from one source share the identical entry",
        );
        // A candidate whose file has no sibling test carries none — never an empty-but-present claim.
        assert!(
            cands.iter().any(|c| c.tests.is_empty()),
            "a source with no colocated test yields candidates with no tests",
        );
    }

    #[test]
    fn relink_recovers_src_and_derives_the_folder_in_one_pass() {
        // #4119 — `folder` derives from `src`, so an impl without provenance is `srcless` and skipped
        // by `refolder`. Recovering the two together means one pass, not a refolder chaser.
        let plan = relink_plan(
            &[stored("order-by-rank.ts", None)],
            &index(&[("order-by-rank.ts", "shared/lib/algorithms/orderByRank.ts")]),
        );
        assert_eq!(
            plan,
            vec![RelinkOutcome::Link {
                id: "order-by-rank.ts".into(),
                src: "shared/lib/algorithms/orderByRank.ts".into(),
                folder: Some("shared/lib/algorithms".into()),
            }],
        );
    }

    #[test]
    fn relink_never_guesses_an_ambiguous_id() {
        // A candidate id is `<kebab(name)>.<ext>`, and bare function names collide across a real tree.
        // Picking one would file the record under ANOTHER module's folder and defeat the dedupe `src`
        // exists to enable — so a multi-match is reported, never resolved.
        let plan = relink_plan(
            &[stored("dismiss.ts", None)],
            &index(&[("dismiss.ts", "features/a/dismiss.ts"), ("dismiss.ts", "features/b/dismiss.ts")]),
        );
        match &plan[0] {
            RelinkOutcome::Ambiguous { id, candidates } => {
                assert_eq!(id, "dismiss.ts");
                assert_eq!(candidates.len(), 2, "both files are named, so a human can settle it");
            }
            other => panic!("expected Ambiguous, got {other:?}"),
        }
    }

    #[test]
    fn relink_never_invents_provenance_for_a_primitive() {
        // #2972 — a primitive DESCRIBES a language built-in via `--ref` and is never re-coded, so it
        // has no source file by design. Matching it against a same-named function in the tree would
        // manufacture provenance for something that legitimately has none.
        let prim = serde_json::json!({ "id": "vec.rs", "role": "primitive" });
        let plan = relink_plan(&[prim], &index(&[("vec.rs", "crates/whatever/vec.rs")]));
        assert_eq!(plan, vec![RelinkOutcome::Primitive { id: "vec.rs".into() }]);
    }

    #[test]
    fn relink_leaves_an_already_linked_impl_alone_and_reports_a_miss() {
        // Idempotence: a re-run must change nothing. And an id nothing harvested is UNMATCHED, not an
        // error — the source may be renamed, deleted, or simply outside the scanned dir.
        let plan = relink_plan(
            &[stored("kept.ts", Some("shared/lib/kept.ts")), stored("gone.ts", None)],
            &index(&[("kept.ts", "somewhere/else/kept.ts")]),
        );
        assert_eq!(plan[0], RelinkOutcome::AlreadyLinked { id: "kept.ts".into() },
            "an existing src is never overwritten, even when the harvest disagrees");
        assert_eq!(plan[1], RelinkOutcome::Unmatched { id: "gone.ts".into() });
    }

    #[test]
    fn relink_uses_the_shared_folder_derivation() {
        // Both libraries must fold identically — same helper, so `shared/lib/algorithms/x.ts` and a
        // component at the same path land in the same folder.
        let plan = relink_plan(
            &[stored("x.ts", None)],
            &index(&[("x.ts", "src/shared/ui/controls/Button.tsx")]),
        );
        let RelinkOutcome::Link { folder, .. } = &plan[0] else { panic!("expected Link") };
        assert_eq!(folder.as_deref(), bsc_util::folder_from_src("src/shared/ui/controls/Button.tsx").as_deref());
        assert_eq!(folder.as_deref(), Some("shared/ui/controls"), "the leading `src/` root is stripped");
    }

    #[test]
    fn a_component_is_the_component_graphs_not_the_librarys() {
        // #4091 — `bsc graph harvest src` was lifting React components (`PathExposeBanner`, the whole
        // banner set) as "algorithms", so the two harvests claimed the same tree. A function that
        // renders JSX is a different KIND of node, owned by `bsc ui harvest`, and is skipped outright.
        let cands = harvest(&fixtures());
        assert!(
            !cands.iter().any(|c| c.name == "StatusBadge"),
            "a JSX-rendering function is not an algorithm candidate: {:?}",
            cands.iter().map(|c| &c.name).collect::<Vec<_>>(),
        );
        // The rule is the tree-sitter node kind, never a `<` scan — a generic must survive it.
        assert!(cands.iter().any(|c| c.name == "quickSort"), "a generic <T> function is not JSX");
    }

    #[test]
    fn a_nested_closure_is_not_a_library_candidate() {
        // Nothing outside `rollingMean` can name `step`, so it cannot be reused by anyone — no scoring
        // weight fixes a candidate that should never have been one. This was the bulk of the noise
        // (`step` in useDockEntrance, `tick` in usePoll, `onKey` in useModalDismiss).
        let cands = harvest(&fixtures());
        assert!(cands.iter().any(|c| c.name == "rollingMean"), "the module-level function IS a candidate");
        assert!(!cands.iter().any(|c| c.name == "step"), "its inner closure is not");
    }

    #[test]
    fn a_private_module_level_helper_is_still_a_candidate() {
        // The rule is NESTING, deliberately not export-ness: `function merge<T>` in the fixture is not
        // exported yet is a real building block. An export-only rule would drop exactly the kind of
        // primitive the library wants (and would break `mergeSort`'s compose edge onto it).
        let cands = harvest(&fixtures());
        let merge = cands.iter().find(|c| c.name == "merge" && c.tech == "typescript");
        assert!(merge.is_some(), "a private module-level helper is harvested");
    }

    #[test]
    fn every_candidate_carries_provenance_and_a_domain() {
        // #4091 — without `src` a record cannot be traced to its file, deduped against a re-harvest, or
        // joined back; without `domain` it does not surface in the graph UI at all (#3607), so a clean
        // `curate --apply` used to land work nobody could see.
        for c in harvest(&fixtures()) {
            assert!(!c.src.trim().is_empty(), "{} carries its source path", c.name);
            assert!(!c.domain.trim().is_empty(), "{} carries a domain facet", c.name);
            // Forward-slashed on EVERY platform, so a record harvested on Windows and one harvested on
            // Linux carry the same path — `MAIN_SEPARATOR` would be a no-op assertion on Unix.
            assert!(!c.src.contains('\\'), "the path is forward-slashed: {}", c.src);
        }
    }

    #[test]
    fn domain_drops_structural_containers_and_the_filename() {
        // `lib`/`src` are folder layout, not subject matter — the facet must describe what the code IS.
        assert_eq!(domain_of("shared/lib/algorithms/orderByRank.ts"), "algorithms");
        assert_eq!(domain_of("src/shared/lib/github/probe.ts"), "github");
        assert_eq!(domain_of("features/planner/lib/focusedPlan.ts"), "planner");
        assert_eq!(domain_of("app/console/panes/PaneAt.tsx"), "shell");
        assert_eq!(domain_of("crates/bsc-graph/src/extract.rs"), "bsc-graph");
        // The last segment is the FILE; a bare file must not be named after itself.
        assert_eq!(domain_of("format.ts"), "misc");
    }

    #[test]
    fn a_hook_and_an_app_coupled_function_are_not_library_worthy() {
        // The bar is "would a DIFFERENT project reach for this?", which is what makes the classifier the
        // line between the LIBRARY and the app's own host code — not a tidiness score.
        let cands = harvest(&fixtures());
        let hook = cands.iter().find(|c| c.name == "useThingCount").expect("harvested");
        assert!(!hook.classification.worthy, "a React hook is app glue: {:?}", hook.classification);
        assert!(
            hook.classification.reasons.iter().any(|r| r.contains("React hook")),
            "the reason NAMES why: {:?}", hook.classification.reasons,
        );
        // `invoke<T>(…)` — the generic call shape a bare `invoke(` token misses entirely.
        assert!(is_app_coupled("const r = await invoke<LlmReply>(\"llm_complete\", {});"));
        assert!(is_app_coupled("const r = await invoke(\"cmd\");"));
        assert!(!is_app_coupled("return xs.map((x) => x * 2);"), "a pure computation is not coupled");
    }

    #[test]
    fn classify_scores_library_worthy_vs_glue() {
        let cands = harvest(&fixtures());
        let of = |name: &str| cands.iter().find(|c| c.name == name).expect("harvested");

        // Recognized algorithms — generic + real composition → library-worthy.
        for name in ["merge_sort", "quick_sort", "merge", "binarySearch"] {
            let c = of(name);
            assert!(
                c.classification.worthy,
                "{name} is library-worthy (score {})",
                c.classification.score
            );
            assert!(!c.classification.reasons.is_empty());
        }

        // Project glue — a glue-named, trivial-bodied helper → not worthy, with a reason why.
        for name in ["helperThing", "some_helper"] {
            let c = of(name);
            assert!(!c.classification.worthy, "{name} is glue, not library-worthy");
            assert!(c
                .classification
                .reasons
                .iter()
                .any(|r| r.contains("trivial") || r.contains("glue")));
        }
    }

    #[test]
    fn curation_plan_adds_new_and_optimizes_existing() {
        let worthy: Vec<Candidate> =
            harvest(&fixtures()).into_iter().filter(|c| c.classification.worthy).collect();
        // An existing store already holding merge-sort.rs → that candidate is an OPTIMIZE (replace);
        // a candidate with no stored counterpart (quick-sort.rs) is an ADD.
        let existing = vec![serde_json::json!({ "id": "merge-sort.rs", "tech": "rust" })];
        let plan = curation_plan(&worthy, &existing);

        let ms = plan.iter().find(|it| it.candidate.id == "merge-sort.rs").expect("merge-sort planned");
        assert_eq!(ms.replaces.as_deref(), Some("merge-sort.rs")); // optimize
        let qs = plan.iter().find(|it| it.candidate.id == "quick-sort.rs").expect("quick-sort planned");
        assert!(qs.replaces.is_none()); // add

        // Only worthy candidates are curated — the glue (helperThing / some_helper) never appears.
        assert!(plan.iter().all(|it| it.candidate.classification.worthy));
        assert!(plan
            .iter()
            .all(|it| it.candidate.name != "helperThing" && it.candidate.name != "some_helper"));
    }
}
