//! `bsc-data` — the data-platform substrate for base-studio-code.
//!
//! Two pieces, mirroring the spec (`docs/data-platform-spec.md`):
//! - a canonical **Data Model** ([`schema`]) and a **DuckDB-backed store** ([`store`])
//!   that materializes it as typed tables with per-row **lineage** (#781);
//! - a **connector framework** ([`connector`]) that reads from a source into a
//!   [`connector::RowSet`], starting with a reference CSV connector (#784).
//!
//! Migration is strictly **read-only** from the source (decided #782): connectors
//! only read; the store only loads into the Data Model — nothing writes back.
//!
//! # This crate has TWO build jobs, and one of them cannot be observed here
//!
//! `build.rs` materializes this crate's modules out of the graph **and** links DuckDB's Restart
//! Manager import library on Windows. See [`build_script_guard`] for why the second one needs a test
//! that reads source rather than a test that runs.

#[cfg(feature = "duckdb-store")]
pub use meta::MetaStore;
pub use error::{DataError, Result};
pub use schema::{DataModel, Entity, Field, FieldType};
pub use shape::{infer_entity_shapes, infer_shapes, Confidence, DataShape, EntityShapes, ShapeCandidate};
pub use connector::{Connector, CsvConnector, FetchFn, RowSet, SourceField, SourceObject};
pub use reconcile::{reconcile, verify_reconciled, MergedRecord, Precedence, Reconciled, SourceLoad, VerifyResult};
pub use behavior::{
    Automation, AutomationKind, BusinessProcess, DerivedKind, DerivedLogic, PlatformScan,
};
pub use rest::{RestConnector, RestResource};
pub use runtime::{
    find_runtime_preset, load_runtime_presets, remove_runtime_preset, runtime_store_path,
    save_runtime_presets, upsert_runtime_preset, RuntimePreset, RuntimeResource,
    RUNTIME_AUTH_KINDS,
};
pub use source_meta::{LiveSupport, SourceAuth};
pub use transport::{build_fetch, resolve_source_secret};
pub use descriptor::{
    find as source_connector, ConnectorDescriptor, ConnectorKind, ResourceDef, RestPreset, BUILTINS,
};

#[cfg(feature = "duckdb-store")]
pub use store::{DataStore, LoadSource};

/// The one job of this crate's `build.rs` that NOTHING on a non-Windows box can exercise.
///
/// `libduckdb-sys` references the Restart Manager API on Windows without linking its import library,
/// so `build.rs` emits `cargo:rustc-link-lib=dylib=rstrtmgr` under a `CARGO_CFG_TARGET_OS ==
/// "windows"` guard. **Losing it is invisible everywhere it can be tested and breaks the Windows
/// link.** That asymmetry is the whole reason `bsc graph migrate-crate` refuses this crate on the
/// shared-build-script route (`refuse_reason`, `crates/bsc-graph/src/migrate.rs`) — the shared script
/// would have REPLACED `build.rs`, and every test on this machine would still have passed.
///
/// The crate adopted the materializer with `--alongside` instead, keeping its own `build.rs` and
/// calling `graph_materialize::emit()` from it as one more job
/// (`the-two-build-rs-crates-adopt-the-materializer-alongside-their-own`). So the invariant now has
/// two halves, and this module asserts BOTH: the directive is still emitted under the same `cfg`
/// condition, **from a build script cargo still runs**.
///
/// It reads SOURCE because there is nothing else to read. A runtime assertion would need a Windows
/// target; a build assertion would be the thing under test. `crates/bsc-config/src/lib.rs` reads its
/// own `build.rs` the same way and for the same reason.
#[cfg(test)]
mod build_script_guard {
    /// This crate's build script, as text. `../build.rs` from `src/lib.rs` is `crates/data/build.rs`,
    /// which is the file cargo AUTO-DETECTS — the manifest names no `build` key, and the third
    /// assertion below is what keeps that true.
    const BUILD_RS: &str = include_str!("../build.rs");
    const CARGO_TOML: &str = include_str!("../Cargo.toml");

    #[test]
    fn the_windows_restart_manager_link_survives_alongside_the_materializer() {
        // The directive itself. Written out rather than pattern-matched: this is the exact string the
        // Windows linker needs, and a looser check would pass for a typo in the library name.
        assert!(
            BUILD_RS.contains(r#"println!("cargo:rustc-link-lib=dylib=rstrtmgr");"#),
            "crates/data/build.rs no longer emits the rstrtmgr link directive — the DuckDB Windows \
             link breaks and NOTHING on a non-Windows box can observe it:\n{BUILD_RS}"
        );

        // …and its GUARD. An unconditional directive would be a different bug — it would ask every
        // platform to link a Windows-only library — so the condition is part of the invariant.
        assert!(
            BUILD_RS.contains(r#"std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")"#),
            "the rstrtmgr link is no longer guarded on the WINDOWS target: {BUILD_RS}"
        );

        // …and the script is still the one cargo RUNS. `crates/data/build.rs` is auto-detected, so a
        // `build = "…"` key pointing anywhere else would leave this file on disk, still passing both
        // assertions above, and never executed. That is the failure mode this crate exists to warn
        // about, one level up.
        let build_key = CARGO_TOML
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("build") && l.contains('='));
        assert!(
            build_key.is_none_or(|l| l.contains("\"build.rs\"")),
            "Cargo.toml redirects the build script away from crates/data/build.rs ({build_key:?}), so \
             the rstrtmgr directive is dead code"
        );
    }

    /// The OTHER half of the same build script, asserted here so the two jobs are pinned together: a
    /// change that drops either one is a change to a file this test reads.
    #[test]
    fn the_materializer_is_called_from_this_crates_own_build_script() {
        assert!(
            BUILD_RS.contains("graph_materialize::emit();"),
            "crates/data/build.rs no longer calls the materializer: {BUILD_RS}"
        );
        assert!(
            CARGO_TOML.contains(r#"graph-materialize = { path = "../graph-materialize" }"#),
            "the call needs graph-materialize under [build-dependencies]: {CARGO_TOML}"
        );
        // A package gets exactly ONE build script. Taking the shared one would silently replace the
        // file the test above reads.
        assert!(
            !CARGO_TOML.contains("../graph-materialize/build.rs"),
            "this crate must NOT point `build =` at the shared script — it has its own: {CARGO_TOML}"
        );
    }
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/schema.rs, src/shape.rs, src/ddl.rs, src/connector.rs, src/entity.rs, src/reconcile.rs, src/error.rs, src/behavior.rs, src/rest.rs, src/runtime.rs, src/source_meta.rs, src/descriptor.rs, src/checks.rs, src/transport.rs, src/connector_it.rs, src/store.rs, src/meta.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by `graph_materialize::emit();`, called from this
// crate's own build.rs (a package gets exactly ONE build script, and this one was taken).
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get data--<module>.rs
//     bsc graph impl set --id data--<module>.rs --code-file <f>
//     bsc graph promote --id data--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));