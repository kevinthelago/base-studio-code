//! `bsc-component` — the component-library store (#2281). The proven-component **kits** (technology-
//! scoped namespaces) + the **components** in them, a verbatim-JSON-per-id file store over the shared
//! [`bsc_json_store`] (#2158): components at `~/.base-studio-code/components/<id>.json`, kits at
//! `~/.base-studio-code/kits/<id>.json`.
//!
//! It's the one store the desktop Component Library pane (#2269), the planner's `test_ui` stage (#2274),
//! and every live session share: the UI reaches it through the generic `bsc` command
//! (`bsc ui …`, over the #2114 bridge — the store verbs are mounted under `bsc ui` per #2469, with
//! `bsc component` a deprecated alias), and a session's own shell reaches the SAME store through
//! the [`cli`] module — so an agent building UI reads the kit (and doesn't re-invent a component) straight
//! from bash. Packaged (built-in) kits/components are seeded into this store on first hydrate + kept
//! reconciled by the frontend, exactly like the user persona/blueprint libraries.
//!
//! Home, too, for the later consumer index (#2277) + the kit lint rules (#2279) — both ride on this
//! store's records.

/// The record stamp now lives in the shared `bsc-record` crate (#72) so the ALGORITHMS graph stamps
/// writes through the same implementation rather than growing a second one that drifts. Re-exported
/// under the old path, so every `crate::record::…` call site here is unchanged.
pub use bsc_record as record;

pub use feature::{feature_from_folder, CORE, SHELL};
pub use folder::folder_from_src;

// This crate's modules are IN THE GRAPH, not in this directory.
// src/backing.rs, src/cli.rs, src/closure.rs, src/crossgraph.rs, src/exports.rs, src/feature.rs, src/folder.rs, src/graph_health.rs, src/import_symbols.rs, src/motion.rs, src/patterns.rs, src/preview_errors.rs, src/preview_props.rs, src/scan_cache.rs, src/similarity.rs, src/syntax.rs, src/usage.rs, src/usage_scan.rs, src/usage_sources.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-component--<module>.rs
//     bsc graph impl set --id bsc-component--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-component--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-component--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));