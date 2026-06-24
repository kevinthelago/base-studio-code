//! arXiv client (#1196) — the Atom XML query API (`export.arxiv.org/api/query`). This is the
//! reference source implementation the other three mirror: a pure [`parse_search`] (fixture-tested,
//! no network) plus thin [`search`]/[`fetch`] entry points.

use crate::http::{encode, Http};
use crate::types::{Author, Paper, SearchQuery, Source};
use roxmltree::{Document, Node};

const API: &str = "http://export.arxiv.org/api/query";

/// Search arXiv, newest first; `year_from` is applied client-side (the Atom API has no clean year
/// filter), and the result is capped to `limit`.
pub fn search(http: &Http, query: &SearchQuery) -> Result<Vec<Paper>, String> {
    let url = format!(
        "{API}?search_query=all:{}&start=0&max_results={}&sortBy=submittedDate&sortOrder=descending",
        encode(&query.query),
        query.limit.max(1),
    );
    let body = http.get_text(&url, &[])?;
    let mut papers = parse_search(&body)?;
    if let Some(yf) = query.year_from {
        papers.retain(|p| p.year.map_or(true, |y| y >= yf));
    }
    papers.truncate(query.limit.max(1));
    Ok(papers)
}

/// Fetch one paper by canonical id (`arxiv:2401.01234`) via the `id_list` query.
pub fn fetch(http: &Http, id: &str) -> Result<Option<Paper>, String> {
    let raw = id.strip_prefix("arxiv:").unwrap_or(id);
    let url = format!("{API}?id_list={}", encode(raw));
    let body = http.get_text(&url, &[])?;
    Ok(parse_search(&body)?.into_iter().next())
}

/// Parse an arXiv Atom feed into normalized papers. Pure — the unit of fixture testing.
pub fn parse_search(body: &str) -> Result<Vec<Paper>, String> {
    let doc = Document::parse(body).map_err(|e| format!("arxiv xml parse: {e}"))?;
    let mut out = Vec::new();
    for entry in doc.descendants().filter(|n| n.is_element() && n.tag_name().name() == "entry") {
        let id_url = child_text(&entry, "id").unwrap_or_default();
        let arxiv_id = arxiv_id_from_url(&id_url);
        if arxiv_id.is_empty() {
            continue; // opensearch/meta entries without an abs id
        }
        let title = collapse_ws(&child_text(&entry, "title").unwrap_or_default());
        if title.is_empty() {
            continue;
        }
        let mut p = Paper::new(format!("arxiv:{arxiv_id}"), Source::Arxiv, title);
        p.arxiv_id = Some(arxiv_id.clone());
        p.abstract_text = child_text(&entry, "summary")
            .map(|s| collapse_ws(&s))
            .filter(|s| !s.is_empty());
        p.year = child_text(&entry, "published").and_then(|d| year_of(&d));
        for a in entry.children().filter(|n| n.is_element() && n.tag_name().name() == "author") {
            if let Some(name) = child_text(&a, "name") {
                let name = collapse_ws(&name);
                if !name.is_empty() {
                    p.authors.push(Author::new(name));
                }
            }
        }
        p.doi = entry
            .children()
            .find(|n| n.is_element() && n.tag_name().name() == "doi")
            .and_then(|n| n.text())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        for link in entry.children().filter(|n| n.is_element() && n.tag_name().name() == "link") {
            let href = link.attribute("href").unwrap_or_default();
            let typ = link.attribute("type").unwrap_or_default();
            let rel = link.attribute("rel").unwrap_or_default();
            let title_attr = link.attribute("title").unwrap_or_default();
            if title_attr == "pdf" || typ == "application/pdf" {
                p.pdf_url = Some(href.to_string());
            } else if rel == "alternate" {
                p.url = Some(href.to_string());
            }
        }
        // Fall back to the canonical landing/PDF URLs derived from the id.
        if p.url.is_none() {
            p.url = Some(format!("https://arxiv.org/abs/{arxiv_id}"));
        }
        if p.pdf_url.is_none() {
            p.pdf_url = Some(format!("https://arxiv.org/pdf/{arxiv_id}"));
        }
        out.push(p);
    }
    Ok(out)
}

// ── small helpers ────────────────────────────────────────────────────────────

/// The text of the first child element with this local name (namespace-agnostic).
fn child_text(node: &Node, name: &str) -> Option<String> {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == name)
        .and_then(|n| n.text())
        .map(|s| s.to_string())
}

/// Extract the bare arXiv id from an abs URL, dropping any trailing version (`2401.01234v2` →
/// `2401.01234`).
fn arxiv_id_from_url(url: &str) -> String {
    let after = url.rsplit("/abs/").next().unwrap_or("").trim();
    strip_version(after)
}

fn strip_version(id: &str) -> String {
    if let Some(pos) = id.rfind('v') {
        let tail = &id[pos + 1..];
        if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
            return id[..pos].to_string();
        }
    }
    id.to_string()
}

fn year_of(date: &str) -> Option<u32> {
    date.get(0..4)?.parse().ok()
}

/// Collapse all runs of whitespace (incl. newlines from wrapped XML) to single spaces, trimmed.
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../fixtures/arxiv_search.xml");

    #[test]
    fn parses_two_entries_with_normalized_fields() {
        let papers = parse_search(FIXTURE).unwrap();
        assert_eq!(papers.len(), 2);

        let a = &papers[0];
        assert_eq!(a.id, "arxiv:2401.01234");
        assert_eq!(a.source, Source::Arxiv);
        // Wrapped title is collapsed to a single line.
        assert_eq!(a.title, "Real-Time Path Tracing with Neural Denoising");
        assert_eq!(a.arxiv_id.as_deref(), Some("2401.01234"));
        assert_eq!(a.year, Some(2024));
        assert_eq!(a.doi.as_deref(), Some("10.1145/3592433"));
        assert_eq!(
            a.authors,
            vec![Author::new("Ada Lovelace"), Author::new("Alan Turing")]
        );
        assert!(a.abstract_text.as_deref().unwrap().starts_with("We present a method"));
        assert_eq!(a.pdf_url.as_deref(), Some("http://arxiv.org/pdf/2401.01234v2"));
        assert_eq!(a.url.as_deref(), Some("http://arxiv.org/abs/2401.01234v2"));
    }

    #[test]
    fn derives_urls_when_links_absent() {
        let papers = parse_search(FIXTURE).unwrap();
        let b = &papers[1];
        assert_eq!(b.id, "arxiv:2312.09999");
        assert_eq!(b.year, Some(2023));
        // No pdf link in the fixture → derived from the id.
        assert_eq!(b.pdf_url.as_deref(), Some("https://arxiv.org/pdf/2312.09999"));
        assert_eq!(b.authors, vec![Author::new("Grace Hopper")]);
    }

    #[test]
    fn strip_version_only_strips_trailing_version() {
        assert_eq!(strip_version("2401.01234v2"), "2401.01234");
        assert_eq!(strip_version("2401.01234"), "2401.01234");
        // A 'v' not followed solely by digits is left alone.
        assert_eq!(strip_version("cs.GR/0001v1abc"), "cs.GR/0001v1abc");
    }
}
