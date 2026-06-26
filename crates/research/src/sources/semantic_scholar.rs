//! Semantic Scholar client (#1196) — Graph REST API (JSON). Mirrors the arXiv reference impl: pure
//! parsers ([`parse_search`]/[`parse_paper`]/[`parse_references`], fixture-tested, no network) plus
//! thin [`search`]/[`fetch`]/[`references`] entry points. The `x-api-key` header is sent only when an
//! `s2_api_key` is configured — every call works key-less (lower rate limits).

use crate::http::{encode, Http};
use crate::types::{Author, Paper, Reference, SearchQuery, Source};
use serde_json::Value;

const API: &str = "https://api.semanticscholar.org/graph/v1/paper";
const FIELDS: &str = "title,abstract,year,authors,externalIds,openAccessPdf,venue,citationCount";

/// Optional `x-api-key` header for the configured key, else no extra headers.
fn auth_headers(http: &Http) -> Vec<(&str, &str)> {
    match &http.s2_api_key {
        Some(key) => vec![("x-api-key", key.as_str())],
        None => Vec::new(),
    }
}

/// Search Semantic Scholar by free-text query, capped to `limit`; `year_from` is applied client-side.
pub fn search(http: &Http, query: &SearchQuery) -> Result<Vec<Paper>, String> {
    let url = format!(
        "{API}/search?query={}&limit={}&fields={}",
        encode(&query.query),
        query.limit.max(1),
        FIELDS,
    );
    let body = http.get_text(&url, &auth_headers(http))?;
    let mut papers = parse_search(&body)?;
    if let Some(yf) = query.year_from {
        papers.retain(|p| p.year.is_none_or(|y| y >= yf));
    }
    papers.truncate(query.limit.max(1));
    Ok(papers)
}

/// Fetch one paper by canonical id (`s2:<paperId>`).
pub fn fetch(http: &Http, id: &str) -> Result<Option<Paper>, String> {
    let pid = id.strip_prefix("s2:").unwrap_or(id);
    let url = format!("{API}/{}?fields={}", encode(pid), FIELDS);
    let body = http.get_text(&url, &auth_headers(http))?;
    parse_paper(&body)
}

/// Resolve a paper's outgoing references (`s2:<paperId>`), reading `data[].citedPaper`.
pub fn references(http: &Http, id: &str) -> Result<Vec<Reference>, String> {
    let pid = id.strip_prefix("s2:").unwrap_or(id);
    let url = format!("{API}/{}/references?fields=title,externalIds&limit=100", encode(pid));
    let body = http.get_text(&url, &auth_headers(http))?;
    parse_references(&body)
}

/// Parse a Graph `paper/search` response into normalized papers. Pure.
pub fn parse_search(body: &str) -> Result<Vec<Paper>, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("s2 json parse: {e}"))?;
    let data = v["data"].as_array().cloned().unwrap_or_default();
    Ok(data.iter().filter_map(paper_obj).collect())
}

/// Parse a Graph single-paper response into one normalized paper. Pure.
pub fn parse_paper(body: &str) -> Result<Option<Paper>, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("s2 json parse: {e}"))?;
    Ok(paper_obj(&v))
}

/// Parse a Graph `paper/<id>/references` response into normalized references. Pure.
pub fn parse_references(body: &str) -> Result<Vec<Reference>, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("s2 json parse: {e}"))?;
    let data = v["data"].as_array().cloned().unwrap_or_default();
    Ok(data.iter().filter_map(|d| cited_to_reference(&d["citedPaper"])).collect())
}

// ── mapping ──────────────────────────────────────────────────────────────────

