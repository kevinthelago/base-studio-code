//! Design-graph health analyzer (#2678, epic #2677) — the PURE traversal behind `bsc ui doctor`.
//!
//! The component library is a per-kit composition graph: nodes are components (`role`, `used` =
//! cross-codebase reuse count, `composes` = the names it depends on), edges are `composes`
//! (composer → dependency, resolved by-name WITHIN a kit). This module finds the dead/duplicated
//! design a growing kit accumulates — especially as the designer LLM authors components via
//! `bsc ui` — so the session can discover and prune it in ONE call.
//!
//! Pure: input is the parsed component records, output is a ranked `Vec<Finding>`. No I/O, so it's
//! unit-tested directly and the same taxonomy can be mirrored frontend-side for graph badges (#2680).
//!
//! Findings (most-severe first): **cycle** (a `composes` loop — also breaks the layered layout) ·
//! **dangling-branch** (an unused root that still pulls in dependencies) · **duplicate** (two
//! components wrapping the same intrinsic, or byte-identical source) · **orphan** (an isolated,
//! never-referenced primitive/composite). "Unused" = orphan ∪ dangling-branch — a node with no
//! composer AND `used == 0`; a `page`/`layout` with `used > 0` is a legit entry point, never flagged.

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// One health finding — LLM-consumable: what, where, why, and what to do about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    /// `cycle` | `dangling-branch` | `duplicate` | `orphan`.
    pub category: &'static str,
    /// Higher = more severe; the report is sorted by this, descending.
    pub severity: u8,
    /// The kit the finding is scoped to.
    pub kit: String,
    /// The component id(s) involved (a cycle/duplicate/branch can span several).
    pub node_ids: Vec<String>,
    /// The component name(s), parallel to `node_ids` — the human/LLM-readable handle.
    pub node_names: Vec<String>,
    /// A one-line explanation of the finding.
    pub why: String,
    /// The concrete next step (e.g. which id to remove, or which to merge into which).
    pub suggested_action: String,
}

impl Finding {
    /// The finding as a JSON object (the `--json` report shape). Manual — the crate carries
    /// `serde_json` but not the `serde` derive.
    pub fn to_value(&self) -> Value {
        json!({
            "category": self.category,
            "severity": self.severity,
            "kit": self.kit,
            "nodeIds": self.node_ids,
            "nodeNames": self.node_names,
            "why": self.why,
            "suggestedAction": self.suggested_action,
        })
    }
}

/// A component record reduced to the fields the analyzer needs (parsed from the store JSON). Records
/// that don't parse to at least an id are skipped — the analyzer never crashes on an odd row.
struct Node {
    id: String,
    name: String,
    kit: String,
    role: String,
    used: i64,
    composes: Vec<String>,
    wraps: Option<String>,
    src_text: String,
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn parse_node(v: &Value) -> Option<Node> {
    let id = v.get("id").and_then(Value::as_str)?.to_string();
    if id.is_empty() {
        return None;
    }
    Some(Node {
        name: {
            let n = s(v, "name");
            if n.is_empty() { id.clone() } else { n }
        },
        id,
        kit: s(v, "kitId"),
        role: {
            let r = s(v, "role");
            if r.is_empty() { "primitive".to_string() } else { r }
        },
        used: v.get("used").and_then(Value::as_i64).unwrap_or(0),
        composes: v
            .get("composes")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        wraps: v.get("wraps").and_then(Value::as_str).filter(|w| !w.is_empty()).map(str::to_string),
        src_text: s(v, "srcText"),
    })
}

/// Analyze the component records for graph-health findings, grouped and scoped PER KIT (edges only
/// resolve within a kit). Returns a ranked list, most-severe first (stable tiebreak: kit, then the
/// first node name), so the same input always yields the same ordering.
pub fn analyze(components: &[Value]) -> Vec<Finding> {
    let nodes: Vec<Node> = components.iter().filter_map(parse_node).collect();
    let mut by_kit: BTreeMap<&str, Vec<&Node>> = BTreeMap::new();
    for n in &nodes {
        by_kit.entry(n.kit.as_str()).or_default().push(n);
    }
    let mut out = Vec::new();
    for (kit, kit_nodes) in by_kit {
        analyze_kit(kit, &kit_nodes, &mut out);
    }
    out.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then_with(|| a.kit.cmp(&b.kit))
            .then_with(|| a.node_names.first().cmp(&b.node_names.first()))
    });
    out
}

