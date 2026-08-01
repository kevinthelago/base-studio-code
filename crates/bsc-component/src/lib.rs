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

pub mod cli;
pub mod folder;
pub mod graph_health;
pub mod motion;
pub mod preview_errors;
pub mod preview_props;
pub mod record;
pub mod similarity;
pub mod syntax;
pub mod usage;

pub use folder::folder_from_src;
