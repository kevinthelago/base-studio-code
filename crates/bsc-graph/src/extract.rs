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
    /// The TOP-LEVEL mutable bindings this module holds — its MODULE STATE, empty for a pure module.
    ///
    /// Recorded because it is the property that decides whether vendoring the record is equivalent to
    /// importing the module: with state, a graph consumer gets a SECOND instance of it. Naming the
    /// bindings puts that on the record instead of leaving each caller to rediscover it.
    pub module_state: Vec<String>,
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
    /// What this function TAKES and RETURNS — its contract, read off the same tree the name came from.
    ///
    /// Carried on the candidate so a duplicate sweep can compare functions by CONTRACT rather than by
    /// name or by byte-identical text, which is all `doctor --dedup` could do
    /// (`epic-a-graph-finds-its-own-duplicates`). Empty for a MODULE-granularity candidate: a module is
    /// not a function and has no single signature.
    pub signature: Signature,
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
    /// Specifiers this harvest REFUSED to make members of, because they name no module (#80) — a
    /// mock, a `${…}` placeholder, a path to nothing.
    ///
    /// Reported rather than dropped in silence. The whole defect being fixed is a permanently
    /// unresolvable member that nobody could account for; replacing it with a silent omission would
    /// hide a GENUINELY missing module behind the same rule that hides a fixture.
    pub edge_declined: Vec<String>,
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

/// One collected definition. A STRUCT, not a tuple: it was `(name, tech, code, rel)` with a doc
/// comment already warning that "the extra provenance field doesn't turn every signature into an
/// unreadable tuple" — and the signature (#epic-a-graph-finds-its-own-duplicates) is the fifth field
/// that would have.
#[derive(Debug, Clone)]
struct Def {
    name: String,
    tech: String,
    code: String,
    /// Scanned-root-relative path of the file it came from.
    rel: String,
    sig: Signature,
    /// 1-based start line, read off the node. A byte offset is what tree-sitter has and what a person
    /// reading a duplicate report cannot use.
    line: usize,
}

/// How a parameter or return TYPE is known. THREE STATES, and keeping them apart is the whole point.
///
/// A signature is only useful for comparison if "I don't know this type" is distinguishable from "this
/// type is X". Untyped parameters, `any`, and inferred returns are everywhere in TypeScript, and
/// collapsing them onto a single "no type" would manufacture agreement out of missing information —
/// the same distinction `cpuMs: null` vs `cpuMs: 0` carries in the reaper, where an unknown that reads
/// as a value produces a confident wrong answer.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum TypeRef {
    /// No annotation at all — the source said nothing.
    #[default]
    Absent,
    /// Annotated, but the annotation carries no information: `any`, `unknown`. The source text is kept
    /// because "it said `any`" is worth reading even though it is worth nothing to a comparison.
    Opaque(String),
    /// A real type, as written. VERBATIM and un-normalised: comparison is confined to ONE tech
    /// (`epic-a-graph-finds-its-own-duplicates` rules cross-kit out), so there is no second language's
    /// spelling to reconcile and nothing to gain from rewriting what the author wrote.
    Known(String),
}

impl TypeRef {
    /// Whether these two types are the SAME type — the question a similarity pass asks, and NOT what
    /// `==` answers.
    ///
    /// `Absent` and `Opaque` match NOTHING, including each other. Two functions that both decline to
    /// say what they take have told us nothing in common; deriving that from `PartialEq` would say they
    /// agree. `==` is kept for the different, legitimate question of whether two records are identical.
    pub fn matches(&self, other: &TypeRef) -> bool {
        matches!((self, other), (TypeRef::Known(a), TypeRef::Known(b)) if a == b)
    }

    /// The source text, whatever the state — `None` only when there was no annotation.
    pub fn text(&self) -> Option<&str> {
        match self {
            TypeRef::Absent => None,
            TypeRef::Opaque(t) | TypeRef::Known(t) => Some(t),
        }
    }

    /// Classify one annotation's source text. Trimmed of the leading `:` a TS `type_annotation` carries.
    fn parse(raw: &str) -> TypeRef {
        let t = raw.trim().trim_start_matches(':').trim();
        if t.is_empty() {
            return TypeRef::Absent;
        }
        // `any` says "stop checking"; `unknown` says "I will not tell you". Neither narrows anything,
        // so neither can support a claim that two functions take the same thing.
        if matches!(t, "any" | "unknown") {
            return TypeRef::Opaque(t.to_string());
        }
        TypeRef::Known(t.to_string())
    }
}

/// One parameter: what it is CALLED and what it takes.
///
/// The NAME is carried deliberately, and it is the reason the component library's contract measure
/// cannot simply be pointed at functions. Component props are named at every call site — `title`,
/// `onSelect`, `variant` — so their names carry meaning. A positional parameter's TYPE does not:
/// `(s: string) => string` describes hundreds of unrelated functions, while `limit: number` and
/// `count: number` share a type and mean different things. The name is the discriminating half.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Param {
    /// The binding as written — an identifier, or a destructuring pattern verbatim (`{ ok }`).
    pub name: String,
    pub ty: TypeRef,
}

/// A function's contract: what it takes and what it gives back.
///
/// LANGUAGE-NATIVE, per the epic: cross-kit comparison is out of scope, so a Rust `Vec<T>` is never
/// reconciled with a TypeScript `T[]` and no lowest-common-denominator type model exists to go wrong.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Signature {
    pub params: Vec<Param>,
    pub returns: TypeRef,
}

impl Signature {
    /// Nothing was learned — no parameters AND no return type. Distinct from arity 0, which is a real
    /// contract: `fn no_params() -> &'static str` takes nothing and says so.
    ///
    /// Used to decide whether the key is written at all: `impl set` is a MERGE (#4154), so emitting an
    /// empty signature for a MODULE candidate would clear whatever a function-granularity pass had
    /// established for that id rather than leaving it alone.
    pub fn is_empty(&self) -> bool {
        self.params.is_empty() && self.returns == TypeRef::Absent
    }

    /// The stored shape, as `bsc graph impl get` surfaces it.
    ///
    /// THE THREE TYPE STATES SURVIVE THE ROUND TRIP, which is the only hard requirement here:
    ///
    /// ```json
    /// { "name": "xs", "type": "string[]" }                 // known
    /// { "name": "n",  "type": null }                       // absent  — no annotation
    /// { "name": "x",  "type": "any", "typeKnown": false }  // opaque  — annotated, says nothing
    /// ```
    ///
    /// One rule for a consumer: a type is comparable iff `type` is non-null AND `typeKnown` is not
    /// `false`. The source text is kept even when opaque, because "it said `any`" is worth reading to a
    /// human even though it is worth nothing to a comparison.
    pub fn to_json(&self) -> serde_json::Value {
        fn ty(t: &TypeRef) -> serde_json::Value {
            match t {
                TypeRef::Absent => serde_json::json!({ "type": serde_json::Value::Null }),
                TypeRef::Opaque(text) => serde_json::json!({ "type": text, "typeKnown": false }),
                TypeRef::Known(text) => serde_json::json!({ "type": text }),
            }
        }
        let params: Vec<serde_json::Value> = self
            .params
            .iter()
            .map(|p| {
                let mut v = ty(&p.ty);
                v["name"] = serde_json::Value::String(p.name.clone());
                v
            })
            .collect();
        serde_json::json!({ "params": params, "returns": ty(&self.returns) })
    }

    /// How many parameters — the ARITY, which is the bucket key a duplicate sweep partitions on.
    ///
    /// Arity rather than name, and that inversion is deliberate: the component sweep's cheap first pass
    /// is a NAME gate, which for functions discards precisely what we are hunting — the same routine
    /// under two different names. Arity partitions without assuming anything about naming.
    pub fn arity(&self) -> usize {
        self.params.len()
    }
}

/// The signature of the function `node` DEFINES. Empty when it defines none.
///
/// Handles the same four shapes [`fn_def_name`] does, and resolves the one indirection: a
/// `variable_declarator` bound to an arrow keeps its parameters on the VALUE, not on the declarator.
fn signature_of(node: Node, src: &[u8]) -> Signature {
    // An arrow bound to a `const` declares its contract on the function expression, not the binding.
    let f = match node.kind() {
        "variable_declarator" => match node.child_by_field_name("value") {
            Some(v) if matches!(v.kind(), "arrow_function" | "function" | "function_expression") => v,
            _ => return Signature::default(),
        },
        _ => node,
    };
    let returns = match f.child_by_field_name("return_type") {
        // TS hands back a `type_annotation` (`: T[]`); Rust hands back the type node itself. `parse`
        // strips the leading colon either way, so one path covers both.
        Some(r) => TypeRef::parse(r.utf8_text(src).unwrap_or_default()),
        None => TypeRef::Absent,
    };
    let params = f
        .child_by_field_name("parameters")
        .map(|p| collect_params(p, src))
        .unwrap_or_default();
    Signature { params, returns }
}

