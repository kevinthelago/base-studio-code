//! The Algorithms knowledge graph (#2760/#2761/#2853/#2961) — the per-language library of
//! IMPLEMENTATIONS. Each language kit is rooted in that language's PRIMITIVES (role: primitive), with
//! algorithms composing UP from them (role: algorithm); the implementation IS the concept — there is NO
//! abstract concept ontology (nodes/edges/concept removed #2961). Seeded from the packaged
//! `src-tauri/data/knowledge/algorithms.json` (the SAME file the frontend imports), then WRITABLE on
//! disk (#2853): the knowledge librarian curates it via `bsc graph`. The store at
//! `~/.base-studio-code/knowledge/algorithms.json` (env `BSC_GRAPH_STORE`) is the runtime source of
//! truth — seeded from the embedded copy on first read, mutated by `impl set`/`impl remove`, so a read
//! after a write reflects the write ("verify after every write"). #2745 layers the extract-to-harvest
//! feeder (mine reusable code from a project into the library) on top.


use serde_json::Value;
use std::path::{Path, PathBuf};

/// A temp path for ONE test — the fixture helper every test in this crate builds its tree under.
///
/// Keying a fixture on the process id ALONE is what made `bsc-graph` intermittently red: three
/// `edge_member_tests` shared `bsc-graph-edge-<pid>`, the harness ran them on parallel threads, and each
/// ended by removing the directory — so a sibling finishing first deleted `model.ts` out from under a
/// test mid-resolution and a real file reported as unresolvable. Measured 1 failure in 3 parallel runs;
/// 5 for 5 green serialised.
///
/// The pid keeps concurrent test BINARIES apart and the counter keeps tests inside one binary apart, so
/// two calls can never collide. A counter rather than a timestamp on purpose: it cannot tie on a coarse
/// clock, and it leaves the path reproducible within a run.
#[cfg(test)]
pub(crate) fn unique_temp(tag: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "bsc-graph-{tag}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

/// The packaged seed — the SAME file the frontend reads via `@data/knowledge/algorithms.json`.
///
/// LOADED AT RUNTIME rather than `include_str!`'d (see [`bsc_util::packaged`]): at 2.6 MB it made
/// every algorithms-record edit recompile this crate and everything downstream of it. Cached in a
/// `OnceLock` and handed out as `&'static str`, so callers are unchanged.
pub fn graph_json() -> &'static str {
    // KEYED ON THE RESOLVED PATH, not on nothing. This was a bare `OnceLock<String>`, which caches
    // the FIRST seed any caller asks for and then ignores where the next caller is pointing — so
    // `BSC_DATA_DIR`, which `bsc_util::packaged` treats as its highest-priority override, silently
    // stopped working the moment anything had already read a seed in that process.
    //
    // MEASURED: `tests_promote_syncs_tests_from_the_runtime_store_onto_the_packaged_seed` passes
    // alone and fails in a `cargo test` suite, because a sibling test populates the cache first. A
    // serial lock cannot fix that — the cache outlives the lock — and it is a real latent defect, not
    // only a test artifact: a cache that ignores its own input is wrong wherever the input can vary.
    //
    // Still cached, so the 2.6 MB read happens ONCE PER PATH. Production resolves one path, so this
    // is exactly the previous behaviour with the key made explicit.
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::BTreeMap<std::path::PathBuf, &'static str>>,
    > = std::sync::OnceLock::new();
    const REL: &str = "knowledge/algorithms.json";
    // An unresolvable path keys as empty and still reads, so a missing seed panics in
    // `read_required` with its own message rather than here with a worse one.
    let key = bsc_util::packaged::resolved_path(REL).unwrap_or_default();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeMap::new()));
    let mut map = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(text) = map.get(&key) {
        return text;
    }
    // Leaked deliberately, exactly as the `OnceLock<String>` did: callers hold `&'static str`. One
    // leak per DISTINCT seed path — one in production, a handful across a test suite.
    let text: &'static str = Box::leak(bsc_util::packaged::read_required(REL).into_boxed_str());
    map.insert(key, text);
    text
}

/// What KIND of thing a record is (#2863) — validated on `impl set`.
///
/// A `primitive` is a LANGUAGE built-in, DESCRIBED by its std `ref` and never re-coded (#2972); an
/// `algorithm` is production logic that composes primitives up; a **`test`** is a module whose whole
/// purpose is to check other records (`a-test-only-module-is-not-an-algorithm`).
///
/// # What makes a record a test
///
/// Its DECLARATION gates it out of production builds — `#[cfg(test)]` on the `mod` line. That is the
/// compiler's own statement that the module is in no shipped binary, which is what "not production
/// logic" means; it is not a guess about the module's contents, and it is NEVER its filename.
/// `crates/bsc-graph/src/rust_test.rs` is 358 lines of production logic that a `*_test.rs` suffix rule
/// called a test, which is what settled that question.
///
/// The role is STORED, written once from the declaration by `migrate::role_for`, and the derivation is
/// the AUDITOR rather than the definition: [`doctor`] reports a record whose `moduleAttrs` say
/// `#[cfg(test)]` while its role says `algorithm` (`mis-roled-test`). Recomputing on every read would
/// let a reformatted attribute silently reclassify a record, and would leave no way to label a
/// test-support module that is deliberately not `#[cfg(test)]`-gated.
///
/// # Why a role rather than a boolean
///
/// Every consumer that already branches on `role != "algorithm"` to mean "not production logic to type,
/// visualize, rank or survey" gets the right answer for a test record with no edit — [`doctor`]'s
/// kind/viz loop is the one in this crate. A `testOnly` boolean would default to `false` at every one of
/// those sites, which restates today's wrong answer until each is found and changed. And these are
/// exclusive in fact — nothing is both a language built-in and a test — so a second axis would model a
/// freedom that does not exist.
/// `doc` is the fourth because a CRATE ROOT'S PROSE is a record too
/// (`a-crate-root-is-shared-so-a-crate-is-one-file`). It carries markdown rather than source, is
/// materialized into `$OUT_DIR/crate_doc.md` by `graph-materialize` for the shared crate root's
/// `#![doc = include_str!(…)]`, and is deliberately NOT an `algorithm`: `scripts/graph-rust-compile.mjs`
/// would try to compile it as Rust and [`doctor`]'s kind/viz loop would demand a manipulation kind of
/// a paragraph. Every consumer that already branches on `role != "algorithm"` gets that right for free.
pub const ROLES: [&str; 4] = ["primitive", "algorithm", "test", "doc"];

