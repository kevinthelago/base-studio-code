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

// This crate's modules are IN THE GRAPH, not in this directory.
// src/behavior.rs, src/build_script_guard.rs, src/checks.rs, src/cli.rs, src/connector.rs, src/connector_it.rs, src/ddl.rs, src/descriptor.rs, src/entity.rs, src/error.rs, src/meta.rs, src/reconcile.rs, src/rest.rs, src/runtime.rs, src/schema.rs, src/shape.rs, src/source_meta.rs, src/store.rs, src/transport.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get data--<module>.rs
//     bsc graph impl set --id data--<module>.rs --code-file <f>
//     bsc graph promote --id data--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `data--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));