/// Map one Graph paper object to a [`Paper`], or `None` if it has no paperId/title.
fn paper_obj(item: &Value) -> Option<Paper> {
    let paper_id = item["paperId"].as_str()?.trim().to_string();
    if paper_id.is_empty() {
        return None;
    }
    let title = collapse_ws(item["title"].as_str().unwrap_or_default());
    if title.is_empty() {
        return None;
    }
    let mut p = Paper::new(format!("s2:{paper_id}"), Source::SemanticScholar, title);
    p.abstract_text = item["abstract"].as_str().map(collapse_ws).filter(|s| !s.is_empty());
    p.year = item["year"].as_u64().map(|y| y as u32);
    if let Some(authors) = item["authors"].as_array() {
        for a in authors {
            if let Some(name) = a["name"].as_str() {
                let name = collapse_ws(name);
                if !name.is_empty() {
                    p.authors.push(Author::new(name));
                }
            }
        }
    }
    p.doi = item["externalIds"]["DOI"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    p.arxiv_id = item["externalIds"]["ArXiv"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    p.pdf_url = item["openAccessPdf"]["url"].as_str().map(|s| s.to_string()).filter(|s| !s.is_empty());
    p.venue = item["venue"].as_str().map(|s| s.to_string()).filter(|s| !s.is_empty());
    p.citation_count = item["citationCount"].as_u64();
    Some(p)
}

/// Map a `citedPaper` object to a [`Reference`]; resolved when it carries a DOI or arXiv id.
fn cited_to_reference(cited: &Value) -> Option<Reference> {
    let title = cited["title"].as_str().map(collapse_ws).filter(|s| !s.is_empty());
    let doi = cited["externalIds"]["DOI"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let arxiv_id = cited["externalIds"]["ArXiv"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let raw = title.clone().or_else(|| doi.clone()).or_else(|| arxiv_id.clone())?;
    let mut r = Reference::unresolved(raw);
    r.resolved = doi.is_some() || arxiv_id.is_some();
    r.title = title;
    r.doi = doi;
    r.arxiv_id = arxiv_id;
    Some(r)
}

/// Collapse runs of whitespace to single spaces, trimmed.
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEARCH: &str = include_str!("../../fixtures/semantic_scholar_search.json");
    const REFS: &str = include_str!("../../fixtures/semantic_scholar_references.json");

    #[test]
    fn parses_search_with_normalized_fields() {
        let papers = parse_search(SEARCH).unwrap();
        assert_eq!(papers.len(), 2);

        let a = &papers[0];
        assert_eq!(a.id, "s2:649def34f8be52c8b66281af98ae884c09aef38b");
        assert_eq!(a.source, Source::SemanticScholar);
        assert_eq!(a.title, "Attention Is All You Need");
        assert_eq!(a.year, Some(2017));
        assert_eq!(
            a.authors,
            vec![Author::new("Ashish Vaswani"), Author::new("Noam Shazeer")]
        );
        assert_eq!(a.doi.as_deref(), Some("10.5555/3295222.3295349"));
        assert_eq!(a.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(a.pdf_url.as_deref(), Some("https://arxiv.org/pdf/1706.03762.pdf"));
        assert_eq!(a.venue.as_deref(), Some("NeurIPS"));
        assert_eq!(a.citation_count, Some(100000));
    }

    #[test]
    fn handles_null_and_empty_optionals() {
        let papers = parse_search(SEARCH).unwrap();
        let b = &papers[1];
        assert_eq!(b.id, "s2:abcdef0000000000000000000000000000000000");
        assert_eq!(b.year, None);
        assert_eq!(b.abstract_text, None);
        assert_eq!(b.doi, None);
        assert_eq!(b.arxiv_id, None);
        assert_eq!(b.pdf_url, None);
        // Empty venue string is dropped.
        assert_eq!(b.venue, None);
        assert_eq!(b.citation_count, Some(0));
    }

    #[test]
    fn parses_references_from_cited_papers() {
        let refs = parse_references(REFS).unwrap();
        assert_eq!(refs.len(), 2);

        let r0 = &refs[0];
        assert!(r0.resolved);
        assert_eq!(
            r0.title.as_deref(),
            Some("Neural Machine Translation by Jointly Learning to Align and Translate")
        );
        assert_eq!(r0.doi.as_deref(), Some("10.48550/arXiv.1409.0473"));
        assert_eq!(r0.arxiv_id.as_deref(), Some("1409.0473"));

        let r1 = &refs[1];
        assert!(!r1.resolved);
        assert_eq!(r1.title.as_deref(), Some("An Untracked Reference"));
        assert_eq!(r1.doi, None);
    }
}
