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

/// The runtime graph — the writable store (store-or-seed). Every reader resolves against this, so a
/// read after a write reflects the write.
pub fn load() -> Value {
    match store_path() {
        Some(p) => load_at(&p),
        None => seed(),
    }
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
    /// The DOMAIN facet (#3120) — the cross-language collection this impl belongs to (e.g. "logistics").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    /// Free-form tags (#3120) — additive keywords for cross-cutting collections.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
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
        *existing = im;
        Ok(true)
    } else {
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
    fn set_impl_persists_the_domain_facet_through_the_store() {
        // `bsc graph impl set --domain` writes `domain`/`tags` onto the impl; save→load preserves them.
        let mut g = seed();
        let inserted = set_impl(&mut g, serde_json::json!({
            "id": "dijkstra.rs", "tech": "rust", "role": "algorithm", "name": "dijkstra",
            "composes": [], "code": "// dijkstra", "domain": "logistics", "tags": ["graph"]
        })).unwrap();
        assert!(!inserted, "a new impl inserts");
        let stored = implementations_of(&g).into_iter().find(|im| im["id"] == "dijkstra.rs").unwrap();
        assert_eq!(stored["domain"], "logistics");
        assert_eq!(stored["tags"], serde_json::json!(["graph"]));

        let tmp = std::env::temp_dir().join(format!(
            "bsc-graph-domain-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0),
        ));
        save_at(&tmp, &g).unwrap();
        let reloaded = implementations_of(&load_at(&tmp)).into_iter().find(|im| im["id"] == "dijkstra.rs").unwrap();
        assert_eq!(reloaded["domain"], "logistics", "the domain survives a save/load round-trip");
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn impl_in_domain_filters_the_list_and_ignores_untagged_impls() {
        // The predicate behind `impl list --domain` — matches only impls tagged with that domain, ACROSS
        // languages, and never the untagged seed impls (so the filter is purely additive).
        let mut g = seed();
        set_impl(&mut g, serde_json::json!({ "id": "dijkstra.rs", "tech": "rust", "role": "algorithm", "name": "dijkstra", "composes": [], "code": "//", "domain": "logistics" })).unwrap();
        set_impl(&mut g, serde_json::json!({ "id": "route.ts", "tech": "typescript", "role": "algorithm", "name": "route", "composes": [], "code": "//", "domain": "logistics" })).unwrap();
        set_impl(&mut g, serde_json::json!({ "id": "blur.ts", "tech": "typescript", "role": "algorithm", "name": "blur", "composes": [], "code": "//", "domain": "graphics" })).unwrap();

        let logistics: Vec<Value> = implementations_of(&g).into_iter().filter(|im| impl_in_domain(im, "logistics")).collect();
        assert_eq!(logistics.len(), 2, "the logistics collection cross-cuts language (rust + typescript)");
        assert!(logistics.iter().all(|im| im["domain"] == "logistics"));
        assert_eq!(implementations_of(&g).into_iter().filter(|im| impl_in_domain(im, "graphics")).count(), 1);
        // A seed impl (no domain) is never in a domain collection; an unknown domain matches nothing.
        assert!(!impl_in_domain(&serde_json::json!({ "id": "merge.rs" }), "logistics"), "an untagged impl never matches");
        assert_eq!(implementations_of(&g).into_iter().filter(|im| impl_in_domain(im, "nope")).count(), 0);
    }
}
