//! `bsc-blueprint` — the blueprint-specific shim over the shared `bsc-json-store` (#2158). The user
//! blueprint store (`~/.base-studio-code/blueprints/<id>.json`, #1719, an instance of #1325) is a
//! verbatim-JSON-per-id file store; the store CRUD + the `list/get/set/remove` CLI now live once in
//! [`bsc_json_store`], and this crate supplies only the blueprint-specific nouns + lean `list` fields.
//!
//! It is the one store the desktop Skills/Blueprint library and every live console session share: the
//! desktop UI reaches it through the generic `bsc` command (`bsc blueprint …`, #2143), and a session's
//! own shell reaches the same store through the [`cli`] module. Built-in blueprints are code/JSON-owned
//! and out of scope — this is the user store only.
//!
//! # This crate's code is IN THE GRAPH, not in this directory
//!
//! `src/cli.rs` does not exist. It is the record `bsc-blueprint-cli.rs` in the committed
//! `graph/algorithms.json`, materialized into `$OUT_DIR` by `build.rs` and pulled in below. To change
//! it, edit the RECORD and promote it — editing a file here would be editing nothing:
//!
//! ```text
//! bsc graph impl get bsc-blueprint-cli.rs          # read it
//! bsc graph impl set --id bsc-blueprint-cli.rs --code-file <f>   # change it
//! bsc graph promote --id bsc-blueprint-cli.rs      # reach the committed store the build reads
//! ```
//!
//! This header stays a file because `include!` refuses crate-level `//!` docs and `#![…]` inner
//! attributes (E0753 / "an inner attribute is not permitted in this context"), measured rather than
//! assumed. Everything below that line is materialized.

include!(concat!(env!("OUT_DIR"), "/crate.rs"));
