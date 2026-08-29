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

/// Which record backs a given file (#4193) — the lookup behind `bsc ui backing` and the write gate.
pub mod backing;
pub mod cli;
/// The RECORD closure a `bsc ui test` materialization writes around a record — the app's own
/// `provides` resolution chain, so a composing component can be verified and not just a leaf.
pub(crate) mod closure;
/// A record's PUBLIC SURFACE — what its module exports, grouped into the ITEMS those exports name.
/// The cross-pillar reference METER (`store-the-three-cross-pillar-edges`) — the number
/// `epic-one-record-core-across-the-graphs` rested its one-record-type decision on, kept checkable.
pub mod crossgraph;
pub mod exports;
pub mod feature;
pub mod folder;
pub mod graph_health;
/// Whether a NAMED import actually names something the target module exports, following `export *`
/// barrels (#149) — the SYMBOL-level counterpart to `graph_health`'s module-level `unresolvable-import`.
pub(crate) mod import_symbols;
/// A PATTERN — the library's structural conventions, given an id.
pub mod patterns;
pub mod motion;
pub mod preview_errors;
pub mod preview_props;
/// The record stamp now lives in the shared `bsc-record` crate (#72) so the ALGORITHMS graph stamps
/// writes through the same implementation rather than growing a second one that drifts. Re-exported
/// under the old path, so every `crate::record::…` call site here is unchanged.
pub use bsc_record as record;
pub mod scan_cache;
pub mod similarity;
pub mod syntax;
pub mod usage;
pub mod usage_scan;

pub use feature::{feature_from_folder, CORE, SHELL};
pub use folder::folder_from_src;
