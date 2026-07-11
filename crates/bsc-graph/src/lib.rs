//! The Algorithms knowledge graph (#2760/#2761/#2853) — "Graph 1", the curated concept ontology (data
//! structures, algorithms, concepts, outputs) joined by typed relationships. Seeded from the packaged
//! `src-tauri/data/knowledge/algorithms.json` (the SAME file the frontend imports), then WRITABLE on
//! disk (#2853): the knowledge librarian curates it via `bsc graph`. The store at
//! `~/.base-studio-code/knowledge/algorithms.json` (env `BSC_GRAPH_STORE`) is the runtime source of
//! truth — seeded from the embedded copy on first read, mutated by `set`/`link`/`unlink`/`remove`, so a
//! read after a write reflects the write ("verify after every write"). Phase 2 (#2745) layers the
//! extracted-from-code `implements` join on top.

pub mod cli;
pub mod extract;

use serde_json::Value;
use std::path::{Path, PathBuf};

/// The packaged seed — the SAME file the frontend reads via `@data/knowledge/algorithms.json`.
pub const GRAPH_JSON: &str = include_str!("../../../src-tauri/data/knowledge/algorithms.json");

/// The node `kind`s the curated ontology admits — validated on `set` so the graph stays consistent
/// with what the frontend styles by.
pub const KINDS: [&str; 4] = ["data-structure", "algorithm", "concept", "output"];
/// The relationship `rel`s an edge may carry — validated on `link` for the same reason.
pub const RELS: [&str; 5] = ["operates-on", "composes", "variant-of", "generates", "related-to"];

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

// ── runtime readers — resolve against the writable store (`load()`), so reads reflect writes ──

/// The runtime graph document (store-or-seed).
pub fn graph() -> Value {
    load()
}
/// The node objects.
pub fn nodes() -> Vec<Value> {
    nodes_of(&load())
}
/// The edge objects.
pub fn edges() -> Vec<Value> {
    edges_of(&load())
}
/// The implementation objects (#2770) — the per-tech tier over the concept spine.
pub fn implementations() -> Vec<Value> {
    implementations_of(&load())
}
/// A node by id, or None.
pub fn node(id: &str) -> Option<Value> {
    node_of(&load(), id)
}
/// The relationships incident to `id` (see [`neighbors_of`]).
pub fn neighbors(id: &str) -> Vec<Value> {
    neighbors_of(&load(), id)
}
/// The shortest relationship path between two ids (see [`path_of`]).
pub fn path(a: &str, b: &str) -> Option<Vec<String>> {
    path_of(&load(), a, b)
}
/// The implementation of `concept` in `tech`, or None.
pub fn implementation(concept: &str, tech: &str) -> Option<Value> {
    implementation_of(&load(), concept, tech)
}
/// The techs that carry an implementation of `concept`, in order (deduplicated).
pub fn techs_with_impl(concept: &str) -> Vec<String> {
    techs_with_impl_of(&load(), concept)
}

// ── pure query fns over a given graph document (testable against `seed()`) ──

