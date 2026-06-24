//! Crossref client (#1196) — REST (JSON) for DOI metadata + reference resolution. STUB: filled in
//! by the source-clients task; dispatch + engine compile against these signatures.

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
