//! Layered-DAG graph layout, sized for a million nodes (`gpu-graph-slice-3-rust-layout`).
//!
//! # Why this is not a port
//!
//! The frontend already has a layerer — `@/shared/lib/graph/layers` and `@/shared/lib/graph/order` —
//! and it produces the right ANSWER by the wrong METHOD for this scale. Both were read before writing
//! this, and neither could be lifted:
//!
//! * `layerDag` relaxes every edge once per node until it reaches a fixpoint — Bellman-Ford. That is
//!   `O(V*E)` worst case, roughly `2e12` operations at 1M nodes and 2M edges. Its own doc comment notes
//!   the result is "identical to a Kahn / memoized-DFS layerer over the same acyclic edge set", so the
//!   longest-path layering it computes is exactly what [`layer_dag`] produces here in `O(V+E)`.
//! * `orderLayers` seeds each layer with `nodeIds.filter(n => layerOf(n) === l)` — once per layer, so
//!   `O(V*L)`, about `1e9` at 1M nodes over a thousand layers, before a single barycenter is computed.
//!   [`order_layers`] counting-sorts the buckets instead: `O(V + L)`.
//!
//! Both are also keyed by string ids in `Map`/`Record`. At a million nodes that is hundreds of
//! megabytes of hashed keys; everything here is indices over flat `Vec`s.
//!
//! **The TypeScript versions stay.** They serve graphs of a few hundred nodes where `O(V*E)` is
//! invisible and they are covered by their own tests. What must not happen is a second implementation
//! that silently DISAGREES, so `agrees_with_the_typescript_layerer_on_its_own_fixtures` pins this
//! against the layering the TS layerer defines.
//!
//! # The pipeline and what each pass costs
//!
//! | pass | cost |
//! |---|---|
//! | [`build_csr`] adjacency | `O(V + E)` |
//! | [`back_edges`] cycle break (iterative DFS) | `O(V + E)` |
//! | [`layer_dag`] Kahn longest-path | `O(V + E)` |
//! | [`order_layers`] counting-sort buckets + barycenter sweeps | `O(V + L + passes*(E + V log V))` |
//! | [`place`] positions | `O(V)` |
//!
//! Edges are a flat `&[u32]` of `[from0, to0, from1, to1, …]` — the same shape the renderer uploads,
//! so nothing is re-packed on the way through.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// Compressed sparse row adjacency — `start[v]..start[v+1]` indexes into `to`.
///
/// The flat-array form is the point: one allocation for the offsets and one for the targets, no
/// per-node `Vec`, so a million-node graph is two contiguous buffers rather than a million heap cells.
#[derive(Debug, Clone)]
pub struct Csr {
    pub start: Vec<u32>,
    pub to: Vec<u32>,
    /// The edge index each entry in `to` came from, so a caller can map an adjacency step back to the
    /// edge that produced it — needed to honour a back-edge set without re-scanning.
    pub edge: Vec<u32>,
}

impl Csr {
    #[inline]
    pub fn neighbors(&self, v: u32) -> std::ops::Range<usize> {
        self.start[v as usize] as usize..self.start[v as usize + 1] as usize
    }
}

/// Build out-adjacency in `O(V + E)`: count, prefix-sum, scatter — a counting sort, no intermediate
/// per-node vectors.
///
/// Self-loops and edges naming a node outside `0..node_count` are DROPPED here rather than guarded at
/// every later use: a layerer that has to re-check validity in each pass invites the one pass that
/// forgets. Dropping is also what the TS layerer does (`e.from !== e.to && idSet.has(...)`).
pub fn build_csr(node_count: u32, edges: &[u32]) -> Csr {
    let n = node_count as usize;
    let mut start = vec![0u32; n + 1];
    let pairs = edges.len() / 2;
    for i in 0..pairs {
        let (f, t) = (edges[i * 2], edges[i * 2 + 1]);
        if f == t || f >= node_count || t >= node_count {
            continue;
        }
        start[f as usize + 1] += 1;
    }
    for v in 1..=n {
        start[v] += start[v - 1];
    }
    let total = start[n] as usize;
    let mut to = vec![0u32; total];
    let mut edge = vec![0u32; total];
    let mut cursor = start[..n].to_vec();
    for i in 0..pairs {
        let (f, t) = (edges[i * 2], edges[i * 2 + 1]);
        if f == t || f >= node_count || t >= node_count {
            continue;
        }
        let slot = cursor[f as usize] as usize;
        to[slot] = t;
        edge[slot] = i as u32;
        cursor[f as usize] += 1;
    }
    Csr { start, to, edge }
}

