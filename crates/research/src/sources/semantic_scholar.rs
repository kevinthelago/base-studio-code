//! Semantic Scholar client (#1196) — Graph REST API (JSON). STUB: filled in by the source-clients
//! task; the dispatch + engine compile against these signatures meanwhile.

use crate::http::Http;
use crate::types::{Paper, Reference, SearchQuery};

pub fn search(_http: &Http, _query: &SearchQuery) -> Result<Vec<Paper>, String> {
    Ok(Vec::new())
}

pub fn fetch(_http: &Http, _id: &str) -> Result<Option<Paper>, String> {
    Ok(None)
}

pub fn references(_http: &Http, _id: &str) -> Result<Vec<Reference>, String> {
    Ok(Vec::new())
}
