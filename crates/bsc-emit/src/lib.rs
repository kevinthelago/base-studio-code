//! Materialize retired modules from their packaged seeds into a generated, git-ignored tree.
//!
//! Ported from `scripts/emit-records.mjs` (502 LOC), which is deleted with this change along with
//! `scripts/lib/recordSource.mjs` — the last two-implementation state in the record system.
//!
//! ## WHY NOT A BUNDLER PLUGIN
//!
//! The original author wrote one first, and deleting a single file proved it insufficient in three
//! different ways at once:
//!
//! ```text
//! vite build  — failed on `'./layout/Spacer'`, a RELATIVE import. A plugin matching `@/…` never sees it.
//! tsc         — TS2307 from three files. The type checker has no plugin API of this kind.
//! vitest      — has its OWN config, so the plugin was never loaded.
//! ```
//!
//! Three resolvers, three mechanisms, and a plugin only ever fixes one. The thing all three DO agree
//! on is a file on disk. So instead of teaching each tool about records, emit the record AS a file
//! into a generated tree and let `tsconfig.paths` fallback order do the rest:
//!
//! ```text
//! "@/*": ["src/*", ".bsc-records/*"]     // src wins; the record answers only what src no longer has
//! ```
//!
//! ## THIS IS NOT "MOVING THE FILE"
//!
//! The emitted tree is GIT-IGNORED and regenerated from the seed on every build/typecheck/test. The
//! repository genuinely loses the module; what exists on disk afterwards is a derived cache, the same
//! status `node_modules` has. If the emitted copy is ever edited, the next run overwrites it — the
//! seed is the source of truth, which is the entire point of the migration.
//!
//! ## ORDER IS NOT PART OF THE CONTRACT, and the port says so rather than pretending
//!
//! The JavaScript built its seed map in `readdirSync` order, which is filesystem order and already
//! differs between machines. Nothing downstream depends on it: `willEmit` is a set, the emitted files
//! are a path-keyed map, and every console listing sorts before printing. This port therefore SORTS
//! the walk, so two runs on one machine and two runs on different machines agree — and the parity
//! test compares sorted whole values, which is the only comparison that could ever have been honest.


pub use emit::{emit_records, prune_empty_dirs, stale_emitted, write_if_changed, EmitReport};
pub use plan::{edge_test_path, ext_for, plan_records, EdgeTest, Plan, PlannedModule, PlannedTest, Unresolvable};

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/emit.rs, src/plan.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-emit--<module>.rs
//     bsc graph impl set --id bsc-emit--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-emit--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-emit--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));