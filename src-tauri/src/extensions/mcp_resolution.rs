//! Which MCP servers a session gets — RE-EXPORTED from `crates/bsc-resolve`.
//!
//! The decision moved out of this binary on
//! `the-resolution-decisions-live-in-the-app-binary-not-a-crate`. Its only coupling to the app was
//! reading `mcp/builtin-servers.json` through `platform::config::load_str`, which the crate now does
//! for itself through `bsc-config` — the SAME on-disk-wins-then-packaged precedence, so the app and a
//! `bsc` call resolve identical built-ins for the same session.
//!
//! This module survives as a SHIM so no call site or test had to change with the move — notably
//! `console/pty/mod.rs`, which names these types directly and is the file the move exists to stop
//! churning.

// EXACTLY what this binary uses — see the note in `skill_resolution.rs`. `builtin_mcp_servers_from`
// (the pure parse) stays on the crate, where the CLI and the tests reach it.
pub use bsc_resolve::mcp::{
    builtin_mcp_servers, mcp_reachable_from, reconcile_mcp, resolve_persona_mcp, to_bsc_agent_mcp,
    to_mcp_payload, BscAgentMcpCfg, McpServer,
};
