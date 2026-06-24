//! Crossref client (#1196) — REST (JSON) for DOI metadata + reference resolution. Mirrors the arXiv
//! reference impl: pure parsers ([`parse_search`]/[`parse_work`]/[`parse_references`], fixture-tested,
//! no network) plus thin [`search`]/[`fetch`]/[`references`] entry points that build the URL, call the
//! http client, and hand the body to the parser.

use crate::http::{encode, Http};
use crate::types::{Author, Paper, Reference, SearchQuery, Source};
use serde_json::Value;

const API: &str = "https://api.crossref.org/works";

/// Search Crossref by free-text query, capped to `limit`; `year_from` is applied client-side.
/// Adds `&mailto=<email>` for the "polite pool" when `crossref_mailto` is configured.
pub fn search(http: &Http, query: &SearchQuery) -> Result<Vec<Paper>, String> {
    let mut url = format!("{API}?query={}&rows={}", encode(&query.query), query.limit.max(1));
    if let Some(mailto) = &http.crossref_mailto {
        url.push_str(&format!("&mailto={}", encode(mailto)));
    }
    let body = http.get_text(&url, &[])?;
    let mut papers = parse_search(&body)?;
    if let Some(yf) = query.year_from {
        papers.retain(|p| p.year.is_none_or(|y| y >= yf));
    }
    papers.truncate(query.limit.max(1));
    Ok(papers)
}

/// Fetch one work by canonical id (`doi:10.1145/3592433`) via `/works/<doi>`.
pub fn fetch(http: &Http, id: &str) -> Result<Option<Paper>, String> {
    let doi = id.strip_prefix("doi:").unwrap_or(id);
    let mut url = format!("{API}/{}", encode(doi));
    if let Some(mailto) = &http.crossref_mailto {
        url.push_str(&format!("?mailto={}", encode(mailto)));
    }
    let body = http.get_text(&url, &[])?;
    parse_work(&body)
}

/// Resolve a work's reference list (`doi:<doi>`), reading `message.reference[]`.
pub fn references(http: &Http, id: &str) -> Result<Vec<Reference>, String> {
    let doi = id.strip_prefix("doi:").unwrap_or(id);
    let mut url = format!("{API}/{}", encode(doi));
    if let Some(mailto) = &http.crossref_mailto {
        url.push_str(&format!("?mailto={}", encode(mailto)));
    }
    let body = http.get_text(&url, &[])?;
    parse_references(&body)
}

/// Parse a Crossref `works` search response into normalized papers. Pure.
pub fn parse_search(body: &str) -> Result<Vec<Paper>, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("crossref json parse: {e}"))?;
    let items = v["message"]["items"].as_array().cloned().unwrap_or_default();
    Ok(items.iter().filter_map(work_to_paper).collect())
}

/// Parse a Crossref single-work response (`message` is the work) into one normalized paper. Pure.
pub fn parse_work(body: &str) -> Result<Option<Paper>, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("crossref json parse: {e}"))?;
    Ok(work_to_paper(&v["message"]))
}

/// Parse a Crossref work's `reference[]` array into normalized references. Pure.
pub fn parse_references(body: &str) -> Result<Vec<Reference>, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("crossref json parse: {e}"))?;
    let refs = v["message"]["reference"].as_array().cloned().unwrap_or_default();
    Ok(refs.iter().map(ref_to_reference).collect())
}

// ── mapping ──────────────────────────────────────────────────────────────────

