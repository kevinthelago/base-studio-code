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

pub mod cache;
pub mod engine;
pub mod http;
pub mod mcp;
pub mod pdf;
pub mod search;
pub mod sources;
pub mod types;

pub use types::{Author, Paper, Reference, SearchQuery, Source};