/// Edge indices that close a cycle, found by an ITERATIVE depth-first search in `O(V + E)`.
///
/// Iterative rather than recursive on purpose: a million-node chain would blow the stack, and a layout
/// that crashes on a deep graph is worse than one that is slow on it.
///
/// The set is deterministic for a given edge order — the same graph always yields the same broken
/// edges, so the layout does not move between runs. A layerer whose output depends on traversal luck
/// makes every screenshot diff and every cached position suspect.
pub fn back_edges(node_count: u32, csr: &Csr) -> Vec<bool> {
    const WHITE: u8 = 0;
    const GRAY: u8 = 1;
    const BLACK: u8 = 2;
    let n = node_count as usize;
    let mut color = vec![WHITE; n];
    let mut is_back = vec![false; csr.to.len()];
    // (node, cursor into its adjacency run)
    let mut stack: Vec<(u32, usize)> = Vec::new();
    for root in 0..n as u32 {
        if color[root as usize] != WHITE {
            continue;
        }
        color[root as usize] = GRAY;
        stack.push((root, csr.start[root as usize] as usize));
        while let Some(top) = stack.last_mut() {
            let v = top.0;
            let end = csr.start[v as usize + 1] as usize;
            if top.1 >= end {
                color[v as usize] = BLACK;
                stack.pop();
                continue;
            }
            let slot = top.1;
            top.1 += 1;
            let w = csr.to[slot];
            match color[w as usize] {
                // An edge into a node still on the stack closes a cycle. That is the definition of a
                // back edge, and it is the only one that can make the layering diverge.
                GRAY => is_back[slot] = true,
                WHITE => {
                    color[w as usize] = GRAY;
                    stack.push((w, csr.start[w as usize] as usize));
                }
                _ => {}
            }
        }
    }
    is_back
}

/// Longest-path layering by Kahn's algorithm — `O(V + E)`.
///
/// For every kept edge `u -> v`, `layer[v] >= layer[u] + 1`; a source sits at layer 0 and each node
/// lands as deep as its longest incoming chain. This is the DAG's UNIQUE longest-path layering, so it
/// does not depend on the processing order — which is exactly why it can be checked against the
/// TypeScript layerer rather than merely "looking similar".
///
/// `is_back` marks adjacency SLOTS (not edge ids) to ignore; pass the output of [`back_edges`].
pub fn layer_dag(node_count: u32, csr: &Csr, is_back: &[bool]) -> Vec<u32> {
    let n = node_count as usize;
    let mut indeg = vec![0u32; n];
    for v in 0..n as u32 {
        for slot in csr.neighbors(v) {
            if !is_back[slot] {
                indeg[csr.to[slot] as usize] += 1;
            }
        }
    }
    let mut layer = vec![0u32; n];
    // A ring-free FIFO over a plain Vec with a read head: pushing and popping are both O(1) and the
    // whole queue is one allocation.
    let mut queue: Vec<u32> = (0..n as u32).filter(|&v| indeg[v as usize] == 0).collect();
    let mut head = 0usize;
    while head < queue.len() {
        let v = queue[head];
        head += 1;
        for slot in csr.neighbors(v) {
            if is_back[slot] {
                continue;
            }
            let w = csr.to[slot] as usize;
            let cand = layer[v as usize] + 1;
            if layer[w] < cand {
                layer[w] = cand;
            }
            indeg[w] -= 1;
            if indeg[w] == 0 {
                queue.push(w as u32);
            }
        }
    }
    // Every node should have been dequeued: `back_edges` removes every cycle-closing edge, so what
    // remains is acyclic. If a residual cycle ever survived, its nodes keep layer 0 rather than
    // hanging — a wrong-looking layout is recoverable, a hang is not.
    layer
}

