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

pub mod cli;
pub mod extract;

use serde_json::Value;
use std::path::{Path, PathBuf};

/// The packaged seed — the SAME file the frontend reads via `@data/knowledge/algorithms.json`.
pub const GRAPH_JSON: &str = include_str!("../../../src-tauri/data/knowledge/algorithms.json");

/// The tiers an implementation may carry (#2863) — validated on `impl set`. A `primitive` is a LANGUAGE
/// built-in (free-standing); an `algorithm` composes them up.
pub const ROLES: [&str; 2] = ["primitive", "algorithm"];

/// Parse the embedded packaged seed. Panics only if the packaged JSON is malformed — a build-time
/// invariant the tests guard.
pub fn seed() -> Value {
    serde_json::from_str(GRAPH_JSON).expect("packaged algorithms.json is valid JSON")
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
    let have: std::collections::HashSet<String> = implementations_of(g)
        .iter()
        .filter_map(|im| im.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let missing: Vec<Value> = implementations_of(&seed())
        .into_iter()
        .filter(|im| {
            im.get("id").and_then(Value::as_str).map(|id| !have.contains(id)).unwrap_or(false)
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
}

/// The implementation objects of the runtime graph (store-or-seed).
pub fn implementations() -> Vec<Value> {
    implementations_of(&load())
}

/// The implementation objects of `g`.
pub fn implementations_of(g: &Value) -> Vec<Value> {
    g.get("implementations").and_then(Value::as_array).cloned().unwrap_or_default()
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
pub fn set_impl(g: &mut Value, im: Value) -> Result<bool, String> {
    let id = im
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("an implementation needs a non-empty `id`")?
        .to_string();
    im.get("tech")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("an implementation needs a `tech` (the language kit)")?;
    let role = im.get("role").and_then(Value::as_str).ok_or("an implementation needs a `role`")?;
    if !ROLES.contains(&role) {
        return Err(format!("unknown role '{role}' — want one of: {}", ROLES.join(" | ")));
    }
    let arr = ensure_array(g, "implementations");
    if let Some(existing) = arr.iter_mut().find(|x| x.get("id").and_then(Value::as_str) == Some(id.as_str())) {
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
        Ok(true)
    } else {
        // A NEW impl still needs the shape the model expects: `composes` is a required array, and the
        // CLI now omits it unless `--composes` was given (so an edit cannot blank it).
        let mut im = im;
        if im.get("composes").is_none() {
            im["composes"] = Value::Array(Vec::new());
        }
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
    remove_impl(g, from); // remove `from` (its refs are already repointed; scrub is a harmless no-op)
    Ok(repointed)
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
    let mut out = Vec::new();
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
    use super::*;

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
        let tmp = std::env::temp_dir().join(format!(
            "bsc-graph-store-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0),
        ));
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
        // The FleetPage dashboard's harvested algorithms (#3462/#3465) form a discoverable "fleet"
        // collection (#3607) — in the graph but ungrouped until tagged, so `bsc graph` surfaced none.
        let mut fleet = in_domain("fleet");
        fleet.sort();
        assert_eq!(
            fleet,
            ["group-totals.ts", "llm-energy.ts", "order-by-rank.ts", "precedence-resolve.ts", "stream-merge.ts", "windowed-tally.ts"],
            "the fleet collection is the FleetPage dashboard's harvested algorithms"
        );

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

        let tmp = std::env::temp_dir().join(format!(
            "bsc-graph-domain-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0),
        ));
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
        let tmp = std::env::temp_dir().join(format!(
            "bsc-graph-reconcile-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0),
        ));
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
