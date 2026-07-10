//! The Algorithms knowledge graph (#2760/#2761) — "Graph 1", the curated concept ontology (data
//! structures, algorithms, concepts, outputs) joined by typed relationships. Embedded from the ONE
//! seed (`src-tauri/data/knowledge/algorithms.json`, the SAME file the frontend imports), so a live
//! session can enumerate + traverse the concepts from its own shell via `bsc graph`. Read-only, zero
//! egress. Phase 2 (#2745) layers the extracted-from-code `implements` join on top.

pub mod cli;

use serde_json::Value;

/// The packaged seed — the SAME file the frontend reads via `@data/knowledge/algorithms.json`.
pub const GRAPH_JSON: &str = include_str!("../../../src-tauri/data/knowledge/algorithms.json");

/// Parse the embedded graph. Panics only if the packaged seed is malformed — a build-time invariant
/// (the tests guard it).
pub fn graph() -> Value {
    serde_json::from_str(GRAPH_JSON).expect("packaged algorithms.json is valid JSON")
}

/// The node objects.
pub fn nodes() -> Vec<Value> {
    graph().get("nodes").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// The edge objects.
pub fn edges() -> Vec<Value> {
    graph().get("edges").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// A node by id, or None.
pub fn node(id: &str) -> Option<Value> {
    nodes().into_iter().find(|n| n.get("id").and_then(Value::as_str) == Some(id))
}

/// The relationships incident to `id`: one `{ rel, dir: "out"|"in", node: <the other node> }` per edge
/// touching it. `dir` is "out" when `id` is the edge's `from`, "in" when it is the `to`.
pub fn neighbors(id: &str) -> Vec<Value> {
    let ns = nodes();
    let by = |nid: &str| ns.iter().find(|n| n.get("id").and_then(Value::as_str) == Some(nid)).cloned();
    let mut out = Vec::new();
    for e in edges() {
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

/// Shortest relationship path between two node ids — BFS over the UNDIRECTED graph (relationships are
/// navigable both ways), inclusive of both ends. `None` if unreachable or an unknown id.
pub fn path(a: &str, b: &str) -> Option<Vec<String>> {
    use std::collections::{HashMap, HashSet, VecDeque};
    let known: HashSet<String> =
        nodes().iter().filter_map(|n| n.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
    if !known.contains(a) || !known.contains(b) {
        return None;
    }
    if a == b {
        return Some(vec![a.to_string()]);
    }
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    for e in edges() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_parses_with_nodes_edges_and_lookups() {
        assert!(nodes().len() > 30, "the seed has a real ontology");
        assert!(edges().len() > 30);
        assert!(node("merge-sort").is_some());
        assert!(node("nope").is_none());
    }

    #[test]
    fn every_edge_references_a_known_node() {
        let ids: std::collections::HashSet<String> =
            nodes().iter().filter_map(|n| n.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
        for e in edges() {
            for k in ["from", "to"] {
                let v = e.get(k).and_then(Value::as_str).expect("edge endpoint is a string");
                assert!(ids.contains(v), "edge {k} '{v}' references a known node");
            }
        }
    }

    #[test]
    fn neighbors_reports_relationship_direction() {
        let nb = neighbors("merge-sort");
        assert!(
            nb.iter().any(|r| r["node"]["id"] == "array" && r["rel"] == "operates-on" && r["dir"] == "out"),
            "merge-sort operates-on array (outbound)",
        );
    }

    #[test]
    fn path_walks_the_fractal_thread_and_handles_edges() {
        assert_eq!(
            path("fibonacci", "mandelbrot"),
            Some(vec!["fibonacci".into(), "golden-ratio".into(), "self-similarity".into(), "mandelbrot".into()]),
        );
        assert_eq!(path("heap", "heap"), Some(vec!["heap".into()]));
        assert_eq!(path("heap", "nope"), None);
    }
}