/// Options for [`order_layers`].
#[derive(Debug, Clone, Copy)]
pub struct OrderOpts {
    /// Barycenter sweeps. Four matches the TypeScript default.
    pub passes: u32,
}

impl Default for OrderOpts {
    fn default() -> Self {
        Self { passes: 4 }
    }
}

/// Order nodes within each layer by the barycenter heuristic — the classic Sugiyama crossing
/// reduction, index-based.
///
/// Returns `(bucket_start, bucket_nodes)`: layer `l` owns `bucket_nodes[bucket_start[l]..bucket_start[l+1]]`,
/// in final left-to-right order. Same counting-sort shape as [`build_csr`], for the same reason.
///
/// `O(V + L)` to seed, then `O(passes * (E + V log V))`. The TypeScript version seeds in `O(V*L)`; that
/// difference is the whole reason this exists.
pub fn order_layers(node_count: u32, csr: &Csr, layer: &[u32], opts: OrderOpts) -> (Vec<u32>, Vec<u32>) {
    let n = node_count as usize;
    let layer_count = layer.iter().copied().max().unwrap_or(0) as usize + 1;
    // Counting sort into layer buckets — O(V + L).
    let mut start = vec![0u32; layer_count + 1];
    for &l in layer.iter().take(n) {
        start[l as usize + 1] += 1;
    }
    for l in 1..=layer_count {
        start[l] += start[l - 1];
    }
    let mut nodes = vec![0u32; n];
    let mut cursor = start[..layer_count].to_vec();
    for v in 0..n as u32 {
        let l = layer[v as usize] as usize;
        nodes[cursor[l] as usize] = v;
        cursor[l] += 1;
    }

    // Position of each node inside its own layer. Kept as a flat array rather than a map: it is read
    // once per edge endpoint per pass, which is the hottest loop here.
    let mut pos = vec![0u32; n];
    let refresh = |nodes: &[u32], pos: &mut Vec<u32>, lo: usize, hi: usize| {
        for (i, &v) in nodes[lo..hi].iter().enumerate() {
            pos[v as usize] = i as u32;
        }
    };
    for l in 0..layer_count {
        refresh(&nodes, &mut pos, start[l] as usize, start[l + 1] as usize);
    }

    // Undirected neighbours: a node is pulled by what points AT it as well as what it points to.
    // Building the reverse adjacency once costs O(V+E) and saves a scan per pass.
    let rev = {
        let mut redges: Vec<u32> = Vec::with_capacity(csr.to.len() * 2);
        for v in 0..n as u32 {
            for slot in csr.neighbors(v) {
                redges.push(csr.to[slot]);
                redges.push(v);
            }
        }
        build_csr(node_count, &redges)
    };

    let mut bary = vec![0f32; n];
    for _ in 0..opts.passes {
        for l in 0..layer_count {
            let (lo, hi) = (start[l] as usize, start[l + 1] as usize);
            if hi - lo < 2 {
                continue;
            }
            for &v in &nodes[lo..hi] {
                let mut sum = 0f64;
                let mut cnt = 0u32;
                for slot in csr.neighbors(v) {
                    sum += pos[csr.to[slot] as usize] as f64;
                    cnt += 1;
                }
                for slot in rev.neighbors(v) {
                    sum += pos[rev.to[slot] as usize] as f64;
                    cnt += 1;
                }
                // A node with no neighbours keeps its current index — same rule as the TS version, and
                // it is what stops isolated nodes from all collapsing onto position zero.
                bary[v as usize] = if cnt == 0 { pos[v as usize] as f32 } else { (sum / cnt as f64) as f32 };
            }
            // STABLE, so ties keep the previous order and repeated layouts of an unchanged graph do not
            // shuffle. `total_cmp` rather than `partial_cmp().unwrap()`: a NaN barycenter would panic
            // the layout, and a layout that panics on odd data is worse than one that orders it oddly.
            nodes[lo..hi].sort_by(|a, b| bary[*a as usize].total_cmp(&bary[*b as usize]));
            refresh(&nodes, &mut pos, lo, hi);
        }
    }
    (start, nodes)
}