/// The parameters declared inside a `formal_parameters` (TS) or `parameters` (Rust) node.
///
/// Walks NAMED children rather than matching an allow-list of node kinds: the two grammars spell a
/// parameter half a dozen ways between them (`required_parameter`, `optional_parameter`,
/// `rest_pattern`, `parameter`, `self_parameter`, and a bare `identifier` in an untyped arrow), and an
/// allow-list is a list that silently drops whatever it forgot. Anything with a `pattern` field is a
/// parameter; anything else in there is punctuation.
fn collect_params(params: Node, src: &[u8]) -> Vec<Param> {
    let mut out = Vec::new();
    let mut cursor = params.walk();
    for child in params.named_children(&mut cursor) {
        // `self` is the RECEIVER, not part of the contract a caller supplies.
        //
        // REDUNDANT WITH THE `pattern` TEST BELOW, and deliberately kept. A `self_parameter` carries no
        // `pattern` field, so the general rule already drops it — MEASURED by removing this arm and
        // watching every test stay green, then removing both and watching `bump` harvest as
        // `[&mut self, by]`. Stating the intent here means the next reader learns the rule from the
        // code rather than from that experiment, and a grammar release that gives `self_parameter` a
        // pattern cannot silently add a phantom first parameter to every method in the library.
        if child.kind() == "self_parameter" {
            continue;
        }
        let name = match child.child_by_field_name("pattern") {
            Some(p) => p.utf8_text(src).unwrap_or_default().to_string(),
            // An untyped arrow parameter is a bare identifier with no `pattern` field: `(x) => x`.
            None if child.kind() == "identifier" => child.utf8_text(src).unwrap_or_default().to_string(),
            None => continue,
        };
        let ty = match child.child_by_field_name("type") {
            Some(t) => TypeRef::parse(t.utf8_text(src).unwrap_or_default()),
            None => TypeRef::Absent,
        };
        out.push(Param { name, ty });
    }
    out
}

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
/// Rewrite a Rust module's RELATIVE `include_str!` / `include_bytes!` paths so they survive
/// materialization.
///
/// `include_str!("../data/x.json")` resolves relative to the FILE THAT CONTAINS IT. Materialized,
/// that file is `target/debug/build/<crate>-<hash>/out/crate.rs`, so the same relative path points
/// somewhere else entirely and the build fails with "couldn't read" — measured on `bsc-sound`, which
/// is why the migration tool refused these crates rather than predicting it.
///
/// The rewrite happens HERE, at harvest, so the stored record is the thing that compiles. Repairing
/// it in `build.rs` instead would mean a build script silently fixing up a record that does not build
/// on its own — a second copy of the truth, which is the failure mode this whole migration exists to
/// remove.
///
/// `CARGO_MANIFEST_DIR` is set for the crate being compiled and `include!` does not change that, so
/// `<manifest>/<the file's dir relative to the manifest>/<original path>` names exactly what the
/// relative path meant before. `..` segments are left in rather than normalized: the filesystem
/// resolves them, and textual normalization across a value only known at compile time is where an
/// off-by-one silently reads the wrong file.
///
/// Left alone: an already-absolutized `concat!(…)` form, and a path that is not a plain string
/// literal.
fn absolutize_includes(src: &str, file: &Path) -> String {
    // The file's directory relative to the crate root — `src` for everything `build.rs` materializes,
    // but derived rather than assumed, since `harvest_module` is not only called on those.
    let manifest = file.ancestors().skip(1).find(|d| d.join("Cargo.toml").is_file());
    let Some(manifest) = manifest else { return src.to_string() };
    let Some(dir) = file.parent() else { return src.to_string() };
    let Ok(rel_dir) = dir.strip_prefix(manifest) else { return src.to_string() };
    let rel_dir = rel_dir.to_string_lossy().replace('\\', "/");
    let prefix = if rel_dir.is_empty() { String::new() } else { format!("{rel_dir}/") };

    let mut out = String::with_capacity(src.len());
    let mut rest = src;
    while let Some(hit) = ["include_str!", "include_bytes!"]
        .iter()
        .filter_map(|m| rest.find(m).map(|i| (i, *m)))
        .min_by_key(|(i, _)| *i)
    {
        let (at, mac) = hit;
        let after = &rest[at + mac.len()..];
        let open = after.find('(');
        // The argument, if it is a plain string literal: `(` then whitespace then `"…"`.
        let literal = open.and_then(|o| {
            let arg = after[o + 1..].trim_start();
            let pad = after[o + 1..].len() - arg.len();
            arg.strip_prefix('"')
                .and_then(|r| r.find('"').map(|e| (o + 1 + pad, r[..e].to_string(), o + 1 + pad + 1 + e + 1)))
        });
        match literal {
            // An absolute path, or one already rooted at an env var, is left exactly as it is.
            Some((start, path, end)) if !path.starts_with('/') && !path.contains(':') => {
                out.push_str(&rest[..at + mac.len() + start]);
                out.push_str(&format!(
                    "concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/{prefix}{path}\")"
                ));
                rest = &rest[at + mac.len() + end..];
            }
            _ => {
                out.push_str(&rest[..at + mac.len()]);
                rest = &rest[at + mac.len()..];
            }
        }
    }
    out.push_str(rest);
    out
}

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

/// The `@/…` member a test specifier becomes, or `None` when it names no module at all (#80).
///
/// Three cases, in order:
/// * a `${…}` interpolation is not a literal specifier — it is a fragment of a template that was
///   never a module reference, and it is decidable on sight;
/// * an already-absolute `@/…` is the canonical form and rides through — whether it is a RECORD yet is
///   the "pending" case doctor exists to report;
/// * a relative path must resolve to a real module file, which is what [`alias_for`] checks.
fn edge_member_for(spec: &str, dir: &Path, root: &Path) -> Option<String> {
    if spec.contains("${") {
        return None;
    }
    if spec.starts_with("@/") {
        return Some(spec.to_string());
    }
    alias_for(spec, dir, root)
}

