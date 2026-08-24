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
//! # BOTH halves are binary (the-layout-request-is-still-json-only-the-response-is-binary)
//!
//! The response was binary from the start and the REQUEST was a JSON number array, which at this scale
//! is the wrong half to leave behind: cost tracks EDGE count, and the edge list is twice the size of the
//! output. Measured through the real command before the change — 20k/40k 14 ms, 100k/200k 75 ms,
//! 300k/600k 226 ms, of which `Array.from` alone was 2/12/38 ms. The crate lays out 1,000,000 nodes and
//! 2,000,000 edges in 256 ms, so JSON was on course to cost more than the work it delivered: 2M edges is
//! 4,000,000 numbers, ~40 MB of text, against 16 MB of `Uint32Array`.
//!
//! So the edge list arrives as the raw request BODY and the scalars ride in HEADERS. The body is nothing
//! but `u32` pairs, little-endian, which keeps its contract as simple as the response's: 8 bytes per
//! edge in, 8 bytes per node out.
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
/// Decode a little-endian `u32` edge list from the raw request body.
///
/// A trailing partial `u32` is DROPPED, for the same reason a trailing half-edge is: a truncated
/// transfer should cost the truncated edge, not the whole layout.
pub(crate) fn decode_edges(bytes: &[u8]) -> Vec<u32> {
    // `as_chunks` rather than `chunks_exact`: the size is a constant, so the compiler gets a fixed-size
    // array and the bounds checks go away. Its `.1` remainder is the trailing partial u32 — dropped, per
    // the doc above.
    bytes.as_chunks::<4>().0.iter().map(|c| u32::from_le_bytes(*c)).collect()
}

/// One header, parsed, with `None` for absent-or-unparseable.
///
/// Unparseable is treated as ABSENT rather than as an error: every scalar here is optional with a
/// documented default, and failing a 16 MB layout because a header said `"NaN"` trades a working
/// default for an outage.
fn header<T: std::str::FromStr>(req: &tauri::ipc::Request<'_>, name: &str) -> Option<T> {
    req.headers().get(name)?.to_str().ok()?.parse().ok()
}

#[tauri::command]
pub(crate) fn graph_layout(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    // The edge list is the BODY. A JSON body means an old frontend against a new backend — say so
    // rather than laying out an edgeless graph, which looks like a layout bug and is a transport one.
    let edges = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => decode_edges(bytes),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("graph_layout: expected a raw edge-list body, got JSON — the caller is out of date".into())
        }
    };
    let node_count: u32 = header(&request, "x-node-count")
        .ok_or("graph_layout: missing or unparseable x-node-count header")?;
    let bytes = layout_bytes(
        node_count,
        &edges,
        header(&request, "x-spacing-x"),
        header(&request, "x-spacing-y"),
        header(&request, "x-passes"),
        header(&request, "x-no-cache"),
    )?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The work, with the transport peeled off — everything above is parsing a `Request`.
///
/// Split out so the refusal and the byte contract stay TESTABLE: a `tauri::ipc::Request` cannot be
/// constructed in a unit test, so folding this into the command would have retired the ceiling test
/// rather than kept it, and the guard against a 20M-node allocator abort is exactly the one worth
/// keeping a test for.
pub(crate) fn layout_bytes(
    node_count: u32,
    edges: &[u32],
    spacing_x: Option<f32>,
    spacing_y: Option<f32>,
    passes: Option<u32>,
    no_cache: Option<bool>,
) -> Result<Vec<u8>, String> {
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
        (layout(node_count, edges, opts, sp).xy, false)
    } else {
        cached_positions(&cache_dir(), node_count, edges, opts, sp)
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
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The command's own arithmetic, without Tauri: the byte length contract the frontend decodes against.
    fn positions_for(node_count: u32, edges: &[u32]) -> Vec<f32> {
        layout(node_count, edges, OrderOpts::default(), Spacing::default()).xy
    }

    #[test]
    fn the_edge_list_round_trips_through_the_raw_body() {
        // the-layout-request-is-still-json-only-the-response-is-binary: the request half is now bytes
        // too. Little-endian u32 pairs — the exact bytes a `Uint32Array` view produces on the frontend.
        let edges: Vec<u32> = vec![0, 1, 1, 2, 7, 9];
        let mut bytes = Vec::new();
        for e in &edges {
            bytes.extend_from_slice(&e.to_le_bytes());
        }
        assert_eq!(decode_edges(&bytes), edges);
        assert_eq!(bytes.len(), edges.len() * 4, "4 bytes per endpoint, 8 per edge");
    }

    #[test]
    fn a_truncated_transfer_costs_the_truncated_edge_and_not_the_layout() {
        // Same tolerance the crate already applies to a trailing half-EDGE, one level lower: a partial
        // u32 is dropped rather than rejected. Refusing would turn a truncated transfer into a failed
        // layout, which is a worse answer than a layout missing the edge that did not arrive.
        let mut bytes = vec![0u8; 8]; // one whole edge: 0 -> 0
        bytes.extend_from_slice(&[1, 2, 3]); // ...and three stray bytes
        assert_eq!(decode_edges(&bytes).len(), 2, "the partial u32 is dropped, the whole edge survives");
    }

    #[test]
    fn an_empty_body_is_an_edgeless_graph_not_an_error() {
        // A graph with no edges is a real state — every node is its own root and the layout is a row.
        assert!(decode_edges(&[]).is_empty());
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
        // Against `layout_bytes`, the command with its transport peeled off: a `tauri::ipc::Request`
        // cannot be built in a unit test, so testing through the command would have meant deleting
        // this test — and the guard against an allocator abort is the last one to give up.
        match layout_bytes(20_000_000, &[], None, None, None, Some(true)) {
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
