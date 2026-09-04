//! `bsc fin` — the personal finance store.
//!
//! A LOCAL surface, and the locality is a requirement rather than a default. Statements are parsed on
//! this machine, into a store on this machine, and no verb here sends anything anywhere. The analysis
//! that runs over it is meant to run on a LOCAL model for the same reason: a bank statement is not
//! something to hand to a third party in order to be told what is in it.
//!
//! A COMMAND SURFACE, not a server. `bsc` is in the mandatory permission tier every session role can
//! already run, so a worker or an architect reaches this with no grant — where an MCP server would
//! need registering, scoping and keeping alive to do the same job worse.
//!
//! Amounts are integer MINOR UNITS end to end ([`money`]). The parse never constructs a float, so a
//! figure in the store is the figure on the statement.

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/money.rs, src/statement.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-fin--<module>.rs
//     bsc graph impl set --id bsc-fin--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-fin--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));