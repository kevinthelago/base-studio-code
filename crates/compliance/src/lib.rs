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

pub mod cli;
pub mod engine;
pub mod mcp;
pub mod seed;
pub mod store;
pub mod types;

pub use types::{Domain, Requirement, Standard};
