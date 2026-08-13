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
    /// The `@/…` import specifier this candidate SATISFIES — set only by a module-granularity harvest.
    ///
    /// A function-granularity candidate has none and never will: half a file satisfies no import. A
    /// MODULE does, and without it there is nothing for a resolver to match — components resolve by
    /// `provides`, algorithms compose BY ID, so until an impl carries the specifier a component imports,
    /// the two graphs cannot link. Derived from `src` at harvest, because backfilling it across a whole
    /// migration afterwards costs far more than computing it once, here.
    pub provides: Option<String>,
    /// The reusability classification (#2745 slice 2) — library-worthy vs. project glue, with reasons.
    pub classification: Classification,
    /// The colocated test that could NOT be paired, carried here so `--apply` can route it into an EDGE
    /// rather than leave it behind when the module's file is retired
    /// (edges-fill-themselves-at-retirement). A test that reaches other modules is not a broken record
    /// test; it is evidence about a relationship, and dropping it at retirement is the loss this avoids.
    pub edge_test: Option<CandidateTest>,
    /// The app modules `edge_test` reaches — the edge's other members. Always ABSOLUTE `@/…`
    /// specifiers, never relative: a member is matched against what records `provide`, and `./sibling`
    /// resolves against a directory an edge does not have. A relative member also reads as a bare record
    /// ID, so doctor would call it DANGLING when it is merely pending.
    pub edge_members: Vec<String>,
    /// The TEST file the edge came from — its provenance. Distinct from [`Self::src`], which is the
    /// module's path: the edge is about the test, so pointing it at the module loses the one path a
    /// reader needs to find the original.
    pub edge_src: Option<String>,
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

/// Path segments we never descend into or parse — vendored deps, build output, VCS/tooling dirs, and
/// TEST TREES (#4136).
///
/// `tests`/`fixtures`/`__tests__` are here because a fixture is not production source, and treating one
/// as such actively manufactures false provenance: `crates/bsc-graph/tests/fixtures/sample.rs` defines
/// `merge`/`merge_sort`/`quick_sort`/`bfs` for the extractor's OWN tests, so a `relink` over `crates/`
/// offered to point the four seeded classics at it. #4119 caught that by hand and skipped it; the walk
/// should never surface it in the first place.
const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", ".git", ".claude", "dist", "build",
    "tests", "fixtures", "__tests__",
];

/// Test files carry no production implementation — skip them.
///
/// Rust was entirely unguarded before #4136 (only the TS suffixes were listed), so `*_test.rs` /
/// `*_tests.rs` harvested as production. The `#[cfg(test)]` module INSIDE a production file is a
/// separate concern the parser handles; this is the whole-file gate.
fn is_test_file(name: &str) -> bool {
    name.ends_with(".test.ts")
        || name.ends_with(".test.tsx")
        || name.ends_with(".spec.ts")
        || name.ends_with(".spec.tsx")
        || name.ends_with("_test.rs")
        || name.ends_with("_tests.rs")
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
/// The module extensions a specifier drops, LONGEST FIRST so `.tsx` is tried before `.ts` — otherwise
/// `Thing.tsx` would strip to `Thing.x`.
const MODULE_EXTS: [&str; 5] = [".tsx", ".jsx", ".ts", ".js", ".rs"];

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
    build_candidates(defs, raw, dir)
}

/// Harvest a SINGLE file (#4161) — parse just `file` and lift its function definitions, `composes`
/// resolved within the file. Mirrors [`crate::harvest`]'s single-file twin in `bsc ui`, so the same path
/// works on both harvests.
///
/// Before this, the dir walk's `read_dir` simply failed on a file path and the harvest returned
/// `{"candidates":[],"count":0}` — indistinguishable from "this file holds nothing worth harvesting".
/// That silent zero was the trap: `bsc ui harvest <file>` prints a note routing the caller to
/// `bsc graph harvest <that same file>`, so the advertised hand-off landed on an empty result every time.
///
/// The recorded `src` is the file's own name, matching `bsc_ui::harvest::harvest_file`; tests still pair,
/// since the sibling `*.test.*` is resolved against the file's parent dir.
pub fn harvest_file(file: &Path) -> Vec<Candidate> {
    let mut defs: Vec<Def> = Vec::new();
    let mut raw: Vec<(String, String, String)> = Vec::new();
    if let Some((tech, src, tree)) = parse(file) {
        let rel = file.file_name().and_then(|n| n.to_str()).unwrap_or("").replace('\\', "/");
        collect_defs(tree.root_node(), &src, tech, false, &rel, &mut defs);
        collect_calls(tree.root_node(), &src, tech, false, None, &mut raw);
    }
    let parent = file.parent().unwrap_or(Path::new("."));
    build_candidates(defs, raw, parent)
}

