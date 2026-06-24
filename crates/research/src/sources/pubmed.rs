//! PubMed/PMC client (#1196) — NCBI E-utilities (esearch/efetch, XML) + PMC OA full text. STUB:
//! filled in by the source-clients task; dispatch + engine compile against these signatures.

use crate::http::Http;
use crate::types::{Paper, SearchQuery};

pub fn search(_http: &Http, _query: &SearchQuery) -> Result<Vec<Paper>, String> {
    Ok(Vec::new())
}

pub fn fetch(_http: &Http, _id: &str) -> Result<Option<Paper>, String> {
    Ok(None)
}
