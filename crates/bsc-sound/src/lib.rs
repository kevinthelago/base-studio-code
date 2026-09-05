//! `bsc-sound` — the sound-kit shim over the shared `bsc-json-store` (#2158, epic #3071). The user
//! sound library (`~/.base-studio-code/sounds.db`, #3080) is a verbatim-JSON-per-id store; the CRUD +
//! the `list/get/set/remove` CLI live once in [`bsc_json_store`], and this crate supplies only the
//! sound-kit-specific noun + lean `list` fields.
//!
//! A **sound kit** is a cohesive, CRUD-able set of SYNTHESIZED sounds — primitives (oscillators/noise) →
//! voices (patches: pitch + envelope + filter) → cues (UI-mapped sounds = layered voices). A sound is a
//! DESCRIPTOR (Web Audio graph), not a binary file, so it's diffable + seedable, exactly like a component
//! or an algorithm impl. It is the one store the desktop Sounds library and a live session's own shell
//! share: the desktop UI reaches it through the generic `bsc` command (`bsc sound …`, over the #2114
//! bridge), and a session's shell reaches the same store through the [`cli`] module. Packaged (built-in)
//! kits are seeded into this store on first hydrate + kept reconciled by the frontend, like the persona +
//! blueprint libraries.

//! Two stores live here, deliberately split (#3371): the FLAT working store above (mutable, SQLite,
//! keyed by bare kit id — what a session authors into), and the VERSIONED [`release`] store (immutable
//! `id@version` artifacts under `~/.base-studio-code/sound-kits/`, content-addressed by sha256 — what a
//! blueprint PINS). The release store mirrors the UI-kit one (`bsc_ui::kit`, #2465) contract-for-contract.

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/release.rs, src/tests.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-sound--<module>.rs
//     bsc graph impl set --id bsc-sound--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-sound--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-sound--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));