/// The node objects of `g`.
pub fn nodes_of(g: &Value) -> Vec<Value> {
    g.get("nodes").and_then(Value::as_array).cloned().unwrap_or_default()
}
/// The edge objects of `g`.
pub fn edges_of(g: &Value) -> Vec<Value> {
    g.get("edges").and_then(Value::as_array).cloned().unwrap_or_default()
}
/// The implementation objects of `g`.
pub fn implementations_of(g: &Value) -> Vec<Value> {
    g.get("implementations").and_then(Value::as_array).cloned().unwrap_or_default()
}
/// A node of `g` by id, or None.
pub fn node_of(g: &Value, id: &str) -> Option<Value> {
    nodes_of(g).into_iter().find(|n| n.get("id").and_then(Value::as_str) == Some(id))
}
/// The implementation of `concept` in `tech` (matching on both fields) within `g`, or None.
pub fn implementation_of(g: &Value, concept: &str, tech: &str) -> Option<Value> {
    implementations_of(g).into_iter().find(|im| {
        im.get("concept").and_then(Value::as_str) == Some(concept)
            && im.get("tech").and_then(Value::as_str) == Some(tech)
    })
}
/// The techs that carry an implementation of `concept` within `g`, in order (deduplicated).
pub fn techs_with_impl_of(g: &Value, concept: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for im in implementations_of(g) {
        if im.get("concept").and_then(Value::as_str) == Some(concept) {
            if let Some(t) = im.get("tech").and_then(Value::as_str) {
                if !out.iter().any(|x| x == t) {
                    out.push(t.to_string());
                }
            }
        }
    }
    out
}
/// The relationships incident to `id` within `g`: one `{ rel, dir: "out"|"in", node: <the other node> }`
/// per edge touching it. `dir` is "out" when `id` is the edge's `from`, "in" when it is the `to`.
pub fn neighbors_of(g: &Value, id: &str) -> Vec<Value> {
    let ns = nodes_of(g);
    let by = |nid: &str| ns.iter().find(|n| n.get("id").and_then(Value::as_str) == Some(nid)).cloned();
    let mut out = Vec::new();
    for e in edges_of(g) {
        let from = e.get("from").and_then(Value::as_str).unwrap_or_default();
        let to = e.get("to").and_then(Value::as_str).unwrap_or_default();
        let rel = e.get("rel").and_then(Value::as_str).unwrap_or_default();
        if from == id {
            if let Some(other) = by(to) { out.push(serde_json::json!({ "rel": rel, "dir": "out", "node": other })); }
        } else if to == id {
            if let Some(other) = by(from) { out.push(serde_json::json!({ "rel": rel, "dir": "in", "node": other })); }
        }
    }
    out
}
/// Shortest relationship path between two node ids within `g` — BFS over the UNDIRECTED graph
/// (relationships are navigable both ways), inclusive of both ends. `None` if unreachable or unknown.
pub fn path_of(g: &Value, a: &str, b: &str) -> Option<Vec<String>> {
    use std::collections::{HashMap, HashSet, VecDeque};
    let known: HashSet<String> =
        nodes_of(g).iter().filter_map(|n| n.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
    if !known.contains(a) || !known.contains(b) {
        return None;
    }
    if a == b {
        return Some(vec![a.to_string()]);
    }
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    for e in edges_of(g) {
        if let (Some(f), Some(t)) = (e.get("from").and_then(Value::as_str), e.get("to").and_then(Value::as_str)) {
            adj.entry(f.to_string()).or_default().push(t.to_string());
            adj.entry(t.to_string()).or_default().push(f.to_string());
        }
    }
    let mut prev: HashMap<String, String> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::from([a.to_string()]);
    let mut q: VecDeque<String> = VecDeque::from([a.to_string()]);
    while let Some(cur) = q.pop_front() {
        for next in adj.get(&cur).into_iter().flatten() {
            if seen.contains(next) {
                continue;
            }
            seen.insert(next.clone());
            prev.insert(next.clone(), cur.clone());
            if next == b {
                let mut chain = vec![b.to_string()];
                let mut step = b.to_string();
                while step != a {
                    step = prev[&step].clone();
                    chain.push(step.clone());
                }
                chain.reverse();
                return Some(chain);
            }
            q.push_back(next.clone());
        }
    }
    None
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

/// Upsert a node by id — replaces a same-id node, else appends. Validates a non-empty `id` + a known
/// `kind`. Returns `true` when it replaced an existing node, `false` when it inserted a new one.
pub fn set_node(g: &mut Value, node: Value) -> Result<bool, String> {
    let id = node
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("a node needs a non-empty `id`")?
        .to_string();
    let kind = node.get("kind").and_then(Value::as_str).ok_or("a node needs a `kind`")?;
    if !KINDS.contains(&kind) {
        return Err(format!("unknown kind '{kind}' — want one of: {}", KINDS.join(" | ")));
    }
    let arr = ensure_array(g, "nodes");
    if let Some(existing) = arr.iter_mut().find(|n| n.get("id").and_then(Value::as_str) == Some(id.as_str())) {
        *existing = node;
        Ok(true)
    } else {
        arr.push(node);
        Ok(false)
    }
}

/// Remove a node and every edge + implementation referencing it. Returns `None` when the node did not
/// exist, else `Some((edges_removed, impls_removed))`.
pub fn remove_node(g: &mut Value, id: &str) -> Option<(usize, usize)> {
    let existed = {
        let nodes = ensure_array(g, "nodes");
        let before = nodes.len();
        nodes.retain(|n| n.get("id").and_then(Value::as_str) != Some(id));
        nodes.len() != before
    };
    if !existed {
        return None;
    }
    let edges_removed = {
        let edges = ensure_array(g, "edges");
        let before = edges.len();
        edges.retain(|e| {
            e.get("from").and_then(Value::as_str) != Some(id)
                && e.get("to").and_then(Value::as_str) != Some(id)
        });
        before - edges.len()
    };
    let impls_removed = {
        let impls = ensure_array(g, "implementations");
        let before = impls.len();
        impls.retain(|im| im.get("concept").and_then(Value::as_str) != Some(id));
        before - impls.len()
    };
    Some((edges_removed, impls_removed))
}

/// Add a `from`→`to` edge carrying `rel`. Errors on an unknown endpoint or an unknown relationship;
/// idempotent — returns `Ok(false)` when the exact edge already exists, `Ok(true)` when it was added.
pub fn link(g: &mut Value, from: &str, to: &str, rel: &str) -> Result<bool, String> {
    if !RELS.contains(&rel) {
        return Err(format!("unknown relationship '{rel}' — want one of: {}", RELS.join(" | ")));
    }
    for (which, id) in [("from", from), ("to", to)] {
        if node_of(g, id).is_none() {
            return Err(format!("{which} node '{id}' does not exist — add it first with `set`"));
        }
    }
    let edges = ensure_array(g, "edges");
    let exists = edges.iter().any(|e| {
        e.get("from").and_then(Value::as_str) == Some(from)
            && e.get("to").and_then(Value::as_str) == Some(to)
            && e.get("rel").and_then(Value::as_str) == Some(rel)
    });
    if exists {
        return Ok(false);
    }
    edges.push(serde_json::json!({ "from": from, "to": to, "rel": rel }));
    Ok(true)
}

/// Remove every `from`→`to` edge (matching `rel` too when given). Returns how many were removed.
pub fn unlink(g: &mut Value, from: &str, to: &str, rel: Option<&str>) -> usize {
    let edges = ensure_array(g, "edges");
    let before = edges.len();
    edges.retain(|e| {
        let matches = e.get("from").and_then(Value::as_str) == Some(from)
            && e.get("to").and_then(Value::as_str) == Some(to)
            && rel.is_none_or(|r| e.get("rel").and_then(Value::as_str) == Some(r));
        !matches
    });
    before - edges.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_parses_with_nodes_edges_and_lookups() {
        let g = seed();
        assert!(nodes_of(&g).len() > 30, "the seed has a real ontology");
        assert!(edges_of(&g).len() > 30);
        assert!(node_of(&g, "merge-sort").is_some());
        assert!(node_of(&g, "nope").is_none());
    }

    #[test]
    fn every_edge_references_a_known_node() {
        let g = seed();
        let ids: std::collections::HashSet<String> =
            nodes_of(&g).iter().filter_map(|n| n.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
        for e in edges_of(&g) {
            for k in ["from", "to"] {
                let v = e.get(k).and_then(Value::as_str).expect("edge endpoint is a string");
                assert!(ids.contains(v), "edge {k} '{v}' references a known node");
            }
        }
    }

    #[test]
    fn neighbors_reports_relationship_direction() {
        let nb = neighbors_of(&seed(), "merge-sort");
        assert!(
            nb.iter().any(|r| r["node"]["id"] == "array" && r["rel"] == "operates-on" && r["dir"] == "out"),
            "merge-sort operates-on array (outbound)",
        );
    }

    #[test]
    fn path_walks_the_fractal_thread_and_handles_edges() {
        let g = seed();
        // Two equal-length shortest paths exist (via golden-ratio OR recursion; BFS picks recursion
        // since composes-edges sort first) — assert the INVARIANT hops, not the ambiguous middle.
        let p = path_of(&g, "fibonacci", "mandelbrot").expect("mandelbrot is reachable from fibonacci");
        assert_eq!(p.len(), 4);
        assert_eq!(p[0], "fibonacci");
        assert_eq!(p[2], "self-similarity");
        assert_eq!(p[3], "mandelbrot");
        assert_eq!(path_of(&g, "heap", "heap"), Some(vec!["heap".into()]));
        assert_eq!(path_of(&g, "heap", "nope"), None);
    }

    #[test]
    fn implementation_lookup_reads_the_per_tech_tier() {
        let g = seed();
        assert_eq!(implementations_of(&g).len(), 10);

        let ms = implementation_of(&g, "merge-sort", "rust").expect("merge-sort has a rust impl");
        assert_eq!(ms["id"], "merge-sort.rs");
        let composes: Vec<&str> =
            ms["composes"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert!(composes.contains(&"merge.rs"), "merge_sort builds on the merge primitive");

        assert!(implementation_of(&g, "merge-sort", "cobol").is_none());
        assert!(implementation_of(&g, "array", "rust").is_none());
    }

    #[test]
    fn techs_with_impl_lists_the_seeded_languages() {
        let g = seed();
        assert_eq!(techs_with_impl_of(&g, "merge-sort"), vec!["typescript".to_string(), "rust".to_string()]);
        assert!(techs_with_impl_of(&g, "array").is_empty());
    }

    #[test]
    fn every_impl_targets_a_known_concept_and_composes_real_impls() {
        let g = seed();
        let node_ids: std::collections::HashSet<String> =
            nodes_of(&g).iter().filter_map(|n| n.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
        let impl_ids: std::collections::HashSet<String> =
            implementations_of(&g).iter().filter_map(|i| i.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
        for im in implementations_of(&g) {
            let concept = im.get("concept").and_then(Value::as_str).expect("impl.concept is a string");
            assert!(node_ids.contains(concept), "impl concept '{concept}' is a known node");
            for c in im.get("composes").and_then(Value::as_array).into_iter().flatten() {
                let cid = c.as_str().expect("composes id is a string");
                assert!(impl_ids.contains(cid), "composes id '{cid}' is a known impl");
            }
        }
    }

    // ── #2853 write path ──

    #[test]
    fn set_node_inserts_then_upserts_and_validates() {
        let mut g = seed();
        let inserted = set_node(&mut g, serde_json::json!({ "id": "skip-list", "kind": "data-structure", "name": "Skip List" })).unwrap();
        assert!(!inserted, "a brand-new id inserts (returns false = not a replace)");
        assert_eq!(node_of(&g, "skip-list").unwrap()["name"], "Skip List");

        let replaced = set_node(&mut g, serde_json::json!({ "id": "skip-list", "kind": "data-structure", "name": "Skip List v2" })).unwrap();
        assert!(replaced, "the same id upserts in place");
        assert_eq!(node_of(&g, "skip-list").unwrap()["name"], "Skip List v2");

        assert!(set_node(&mut g, serde_json::json!({ "id": "x", "kind": "bogus", "name": "X" })).is_err(), "unknown kind is rejected");
        assert!(set_node(&mut g, serde_json::json!({ "id": "", "kind": "concept", "name": "X" })).is_err(), "empty id is rejected");
    }

    #[test]
    fn link_validates_endpoints_and_rel_and_is_idempotent() {
        let mut g = seed();
        assert!(link(&mut g, "array", "stack", "related-to").unwrap(), "a fresh valid edge is added");
        assert!(!link(&mut g, "array", "stack", "related-to").unwrap(), "re-linking the same edge is a no-op");
        assert!(link(&mut g, "array", "nope", "related-to").is_err(), "an unknown endpoint is rejected");
        assert!(link(&mut g, "array", "stack", "bogus-rel").is_err(), "an unknown relationship is rejected");
    }

    #[test]
    fn unlink_removes_matching_edges() {
        let mut g = seed();
        link(&mut g, "array", "stack", "related-to").unwrap();
        assert_eq!(unlink(&mut g, "array", "stack", Some("composes")), 0, "the rel must match");
        assert_eq!(unlink(&mut g, "array", "stack", Some("related-to")), 1, "the exact edge is removed");
        assert_eq!(unlink(&mut g, "array", "stack", None), 0, "nothing left to remove");
    }

    #[test]
    fn remove_node_drops_the_node_and_its_incident_edges() {
        let mut g = seed();
        assert!(node_of(&g, "merge-sort").is_some());
        let (edges_removed, _impls_removed) = remove_node(&mut g, "merge-sort").expect("merge-sort existed");
        assert!(edges_removed > 0, "merge-sort had incident edges");
        assert!(node_of(&g, "merge-sort").is_none(), "the node is gone");
        assert!(
            !edges_of(&g).iter().any(|e| e["from"] == "merge-sort" || e["to"] == "merge-sort"),
            "no dangling edge references the removed node",
        );
        assert!(remove_node(&mut g, "merge-sort").is_none(), "removing an absent node reports None");
    }

    #[test]
    fn save_then_load_round_trips_a_mutated_graph() {
        let mut g = seed();
        set_node(&mut g, serde_json::json!({ "id": "bloom-filter", "kind": "data-structure", "name": "Bloom Filter" })).unwrap();
        let tmp = std::env::temp_dir().join(format!(
            "bsc-graph-store-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0),
        ));
        save_at(&tmp, &g).unwrap();
        let back = load_at(&tmp);
        assert!(node_of(&back, "bloom-filter").is_some(), "the write persisted + re-loaded");
        // A missing store falls back to the embedded seed (which has no bloom-filter).
        let missing = std::env::temp_dir().join("bsc-graph-store-does-not-exist.json");
        assert!(node_of(&load_at(&missing), "bloom-filter").is_none());
        assert!(node_of(&load_at(&missing), "merge-sort").is_some(), "an absent store reads the seed");
        let _ = std::fs::remove_file(&tmp);
    }
}
