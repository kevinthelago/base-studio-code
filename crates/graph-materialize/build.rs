//! The SHARED build script for every crate whose source lives in the graph (files-to-zero, 2026-08-19).
//!
//! A crate opts in with one line in its `Cargo.toml`:
//!
//! ```toml
//! build = "../graph-materialize/build.rs"
//! ```
//!
//! and one line in its `src/lib.rs`:
//!
//! ```ignore
//! include!(concat!(env!("OUT_DIR"), "/crate.rs"));
//! ```
//!
//! That is the whole cost per crate. Sharing this file rather than copying it per crate is what makes
//! the migration actually reduce files: a per-crate `build.rs` costs exactly as much as the module it
//! replaces, so a two-file crate would net ZERO. Measured on `bsc-blueprint` before this was shared —
//! 2 files in, 2 files out. Shared, the floor is one `src/lib.rs` per crate plus this one script.
//!
//! # What it materializes
//!
//! Every record in the committed store whose `src` sits under THIS crate's `src/` directory, except
//! `lib.rs` — which stays a real file because `include!` refuses crate-level `//!` docs and `#![…]`
//! inner attributes (E0753 / "an inner attribute is not permitted in this context", both measured).
//!
//! NESTED DIRECTORIES ARE MATERIALIZED TOO (`graph-materialize-takes-nested-modules-and-mod-rs`), as a
//! `mod` tree mirroring the directory tree — `src/cli/nouns.rs` becomes `mod cli { … mod nouns { … } }`
//! — and `<dir>/mod.rs` maps to its DIRECTORY name, never to a module literally called `mod`. The rules
//! and the reasoning live in `plan.rs` beside this file, which is `include!`d here AND by
//! `crates/bsc-graph/src/migrate.rs`'s tests, so the tests drive this exact source rather than a copy.
//!
//! # Why the store is read DIRECTLY
//!
//! `graph/algorithms.json` is COMMITTED so this works in a fresh clone, in CI and in every nested
//! zero-install worktree. It is parsed with `serde_json` rather than through `bsc_graph`, because a
//! build script must not depend on the crate graph it is part of, and `bsc_graph::load()` reconciles the
//! packaged seed — which would pull 676 unrelated implementations into a build input.
//!
//! # Failure is loud
//!
//! A missing store, unparseable JSON, or a crate that opted in while owning no records is a hard error
//! naming what it looked for. There is deliberately no fallback to a file: the file is gone, and a build
//! that quietly produced an empty module is the silent-success failure this repo keeps paying for.

use std::path::{Path, PathBuf};