/// Is this record's MODULE compiled out of production builds — `#[cfg(test)]` on its declaration?
///
/// The auditor's half of the test scheme (see [`ROLES`]). Whitespace-insensitive, because a record must
/// not change classification because somebody reformatted the attribute. A FEATURE gate is not a test
/// gate: `crates/data` gates three modules on `#[cfg(feature = "duckdb-store")]` and those are
/// production logic that happens to be optional.
pub fn module_is_cfg_test(im: &Value) -> bool {
    im.get("moduleAttrs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|a| a.chars().filter(|c| !c.is_whitespace()).collect::<String>() == "#[cfg(test)]")
}

/// Parse the embedded packaged seed. Panics only if the packaged JSON is malformed — a build-time
/// invariant the tests guard.
pub fn seed() -> Value {
    serde_json::from_str(graph_json()).expect("packaged algorithms.json is valid JSON")
}

/// The on-disk path the packaged seed [`graph_json`] resolves to — the same file [`seed`] parses, but
/// as a PATH rather than cached contents. `None` when no candidate resolves (a shipped build whose
/// resources are missing, or `BSC_DATA_DIR` pointed somewhere empty).
///
/// Unlike [`graph_json`]/[`seed`], which cache the first successful read for the process's lifetime
/// (so a later on-disk edit is invisible to them within the same run), this re-resolves on every call
/// — a caller that wants to WRITE the seed back in place (`tests set --seed`, #141) needs the CURRENT
/// path, and landing a test onto the packaged copy is optional curation, not something every boot
/// depends on, so an ordinary error is right here where [`seed`] would rather panic.
pub fn seed_path() -> Option<PathBuf> {
    seed_path_from(std::env::current_dir().ok().as_deref())
}

/// [`seed_path`] with the starting directory passed in, so the PRECEDENCE is testable without
/// mutating the process's cwd. The order is the whole contract:
///
///   1. `$BSC_DATA_DIR` — the one form that says "this tree, deliberately";
///   2. the checkout enclosing `start` (see [`seed_under_checkout`]);
///   3. `bsc_util::packaged` — the shipped resource dir, then the checkout baked into the binary.
///
/// Step 2 is the fix, and it must sit BELOW the env override and ABOVE the packaged fallback. Testing
/// `seed_under_checkout` alone does not pin that: the walk keeps passing while nothing calls it, which
/// is exactly what happened on the first attempt here.
pub fn seed_path_from(start: Option<&Path>) -> Option<PathBuf> {
    if let Ok(d) = std::env::var("BSC_DATA_DIR") {
        let d = d.trim();
        if !d.is_empty() {
            let p = Path::new(d).join("knowledge").join("algorithms.json");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    if let Some(p) = start.and_then(seed_under_checkout) {
        return Some(p);
    }
    bsc_util::packaged::resolved_path("knowledge/algorithms.json")
}

/// The packaged seed belonging to the checkout that ENCLOSES `start`, found by walking up for
/// `src-tauri/data/knowledge/algorithms.json`.
///
/// WHY THIS EXISTS. `bsc_util::packaged` resolves `$BSC_DATA_DIR`, then the shipped resource dir, then
/// the dev checkout baked into the binary — and none of those is the caller's cwd. The binary on PATH
/// is the staged `~/.base-studio-code/bin/bsc`, so every worktree agent writing `--seed` was aiming at
/// ONE target: the repo root.
///
/// MEASURED 2026-09-01: eighteen `tests set --seed` calls run with the cwd inside `wt-171` all reported
/// success; wt-171's seed was unchanged and the ROOT's `algorithms.json` had sixteen altered records.
/// The root is checked out on the app branch and runs the app, so the write landed on a branch nobody
/// chose, `npm run promote` then refused for "uncommitted changes" naming nothing about the cause, and
/// the obvious way to clean it — `git checkout` in the root — would have destroyed the work while the
/// session that made it never knew it was there. Two agents doing it at once interleave with no lock.
///
/// A WALK, not `git rev-parse`: the thing being looked for IS the data tree, so finding it directly
/// needs no git, works in a worktree exactly as in the main checkout, and cannot disagree with itself
/// about where the repo starts. Returns `None` outside a checkout, which is the shipped-build case and
/// correctly falls through to the packaged resolution.
pub fn seed_under_checkout(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        let p = d.join("src-tauri").join("data").join("knowledge").join("algorithms.json");
        if p.is_file() {
            return Some(p);
        }
        dir = d.parent();
    }
    None
}

/// The writable store path — `BSC_GRAPH_STORE` if set, else `~/.base-studio-code/knowledge/algorithms.json`.
/// `None` when no home dir resolves (reads then fall back to the embedded seed; writes error).
pub fn store_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("BSC_GRAPH_STORE") {
        if !p.trim().is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    bsc_util::bsc_base_dir().map(|b| b.join("knowledge").join("algorithms.json"))
}

/// Load the graph AT a path: the on-disk store when it exists and parses, else the embedded seed. A
/// corrupt store falls back to the seed rather than bricking the CLI.
pub fn load_at(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(seed)
}

/// The runtime graph — the writable store (store-or-seed), RECONCILED against the packaged seed
/// (#3198). Every reader resolves against this, so a read after a write reflects the write AND a
/// packaged algorithm added after the store was first written still surfaces.
pub fn load() -> Value {
    let mut g = match store_path() {
        Some(p) => load_at(&p),
        None => seed(),
    };
    // Heal a store written by the first cut BEFORE anything reads it (#the-tombstone-crash), and
    // PERSIST the heal — an in-memory fix would leave the file untouched, and the file is what the
    // FRONTEND reads. That asymmetry is the whole bug: Rust readers were fine while the graph page
    // died on a record Rust had filtered. Best-effort and only when something actually changed, so a
    // normal load still writes nothing.
    // Both heals run before anything reads, and both PERSIST — an in-memory fix would leave the file
    // untouched, and the file is what the FRONTEND reads. `|` not `||`: short-circuiting would skip
    // the dedupe whenever the migration already reported a change.
    if migrate_inline_tombstones(&mut g) | dedupe_suppressions(&mut g) {
        if let Some(p) = store_path() {
            let _ = save_at(&p, &g);
        }
    }
    reconcile_seed(&mut g);
    g
}

/// Append any packaged-seed implementation whose `id` is ABSENT from `g` (#3198) — the seed reconcile
/// that keeps a writable store from SHADOWING algorithms added to the packaged seed later (the same
/// class the Designs kit solved with #2483). It never overwrites an existing id, so a librarian's edit
/// to a seed impl and every harvested/custom impl are preserved; a seed impl the store lacks — never
/// had it, or the user removed it — is (re-)added, so packaged algorithms always surface AND are
/// RECOVERABLE (delete one, it returns on next load). Custom (non-seed) impls stay fully removable.
/// Returns whether it changed `g`. Order-stable: the store's own impls keep their order; missing seed
/// impls are appended in seed order.
///
/// EDGES reconcile by the same rule (`a-rust-record-test-runs-and-an-edge-reaches-the-seed`). They did
/// not, so an edge that reached the packaged seed was invisible to every machine that already had a
/// runtime store -- which made the whole `promote --seed` path for the tier deliver to nobody.
pub fn reconcile_seed(g: &mut Value) -> bool {
    let suppressed: std::collections::HashSet<String> = suppressions_of(g)
        .iter()
        .filter_map(|t| t.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let have: std::collections::HashSet<String> = implementations_of(g)
        .iter()
        .filter_map(|im| im.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let missing: Vec<Value> = implementations_of(&seed())
        .into_iter()
        .filter(|im| {
            // A SUPPRESSED id is not "missing" — it was retired on purpose, and re-adding it is the
            // exact bug the tombstone exists to prevent (#71).
            im.get("id")
                .and_then(Value::as_str)
                .map(|id| !have.contains(id) && !suppressed.contains(id))
                .unwrap_or(false)
        })
        .collect();
    let missing_edges = reconcile_edges_into(g, &edges_of(&seed()));

    if missing.is_empty() && !missing_edges {
        return false;
    }
    if !missing.is_empty() {
        let arr = ensure_array(g, "implementations");
        for im in missing {
            arr.push(im);
        }
    }
    true
}

/// Append every edge of `from` whose id is ABSENT from `g`, and report whether anything was added —
/// the edge half of [`reconcile_seed`] (`a-rust-record-test-runs-and-an-edge-reaches-the-seed`).
///
/// # Why this tier reconciles at all
///
/// It did not, and the consequence was that the packaged seed could not deliver an edge to any
/// machine that had ever authored one. [`load`] falls back WHOLLY to the seed only when no store file
/// exists, so a fresh CLONE on a developer's box — which is every box here — read its own store,
/// found no `edges` key, and showed none. MEASURED: a store holding one impl and no edges answered
/// `bsc graph edge list` with `[]` while the packaged seed carried the edge. `bsc graph promote --id
/// <edge> --seed` already lands an edge in the seed; without this, landing it there reached nobody.
///
/// # Taken as an argument rather than read from [`seed`]
///
/// So it is testable without a packaged seed and without `set_var("BSC_DATA_DIR", …)` — the
/// process-global mutation that makes a suite pass under `cargo nextest` (one process per test) and
/// fail under `cargo test` (threads in one), which this repo has paid for twice.
///
/// Same rule as the implementation half and deliberately no more: an id the store already holds is
/// NEVER overwritten, so a local edit survives; what is absent is appended in `from` order.
///
/// NO SUPPRESSION CHECK, and that is not an oversight. A tombstone is keyed on an IMPLEMENTATION id
/// ([`is_suppressed`]), an edge id is a different namespace, and consulting one list for two
/// namespaces would let an impl's tombstone silently retire an unrelated edge that shares its name.
pub fn reconcile_edges_into(g: &mut Value, from: &[Value]) -> bool {
    let have: std::collections::HashSet<&str> =
        g.get("edges").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default()
            .iter()
            .filter_map(|e| e.get("id").and_then(Value::as_str))
            .collect();
    let missing: Vec<Value> = from
        .iter()
        .filter(|e| e.get("id").and_then(Value::as_str).map(|id| !have.contains(id)).unwrap_or(false))
        .cloned()
        .collect();
    // ADDITIVE, exactly as `edges_of` is: nothing missing must not insert an empty `edges` array into
    // a store that has none, or every store on every box grows the key on its next read.
    if missing.is_empty() {
        return false;
    }
    let arr = ensure_array(g, "edges");
    for e in missing {
        arr.push(e);
    }
    true
}

/// Persist the graph to `path` (pretty JSON), creating the parent dir — write a temp sibling then
/// rename so a crash mid-write never truncates the store.
pub fn save_at(path: &Path, g: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(g).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Persist the graph to the runtime store. Errors when no store path resolves (no home dir).
pub fn save(g: &Value) -> Result<(), String> {
    let p = store_path().ok_or("no home dir — cannot persist the knowledge graph")?;
    save_at(&p, g)
}

// ── the per-language implementation tier (#2863/#2958) — a node IS its implementation ──

/// The typed shape of a library implementation — the Rust mirror of the frontend `AlgoImpl` interface
/// (`src/features/algorithms/lib/knowledge.ts`). The on-disk store is untyped JSON (a `serde_json::Value`)
/// so unknown keys always round-trip; this struct documents the contract AND drives the serde round-trip
/// tests. The `domain` + `tags` facets (#3120) are ADDITIVE: `#[serde(default, skip_serializing_if …)]`
/// means an impl authored before the facet existed deserializes cleanly (domain `None`, tags empty) and
/// re-serializes UNCHANGED (no empty `domain`/`tags` keys appear), so existing seed JSON is untouched.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AlgoImpl {
    /// `<name>.<ext>` (algorithm) or `<tech>.<name>` (primitive).
    pub id: String,
    /// The language kit — `"typescript"` | `"rust"`.
    pub tech: String,
    /// What kind of record this is (#2863) — `"primitive"` | `"algorithm"` | `"test"` | `"doc"`. See [`ROLES`].
    pub role: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// OTHER same-tech impl ids this builds on. Always emitted (a required contract field), defaulting to
    /// `[]` when a source JSON omits it.
    #[serde(default)]
    pub composes: Vec<String>,
    /// A primitive's std reference (`std::vec::Vec`); algorithms leave it unset (#2972).
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// PROVENANCE (#4091/#4107) — the scanned-root-relative path of the file this was harvested from,
    /// forward-slashed. `curate --apply` has written it since #4091, but the contract never declared it,
    /// so it was untyped and undocumented; every impl in the live store predates it. It is what makes a
    /// record traceable to its file, dedupable on re-harvest, and — via [`Self::folder`] — placeable in
    /// a folder tree. Additive: an impl without it round-trips unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    /// The FOLDER (#4107) — the nested, `/`-delimited path this impl organizes under, derived from
    /// [`Self::src`] by `bsc_util::folder_from_src`, the SAME derivation components use. Harvest is 1:1:
    /// the folder mirrors where the code actually lives, not a curated taxonomy. (Re-organizing the
    /// library into an optimized graph is a separate pass on top of an accurate base.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// The DOMAIN facet (#3120) — the cross-language collection this impl belongs to (e.g. "logistics").
    /// Distinct from [`Self::folder`]: `domain_of` deliberately COLLAPSES a path to one segment
    /// (`features/<x>` → `<x>`) for a cross-language filter, where the folder keeps the full nesting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    /// The OWNERSHIP axis (`the-ownership-axis-is-feature-on-both-graphs`) — which FEATURE owns this
    /// record, and so which worker may write it. `core` is the shared baseline usable anywhere;
    /// `reference` is library content owned by no application feature.
    ///
    /// THREE NEARBY FIELDS, THREE QUESTIONS, and confusing them is how this axis got named twice:
    /// - [`Self::folder`] is PROVENANCE — where the code lives, derived from `src`.
    /// - [`Self::domain`] is the curated cross-language COLLECTION facet (#3120), and it is PARTIAL by
    ///   design: general-purpose algorithms and primitives are excluded on purpose.
    /// - `feature` is OWNERSHIP, and it is TOTAL — every record is placed.
    ///
    /// Single-valued, because it answers which ONE worker may write the record; a record owned by
    /// three features has no answer. USAGE is the many-to-many relation and lives elsewhere: `requires`
    /// on a plan feature, mirrored here as `requiredBy`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature: Option<String>,
    /// Free-form tags (#3120) — additive keywords for cross-cutting collections.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// The KIND facet (#3210) — the manipulation this algorithm performs (`sort`/`search`/…), the axis
    /// that (with its data structure) selects the live animation. Additive like `domain`: the creator
    /// assigns it (`bsc graph impl set --kind`), a heuristic fills untyped impls; absent ⇒ omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The VIZ-CODE facet (#3218) — the algorithm's VISUALIZATION as data: a JS trace-program (a function
    /// over the TracedArray API) the sandboxed executor runs to derive the animation. Additive; the
    /// librarian authors it (`bsc graph impl set --viz-code`); absent ⇒ omitted. Stored as `vizCode`.
    #[serde(default, rename = "vizCode", skip_serializing_if = "Option::is_none")]
    pub viz_code: Option<String>,
    /// The `@/…` specifier this impl SATISFIES — what the runtime loader matches a record's import
    /// against, the same field the component store carries (#3660).
    ///
    /// Typed late, and the gap was not cosmetic: the store had held this since `harvest --module`
    /// existed, so a typed round-trip DROPPED it silently. `provides` is not incidental metadata — it is
    /// the whole reason a logic module can be a record at all, and an untyped field the store round-trips
    /// through is one refactor away from being dropped for real.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provides: Option<String>,
    /// The COLOCATED TESTS carried onto the node (#4126), paired only when they can run in isolation.
    /// Additive like every facet above: an impl without them re-serializes with no `tests` key.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tests: Vec<AlgoImplTest>,
}

/// One test paired with an impl: its display name and its full source.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AlgoImplTest {
    pub name: String,
    pub src: String,
    /// The extension the test's SOURCE FILE had (`.ts` / `.tsx`), when the record knows it.
    ///
    /// The emitter otherwise guesses from the body, and its guess reads an ordinary TypeScript generic
    /// — `const last = <T>(a: readonly T[]): T => …` — as a JSX tag. It then writes `.tsx`, the parser
    /// fails on `<T>`, and the file reports as a dead suite rather than a red test. That guess was wrong
    /// on 177 of 376 tests when the algorithm corpus moved onto its records.
    ///
    /// Additive and optional like every facet above, so a record written before the field round-trips
    /// unchanged and still falls back to the guess. It is carried here rather than inferred again in
    /// Rust because a SECOND inference is a second thing to disagree with the first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ext: Option<String>,
}

// ── EDGES (integration-tests-become-graph-edges) ─────────────────────────────────────────────────
//
// A test that reaches another app module is not a broken record test — it is a claim about the
// RELATIONSHIP between records. `composes` already says A builds on B; an edge is where the evidence
// that the relationship WORKS gets to live, instead of being deleted or forced onto one node it does
// not belong to.
//
// Edges are ADDITIVE to the document, in the same way every facet on `AlgoImpl` is: a store with none
// never gains an `edges` key, so existing seed JSON round-trips byte-identically.

/// One stored edge: the records it spans and the tests that verify them together.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct GraphEdge {
    /// Stable id — conventionally the members joined, but opaque to the store.
    pub id: String,
    /// The impl ids this edge spans. TWO OR MORE: an edge over one record is a record test and belongs
    /// on the node, which is the distinction `harvest` now enforces when it pairs.
    pub members: Vec<String>,
    /// PROVENANCE — the test file this was lifted from, root-relative and forward-slashed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    /// The tests that exercise the members together.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tests: Vec<AlgoImplTest>,
}

/// The edges of a graph document. READ-ONLY on purpose: unlike `ensure_array`, this never inserts the
/// key, so merely LOOKING at a store with no edges cannot add `"edges": []` to it.
pub fn edges_of(g: &Value) -> Vec<Value> {
    g.get("edges").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// Upsert an edge. Merging, exactly like [`set_impl`] (#4154): a supplied key overlays, a null removes,
/// and an unsupplied key is PRESERVED rather than silently deleted.
pub fn set_edge(g: &mut Value, e: Value) -> Result<bool, String> {
    let id = e
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("an edge needs a non-empty `id`")?
        .to_string();
    // An edge over fewer than two records is a RECORD test wearing the wrong shape. Accepting it would
    // reintroduce exactly what the isolation gate exists to keep off a node.
    //
    // Checked only when `members` is SUPPLIED — this is a merging write (#4154), so a later
    // `--src`-only update must not have to resupply the members it is not changing. Requiring them on
    // every write is the same destructive default that made a domain-only edit wipe an impl's folder.
    let supplied = e.get("members").and_then(Value::as_array);
    if let Some(members) = supplied {
        if members.len() < 2 {
            return Err("an edge needs at least two `members` — a test over ONE record belongs on that record".into());
        }
    }
    let is_new = !edges_of(g).iter().any(|x| x.get("id").and_then(Value::as_str) == Some(id.as_str()));
    if is_new && supplied.is_none() {
        return Err("a new edge needs `members` — the records it spans".into());
    }
    let arr = ensure_array(g, "edges");
    if let Some(existing) = arr.iter_mut().find(|x| x.get("id").and_then(Value::as_str) == Some(id.as_str())) {
        match (existing.as_object_mut(), e.as_object()) {
            (Some(dst), Some(src)) => {
                for (k, v) in src {
                    if v.is_null() {
                        dst.remove(k);
                    } else {
                        dst.insert(k.clone(), v.clone());
                    }
                }
            }
            _ => *existing = e,
        }
        Ok(true)
    } else {
        arr.push(e);
        Ok(false)
    }
}

/// Delete an edge by id. Returns whether one was removed.
pub fn remove_edge(g: &mut Value, id: &str) -> bool {
    let Some(arr) = g.get_mut("edges").and_then(Value::as_array_mut) else {
        return false;
    };
    let before = arr.len();
    arr.retain(|x| x.get("id").and_then(Value::as_str) != Some(id));
    before != arr.len()
}

/// Which `composes` relations have NO edge covering them, which edges name a record that is GONE, and
/// which name a specifier no record provides YET. Returned as `(missing, dangling, pending)`.
///
/// A dangling edge is reported separately and deliberately: a MISSING edge is honestly empty, while a
/// dangling one reads as covered — the worse of the two failures.
pub fn edge_findings(g: &Value) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
    let impls = implementations_of(g);
    let known: std::collections::HashSet<String> = impls
        .iter()
        .filter_map(|im| im.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    // A PRIMITIVE is a language built-in DESCRIBED via `ref`, never re-coded (#2972) — "quicksort uses
    // Vec" is not a relationship anyone can write evidence for. Counting those would report 46 gaps on
    // the current library where only a handful are real, and a doctor that cries wolf is one nobody runs.
    let primitives: std::collections::HashSet<String> = impls
        .iter()
        .filter(|im| im.get("role").and_then(Value::as_str) == Some("primitive"))
        .filter_map(|im| im.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    // What the records currently PROVIDE — how a specifier-shaped member resolves.
    let provided: std::collections::HashSet<String> = impls
        .iter()
        .filter_map(|im| im.get("provides").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let edges = edges_of(g);
    // Every unordered pair some edge spans.
    let mut covered: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    let mut dangling = Vec::new();
    let mut pending = Vec::new();
    for e in &edges {
        let members: Vec<String> = e
            .get("members")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|m| m.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        // A member is either a RECORD ID or a `@/…` SPECIFIER, and the difference is the whole point.
        //
        //   pending  — a specifier no record provides YET. An edge is written when a module RETIRES,
        //              and its collaborators are usually still files at that moment, so this is the
        //              migration not having reached them: expected, honest, not an error.
        //   dangling — a bare record id that does not exist. A record was REMOVED and the edge still
        //              claims to cover it, which reads as covered while covering nothing.
        //
        // Collapsing the two would make doctor either cry wolf or go silent — the same mistake as
        // counting primitive relations, which reported 46 findings where exactly 1 was real.
        let mut unresolved = Vec::new();
        let mut not_yet = Vec::new();
        for m in &members {
            if let Some(spec) = m.strip_prefix("@/") {
                let _ = spec;
                if !provided.contains(m) {
                    not_yet.push(m.clone());
                }
            } else if !known.contains(m) {
                unresolved.push(m.clone());
            }
        }
        if !unresolved.is_empty() {
            dangling.push(serde_json::json!({
                "edge": e.get("id").and_then(Value::as_str).unwrap_or(""),
                "unknownMembers": unresolved,
            }));
        }
        if !not_yet.is_empty() {
            pending.push(serde_json::json!({
                "edge": e.get("id").and_then(Value::as_str).unwrap_or(""),
                "pendingMembers": not_yet,
            }));
        }
        for i in 0..members.len() {
            for j in (i + 1)..members.len() {
                covered.insert(pair(&members[i], &members[j]));
            }
        }
    }
    let mut missing = Vec::new();
    for im in &impls {
        let Some(from) = im.get("id").and_then(Value::as_str) else { continue };
        for to in im.get("composes").and_then(Value::as_array).into_iter().flatten() {
            let Some(to) = to.as_str() else { continue };
            // A composes pointing at a record that does not exist is `doctor`'s existing business, not
            // an edge gap — reporting it here would blame the edge tier for a node-tier problem.
            if !known.contains(to) || primitives.contains(to) || covered.contains(&pair(from, to)) {
                continue;
            }
            missing.push(serde_json::json!({ "from": from, "to": to }));
        }
    }
    (missing, dangling, pending)
}

/// Unordered pair key — an edge A↔B covers B↔A.
fn pair(a: &str, b: &str) -> (String, String) {
    if a <= b { (a.to_string(), b.to_string()) } else { (b.to_string(), a.to_string()) }
}

/// The implementation objects of the runtime graph (store-or-seed).
pub fn implementations() -> Vec<Value> {
    implementations_of(&load())
}

/// The implementation objects of `g`.
///
/// Suppression does NOT live here. The first cut parked a `{ id, suppressed: true }` tombstone inside
/// this array — borrowing the component store's trick, where occupying the id is what makes the seed
/// reconcile skip the packaged record — and filtered it out in this one function, on the reasoning that
/// every read funnels through here. That was true of RUST. The frontend reads the same JSON directly
/// and had never heard of `suppressed`, so the Algorithms graph iterated a tombstone, called `.join` on
/// its missing `composes`, and died on render.
///
/// The lesson is about SHAPE, not about a missing filter: a record parked in an array of
/// implementations will eventually be read by something that does not know to skip it, and the next
/// such reader is as likely to be a chart or an export as a page. So the list below is the only place
/// suppression exists, and this array holds implementations and nothing else.
pub fn implementations_of(g: &Value) -> Vec<Value> {
    g.get("implementations").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// The suppression list — retired ids the seed reconcile must not re-add, each with what replaced it.
pub fn suppressions_of(g: &Value) -> Vec<Value> {
    g.get("suppressed").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// Is `id` retired?
pub fn is_suppressed(g: &Value, id: &str) -> bool {
    suppressions_of(g).iter().any(|t| t.get("id").and_then(Value::as_str) == Some(id))
}

/// What retired `id`, if anything did — the tombstone's `supersededBy`.
pub fn superseded_by(g: &Value, id: &str) -> Option<String> {
    suppressions_of(g)
        .iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|t| t.get("supersededBy").and_then(Value::as_str).map(str::to_owned))
        .filter(|s| !s.trim().is_empty())
}

/// Record `id` as retired, carrying what replaced it. IDEMPOTENT — returns whether it was NEW.
///
/// Retiring an already-retired id must not append a second tombstone. The live store proved this is
/// not theoretical: it carried FOUR entries for TWO ids (`llm-energy.ts` and `stream-merge.ts` each
/// twice), because the reporter of designer request #77 ran the same merge again after the record
/// came back. Duplicates are harmless to the reconcile — which only asks whether an id is in the
/// list — but a list that grows on every retry cannot be read as a history of retirements.
///
/// An existing entry KEEPS its `supersededBy` unless this call supplies one: re-retiring without a
/// pointer must not erase the pointer an earlier retirement recorded.
pub fn add_suppression(g: &mut Value, id: &str, superseded_by: Option<&str>) -> bool {
    let arr = ensure_array(g, "suppressed");
    if let Some(existing) = arr.iter_mut().find(|t| t.get("id").and_then(Value::as_str) == Some(id)) {
        if let Some(b) = superseded_by {
            existing["supersededBy"] = Value::String(b.to_string());
        }
        return false;
    }
    let mut entry = serde_json::json!({ "id": id });
    if let Some(b) = superseded_by {
        entry["supersededBy"] = Value::String(b.to_string());
    }
    arr.push(entry);
    true
}

/// Collapse duplicate tombstones to one per id. Runs on load beside [`migrate_inline_tombstones`], so
/// a store that already accumulated them self-repairs rather than carrying them forever — the live
/// store has four entries for two ids right now. Returns whether it changed `g`.
pub fn dedupe_suppressions(g: &mut Value) -> bool {
    // Collect each id's pointer BEFORE pruning: the copy that carries `supersededBy` is not
    // necessarily the first one, and dropping it would lose WHAT replaced the record — the only
    // thing a tombstone knows that a plain delete would not.
    let mut pointer: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    for t in suppressions_of(g) {
        if let (Some(id), Some(b)) = (
            t.get("id").and_then(Value::as_str),
            t.get("supersededBy").and_then(Value::as_str).filter(|s| !s.trim().is_empty()),
        ) {
            pointer.entry(id.to_string()).or_insert_with(|| b.to_string());
        }
    }
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let arr = ensure_array(g, "suppressed");
    let before = arr.len();
    arr.retain(|t| match t.get("id").and_then(Value::as_str) {
        Some(id) => seen.insert(id.to_string()),
        // An entry with no id can never be matched by the reconcile — it is noise either way.
        None => false,
    });
    for t in arr.iter_mut() {
        let Some(id) = t.get("id").and_then(Value::as_str).map(str::to_owned) else { continue };
        if t.get("supersededBy").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).is_none() {
            if let Some(b) = pointer.get(&id) {
                t["supersededBy"] = Value::String(b.clone());
            }
        }
    }
    arr.len() != before
}

/// Sweep any LEGACY in-array tombstone into the suppression list. Runs on load, so a store written by
/// the first cut heals itself without anyone running a command — two of them are already in a live
/// store, and one of them is what crashed the graph.
pub fn migrate_inline_tombstones(g: &mut Value) -> bool {
    let inline: Vec<Value> = implementations_of(g)
        .into_iter()
        .filter(|im| im.get("suppressed").and_then(Value::as_bool) == Some(true))
        .collect();
    if inline.is_empty() {
        return false;
    }
    for t in &inline {
        if let Some(id) = t.get("id").and_then(Value::as_str) {
            let known = is_suppressed(g, id);
            if !known {
                let mut entry = serde_json::Map::new();
                entry.insert("id".into(), Value::from(id));
                if let Some(sb) = t.get("supersededBy") {
                    entry.insert("supersededBy".into(), sb.clone());
                }
                ensure_array(g, "suppressed").push(Value::Object(entry));
            }
        }
    }
    let ids: std::collections::BTreeSet<String> = inline
        .iter()
        .filter_map(|t| t.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    ensure_array(g, "implementations")
        .retain(|im| !im.get("id").and_then(Value::as_str).is_some_and(|id| ids.contains(id)));
    true
}

/// Whether `im` belongs to `domain` (#3120) — the predicate behind `bsc graph impl list --domain`. An
/// impl with no `domain` never matches, so the filter is purely additive (it hides only the untagged).
pub fn impl_in_domain(im: &Value, domain: &str) -> bool {
    im.get("domain").and_then(Value::as_str) == Some(domain)
}

/// Whether `im` carries EVERY tag in `want` — the predicate behind `bsc graph impl list --tags a,b`
/// (`the-graphs-cannot-be-searched-by-the-axes-they-store`).
///
/// AND, not OR, and that is the whole point of the flag. A worker reaches for a tag search to NARROW
/// ("the sorting algorithms that are also stable"); a union would widen with each extra term, which is
/// the opposite of what naming a second tag means. `--domain` and `--feature` compose with this the
/// same way — every filter on the list verb intersects.
///
/// An EMPTY `want` matches everything, so an absent `--tags` is not a filter. That is what makes the
/// flag additive rather than a mode: `impl list` and `impl list --tags ""` are the same read.
///
/// A record with no `tags` matches only when nothing was asked for — the same purely-additive rule
/// [`impl_in_domain`] follows, so an untagged record is hidden by a tag search rather than swept in.
pub fn impl_has_every_tag(im: &Value, want: &[&str]) -> bool {
    if want.is_empty() {
        return true;
    }
    let Some(have) = im.get("tags").and_then(Value::as_array) else {
        return false;
    };
    want.iter().all(|w| have.iter().filter_map(Value::as_str).any(|h| h == *w))
}

/// Every tag in the store with the number of implementations carrying it, most-used first and ties
/// broken alphabetically so the output is stable across runs.
///
/// THE SEARCH IS USELESS WITHOUT THIS. An agent cannot filter by a tag it has no way to discover, and
/// nothing else answers "what tags exist" — `dump` returns 11 MB to find out. Ordering by count puts
/// the vocabulary's real spine first; sorting ties by name keeps a diff between two runs meaningful.
pub fn tag_census(impls: &[Value]) -> Vec<(String, usize)> {
    let mut counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for im in impls {
        for t in im.get("tags").and_then(Value::as_array).into_iter().flatten() {
            if let Some(t) = t.as_str().map(str::trim).filter(|t| !t.is_empty()) {
                *counts.entry(t.to_string()).or_default() += 1;
            }
        }
    }
    let mut out: Vec<(String, usize)> = counts.into_iter().collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out
}

// ── mutators (#2853) — pure over `&mut` the graph document; the CLI does load → mutate → save ──

/// The `key` array of `g`, created empty if absent/mistyped, as a mutable Vec.
fn ensure_array<'a>(g: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    if !g.get(key).map(Value::is_array).unwrap_or(false) {
        if let Some(obj) = g.as_object_mut() {
            obj.insert(key.to_string(), Value::Array(Vec::new()));
        }
    }
    g.get_mut(key).and_then(Value::as_array_mut).expect("array ensured above")
}

/// Upsert an implementation by id (#2863) — a language-kit node (`primitive` | `algorithm`, with
/// `code` + `composes`). Validates a non-empty `id` + `tech` and a known `role`. Returns `true` when it
/// replaced an existing impl, `false` when it inserted a new one.
/// The platform manifest — the SAME file `bsc_component::graph_health` embeds.
///
/// Read here rather than called there because `bsc-component` already depends on THIS crate, so the
/// reverse would be a cycle. The duplication is of the EMBED, not of a rule: both read
/// `src-tauri/data/ui/platform-modules.json`, so neither can drift from the source of truth — only
/// from each other's caching, which is why this is a plain set lookup with no interpretation.
fn platform_modules_json() -> &'static str {
    static CELL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CELL.get_or_init(|| bsc_util::packaged::read_required("ui/platform-modules.json"))
}

/// Is `spec` bound to a LIVE platform module at runtime (`registerAppModule`)?
///
/// Public so the COMPONENT store can apply the same refusal — it holds records that `provides` the
/// very same specifiers, and duplicating the manifest lookup there would let the two drift.
pub fn is_registered_platform_module(spec: &str) -> bool {
    static M: std::sync::OnceLock<std::collections::BTreeSet<String>> = std::sync::OnceLock::new();
    M.get_or_init(|| {
        serde_json::from_str::<Vec<String>>(platform_modules_json()).unwrap_or_default().into_iter().collect()
    })
    .contains(spec)
}

/// Upsert an implementation with no explicit author — every pre-#72 caller and test. Attributed to
/// `unknown`, exactly as the component store attributes an unattributed write, rather than inventing a
/// plausible-looking author.
pub fn set_impl(g: &mut Value, im: Value) -> Result<bool, String> {
    set_impl_by(g, im, "unknown", None)
}

/// The record's current `rev`, or 0 when it is absent from the store — the same
/// "absent reads as rev 0" contract [`bsc_record::read_rev`] gives a record with no stamp.
///
/// So `--if-version 0` is the correct guard for a record that has never been written since #72, and
/// for one that does not exist yet. That is why the 695 records carrying no stamp need no backfill to
/// be safe under optimistic concurrency: they already answer 0, and a guard reading 0 is telling the
/// truth about them.
pub fn impl_rev(g: &Value, id: &str) -> i64 {
    implementations_of(g)
        .iter()
        .find(|x| x.get("id").and_then(Value::as_str) == Some(id))
        .map(bsc_record::read_rev)
        .unwrap_or(0)
}

/// Upsert an implementation, refusing the write when the record has MOVED ON since the caller read it
/// (optimistic concurrency, mirroring `bsc ui set --if-version`).
///
/// This is the guard the algorithms store did not have. The component store has had it since #3164 —
/// 27 call sites — while `bsc graph` had none, and the algorithms store is the one a librarian session
/// writes LIVE, in a single 13.7 MB JSON document with no transaction and no rollback. The sixteen
/// hand-made `algorithms.json.bak-*` files beside it are what that absence cost: a human snapshotting
/// the store before every bulk edit, because nothing else could refuse a stale overwrite.
///
/// `if_version: None` is the unguarded write every existing caller already makes — the guard is opt-in,
/// exactly as it is for components, so this adds a capability without changing a single existing path.
pub fn set_impl_versioned(
    g: &mut Value,
    im: Value,
    writer: &str,
    note: Option<&str>,
    if_version: Option<i64>,
) -> Result<bool, String> {
    if let Some(n) = if_version {
        let id = im
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .ok_or("an implementation needs a non-empty `id`")?;
        let prior_rev = impl_rev(g, id);
        if prior_rev != n {
            return Err(format!(
                "version conflict on implementation '{id}': its current rev is {prior_rev}, not {n} — \
                 it changed since you read it. Re-read (`bsc graph impl history {id}`) and retry."
            ));
        }
    }
    set_impl_by(g, im, writer, note)
}

/// Upsert an implementation, STAMPING the write with its author, timestamp, rev and history (#72).
///
/// `writer` is who to attribute it to (`--by`, else the resolved default) and `note` is the optional
/// why. Both ride to `bsc-record`, the one stamp shared with the component store.
pub fn set_impl_by(g: &mut Value, im: Value, writer: &str, note: Option<&str>) -> Result<bool, String> {
    let id = im
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("an implementation needs a non-empty `id`")?
        .to_string();
    // A RETIRED id is refused here, not merely kept out of the seed reconcile (#77, designer request).
    //
    // The tombstone used to guard exactly one path — `reconcile_seed` — and `is_suppressed` was
    // consulted in exactly one place, the `unsuppress` verb. Nothing checked it on the way IN, so
    // every authoring path (`impl set`, `harvest --apply`, `curate --apply`) wrote a retired record
    // straight back while its tombstone sat untouched beside it. That is what was reported as the
    // tombstone "not being durable": two ids were merged away, confirmed gone, verified across a
    // fresh doctor run, and reappeared later in the same session — because a second harvest pass
    // re-authored them. They came back with no history, which is what a fresh write looks like, so
    // the reconcile took the blame for something it never did.
    //
    // Refusing at the single write path is what makes retirement mean the same thing to every caller,
    // including ones not written yet. `unsuppress` stays the one deliberate way back.
    if is_suppressed(g, &id) {
        let by = superseded_by(g, &id)
            .map(|b| format!(", superseded by '{b}'"))
            .unwrap_or_default();
        return Err(format!(
            "'{id}' is RETIRED{by} — refusing to re-author it. A tombstone means the id was folded \
             away on purpose, so writing it back would silently undo that (it is how a re-harvest \
             resurrected two records after they were merged, #77). Write the record that superseded \
             it, or run `bsc graph impl unsuppress {id}` first if the retirement was wrong."
        ));
    }
    im.get("tech")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("an implementation needs a `tech` (the language kit)")?;
    let role = im.get("role").and_then(Value::as_str).ok_or("an implementation needs a `role`")?;
    if !ROLES.contains(&role) {
        return Err(format!("unknown role '{role}' — want one of: {}", ROLES.join(" | ")));
    }
    // A record must never claim a specifier that a LIVE platform module already owns while holding
    // module state. `resolveGraphSource` checks records BEFORE the platform registry, so such a record
    // WINS: a graph consumer gets this source vendored instead of the running module, and a module
    // holding state becomes a SECOND instance whose divergence is silent — unlike a broken override,
    // which declines and falls back, a stateful shadow works, just against the wrong copy.
    //
    // Pure shadows are fine and deliberately allowed: same code, same behaviour, so which copy wins
    // does not matter. Only STATE makes the identity load-bearing.
    if let Some(spec) = im.get("provides").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        let state: Vec<String> = im
            .get("moduleState")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        if !state.is_empty() && is_registered_platform_module(spec) {
            return Err(format!(
                "'{id}' cannot provide `{spec}`: that specifier is a REGISTERED platform module, and this                  record holds module state ({}). A record wins over the registry, so this would vendor a                  SECOND copy of that state to every graph consumer. Drop the `provides` (the record stays                  for provenance), or move the state out of the module.",
                state.join(", ")
            ));
        }
    }
    let now = bsc_record::now_iso();
    let arr = ensure_array(g, "implementations");
    if let Some(existing) = arr.iter_mut().find(|x| x.get("id").and_then(Value::as_str) == Some(id.as_str())) {
        // The pre-write value, cloned BEFORE the merge mutates it — the stamp diffs the two.
        let prior = existing.clone();
        // MERGE, never replace (#4154). This was `*existing = im`, a whole-record overwrite — so any
        // field the caller did not resupply was SILENTLY DELETED. The designer hit it twice: a
        // domain-only edit wiped `transpose.ts`'s `folder` and `src` (request #49), and `tests` has no
        // flag at all so every write dropped it, which stalled a reorg across 16 entries carrying real
        // vitest suites (request #50). It also explains provenance vanishing from the live store during
        // a concurrent librarian session while a backfill was running.
        //
        // Overlaying only the supplied keys makes a write additive: `--domain x` changes the domain and
        // nothing else. Removing a value is now explicit — see `--clear` in the CLI — because a merge
        // otherwise makes deletion impossible.
        match (existing.as_object_mut(), im.as_object()) {
            (Some(dst), Some(src)) => {
                for (k, v) in src {
                    // A NULL means "remove this field" — how `--clear` expresses a deletion that a
                    // merging write can no longer express by omission.
                    if v.is_null() {
                        dst.remove(k);
                    } else {
                        dst.insert(k.clone(), v.clone());
                    }
                }
            }
            // A non-object on either side cannot be merged field-wise; replacing is the honest fallback
            // rather than silently keeping a malformed record.
            _ => *existing = im,
        }
        // #72 — STAMP the write. `bsc graph impl set` recorded nothing: no rev, no author, no timestamp,
        // no history, so a bad write was both unattributable and unrevertible, and a session hunting
        // *who* kept recreating a node had nothing to read. Stamped through the SAME `bsc-record` the
        // component store uses, so `bsc graph impl history` and `bsc ui log` mean the same thing rather
        // than being two dialects that drift.
        //
        // Stamped from the PRIOR value, after the merge: the entry's `changed` set is the diff, so it
        // must see both sides. `prevCode` (the revert rung) is retained by the same rule `prevSrc` uses.
        bsc_record::stamp_with_history_of(existing, &prior, writer, &now, note, "code");
        Ok(true)
    } else {
        // A NEW impl still needs the shape the model expects: `composes` is a required array, and the
        // CLI now omits it unless `--composes` was given (so an edit cannot blank it).
        let mut im = im;
        if im.get("composes").is_none() {
            im["composes"] = Value::Array(Vec::new());
        }
        // A CREATE is stamped too, against a null prior — so rev 1 exists and `history` is never absent.
        // A record whose log starts at its second write reads as if the first never happened.
        bsc_record::stamp_with_history_of(&mut im, &Value::Null, writer, &now, note, "code");
        arr.push(im);
        Ok(false)
    }
}

/// Remove an implementation by id (#2863) and scrub the id from every other impl's `composes`. Returns
/// whether it existed.
pub fn remove_impl(g: &mut Value, id: &str) -> bool {
    remove_impl_by(g, id, "unknown")
}

/// [`remove_impl`], attributed — `writer` lands on the history entry of every record whose `composes`
/// the scrub edited.
///
/// The scrub is a write to records the caller never named. Leaving it unstamped meant a record's
/// dependency list could lose an entry with nothing in `bsc graph impl history` to say who did it or
/// when — the same hole `merge_impls` had, from the same cause (the #3164 provenance layer arrived for
/// this store only in #72, and the removal paths were never revisited).
pub fn remove_impl_by(g: &mut Value, id: &str, writer: &str) -> bool {
    let existed = {
        let arr = ensure_array(g, "implementations");
        let before = arr.len();
        arr.retain(|x| x.get("id").and_then(Value::as_str) != Some(id));
        arr.len() != before
    };
    if !existed {
        return false;
    }
    let now = bsc_record::now_iso();
    let note = format!("remove: scrub composes reference to '{id}'");
    for im in ensure_array(g, "implementations").iter_mut() {
        let Some(list) = im.get("composes").and_then(Value::as_array) else { continue };
        if !list.iter().any(|v| v.as_str() == Some(id)) {
            continue; // this record never referenced it — a stamp here would be a write that did not happen
        }
        let prior = im.clone();
        if let Some(list) = im.get_mut("composes").and_then(Value::as_array_mut) {
            list.retain(|v| v.as_str() != Some(id));
        }
        bsc_record::stamp_with_history_of(im, &prior, writer, &now, Some(&note), "code");
    }
    true
}

// ── optimize (#3594) — the measure + combine mirror of the component graph (#3584/#3592) ──

/// The composes-INVERSE (#3594): implementation id → the ids of implementations that list it in
/// `composes` (sorted + deduped). The algorithm graph's USAGE signal — how load-bearing an impl is —
/// keyed by id (algorithms compose by id; there are no kits, unlike the component graph). Computed live
/// from the graph, so it is never a placeholder. The measure step a `merge` decision reads.
pub fn used_by_index(g: &Value) -> std::collections::BTreeMap<String, Vec<String>> {
    let mut idx: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    for im in implementations_of(g) {
        let Some(consumer) = im.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) else { continue };
        for dep in im.get("composes").and_then(Value::as_array).into_iter().flatten() {
            if let Some(dep_id) = dep.as_str().filter(|s| !s.is_empty()) {
                idx.entry(dep_id.to_string()).or_default().push(consumer.to_string());
            }
        }
    }
    for consumers in idx.values_mut() {
        consumers.sort();
        consumers.dedup();
    }
    idx
}

/// Fold implementation `from` INTO `into` (#3594) — the combine ACT that mirrors `bsc ui merge`: repoint
/// every impl's `composes` from→into (deduped; a self-reference the fold would create is dropped), then
/// remove `from`. `into` stays authoritative. Returns the ids of the impls whose `composes` were
/// repointed. Errs on a self-merge or an absent id.
///
/// Every repointed record is STAMPED. This used to carry "No history stamp — the graph store has no
/// #3164 provenance layer (unlike the component store)", which #72 made false: the layer exists and
/// `set_impl_by` uses it. The comment outliving the gap is how a merge went on silently editing other
/// people's records — a `composes` list changed underneath a record whose owner never wrote it, and
/// `bsc graph impl history` showed nothing, so the edit was unattributable and unrevertible. A merge
/// touches records the caller did not name, which makes it MORE in need of a trail than an ordinary
/// write, not less.
pub fn merge_impls(g: &mut Value, from: &str, into: &str) -> Result<Vec<String>, String> {
    merge_impls_by(g, from, into, "unknown")
}

/// [`merge_impls`], attributed. `writer` lands on every repointed record's history entry.
pub fn merge_impls_by(g: &mut Value, from: &str, into: &str, writer: &str) -> Result<Vec<String>, String> {
    if from == into {
        return Err(format!("cannot merge '{from}' into itself"));
    }
    let ids: std::collections::BTreeSet<String> = implementations_of(g)
        .iter()
        .filter_map(|im| im.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    if !ids.contains(from) {
        return Err(format!("unknown implementation '{from}'"));
    }
    if !ids.contains(into) {
        return Err(format!("unknown implementation '{into}'"));
    }
    let mut repointed = Vec::new();
    // The pre-repoint `composes` of every record the fold edits, keyed by id — the honest `prior` the
    // stamp below diffs against. Captured HERE because after the loop the old value is gone, and a
    // reconstructed prior would put a guess in the history where a fact belongs.
    let mut prior_composes: std::collections::BTreeMap<String, Value> = std::collections::BTreeMap::new();
    for im in ensure_array(g, "implementations").iter_mut() {
        let own_id = im.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if own_id == from {
            continue; // being removed
        }
        let was = im.get("composes").cloned();
        if let Some(list) = im.get_mut("composes").and_then(Value::as_array_mut) {
            let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
            let mut next: Vec<Value> = Vec::with_capacity(list.len());
            let mut any = false;
            for v in list.iter() {
                let Some(orig) = v.as_str() else { continue };
                let mapped = if orig == from { into } else { orig };
                if orig == from {
                    any = true;
                }
                // Drop a self-reference the fold would create, and dedup (a consumer of BOTH from and into
                // must not end up composing into twice).
                if mapped == own_id || !seen.insert(mapped.to_string()) {
                    any = true;
                    continue;
                }
                next.push(Value::String(mapped.to_string()));
            }
            if any {
                *list = next;
                if let Some(w) = was {
                    prior_composes.insert(own_id.clone(), w);
                }
                repointed.push(own_id);
            }
        }
    }
    // Stamp every record the fold edited. Done in a SECOND pass, not inside the borrow above, because
    // the stamp diffs a prior against a next and the loop above already holds `composes` mutably.
    {
        let now = bsc_record::now_iso();
        let note = format!("merge: repoint composes '{from}' -> '{into}'");
        for im in ensure_array(g, "implementations").iter_mut() {
            let own_id = im.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let Some(was) = prior_composes.get(&own_id) else { continue };
            // The real pre-repoint record: this one with its ORIGINAL `composes` put back, so the
            // entry's `changed` set is a diff of what actually happened.
            let mut prior = im.clone();
            if let Some(o) = prior.as_object_mut() {
                o.insert("composes".into(), was.clone());
            }
            bsc_record::stamp_with_history_of(im, &prior, writer, &now, Some(&note), "code");
        }
    }
    // RETIRE `from`. A plain remove is only durable for a USER-MADE impl: the seed reconcile re-adds any
    // packaged id the store lacks, by design (it is what makes packaged algorithms recoverable), so
    // removing a seeded impl silently undid itself and `merge` still reported `"removed"` — the defect
    // behind request #71, which cost a session an afternoon hunting a phantom re-harvester.
    //
    // So a seeded `from` becomes a TOMBSTONE instead, carrying WHAT replaced it. The reconcile finds the
    // id present and leaves it alone, and the fold is finally durable. `supersededBy` is set without the
    // `suppress` verb's dangling-pointer checks because `into` was validated above — it is an impl in
    // this very store, and the merge just repointed every consumer at it.
    if is_seeded(from) {
        remove_impl(g, from);
        // Idempotent (#77): running the same merge twice must not leave two tombstones for one id.
        add_suppression(g, from, Some(into));
    } else {
        remove_impl(g, from); // its refs are already repointed; the scrub is a harmless no-op
    }
    Ok(repointed)
}

/// Is `id` in the PACKAGED seed — i.e. would [`reconcile_seed`] re-add it after a plain remove?
///
/// The seeded/user-made split is the whole reason retirement needs two mechanisms, and it is not
/// something a caller can infer from the record it holds: a seeded impl and a harvested one look
/// identical in the store.
pub fn is_seeded(id: &str) -> bool {
    implementations_of(&seed())
        .iter()
        .any(|im| im.get("id").and_then(Value::as_str) == Some(id))
}

// ── the doctor (#3212) — diagnose visualization typing + coverage ──

/// The known manipulation kinds — MUST match the frontend `ALGO_KINDS` (`src/features/algorithms/lib/
/// knowledge.ts`). A kind outside this set is `invalid-kind`.
pub const KINDS: [&str; 5] = ["sort", "search", "traversal", "accumulate", "transform"];

/// The base-name viz PROGRAMS that exist in-app today — MUST mirror the frontend registry's `EXAMPLE_BY_KEY`
/// keys EXACTLY (`TRACE_PROGRAMS` + `MATRIX_PROGRAMS` + `GRAPH_PROGRAMS` in `viz/examples/`). An algorithm
/// whose base name is here animates even without stored `vizCode`; one that is NOT here (e.g. `fibonacci`)
/// has no visualization and is reported `missing-viz`. NOTE the generic `sort` IS here — `TRACE_PROGRAMS`
/// has a (unquoted) `sort:` entry mapping to insertion sort, so `sort.ts` animates in-app (its omission
/// here made the doctor false-positive `sort.ts` as missing-viz, #3237). As #3230 moves visualizations to
/// persisted `vizCode`, this list shrinks toward empty.
pub const VIZ_PROGRAMS: [&str; 14] = [
    "bubble-sort", "insertion-sort", "quick-sort", "heap-sort", "merge-sort", "sort", // array sorts
    "transpose", "rotate", "reflect", // matrix transforms
    "bfs", "dfs", "dijkstra", "a-star", "topological-sort", // graph traversals
];

/// Normalize an impl id to its base-algorithm key — MUST mirror the frontend `programKey`: strip the
/// extension, lowercase, unify separators (`merge-sort.rs` / `merge_sort` → `merge-sort`).
pub fn base_name(id: &str) -> String {
    let stem = id.rsplit_once('.').map_or(id, |(s, _)| s);
    stem.to_lowercase().replace([' ', '_'], "-")
}

/// The heuristic kind classifier — MUST mirror the frontend `classifyKind` (name/id/tags, then a light
/// code hint). Ordered so ambiguous names disambiguate; `None` when nothing matches.
pub fn classify_kind(im: &Value) -> Option<&'static str> {
    let field = |k: &str| im.get(k).and_then(Value::as_str).unwrap_or("");
    let tags = im
        .get("tags")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    let hay = format!("{} {} {}", field("name"), field("id"), tags).to_lowercase();
    let has = |ws: &[&str]| ws.iter().any(|w| hay.contains(w));
    if has(&["bfs", "dfs", "traverse", "traversal", "walk", "breadth-first", "depth-first"]) {
        return Some("traversal");
    }
    if has(&["sort"]) {
        return Some("sort");
    }
    if has(&["transpose", "rotate", "reflect", "transform", "flip", "mirror"]) {
        return Some("transform");
    }
    if has(&["search", "find", "lookup", "bisect"]) {
        return Some("search");
    }
    if has(&["fib", "factorial", "prefix-sum", "prefixsum", "accumulate", "cumulative", "reduce", "scan"]) {
        return Some("accumulate");
    }
    // A light code-pattern fallback for un-obvious names.
    let code = field("code").to_lowercase();
    if code.contains("mid") && (code.contains("lo") || code.contains("hi")) {
        return Some("search");
    }
    if code.contains("swap") {
        return Some("sort");
    }
    None
}

/// A doctor finding (#3212). `category` is one of `untyped` | `invalid-kind` | `mistyped` | `missing-viz`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Finding {
    pub id: String,
    pub category: &'static str,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

/// Diagnose the algorithm library's visualization typing + coverage (#3212). Reports each ALGORITHM (not
/// primitives) that is `untyped` (no `kind`), carries an `invalid-kind` or a likely-`mistyped` one, or has
/// `missing-viz` (no `vizCode` AND no in-app program). Pure over the graph.
pub fn doctor(g: &Value) -> Vec<Finding> {
    doctor_with_entities(g, &[])
}

/// [`doctor`], plus the DATA-GRAPH surface check when the entity ids are supplied
/// (the-data-graph-a-global-third-pillar).
///
/// A node declares the entities it reads or writes; this is what holds it to the declaration. A name
/// that matches no entity is reported — a surface restriction nothing verifies is a comment, and the
/// failure it invites is the worst kind: a node believed to be bounded that is not.
///
/// `entities` empty means the caller did not open the data graph, and the check is SKIPPED rather
/// than failing every declaration — the same shape the provides-set uses when no store is open.
pub fn doctor_with_entities(g: &Value, entities: &[String]) -> Vec<Finding> {
    let mut out = Vec::new();
    // AN ID THAT IS BOTH LIVE AND RETIRED — the residue of the resurrection bug (#77).
    //
    // The guard in `set_impl_by` stops this from being CREATED, but stores already carry it: at the
    // time that fix was written the live store held `llm-energy.ts` and `stream-merge.ts` in
    // `implementations` AND in `suppressed` at the same time. Nothing could see that, which is how it
    // survived two rounds of someone actively looking for it.
    //
    // REPORTED, NEVER AUTO-RESOLVED. Dropping the record would discard whatever was written into it
    // since; dropping the tombstone would discard a deliberate retirement. Both are destructive and
    // only the operator knows which one is the mistake — so this names the contradiction and the two
    // verbs that settle it.
    for im in implementations_of(g) {
        let Some(id) = im.get("id").and_then(Value::as_str) else { continue };
        if !is_suppressed(g, id) {
            continue;
        }
        let by = superseded_by(g, id)
            .map(|b| format!(" (superseded by `{b}`)"))
            .unwrap_or_default();
        out.push(Finding {
            id: id.to_string(),
            category: "retired-but-live",
            detail: format!(
                "`{id}` is RETIRED{by} yet still present as a live implementation — it was re-authored \
                 after being folded away, which is the resurrection #77 fixed at the write path"
            ),
            suggestion: Some(format!(
                "keep the retirement: `bsc graph impl remove {id}` — or reverse it: \
                 `bsc graph impl unsuppress {id}`. Not auto-resolved: one discards the record, the \
                 other discards the decision to retire it"
            )),
        });
    }
    if !entities.is_empty() {
        for im in implementations_of(g) {
            let id = im.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            for key in ["reads", "writes"] {
                for name in im.get(key).and_then(Value::as_array).into_iter().flatten() {
                    let Some(n) = name.as_str() else { continue };
                    if !entities.iter().any(|e| e == n) {
                        out.push(Finding {
                            id: id.clone(),
                            category: "unknown-entity",
                            detail: format!("`{key}` names `{n}`, which is not an entity in the data graph"),
                            suggestion: Some(format!(
                                "create it (`bsc data entity set`) or correct the `--{key}` declaration"
                            )),
                        });
                    }
                }
            }
        }
    }
    // MIS-ROLED TEST (`a-test-only-module-is-not-an-algorithm`). The stored `role` is the definition;
    // this is the DETECTOR for it disagreeing with the declaration the record carries. It is the shape
    // `migrate-crate` left two records in by hardcoding `--role algorithm` for every module it lifted,
    // and the shape a hand edit to `moduleAttrs` can put a record back into.
    for im in implementations_of(g) {
        if im.get("role").and_then(Value::as_str) == Some("algorithm") && module_is_cfg_test(&im) {
            let id = im.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            out.push(Finding {
                id: id.clone(),
                category: "mis-roled-test",
                detail: "declared `#[cfg(test)]` — the module is in no production build — yet the record \
                         claims `role: algorithm`, so every survey and ranking counts it as production logic"
                    .into(),
                suggestion: Some(format!("`bsc graph impl set --id {id} --role test` (with its `--tech` and `--name`)")),
            });
        }
    }
    for im in implementations_of(g) {
        if im.get("role").and_then(Value::as_str) != Some("algorithm") {
            // A primitive DESCRIBES a built-in and a test CHECKS other records — neither has a
            // manipulation kind or anything to visualize, so the diagnostics below do not apply.
            continue;
        }
        let id = im.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let inferred = classify_kind(&im);
        match im.get("kind").and_then(Value::as_str) {
            None => out.push(Finding {
                id: id.clone(),
                category: "untyped",
                detail: "no `kind` assigned".into(),
                suggestion: inferred.map(|k| format!("looks like `{k}` — `bsc graph doctor --fix` or `impl set --kind {k}`")),
            }),
            Some(k) if !KINDS.contains(&k) => out.push(Finding {
                id: id.clone(),
                category: "invalid-kind",
                detail: format!("kind `{k}` is not one of: {}", KINDS.join(" | ")),
                suggestion: inferred.map(|s| format!("did you mean `{s}`?")),
            }),
            Some(k) => {
                if let Some(s) = inferred {
                    if s != k {
                        out.push(Finding {
                            id: id.clone(),
                            category: "mistyped",
                            detail: format!("kind is `{k}` but the name/code looks like `{s}`"),
                            suggestion: Some(format!("`{s}`")),
                        });
                    }
                }
            }
        }
        let has_viz_code = im.get("vizCode").and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty());
        let has_program = VIZ_PROGRAMS.contains(&base_name(&id).as_str());
        if !has_viz_code && !has_program {
            out.push(Finding {
                id: id.clone(),
                category: "missing-viz",
                detail: "no visualization — neither a stored `vizCode` nor a built-in program".into(),
                suggestion: Some("author a `vizCode` trace-program: `bsc graph impl set --viz-code …`".into()),
            });
        }
    }
    out
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/node_urn.rs, src/features.rs, src/build_facet.rs, src/impl_refresh.rs, src/cli.rs, src/emit.rs, src/extract.rs, src/migrate.rs, src/repo_store.rs, src/rust_test.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-graph--<module>.rs
//     bsc graph impl set --id bsc-graph--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-graph--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-graph--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));
