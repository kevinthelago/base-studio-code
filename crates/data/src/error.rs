//! Crate-wide error type.

use std::fmt;

/// Everything that can go wrong loading data into the Data Model.
#[derive(Debug)]
pub enum DataError {
    /// The Data Model is invalid (unknown entity, bad identifier, dangling ref, …).
    Schema(String),
    /// Filesystem / IO failure (reading a CSV, opening a store file).
    Io(String),
    /// CSV parse failure.
    Csv(String),
    /// DuckDB failure.
    Db(String),
}

impl fmt::Display for DataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DataError::Schema(m) => write!(f, "schema error: {m}"),
            DataError::Io(m) => write!(f, "io error: {m}"),
            DataError::Csv(m) => write!(f, "csv error: {m}"),
            DataError::Db(m) => write!(f, "db error: {m}"),
        }
    }
}

impl std::error::Error for DataError {}

impl From<std::io::Error> for DataError {
    fn from(e: std::io::Error) -> Self {
        DataError::Io(e.to_string())
    }
}

impl From<csv::Error> for DataError {
    fn from(e: csv::Error) -> Self {
        DataError::Csv(e.to_string())
    }
}

#[cfg(feature = "duckdb-store")]
impl From<duckdb::Error> for DataError {
    fn from(e: duckdb::Error) -> Self {
        DataError::Db(e.to_string())
    }
}

/// Crate result alias.
pub type Result<T> = std::result::Result<T, DataError>;
