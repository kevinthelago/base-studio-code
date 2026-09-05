//! Native compliance-standards source of truth for base-studio-code (#1005).
//!
//! The single, **user-updatable** store of current **regulation / accessibility / user-protection
//! standards** (WCAG 2.2 AA, GDPR, CCPA/CPRA, SOC 2, user-protection basics), queried by the project
//! planner so every plan bakes in the right requirements — and refreshable **without an app release**
//! (the standards live in the store; `reseed`/`upsert` update them). Shipped as the bundled
//! `bsc-compliance-mcp` stdio MCP server. "Preserve the contract, swap the producer": the agent-facing
//! MCP tool surface is the contract; this crate is the native producer behind it.
//!
//! Layering: [`types`] is the normalized standard/requirement model (pure data + serde); [`seed`] is
//! the baseline corpus; [`store`] is the SQLite source of truth (seeded on first open, user-editable);
//! [`engine`] is the query + scoping logic; and [`mcp`] exposes the five tools the planner calls.


pub use types::{Domain, Requirement, Standard};

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/engine.rs, src/mcp.rs, src/seed.rs, src/store.rs, src/types.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get compliance--<module>.rs
//     bsc graph impl set --id compliance--<module>.rs --code-file <f>
//     bsc graph promote --id compliance--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `compliance--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));