/// Map one Crossref work object to a [`Paper`], or `None` if it has no DOI/title.
fn work_to_paper(item: &Value) -> Option<Paper> {
    let doi = item["DOI"].as_str()?.trim().to_string();
    if doi.is_empty() {
        return None;
    }
    let title = item["title"].as_array().and_then(|a| a.first()).and_then(|t| t.as_str()).unwrap_or_default();
    let title = collapse_ws(title);
    if title.is_empty() {
        return None;
    }
    let mut p = Paper::new(format!("doi:{doi}"), Source::Crossref, title);
    p.doi = Some(doi);
    if let Some(authors) = item["author"].as_array() {
        for a in authors {
            if let Some(name) = author_name(a) {
                p.authors.push(Author::new(name));
            }
        }
    }
    p.year = item["issued"]["date-parts"]
        .as_array()
        .and_then(|parts| parts.first())
        .and_then(|first| first.as_array())
        .and_then(|first| first.first())
        .and_then(|y| y.as_u64())
        .map(|y| y as u32);
    p.abstract_text = item["abstract"].as_str().map(strip_tags).filter(|s| !s.is_empty());
    p.url = item["URL"].as_str().map(|s| s.to_string());
    p.venue = item["container-title"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    p.citation_count = item["is-referenced-by-count"].as_u64();
    Some(p)
}

/// Map one Crossref `reference[]` entry to a [`Reference`].
fn ref_to_reference(r: &Value) -> Reference {
    let doi = r["DOI"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let title = r["article-title"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let raw = if let Some(unstructured) = r["unstructured"].as_str() {
        unstructured.trim().to_string()
    } else {
        // Assemble from the structured pieces we have.
        let mut parts = Vec::new();
        if let Some(author) = r["author"].as_str() {
            parts.push(author.trim().to_string());
        }
        if let Some(year) = r["year"].as_str() {
            parts.push(format!("({})", year.trim()));
        }
        if let Some(t) = &title {
            parts.push(t.clone());
        }
        if parts.is_empty() {
            doi.clone().unwrap_or_default()
        } else {
            parts.join(" ")
        }
    };
    let mut reference = Reference::unresolved(raw);
    reference.resolved = doi.is_some();
    reference.doi = doi;
    reference.title = title;
    reference
}

// ── small helpers ────────────────────────────────────────────────────────────

/// Crossref authors carry `given`/`family` (or a `name` for orgs); join into a display name.
fn author_name(a: &Value) -> Option<String> {
    if let Some(name) = a["name"].as_str() {
        let name = name.trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    let given = a["given"].as_str().unwrap_or("").trim();
    let family = a["family"].as_str().unwrap_or("").trim();
    let name = format!("{given} {family}");
    let name = name.trim();
    if name.is_empty() { None } else { Some(name.to_string()) }
}

/// Best-effort strip of XML/JATS markup from a Crossref abstract, then collapse whitespace.
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    collapse_ws(&out)
}

/// Collapse runs of whitespace to single spaces, trimmed.
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEARCH: &str = include_str!("../../fixtures/crossref_search.json");
    const WORK: &str = include_str!("../../fixtures/crossref_work.json");

    #[test]
    fn parses_search_with_normalized_fields() {
        let papers = parse_search(SEARCH).unwrap();
        assert_eq!(papers.len(), 2);

        let a = &papers[0];
        assert_eq!(a.id, "doi:10.1145/3592433");
        assert_eq!(a.source, Source::Crossref);
        assert_eq!(a.title, "Real-Time Path Tracing with Neural Denoising");
        assert_eq!(a.doi.as_deref(), Some("10.1145/3592433"));
        assert_eq!(a.year, Some(2024));
        assert_eq!(
            a.authors,
            vec![Author::new("Ada Lovelace"), Author::new("Alan Turing")]
        );
        // JATS markup stripped.
        assert_eq!(
            a.abstract_text.as_deref(),
            Some("We present a method for real-time path tracing.")
        );
        assert_eq!(a.venue.as_deref(), Some("ACM Transactions on Graphics"));
        assert_eq!(a.citation_count, Some(42));
        assert_eq!(a.url.as_deref(), Some("https://doi.org/10.1145/3592433"));
    }

    #[test]
    fn parses_year_only_date_parts_and_org_author() {
        let papers = parse_search(SEARCH).unwrap();
        let b = &papers[1];
        assert_eq!(b.id, "doi:10.1000/xyz123");
        assert_eq!(b.year, Some(2023));
        assert_eq!(b.authors, vec![Author::new("Hopper")]);
        assert_eq!(b.abstract_text, None);
        assert_eq!(b.citation_count, Some(7));
    }

    #[test]
    fn parses_single_work() {
        let p = parse_work(WORK).unwrap().unwrap();
        assert_eq!(p.id, "doi:10.1145/3592433");
        assert_eq!(p.title, "Real-Time Path Tracing with Neural Denoising");
        assert_eq!(p.year, Some(2024));
    }

    #[test]
    fn parses_references_resolved_and_unstructured() {
        let refs = parse_references(WORK).unwrap();
        assert_eq!(refs.len(), 2);

        let r0 = &refs[0];
        assert!(r0.resolved);
        assert_eq!(r0.doi.as_deref(), Some("10.1109/tvcg.2020.1234567"));
        assert_eq!(r0.title.as_deref(), Some("Foundations of Rendering"));
        assert_eq!(r0.raw, "Knuth (2020) Foundations of Rendering");

        let r1 = &refs[1];
        assert!(!r1.resolved);
        assert_eq!(r1.doi, None);
        assert_eq!(
            r1.raw,
            "Dijkstra, E. A Note on Two Problems in Connexion with Graphs. 1959."
        );
    }
}
