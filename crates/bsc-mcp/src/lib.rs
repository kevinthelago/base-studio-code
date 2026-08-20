//! `bsc-mcp` — the MCP server store, and the verbs that assign a server to a PERSONA.
//!
//! ## A server reaches a session because a persona carries it
//!
//! That is the whole model, and it replaces three mechanisms that used to answer the same question:
//! project scoping (`McpServer.projects[]`), per-stream assignment (`streamMcp`), and a per-pane
//! override (`paneMcpServers`). A skill already worked this way — `persona.skills` — and an MCP
//! server is the same kind of thing: injectable capability an agent draws on. Now it is stored the
//! same way and assigned the same way.
//!
//! The store itself is the shared verbatim-JSON-per-id store (`~/.base-studio-code/mcp.db`), so this
//! crate supplies only the MCP-specific nouns plus `assign`/`unassign`, which are read-modify-writes
//! of the PERSONA record rather than of anything here — the assignment lives with the carrier, so
//! there is exactly one owner of it and the two stores cannot disagree.
//!
//! ## The system servers are not in this store
//!
//! `research` / `compliance` / `cve` / `channel-mock` ship in the app bundle
//! (`@data/mcp/builtin-servers.json`) and are spawned as `bsc mcp <server>`. They are the app's own
//! capability, not user data, so they are not copied in here — the same reason packaged personas are
//! seeded rather than authored.

pub mod cli;
