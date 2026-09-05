//! The SHARED build script for every crate whose source lives in the graph (files-to-zero, 2026-08-19).
//!
//! A crate opts in with one line in its `Cargo.toml`:
//!
//! ```toml
//! build = "../graph-materialize/build.rs"
//! ```
//!
//! and one more pointing its crate root at the SHARED one beside this file:
//!
//! ```toml
//! [lib]
//! path = "../graph-materialize/crate_root.rs"
//! ```
//!
//! That is the whole cost per crate, and it is ZERO FILES. Sharing this script rather than copying it
//! per crate is what makes the migration actually reduce files: a per-crate `build.rs` costs exactly
//! as much as the module it replaces, so a two-file crate would net ZERO. Measured on `bsc-blueprint`
//! before this was shared — 2 files in, 2 files out.
//!
//! THE FLOOR WAS ONE `src/lib.rs` PER CRATE PLUS THIS SCRIPT, and it is not any more
//! (`a-crate-root-is-shared-so-a-crate-is-one-file`). `crate_root.rs` beside this file is that root,
//! byte-identical for every adopter because it IS one file; both halves it needs come out of the
//! per-crate `$OUT_DIR` this script writes — `crate.rs` (the modules) and `crate_doc.md` (the crate's
//! own `//!` prose, from its `<crate>--lib.rs` doc record). A crate at the floor is a `Cargo.toml`
//! and nothing else.
//!
//! # This is a THIN ENTRY POINT, not the implementation
//!
//! The rules live in `plan.rs` (which file is which module, which id names it, the line-offset
//! arithmetic) and `emit.rs` (where the repo root is, which records are this crate's, the one write),
//! beside this file. `src/lib.rs` `include!`s the SAME two files, so the package
//! `graph-materialize` — which a crate that already owns a build script takes as a
//! `[build-dependencies]` entry and calls as `graph_materialize::emit()` — runs this exact source
//! rather than a copy of it. That is what made `src-tauri` adoptable
//! (`graph-materialize-becomes-a-real-build-dependency`): it has its own `build.rs` doing four jobs,
//! and a package gets exactly one build script.
//!
//! Which means the 54 crates pointing their `build =` key here and any crate taking the
//! build-dependency emit byte-identical output BY CONSTRUCTION, not by agreement.

include!("plan.rs");
include!("emit.rs");

fn main() {
    emit();
}