/// Harvest a file as ONE MODULE-shaped candidate — the record a runtime loader can vendor.
///
/// WHY THIS IS NOT [`harvest_file`]. That one lifts every function, which is exactly right for the
/// reusable library it was built for (#2745): a library wants `quickSort`, not the file it lived in.
/// It is wrong for turning a logic module INTO a record, because the loader vendors modules — it needs
/// the `import`s and `export`s intact, and a lifted function body has neither. Measured on
/// `locationCrumb.ts`: three candidates, none with an `export`.
///
/// So this keeps the source VERBATIM and derives the rest from the path:
///   * `provides` — the `@/…` specifier a component's import will match on;
///   * `src` — the ROOT-RELATIVE path (not the basename `harvest_file` records), so `folder` derives
///     and provenance can be traced back;
///   * `domain` — from `src`, because a domainless impl is invisible in the library (#3607).
///
/// `composes` stays empty by construction: a module states its dependencies as IMPORTS, and re-encoding
/// them as compose edges would give the same fact two representations that can disagree.
/// Quote + separator characters as NAMED consts. Escaping them inline survives neither the shell
/// nor the heredocs this file gets edited through, and a mangled char literal is a compile error
/// that reads like a logic bug.
const DOUBLE_QUOTE: char = '\u{22}';
const SINGLE_QUOTE: char = '\u{27}';
pub(crate) const BACKSLASH: char = '\u{5C}';

/// Rewrite every RELATIVE import in a lifted module to its `@/…` equivalent.
///
/// A file and a record resolve imports differently, and this is the whole difference. `./planningTerminal`
/// works in a FILE because Vite resolves it against the file's directory. A RECORD is a string in a store
/// with no directory at all, so the runtime loader can only match absolute `@/…` specifiers against the
/// platform registry or another record's `provides` — `platformBoundary.test.ts` states the rule outright:
/// records must import absolutely. Lifting a module verbatim therefore produces a record that cannot load
/// AND takes its importing page down with it (`planningpage`, `githubpage` and `mcppage` all failed this
/// way; 12 of the first 18 modules tried were affected, one of them with 15 relative imports).
///
/// A specifier that resolves to no file on disk is LEFT ALONE. Rewriting it would be a guess, and a wrong
/// `@/…` is worse than an honest `./…`: the loader names an unresolved absolute specifier, while a guessed
/// one may silently resolve to the wrong module.
fn absolutize_imports(code: &str, file: &Path, root: &Path) -> String {
    let dir = file.parent().unwrap_or(Path::new(".")).to_path_buf();
    let chars: Vec<char> = code.chars().collect();
    let mut out = String::with_capacity(code.len());
    let mut i = 0usize;
    while i < chars.len() {
        let q = chars[i];
        if (q == DOUBLE_QUOTE || q == SINGLE_QUOTE) && import_specifier_at(&chars, i) {
            if let Some(len) = chars[i + 1..].iter().position(|&c| c == q) {
                let spec: String = chars[i + 1..i + 1 + len].iter().collect();
                if spec.starts_with('.') {
                    if let Some(alias) = alias_for(&spec, &dir, root) {
                        out.push(q);
                        out.push_str(&alias);
                        out.push(q);
                        i += len + 2;
                        continue;
                    }
                }
            }
        }
        out.push(q);
        i += 1;
    }
    out
}

/// Is the quote at `idx` the start of a MODULE SPECIFIER — i.e. does `from` or `import` sit immediately
/// before it? Without this the scan would rewrite any string literal in the file that happens to start
/// with a dot.
fn import_specifier_at(chars: &[char], idx: usize) -> bool {
    let mut j = idx;
    while j > 0 && chars[j - 1].is_whitespace() {
        j -= 1;
    }
    let ends_with = |kw: &str| {
        let k: Vec<char> = kw.chars().collect();
        j >= k.len()
            && chars[j - k.len()..j] == k[..]
            // A keyword boundary: `notfrom "x"` is not an import.
            && (j == k.len() || !chars[j - k.len() - 1].is_alphanumeric())
    };
    ends_with("from") || ends_with("import")
}

