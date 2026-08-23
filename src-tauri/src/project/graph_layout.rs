//! The layout command — `bsc-graph-layout` reached from the frontend (`wire-the-rust-layout-into-the-app`).
//!
//! # This is the first BINARY command in the app, and that is the point
//!
//! Every other command here returns JSON. For layout that would be self-defeating: a million nodes as a
//! JSON array of numbers is ~100 MB of text and seconds of `JSON.parse` on the main thread — more than
//! the 256 ms layout it is delivering. [`tauri::ipc::Response`] returns raw bytes through the custom
//! protocol instead; they arrive as an `ArrayBuffer` and go straight into a `Float32Array` with one
//! memcpy. A million nodes is 8 MB.
//!
//! Written to be copied: anything that ships bulk numeric data to the frontend should look like this.
//!
//! # What it does not do
//!
//! It does not decide which surface uses it. The Design Studio's 627-node graph is served fine by the
//! TypeScript layerer, and swapping a layout under a live page is exactly how the last regression
//! shipped. This makes the crate REACHABLE and proves the path; adoption is a separate decision.

use crate::prelude::*;
use bsc_graph_layout::{cached_positions, layout, OrderOpts, Spacing};

/// Where layouts are cached, keyed by a content hash of (nodes, edges, params).
fn cache_dir() -> std::path::PathBuf {
    bsc_base_dir().join("graph-layout")
}

/// Lay out a graph and return interleaved `[x,y]` `f32` positions as RAW LITTLE-ENDIAN BYTES.
///
/// `edges` is a flat `[from0, to0, from1, to1, …]`; a trailing odd element is ignored rather than
/// rejected, matching the crate's own tolerance — a half-written edge should cost that edge, not the
/// whole layout. Self-loops and out-of-range endpoints are dropped by `build_csr`.
///
/// The response is `node_count * 8` bytes. `cached` is reported in the log, not in the payload, so the
/// frontend's decode path stays a single typed-array view over the whole buffer.
///
/// Errors instead of panicking on a hostile size: a `node_count` the machine cannot allocate would take
/// the whole app down from a background call.
#[tauri::command]
pub(crate) fn graph_layout(
    node_count: u32,
    edges: Vec<u32>,
    spacing_x: Option<f32>,
    spacing_y: Option<f32>,
    passes: Option<u32>,
    no_cache: Option<bool>,
) -> Result<tauri::ipc::Response, String> {
    // 16M nodes is 128 MB of output and far past anything this app can draw; refusing is kinder than
    // an allocator abort with no message.
    const MAX_NODES: u32 = 16_000_000;
    if node_count > MAX_NODES {
        return Err(format!("graph_layout: {node_count} nodes exceeds the {MAX_NODES} ceiling"));
    }
    let sp = Spacing {
        x: spacing_x.unwrap_or(Spacing::default().x),
        y: spacing_y.unwrap_or(Spacing::default().y),
    };
    let opts = OrderOpts { passes: passes.unwrap_or(OrderOpts::default().passes) };
    let started = std::time::Instant::now();
    let (xy, hit) = if no_cache.unwrap_or(false) {
        (layout(node_count, &edges, opts, sp).xy, false)
    } else {
        cached_positions(&cache_dir(), node_count, &edges, opts, sp)
    };
    let mut bytes = Vec::with_capacity(xy.len() * 4);
    for v in &xy {
        bytes.extend_from_slice(&v.to_bits().to_le_bytes());
    }
    log::info!(
        "graph_layout: {node_count} nodes, {} edges -> {} bytes in {}ms ({})",
        edges.len() / 2,
        bytes.len(),
        started.elapsed().as_millis(),
        if hit { "cache hit" } else { "computed" },
    );
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The command's own arithmetic, without Tauri: the byte length contract the frontend decodes against.
    fn positions_for(node_count: u32, edges: &[u32]) -> Vec<f32> {
        layout(node_count, edges, OrderOpts::default(), Spacing::default()).xy
    }

    #[test]
    fn the_payload_is_exactly_eight_bytes_per_node() {
        // The frontend views the whole buffer as one Float32Array and divides by 2. A payload that is not
        // an exact multiple silently shifts every node after the discrepancy.
        for n in [0u32, 1, 7, 1000] {
            let xy = positions_for(n, &[0, 1, 1, 2]);
            assert_eq!(xy.len(), n as usize * 2, "{n} nodes must yield {} floats", n * 2);
            assert_eq!(xy.len() * 4, n as usize * 8);
        }
    }

    #[test]
    fn a_trailing_half_edge_costs_that_edge_and_not_the_layout() {
        // An odd-length list is a half-written edge. Dropping it is recoverable; refusing the whole
        // layout would blank a graph over one bad pair.
        let full = positions_for(4, &[0, 1, 1, 2]);
        let ragged = positions_for(4, &[0, 1, 1, 2, 3]);
        assert_eq!(full, ragged);
    }

    #[test]
    fn out_of_range_and_self_loops_do_not_panic() {
        let xy = positions_for(3, &[0, 99, 99, 0, 2, 2, 0, 1]);
        assert_eq!(xy.len(), 6);
        assert!(xy.iter().all(|v| v.is_finite()), "no NaN reaches the renderer: {xy:?}");
    }

    #[test]
    fn zero_nodes_is_an_empty_payload_not_an_error() {
        // A graph with nothing in it is a real state (an empty kit), and it must not read as a failure.
        assert!(positions_for(0, &[]).is_empty());
    }

    #[test]
    fn the_cache_returns_identical_positions_and_reports_the_hit() {
        let dir = std::env::temp_dir().join(format!("bsc-graph-layout-cmd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let edges = [0u32, 1, 1, 2, 2, 3, 0, 3];
        let (first, hit1) = cached_positions(&dir, 4, &edges, OrderOpts::default(), Spacing::default());
        let (second, hit2) = cached_positions(&dir, 4, &edges, OrderOpts::default(), Spacing::default());
        assert!(!hit1, "the first call cannot be a hit");
        assert!(hit2, "the second call for an unchanged graph must come from the cache");
        assert_eq!(first, second, "a hit must return the same positions, not merely some");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_hostile_node_count_is_refused_rather_than_allocated() {
        // 16M nodes is 128 MB of output. The guard exists so a background call cannot abort the app in
        // the allocator, where there is no message to act on.
        // Matched rather than `unwrap_err`: `tauri::ipc::Response` is not `Debug`, so the Result's
        // unwrap helpers are unavailable — which is itself worth knowing before writing the next
        // binary command's tests.
        match graph_layout(20_000_000, vec![], None, None, None, Some(true)) {
            Err(e) => assert!(e.contains("exceeds"), "the refusal must name the limit: {e}"),
            Ok(_) => panic!("a 20M-node request must be refused, not allocated"),
        }
    }

    /// The layering this returns must match what the FRONTEND's own layerer would produce, or two
    /// surfaces will disagree about where a node belongs. The crate has the property test against the
    /// relaxation; this pins the shape the command actually ships.
    #[test]
    fn a_chain_lays_out_one_row_per_step() {
        let xy = positions_for(4, &[0, 1, 1, 2, 2, 3]);
        let y: Vec<f32> = (0..4).map(|i| xy[i * 2 + 1]).collect();
        let step = Spacing::default().y;
        assert_eq!(y, vec![0.0, step, step * 2.0, step * 3.0]);
    }
}
