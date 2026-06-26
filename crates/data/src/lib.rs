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
pub mod behavior;
pub mod salesforce;
pub mod monday;
pub mod quickbooks;
pub mod quickbase;
pub mod hubspot;
pub mod odata;
pub mod fhir;
pub mod rest;
pub mod presets;
pub mod runtime;
pub mod registry;
pub mod descriptor;

#[cfg(feature = "duckdb-store")]
pub mod store;
#[cfg(feature = "duckdb-store")]
pub mod meta;

#[cfg(feature = "duckdb-store")]
pub use meta::MetaStore;
pub use error::{DataError, Result};
pub use schema::{DataModel, Entity, Field, FieldType};
pub use connector::{Connector, CsvConnector, RowSet, SourceField, SourceObject};
pub use reconcile::{reconcile, verify_reconciled, MergedRecord, Precedence, Reconciled, SourceLoad, VerifyResult};
pub use behavior::{
    Automation, AutomationKind, BusinessProcess, DerivedKind, DerivedLogic, PlatformScan,
};
pub use salesforce::{SalesforceConnector, SalesforceField, SalesforceObject};
pub use monday::MondayConnector;
pub use quickbooks::QuickBooksConnector;
pub use quickbase::QuickbaseConnector;
pub use hubspot::HubSpotConnector;
pub use odata::ODataConnector;
pub use fhir::{FhirConnector, FHIR_RESOURCE_TYPES};
pub use rest::{RestConnector, RestResource};
pub use presets::{VendorPreset, CATALOG as VENDOR_PRESETS};
pub use runtime::{
    find_runtime_preset, load_runtime_presets, remove_runtime_preset, runtime_store_path,
    save_runtime_presets, upsert_runtime_preset, RuntimePreset, RuntimeResource,
    RUNTIME_AUTH_KINDS,
};
pub use registry::{LiveSupport, SourceAuth};
pub use descriptor::{
    find as source_connector, ConnectorDescriptor, ConnectorKind, FetchFn, ResourceDef, BUILTINS,
};

#[cfg(feature = "duckdb-store")]
pub use store::{DataStore, LoadSource};