/// A component safe to prune (#2679) — a finding root the confirm-gated `--fix` may remove.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prunable {
    pub id: String,
    pub name: String,
    pub reason: String,
}

/// The safe-to-remove set (#2679): the ROOT of every orphan / dangling-branch finding — a node with
/// no composer and `used == 0`. Deliberately NOT the branch DESCENDANTS (one might be shared by a live
/// component): removing the roots and re-running `doctor` surfaces any newly-orphaned children on the
/// next pass. Cycles and duplicates are never auto-pruned (they need a human's merge/break call). By
/// construction a `used > 0` node can never appear here.
pub fn prunable(components: &[Value]) -> Vec<Prunable> {
    analyze(components)
        .into_iter()
        .filter_map(|f| match f.category {
            "orphan" | "dangling-branch" => Some(Prunable {
                id: f.node_ids.into_iter().next()?,
                name: f.node_names.into_iter().next().unwrap_or_default(),
                reason: f.why,
            }),
            _ => None,
        })
        .collect()
}

fn analyze_kit(kit: &str, nodes: &[&Node], out: &mut Vec<Finding>) {
    // Name → id (in-kit). A duplicate NAME would collide; the store keys by id, so we keep the first.
    let mut id_by_name: BTreeMap<&str, &str> = BTreeMap::new();
    for n in nodes {
        id_by_name.entry(n.name.as_str()).or_insert(n.id.as_str());
    }
    // Resolved edges (composer id → dependency id) + in/out degree by id.
    let mut out_ids: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut in_deg: BTreeMap<&str, usize> = BTreeMap::new();
    for n in nodes {
        in_deg.entry(n.id.as_str()).or_insert(0);
    }
    for n in nodes {
        for dep_name in &n.composes {
            if let Some(&dep_id) = id_by_name.get(dep_name.as_str()) {
                out_ids.entry(n.id.as_str()).or_default().push(dep_id);
                *in_deg.entry(dep_id).or_insert(0) += 1;
            }
        }
    }
    let node_by_id: BTreeMap<&str, &&Node> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let name_of = |id: &str| node_by_id.get(id).map(|n| n.name.clone()).unwrap_or_default();

    // ── cycles (severity 4) — a `composes` loop; report each SCC of size > 1 (or a self-loop).
    for scc in strongly_connected(nodes, &out_ids) {
        let is_cycle = scc.len() > 1 || out_ids.get(scc[0]).is_some_and(|d| d.contains(&scc[0]));
        if !is_cycle {
            continue;
        }
        let names: Vec<String> = scc.iter().map(|id| name_of(id)).collect();
        out.push(Finding {
            category: "cycle",
            severity: 4,
            kit: kit.to_string(),
            node_ids: scc.iter().map(|s| s.to_string()).collect(),
            node_names: names.clone(),
            why: format!("these components form a `composes` cycle: {}", names.join(" → ")),
            suggested_action: "break the loop — a composition graph must be acyclic (it also breaks the layered layout)".to_string(),
        });
    }

    // ── dead roots: in-degree 0 AND used == 0, excluding a page/layout entry point kept alive by use.
    for n in nodes {
        let indeg = *in_deg.get(n.id.as_str()).unwrap_or(&0);
        let outdeg = out_ids.get(n.id.as_str()).map(Vec::len).unwrap_or(0);
        if indeg != 0 || n.used != 0 {
            continue;
        }
        if outdeg == 0 {
            // ── orphan (severity 2) — an isolated primitive/composite nobody composes or uses.
            if n.role == "primitive" || n.role == "composite" {
                out.push(Finding {
                    category: "orphan",
                    severity: 2,
                    kit: kit.to_string(),
                    node_ids: vec![n.id.clone()],
                    node_names: vec![n.name.clone()],
                    why: format!("`{}` is isolated (nothing composes it) and unused (used = 0)", n.name),
                    suggested_action: format!("prune it — `bsc ui remove {}` (confirm-gated)", n.id),
                });
            }
            // A dead isolated page/layout is unusual (a stray screen); leave it for the human — it's
            // an entry point by role, so we don't auto-flag it as prunable.
        } else {
            // ── dangling-branch (severity 3) — an unused root that still pulls in dependencies.
            let mut reachable = BTreeSet::new();
            collect_reachable(n.id.as_str(), &out_ids, &mut reachable);
            reachable.remove(n.id.as_str());
            let mut ids = vec![n.id.clone()];
            let mut names = vec![n.name.clone()];
            for id in &reachable {
                ids.push(id.to_string());
                names.push(name_of(id));
            }
            out.push(Finding {
                category: "dangling-branch",
                severity: 3,
                kit: kit.to_string(),
                node_ids: ids,
                node_names: names,
                why: format!(
                    "`{}` is an unused root (nothing composes it, used = 0) that pulls in {} dependenc{}",
                    n.name,
                    reachable.len(),
                    if reachable.len() == 1 { "y" } else { "ies" }
                ),
                suggested_action: format!(
                    "prune the branch from its root `{}` — check each dependency isn't shared before removing",
                    n.name
                ),
            });
        }
    }

    // ── duplicates (severity 3): two components wrapping the SAME intrinsic, or byte-identical source.
    let mut by_wraps: BTreeMap<&str, Vec<&&Node>> = BTreeMap::new();
    for n in nodes {
        if let Some(w) = &n.wraps {
            by_wraps.entry(w.as_str()).or_default().push(n);
        }
    }
    for (intrinsic, group) in by_wraps {
        if group.len() < 2 {
            continue;
        }
        let names: Vec<String> = group.iter().map(|n| n.name.clone()).collect();
        // Suggest keeping the most-used one as the merge target.
        let target = group.iter().max_by_key(|n| n.used).map(|n| n.name.clone()).unwrap_or_default();
        out.push(Finding {
            category: "duplicate",
            severity: 3,
            kit: kit.to_string(),
            node_ids: group.iter().map(|n| n.id.clone()).collect(),
            node_names: names.clone(),
            why: format!("{} components all wrap the raw `<{}>`: {}", group.len(), intrinsic, names.join(", ")),
            suggested_action: format!("merge into `{target}` (the most-used) and repoint the others"),
        });
    }
    // Byte-identical source (a stronger duplicate signal than `wraps`).
    let mut by_src: BTreeMap<&str, Vec<&&Node>> = BTreeMap::new();
    for n in nodes {
        if !n.src_text.trim().is_empty() {
            by_src.entry(n.src_text.as_str()).or_default().push(n);
        }
    }
    for (_src, group) in by_src {
        if group.len() < 2 {
            continue;
        }
        let names: Vec<String> = group.iter().map(|n| n.name.clone()).collect();
        let target = group.iter().max_by_key(|n| n.used).map(|n| n.name.clone()).unwrap_or_default();
        out.push(Finding {
            category: "duplicate",
            severity: 3,
            kit: kit.to_string(),
            node_ids: group.iter().map(|n| n.id.clone()).collect(),
            node_names: names.clone(),
            why: format!("{} components have byte-identical source: {}", group.len(), names.join(", ")),
            suggested_action: format!("merge into `{target}` (the most-used) and repoint the others"),
        });
    }
}