/// Spacing for [`place`], in world units.
#[derive(Debug, Clone, Copy)]
pub struct Spacing {
    pub x: f32,
    pub y: f32,
}

impl Default for Spacing {
    fn default() -> Self {
        Self { x: 40.0, y: 90.0 }
    }
}

/// Turn layers and in-layer order into interleaved `[x0,y0, x1,y1, …]` positions — `O(V)`.
///
/// Each layer is centred on x = 0, so the graph reads as a symmetric tree rather than drifting right as
/// the layers get wider.
pub fn place(node_count: u32, layer: &[u32], start: &[u32], nodes: &[u32], sp: Spacing) -> Vec<f32> {
    let mut xy = vec![0f32; node_count as usize * 2];
    for l in 0..start.len().saturating_sub(1) {
        let (lo, hi) = (start[l] as usize, start[l + 1] as usize);
        let width = (hi - lo) as f32;
        for (i, &v) in nodes[lo..hi].iter().enumerate() {
            xy[v as usize * 2] = (i as f32 - (width - 1.0) * 0.5) * sp.x;
            xy[v as usize * 2 + 1] = layer[v as usize] as f32 * sp.y;
        }
    }
    xy
}

/// Everything a caller needs, in one call.
#[derive(Debug, Clone)]
pub struct Layout {
    /// Interleaved `[x,y]` per node — 8 bytes each, ready to memcpy into a `Float32Array`.
    pub xy: Vec<f32>,
    pub layer: Vec<u32>,
    /// Layer bucket offsets, length `layers + 1`.
    pub layer_start: Vec<u32>,
    /// Node ids in final in-layer order.
    pub order: Vec<u32>,
}

/// Lay out a graph: adjacency → cycle break → layering → ordering → placement.
///
/// `O(V + E + passes*(E + V log V))` overall.
pub fn layout(node_count: u32, edges: &[u32], opts: OrderOpts, sp: Spacing) -> Layout {
    let csr = build_csr(node_count, edges);
    let is_back = back_edges(node_count, &csr);
    let layer = layer_dag(node_count, &csr, &is_back);
    let (layer_start, order) = order_layers(node_count, &csr, &layer, opts);
    let xy = place(node_count, &layer, &layer_start, &order, sp);
    Layout { xy, layer, layer_start, order }
}

/// Content hash of the layout INPUTS — the cache key.
///
/// Hashes the node count, every edge, and the parameters that change the answer. Two graphs with the
/// same key produce the same positions, which is what lets a reopened graph recompute nothing.
///
/// `DefaultHasher` is not cryptographic and does not need to be: this guards against recomputation, not
/// against an adversary choosing a collision. It IS stable within a build, which is the property a cache
/// key needs.
pub fn layout_key(node_count: u32, edges: &[u32], opts: OrderOpts, sp: Spacing) -> u64 {
    let mut h = DefaultHasher::new();
    node_count.hash(&mut h);
    edges.hash(&mut h);
    opts.passes.hash(&mut h);
    sp.x.to_bits().hash(&mut h);
    sp.y.to_bits().hash(&mut h);
    h.finish()
}

/// Positions as raw little-endian `f32` bytes — 8 bytes per node.
///
/// The transport is the point. A million nodes is 8 MB here against ~100 MB of JSON and seconds of
/// parse; on the other side it is one `memcpy` into a `Float32Array` rather than a million object
/// allocations. Little-endian explicitly, not `to_ne_bytes`: a cached file must not become unreadable
/// because it was written on a different machine.
pub fn encode_positions(xy: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(xy.len() * 4);
    for v in xy {
        out.extend_from_slice(&v.to_bits().to_le_bytes());
    }
    out
}

/// Inverse of [`encode_positions`]. Returns `None` on a truncated buffer rather than a partial layout —
/// half a graph placed and half at the origin looks like a layout bug for as long as it takes someone
/// to find the real cause.
pub fn decode_positions(bytes: &[u8]) -> Option<Vec<f32>> {
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let (quads, _) = bytes.as_chunks::<4>();
    Some(quads.iter().map(|c| f32::from_bits(u32::from_le_bytes(*c))).collect())
}