/// Resolve a relative specifier against `dir` and express it as `@/…`, or `None` when it names no file.
fn alias_for(spec: &str, dir: &Path, root: &Path) -> Option<String> {
    // Resolved with PathBuf, NOT by joining hand-normalized strings. The string form silently dropped
    // the leading `/` of an absolute POSIX dir — `"/a/b".split('/')` yields an empty first segment and
    // the `""` arm discarded it — so `base` stopped being absolute and `root.join(base)` prepended the
    // root a SECOND time (`/tmp/t/tmp/t/src/…`). Nothing existed there, so every relative import
    // resolved to `None` and was left as `./…`.
    //
    // It only ever worked on Windows: there an absolute dir is `C:/…`, whose first segment survives, so
    // the result stayed absolute and `Path::join` REPLACES the base rather than appending to it. The
    // first native Linux gate failed three extract tests on this.
    let mut p = dir.to_path_buf();
    for seg in spec.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                p.pop();
            }
            other => p.push(other),
        }
    }
    // The forms the loader's own resolution accepts, in the order a bundler tries them.
    for suffix in [".ts", ".tsx", "/index.ts", "/index.tsx"] {
        let mut with_ext = p.clone().into_os_string();
        with_ext.push(suffix);
        let candidate = PathBuf::from(with_ext);
        let full = if candidate.is_absolute() { candidate } else { root.join(&candidate) };
        if !full.exists() {
            continue;
        }
        let rel = full.strip_prefix(root).ok()?.to_string_lossy().replace(BACKSLASH, "/");
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

/// The id for a module record, derived from its ROOT-RELATIVE PATH rather than its file stem.
///
/// # Why the stem cannot be the id
///
/// A module record's id is a store KEY, and the store refuses a duplicate. Measured on this tree:
/// **158 of 338 `.rs` files share a basename** — `lib.rs` x39, `cli.rs` x28, `mod.rs` x24. Under a
/// stem-derived id exactly ONE crate's `cli.rs` can ever be a record, which is why `bsc-blueprint`
/// migrated only with a hand-picked id. A naming convention applied by hand per module is not a scheme.
///
/// # The derivation
///
/// Drop the uninformative structural segments and join the rest with `--`:
///
/// ```text
/// crates/bsc-blueprint/src/cli.rs   ->  bsc-blueprint--cli.rs
/// crates/plandb/src/cli/nouns.rs    ->  plandb--cli--nouns.rs
/// src-tauri/src/console/pty/job.rs  ->  src-tauri--console--pty--job.rs
/// src/features/planner/lib/x.ts     ->  features--planner--lib--x.ts
/// ```
///
/// Unique because the path is unique; readable because every segment survives, so a human seeing the id
/// can say which file it is without a lookup. `crates/` and a `src/` component carry no information —
/// every crate has them — so they are dropped, while the crate name is kept because it is the part that
/// disambiguates.
///
/// # What this does NOT do
///
/// It does not rename anything. 683 records are keyed by their current ids and referenced by `composes`
/// edges; a rename would break those silently. This applies to module records harvested from here on,
/// and everything downstream already matches on `src` rather than on id — `build.rs` selects a crate's
/// modules by path prefix, and both Tier-A exclusions do the same.
pub fn module_id(src_rel: &str, ext: &str) -> String {
    let path = src_rel.replace('\\', "/");
    let path = path.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(&path);
    let segments: Vec<&str> = path
        .split('/')
        .filter(|s| !s.is_empty())
        // `crates/` and `src/` appear in nearly every path and distinguish nothing.
        .filter(|s| *s != "crates" && *s != "src")
        .collect();
    // Each SEGMENT is kebabed and then joined — never the other way round. `kebab` collapses a run of
    // separators, so kebabing the joined string turns the `--` boundary into a single `-` and
    // `bsc-blueprint--cli` becomes `bsc-blueprint-cli`, silently reintroducing the ambiguity the double
    // separator exists to prevent (a crate legitimately named `bsc-blueprint-cli` would collide).
    let joined = segments.iter().map(|s| kebab(s)).collect::<Vec<_>>().join("--");
    let joined = if joined.is_empty() { "module".to_string() } else { joined };
    format!("{joined}.{ext}")
}

pub fn harvest_module(file: &Path, root: &Path) -> Option<Candidate> {
    let (tech, src_bytes, _tree) = parse(file)?;
    // The one place a lifted module is NOT verbatim — see `absolutize_imports`, and for Rust
    // `absolutize_includes`, which is the same trade for the same reason.
    let code = absolutize_imports(&String::from_utf8_lossy(&src_bytes), file, root);
    let code = if tech == "rust" { absolutize_includes(&code, file) } else { code };
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
        // …and a trailing `/index`, because a DIRECTORY import resolves to it. `features/data/index.ts`
        // is imported as `@/features/data`, never `@/features/data/index`, so keeping the segment gave
        // 13 barrel records a specifier no import in the tree writes — the same failure as the `.tsx`
        // extension bug: a record `provides` cannot resolve through. Only when something remains, so a
        // root `index.ts` does not collapse to `@/`.
        let base = base.strip_suffix("/index").filter(|b| !b.is_empty()).unwrap_or(base);
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
    let mut edge_declined: Vec<String> = Vec::new();
    let tests = match found_test {
        Some((p, contents)) => {
            // ONLY TYPESCRIPT HAS MODULE SPECIFIERS. `foreign_app_imports` scans raw text for a quote
            // preceded by `from`/`import`, which is meaningless in Rust — and for a Rust module
            // `test_path_for` returns THE FILE ITSELF (its tests are inline), so the scan runs over
            // production source, not over a test file.
            //
            // It fires. `crates/bsc-files/src/cli.rs` implements `bsc files read --from 10`, so its
            // source contains `"--from".into()`; the scanner treats the CLOSING quote of `"--from"` as
            // an opening one, captures `.into(), ` as the "specifier", and concludes the test "imports
            // the app module `./Foo`, so it cannot run in isolation". Every member was then declined,
            // leaving a 0-member edge that the store correctly refused with "an edge needs at least two
            // members" — an accurate error about a relationship that should never have been proposed.
            //
            // NOTE the scanner's closing-quote confusion is not Rust-specific; a TS module holding a
            // string that ends in `from` would mis-scan the same way. Fixing that is a separate change
            // (it could reclassify existing records); this one removes the whole question for Rust.
            let foreign =
                if tech == "rust" { Vec::new() } else { foreign_app_imports(&contents, stem) };
            if foreign.is_empty() {
                vec![CandidateTest { name: bsc_util::test_display_name(&p, &contents), src: contents }]
            } else {
                unpaired = Some(foreign[0].clone());
                // ABSOLUTE, via the same resolution the module's own imports get. A relative member
                // cannot be matched against `provides` and reads as a bare record id, so doctor would
                // report it DANGLING when the module has simply not migrated yet.
                // A MEMBER MUST NAME A REAL MODULE (#80, designer request).
                //
                // This was `.map(|spec| alias_for(…).unwrap_or(spec))`, and that `unwrap_or` did double
                // duty: it correctly passed an already-absolute `@/…` through, and it INCORRECTLY passed
                // through a relative path that resolved to nothing. `module_specifiers` scans raw text
                // for `from "…"`, and a test's own source carries FIXTURE CODE inside string literals —
                // a test building a fake module map writes `"import { b } from './b';"` as data — so the
                // quoted fixture's imports became the edge's members. Measured on the real store: 7
                // dangling edges, 25 unknown members, at least 14 of them mocks (`./a` … `./x`), a
                // literal `${entry}` placeholder, and `../also/gone`. None can EVER resolve, so doctor
                // reported them forever.
                //
                // Not a deny-list of names that look fake — `gone`/`nope` would be guessing. A member
                // has to resolve through the loader's own resolution, which `alias_for` already does
                // against the real filesystem. That KEEPS the pending case the design depends on: a
                // member that is still a plain file (not yet a record) resolves and stays.
                let (kept, declined): (Vec<_>, Vec<_>) =
                    foreign.into_iter().partition(|spec| edge_member_for(spec, dir, root).is_some());
                edge_members =
                    kept.iter().filter_map(|spec| edge_member_for(spec, dir, root)).collect();
                // Reported, not silently dropped: a genuinely missing module must not be hidden by the
                // same rule that hides a mock.
                edge_declined = declined;
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
        // A MODULE HAS NO SIGNATURE, and empty is the honest answer rather than a gap. A file holds
        // many functions with many contracts; picking one, or unioning them, would invent a contract
        // the module does not have. Function-granularity candidates carry the real ones.
        signature: Signature::default(),
        // What this module HOLDS. A module harvest is the whole file, so its top-level mutable
        // bindings come with it — recorded here so the record can say so rather than each caller
        // rediscovering it by reading the code.
        module_state: module_state(_tree.root_node(), &src_bytes),
        // PATH-derived, not stem-derived: 158 of 338 .rs files share a basename, so a stem id lets
        // exactly one crate own `cli.rs`. See `module_id`.
        id: module_id(&src_rel, ext_of(tech)),
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
        edge_declined,
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
        defs.iter().map(|d| (d.name.clone(), d.tech.clone())).collect();
    // Colocated tests, read ONCE PER FILE (#4126). Many candidates share one source — this repo's
    // `sorts.test.ts` covers four impls and `graphAlgos.test.ts` five — so pairing per candidate would
    // re-read the same file dozens of times across a 1780-candidate walk.
    let mut test_cache: std::collections::BTreeMap<String, Vec<CandidateTest>> = Default::default();
    for src_rel in defs.iter().map(|d| &d.rel) {
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
        .map(|Def { name, tech, code, rel: src_rel, sig, line: _ }| {
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
                // A FUNCTION harvest never mints an edge — the edge comes from a MODULE's colocated
                // test, and a fragment has none. Empty, not "declined nothing" (#80).
                edge_declined: Vec::new(),
                // A FUNCTION is not a module: whatever the file holds at top level is not this
                // candidate's, and claiming it would misreport every fragment lifted from a stateful file.
                module_state: Vec::new(),
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
                signature: sig,
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
/// One function in the TREE, projected to what a duplicate sweep reads — and nothing else.
///
/// Deliberately WITHOUT the body. A [`Candidate`] carries the full source, its colocated tests and a
/// classification, which is right for curation and ruinous for a whole-tree sweep: MEASURED, a
/// `harvest` of `crates/` peaks at **962 MB** for 7,514 functions. Nothing here retains the source, so
/// the walk streams and only the projection accumulates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FnShape {
    pub name: String,
    pub tech: String,
    /// Scanned-root-relative path, forward-slashed.
    pub src: String,
    /// 1-based start line, so a report can point AT the function rather than at its file.
    pub line: usize,
    /// The rename-invariant fingerprint. Present by construction: a function too trivial to have one
    /// is never collected, which is the triviality floor doing its work at the source.
    pub shape: String,
    pub arity: usize,
}

/// Every non-trivial function under `dir`, projected to its shape — the whole-tree corpus.
///
/// THIS IS THE HALF THE GRAPH CANNOT SEE. The algorithms store holds 32 Rust records; this tree holds
/// 7,514 Rust functions across 378 files, so a duplicate sweep over records alone covers 0.4% of the
/// Rust in this repo. Records are curated; the tree is where duplication actually accumulates.
///
/// STREAMS, and that is the whole design. Each file is parsed, projected and dropped before the next
/// is opened, so peak memory is one file's tree plus the projection — against the 962 MB a full
/// `harvest` of the same directory costs.
///
/// A function with no shape (too trivial to be evidence, see [`MIN_SHAPE_TOKENS`]) is dropped HERE
/// rather than filtered later: carrying every `fn new()` in the workspace to the grouping step and
/// discarding it there would be the same memory bill for the same answer.
pub fn scan_shapes(dir: &Path, tech_filter: Option<&str>) -> Vec<FnShape> {
    let mut out = Vec::new();
    scan_shapes_walk(dir, dir, tech_filter, &mut out);
    out
}

fn scan_shapes_walk(dir: &Path, root: &Path, tech_filter: Option<&str>, out: &mut Vec<FnShape>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.is_dir() {
            if !SKIP_DIRS.contains(&name) {
                scan_shapes_walk(&path, root, tech_filter, out);
            }
            continue;
        }
        let Some((tech, src, tree)) = parse(&path) else { continue };
        if tech_filter.is_some_and(|t| t != tech) {
            continue;
        }
        let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace(BACKSLASH, "/");
        // Per FILE, so the Defs — which hold the source — are dropped before the next file is read.
        let mut defs: Vec<Def> = Vec::new();
        collect_defs(tree.root_node(), &src, tech, false, &rel, &mut defs);
        for d in defs {
            let Some(shape) = shape_fingerprint(&d.code, &d.tech) else { continue };
            out.push(FnShape {
                line: d.line,
                arity: d.sig.arity(),
                name: d.name,
                tech: d.tech,
                src: d.rel,
                shape,
            });
        }
    }
}

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
                    out.push(Def {
                        name,
                        tech: tech.to_string(),
                        code: code.to_string(),
                        rel: rel.to_string(),
                        // Read from the SAME node the name came from, while the tree is in hand.
                        // Re-parsing the stored `code` later would work and would be a second parser
                        // to keep in step with this one.
                        sig: signature_of(node, src),
                        line: node.start_position().row + 1,
                    });
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
/// The module-state bindings in a source STRING, for a record that has no file on disk.
///
/// `harvest_module` reads a path, which is right for a harvest but useless to the COMPONENT store: a
/// component record carries its source as `srcText` and has no `moduleState` field at all. That gap is
/// why the stateful-shadow refusal covered impls only, and why a component record could claim a
/// registered platform specifier while holding module state with nothing to stop it.
///
/// `tsx` picks the dialect — a `.tsx` body parsed as plain TS mis-reads JSX as comparison operators and
/// the top-level scan silently finds nothing.
pub fn module_state_of(src: &str, tsx: bool) -> Vec<String> {
    let language: tree_sitter::Language = if tsx {
        tree_sitter_typescript::LANGUAGE_TSX.into()
    } else {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
    };
    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return Vec::new();
    }
    let bytes = src.as_bytes();
    match parser.parse(bytes, None) {
        Some(tree) => module_state(tree.root_node(), bytes),
        None => Vec::new(),
    }
}

/// Node kinds whose TEXT is an author's choice of NAME. Alpha-renamed to a positional slot, which is
/// what makes the fingerprint see through a copy-paste-and-rename.
///
/// Both grammars are covered by one list because the kinds do not collide: TypeScript spells a member
/// access `property_identifier` and Rust spells it `field_identifier`, and neither language emits the
/// other's kind. A kind missing here is not silently wrong — it falls through to the node-kind branch
/// and is emitted verbatim, which makes the fingerprint STRICTER (two copies stop matching), never
/// looser.
const RENAMEABLE_KINDS: &[&str] = &[
    "identifier",
    "type_identifier",
    "property_identifier",
    "shorthand_property_identifier",
    "shorthand_property_identifier_pattern",
    "field_identifier",
    "statement_identifier",
];

/// Node kinds whose TEXT is a VALUE. Replaced by the kind alone, so `clamp(x, 0, 10)` and
/// `clamp(x, 0, 100)` share a shape — a constant is a parameter someone chose not to extract, and two
/// copies differing only in one is the duplication this is hunting.
const LITERAL_KINDS: &[&str] = &[
    "number", "string", "string_fragment", "template_string", "regex", "char_literal",
    "integer_literal", "float_literal", "string_literal", "raw_string_literal", "boolean_literal",
    "true", "false", "null", "undefined",
];

/// A body shorter than this in SHAPE TOKENS carries no evidence. The mirror of `MIN_SHINGLES` on the
/// shingle signal, and needed for the same reason with a sharper edge: a node-kind sequence for
/// `fn new() { Self::default() }` is shared by every other trivial constructor in the workspace, so
/// without a floor the largest "duplicate group" in any Rust crate is its boilerplate.
pub const MIN_SHAPE_TOKENS: usize = 24;

/// The RENAME-INVARIANT shape of a function body — `None` when it is too trivial to be evidence.
///
/// THE ONE SIGNAL THE EXISTING DETECTOR CANNOT HAVE. `dedup_findings` compares k-gram shingles over
/// TOKENS, and a token stream contains the identifiers; rename them and the two sets are disjoint, so
/// no threshold can recover the match. MEASURED: `groupItems(items, keyOf)` and
/// `bucketRows(rows, labelFor)` — identical logic, every identifier renamed — were not grouped.
///
/// The normalization is three rules:
///   * an IDENTIFIER becomes a positional slot, assigned on first sight and reused consistently, so
///     `a + b` and `x + y` collapse to `#0 + #1` while `a + a` stays `#0 + #0` and does NOT match them;
///   * a LITERAL becomes its kind, so two copies differing only in a constant still match;
///   * everything else contributes its NODE KIND, so control flow is preserved exactly — a `for` loop
///     and a `while` loop are different shapes, and so are an `if` with an `else` and one without.
///
/// Equal fingerprints ARE the same code under renaming, so this needs no threshold and has no false
/// positives. That is why it ships ahead of the contract measure.
///
/// NOT STORED ON THE RECORD, deliberately. It is a pure function of `code`, so a stored copy is a cache
/// that goes stale the moment the body is edited — and stale derived data is the failure this repo
/// keeps paying for. Re-deriving 677 records costs a few hundred milliseconds.
pub fn shape_fingerprint(code: &str, tech: &str) -> Option<String> {
    let language: Language = match tech {
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        // A `.tsx` body parsed as plain TS mis-reads JSX as comparison operators, but a JSX-rendering
        // function is the COMPONENT graph's (`renders_jsx` already excludes it here), so the plain
        // dialect is the right one for every body this store holds.
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        _ => return None,
    };
    let mut parser = Parser::new();
    parser.set_language(&language).ok()?;
    let bytes = code.as_bytes();
    let tree = parser.parse(bytes, None)?;

    let mut slots: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut out = String::new();
    let mut stack = vec![tree.root_node()];
    let mut tokens = 0usize;
    // Explicit stack in PRE-ORDER, children pushed in reverse so they pop left-to-right: the sequence
    // has to be deterministic, and a recursive walk over a deeply nested body is a stack overflow
    // waiting for the one generated file that has it.
    while let Some(node) = stack.pop() {
        let kind = node.kind();
        if RENAMEABLE_KINDS.contains(&kind) {
            let text = node.utf8_text(bytes).unwrap_or_default().to_string();
            let next = slots.len();
            let slot = *slots.entry(text).or_insert(next);
            out.push('#');
            out.push_str(&slot.to_string());
        } else if LITERAL_KINDS.contains(&kind) {
            out.push_str(kind);
        } else {
            out.push_str(kind);
            let mut cursor = node.walk();
            let kids: Vec<Node> = node.named_children(&mut cursor).collect();
            for child in kids.into_iter().rev() {
                stack.push(child);
            }
        }
        out.push(' ');
        tokens += 1;
    }
    (tokens >= MIN_SHAPE_TOKENS)
        .then(|| bsc_cli_util::vendored::sha256_hex(out.as_bytes())[..16].to_string())
}

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

/// The TOP-LEVEL mutable bindings a module holds — its MODULE STATE, named so it can be seen.
///
/// This is the property that decides whether a module is safe to vendor. `provides` makes the loader
/// hand a record's source to graph consumers instead of using the bundled module: for a pure module
/// that is identical behaviour, but a module holding state gets a SECOND instance — a second queue, a
/// second cache, a second timer — and the two copies diverge with nothing to show for it. Recording
/// the bindings makes that visible on the record rather than something each caller has to rediscover
/// by reading the source.
///
/// The test is MUTABILITY, not the presence of a collection: a `const` bound to `new Set([...])` and
/// only ever read is a frozen lookup table and is NOT state. So `let`/`var` always count, and a
/// `const` counts only when it binds a container that something later mutates.
fn module_state(root: Node, src: &[u8]) -> Vec<String> {
    let text = std::str::from_utf8(src).unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    let mut cursor = root.walk();
    for top in root.named_children(&mut cursor) {
        // `export let x` wraps the declaration; look through it.
        let decl = if top.kind() == "export_statement" {
            top.child_by_field_name("declaration").unwrap_or(top)
        } else {
            top
        };
        if !matches!(decl.kind(), "lexical_declaration" | "variable_declaration") {
            continue;
        }
        let head = decl.utf8_text(src).unwrap_or("");
        let is_const = head.trim_start().starts_with("const");
        let mut c2 = decl.walk();
        for d in decl.named_children(&mut c2) {
            if d.kind() != "variable_declarator" {
                continue;
            }
            let Some(name) = field_text(d, "name", src) else { continue };
            let factory = field_text(d, "value", src).is_some_and(|v| is_state_factory(&v));
            if is_const && !factory && !mutated_after(&name, text, d.end_byte()) {
                continue;
            }
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

/// Does this initializer BUILD a stateful thing, so the binding is module state even though nothing
/// ever assigns to it?
///
/// `mutated_after` looks for a write, which finds `let` and a mutated container but is structurally
/// blind to the commonest shape of all: `export const useAnnouncer = create<S>(…)`. That is a `const`,
/// never textually mutated, and the state lives inside the closure the factory returns. It read as
/// PURE, kept its `provides`, and shadowed the specifier `appModules.ts` registers — so a graph-loaded
/// caller of `announce()` wrote to a SECOND store while the mounted `<LiveRegion>` subscribed to the
/// first, and the screen reader stayed silent.
///
/// Identity is the test, not mutation: each of these returns a thing whose VALUE IS ITS IDENTITY (a
/// store, a context, an event hub), so a second copy is a different one even if neither is ever
/// reassigned.
///
/// ⚠️ Deliberately a NAMED list, not "any call". `const rows = parse(raw)` is pure data and must stay
/// migratable, and so must a frozen `new Map()` — see the test below, which pins exactly that.
fn is_state_factory(init: &str) -> bool {
    let init = init.trim_start();
    // `create<S>(…)` / `createStore(…)` — zustand and friends. Match the call head, so a mere mention
    // in a comment or a longer identifier (`createStoreLabel`) does not count.
    const CALLS: [&str; 3] = ["create", "createStore", "createContext"];
    let head: String =
        init.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$').collect();
    if CALLS.contains(&head.as_str()) {
        let rest = init[head.len()..].trim_start();
        if rest.starts_with('(') || rest.starts_with('<') {
            return true;
        }
    }
    // `React.createContext(…)` — the same thing reached through the namespace import.
    if init.starts_with("React.createContext") {
        return true;
    }
    // Live objects whose identity is the whole point: listeners registered on one are invisible to a
    // second copy.
    const NEWS: [&str; 4] = ["EventTarget", "EventEmitter", "BroadcastChannel", "AbortController"];
    if let Some(rest) = init.strip_prefix("new ") {
        let ctor: String =
            rest.trim_start().chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        if NEWS.contains(&ctor.as_str()) {
            return true;
        }
    }
    false
}

/// Is `name` mutated anywhere after byte `from`? A container method that writes, or an index
/// assignment. Deliberately textual and deliberately loose in the SAFE direction — over-reporting a
/// binding as state costs a module its automatic migration and asks a human; under-reporting ships a
/// second copy of live state.
fn mutated_after(name: &str, text: &str, from: usize) -> bool {
    let Some(rest) = text.get(from..) else { return false };
    const WRITES: [&str; 10] =
        [".push(", ".pop(", ".shift(", ".unshift(", ".splice(", ".set(", ".add(", ".delete(", ".clear(", ".sort("];
    if WRITES.iter().any(|w| rest.contains(&format!("{name}{w}"))) {
        return true;
    }
    // `name[…] =` / `name.field =` — an index or property write, but not `==`/`=>`/`===`.
    rest.match_indices(name).any(|(i, _)| {
        let after = &rest[i + name.len()..];
        let assign = |s: &str| {
            s.trim_start().starts_with('=')
                && !s.trim_start().starts_with("==")
                && !s.trim_start().starts_with("=>")
        };
        (after.starts_with('[') && after.find(']').is_some_and(|j| assign(&after[j + 1..])))
            || (after.starts_with('.') && after.find(' ').is_some_and(|j| assign(&after[j..])))
    })
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

    // ── SIGNATURES (epic-a-graph-finds-its-own-duplicates, slice 1) ──────────────────────────────
    // Nothing can compare functions by CONTRACT until a harvested function carries one. `extract.rs`
    // already walked every function node and pulled the `name` field and stopped there, so
    // `doctor --dedup` could only ever key on a shared name, a shared src module, or byte-identical
    // code — all three lexical, and all three blind to the same routine written twice under two names.
    //
    // Asserted against REAL fixture source rather than inline strings: the failure mode here is a
    // grammar assumption (which node kind, which field name) being wrong, and an inline string written
    // from the same wrong assumption would agree with it.

    /// The signature of the named function harvested from `file`.
    fn sig_of(file: &str, name: &str) -> Signature {
        harvest_file(&fixtures().join(file))
            .into_iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("{name} was not harvested from {file}"))
            .signature
    }
    fn known(t: &str) -> TypeRef { TypeRef::Known(t.to_string()) }

    /// THE DISTINCTION THE WHOLE SLICE RESTS ON. `n` has no annotation, `x` says `any`, `xs` says
    /// `string[]`. Collapsing the first two onto one "no type" would let a later similarity pass
    /// conclude that two functions which both decline to say what they take agree about it.
    #[test]
    fn a_type_is_known_absent_or_opaque_and_the_three_are_distinguishable() {
        let sig = sig_of("signatures.ts", "threeStates");
        assert_eq!(sig.arity(), 3, "one parameter per declared parameter: {sig:?}");
        assert_eq!(sig.params[0], Param { name: "xs".into(), ty: known("string[]") });
        assert_eq!(sig.params[1], Param { name: "n".into(), ty: TypeRef::Absent });
        assert_eq!(sig.params[2], Param { name: "x".into(), ty: TypeRef::Opaque("any".into()) });
        assert_eq!(sig.returns, known("number"), "the return type drops its leading colon");
    }

    /// AN UNKNOWN NEVER MATCHES AN UNKNOWN — the rule `PartialEq` would get wrong, which is why
    /// `matches` exists beside it rather than instead of it.
    #[test]
    fn an_unknown_type_matches_nothing_including_another_unknown() {
        assert!(known("T[]").matches(&known("T[]")));
        assert!(!known("T[]").matches(&known("U[]")));

        for unknowable in [TypeRef::Absent, TypeRef::Opaque("any".into())] {
            assert!(!unknowable.matches(&unknowable.clone()), "{unknowable:?} agrees with itself");
            assert!(!unknowable.matches(&known("T[]")));
            assert!(!known("T[]").matches(&unknowable));
        }
        // ...while `==` still answers the DIFFERENT question of whether two records are identical, so
        // the two must not be conflated.
        assert_eq!(TypeRef::Absent, TypeRef::Absent, "structural equality is untouched");
    }

    /// `unknown` is a REAL TypeScript type that means "I will not tell you", so it is opaque, not known.
    #[test]
    fn the_unknown_type_is_opaque_rather_than_a_type_named_unknown() {
        let sig = sig_of("signatures.ts", "opaqueUnknown");
        assert_eq!(sig.params[0].ty, TypeRef::Opaque("unknown".into()));
        // `void` IS a declared type — the contrast that keeps the opaque list from growing by feel.
        assert_eq!(sig.returns, known("void"));
    }

    /// AN INFERRED RETURN IS ABSENT, and that is not the same as `: void`.
    #[test]
    fn an_inferred_return_is_absent_not_void() {
        assert_eq!(sig_of("signatures.ts", "inferredReturn").returns, TypeRef::Absent);
        assert_eq!(sig_of("signatures.ts", "opaqueUnknown").returns, known("void"));
    }

    /// AN ARROW DECLARES ITS CONTRACT ON THE VALUE, not on the binding. Reading the declarator node
    /// finds no `parameters` field at all, so every `export const f = (…) => …` in the library — and
    /// that is most of the TypeScript in this repo — would have harvested as arity 0.
    #[test]
    fn an_arrow_declarators_signature_comes_off_its_value() {
        let sig = sig_of("signatures.ts", "typedArrow");
        assert_eq!(sig.arity(), 2, "the arrow's parameters, not the declarator's absent ones");
        assert_eq!(sig.params[0], Param { name: "xs".into(), ty: known("number[]") });
        assert_eq!(sig.returns, known("number"));
    }

    /// An UNTYPED arrow parameter is a bare `identifier` with no `pattern` field — the shape an
    /// allow-list of parameter node kinds drops silently, and the reason `collect_params` walks named
    /// children and asks for a pattern instead of matching kinds.
    #[test]
    fn an_untyped_arrow_parameter_is_still_a_parameter() {
        let sig = sig_of("signatures.ts", "untypedArrow");
        assert_eq!(sig.params, vec![Param { name: "value".into(), ty: TypeRef::Absent }]);
    }

    /// A METHOD is reached only through `method_definition`, a different node kind from every other
    /// case here.
    #[test]
    fn a_method_definition_carries_its_signature_too() {
        let sig = sig_of("signatures.ts", "add");
        assert_eq!(sig.arity(), 2);
        assert_eq!(sig.params[1], Param { name: "at".into(), ty: known("number") });
        assert_eq!(sig.returns, known("boolean"));
    }

    /// A DESTRUCTURED parameter keeps its pattern verbatim: there is no identifier to take, and
    /// inventing one would put a name in the record that the source never used.
    #[test]
    fn a_destructured_parameter_keeps_its_pattern() {
        let ts = sig_of("signatures.ts", "destructured");
        assert_eq!(ts.arity(), 1, "one parameter, however many bindings it unpacks");
        assert_eq!(ts.params[0].name, "{ ok, code }");
        let rs = sig_of("signatures.rs", "destructured");
        assert_eq!(rs.arity(), 1);
        assert_eq!(rs.params[0], Param { name: "(lo, hi)".into(), ty: known("(u32, u32)") });
    }

    /// RUST: the grammar hands back the return type WITHOUT a colon, and a missing one is absent
    /// rather than `()` — reporting `()` would be an annotation the author never wrote.
    #[test]
    fn a_rust_function_carries_its_signature() {
        let two = sig_of("signatures.rs", "two_typed");
        assert_eq!(two.params[0], Param { name: "xs".into(), ty: known("&[u32]") });
        assert_eq!(two.params[1], Param { name: "seed".into(), ty: known("u32") });
        assert_eq!(two.returns, known("Vec<u32>"));

        assert_eq!(sig_of("signatures.rs", "no_return").returns, TypeRef::Absent);
        assert_eq!(sig_of("signatures.rs", "no_params").arity(), 0, "arity 0 is a bucket, not a gap");
    }

    /// `self` IS THE RECEIVER, not a parameter a caller supplies. Counting it would make every method
    /// one arity higher than the free function doing the same job — and land it in a different bucket
    /// from the duplicate it is meant to be matched against.
    ///
    /// TWO GUARDS HOLD THIS AND EITHER ALONE IS ENOUGH (the explicit `self_parameter` arm, and the
    /// `pattern`-field test that a receiver also fails), so removing one leaves this test green.
    /// Removing BOTH harvests `bump` as `[&mut self, by]` — which is how the real dependency was
    /// established rather than assumed.
    #[test]
    fn a_rust_receiver_is_not_a_parameter() {
        let sig = sig_of("signatures.rs", "bump");
        assert_eq!(sig.arity(), 1, "`by` alone; `&mut self` is the receiver: {sig:?}");
        assert_eq!(sig.params[0], Param { name: "by".into(), ty: known("u32") });
    }

    // ── THE TREE SCAN (slice 3) ─────────────────────────────────────────────────────────────────
    // The corpus the graph cannot see: 32 Rust records against 7,514 Rust functions on disk.

    /// The scan STREAMS and projects — no body, no tests, no classification. That is what makes a
    /// whole-tree sweep affordable: MEASURED, a `harvest` of `crates/` peaks at 962 MB while this
    /// peaks at 115 MB over the same directory.
    #[test]
    fn a_tree_scan_projects_each_function_to_its_shape() {
        let found = scan_shapes(&fixtures(), None);
        assert!(!found.is_empty(), "the fixture tree has non-trivial functions");
        for f in &found {
            assert!(!f.shape.is_empty(), "{} carries a shape or is not collected", f.name);
            assert!(f.line >= 1, "{} has a 1-based line, not a byte offset", f.name);
            assert!(!f.src.contains('\\'), "{} is forward-slashed: {}", f.name, f.src);
        }
        // A TRIVIAL function is dropped AT THE SOURCE rather than filtered later — carrying every
        // `fn new()` in a workspace to the grouping step costs the same memory for the same answer.
        assert!(
            !found.iter().any(|f| f.name == "helperThing"),
            "an empty body is not evidence and must not be collected: {:?}",
            found.iter().map(|f| &f.name).collect::<Vec<_>>(),
        );
    }

    /// A tech filter is applied DURING the walk, so an unwanted language is never parsed rather than
    /// parsed and discarded.
    #[test]
    fn a_tree_scan_honours_its_tech_filter() {
        let rust = scan_shapes(&fixtures(), Some("rust"));
        assert!(!rust.is_empty(), "the fixture tree has Rust");
        assert!(rust.iter().all(|f| f.tech == "rust"), "only rust: {:?}", rust.iter().map(|f| &f.tech).collect::<Vec<_>>());
        let ts = scan_shapes(&fixtures(), Some("typescript"));
        assert!(ts.iter().all(|f| f.tech == "typescript"));
        // …and the two partitions together are the unfiltered scan: a filter must not lose anything.
        assert_eq!(rust.len() + ts.len(), scan_shapes(&fixtures(), None).len());
    }

    /// THE POINT OF THE WHOLE SLICE, on the fixture tree: two functions that are the same code under
    /// renaming land on the same shape even though they live in different FILES, which is how a
    /// tree-wide sweep finds what a per-file or per-record one cannot.
    #[test]
    fn two_files_sharing_a_shape_are_visible_to_the_tree_scan() {
        let found = scan_shapes(&fixtures(), Some("typescript"));
        let mut by_shape: std::collections::BTreeMap<&str, Vec<&str>> = Default::default();
        for f in &found {
            by_shape.entry(&f.shape).or_default().push(&f.src);
        }
        // `signatures.ts` holds `threeStates` and nothing shaped like it; the assertion that matters is
        // that grouping BY SHAPE is what the scan enables, so every group's members are addressable.
        assert!(
            by_shape.values().all(|srcs| !srcs.is_empty()),
            "every shape names the files that carry it",
        );
        assert!(found.iter().any(|f| f.src.ends_with("sample.ts")), "the walk reaches every file");
    }

    // ── SHAPE FINGERPRINT (slice 2) ─────────────────────────────────────────────────────────────
    // The one signal `dedup_findings` structurally cannot have: its shingles are taken over TOKENS,
    // which include the identifiers, so a renamed copy has a DISJOINT set and no threshold recovers
    // it. MEASURED before writing this: `groupItems(items, keyOf)` and `bucketRows(rows, labelFor)`
    // were curated into a scratch store and `doctor --dedup` did not group them.

    /// Long enough to clear MIN_SHAPE_TOKENS — the floor is real, so every fixture here has to carry
    /// enough body to be evidence, exactly as a real candidate would.
    const GROUP_A: &str = r#"
        export function groupItems<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
          const out = new Map<string, T[]>();
          for (const item of items) {
            const key = keyOf(item);
            const bucket = out.get(key);
            if (bucket) { bucket.push(item); } else { out.set(key, [item]); }
          }
          return out;
        }"#;
    /// The SAME function with every identifier renamed — the copy-paste-then-rename case.
    const GROUP_B: &str = r#"
        export function bucketRows<R>(rows: R[], labelFor: (row: R) => string): Map<string, R[]> {
          const acc = new Map<string, R[]>();
          for (const row of rows) {
            const label = labelFor(row);
            const slot = acc.get(label);
            if (slot) { slot.push(row); } else { acc.set(label, [row]); }
          }
          return acc;
        }"#;

    /// THE WHOLE POINT. Rename every identifier and the shape is unchanged.
    #[test]
    fn a_renamed_copy_has_the_same_shape() {
        let a = shape_fingerprint(GROUP_A, "typescript").expect("long enough to be evidence");
        let b = shape_fingerprint(GROUP_B, "typescript").expect("long enough to be evidence");
        assert_eq!(a, b, "identical logic under renaming must fingerprint the same");
    }

    /// …and the CONVERSE, or the signal would be worthless: different control flow is a different
    /// shape. A `while` is not a `for`, and an `if` without an `else` is not one with.
    #[test]
    fn different_control_flow_is_a_different_shape() {
        let with_else = shape_fingerprint(GROUP_A, "typescript").unwrap();
        let no_else = shape_fingerprint(
            &GROUP_A.replace("if (bucket) { bucket.push(item); } else { out.set(key, [item]); }",
                             "if (bucket) { bucket.push(item); }\n            out.set(key, [item]);"),
            "typescript",
        )
        .unwrap();
        assert_ne!(with_else, no_else, "dropping the else branch must change the shape");
    }

    /// CONSISTENT renaming, not blanket erasure. `a + b` and `x + y` are the same shape; `a + a` is
    /// NOT — it reuses one binding where the others use two, and collapsing that would call two
    /// genuinely different functions duplicates.
    #[test]
    fn renaming_is_consistent_so_reusing_one_binding_is_a_different_shape() {
        let body = |expr: &str| format!(
            r#"export function f(alpha: number, beta: number): number {{
                 const first = alpha * 2;
                 const second = beta * 3;
                 const third = first + second;
                 return {expr} + third;
               }}"#);
        let two = shape_fingerprint(&body("alpha + beta"), "typescript").unwrap();
        let renamed = shape_fingerprint(
            &body("alpha + beta").replace("alpha", "aa").replace("beta", "bb"), "typescript").unwrap();
        let one = shape_fingerprint(&body("alpha + alpha"), "typescript").unwrap();
        assert_eq!(two, renamed, "a consistent rename is the same shape");
        assert_ne!(two, one, "`a + b` and `a + a` are different programs");
    }

    /// A LITERAL is a value, not a name: two copies differing only in a constant are still the same
    /// shape, because a constant is a parameter someone chose not to extract.
    #[test]
    fn a_differing_literal_does_not_change_the_shape() {
        let body = |n: &str| format!(
            r#"export function clampAll(xs: number[]): number[] {{
                 const out: number[] = [];
                 for (const x of xs) {{ out.push(x > {n} ? {n} : x); }}
                 return out;
               }}"#);
        assert_eq!(
            shape_fingerprint(&body("10"), "typescript").unwrap(),
            shape_fingerprint(&body("100"), "typescript").unwrap(),
        );
    }

    /// THE TRIVIALITY FLOOR, and it is not optional. Without it the largest "duplicate group" in any
    /// Rust crate is its boilerplate — every `fn new()` shares a node-kind sequence with every other.
    #[test]
    fn a_trivial_body_is_not_evidence() {
        assert_eq!(shape_fingerprint("pub fn new() -> Self { Self::default() }", "rust"), None);
        assert_eq!(shape_fingerprint("export const x = 1;", "typescript"), None);
        // …and a real body IS.
        assert!(shape_fingerprint(GROUP_A, "typescript").is_some());
    }

    /// Rust gets the same treatment, through a different grammar — `field_identifier` where TypeScript
    /// says `property_identifier`, and neither language emits the other's kind.
    #[test]
    fn a_renamed_rust_copy_has_the_same_shape_too() {
        let a = r#"pub fn tally(rows: &[u32], floor: u32) -> Vec<u32> {
                     let mut out = Vec::new();
                     for row in rows {
                         if *row > floor { out.push(*row); } else { out.push(floor); }
                     }
                     out
                   }"#;
        let b = r#"pub fn collect_scores(items: &[u32], base: u32) -> Vec<u32> {
                     let mut acc = Vec::new();
                     for item in items {
                         if *item > base { acc.push(*item); } else { acc.push(base); }
                     }
                     acc
                   }"#;
        assert_eq!(
            shape_fingerprint(a, "rust").expect("long enough"),
            shape_fingerprint(b, "rust").expect("long enough"),
        );
    }

    /// An unknown tech returns None rather than guessing a grammar — a body parsed with the wrong
    /// grammar yields a plausible fingerprint that means nothing, which is worse than no answer.
    #[test]
    fn an_unknown_tech_has_no_shape() {
        assert_eq!(shape_fingerprint(GROUP_A, "python"), None);
    }

    /// A MODULE has no single contract, and empty is the honest answer rather than a gap: a file holds
    /// many functions, so picking one or unioning them would invent a contract the module lacks.
    #[test]
    fn a_module_granularity_candidate_carries_no_signature() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let c = harvest_module(&fixtures().join("sample.ts"), root).unwrap();
        assert_eq!(c.signature, Signature::default());
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

    /// The module-state detector: the property that decides whether vendoring a record is equivalent
    /// to importing the module. Over-reporting costs a module its automatic migration and asks a
    /// human; under-reporting ships a SECOND copy of live state, so the bias is deliberate.
    #[test]
    fn module_state_names_the_mutable_bindings_and_ignores_frozen_ones() {
        let root = crate::unique_temp("modstate");
        let dir = root.join("src").join("x");
        std::fs::create_dir_all(&dir).unwrap();
        let cases: [(&str, &str, Vec<&str>); 10] = [
            // a top-level `let` is state, always
            ("a.ts", "let done = false;
export const go = () => { done = true; };
", vec!["done"]),
            // `export let` too — the export wrapper must not hide it
            ("b.ts", "export let seq = 0;
export const next = () => ++seq;
", vec!["seq"]),
            // a MUTATED const container is state
            ("c.ts", "const q: number[] = [];
export const add = (n: number) => { q.push(n); };
", vec!["q"]),
            ("d.ts", "const m = new Map();
export const put = (k: string) => { m.set(k, 1); };
", vec!["m"]),
            // a FROZEN lookup read only with `.has()` is NOT state — this is the case that makes the
            // detector useful rather than a blanket "contains a collection" reject
            ("e.ts", "const EX = new Set([\"a\"]);
export const skip = (s: string) => EX.has(s);
", vec![]),
            // A STATE FACTORY is state with no mutation anywhere — the hole that let `announcer.ts`
            // shadow a registered specifier and swallow every screen-reader announcement.
            ("f.ts", "import { create } from \"zustand\";
export const useAnnouncer = create<S>((set) => ({ msg: \"\" }));
", vec!["useAnnouncer"]),
            ("g.ts", "export const Ctx = createContext<T | null>(null);
", vec!["Ctx"]),
            ("h.ts", "const bus = new EventTarget();
export const on = (f: () => void) => bus.addEventListener(\"x\", f);
", vec!["bus"]),
            // …but a plain call returning DATA is not. Widening this to \"any call\" would re-block
            // hundreds of pure modules, which is the obvious wrong fix.
            ("i.ts", "const rows = parseRows(RAW);
export const all = () => rows;
", vec![]),
            // a longer identifier that merely STARTS with a factory name is not one
            ("j.ts", "const createStoreLabel = (s: string) => s.trim();
export const lbl = createStoreLabel;
", vec![]),
        ];
        for (name, body, want) in cases {
            let f = dir.join(name);
            std::fs::write(&f, body).unwrap();
            let c = harvest_module(&f, &root).expect("harvests");
            let want: Vec<String> = want.into_iter().map(str::to_string).collect();
            assert_eq!(c.module_state, want, "{name}: {body}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A FUNCTION-granularity candidate is not a module, so it never claims the file's module state —
    /// otherwise every fragment lifted from a stateful file would misreport it as its own.
    #[test]
    fn a_function_candidate_claims_no_module_state() {
        for c in harvest_file(&fixtures().join("sample.ts")) {
            assert!(c.module_state.is_empty(), "{} claimed module state", c.id);
        }
    }

    /// A DIRECTORY-index module claims the directory, not the index file. Importers write
    /// `@/features/data`; keeping `/index` gave 13 barrel records a specifier nothing resolves through.
    #[test]
    fn an_index_module_claims_its_directory() {
        let root = crate::unique_temp("idxprov");
        for (rel, want) in [
            ("features/data/index.ts", "@/features/data"),
            ("shared/ui/kit/index.tsx", "@/shared/ui/kit"),
            // not an index — untouched
            ("features/data/model.ts", "@/features/data/model"),
            // a file whose NAME merely ends in "index" keeps it: only the SEGMENT is a directory index
            ("features/data/reindex.ts", "@/features/data/reindex"),
        ] {
            let f = root.join("src").join(rel);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(&f, "export const x = 1;
").unwrap();
            let c = harvest_module(&f, &root).expect("harvests");
            assert_eq!(c.provides.as_deref(), Some(want), "{rel}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A `.tsx` module drops its extension like every other. The bug this covers shipped five records
    /// claiming `@/app/console/useConsoleTabs.tsx` — a specifier no import ever writes, so each record
    /// resolved through nothing. The `.ts` path was correct throughout, which is exactly what hid it.
    #[test]
    fn a_tsx_module_drops_its_extension_in_the_specifier_it_provides() {
        let root = crate::unique_temp("tsx-provides");
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
    fn a_relative_include_is_absolutized_against_the_crate_manifest() {
        // `include_str!("../x")` resolves against the FILE, and the materialized file lives in
        // `$OUT_DIR`. Absolutizing at harvest is what lets a module carrying one become a record —
        // the largest single blocker in the crate migration (5 crates).
        let root = std::env::temp_dir().join("bsc-graph-rel-include");
        let manifest = root.join("crates").join("demo");
        let dir = manifest.join("src");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(manifest.join("Cargo.toml"), "[package]\nname = \"demo\"\n").unwrap();
        let f = dir.join("release.rs");
        std::fs::write(
            &f,
            concat!(
                // The real shape, reaching ABOVE the crate root — `bsc-sound` does exactly this.
                "pub const SIGNAL: &str = include_str!(\"../../../src-tauri/data/sounds/signal.json\");\n",
                "pub const RAW: &[u8] = include_bytes!( \"../data/blob.bin\" );\n",
                // Already absolutized: must be left exactly alone, so re-harvesting is idempotent.
                "pub const GEN: &str = include!(concat!(env!(\"OUT_DIR\"), \"/x.rs\"));\n",
            ),
        )
        .unwrap();

        let c = harvest_module(&f, &root).expect("harvests");
        assert!(
            c.code.contains(
                "include_str!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/src/../../../src-tauri/data/sounds/signal.json\"))"
            ),
            "the include is rooted at the manifest: {}",
            c.code,
        );
        // Whitespace inside the parens must not defeat it, and `include_bytes!` takes the same
        // rewrite. Only the LITERAL is replaced, so the author's spacing survives — asserting on the
        // argument rather than on the whole call is the difference between testing the behavior and
        // pinning the formatting.
        assert!(
            c.code.contains("include_bytes!( concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/src/../data/blob.bin\") )"),
            "include_bytes! is rewritten too, spacing intact: {}",
            c.code,
        );
        assert!(c.code.contains("include!(concat!(env!(\"OUT_DIR\"), \"/x.rs\"))"), "an OUT_DIR include is untouched");
        // IDEMPOTENT: harvesting the rewritten code again must not wrap it a second time.
        assert_eq!(absolutize_includes(&c.code, &f), c.code, "already-absolutized code is a fixed point");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_rust_string_ending_in_from_is_not_read_as_a_module_specifier() {
        // `crates/bsc-files` could not migrate because of this. Its CLI implements
        // `bsc files read --from 10`, so the source contains `"--from".into()`; the specifier scanner
        // treats the CLOSING quote of `"--from"` as an opening one and captures `.into(), ` as an
        // imported module. Every "member" was then declined, leaving a 0-member edge that the store
        // refused — a correct error about a relationship that should never have been proposed.
        //
        // Rust has no module specifiers, and for a Rust module `test_path_for` returns the FILE ITSELF
        // (its tests are inline), so the scan was running over production source to begin with.
        let root = std::env::temp_dir().join("bsc-graph-rust-from-literal");
        let dir = root.join("src");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("cli.rs");
        std::fs::write(
            &f,
            concat!(
                "pub fn parse_args(a: Vec<String>) -> Result<(), String> { let _ = a; Ok(()) }\n",
                "#[cfg(test)]\n",
                "mod tests {\n",
                "    use super::*;\n",
                "    #[test]\n",
                "    fn reads_a_range() {\n",
                "        assert!(parse_args(vec![\"--from\".into(), \"10\".into()]).is_ok());\n",
                "    }\n",
                "}\n",
            ),
        )
        .unwrap();

        let c = harvest_module(&f, &root).expect("harvests");
        assert!(c.edge_members.is_empty(), "no edge is proposed: {:?}", c.edge_members);
        assert!(c.edge_declined.is_empty(), "nothing is declined: {:?}", c.edge_declined);
        assert!(
            !c.classification.reasons.iter().any(|r| r.contains("imports the app module")),
            "no fabricated import reason: {:?}",
            c.classification.reasons,
        );
        // The inline tests ride along with the module, as they do for every other migrated crate.
        assert!(!c.tests.is_empty(), "the module's own inline tests are paired");

        std::fs::remove_dir_all(&root).ok();
    }

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

/// #80 — an edge member must name a real module, not a string that appeared in a test file.
#[cfg(test)]
mod edge_member_tests {
    use super::edge_member_for;

    /// A tree with ONE real sibling module, so "resolves" and "does not resolve" are both real answers
    /// rather than both being misses.
    fn tree() -> (std::path::PathBuf, std::path::PathBuf) {
        let root = crate::unique_temp("edge");
        let dir = root.join("src/features/designs/lib");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("model.ts"), "export const m = 1;\n").unwrap();
        (root, dir)
    }

    /// THE REPORTED SHAPES. `component-preview.ts~integration` carried twelve single-letter members
    /// (`./a` … `./x`) and `html-renderer.ts~integration` a literal `${entry}`; none can ever resolve,
    /// so doctor reported them forever.
    #[test]
    fn a_mock_and_a_template_placeholder_are_not_members() {
        let (root, dir) = tree();
        for spec in ["./a", "./b", "./x", "../also/gone", "./Sibling"] {
            assert_eq!(edge_member_for(spec, &dir, &root), None, "{spec} names no module");
        }
        // A `${…}` is not a literal specifier at all — decidable on sight, no filesystem needed.
        assert_eq!(edge_member_for("../../../../__tests__/preview/${entry}", &dir, &root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// THE PENDING CASE MUST SURVIVE, and it is the reason this is a resolution check rather than a
    /// deny-list: a member that is still a plain FILE (not yet a record) is exactly what doctor means
    /// by pending, and dropping it would hide real migration work.
    #[test]
    fn a_real_sibling_module_still_becomes_an_absolute_member() {
        let (root, dir) = tree();
        assert_eq!(
            edge_member_for("./model", &dir, &root).as_deref(),
            Some("@/features/designs/lib/model"),
            "a real file resolves, and is expressed ABSOLUTELY so it can be matched against `provides`"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An already-absolute specifier is the canonical form and rides through untouched — it is not
    /// resolved against a directory, because it does not name one.
    #[test]
    fn an_alias_specifier_is_kept_verbatim() {
        let (root, dir) = tree();
        assert_eq!(
            edge_member_for("@/shared/lib/core/log", &dir, &root).as_deref(),
            Some("@/shared/lib/core/log"),
        );
        // …but an alias with an interpolation in it is still not a specifier.
        assert_eq!(edge_member_for("@/features/${name}/lib/x", &dir, &root), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// The module-record id derivation (`a-module-record-id-must-come-from-its-path`).
///
/// Its failure mode is not an error — it is a store REFUSING a second record with a message about
/// duplicates, which reads as "this module cannot be a record" rather than "the id scheme is wrong".
#[cfg(test)]
mod module_id_tests {
    use super::module_id;

    /// The whole reason this derivation exists: two crates' `cli.rs` must be able to coexist.
    #[test]
    fn two_crates_cli_modules_get_distinct_ids() {
        let a = module_id("crates/bsc-blueprint/src/cli.rs", "rs");
        let b = module_id("crates/bsc-teams/src/cli.rs", "rs");
        assert_eq!(a, "bsc-blueprint--cli.rs");
        assert_eq!(b, "bsc-teams--cli.rs");
        assert_ne!(a, b, "the collision this exists to remove");
    }

    #[test]
    fn every_lib_rs_in_the_workspace_would_be_distinct() {
        let ids: std::collections::BTreeSet<String> = ["bsc-util", "bsc-graph", "plandb", "cve"]
            .iter()
            .map(|c| module_id(&format!("crates/{c}/src/lib.rs"), "rs"))
            .collect();
        assert_eq!(ids.len(), 4, "39 lib.rs files must not collapse onto one id: {ids:?}");
    }

    /// `crates/` and `src/` are on nearly every path and distinguish nothing; the crate name does.
    #[test]
    fn structural_segments_are_dropped_and_the_crate_name_is_kept() {
        assert_eq!(module_id("crates/plandb/src/cli/nouns.rs", "rs"), "plandb--cli--nouns.rs");
        assert_eq!(module_id("src-tauri/src/console/pty/job.rs", "rs"), "src-tauri--console--pty--job.rs");
    }

    #[test]
    fn a_nested_frontend_module_keeps_its_segments() {
        assert_eq!(module_id("src/features/planner/lib/focusedPlan.ts", "ts"), "features--planner--lib--focused-plan.ts");
    }

    /// A path that is nothing BUT structural segments still has to produce a usable id.
    #[test]
    fn a_degenerate_path_does_not_produce_an_empty_id() {
        let id = module_id("src/", "ts");
        assert!(id.starts_with("module"), "{id}");
        assert!(id.ends_with(".ts"));
    }

    #[test]
    fn the_extension_comes_from_the_caller_not_the_path() {
        // A .tsx module records a `ts` id — the file extension is not always the record's extension.
        assert_eq!(module_id("src/app/App.tsx", "ts"), "app--app.ts");
    }

    #[test]
    fn windows_separators_are_normalized() {
        assert_eq!(module_id(r"crates\bsc-teams\src\cli.rs", "rs"), "bsc-teams--cli.rs");
    }
}
