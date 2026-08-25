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

pub mod build_facet;
pub mod cli;
/// The store→file direction (#4192) — the twin of `bsc ui emit`, with the shared-`src` hazard
/// that makes an algorithm emit deliberately unlike a component one.
pub mod emit;
pub mod extract;
pub mod migrate;
pub mod repo_store;
pub mod rust_test;

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
    static V: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    V.get_or_init(|| bsc_util::packaged::read_required("knowledge/algorithms.json")).as_str()
}

/// The tiers an implementation may carry (#2863) — validated on `impl set`. A `primitive` is a LANGUAGE
/// built-in (free-standing); an `algorithm` composes them up.
pub const ROLES: [&str; 2] = ["primitive", "algorithm"];

/// Parse the embedded packaged seed. Panics only if the packaged JSON is malformed — a build-time
/// invariant the tests guard.
pub fn seed() -> Value {
    serde_json::from_str(graph_json()).expect("packaged algorithms.json is valid JSON")
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
    if missing.is_empty() {
        return false;
    }
    let arr = ensure_array(g, "implementations");
    for im in missing {
        arr.push(im);
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
    /// The tier (#2863) — `"primitive"` | `"algorithm"`.
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
const PLATFORM_MODULES_JSON: &str = include_str!("../../../src-tauri/data/ui/platform-modules.json");

/// Is `spec` bound to a LIVE platform module at runtime (`registerAppModule`)?
///
/// Public so the COMPONENT store can apply the same refusal — it holds records that `provides` the
/// very same specifiers, and duplicating the manifest lookup there would let the two drift.
pub fn is_registered_platform_module(spec: &str) -> bool {
    static M: std::sync::OnceLock<std::collections::BTreeSet<String>> = std::sync::OnceLock::new();
    M.get_or_init(|| {
        serde_json::from_str::<Vec<String>>(PLATFORM_MODULES_JSON).unwrap_or_default().into_iter().collect()
    })
    .contains(spec)
}

/// Upsert an implementation with no explicit author — every pre-#72 caller and test. Attributed to
/// `unknown`, exactly as the component store attributes an unattributed write, rather than inventing a
/// plausible-looking author.
pub fn set_impl(g: &mut Value, im: Value) -> Result<bool, String> {
    set_impl_by(g, im, "unknown", None)
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
    let existed = {
        let arr = ensure_array(g, "implementations");
        let before = arr.len();
        arr.retain(|x| x.get("id").and_then(Value::as_str) != Some(id));
        arr.len() != before
    };
    if !existed {
        return false;
    }
    let arr = ensure_array(g, "implementations");
    for im in arr.iter_mut() {
        if let Some(list) = im.get_mut("composes").and_then(Value::as_array_mut) {
            list.retain(|v| v.as_str() != Some(id));
        }
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
/// repointed. Errs on a self-merge or an absent id. No history stamp — the graph store has no #3164
/// provenance layer (unlike the component store).
pub fn merge_impls(g: &mut Value, from: &str, into: &str) -> Result<Vec<String>, String> {
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
    for im in ensure_array(g, "implementations").iter_mut() {
        let own_id = im.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if own_id == from {
            continue; // being removed
        }
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
                repointed.push(own_id);
            }
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
    for im in implementations_of(g) {
        if im.get("role").and_then(Value::as_str) != Some("algorithm") {
            continue; // primitives describe a built-in — nothing to type or visualize
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

#[cfg(test)]
mod tests {
    /// A record must not claim a specifier a LIVE platform module owns while holding state:
    /// `resolveGraphSource` checks records FIRST, so it would win and vendor a SECOND copy of that
    /// state to every graph consumer. Silent, unlike a broken override, which declines and falls back.
    #[test]
    fn a_stateful_record_cannot_provide_a_registered_platform_module() {
        let mut g = seed();
        // `@/store` is registered — the app store's own specifier.
        let stateful = serde_json::json!({
            "id": "x.ts", "tech": "typescript", "role": "algorithm", "name": "X",
            "code": "export const x = 1;", "provides": "@/store", "moduleState": ["cache"],
        });
        let err = set_impl(&mut g, stateful).expect_err("a stateful shadow is refused");
        assert!(err.contains("@/store"), "the error NAMES the specifier: {err}");
        assert!(err.contains("cache"), "…and the state it holds: {err}");

        // The SAME record without state is fine — a pure shadow is the same code either way, so which
        // copy wins does not matter. Only state makes module identity load-bearing.
        let pure = serde_json::json!({
            "id": "y.ts", "tech": "typescript", "role": "algorithm", "name": "Y",
            "code": "export const y = 1;", "provides": "@/store",
        });
        assert!(set_impl(&mut g, pure).is_ok(), "a pure shadow is allowed");

        // …and state alone is fine when the specifier is NOT a live platform module.
        let unclaimed = serde_json::json!({
            "id": "z.ts", "tech": "typescript", "role": "algorithm", "name": "Z",
            "code": "export const z = 1;", "provides": "@/nobody/owns/this", "moduleState": ["cache"],
        });
        assert!(set_impl(&mut g, unclaimed).is_ok(), "nothing live owns it, so nothing is shadowed");
    }

    /// The SURFACE RESTRICTION is only a restriction if something checks it. A declaration naming no
    /// entity is reported; a correct one is silent; and with NO entity list supplied the check is
    /// skipped rather than condemning every declaration — the caller simply did not open the store.
    #[test]
    fn doctor_reports_a_declaration_naming_no_entity() {
        let g = serde_json::json!({ "implementations": [{
            "id": "a.ts", "tech": "typescript", "role": "algorithm", "name": "A", "code": "export const a=1;",
            "kind": "accumulate", "reads": ["console-state"], "writes": ["ghost-entity"],
        }]});
        let unknown = |fs: &[Finding]| -> Vec<String> {
            fs.iter().filter(|f| f.category == "unknown-entity").map(|f| f.detail.clone()).collect()
        };

        let found = unknown(&doctor_with_entities(&g, &["console-state".to_string()]));
        assert_eq!(found.len(), 1, "exactly the undeclared one: {found:?}");
        assert!(found[0].contains("ghost-entity"), "and it NAMES it: {found:?}");

        let both = doctor_with_entities(&g, &["console-state".into(), "ghost-entity".into()]);
        assert!(unknown(&both).is_empty(), "a correct declaration is silent");

        assert!(unknown(&doctor(&g)).is_empty(), "no entity list ⇒ skipped, not all-condemned");
    }

    use super::*;

    /// Request #71 — the whole point of the tombstone. `merge` folded a SEEDED impl away, reported
    /// `"removed"`, and the seed reconcile put it straight back on the next read; a session lost an
    /// afternoon to a phantom "concurrent re-harvester" that did not exist.
    ///
    /// The reconcile is NOT the bug and is unchanged: it re-adds any packaged id the store lacks, which
    /// is what makes packaged algorithms recoverable. The tombstone works WITH that rule by occupying
    /// the id, so the absent-id check finds it present.
    #[test]
    fn a_merged_away_seed_impl_stays_gone_across_a_reconcile() {
        let mut g = seed();
        assert!(is_seeded("llm-energy.ts"), "the fixture depends on this being packaged");
        merge_impls(&mut g, "llm-energy.ts", "algorithms-llm-energy.ts").expect("merge succeeds");

        // Gone from every READ …
        let live = implementations_of(&g);
        assert!(!live.iter().any(|im| im["id"] == "llm-energy.ts"), "the fold removes it");
        // … and STAYS gone when the reconcile runs, which is where it used to come back.
        reconcile_seed(&mut g);
        let after = implementations_of(&g);
        assert!(!after.iter().any(|im| im["id"] == "llm-energy.ts"), "the reconcile must not resurrect it");

        // The tombstone records WHAT replaced it — the audit trail a consolidation needs later.
        let tomb = suppressions_of(&g)
            .into_iter()
            .find(|t| t["id"] == "llm-energy.ts")
            .expect("the suppression is listed");
        assert_eq!(tomb.get("supersededBy").and_then(Value::as_str), Some("algorithms-llm-energy.ts"));
    }

    /// REQUEST #77 — the reported shape, reproduced end to end.
    ///
    /// `llm-energy.ts` was merged into its algorithms-domain survivor, confirmed gone, verified across
    /// a fresh doctor run, and then reappeared later in the same session. It was reported as the
    /// tombstone not being durable, but the tombstone never moved: the live store carried FOUR entries
    /// for TWO ids, which is the SECOND merge writing a duplicate of one already there.
    ///
    /// The tombstone guarded `reconcile_seed` and nothing else — `is_suppressed` was consulted in one
    /// place, the `unsuppress` verb — so every authoring path wrote the retired record straight back
    /// while its tombstone sat beside it untouched. The reporter was running bulk harvest passes,
    /// which is exactly that path. The record returned with no history, which is what a fresh write
    /// looks like, so the reconcile took the blame for something it never did.
    ///
    /// BEFORE THIS FIX the `set_impl` below returned `Ok` and the final assertion failed.
    #[test]
    fn a_retired_impl_cannot_be_re_authored_by_a_later_write() {
        let mut g = seed();
        merge_impls(&mut g, "llm-energy.ts", "algorithms-llm-energy.ts").expect("merge succeeds");
        assert!(!implementations_of(&g).iter().any(|im| im["id"] == "llm-energy.ts"), "gone after the fold");

        // The resurrection: a later pass re-authors the same id, exactly as a re-harvest would.
        let err = set_impl(
            &mut g,
            serde_json::json!({
                "id": "llm-energy.ts", "tech": "typescript", "role": "algorithm",
                "name": "llmEnergy", "code": "export const e = 1;",
            }),
        )
        .expect_err("re-authoring a RETIRED id must be refused");
        assert!(err.contains("llm-energy.ts"), "names the id: {err}");
        assert!(err.contains("algorithms-llm-energy.ts"), "names what superseded it: {err}");
        assert!(err.contains("unsuppress"), "names the way back, or the refusal is a dead end: {err}");

        // The point of the whole thing: it is STILL gone, with no second merge needed.
        assert!(!implementations_of(&g).iter().any(|im| im["id"] == "llm-energy.ts"), "stays retired");
    }

    /// The refusal must not be a one-way door. `unsuppress` is the deliberate way back, and after it
    /// the SAME write succeeds — otherwise a wrong retirement would be unrecoverable.
    #[test]
    fn unsuppress_reopens_the_id_and_the_same_write_then_succeeds() {
        let mut g = seed();
        merge_impls(&mut g, "stream-merge.ts", "windowed-tally.ts").expect("merge succeeds");
        let write = || {
            serde_json::json!({
                "id": "stream-merge.ts", "tech": "typescript", "role": "algorithm",
                "name": "streamMerge", "code": "export const s = 1;",
            })
        };
        assert!(set_impl(&mut g, write()).is_err(), "refused while retired");

        // `unsuppress` as the CLI performs it — drop the tombstone, then write.
        ensure_array(&mut g, "suppressed")
            .retain(|t| t.get("id").and_then(Value::as_str) != Some("stream-merge.ts"));
        assert!(set_impl(&mut g, write()).is_ok(), "and allowed once the retirement is lifted");
        assert!(implementations_of(&g).iter().any(|im| im["id"] == "stream-merge.ts"), "it is back");
    }

    /// Retiring an already-retired id is IDEMPOTENT. The live store carried two tombstones for each of
    /// two ids because the same merge ran twice; duplicates do not fool the reconcile (it only asks
    /// whether an id is listed) but a list that grows on every retry cannot be read as a history.
    #[test]
    fn retiring_an_already_retired_id_does_not_append_a_second_tombstone() {
        let mut g = seed();
        assert!(add_suppression(&mut g, "x.ts", Some("y.ts")), "first is new");
        assert!(!add_suppression(&mut g, "x.ts", Some("y.ts")), "second is not");
        assert_eq!(suppressions_of(&g).iter().filter(|t| t["id"] == "x.ts").count(), 1, "one entry");

        // Re-retiring with NO pointer must not erase the pointer already recorded.
        assert!(!add_suppression(&mut g, "x.ts", None));
        assert_eq!(superseded_by(&g, "x.ts").as_deref(), Some("y.ts"), "the pointer survives");
        // …and a NEW pointer refreshes it rather than being dropped on the floor.
        add_suppression(&mut g, "x.ts", Some("z.ts"));
        assert_eq!(superseded_by(&g, "x.ts").as_deref(), Some("z.ts"));
    }

    /// A store that ALREADY accumulated duplicates heals itself on load — the live store has four
    /// entries for two ids right now, and nobody should have to run a command to fix that.
    #[test]
    fn dedupe_collapses_existing_duplicates_and_keeps_what_superseded_them() {
        // The exact live shape, including the case that matters: the copy carrying `supersededBy` is
        // NOT the first one, so a naive keep-the-first would drop what replaced the record.
        let mut g = serde_json::json!({
            "implementations": [],
            "suppressed": [
                { "id": "llm-energy.ts" },
                { "id": "stream-merge.ts", "supersededBy": "algorithms-stream-merge.ts" },
                { "id": "llm-energy.ts", "supersededBy": "algorithms-llm-energy.ts" },
                { "id": "stream-merge.ts", "supersededBy": "algorithms-stream-merge.ts" },
            ],
        });
        assert!(dedupe_suppressions(&mut g), "it changed the store");
        assert_eq!(suppressions_of(&g).len(), 2, "one per id: {:?}", suppressions_of(&g));
        assert_eq!(superseded_by(&g, "llm-energy.ts").as_deref(), Some("algorithms-llm-energy.ts"));
        assert_eq!(superseded_by(&g, "stream-merge.ts").as_deref(), Some("algorithms-stream-merge.ts"));
        assert!(!dedupe_suppressions(&mut g), "idempotent — a clean store reports no change");
    }

    /// The RESIDUE of #77, which the write-path guard cannot undo. Measured on the live store WHILE
    /// this fix was being written: `llm-energy.ts` and `stream-merge.ts` were each listed in
    /// `suppressed` and simultaneously present in `implementations`. Nothing surfaced it, which is how
    /// it survived two rounds of someone actively hunting it.
    #[test]
    fn doctor_reports_an_id_that_is_both_retired_and_live() {
        let g = serde_json::json!({
            "implementations": [{
                "id": "llm-energy.ts", "tech": "typescript", "role": "algorithm",
                "name": "llmEnergy", "code": "export const e = 1;", "kind": "accumulate",
            }],
            "suppressed": [{ "id": "llm-energy.ts", "supersededBy": "algorithms-llm-energy.ts" }],
        });
        let all = doctor(&g);
        let found: Vec<&Finding> = all.iter().filter(|f| f.category == "retired-but-live").collect();
        assert_eq!(found.len(), 1, "the contradiction is reported: {all:?}");
        assert!(found[0].detail.contains("algorithms-llm-energy.ts"), "names what superseded it");
        let s = found[0].suggestion.clone().unwrap_or_default();
        assert!(s.contains("remove") && s.contains("unsuppress"), "offers BOTH resolutions: {s}");

        // A healthy store is silent — the check must not fire on an ordinary retirement.
        let clean = serde_json::json!({
            "implementations": [],
            "suppressed": [{ "id": "llm-energy.ts", "supersededBy": "algorithms-llm-energy.ts" }],
        });
        assert!(
            !doctor(&clean).iter().any(|f| f.category == "retired-but-live"),
            "a properly retired id is not a finding"
        );
    }

    /// A tombstone must never surface AS an algorithm. It lives in the same array as the impls (that is
    /// what makes the reconcile skip it), so the single filtered reader is the only thing standing
    /// between it and every consumer — doctor, domain sweeps, `impl list`.
    #[test]
    fn a_retired_impl_leaves_the_array_entirely_and_is_recorded_in_the_list() {
        let mut g = seed();
        merge_impls(&mut g, "stream-merge.ts", "windowed-tally.ts").expect("merge succeeds");
        assert!(!implementations_of(&g).iter().any(|im| im["id"] == "stream-merge.ts"), "gone from the impls");
        assert!(is_suppressed(&g, "stream-merge.ts"), "recorded in the suppression list instead");
        // …and it does not leak into a domain collection either.
        assert!(!in_domain_ids(&g, "fleet").contains(&"stream-merge.ts".to_string()));
    }

    /// A USER-MADE impl keeps removing outright: no tombstone where a plain delete is durable, or the
    /// store fills with markers for records nothing would have re-seeded.
    #[test]
    fn a_user_made_impl_is_removed_outright_not_tombstoned() {
        let mut g = seed();
        set_impl(&mut g, serde_json::json!({
            "id": "zz-user.ts", "tech": "typescript", "role": "algorithm", "name": "ZZ", "code": "export const z=1;",
        })).expect("user impl writes");
        merge_impls(&mut g, "zz-user.ts", "windowed-tally.ts").expect("merge succeeds");
        assert!(!implementations_of(&g).iter().any(|im| im["id"] == "zz-user.ts"), "gone entirely");
        assert!(!is_suppressed(&g, "zz-user.ts"), "and NOT tombstoned — a plain delete is durable for it");
    }

    /// Helper: the ids a domain collection reports, through the FILTERED reader.
    fn in_domain_ids(g: &Value, domain: &str) -> Vec<String> {
        implementations_of(g)
            .iter()
            .filter(|im| impl_in_domain(im, domain))
            .filter_map(|im| im.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect()
    }

    /// #72 — every graph write is now ATTRIBUTED. `impl set` stamped nothing: no rev, author, timestamp
    /// or history, so a bad write was unattributable and unrevertible, and a session asking "who keeps
    /// recreating this node" had nothing to read. (Nobody was: that was the seed reconcile, #71.)
    ///
    /// Stamped through the SAME `bsc-record` the component store uses, so `bsc ui log` and the graph's
    /// history mean the same thing instead of being two dialects.
    #[test]
    fn a_graph_write_is_stamped_with_its_author_and_history() {
        let mut g = seed();
        set_impl_by(&mut g, serde_json::json!({
            "id": "zz-hist.ts", "tech": "typescript", "role": "algorithm", "name": "ZZ", "code": "export const z = 1;",
        }), "designer", Some("first cut")).expect("create");

        let rec = |g: &Value| implementations_of(g).into_iter().find(|i| i["id"] == "zz-hist.ts").expect("present");
        let created = rec(&g);
        assert_eq!(created.get("rev").and_then(Value::as_i64), Some(1), "a CREATE is rev 1, not unstamped");
        let h = created.get("history").and_then(Value::as_array).cloned().unwrap_or_default();
        assert_eq!(h.len(), 1, "the create is in the log — a record whose log starts at its second write lies");
        assert_eq!(h[0].get("by").and_then(Value::as_str), Some("designer"));
        assert_eq!(h[0].get("note").and_then(Value::as_str), Some("first cut"));

        // An EDIT diffs against the prior value and retains the rung back.
        set_impl_by(&mut g, serde_json::json!({
            "id": "zz-hist.ts", "tech": "typescript", "role": "algorithm", "name": "ZZ", "code": "export const z = 2;",
        }), "claude", Some("bump")).expect("edit");
        let edited = rec(&g);
        assert_eq!(edited.get("rev").and_then(Value::as_i64), Some(2));
        let h2 = edited.get("history").and_then(Value::as_array).cloned().unwrap_or_default();
        let last = h2.last().expect("an entry");
        assert_eq!(last.get("by").and_then(Value::as_str), Some("claude"));
        assert!(
            last.get("changed").and_then(Value::as_array).is_some_and(|c| c.iter().any(|v| v == "code")),
            "the diff names the field that moved: {last}"
        );
        // The rung is keyed on the GRAPH's content field (`code`), not the component store's `srcText` —
        // the one store-specific thing in the shared stamp, and the reason it takes a parameter.
        assert_eq!(last.get("prevSrc").and_then(Value::as_str), Some("export const z = 1;"),
                   "the previous code is retained, so a revert has something to reach");
    }

    /// THE CRASH (#the-tombstone-crash). The first cut parked `{ id, suppressed: true }` INSIDE
    /// `implementations`, filtered it in the Rust reader, and called that the single funnel. The
    /// frontend reads the same JSON directly, had never heard of `suppressed`, and died on render:
    /// `TypeError: Cannot read properties of undefined (reading 'join')` — `graphSig` mapping over a
    /// record with no `composes`.
    ///
    /// So the invariant is about SHAPE: everything in that array is an implementation. A store written
    /// by the first cut heals on load rather than needing a command, because two of them are already in
    /// a live store.
    #[test]
    fn a_legacy_inline_tombstone_is_swept_out_of_the_impl_array() {
        let mut g = seed();
        ensure_array(&mut g, "implementations").push(serde_json::json!({
            "id": "llm-energy.ts", "suppressed": true, "supersededBy": "algorithms-llm-energy.ts",
        }));

        assert!(migrate_inline_tombstones(&mut g), "it reports having healed something");

        // Nothing a reader iterates is a tombstone, and every impl has what an impl has — the two
        // fields `graphSig` reached for.
        for im in implementations_of(&g) {
            assert!(im.get("suppressed").is_none(), "no tombstone survives in the array: {im}");
            assert!(im.get("composes").is_some(), "every impl a reader sees has composes: {im}");
        }
        // …and the retirement is still recorded, with what replaced it.
        assert!(is_suppressed(&g, "llm-energy.ts"));
        let t = suppressions_of(&g).into_iter().find(|t| t["id"] == "llm-energy.ts").expect("listed");
        assert_eq!(t.get("supersededBy").and_then(Value::as_str), Some("algorithms-llm-energy.ts"));
        // Idempotent: a second load neither duplicates nor re-adds.
        assert!(!migrate_inline_tombstones(&mut g), "nothing left to heal");
        reconcile_seed(&mut g);
        assert!(!implementations_of(&g).iter().any(|im| im["id"] == "llm-energy.ts"), "stays retired");
    }

    #[test]
    fn seed_parses_impl_only_and_is_primitives_rooted() {
        let g = seed();
        let impls = implementations_of(&g);
        assert!(impls.len() >= 16, "the seed carries the Rust kit");
        // No abstract concept ontology (#2961) — a node IS its implementation.
        assert!(g.get("nodes").is_none(), "the abstract `nodes` array is gone");
        assert!(g.get("edges").is_none(), "the abstract `edges` array is gone");
        let ids: std::collections::HashSet<String> =
            impls.iter().filter_map(|i| i.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
        let mut has_primitive = false;
        for im in &impls {
            let role = im.get("role").and_then(Value::as_str).expect("impl.role is set");
            assert!(ROLES.contains(&role), "impl role '{role}' is known");
            if role == "primitive" {
                has_primitive = true;
            }
            // No impl carries a `concept` — the impl IS the concept (#2961).
            assert!(im.get("concept").is_none(), "impls no longer carry a `concept`");
            for c in im.get("composes").and_then(Value::as_array).into_iter().flatten() {
                let cid = c.as_str().expect("composes id is a string");
                assert!(ids.contains(cid), "composes id '{cid}' is a known impl");
            }
        }
        assert!(has_primitive, "the kit has a primitive base");
    }

    #[test]
    fn primitives_are_descriptors_with_a_ref_not_code() {
        // #2972: a primitive DESCRIBES a language built-in (its std `ref`) and is NOT re-coded; an
        // algorithm carries real, reusable code.
        let g = seed();
        for im in implementations_of(&g) {
            let id = im.get("id").and_then(Value::as_str).unwrap_or_default();
            match im.get("role").and_then(Value::as_str) {
                Some("primitive") => {
                    assert!(
                        im.get("ref").and_then(Value::as_str).is_some_and(|r| !r.trim().is_empty()),
                        "primitive '{id}' names its std ref",
                    );
                    assert!(im.get("code").is_none(), "primitive '{id}' is described, not re-coded");
                }
                Some("algorithm") => assert!(
                    im.get("code").and_then(Value::as_str).is_some_and(|c| !c.trim().is_empty()),
                    "algorithm '{id}' carries real code",
                ),
                other => panic!("impl '{id}' has an unexpected role {other:?}"),
            }
        }
    }

    #[test]
    fn used_by_index_is_the_composes_inverse_by_id() {
        // #3594: the algorithm graph's usage signal — keyed by id (algorithms compose by id, no kits).
        let g = serde_json::json!({ "implementations": [
            { "id": "swap", "tech": "rust", "role": "primitive", "name": "swap", "ref": "std", "composes": [] },
            { "id": "bubble", "tech": "rust", "role": "algorithm", "name": "bubble", "code": "x", "composes": ["swap"] },
            { "id": "insertion", "tech": "rust", "role": "algorithm", "name": "insertion", "code": "x", "composes": ["swap"] },
            { "id": "quick", "tech": "rust", "role": "algorithm", "name": "quick", "code": "x", "composes": ["swap", "swap"] },
        ] });
        let idx = used_by_index(&g);
        assert_eq!(
            idx.get("swap"),
            Some(&vec!["bubble".to_string(), "insertion".to_string(), "quick".to_string()]),
            "swap: composed by all three, sorted + deduped (quick listed it twice)",
        );
        assert!(!idx.contains_key("bubble"), "nothing composes bubble ⇒ absent (a root)");
    }

    #[test]
    fn merge_impls_repoints_dedups_drops_self_ref_and_removes() {
        // #3594: merge `xchg` INTO `swap`. `swap` composed `xchg` (→ a self-ref the fold drops); `bubble`
        // composed BOTH swap + xchg (→ dedups to swap once) plus an unrelated `cmp` (kept).
        let mut g = serde_json::json!({ "implementations": [
            { "id": "swap", "tech": "rust", "role": "algorithm", "name": "swap", "code": "x", "composes": ["xchg"] },
            { "id": "xchg", "tech": "rust", "role": "algorithm", "name": "xchg", "code": "x", "composes": [] },
            { "id": "bubble", "tech": "rust", "role": "algorithm", "name": "bubble", "code": "x", "composes": ["swap", "xchg", "cmp"] },
        ] });
        let repointed = merge_impls(&mut g, "xchg", "swap").unwrap();
        assert!(repointed.contains(&"swap".to_string()) && repointed.contains(&"bubble".to_string()));
        let by = |id: &str| implementations_of(&g).into_iter().find(|im| im["id"] == *id).unwrap();
        assert_eq!(by("swap")["composes"], serde_json::json!([]), "the self-reference the fold created is dropped");
        assert_eq!(by("bubble")["composes"], serde_json::json!(["swap", "cmp"]), "deduped to swap once; cmp kept");
        assert!(implementations_of(&g).iter().all(|im| im["id"] != "xchg"), "the merged-away impl is removed");
    }

    #[test]
    fn merge_impls_refuses_self_and_absent() {
        let mut g = serde_json::json!({ "implementations": [
            { "id": "a", "tech": "rust", "role": "primitive", "name": "a", "ref": "std", "composes": [] },
        ] });
        assert!(merge_impls(&mut g, "a", "a").unwrap_err().contains("into itself"));
        assert!(merge_impls(&mut g, "ghost", "a").unwrap_err().contains("unknown implementation 'ghost'"));
        assert!(merge_impls(&mut g, "a", "ghost").unwrap_err().contains("unknown implementation 'ghost'"));
        assert_eq!(implementations_of(&g).len(), 1, "no refusal mutated the graph");
    }

    #[test]
    fn implementations_find_by_id_over_the_tier() {
        let g = seed();
        let ms = implementations_of(&g)
            .into_iter()
            .find(|im| im["id"] == "merge-sort.rs")
            .expect("merge-sort.rs is seeded");
        assert_eq!(ms["tech"], "rust");
        let composes: Vec<&str> =
            ms["composes"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert!(composes.contains(&"merge.rs"), "merge_sort builds on the merge primitive");
        assert!(implementations_of(&g).iter().all(|im| im["id"] != "nope.rs"));
    }

    // ── #2853 write path ──

    #[test]
    fn set_impl_upserts_a_language_kit_node_and_validates_role() {
        let mut g = seed();
        let n0 = implementations_of(&g).len();
        let inserted = set_impl(&mut g, serde_json::json!({
            "id": "java.stream", "tech": "java", "role": "primitive", "name": "Stream (Java)", "composes": [], "code": "…"
        })).unwrap();
        assert!(!inserted, "a new impl inserts");
        assert_eq!(implementations_of(&g).len(), n0 + 1);
        assert!(implementations_of(&g).iter().any(|im| im["id"] == "java.stream" && im["role"] == "primitive"));

        let replaced = set_impl(&mut g, serde_json::json!({
            "id": "java.stream", "tech": "java", "role": "primitive", "name": "Stream v2", "composes": [], "code": "…"
        })).unwrap();
        assert!(replaced);
        assert_eq!(implementations_of(&g).len(), n0 + 1, "upsert doesn't duplicate");

        assert!(set_impl(&mut g, serde_json::json!({ "id": "x", "tech": "java", "role": "bogus", "name": "X", "composes": [] })).is_err(), "unknown role rejected");
        assert!(set_impl(&mut g, serde_json::json!({ "id": "", "tech": "java", "role": "algorithm", "name": "X", "composes": [] })).is_err(), "empty id rejected");
        assert!(set_impl(&mut g, serde_json::json!({ "id": "y", "role": "algorithm", "name": "Y", "composes": [] })).is_err(), "missing tech rejected");
    }

    #[test]
    fn remove_impl_drops_it_and_scrubs_composes() {
        let mut g = seed();
        // merge-sort.rs composes merge.rs — removing merge.rs scrubs the reference.
        assert!(implementations_of(&g).iter().any(|im| im["id"] == "merge.rs"));
        assert!(remove_impl(&mut g, "merge.rs"), "merge.rs existed");
        assert!(!implementations_of(&g).iter().any(|im| im["id"] == "merge.rs"), "it's gone");
        let ms = implementations_of(&g).into_iter().find(|im| im["id"] == "merge-sort.rs").unwrap();
        assert!(
            !ms["composes"].as_array().unwrap().iter().any(|v| v == "merge.rs"),
            "the dangling composes reference was scrubbed",
        );
        assert!(!remove_impl(&mut g, "merge.rs"), "removing an absent impl reports false");
    }

    #[test]
    fn save_then_load_round_trips_a_mutated_graph() {
        let mut g = seed();
        set_impl(&mut g, serde_json::json!({
            "id": "rust.bloomfilter", "tech": "rust", "role": "primitive", "name": "BloomFilter (Rust)", "composes": [], "code": "// bloom"
        })).unwrap();
        let tmp = crate::unique_temp("store").with_extension("json");
        save_at(&tmp, &g).unwrap();
        let back = load_at(&tmp);
        assert!(
            implementations_of(&back).iter().any(|im| im["id"] == "rust.bloomfilter"),
            "the write persisted + re-loaded",
        );
        // A missing store falls back to the embedded seed (which has no bloom filter).
        let missing = std::env::temp_dir().join("bsc-graph-store-does-not-exist.json");
        assert!(!implementations_of(&load_at(&missing)).iter().any(|im| im["id"] == "rust.bloomfilter"));
        assert!(
            implementations_of(&load_at(&missing)).iter().any(|im| im["id"] == "merge-sort.rs"),
            "an absent store reads the seed",
        );
        let _ = std::fs::remove_file(&tmp);
    }

    // ── #3120 domain facet ──

    #[test]
    fn algo_impl_without_domain_or_tags_deserializes_and_round_trips_unchanged() {
        // Backward compat: an impl authored before the facet — no `domain`/`tags` — deserializes with the
        // facet ABSENT (domain None, tags empty), and re-serializes WITHOUT gaining empty facet keys, so
        // existing seed JSON is untouched.
        let json = serde_json::json!({
            "id": "merge.rs", "tech": "rust", "role": "algorithm", "name": "merge",
            "summary": "Interleave two sorted slices.", "composes": ["rust.vec"], "code": "// merge"
        });
        let im: AlgoImpl = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(im.domain, None, "no domain when the JSON omits it");
        assert!(im.tags.is_empty(), "tags default empty when the JSON omits them");
        let back = serde_json::to_value(&im).unwrap();
        assert!(back.get("domain").is_none(), "no empty `domain` key is emitted");
        assert!(back.get("tags").is_none(), "no empty `tags` key is emitted");
        assert_eq!(back, json, "the facet-less impl round-trips unchanged");
    }

    #[test]
    fn algo_impl_carries_the_domain_and_tags_facets_when_present() {
        let json = serde_json::json!({
            "id": "dijkstra.rs", "tech": "rust", "role": "algorithm", "name": "dijkstra",
            "composes": [], "code": "// dijkstra", "domain": "logistics", "tags": ["graph", "routing"]
        });
        let im: AlgoImpl = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(im.domain.as_deref(), Some("logistics"));
        assert_eq!(im.tags, ["graph", "routing"]);
        assert_eq!(serde_json::to_value(&im).unwrap(), json, "the facets round-trip");
    }

    #[test]
    fn the_packaged_seed_carries_domain_collections() {
        // #3134: the seed itself is TAGGED, so the domain filter (rail + `impl list --domain`) is
        // populated out of the box — no manual `bsc graph impl set --domain` curation needed. Asserts
        // the collections the seed ships, so an accidental de-tagging of the seed fails here.
        let impls = implementations_of(&seed());
        let in_domain = |d: &str| -> Vec<String> {
            impls
                .iter()
                .filter(|im| impl_in_domain(im, d))
                .filter_map(|im| im.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect()
        };

        // Routing / shortest-path / dependency sequencing — the issue's named example collection.
        let mut logistics = in_domain("logistics");
        logistics.sort();
        assert_eq!(
            logistics,
            ["a-star.rs", "bfs.rs", "dfs.rs", "dijkstra.rs", "topological-sort.rs"],
            "the logistics collection is the graph traversal + pathfinding + scheduling set"
        );
        // In-place square-matrix transforms — a SECOND domain, proving the filter discriminates.
        let mut graphics = in_domain("graphics");
        graphics.sort();
        assert_eq!(graphics, ["reflect.ts", "rotate.ts", "transpose.ts"], "the graphics collection");
        assert_eq!(in_domain("signal-processing"), ["fft.rs"]);
        // `fleet` is an OPEN domain and the three above are CLOSED — which is why this one is asserted
        // by PROPERTY rather than by membership. Logistics is the graph-traversal/pathfinding set and
        // graphics is the in-place matrix transforms: finite, classical, and an exact list is right for
        // them. `fleet` is fed by directory harvest, so pinning its exact membership meant every later
        // curation of the subsystem turned develop red — it sat at 91 pass / 1 fail once a sweep of
        // `src/shared/lib/fleet/` took it from 6 members to 21, and the failure said nothing about what
        // had gone wrong. A red test on develop is worse than no test: it trains the next reader to see
        // a real failure as noise, and this one was already mistaken for collateral damage once.
        //
        // The property still has the teeth the list had. The six FleetPage-dashboard originals
        // (#3462/#3465) were extracted from the PAGE, so they carry no `src`; everything harvested since
        // carries a `src` under the fleet subsystem. So a member is one or the other — and an impl from
        // ANYWHERE ELSE tagged `fleet`, which is the over-tagging the list was guarding against, still
        // fails.
        const FLEET_DASHBOARD: [&str; 6] = [
            "group-totals.ts", "llm-energy.ts", "order-by-rank.ts",
            "precedence-resolve.ts", "stream-merge.ts", "windowed-tally.ts",
        ];
        let fleet = in_domain("fleet");
        for id in FLEET_DASHBOARD {
            assert!(fleet.iter().any(|f| f == id), "the dashboard original '{id}' stays in the fleet collection");
        }
        for id in &fleet {
            if FLEET_DASHBOARD.contains(&id.as_str()) {
                continue;
            }
            let im = impls.iter().find(|im| im["id"] == id.as_str()).expect("a listed id resolves");
            let src = im.get("src").and_then(Value::as_str).unwrap_or_default();
            // A no-`src` member is the interesting failure, not an edge case: that shape is reserved
            // for the six dashboard originals, so a SEVENTH is either a new dashboard extraction that
            // belongs on the list above, or a mis-tag. Say which rather than printing an empty path.
            let from = if src.is_empty() { "no src — extracted, not lifted".to_string() } else { format!("'{src}'") };
            assert!(
                src.contains("shared/lib/fleet/"),
                "fleet member '{id}' ({from}) is outside the fleet subsystem — mis-tagged rather than \
                 curated, or a new dashboard extraction that belongs in FLEET_DASHBOARD"
            );
        }

        // The facet is ADDITIVE: the seed's general-purpose sorts/searches stay UNTAGGED rather than
        // being forced into a domain, so a domain collection never surfaces an unrelated algorithm.
        for id in ["merge-sort.rs", "quick-sort.rs", "binary-search.rs", "linear-search.rs"] {
            let im = impls.iter().find(|im| im["id"] == id).expect("seed impl exists");
            assert!(im.get("domain").is_none(), "general-purpose '{id}' carries no domain");
        }
        // Primitives are language built-ins, never domain members.
        for im in &impls {
            if im.get("role").and_then(Value::as_str) == Some("primitive") {
                assert!(im.get("domain").is_none(), "a primitive carries no domain: {}", im["id"]);
            }
        }
    }

    #[test]
    fn every_seed_impl_deserializes_as_a_typed_algo_impl_and_round_trips() {
        // The domain tags (#3134) are only real if the PARSER accepts them: every packaged impl must
        // deserialize into the typed `AlgoImpl` and re-serialize byte-identically, so a tag added to the
        // JSON is readable through the model rather than dead weight the struct silently drops.
        for im in implementations_of(&seed()) {
            let typed: AlgoImpl = serde_json::from_value(im.clone())
                .unwrap_or_else(|e| panic!("seed impl {} does not parse: {e}", im["id"]));
            assert_eq!(serde_json::to_value(&typed).unwrap(), im, "{} round-trips", im["id"]);
        }
        // …and the tagged ones surface their domain through the typed field.
        let dijkstra = implementations_of(&seed()).into_iter().find(|im| im["id"] == "dijkstra.rs").unwrap();
        let typed: AlgoImpl = serde_json::from_value(dijkstra).unwrap();
        assert_eq!(typed.domain.as_deref(), Some("logistics"));
    }

    /// `provides` is what makes a record RESOLVABLE at runtime, and `tests` is what will let one be
    /// verified in isolation — so both must survive the typed model, not merely sit in the JSON.
    /// Untyped, they round-tripped to nothing and the whole 19-module migration failed this test
    /// (algoimpl-drops-provides-and-tests).
    #[test]
    fn a_record_keeps_provides_and_its_paired_tests_through_the_typed_model() {
        let raw = serde_json::json!({
            "id": "use-plan-gates.ts", "tech": "typescript", "role": "algorithm", "name": "usePlanGates",
            "composes": [], "code": "export const x = 1;
",
            "provides": "@/features/planner/session/usePlanGates",
            "tests": [{ "name": "usePlanGates", "src": "import { it } from \"vitest\";
" }],
        });
        let typed: AlgoImpl = serde_json::from_value(raw.clone()).expect("parses");
        assert_eq!(typed.provides.as_deref(), Some("@/features/planner/session/usePlanGates"));
        assert_eq!(typed.tests.len(), 1);
        assert_eq!(serde_json::to_value(&typed).unwrap(), raw, "round-trips byte-for-byte");

        // ADDITIVE both ways: an impl with neither gains no keys, so untouched seed JSON stays identical.
        let bare = serde_json::json!({
            "id": "fibonacci.ts", "tech": "typescript", "role": "algorithm", "name": "fibonacci",
            "composes": [], "code": "export const f = 1;
",
        });
        let typed: AlgoImpl = serde_json::from_value(bare.clone()).expect("parses");
        assert!(typed.provides.is_none() && typed.tests.is_empty());
        assert_eq!(serde_json::to_value(&typed).unwrap(), bare, "no empty provides/tests keys appear");
    }

    /// The EDGE tier (integration-tests-become-graph-edges): a test spanning two records is evidence
    /// about the relationship, and `doctor` can then say which relationships have none.
    #[test]
    fn edges_are_additive_and_doctor_finds_the_gaps() {
        // A store with NO edges must never gain an `edges` key by being read — otherwise every seed
        // would churn the first time anything looked at it.
        let bare = serde_json::json!({ "version": 2, "implementations": [] });
        assert!(edges_of(&bare).is_empty());
        assert_eq!(bare, serde_json::json!({ "version": 2, "implementations": [] }), "reading added no key");

        let mut g = serde_json::json!({
            "version": 2,
            "implementations": [
                { "id": "a.ts", "tech": "typescript", "role": "algorithm", "name": "a", "composes": ["b.ts", "c.ts"] },
                { "id": "b.ts", "tech": "typescript", "role": "algorithm", "name": "b", "composes": [] },
                { "id": "c.ts", "tech": "typescript", "role": "algorithm", "name": "c", "composes": [] },
            ],
        });

        // A relation to a PRIMITIVE is not a gap — it is a language built-in, not a collaborator.
        {
            let mut withprim = g.clone();
            withprim["implementations"].as_array_mut().unwrap().push(serde_json::json!({
                "id": "typescript.array", "tech": "typescript", "role": "primitive", "name": "array", "composes": []
            }));
            withprim["implementations"][0]["composes"].as_array_mut().unwrap().push(serde_json::json!("typescript.array"));
            let (missing, _, _) = edge_findings(&withprim);
            assert!(!missing.iter().any(|m| m["to"] == "typescript.array"), "a primitive is not a missing edge: {missing:?}");
        }

        // Both relations are uncovered to begin with.
        let (missing, dangling, _) = edge_findings(&g);
        assert_eq!(missing.len(), 2, "a→b and a→c are both uncovered: {missing:?}");
        assert!(dangling.is_empty());

        // An edge over a→b covers it, in either direction.
        set_edge(&mut g, serde_json::json!({ "id": "a×b", "members": ["b.ts", "a.ts"] })).unwrap();
        let (missing, _, _) = edge_findings(&g);
        assert_eq!(missing.len(), 1, "only a→c is left: {missing:?}");
        assert_eq!(missing[0]["to"], "c.ts");

        // A DANGLING edge is its own finding — it reads as covered while naming a record that is gone.
        set_edge(&mut g, serde_json::json!({ "id": "a×ghost", "members": ["a.ts", "ghost.ts"] })).unwrap();
        let (_, dangling, _) = edge_findings(&g);
        assert_eq!(dangling.len(), 1);
        assert_eq!(dangling[0]["unknownMembers"][0], "ghost.ts");

        // An edge over ONE record is a record test wearing the wrong shape — refused, or the isolation
        // gate is pointless.
        assert!(set_edge(&mut g, serde_json::json!({ "id": "solo", "members": ["a.ts"] })).is_err());

        // Merging, like `set_impl`: a later write overlays without deleting what it did not supply.
        set_edge(&mut g, serde_json::json!({ "id": "a×b", "src": "src/x.test.ts" })).unwrap();
        let e = edges_of(&g).into_iter().find(|e| e["id"] == "a×b").unwrap();
        assert_eq!(e["src"], "src/x.test.ts");
        assert_eq!(e["members"].as_array().unwrap().len(), 2, "members survived a src-only write");

        assert!(remove_edge(&mut g, "a×ghost"));
        assert!(edge_findings(&g).1.is_empty());

        // PENDING, not dangling: an edge written when a module retires names collaborators that are
        // still FILES. `@/…` that no record provides YET is the migration not having reached it —
        // expected and honest — where a bare id that does not exist is a record that was REMOVED.
        set_edge(&mut g, serde_json::json!({
            "id": "a~integration",
            "members": ["a.ts", "@/features/not/migrated/yet"],
        })).unwrap();
        let (_, dangling, pending) = edge_findings(&g);
        assert!(dangling.is_empty(), "a specifier is not dangling: {dangling:?}");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["pendingMembers"][0], "@/features/not/migrated/yet");

        // …and it RESOLVES once that module becomes a record carrying the specifier.
        g["implementations"].as_array_mut().unwrap().push(serde_json::json!({
            "id": "yet.ts", "tech": "typescript", "role": "algorithm", "name": "yet", "composes": [],
            "provides": "@/features/not/migrated/yet",
        }));
        let (_, _, pending) = edge_findings(&g);
        assert!(pending.is_empty(), "pending clears when the module migrates: {pending:?}");
    }

    // ── #3210 kind facet ──

    #[test]
    fn algo_impl_kind_facet_is_additive_round_trips_and_persists_via_set_impl() {
        // Present → deserializes + re-serializes unchanged.
        let json = serde_json::json!({
            "id": "merge-sort.rs", "tech": "rust", "role": "algorithm", "name": "merge_sort",
            "composes": [], "code": "// sort", "kind": "sort"
        });
        let im: AlgoImpl = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(im.kind.as_deref(), Some("sort"));
        assert_eq!(serde_json::to_value(&im).unwrap(), json, "the kind facet round-trips");

        // Absent → None, and no empty `kind` key is emitted (backward-compatible with pre-facet impls).
        let bare = serde_json::json!({ "id": "x.rs", "tech": "rust", "role": "algorithm", "name": "x", "composes": [], "code": "//" });
        let im2: AlgoImpl = serde_json::from_value(bare.clone()).unwrap();
        assert_eq!(im2.kind, None);
        assert!(serde_json::to_value(&im2).unwrap().get("kind").is_none(), "no empty kind key emitted");

        // `bsc graph impl set --kind` (via set_impl) persists it.
        let mut g = seed();
        set_impl(&mut g, serde_json::json!({
            "id": "quick-sort.rs", "tech": "rust", "role": "algorithm", "name": "quick_sort",
            "composes": [], "code": "//", "kind": "sort"
        })).unwrap();
        let stored = implementations_of(&g).into_iter().find(|im| im["id"] == "quick-sort.rs").unwrap();
        assert_eq!(stored["kind"], "sort");
    }

    #[test]
    fn algo_impl_viz_code_facet_is_additive_round_trips_and_persists_via_set_impl() {
        // Present (stored as `vizCode`) → deserializes to `viz_code` + re-serializes unchanged.
        let json = serde_json::json!({
            "id": "merge-sort.rs", "tech": "rust", "role": "algorithm", "name": "merge_sort",
            "composes": [], "code": "// rust ref", "vizCode": "function run(a){ a.markSorted(); }"
        });
        let im: AlgoImpl = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(im.viz_code.as_deref(), Some("function run(a){ a.markSorted(); }"));
        assert_eq!(serde_json::to_value(&im).unwrap(), json, "the vizCode facet round-trips");

        // Absent → None, and no empty `vizCode` key is emitted.
        let bare = serde_json::json!({ "id": "x.rs", "tech": "rust", "role": "algorithm", "name": "x", "composes": [], "code": "//" });
        let im2: AlgoImpl = serde_json::from_value(bare).unwrap();
        assert_eq!(im2.viz_code, None);
        assert!(serde_json::to_value(&im2).unwrap().get("vizCode").is_none(), "no empty vizCode key emitted");

        // `bsc graph impl set --viz-code` (via set_impl) persists it under `vizCode`.
        let mut g = seed();
        set_impl(&mut g, serde_json::json!({
            "id": "route.ts", "tech": "typescript", "role": "algorithm", "name": "route",
            "composes": [], "code": "//", "vizCode": "function run(a){}"
        })).unwrap();
        let stored = implementations_of(&g).into_iter().find(|im| im["id"] == "route.ts").unwrap();
        assert_eq!(stored["vizCode"], "function run(a){}");
    }

    #[test]
    fn set_impl_persists_the_domain_facet_through_the_store() {
        // `bsc graph impl set --domain` writes `domain`/`tags` onto the impl; save→load preserves them.
        let mut g = seed();
        // A test-only id NOT in the packaged seed — the seed now carries its own `logistics` domain
        // collection incl. `dijkstra.rs` (#3120), so a unique id keeps this a genuine INSERT.
        let inserted = set_impl(&mut g, serde_json::json!({
            "id": "logistics-test.rs", "tech": "rust", "role": "algorithm", "name": "logistics-test",
            "composes": [], "code": "// test", "domain": "logistics", "tags": ["graph"]
        })).unwrap();
        assert!(!inserted, "a new impl inserts");
        let stored = implementations_of(&g).into_iter().find(|im| im["id"] == "logistics-test.rs").unwrap();
        assert_eq!(stored["domain"], "logistics");
        assert_eq!(stored["tags"], serde_json::json!(["graph"]));

        let tmp = crate::unique_temp("domain").with_extension("json");
        save_at(&tmp, &g).unwrap();
        let reloaded = implementations_of(&load_at(&tmp)).into_iter().find(|im| im["id"] == "logistics-test.rs").unwrap();
        assert_eq!(reloaded["domain"], "logistics", "the domain survives a save/load round-trip");
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn impl_in_domain_filters_the_list_and_ignores_untagged_impls() {
        // The predicate behind `impl list --domain` — matches only impls tagged with that domain, ACROSS
        // languages, and never the untagged seed impls (so the filter is purely additive).
        let mut g = seed();
        // Unique test ids across two languages (the packaged seed now carries its OWN `logistics`/
        // `graphics` domain collections, #3120, so assertions are membership-based, not exact counts).
        set_impl(&mut g, serde_json::json!({ "id": "test-dijkstra.rs", "tech": "rust", "role": "algorithm", "name": "test-dijkstra", "composes": [], "code": "//", "domain": "logistics" })).unwrap();
        set_impl(&mut g, serde_json::json!({ "id": "test-route.ts", "tech": "typescript", "role": "algorithm", "name": "test-route", "composes": [], "code": "//", "domain": "logistics" })).unwrap();
        set_impl(&mut g, serde_json::json!({ "id": "test-blur.ts", "tech": "typescript", "role": "algorithm", "name": "test-blur", "composes": [], "code": "//", "domain": "graphics" })).unwrap();

        let logistics: Vec<Value> = implementations_of(&g).into_iter().filter(|im| impl_in_domain(im, "logistics")).collect();
        // The collection cross-cuts language: both the rust and typescript impls we tagged are in it…
        assert!(logistics.iter().any(|im| im["id"] == "test-dijkstra.rs"), "rust logistics impl is in the collection");
        assert!(logistics.iter().any(|im| im["id"] == "test-route.ts"), "typescript logistics impl is in the collection");
        // …every member really carries the domain (the predicate never over-matches)…
        assert!(logistics.iter().all(|im| im["domain"] == "logistics"));
        // …and the graphics impl is in graphics, never logistics.
        assert!(!logistics.iter().any(|im| im["id"] == "test-blur.ts"), "a graphics impl is not in the logistics collection");
        assert!(implementations_of(&g).into_iter().filter(|im| impl_in_domain(im, "graphics")).any(|im| im["id"] == "test-blur.ts"));
        // A seed impl (no domain) is never in a domain collection; an unknown domain matches nothing.
        assert!(!impl_in_domain(&serde_json::json!({ "id": "merge.rs" }), "logistics"), "an untagged impl never matches");
        assert_eq!(implementations_of(&g).into_iter().filter(|im| impl_in_domain(im, "nope")).count(), 0);
    }

    // ── #3198 seed reconcile — the writable store must not shadow packaged algorithms ──

    /// A store id absent from the seed. Seeded (`_stale_store`) with the Rust kit only, mimicking a
    /// store written before the TypeScript impls were packaged.
    fn stale_rust_only_store() -> Value {
        let full = seed();
        let rust_only: Vec<Value> = implementations_of(&full)
            .into_iter()
            .filter(|im| im.get("tech").and_then(Value::as_str) == Some("rust"))
            .collect();
        serde_json::json!({ "implementations": rust_only })
    }

    #[test]
    fn reconcile_appends_seed_impls_the_store_lacks() {
        // A store written before `sort.ts`/`fibonacci.ts` were packaged (Rust-only) gets them back.
        let mut g = stale_rust_only_store();
        assert!(!implementations_of(&g).iter().any(|im| im["id"] == "sort.ts"), "the stale store lacks sort.ts");
        let changed = reconcile_seed(&mut g);
        assert!(changed, "reconcile added the missing seed impls");
        for id in ["sort.ts", "fibonacci.ts", "typescript.number"] {
            assert!(
                implementations_of(&g).iter().any(|im| im["id"] == id),
                "the packaged '{id}' now surfaces after reconcile",
            );
        }
    }

    #[test]
    fn reconcile_is_a_noop_when_the_store_already_has_every_seed_impl() {
        // A store equal to the seed is unchanged (no duplicates, no churn).
        let mut g = seed();
        let n0 = implementations_of(&g).len();
        assert!(!reconcile_seed(&mut g), "nothing to add → no change");
        assert_eq!(implementations_of(&g).len(), n0, "no duplicate impls appended");
    }

    #[test]
    fn reconcile_never_overwrites_a_user_edit_to_a_seed_impl() {
        // A store whose impl shares a seed id but differs (a librarian edit) is KEPT verbatim — reconcile
        // only fills GAPS by id, it never clobbers an existing impl.
        let mut g = seed();
        set_impl(&mut g, serde_json::json!({
            "id": "sort.ts", "tech": "typescript", "role": "algorithm", "name": "sort (my edit)",
            "composes": [], "code": "// hand-tuned"
        })).unwrap();
        reconcile_seed(&mut g);
        let sort = implementations_of(&g).into_iter().find(|im| im["id"] == "sort.ts").unwrap();
        assert_eq!(sort["name"], "sort (my edit)", "the user's edit survives reconcile");
        assert_eq!(sort["code"], "// hand-tuned");
        assert_eq!(
            implementations_of(&g).iter().filter(|im| im["id"] == "sort.ts").count(),
            1,
            "no duplicate is appended for an id already present",
        );
    }

    #[test]
    fn reconcile_leaves_custom_non_seed_impls_untouched() {
        // A harvested/custom impl (not in the seed) is neither removed nor duplicated by reconcile.
        let mut g = stale_rust_only_store();
        set_impl(&mut g, serde_json::json!({
            "id": "my-thing.ts", "tech": "typescript", "role": "algorithm", "name": "myThing", "composes": [], "code": "//"
        })).unwrap();
        reconcile_seed(&mut g);
        assert_eq!(
            implementations_of(&g).iter().filter(|im| im["id"] == "my-thing.ts").count(),
            1,
            "the custom impl is preserved exactly once",
        );
    }

    #[test]
    fn reconcile_re_adds_a_removed_seed_impl_so_seed_algorithms_are_recoverable() {
        // Deleting a seed impl does not stick — the next reconcile re-adds it (the "undeletable / at least
        // recoverable" behavior). A custom impl removed the same way stays gone (see the test above).
        let mut g = seed();
        assert!(remove_impl(&mut g, "sort.ts"), "sort.ts existed");
        assert!(!implementations_of(&g).iter().any(|im| im["id"] == "sort.ts"), "it's gone after remove");
        assert!(reconcile_seed(&mut g), "reconcile re-added the removed seed impl");
        assert!(
            implementations_of(&g).iter().any(|im| im["id"] == "sort.ts"),
            "the seed algorithm is recoverable — it returns on the next load",
        );
    }

    #[test]
    fn load_path_reconciles_a_stale_store_on_disk() {
        // The end-to-end guard: a stale store file on disk, read via `load_at` + reconcile (what `load()`
        // does), yields the packaged TypeScript impls — the exact bug ("I only see rust algorithms").
        let tmp = crate::unique_temp("reconcile").with_extension("json");
        save_at(&tmp, &stale_rust_only_store()).unwrap();
        let mut on_disk = load_at(&tmp); // store-or-seed (no reconcile) — the stale store
        assert!(!implementations_of(&on_disk).iter().any(|im| im["id"] == "sort.ts"), "raw load is stale");
        reconcile_seed(&mut on_disk); // what load() layers on top
        assert!(
            implementations_of(&on_disk).iter().any(|im| im["id"] == "sort.ts"),
            "load() surfaces the packaged algorithm from a stale on-disk store",
        );
        let _ = std::fs::remove_file(&tmp);
    }

    // ── #3212 doctor — visualization typing + coverage diagnosis ──

    fn algo(id: &str, extra: Value) -> Value {
        let mut im = serde_json::json!({ "id": id, "tech": "typescript", "role": "algorithm", "name": id, "composes": [], "code": "//" });
        if let Value::Object(o) = extra {
            for (k, v) in o {
                im[k] = v;
            }
        }
        im
    }

    #[test]
    fn base_name_mirrors_program_key() {
        // Strip the extension, lowercase, unify separators — merge-sort.rs / merge_sort → merge-sort.
        assert_eq!(base_name("merge-sort.rs"), "merge-sort");
        assert_eq!(base_name("Merge_Sort"), "merge-sort");
        assert_eq!(base_name("bfs.ts"), "bfs");
        assert_eq!(base_name("topological-sort.rs"), "topological-sort");
        assert_eq!(base_name("a-star.rs"), "a-star");
    }

    #[test]
    fn classify_kind_reads_name_id_tags_then_code() {
        let t = |v: Value| classify_kind(&v);
        // *-first-search → traversal (before the sort family swallows it).
        assert_eq!(t(algo("breadth-first-search.ts", serde_json::json!({}))), Some("traversal"));
        assert_eq!(t(algo("bfs.ts", serde_json::json!({}))), Some("traversal"));
        // topological-SORT is a sort by name.
        assert_eq!(t(algo("topological-sort.ts", serde_json::json!({}))), Some("sort"));
        assert_eq!(t(algo("quick-sort.ts", serde_json::json!({}))), Some("sort"));
        assert_eq!(t(algo("transpose.ts", serde_json::json!({}))), Some("transform"));
        assert_eq!(t(algo("binary-search.ts", serde_json::json!({}))), Some("search"));
        assert_eq!(t(algo("fibonacci.ts", serde_json::json!({}))), Some("accumulate"));
        // A tag can drive the classification when the name is opaque.
        assert_eq!(t(algo("thing.ts", serde_json::json!({ "tags": ["sorting"] }))), Some("sort"));
        // Fallback to a light code hint: mid+lo/hi → search; swap → sort.
        assert_eq!(t(algo("mystery.ts", serde_json::json!({ "code": "let mid = (lo+hi)/2" }))), Some("search"));
        assert_eq!(t(algo("mystery2.ts", serde_json::json!({ "code": "swap(a,b)" }))), Some("sort"));
        // Truly opaque → None (never guesses).
        assert_eq!(t(algo("zzz.ts", serde_json::json!({ "code": "return 1" }))), None);
    }

    #[test]
    fn doctor_flags_untyped_invalid_mistyped_and_missing_viz() {
        let g = serde_json::json!({ "implementations": [
            // primitives are skipped entirely
            { "id": "typescript.number", "tech": "typescript", "role": "primitive", "name": "number", "ref": "number", "composes": [] },
            // untyped but classifiable (bfs → traversal) AND has an in-app program → only the `untyped` finding
            algo("bfs.ts", serde_json::json!({})),
            // typed correctly + has a program → clean, no finding
            algo("quick-sort.ts", serde_json::json!({ "kind": "sort" })),
            // kind not in the vocabulary
            algo("weird.ts", serde_json::json!({ "kind": "bogus", "vizCode": "function run(){}" })),
            // mistyped: named a sort but tagged search
            algo("heap-sort.ts", serde_json::json!({ "kind": "search" })),
            // typed fine but no program and no vizCode → missing-viz
            algo("bellman-ford.ts", serde_json::json!({ "kind": "traversal" })),
        ]});
        let fs = doctor(&g);
        let by = |cat: &str| fs.iter().filter(|f| f.category == cat).map(|f| f.id.as_str()).collect::<Vec<_>>();

        assert_eq!(by("untyped"), ["bfs.ts"], "only the untyped impl is flagged untyped");
        assert!(fs.iter().find(|f| f.id == "bfs.ts").unwrap().suggestion.as_deref().unwrap().contains("traversal"), "the untyped finding suggests the inferred kind");
        assert_eq!(by("invalid-kind"), ["weird.ts"]);
        assert_eq!(by("mistyped"), ["heap-sort.ts"]);
        assert_eq!(by("missing-viz"), ["bellman-ford.ts"], "only the impl with neither program nor vizCode");
        // The primitive and the clean, program-backed sort produce nothing.
        assert!(!fs.iter().any(|f| f.id == "typescript.number"), "primitives are never diagnosed");
        assert!(!fs.iter().any(|f| f.id == "quick-sort.ts"), "a correctly-typed, program-backed algorithm is clean");
    }

    #[test]
    fn doctor_treats_a_stored_viz_code_as_visualization_coverage() {
        // An impl with no in-app program is NOT missing-viz once it carries a (non-empty) vizCode.
        let g = serde_json::json!({ "implementations": [
            algo("custom.ts", serde_json::json!({ "kind": "sort", "vizCode": "function run(a){ a.mark(0); }" })),
            algo("blank.ts", serde_json::json!({ "kind": "sort", "vizCode": "   " })),
        ]});
        let fs = doctor(&g);
        assert!(!fs.iter().any(|f| f.id == "custom.ts" && f.category == "missing-viz"), "a real vizCode counts as coverage");
        assert!(fs.iter().any(|f| f.id == "blank.ts" && f.category == "missing-viz"), "a whitespace-only vizCode does NOT count");
    }

    #[test]
    fn generic_sort_is_a_known_program_not_missing_viz() {
        // Regression (#3237): `TRACE_PROGRAMS` has an (unquoted) `sort:` entry, so `sort.ts` animates in-app
        // even without a stored vizCode. VIZ_PROGRAMS must include "sort" so the doctor does NOT
        // false-positive it as missing-viz.
        assert!(VIZ_PROGRAMS.contains(&"sort"), "the generic `sort` program is a known viz");
        let g = serde_json::json!({ "implementations": [
            algo("sort.ts", serde_json::json!({ "kind": "sort" })), // typed, NO vizCode
        ]});
        let fs = doctor(&g);
        assert!(!fs.iter().any(|f| f.id == "sort.ts"), "sort.ts is fully covered by its in-app program — no findings");
    }

    // ── #4107 folder facet ──

    /// An impl authored before the folder existed must survive a round trip untouched — the same
    /// additive contract `domain`/`tags` established (#3120). If it did not, every seeded impl would
    /// gain empty `src`/`folder` keys the moment anything re-saved the store.
    #[test]
    fn algo_impl_without_src_or_folder_round_trips_unchanged() {
        let raw = serde_json::json!({
            "id": "merge.rs", "tech": "rust", "role": "algorithm", "name": "merge",
            "composes": ["rust.vec"],
        });
        let parsed: AlgoImpl = serde_json::from_value(raw.clone()).unwrap();
        assert!(parsed.src.is_none() && parsed.folder.is_none());
        assert_eq!(serde_json::to_value(&parsed).unwrap(), raw, "no empty src/folder keys appear");
    }

    /// The folder is the SAME derivation components use — that is the whole point of putting it in
    /// `bsc-util`. Pinned here so a change on either side has to break this test to diverge.
    #[test]
    fn the_algorithm_folder_is_the_component_derivation() {
        assert_eq!(
            bsc_util::folder_from_src("crates/bsc-graph/src/extract.rs").as_deref(),
            Some("crates/bsc-graph/src"),
        );
        // Harvest is 1:1 — a crate scanned at its OWN root makes `src/` the root, so a file directly
        // under it is unfoldered, exactly as a component directly under `src/` is.
        assert_eq!(bsc_util::folder_from_src("src/cli.rs"), None);
    }

    /// `folder` and `domain` are different axes and must not be conflated: `domain_of` COLLAPSES a
    /// path to one segment for the cross-language filter, the folder keeps the full nesting.
    #[test]
    fn folder_keeps_the_nesting_domain_collapses() {
        let src = "src-tauri/src/console/pty/job.rs";
        assert_eq!(bsc_util::folder_from_src(src).as_deref(), Some("src-tauri/src/console/pty"));
        assert_ne!(crate::extract::domain_of(src), "src-tauri/src/console/pty");
    }
}

#[cfg(test)]
mod merge_tests {
    use super::*;
    use serde_json::json;

    fn base() -> Value {
        let mut g = json!({ "implementations": [] });
        set_impl(&mut g, json!({
            "id": "t.ts", "tech": "typescript", "role": "algorithm", "name": "t",
            "composes": ["typescript.number"], "code": "// real",
            "src": "features/x/t.ts", "folder": "features/x",
            "tests": [{ "name": "t suite", "src": "…" }], "vizCode": "({})"
        })).unwrap();
        g
    }
    fn rec(g: &Value) -> Value {
        implementations_of(g).into_iter().find(|i| i["id"] == "t.ts").unwrap().clone()
    }

    #[test]
    fn a_partial_write_preserves_every_field_it_did_not_supply() {
        // #4154 / requests #49 + #50: this used to be `*existing = im`, so a domain-only edit deleted
        // `folder`, `src`, `tests` and `vizCode` outright. `tests` has no flag AT ALL, so every write
        // dropped it — which stalled a reorg across 16 entries carrying real vitest suites.
        let mut g = base();
        set_impl(&mut g, json!({ "id": "t.ts", "tech": "typescript", "role": "algorithm", "name": "t", "domain": "d" })).unwrap();
        let r = rec(&g);
        assert_eq!(r["domain"], "d", "the supplied field is written");
        assert_eq!(r["src"], "features/x/t.ts", "provenance survives");
        assert_eq!(r["folder"], "features/x");
        assert_eq!(r["tests"][0]["name"], "t suite", "the unflagged field survives");
        assert_eq!(r["vizCode"], "({})");
        assert_eq!(r["composes"][0], "typescript.number", "an omitted composes is not blanked");
        assert_eq!(r["code"], "// real");
    }

    #[test]
    fn a_supplied_field_still_overwrites() {
        // Merging must not make a write inert — the whole point is that it changes what you asked for.
        let mut g = base();
        set_impl(&mut g, json!({ "id": "t.ts", "tech": "typescript", "role": "algorithm", "name": "t2", "code": "// new" })).unwrap();
        let r = rec(&g);
        assert_eq!(r["name"], "t2");
        assert_eq!(r["code"], "// new");
    }

    #[test]
    fn a_null_removes_the_field_so_deletion_is_still_possible() {
        // With merge, omission can no longer mean removal — so `--clear` sends a null and this drops it.
        let mut g = base();
        set_impl(&mut g, json!({ "id": "t.ts", "tech": "typescript", "role": "algorithm", "name": "t", "vizCode": null })).unwrap();
        let r = rec(&g);
        assert!(r.get("vizCode").is_none(), "cleared outright, not left as a null");
        assert_eq!(r["src"], "features/x/t.ts", "clearing one field touches no other");
    }

    #[test]
    fn a_new_impl_still_gets_the_required_composes_array() {
        // The CLI now omits `composes` unless supplied, so an INSERT must still land the shape the model
        // expects rather than a record missing a required field.
        let mut g = json!({ "implementations": [] });
        let inserted = set_impl(&mut g, json!({ "id": "n.ts", "tech": "typescript", "role": "algorithm", "name": "n" })).unwrap();
        assert!(!inserted, "a new id inserts");
        let r = implementations_of(&g).into_iter().find(|i| i["id"] == "n.ts").unwrap().clone();
        assert_eq!(r["composes"], json!([]));
    }
}
