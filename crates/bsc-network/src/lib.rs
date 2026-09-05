//! `bsc-network` — the network-specific shim over the shared `bsc-json-store` (#2158).
//!
//! A **network** is a DOMAIN: a named set of projects that own one concern together — `kitchen`,
//! `finance`, `science` — and it owns **exactly one architect session**, the funnel's front door for
//! every project in it. Glance draws one network per tab; the architect node in that tab opens that
//! network's session.
//!
//! Before this store the app had NO grouping above a project. The only supra-project relations were the
//! nullable `architect` column on the project row and the global `bsc project link` contract table, so
//! "which projects belong together" had nowhere to live and every project shared one graph.
//!
//! # What is here, and what deliberately is not
//!
//! This store holds the network ENTITY — `{ id, name, architect?, position }` — and nothing else. The
//! ASSIGNMENT of a project to a network is a `network` column on the project row in `bsc-project`,
//! reached with `bsc project network set|clear`. That split is not arbitrary: it is exactly the seam
//! `architect` already uses (the persona lives in `bsc-persona`, the assignment is a column), and it
//! keeps a network from having to know the project list it would then have to keep in sync.
//!
//! # Naming
//!
//! A network id is MINTED and auto-disambiguated (`network-foo`, `network-foo-2`, …), the convention
//! every in-app library uses. It is deliberately NOT the `projectSlug`-plus-collision-modal discipline:
//! that exists only where an id names an on-disk hub recovered by derivation, and a network is a row.
//! Renaming is display-only — the id is frozen at creation, because the architect's pane id
//! (`network-<id>:architect`) and workspace dir are derived from it.

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/tests.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-network--<module>.rs
//     bsc graph impl set --id bsc-network--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-network--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-network--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));