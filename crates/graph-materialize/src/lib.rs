//! The SHARED materializer for every crate whose source lives in the graph (files-to-zero, 2026-08-19).
//!
//! # The two ways in
//!
//! **As a shared build script**, which is how the 54 crates migrated before this package existed reach
//! it — one line in `Cargo.toml`:
//!
//! ```toml
//! build = "../graph-materialize/build.rs"
//! ```
//!
//! and one more pointing the crate root at the SHARED one, so the crate owns no source file at all:
//!
//! ```toml
//! [lib]
//! path = "../graph-materialize/crate_root.rs"
//! ```
//!
//! **As a real build-dependency**, which is how a crate that ALREADY OWNS a build script reaches it —
//! a package gets exactly one build script, so a shared file is no use to it:
//!
//! ```toml
//! [build-dependencies]
//! graph-materialize = { path = "../crates/graph-materialize" }
//! ```
//!
//! ```ignore
//! fn main() {
//!     my_first_job();
//!     my_second_job();
//!     graph_materialize::emit();
//! }
//! ```
//!
//! Both run THE SAME SOURCE. `build.rs` and this file `include!` `plan.rs` and `emit.rs` beside them,
//! so there is one implementation with two entry points rather than a copy that can drift — the same
//! shape `plan.rs` already used to share the planning rules with `bsc-graph`'s tests.
//!
//! # What it materializes
//!
//! Every record in the committed store whose `src` sits under THIS crate's `src/` directory. The root
//! (`lib.rs`) is not a module and is materialized SEPARATELY, into `$OUT_DIR/crate_doc.md`, by
//! [`Plan::select_doc`] — it is the crate's own `//!` prose, and the shared
//! `crates/graph-materialize/crate_root.rs` picks it up with
//! `#![doc = include_str!(concat!(env!("OUT_DIR"), "/crate_doc.md"))]`.
//!
//! THE ROOT USED TO BE PERMANENT FLOOR HERE, "because `include!` refuses crate-level `//!` docs and
//! `#![…]` inner attributes (E0753)". That refusal is about an INCLUDED file; the inner attribute
//! above sits in the REAL root and is perfectly legal, so two adopters share one root file and still
//! get different rustdoc. See `a-crate-root-is-shared-so-a-crate-is-one-file`.
//!
//! Nested directories are materialized as a `mod` tree mirroring the directory tree
//! (`graph-materialize-takes-nested-modules-and-mod-rs`) — `src/cli/nouns.rs` becomes
//! `mod cli { … mod nouns { … } }` — and `<dir>/mod.rs` maps to its DIRECTORY name, never to a module
//! literally called `mod`.
//!
//! # Depth is derived, never assumed
//!
//! The repo root is the nearest ancestor of the manifest holding `graph/algorithms.json`, and the
//! source prefix is the manifest's path relative to it. Until
//! `graph-materialize-becomes-a-real-build-dependency` the root was
//! `manifest.parent().parent()` with `expect("crates/<name> is two deep")` and the prefix was the
//! literal `crates/<name>/src/`, so a crate one level deep resolved OUTSIDE the repo and matched no
//! record. See [`repo_root_by_walk`] and [`src_prefix`].
//!
//! # Why the store is read DIRECTLY
//!
//! `graph/algorithms.json` is COMMITTED so this works in a fresh clone, in CI and in every nested
//! zero-install worktree. It is parsed with `serde_json` rather than through `bsc_graph`, because a
//! build script must not depend on the crate graph it is part of, and `bsc_graph::load()` reconciles
//! the packaged seed — which would pull 676 unrelated implementations into a build input.
//!
//! # The cost this imposes, stated plainly
//!
//! Materializing puts the store on the crate's `rerun-if-changed` list, so a record edit ANYWHERE
//! rebuilds every crate that materializes and re-links whatever depends on them. MEASURED 2026-09-04 in
//! a warm worktree, before this package existed and with `src-tauri` owning zero records: `touch
//! graph/algorithms.json && cargo build -p base-studio-code` recompiled 33 of the app's path
//! dependencies and re-linked the app in 23.7s / 11.6s / 15.1s at ~1.64 GB peak RSS. So the app already
//! pays that on every record edit, and wiring `src-tauri` itself adds a build-script run, not a link.
//!
//! # Failure is loud
//!
//! A missing store, unparseable JSON, or a crate that opted in while owning no records is a hard error
//! naming what it looked for. There is deliberately no fallback to a file: the file is gone, and a
//! build that quietly produced an empty module is the silent-success failure this repo keeps paying
//! for. The one exception is [`Adoption::Optional`], for a crate wired AHEAD of its first record, whose
//! `lib.rs` does not `include!` anything yet.

// The planning core and the emit half live beside this file rather than under `src/`, because
// `build.rs` — the entry point the 54 existing adopters compile — `include!`s the same two files. One
// implementation, two entry points. They use `//` and never `//!` for exactly the E0753 reason above.
include!("../plan.rs");
include!("../emit.rs");

// The manifest as a RECORD, and the driver that builds and tests a crate from records with cargo out
// of the loop (`a-crate-builds-and-tests-from-the-database`). They live under `src/` rather than beside
// `plan.rs`/`emit.rs` deliberately: `build.rs` `include!`s those two, and a build script must not grow
// a dependency on the driver it has no use for.
pub mod drive;
pub mod manifest;

#[cfg(test)]
mod tests;

// The integration-test half — a crate's `tests/*.rs` targets, materialized from the EDGE tier
// (`a-rust-record-test-runs-and-an-edge-reaches-the-seed`). Its own module because it asserts its own
// selection rule, output directory and shared root file, and shares no fixture with `tests`.
#[cfg(test)]
mod test_targets;
