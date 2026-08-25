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
//! Each is inlined as `pub mod <basename> { … }`.
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
    let mut mine: Vec<(&str, &str, &str, String, Vec<String>)> = impls
        .iter()
        .filter_map(|i| {
            let src = i.get("src")?.as_str()?;
            let rest = src.strip_prefix(&prefix)?;
            // Only direct children, and never the crate ROOT — it stays a file. `main.rs` counts as
            // one: a BINARY crate declares its modules there and `include!`s the generated file there
            // just as a lib does, so without this the root would try to materialize itself into a
            // module named `main` — and the `include!` inside it would then recurse.
            if rest.contains('/') || rest == "lib.rs" || rest == "main.rs" {
                return None;
            }
            let module = rest.strip_suffix(".rs")?;
            // ONLY THE MODULE RECORD, never a function lifted out of the same file. Both carry the same
            // `src`: `unquote.rs` is 8 lines lifted out of `crates/cve/src/install.rs`, while
            // `cve--install.rs` IS that file. Selecting on `src` alone saw two records claiming module
            // `install` and stopped the build.
            //
            // The discriminator is the id, and it is the same one `bsc graph emit` uses: a module
            // record's id is DERIVED from its path, so `<crate>--<module>.rs` is exactly the statement
            // "this record is that whole file". Rust module names are snake_case, so kebabing is a
            // `_` → `-` swap; the fuller `kebab` in `bsc_graph::extract` also splits camelCase, which
            // no Rust module name has.
            let expected = format!("{crate_dir}--{}.rs", module.replace('_', "-"));
            let id = i.get("id")?.as_str()?;
            if id != expected {
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
            Some((id, module, i.get("code")?.as_str()?, vis, attrs))
        })
        .collect();
    mine.sort_by_key(|(_, module, _, _, _)| *module);

    // TWO RECORDS CLAIMING ONE MODULE is a hard error, not a last-one-wins. It happened: renaming a
    // record onto the path-derived id scheme left the superseded id in the store with the same `src`,
    // and this script emitted `pub mod cli` twice — E0428, "the name `cli` is defined multiple times".
    // The compiler caught it, but only after a broken store had been committed; saying so HERE names the
    // cause instead of leaving a reader to work back from a duplicate-definition error.
    if let Some(dup) = mine.windows(2).find(|w| w[0].1 == w[1].1) {
        panic!(
            "two records claim module `{}` of crate `{crate_dir}`: `{}` and `{}`. One is superseded —              remove it from the store (`bsc graph impl remove <id>`) and re-promote.",
            dup[0].1, dup[0].0, dup[1].0
        );
    }

    if mine.is_empty() {
        panic!(
            "crate `{crate_dir}` opted into graph materialization but no record in {} has a `src` under {prefix}. \
             Author one (`bsc graph impl set --src {prefix}<module>.rs`) and `bsc graph promote --id <id>`.",
            store_path.display()
        );
    }

    let mut out = String::from(
        "// GENERATED by crates/graph-materialize/build.rs from graph/algorithms.json — do not edit;\n\
         // the edit would be lost on the next build. Edit the RECORD, then promote it:\n\
         //     bsc graph impl get <id>\n\
         //     bsc graph impl set --id <id> --code-file <f>\n\
         //     bsc graph promote --id <id>\n\
         // A compiler error below points at THIS file; each module header gives the line offset back\n\
         // to its record.\n\n",
    );
    for (id, module, code, vis, attrs) in mine {
        // A module's own `//!` docs are legal here ONLY because this writes a LITERAL `mod { … }` block.
        // They do NOT survive an `include!`, even inside a mod block — measured, E0753. That is why the
        // bodies are concatenated rather than each pulled in by its own include, which would have made
        // line numbers match exactly at the cost of every module's documentation.
        // ATTRIBUTES FIRST, then the declaration with its recorded visibility. Both come from the
        // record because both are part of what the module MEANS: `#[cfg(feature = "duckdb-store")]` is
        // what makes it conditional, and `pub` vs bare `mod` is the crate's API surface. An earlier cut
        // of this loop widened the tuple to carry them and then still emitted a hard-coded
        // `pub mod {module}` — it compiled, and silently un-gated three modules of `crates/data`.
        for a in &attrs {
            // SKIP an outer attribute the module body already states as an inner one. `crates/data`
            // gated `meta` twice — `#[cfg(feature = "duckdb-store")]` on the declaration in lib.rs and
            // `#![cfg(feature = "duckdb-store")]` at the top of meta.rs. Legal while they lived in two
            // files; materialization puts both on ONE item, which rustc rejects with "item has both
            // inner and outer attributes". The body's copy is inside the record and must not be
            // rewritten, so the redundant outer one is the one that gives way.
            let inner = a.trim().replacen("#[", "#![", 1);
            if code.contains(&inner) {
                continue;
            }
            out.push_str(a);
            out.push('\n');
        }
        out.push_str(&format!("{vis}mod {module} {{\n"));
        let body_starts_at = out.lines().count() + 1; // the body begins after the header line below
        out.push_str(&format!("    // record `{id}` — line N here is line N-{body_starts_at} in the record.\n"));
        out.push_str(&format!("{code}\n}}\n"));
    }

    let dest = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("crate.rs");
    std::fs::write(&dest, out).unwrap_or_else(|e| panic!("cannot write {}: {e}", dest.display()));
}