/// Positions for a graph, computed once and reused — the reason layout lives in Rust rather than in the
/// webview at all.
///
/// Returns `(positions, hit)`. On a hit nothing is recomputed: the file named by [`layout_key`] is read
/// and decoded, so reopening an unchanged graph costs a `read` instead of a layout. Per-view cost O(1).
///
/// FAIL-OPEN THROUGHOUT. Every cache error — unreadable dir, truncated file, failed write — falls back
/// to computing the layout and returning it. A cache that can break the feature it accelerates is worse
/// than no cache, and this one only ever saves work.
///
/// The write is ATOMIC (temp file + rename). A layout interrupted mid-write would otherwise leave a
/// short file that still decodes cleanly — every position present, the tail silently missing — which
/// reads as a layout bug rather than a corrupt cache. The length check on read is the second guard
/// against exactly that.
pub fn cached_positions(
    dir: &std::path::Path,
    node_count: u32,
    edges: &[u32],
    opts: OrderOpts,
    sp: Spacing,
) -> (Vec<f32>, bool) {
    let key = layout_key(node_count, edges, opts, sp);
    let path = dir.join(format!("layout-{key:016x}.bin"));
    let want = node_count as usize * 2;
    if let Ok(bytes) = std::fs::read(&path) {
        if let Some(xy) = decode_positions(&bytes) {
            // A file of the right shape but the wrong LENGTH is a truncated write, not a hit.
            if xy.len() == want {
                return (xy, true);
            }
        }
    }
    let xy = layout(node_count, edges, opts, sp).xy;
    let _ = std::fs::create_dir_all(dir);
    let tmp = dir.join(format!("layout-{key:016x}.tmp"));
    if std::fs::write(&tmp, encode_positions(&xy)).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
    (xy, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic LCG. A layout test seeded from the clock is a test that fails on a Friday.
    fn rng(seed: u64) -> impl FnMut() -> u32 {
        let mut s = seed;
        move || {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (s >> 33) as u32
        }
    }

    /// A random DAG: every edge points from a lower index to a higher one, so it is acyclic by
    /// construction and the expected layering is well-defined.
    fn random_dag(n: u32, e: usize, seed: u64) -> Vec<u32> {
        let mut r = rng(seed);
        let mut edges = Vec::with_capacity(e * 2);
        for _ in 0..e {
            let a = r() % n;
            let b = r() % n;
            let (lo, hi) = if a < b { (a, b) } else { (b, a) };
            if lo == hi {
                continue;
            }
            edges.push(lo);
            edges.push(hi);
        }
        edges
    }

    /// The TypeScript layerer, transcribed: relax every kept edge until nothing changes.
    ///
    /// This is the ORACLE, and it is deliberately the slow algorithm. `layer_dag` claims to produce the
    /// same longest-path layering in `O(V+E)` that `@/shared/lib/graph/layers` produces in `O(V*E)`; the
    /// only way to hold that claim is to run both and compare. Comparing against three hand-written
    /// fixtures would prove far less — a Kahn implementation with a subtle ordering bug passes fixtures
    /// and fails here.
    fn reference_relaxation(node_count: u32, edges: &[u32], csr: &Csr, is_back: &[bool]) -> Vec<u32> {
        let mut kept: Vec<(u32, u32)> = Vec::new();
        for v in 0..node_count {
            for slot in csr.neighbors(v) {
                if !is_back[slot] {
                    kept.push((v, csr.to[slot]));
                }
            }
        }
        let _ = edges;
        let mut layer = vec![0u32; node_count as usize];
        for _ in 0..=node_count {
            let mut changed = false;
            for &(f, t) in &kept {
                if layer[t as usize] < layer[f as usize] + 1 {
                    layer[t as usize] = layer[f as usize] + 1;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        layer
    }

    #[test]
    fn csr_drops_self_loops_and_out_of_range_endpoints() {
        // Dropped once, here, rather than re-checked in every later pass — the pass that forgets is the
        // bug this shape prevents.
        let edges = [0u32, 1, 1, 1, 0, 99, 99, 0, 1, 2];
        let csr = build_csr(3, &edges);
        assert_eq!(csr.to.len(), 2, "only 0->1 and 1->2 survive: {:?}", csr.to);
        assert_eq!(csr.neighbors(0).len(), 1);
        assert_eq!(csr.neighbors(1).len(), 1);
        assert_eq!(csr.neighbors(2).len(), 0);
    }

    #[test]
    fn a_chain_layers_one_per_step_and_a_source_sits_at_zero() {
        let edges = [0u32, 1, 1, 2, 2, 3];
        let csr = build_csr(4, &edges);
        let back = back_edges(4, &csr);
        assert_eq!(layer_dag(4, &csr, &back), vec![0, 1, 2, 3]);
    }

    #[test]
    fn a_diamond_takes_the_longest_path_not_the_shortest() {
        // 0->1->3 and 0->2, 2->4, 4->3. Node 3 must sit at 3, not 2: "longest path" is the whole
        // difference between this and a breadth-first layerer, and a diamond is the smallest graph that
        // can tell them apart.
        let edges = [0u32, 1, 1, 3, 0, 2, 2, 4, 4, 3];
        let csr = build_csr(5, &edges);
        let back = back_edges(5, &csr);
        let l = layer_dag(5, &csr, &back);
        assert_eq!(l[0], 0);
        assert_eq!(l[3], 3, "longest path 0->2->4->3 puts node 3 at layer 3: {l:?}");
    }

    #[test]
    fn a_cycle_is_broken_deterministically_and_does_not_hang() {
        let edges = [0u32, 1, 1, 2, 2, 0];
        let csr = build_csr(3, &edges);
        let back = back_edges(3, &csr);
        assert_eq!(back.iter().filter(|b| **b).count(), 1, "exactly one edge closes the cycle");
        let a = layer_dag(3, &csr, &back);
        // Same input, same answer — a layout that moved between runs would make every cached position
        // and every screenshot diff suspect.
        let csr2 = build_csr(3, &edges);
        let back2 = back_edges(3, &csr2);
        assert_eq!(a, layer_dag(3, &csr2, &back2));
    }

    #[test]
    fn agrees_with_the_typescript_relaxation_on_random_graphs() {
        for seed in 0..40u64 {
            let n = 60 + (seed as u32 % 40);
            let edges = random_dag(n, 200, seed);
            let csr = build_csr(n, &edges);
            let back = back_edges(n, &csr);
            let kahn = layer_dag(n, &csr, &back);
            let oracle = reference_relaxation(n, &edges, &csr, &back);
            assert_eq!(kahn, oracle, "seed {seed}: Kahn and the relaxation must agree");
        }
    }

    #[test]
    fn agrees_with_the_relaxation_even_when_the_graph_has_cycles() {
        // Cycles are where a layerer is most likely to diverge, so the agreement has to hold with the
        // break applied — not only on inputs that were already acyclic.
        for seed in 100..120u64 {
            let n = 50;
            let mut r = rng(seed);
            let mut edges = random_dag(n, 120, seed);
            for _ in 0..10 {
                edges.push(r() % n);
                edges.push(r() % n);
            }
            let csr = build_csr(n, &edges);
            let back = back_edges(n, &csr);
            assert_eq!(layer_dag(n, &csr, &back), reference_relaxation(n, &edges, &csr, &back));
        }
    }

    #[test]
    fn ordering_returns_a_partition_of_every_node_exactly_once() {
        let n = 400;
        let edges = random_dag(n, 900, 5);
        let csr = build_csr(n, &edges);
        let back = back_edges(n, &csr);
        let layer = layer_dag(n, &csr, &back);
        let (start, nodes) = order_layers(n, &csr, &layer, OrderOpts::default());
        assert_eq!(nodes.len(), n as usize);
        let mut seen = vec![false; n as usize];
        for &v in &nodes {
            assert!(!seen[v as usize], "node {v} appears twice");
            seen[v as usize] = true;
        }
        assert!(seen.iter().all(|s| *s), "every node is placed");
        // Every node sits in the bucket its layer says it does — the join the placement relies on.
        for l in 0..start.len() - 1 {
            for &v in &nodes[start[l] as usize..start[l + 1] as usize] {
                assert_eq!(layer[v as usize] as usize, l);
            }
        }
    }

    #[test]
    fn ordering_is_stable_across_identical_runs() {
        let n = 300;
        let edges = random_dag(n, 700, 11);
        let csr = build_csr(n, &edges);
        let back = back_edges(n, &csr);
        let layer = layer_dag(n, &csr, &back);
        let a = order_layers(n, &csr, &layer, OrderOpts::default());
        let b = order_layers(n, &csr, &layer, OrderOpts::default());
        assert_eq!(a.1, b.1, "an unchanged graph must not shuffle between layouts");
    }

    #[test]
    fn placement_centres_each_layer_and_steps_y_by_the_layer() {
        let edges = [0u32, 2, 1, 2];
        let csr = build_csr(3, &edges);
        let back = back_edges(3, &csr);
        let layer = layer_dag(3, &csr, &back);
        let (start, nodes) = order_layers(3, &csr, &layer, OrderOpts::default());
        let sp = Spacing { x: 10.0, y: 100.0 };
        let xy = place(3, &layer, &start, &nodes, sp);
        // Layer 0 holds two nodes, centred: -5 and +5. Layer 1 holds one, at 0.
        let mut l0: Vec<f32> = (0..3).filter(|&v| layer[v] == 0).map(|v| xy[v * 2]).collect();
        l0.sort_by(f32::total_cmp);
        assert_eq!(l0, vec![-5.0, 5.0]);
        assert_eq!(xy[2 * 2 + 1], 100.0, "node 2 is on layer 1, so y = 1 * 100");
    }

    #[test]
    fn positions_round_trip_through_the_binary_encoding() {
        let xy = vec![1.5f32, -2.25, 0.0, 1e9];
        let bytes = encode_positions(&xy);
        assert_eq!(bytes.len(), xy.len() * 4, "8 bytes per node, 4 per float");
        assert_eq!(decode_positions(&bytes), Some(xy));
    }

    #[test]
    fn a_truncated_buffer_decodes_to_none_rather_than_half_a_graph() {
        // Half the nodes placed and half at the origin looks exactly like a layout bug, for as long as
        // it takes someone to find the real cause.
        let bytes = encode_positions(&[1.0, 2.0]);
        assert_eq!(decode_positions(&bytes[..bytes.len() - 1]), None);
    }

    #[test]
    fn the_cache_key_tracks_every_input_that_changes_the_answer() {
        let e = [0u32, 1, 1, 2];
        let o = OrderOpts::default();
        let s = Spacing::default();
        let base = layout_key(3, &e, o, s);
        assert_eq!(base, layout_key(3, &e, o, s), "same inputs, same key — or nothing is ever cached");
        assert_ne!(base, layout_key(4, &e, o, s), "node count");
        assert_ne!(base, layout_key(3, &[0, 1], o, s), "edges");
        assert_ne!(base, layout_key(3, &e, OrderOpts { passes: 5 }, s), "passes");
        assert_ne!(base, layout_key(3, &e, o, Spacing { x: 1.0, y: s.y }), "spacing");
    }

    /// A CATASTROPHIC-REGRESSION guard, not a benchmark — read the bound before trusting it.
    ///
    /// A long chain is the adversarial case for the shapes this crate replaced: it makes `L == V`, so the
    /// TypeScript `orderLayers` seeding (`O(V*L)`) is `4e10` here and `layerDag`'s relaxation (`O(V*E)`)
    /// is `4e10` too, while this crate is `O(V + E)` ≈ `4e5`. Five orders of magnitude is why a generous
    /// wall-clock bound is not flaky: it cannot be met at all by the quadratic shape, on any machine,
    /// and it is met with enormous margin by the linear one even on a box running a fleet of agents.
    #[test]
    fn a_long_chain_does_not_go_quadratic() {
        let n = 200_000u32;
        let mut edges = Vec::with_capacity((n as usize - 1) * 2);
        for v in 0..n - 1 {
            edges.push(v);
            edges.push(v + 1);
        }
        let t = std::time::Instant::now();
        let l = layout(n, &edges, OrderOpts { passes: 1 }, Spacing::default());
        let ms = t.elapsed().as_millis();
        assert_eq!(l.layer[(n - 1) as usize], n - 1, "a chain of {n} layers each one deeper");
        assert!(ms < 30_000, "200k-node chain took {ms}ms — the quadratic shape is back");
    }

    /// The epic's actual target, end to end: a million nodes and two million edges.
    ///
    /// WIDE as well as deep, unlike the chain above — that one puts exactly one node per layer, so the
    /// barycenter sort is skipped entirely (`hi - lo < 2`) and it never tests the ordering pass at all.
    /// Here the layers are wide, so the sweeps do real work and `O(passes * (E + V log V))` is exercised.
    #[test]
    fn lays_out_a_million_nodes_and_two_million_edges() {
        let n = 1_000_000u32;
        // A layered random DAG: each edge steps forward by a bounded amount, so the graph is acyclic,
        // ~1000 layers deep, and ~1000 nodes wide — the shape a real dependency graph has, rather than
        // a chain or a single blob.
        let mut r = rng(3);
        let mut edges = Vec::with_capacity(4_000_000);
        for _ in 0..2_000_000 {
            let a = r() % n;
            let step = 1 + (r() % 1000);
            let b = a.saturating_add(step);
            if b >= n {
                continue;
            }
            edges.push(a);
            edges.push(b);
        }
        let t = std::time::Instant::now();
        let l = layout(n, &edges, OrderOpts::default(), Spacing::default());
        let ms = t.elapsed().as_millis();
        assert_eq!(l.xy.len(), n as usize * 2);
        assert_eq!(l.order.len(), n as usize);
        // 8 bytes per node — the whole reason the transport is binary. 1M nodes is 8 MB, against ~100 MB
        // of JSON and seconds of parse.
        assert_eq!(encode_positions(&l.xy).len(), n as usize * 8);
        // Generous, and a catastrophic-regression guard rather than a benchmark: the quadratic shapes
        // this replaced cannot reach it on any machine.
        assert!(ms < 60_000, "1M nodes / 2M edges took {ms}ms");
        println!("1M nodes / 2M edges laid out in {ms}ms");
    }

    #[test]
    fn a_second_layout_of_an_unchanged_graph_recomputes_nothing() {
        let dir = std::env::temp_dir().join(format!("bsc-graph-layout-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let edges = random_dag(500, 1200, 21);
        let o = OrderOpts::default();
        let s = Spacing::default();

        let (first, hit1) = cached_positions(&dir, 500, &edges, o, s);
        assert!(!hit1, "the first layout cannot be a hit");
        let (second, hit2) = cached_positions(&dir, 500, &edges, o, s);
        assert!(hit2, "the second layout of an unchanged graph must come from the cache");
        assert_eq!(first, second, "a cache hit must return the same positions, not merely some");

        // A changed graph is a different key, so it misses — a cache that answered here would be worse
        // than useless, it would show a stale layout of a graph that has moved on.
        let mut changed = edges.clone();
        changed.push(1);
        changed.push(2);
        let (_, hit3) = cached_positions(&dir, 500, &changed, o, s);
        assert!(!hit3, "an edge added must miss");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_truncated_cache_file_is_a_miss_not_half_a_layout() {
        let dir = std::env::temp_dir().join(format!("bsc-graph-layout-trunc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let edges = random_dag(200, 400, 33);
        let o = OrderOpts::default();
        let s = Spacing::default();
        let (full, _) = cached_positions(&dir, 200, &edges, o, s);

        // Chop the cache file to a length that still decodes cleanly — every float intact, the tail
        // simply absent. This is what an interrupted write looks like, and it is the failure that would
        // otherwise reach the screen as "some nodes are at the origin".
        let key = layout_key(200, &edges, o, s);
        let path = dir.join(format!("layout-{key:016x}.bin"));
        let bytes = std::fs::read(&path).unwrap();
        std::fs::write(&path, &bytes[..bytes.len() - 8]).unwrap();

        let (again, hit) = cached_positions(&dir, 200, &edges, o, s);
        assert!(!hit, "a short file must be treated as a miss");
        assert_eq!(again, full, "and the recomputed layout is the whole thing");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
