//! Tauri bridge for the data platform (#781/#784), split (#1661) into two halves:
//! - [`data_csv`]: preview/load/reconcile a CSV into a canonical Data Model's DuckDB store, plus
//!   the `source-stage` CSV-inference UX (inventory / sample / infer / persist / load).
//! - [`data_scan`]: the live read-only platform scan over a connector + reqwest transport
//!   (`source-stage`-gated), the packaged connector catalog, and the per-project scan persist.
//!
//! All are re-exported here so `data::*` paths (the command list in `app/run.rs`) stay valid.
//! Read-only with respect to the source (#782): we only read and load inward.
//! (The agent-authored runtime-connector list is now served to the Source pane via the generic
//! `bsc data connector` bridge (#2130); the former `data_runtime_connectors` command was retired
//! with #2125.)

mod data_csv;
#[cfg(feature = "source-stage")]
mod data_scan;

pub use data_csv::*;
#[cfg(feature = "source-stage")]
pub use data_scan::*;
