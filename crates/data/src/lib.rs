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

pub mod schema;
pub mod ddl;
pub mod connector;
pub mod reconcile;
pub mod error;
pub mod infer;
pub mod salesforce;

#[cfg(feature = "duckdb-store")]
pub mod store;

pub use error::{DataError, Result};
pub use schema::{DataModel, Entity, Field, FieldType};
pub use connector::{Connector, CsvConnector, RowSet, SourceObject};
pub use reconcile::{reconcile, MergedRecord, Precedence, Reconciled, SourceLoad};
pub use infer::{infer, EntityInference, FieldProvenance, InferResult};

#[cfg(feature = "duckdb-store")]
pub use store::{DataStore, LoadSource};