/// Resolve a relative specifier against `dir` and express it as `@/…`, or `None` when it names no file.
fn alias_for(spec: &str, dir: &Path, root: &Path) -> Option<String> {
    // Normalize by hand rather than `canonicalize`: that requires the path to exist BEFORE we know which
    // extension to try, and returns an absolute platform path we would only have to strip again.
    let mut parts: Vec<String> = Vec::new();
    for seg in dir.to_string_lossy().replace(BACKSLASH, "/").split('/').chain(spec.split('/')) {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other.to_string()),
        }
    }
    let base = parts.join("/");
    // The forms the loader's own resolution accepts, in the order a bundler tries them.
    for suffix in [".ts", ".tsx", "/index.ts", "/index.tsx"] {
        let candidate = format!("{base}{suffix}");
        if !root.join(&candidate).exists() {
            continue;
        }
        let rel = candidate
            .strip_prefix(&format!("{}/", root.to_string_lossy().replace(BACKSLASH, "/")))
            .unwrap_or(&candidate)
            .to_string();
        let rest = rel.strip_prefix("src/")?;
        // `@/x/y` is the registration key, so an `index` file is addressed by its DIRECTORY and every
        // form drops its extension — matching how `provides` is derived for the module itself.
        let trimmed = rest
            .strip_suffix("/index.ts")
            .or_else(|| rest.strip_suffix("/index.tsx"))
            .or_else(|| rest.strip_suffix(".tsx"))
            .or_else(|| rest.strip_suffix(".ts"))
            .unwrap_or(rest);
        return Some(format!("@/{trimmed}"));
    }
    None
}

/// EVERY app module a colocated test reaches other than the one under test.
///
/// Empty ⇒ the test can run with NOTHING but the record and its package deps, so it PAIRS onto the
/// node. Non-empty ⇒ it is an integration test, and these are the members of the EDGE it becomes.
/// All of them, not just the first: an edge naming one collaborator when the test exercises three
/// would claim coverage it does not have.
///
/// A record is a unit only if it can be verified ALONE, and that is the precondition for executing a
/// record's tests in a sealed filesystem where no other app module exists. So a test is paired only when
/// every app-module import it makes is the module under test itself.
///
/// The rule is about APP MODULES, not imports in general. `vitest` and `@testing-library/react` are
/// HARNESS — they live in the image and are exactly what a record's test should be free to use. An
/// `@/…` specifier or a sibling path is different in kind: it makes the record's verification depend on
/// code the record does not carry, so the test could never run where the record will run.
///
/// Returns the disqualifying import, or `None` when the test is isolated. Naming the import matters —
/// a test that is silently not paired reads as "this module has no test", which is the same false
/// negative `test_path_for` produced when handed the wrong path.
fn foreign_app_imports(test_src: &str, module_stem: &str) -> Vec<String> {
    let mut out = Vec::new();
    for spec in module_specifiers(test_src) {
        if !(spec.starts_with("@/") || spec.starts_with('.')) {
            continue; // a package — harness, present in the image
        }
        if spec.rsplit('/').next().unwrap_or("") == module_stem {
            continue; // the module UNDER TEST
        }
        if !out.contains(&spec) {
            out.push(spec);
        }
    }
    out
}

