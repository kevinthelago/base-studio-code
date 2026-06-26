//! Tauri bridge for the data platform (#781/#784), split (#1661) into two halves:
//! - [`data_csv`]: preview/load/reconcile a CSV into a canonical Data Model's DuckDB store, plus
//!   the `source-stage` CSV-inference UX (inventory / sample / infer / persist / load).
//! - [`data_scan`]: the live read-only platform scan over a connector + reqwest transport
//!   (`source-stage`-gated), the packaged connector catalog, and the per-project scan persist.
//!
//! Both are re-exported here so `data::*` paths (the command list in `app/run.rs`) stay valid.
//! Read-only with respect to the source (#782): we only read and load inward.

mod data_csv;
mod data_scan;

pub use data_csv::*;
pub use data_scan::*;
