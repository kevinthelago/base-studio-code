//! `bsc-blueprint` — the blueprint-specific shim over the shared `bsc-json-store` (#2158). The user
//! blueprint store (`~/.base-studio-code/blueprints/<id>.json`, #1719, an instance of #1325) is a
//! verbatim-JSON-per-id file store; the store CRUD + the `list/get/set/remove` CLI now live once in
//! [`bsc_json_store`], and this crate supplies only the blueprint-specific nouns + lean `list` fields.
//!
//! It is the one store the desktop Skills/Blueprint library and every live console session share: the
//! desktop UI reaches it through the generic `bsc` command (`bsc blueprint …`, #2143), and a session's
//! own shell reaches the same store through the [`cli`] module. Built-in blueprints are code/JSON-owned
//! and out of scope — this is the user store only.

pub mod cli;