/// Every `from "…"` specifier in a source text. Deliberately literal: a harvest reads code it did not
/// write, and a parser here would be a second implementation of what the loader already does.
fn module_specifiers(src: &str) -> Vec<String> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let q = chars[i];
        if (q == DOUBLE_QUOTE || q == SINGLE_QUOTE) && import_specifier_at(&chars, i) {
            if let Some(len) = chars[i + 1..].iter().position(|&c| c == q) {
                out.push(chars[i + 1..i + 1 + len].iter().collect::<String>());
                i += len + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

pub fn harvest_module(file: &Path, root: &Path) -> Option<Candidate> {
    let (tech, src_bytes, _tree) = parse(file)?;
    // The one place a lifted module is NOT verbatim — see `absolutize_imports`.
    let code = absolutize_imports(&String::from_utf8_lossy(&src_bytes), file, root);
    let src_rel = file
        .strip_prefix(root)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/");
    let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or("module");
    // `@/x/y` mirrors the app's alias: the tracked path minus its `src/` root and extension.
    //
    // The FILE's extension, not one guessed from `tech`. `ext_of("typescript")` is `ts`, so a `.tsx`
    // module kept its extension and claimed `@/app/console/useConsoleTabs.tsx` — a specifier no import
    // ever writes, so the record resolved through nothing, which is the one thing `provides` exists to
    // prevent. The `.ts` case passing is exactly what hid it.
    let provides = src_rel.strip_prefix("src/").map(|rest| {
        let base = MODULE_EXTS
            .iter()
            .find_map(|e| rest.strip_suffix(e))
            .unwrap_or(rest);
        format!("@/{base}")
    });
    let dir = file.parent().unwrap_or(Path::new("."));
    // `test_path_for` pairs a FILE NAME against its sibling `*.test.*`, so it must get the basename —
    // handing it the root-relative path silently finds nothing, which is indistinguishable from
    // "this module has no test" and would have shipped 150 impls with their coverage quietly dropped.
    let base = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let found_test = bsc_util::test_path_for(dir, base)
        .and_then(|p| std::fs::read_to_string(&p).ok().map(|c| (p, c)));
    // Pair the test ONLY if it can run where the record will run — see `breaks_isolation`.
    let mut unpaired: Option<String> = None;
    let mut edge_test: Option<CandidateTest> = None;
    let mut edge_members: Vec<String> = Vec::new();
    let mut edge_src: Option<String> = None;
    let tests = match found_test {
        Some((p, contents)) => {
            let foreign = foreign_app_imports(&contents, stem);
            if foreign.is_empty() {
                vec![CandidateTest { name: bsc_util::test_display_name(&p, &contents), src: contents }]
            } else {
                unpaired = Some(foreign[0].clone());
                // ABSOLUTE, via the same resolution the module's own imports get. A relative member
                // cannot be matched against `provides` and reads as a bare record id, so doctor would
                // report it DANGLING when the module has simply not migrated yet.
                edge_members = foreign
                    .into_iter()
                    .map(|spec| alias_for(&spec, dir, root).unwrap_or(spec))
                    .collect();
                edge_src = Some(
                    p.strip_prefix(root)
                        .unwrap_or(&p)
                        .to_string_lossy()
                        .replace(BACKSLASH, "/"),
                );
                edge_test =
                    Some(CandidateTest { name: bsc_util::test_display_name(&p, &contents), src: contents });
                Vec::new()
            }
        }
        None => Vec::new(),
    };
    let mut c = Candidate {
        id: format!("{}.{}", kebab(stem), ext_of(tech)),
        name: stem.to_string(),
        tech: tech.to_string(),
        // A module is composed FROM parts rather than being one, so it is never the `primitive` tier.
        role: "algorithm",
        composes: Vec::new(),
        code,
        domain: domain_of(&src_rel),
        tests,
        provides,
        src: src_rel,
        classification: Classification::default(),
        edge_test,
        edge_members,
        edge_src,
    };
    c.classification = classify(&c);
    // Say so. A test left off the record must be VISIBLE, or "no tests" reads as "never had one".
    if let Some(spec) = unpaired {
        c.classification
            .reasons
            .push(format!("test not paired: it imports the app module `{spec}`, so it cannot run in isolation"));
    }
    Some(c)
}

/// Render harvested `defs` + raw call edges into candidates. Shared by the directory [`harvest`] and the
/// single-file [`harvest_file`] so both resolve `composes`, tests, and classification identically.
/// `test_root` is the dir colocated tests are resolved against.
fn build_candidates(defs: Vec<Def>, raw: Vec<(String, String, String)>, test_root: &Path) -> Vec<Candidate> {
    let dir = test_root;
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
                // Function granularity: a fragment of a file satisfies no import specifier.
                provides: None,
                classification: Classification::default(),
            // Function granularity never carries one: half a file is not a module, so it has no
            // colocated test of its own to route.
            edge_test: None,
            edge_members: Vec::new(),
            edge_src: None,
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

    // ── MODULE GRANULARITY (graph-harvest-module-mode) ───────────────────────────────────────────
    // The function harvest is right for the reusable LIBRARY and wrong for turning a logic module into
    // a record: the loader vendors modules, and a lifted function body has no imports and no export.

    #[test]
    fn harvest_module_lifts_the_whole_file_as_one_candidate() {
        let file = fixtures().join("sample.ts");
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let c = harvest_module(&file, root).expect("sample.ts harvests as a module");

        // ONE candidate, not one per function — the function harvest lifts several from this same file.
        assert!(harvest_file(&file).len() > 1, "the fixture must hold several functions, or this proves nothing");

        // MODULE-SHAPED: the source verbatim, so `export` survives and the loader can vendor it.
        assert!(c.code.contains("export function quickSort"), "the module's exports must survive");
        assert_eq!(c.code, std::fs::read_to_string(&file).unwrap(), "the code is the file, verbatim");

        // Provenance the function harvest does not give: a root-relative src, not the bare basename.
        assert_eq!(c.src, "tests/fixtures/sample.ts");
        assert_eq!(c.role, "algorithm");
        assert!(c.composes.is_empty(), "a module states its deps as imports, not compose edges");
    }

    #[test]
    fn harvest_module_derives_the_specifier_it_provides() {
        // `provides` is what a component's import matches on — without it the two graphs cannot link.
        // Derived from a `src/`-rooted path, mirroring the app's `@/` alias.
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let c = harvest_module(&fixtures().join("sample.ts"), root).unwrap();
        // This fixture is not under `src/`, so there is no specifier to claim — and inventing one
        // would be worse than none, since a wrong `provides` is a global override (#3660).
        assert_eq!(c.provides, None, "a path outside src/ claims no specifier");
    }

    /// A `.tsx` module drops its extension like every other. The bug this covers shipped five records
    /// claiming `@/app/console/useConsoleTabs.tsx` — a specifier no import ever writes, so each record
    /// resolved through nothing. The `.ts` path was correct throughout, which is exactly what hid it.
    #[test]
    fn a_tsx_module_drops_its_extension_in_the_specifier_it_provides() {
        let root = std::env::temp_dir().join(format!("bsc-graph-tsx-provides-{}", std::process::id()));
        let dir = root.join("src").join("app").join("console");
        std::fs::create_dir_all(&dir).unwrap();
        for (name, want) in
            [("useConsoleTabs.tsx", "@/app/console/useConsoleTabs"), ("bridge.ts", "@/app/console/bridge")]
        {
            let f = dir.join(name);
            std::fs::write(&f, "export const useConsoleTabs = () => 1;\n").unwrap();
            let c = harvest_module(&f, &root).expect("harvests as a module");
            assert_eq!(c.provides.as_deref(), Some(want), "{name} must claim {want}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_function_granularity_candidate_never_claims_a_specifier() {
        // Half a file satisfies no import. If these ever gained a `provides`, a resolver would match a
        // fragment where a module was expected.
        for c in harvest_file(&fixtures().join("sample.ts")) {
            assert_eq!(c.provides, None, "{} must not claim a specifier", c.id);
        }
    }

    #[test]
    fn harvest_module_pairs_the_colocated_test() {
        // `test_path_for` pairs a FILE NAME; handing it a root-relative path finds nothing silently,
        // which reads as "this module has no test" and would drop coverage across a whole migration.
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let c = harvest_module(&fixtures().join("sample.ts"), root).unwrap();
        assert_eq!(c.tests.len(), 1, "sample.test.ts sits beside sample.ts and must be carried");
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
    fn harvest_file_lifts_one_modules_functions_instead_of_returning_a_silent_zero() {
        // #4161: `bsc ui harvest <file>` prints a note routing the caller to `bsc graph harvest <that
        // same file>`. The dir walk's `read_dir` failed on a file path, so that advertised hand-off
        // returned `{"candidates":[],"count":0}` every time — indistinguishable from "nothing here".
        let file = fixtures().join("sample.rs");
        let cands = harvest_file(&file);
        assert!(!cands.is_empty(), "a single-file harvest lifts that module's functions");

        // Same records the DIRECTORY form produces for that file — the file target is a narrowing, not
        // a second extraction path.
        let mut got: Vec<String> = cands.iter().map(|c| c.name.clone()).collect();
        let mut want: Vec<String> =
            harvest(&fixtures()).into_iter().filter(|c| c.src == "sample.rs").map(|c| c.name).collect();
        got.sort_unstable();
        want.sort_unstable();
        assert_eq!(got, want, "a file target yields the same candidates the dir walk finds in it");

        // `src` is the file's own name (the `bsc ui harvest_file` convention — no root to relativize
        // against), and in-file `composes` still resolve.
        assert!(cands.iter().all(|c| c.src == "sample.rs"));
        let ms = cands.iter().find(|c| c.name == "merge_sort").expect("merge_sort harvested");
        assert_eq!(ms.composes, vec!["merge.rs".to_string()]);

        // A path that parses to nothing yields no candidates rather than erroring.
        assert!(harvest_file(&fixtures().join("nope.rs")).is_empty());
    }

    #[test]
    fn harvest_never_descends_into_a_test_tree() {
        // #4136 — the REAL crate, not a synthetic tree. `crates/bsc-graph/tests/fixtures/sample.rs`
        // defines merge/merge_sort/quick_sort/bfs for this extractor's own tests; harvesting it made
        // `relink` offer to point the four SEEDED CLASSICS at a fixture (#4119 skipped that by hand).
        let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let cands = harvest(crate_root);
        for c in &cands {
            assert!(
                !c.src.split('/').any(|seg| seg == "tests" || seg == "fixtures" || seg == "__tests__"),
                "harvested {} from a test tree: {}",
                c.name,
                c.src,
            );
        }
        // Not vacuous: this crate's own src/ still yields candidates.
        assert!(!cands.is_empty(), "the crate's production source still harvests");
    }

    #[test]
    fn an_explicit_test_root_is_still_honoured() {
        // SKIP_DIRS gates DESCENT, not the root you point at — so the fixture-based tests above (which
        // pass `tests/fixtures` directly) keep working. Locking the distinction in: it is the reason
        // adding `fixtures` to SKIP_DIRS did not break every other test in this module.
        assert!(!harvest(&fixtures()).is_empty());
    }


    /// A record must be verifiable ALONE — that is the precondition for running its tests in a sealed
    /// filesystem where no other app module exists (harvest-pairs-only-an-isolated-test).
    #[test]
    fn harvest_module_pairs_only_a_test_that_can_run_in_isolation() {
        let root = std::env::temp_dir().join("bsc-graph-isolation");
        let dir = root.join("src").join("features").join("demo");
        std::fs::create_dir_all(&dir).unwrap();

        // ISOLATED: vitest + testing-library are HARNESS and live in the image; the only app module it
        // names is the module under test.
        let solo = dir.join("solo.ts");
        std::fs::write(&solo, "export const one = 1;
").unwrap();
        std::fs::write(
            dir.join("solo.test.ts"),
            concat!(
                "import { describe, it, expect } from \"vitest\";
",
                "import { render } from \"@testing-library/react\";
",
                "import { one } from \"./solo\";
",
                "describe(\"solo\", () => { it(\"is one\", () => { expect(one).toBe(1); }); });
",
            ),
        )
        .unwrap();
        let c = harvest_module(&solo, &root).expect("harvests");
        assert_eq!(c.tests.len(), 1, "a self-contained test is paired: {:?}", c.classification.reasons);

        // NOT ISOLATED: it reaches the app store, which will not exist where the record runs.
        let bound = dir.join("bound.ts");
        std::fs::write(&bound, "export const two = 2;
").unwrap();
        std::fs::write(dir.join("helper.ts"), "export const h = 3;
").unwrap();
        std::fs::write(
            dir.join("bound.test.ts"),
            concat!(
                "import { describe, it, expect } from \"vitest\";
",
                "import { useAppStore } from \"@/store\";
",
                // A RELATIVE collaborator — the shape that shipped broken: it reads as a bare record id,
                // so doctor called it DANGLING when the module had merely not migrated yet.
                "import { h } from \"./helper\";
",
                "import { two } from \"./bound\";
",
                "describe(\"bound\", () => { it(\"is two\", () => { expect(two).toBe(2); }); });
",
            ),
        )
        .unwrap();
        let c = harvest_module(&bound, &root).expect("harvests");
        assert!(c.tests.is_empty(), "a test reaching an app module is not paired");
        // …and it SAYS so. Silence would read as "this module has no test".
        assert!(
            c.classification.reasons.iter().any(|r| r.contains("@/store")),
            "the disqualifying import is named: {:?}",
            c.classification.reasons,
        );

        // The unpaired test is CARRIED, not discarded — `--apply` routes it into an edge naming every
        // app module it reaches (edges-fill-themselves-at-retirement). Dropping it here is the loss the
        // whole edge tier exists to prevent.
        assert!(c.edge_test.is_some(), "the integration test rides along for routing");
        // ABSOLUTE, both of them. A member is matched against what records `provide`, and `./helper`
        // resolves against a directory an edge does not have.
        assert_eq!(
            c.edge_members,
            vec!["@/store".to_string(), "@/features/demo/helper".to_string()],
            "every member is an absolute specifier",
        );
        assert_eq!(c.edge_src.as_deref(), Some("src/features/demo/bound.test.ts"), "provenance is the TEST");

        std::fs::remove_dir_all(&root).ok();
    }

    /// A record resolves through the LOADER, which has no directory — so a lifted module's relative
    /// imports have to become absolute or the record cannot load, and takes its importing page with it
    /// (harvest-module-must-rewrite-relative-imports).
    #[test]
    fn harvest_module_absolutizes_relative_imports() {
        let root = std::env::temp_dir().join("bsc-graph-absolutize");
        let feat = root.join("src").join("features").join("demo");
        let lib = feat.join("lib");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::create_dir_all(root.join("src").join("shared").join("bits")).unwrap();
        // The three shapes the loader accepts: a plain sibling, a `.tsx` sibling, and a directory index.
        std::fs::write(feat.join("sibling.ts"), "export const a = 1;
").unwrap();
        std::fs::write(feat.join("Widget.tsx"), "export const W = 1;
").unwrap();
        std::fs::write(root.join("src").join("shared").join("bits").join("index.ts"), "export const b = 2;
").unwrap();
        let entry = feat.join("entry.ts");
        std::fs::write(
            &entry,
            concat!(
                "import { a } from \"./sibling\";
",
                "import { W } from './Widget';
",
                "import { b } from \"../../shared/bits\";
",
                "import { keep } from \"@/already/absolute\";
",
                "import { gone } from \"./doesNotExist\";
",
                "const notAnImport = \"./sibling\";
",
                "export const use = [a, W, b, keep, gone, notAnImport];
",
            ),
        )
        .unwrap();

        let c = harvest_module(&entry, &root).expect("module harvests");
        assert!(c.code.contains("from \"@/features/demo/sibling\""), "plain sibling: {}", c.code);
        assert!(c.code.contains("from '@/features/demo/Widget'"), "tsx sibling keeps its quote style: {}", c.code);
        assert!(c.code.contains("from \"@/shared/bits\""), "a directory index drops /index: {}", c.code);
        assert!(c.code.contains("from \"@/already/absolute\""), "an absolute import is untouched: {}", c.code);
        // A specifier naming no file is LEFT ALONE — a guessed `@/…` could silently resolve to the wrong
        // module, while an honest `./…` makes the loader name it.
        assert!(c.code.contains("from \"./doesNotExist\""), "unresolvable stays relative: {}", c.code);
        // Only MODULE SPECIFIERS are rewritten; a string that merely looks like a path is not one.
        assert!(c.code.contains("notAnImport = \"./sibling\""), "a plain string literal is untouched: {}", c.code);

        std::fs::remove_dir_all(&root).ok();
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
        // The "no test ⇒ no pairing, never an empty-but-present claim" contract is exercised in
        // `bsc_util::test_path_for`'s own tests: EVERY file in this fixture dir now pairs (`sample.tsx`
        // resolves the shared stem to `sample.test.ts`), so there is no untested case to assert here.
        // #4146 — a RUST candidate pairs with its OWN file, because its tests are an inline
        // `#[cfg(test)] mod tests` rather than a sibling. `sample.rs` carries one, so its candidates are
        // tested; before #4146 every Rust impl reported as untested no matter what it contained.
        let from_rs: Vec<&Candidate> = cands.iter().filter(|c| c.src == "sample.rs").collect();
        assert!(!from_rs.is_empty(), "the fixture yields candidates from sample.rs");
        for c in &from_rs {
            assert_eq!(c.tests.len(), 1, "{} pairs with its own inline test module", c.name);
            assert!(
                c.tests[0].src.contains("#[cfg(test)]"),
                "the entry is the file's own contents, which is where the tests are",
            );
        }
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
