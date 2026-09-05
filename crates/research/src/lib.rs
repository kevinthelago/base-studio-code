//! Native literature research for base-studio-code (#1196).
//!
//! Search/retrieve across **arXiv · Semantic Scholar · PubMed/PMC · Crossref**, extract full text
//! from PDFs natively (no Docker/GROBID), and run **citation-grounded semantic search** over the
//! fetched corpus — all offline-capable and key-less by default. Shipped as the bundled
//! `bsc-research-mcp` stdio MCP server so the planner/director/workers can ground plans & skills in
//! real sources with zero install. "Preserve the contract, swap the producer": the agent-facing MCP
//! tool surface is the contract; this crate is the native producer.
//!
//! Layering: [`sources`] hold per-source *pure parsers* (fixture-tested, no network) plus thin
//! `search`/`fetch` entry points; [`http`] is the only place that touches the network; [`cache`]
//! memoizes results; [`pdf`] extracts + chunks full text; [`search`] is the lexical retriever; and
//! [`engine`] ties them together into the five tool implementations the [`mcp`] server exposes.


pub use types::{Author, Paper, Reference, SearchQuery, Source};

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cache.rs, src/engine.rs, src/http.rs, src/mcp.rs, src/pdf.rs, src/search.rs, src/sources/mod.rs, src/sources/arxiv.rs, src/sources/crossref.rs, src/sources/pubmed.rs, src/sources/semantic_scholar.rs, src/sources/wikipedia.rs, src/types.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get research--<module>.rs
//     bsc graph impl set --id research--<module>.rs --code-file <f>
//     bsc graph promote --id research--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));