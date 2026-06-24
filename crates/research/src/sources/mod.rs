//! Per-source clients (#1196). Each submodule keeps a *pure parser* (`parse_*`, fixture-tested with
//! no network) separate from the thin `search`/`fetch` entry points that build the request URL, call
//! [`crate::http`], and hand the body to the parser. This module dispatches by [`Source`] and by the
//! canonical-id scheme (`arxiv:` / `doi:` / `pmid:` / `s2:`).

pub mod arxiv;
pub mod crossref;
pub mod pubmed;
pub mod semantic_scholar;

use crate::http::Http;
use crate::types::{Paper, Reference, SearchQuery, Source};

/// Run a search against one source, returning normalized papers (best-effort: an error from one
/// source is the caller's to log + skip so a single flaky upstream doesn't fail the whole fan-out).
pub fn search_source(http: &Http, source: Source, query: &SearchQuery) -> Result<Vec<Paper>, String> {
    match source {
        Source::Arxiv => arxiv::search(http, query),
        Source::SemanticScholar => semantic_scholar::search(http, query),
        Source::Pubmed => pubmed::search(http, query),
        Source::Crossref => crossref::search(http, query),
    }
}

/// Which source a canonical id belongs to, by scheme prefix.
pub fn source_for_id(id: &str) -> Option<Source> {
    let id = id.trim();
    if id.starts_with("arxiv:") {
        Some(Source::Arxiv)
    } else if id.starts_with("pmid:") || id.starts_with("pmcid:") {
        Some(Source::Pubmed)
    } else if id.starts_with("s2:") {
        Some(Source::SemanticScholar)
    } else if id.starts_with("doi:") {
        // DOIs are resolved via Crossref (richest metadata + reference list).
        Some(Source::Crossref)
    } else {
        None
    }
}

/// Fetch a single record by canonical id, routed to the owning source.
pub fn fetch_paper(http: &Http, id: &str) -> Result<Option<Paper>, String> {
    match source_for_id(id) {
        Some(Source::Arxiv) => arxiv::fetch(http, id),
        Some(Source::SemanticScholar) => semantic_scholar::fetch(http, id),
        Some(Source::Pubmed) => pubmed::fetch(http, id),
        Some(Source::Crossref) => crossref::fetch(http, id),
        None => Err(format!("unrecognized id scheme: {id} (expected arxiv:/doi:/pmid:/s2:)")),
    }
}

/// Resolve a paper's reference list. Crossref owns DOI reference lists; Semantic Scholar backs the
/// rest. Returns an empty list (not an error) when the source exposes no references.
pub fn fetch_references(http: &Http, id: &str) -> Result<Vec<Reference>, String> {
    match source_for_id(id) {
        Some(Source::Crossref) => crossref::references(http, id),
        Some(Source::SemanticScholar) => semantic_scholar::references(http, id),
        // arXiv/PubMed don't serve structured reference lists; try Crossref via the paper's DOI.
        Some(_) | None => {
            if let Ok(Some(p)) = fetch_paper(http, id) {
                if let Some(doi) = &p.doi {
                    return crossref::references(http, &format!("doi:{doi}"));
                }
            }
            Ok(Vec::new())
        }
    }
}
