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

// The `bsc data` subcommand (#1877) — extracted from the old `bsc-data` binary. Needs the
// DuckDB-backed MetaStore/DataStore, so it's gated like the store (mirrors the bin's
// `required-features = ["duckdb-store"]`).
#[cfg(feature = "duckdb-store")]
pub mod cli;

pub mod schema;
// Schema → data-shape inference (#2478): derive each entity's ideal rendering shape from the
// canonical model, so the planner's layout pick (#2475 `bsc ui shapes`) is mechanical. Pure —
// no store, no Tauri.
pub mod shape;
pub mod ddl;
pub mod connector;
pub mod reconcile;
pub mod error;
pub mod behavior;
pub mod rest;
pub mod runtime;
pub mod source_meta;
pub mod descriptor;
// Connector dev-loop transport (#1963): authed HTTP + OS-keychain + sample inference for the
// `bsc data connector probe/try/map` verbs. Pure inference is unit-tested; the network stays behind
// `build_fetch`. Compiled unconditionally (the verbs that drive it live in the gated `cli`).
pub mod transport;

#[cfg(feature = "duckdb-store")]
pub mod store;
#[cfg(feature = "duckdb-store")]
pub mod meta;

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