/// Collect every id reachable from `start` along `out_ids` (DFS, cycle-safe via the visited set).
fn collect_reachable<'a>(
    start: &'a str,
    out_ids: &BTreeMap<&'a str, Vec<&'a str>>,
    visited: &mut BTreeSet<&'a str>,
) {
    if !visited.insert(start) {
        return;
    }
    if let Some(deps) = out_ids.get(start) {
        for &d in deps {
            collect_reachable(d, out_ids, visited);
        }
    }
}

/// Tarjan's strongly-connected components over the resolved `composes` edges — the SCCs of size > 1
/// (and self-loops) are the cycles. Deterministic: nodes are visited in the input order.
fn strongly_connected<'a>(nodes: &[&'a Node], out_ids: &BTreeMap<&'a str, Vec<&'a str>>) -> Vec<Vec<&'a str>> {
    struct T<'a> {
        idx: BTreeMap<&'a str, usize>,
        low: BTreeMap<&'a str, usize>,
        on_stack: BTreeSet<&'a str>,
        stack: Vec<&'a str>,
        counter: usize,
        sccs: Vec<Vec<&'a str>>,
    }
    fn strong<'a>(v: &'a str, out_ids: &BTreeMap<&'a str, Vec<&'a str>>, t: &mut T<'a>) {
        t.idx.insert(v, t.counter);
        t.low.insert(v, t.counter);
        t.counter += 1;
        t.stack.push(v);
        t.on_stack.insert(v);
        if let Some(deps) = out_ids.get(v) {
            for &w in deps {
                if !t.idx.contains_key(w) {
                    strong(w, out_ids, t);
                    let lw = t.low[w];
                    let e = t.low.get_mut(v).unwrap();
                    *e = (*e).min(lw);
                } else if t.on_stack.contains(w) {
                    let iw = t.idx[w];
                    let e = t.low.get_mut(v).unwrap();
                    *e = (*e).min(iw);
                }
            }
        }
        if t.low[v] == t.idx[v] {
            let mut comp = Vec::new();
            while let Some(w) = t.stack.pop() {
                t.on_stack.remove(w);
                comp.push(w);
                if w == v {
                    break;
                }
            }
            t.sccs.push(comp);
        }
    }
    let mut t = T {
        idx: BTreeMap::new(),
        low: BTreeMap::new(),
        on_stack: BTreeSet::new(),
        stack: Vec::new(),
        counter: 0,
        sccs: Vec::new(),
    };
    for n in nodes {
        if !t.idx.contains_key(n.id.as_str()) {
            strong(n.id.as_str(), out_ids, &mut t);
        }
    }
    t.sccs
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn comp(id: &str, role: &str, used: i64, composes: &[&str]) -> Value {
        json!({ "id": id, "name": id, "kitId": "k", "role": role, "used": used,
                "composes": composes, "srcText": format!("src-{id}") })
    }

    fn cats(fs: &[Finding]) -> Vec<&str> {
        fs.iter().map(|f| f.category).collect()
    }

    #[test]
    fn a_clean_kit_has_no_findings() {
        // Page → Card → Button, all used; nothing dead or duplicated.
        let comps = [
            comp("page", "page", 1, &["Card"]),
            json!({ "id": "Card", "name": "Card", "kitId": "k", "role": "composite", "used": 3, "composes": ["Button"], "srcText": "card" }),
            json!({ "id": "Button", "name": "Button", "kitId": "k", "role": "primitive", "used": 9, "composes": [], "srcText": "btn" }),
        ];
        assert!(analyze(&comps).is_empty());
    }

    #[test]
    fn flags_an_isolated_unused_primitive_as_an_orphan() {
        let comps = [
            comp("Button", "primitive", 5, &[]),
            comp("Ghost", "primitive", 0, &[]), // isolated + unused
        ];
        let fs = analyze(&comps);
        assert_eq!(cats(&fs), ["orphan"]);
        assert_eq!(fs[0].node_names, ["Ghost"]);
    }

    #[test]
    fn a_used_primitive_is_never_flagged() {
        let fs = analyze(&[comp("Button", "primitive", 2, &[])]);
        assert!(fs.is_empty());
    }

    #[test]
    fn flags_an_unused_root_with_deps_as_a_dangling_branch() {
        // DeadShell (unused, in-degree 0) composes Widget; the whole branch is dead.
        let comps = [
            json!({ "id": "shell", "name": "DeadShell", "kitId": "k", "role": "layout", "used": 0, "composes": ["Widget"], "srcText": "a" }),
            json!({ "id": "widget", "name": "Widget", "kitId": "k", "role": "composite", "used": 0, "composes": [], "srcText": "b" }),
        ];
        let fs = analyze(&comps);
        assert_eq!(cats(&fs), ["dangling-branch"]);
        assert!(fs[0].node_names.contains(&"DeadShell".to_string()));
        assert!(fs[0].node_names.contains(&"Widget".to_string()));
    }

    #[test]
    fn flags_two_components_wrapping_the_same_intrinsic_as_duplicates() {
        let comps = [
            json!({ "id": "btn", "name": "Button", "kitId": "k", "role": "primitive", "used": 9, "composes": [], "wraps": "button", "srcText": "a" }),
            json!({ "id": "btn2", "name": "Btn2", "kitId": "k", "role": "primitive", "used": 1, "composes": [], "wraps": "button", "srcText": "b" }),
        ];
        let fs = analyze(&comps);
        assert_eq!(cats(&fs), ["duplicate"]);
        // Merge target is the most-used one.
        assert!(fs[0].suggested_action.contains("Button"));
    }

    #[test]
    fn flags_a_composes_cycle() {
        let comps = [
            json!({ "id": "a", "name": "A", "kitId": "k", "role": "composite", "used": 1, "composes": ["B"], "srcText": "a" }),
            json!({ "id": "b", "name": "B", "kitId": "k", "role": "composite", "used": 1, "composes": ["A"], "srcText": "b" }),
        ];
        let fs = analyze(&comps);
        assert_eq!(cats(&fs), ["cycle"]);
        assert_eq!(fs[0].severity, 4);
    }

    #[test]
    fn edges_do_not_cross_kits() {
        // Same dependency name in two kits must not wire them together.
        let comps = [
            json!({ "id": "k1-page", "name": "Page", "kitId": "k1", "role": "page", "used": 1, "composes": ["Button"], "srcText": "a" }),
            json!({ "id": "k1-btn", "name": "Button", "kitId": "k1", "role": "primitive", "used": 4, "composes": [], "srcText": "b" }),
            json!({ "id": "k2-btn", "name": "Button", "kitId": "k2", "role": "primitive", "used": 0, "composes": [], "srcText": "c" }),
        ];
        // k2's Button is isolated + unused in ITS kit → orphan; k1's Button is composed → clean.
        let fs = analyze(&comps);
        assert_eq!(cats(&fs), ["orphan"]);
        assert_eq!(fs[0].kit, "k2");
    }

    #[test]
    fn prunable_is_the_orphan_and_dead_root_set_and_never_a_used_node() {
        let comps = [
            comp("Button", "primitive", 9, &[]),   // used → never prunable
            comp("Ghost", "primitive", 0, &[]),     // orphan → prunable
            // dead root + its dependency; only the ROOT is prunable this pass.
            json!({ "id": "shell", "name": "DeadShell", "kitId": "k", "role": "layout", "used": 0, "composes": ["Widget"], "srcText": "a" }),
            json!({ "id": "widget", "name": "Widget", "kitId": "k", "role": "composite", "used": 0, "composes": [], "srcText": "b" }),
            // a duplicate pair — reported, but NOT auto-prunable.
            json!({ "id": "b1", "name": "Btn1", "kitId": "k", "role": "primitive", "used": 3, "composes": [], "wraps": "button", "srcText": "x" }),
            json!({ "id": "b2", "name": "Btn2", "kitId": "k", "role": "primitive", "used": 1, "composes": [], "wraps": "button", "srcText": "y" }),
        ];
        let ids: Vec<String> = prunable(&comps).into_iter().map(|p| p.id).collect();
        assert!(ids.contains(&"Ghost".to_string()));
        assert!(ids.contains(&"shell".to_string()));
        assert!(!ids.contains(&"widget".to_string())); // a descendant, not a root — next pass
        assert!(!ids.contains(&"Button".to_string())); // used > 0
        assert!(!ids.contains(&"b1".to_string()) && !ids.contains(&"b2".to_string())); // duplicates aren't pruned
    }

    #[test]
    fn ranks_most_severe_first() {
        let comps = [
            comp("Ghost", "primitive", 0, &[]), // orphan (sev 2)
            json!({ "id": "a", "name": "A", "kitId": "k", "role": "composite", "used": 1, "composes": ["B"], "srcText": "a" }),
            json!({ "id": "b", "name": "B", "kitId": "k", "role": "composite", "used": 1, "composes": ["A"], "srcText": "b" }),
        ];
        let fs = analyze(&comps);
        assert_eq!(fs[0].category, "cycle"); // severity 4 leads
        assert_eq!(fs.last().unwrap().category, "orphan"); // severity 2 trails
    }
}