// The pure planning core, shared VERBATIM with the tests in `crates/bsc-graph/src/migrate.rs`. A build
// script has no test target of its own — `crates/graph-materialize` is not a package — so the rules
// that decide which file is which module, which id names it, and how the line offsets are computed
// would otherwise be assertable only by compiling a crate and reading the output.
include!("plan.rs");

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let repo_root = manifest.parent().and_then(Path::parent).expect("crates/<name> is two deep");
    let store_path = repo_root.join("graph").join("algorithms.json");

    // A record edit MUST reach the compiler — the cost files-to-zero accepted. Note this watches the
    // REPO store only: the packaged seed at src-tauri/data/knowledge/ is a different file and stays off
    // the Rust rebuild path, so `data-edits-must-not-rebuild-rust` (~28s -> 2.0s) still holds for the
    // UI/designer record edits it was won for. Verified: touching the seed compiles 0 crates.
    println!("cargo:rerun-if-changed={}", store_path.display());
    println!("cargo:rerun-if-changed={}", manifest.join("..").join("graph-materialize").join("build.rs").display());
    // …and the planning core it includes. Without this an edit to `plan.rs` changes what every migrated
    // crate compiles to and cargo rebuilds none of them — the silent-success failure this file's own
    // "failure is loud" section exists to avoid.
    println!("cargo:rerun-if-changed={}", manifest.join("..").join("graph-materialize").join("plan.rs").display());

    let crate_dir = manifest.file_name().and_then(|s| s.to_str()).expect("crate dir name");
    let prefix = format!("crates/{crate_dir}/src/");

    let raw = std::fs::read_to_string(&store_path)
        .unwrap_or_else(|e| panic!("cannot read the committed graph store at {}: {e}", store_path.display()));
    let store: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", store_path.display()));
    let impls = store
        .get("implementations")
        .and_then(|v| v.as_array())
        .unwrap_or_else(|| panic!("{} has no `implementations` array", store_path.display()));

    // Deterministic order: cargo reruns this on every store change and a shuffled output would recompile
    // the crate for no reason.
    let mut mine: Vec<Unit> = impls
        .iter()
        .filter_map(|i| {
            let src = i.get("src")?.as_str()?;
            let rest = src.strip_prefix(&prefix)?;
            // Which MODULE this file is, at ANY depth — `src/cli/nouns.rs` is `cli::nouns` and
            // `src/signals/mod.rs` is `signals`. `None` is the crate ROOT and a stray `src/mod.rs`; see
            // `plan.rs::module_path` for why `main.rs` counts as a root.
            let path = module_path(rest)?;
            // ONLY THE MODULE RECORD, never a function lifted out of the same file. Both carry the same
            // `src`: `unquote.rs` is 8 lines lifted out of `crates/cve/src/install.rs`, while
            // `cve--install.rs` IS that file. Selecting on `src` alone saw two records claiming module
            // `install` and stopped the build.
            //
            // The discriminator is the id, and it is the same one `bsc graph emit` uses: a module
            // record's id is DERIVED from its path, so it is exactly the statement "this record is that
            // whole file". `plan.rs::expected_id` is that derivation, and
            // `expected_id_agrees_with_extract_module_id` pins it against `extract::module_id` over
            // every real path in this tree rather than asserting the two agree.
            let id = i.get("id")?.as_str()?;
            if id != expected_id(crate_dir, rest) {
                return None;
            }
            // HOW the module is declared travels on the record. `moduleVis` defaults to `pub` because
            // that was the only shape before this existed; `private` emits a bare `mod`. `moduleAttrs`
            // are emitted verbatim above the declaration, which is what keeps a `#[cfg(feature = "…")]`
            // gate intact — materialising a gated module without it makes it unconditional, and that is
            // a change to the program rather than to its formatting.
            let vis = match i.get("moduleVis").and_then(|v| v.as_str()) {
                Some("private") | Some("") => String::new(),
                Some(v) => format!("{v} "),
                None => "pub ".to_string(),
            };
            let attrs: Vec<String> = i
                .get("moduleAttrs")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            Some(Unit { id: id.to_string(), path, code: i.get("code")?.as_str()?.to_string(), vis, attrs })
        })
        .collect();
    // Deterministic order: cargo reruns this on every store change and a shuffled output would recompile
    // the crate for no reason. `render` sorts by module PATH, which is that order.
    mine.sort_by(|a, b| a.path.cmp(&b.path));

    if mine.is_empty() {
        panic!(
            "crate `{crate_dir}` opted into graph materialization but no record in {} has a `src` under {prefix}. \
             Author one (`bsc graph impl set --src {prefix}<module>.rs`) and `bsc graph promote --id <id>`.",
            store_path.display()
        );
    }

    // The duplicate-module and missing-parent hard errors live in `render` — see `plan.rs`, which is
    // where a test can reach them. TWO RECORDS CLAIMING ONE MODULE is not a last-one-wins: it happened,
    // when renaming a record onto the path-derived id scheme left the superseded id in the store with
    // the same `src`, and the emitted `pub mod cli` twice reached the compiler as E0428.
    let out = render(mine, crate_dir, PREAMBLE).unwrap_or_else(|e| panic!("{e}"));

    let dest = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("crate.rs");
    std::fs::write(&dest, out).unwrap_or_else(|e| panic!("cannot write {}: {e}", dest.display()));
}
