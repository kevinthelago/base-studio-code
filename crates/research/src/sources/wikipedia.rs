//! Wikipedia client (#1298) — the MediaWiki Action API (`en.wikipedia.org/w/api.php`,
//! `formatversion=2`). Unlike the scientific sources, Wikipedia is the *encyclopedic backbone*: it
//! SEEDS a skill with broad coverage (definitions, taxonomy, core concepts) fast, and the scientific
//! sources then refine it. Mirrors the arXiv reference impl — pure parsers
//! ([`parse_search`]/[`parse_page`]/[`parse_fulltext`], fixture-tested, no network) plus thin
//! [`search`]/[`fetch`]/[`fetch_fulltext`] entry points.
//!
//! Canonical id = `wikipedia:<Title_With_Underscores>` (matches the article URL slug). Articles have
//! no publication year, so `year` is left unset and `year_from` doesn't apply. Full text is served
//! directly as plain text (no PDF), so the engine routes `wikipedia:` ids to [`fetch_fulltext`]
//! instead of its PDF path.

use crate::http::{encode, Http};
use crate::types::{Paper, SearchQuery, Source};

const API: &str = "https://en.wikipedia.org/w/api.php";

/// Search Wikipedia (`list=search`), capped to `limit`. `year_from` is ignored — encyclopedia
/// articles aren't dated publications.
pub fn search(http: &Http, query: &SearchQuery) -> Result<Vec<Paper>, String> {
    let limit = query.limit.max(1);
    let url = format!(
        "{API}?action=query&list=search&srsearch={}&srlimit={}&srprop=snippet&format=json&formatversion=2",
        encode(&query.query),
        limit,
    );
    let body = http.get_text(&url, &[])?;
    let mut papers = parse_search(&body)?;
    papers.truncate(limit);
    Ok(papers)
}

/// Fetch one article's intro extract by canonical id (`wikipedia:Ray_tracing`) — the summary used as
/// the skill seed's abstract.
pub fn fetch(http: &Http, id: &str) -> Result<Option<Paper>, String> {
    let title = title_from_id(id);
    let url = format!(
        "{API}?action=query&prop=extracts%7Cinfo&exintro=1&explaintext=1&inprop=url&redirects=1&titles={}&format=json&formatversion=2",
        encode(&title),
    );
    let body = http.get_text(&url, &[])?;
    parse_page(&body)
}

/// Fetch an article's FULL plain text (all sections, `== Heading ==` markers preserved) for
/// full-text / citation-grounded semantic search. This is what the engine stores to seed + refine a
/// skill.
pub fn fetch_fulltext(http: &Http, id: &str) -> Result<String, String> {
    let title = title_from_id(id);
    let url = format!(
        "{API}?action=query&prop=extracts&explaintext=1&redirects=1&titles={}&format=json&formatversion=2",
        encode(&title),
    );
    let body = http.get_text(&url, &[])?;
    parse_fulltext(&body)
}

// ── pure parsers ───────────────────────────────────────────────────────────────

/// Parse a `list=search` response into normalized records. Pure — the unit of fixture testing.
pub fn parse_search(body: &str) -> Result<Vec<Paper>, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("wikipedia json parse: {e}"))?;
    let mut out = Vec::new();
    let Some(arr) = v["query"]["search"].as_array() else {
        return Ok(out);
    };
    for item in arr {
        let title = item["title"].as_str().unwrap_or_default().trim().to_string();
        if title.is_empty() {
            continue;
        }
        let mut p = Paper::new(format!("wikipedia:{}", title_to_slug(&title)), Source::Wikipedia, title.clone());
        // The snippet is HTML (`<span class="searchmatch">…</span>` + entities) — strip to plain text.
        let snippet = strip_html(item["snippet"].as_str().unwrap_or_default());
        if !snippet.is_empty() {
            p.abstract_text = Some(snippet);
        }
        p.url = Some(article_url(&title));
        out.push(p);
    }
    Ok(out)
}

/// Parse a `prop=extracts` (intro) response into a single record, or `None` when the page is missing.
/// Pure.
pub fn parse_page(body: &str) -> Result<Option<Paper>, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("wikipedia json parse: {e}"))?;
    let Some(pages) = v["query"]["pages"].as_array() else {
        return Ok(None);
    };
    for page in pages {
        if page["missing"].as_bool() == Some(true) {
            continue;
        }
        let title = page["title"].as_str().unwrap_or_default().trim().to_string();
        if title.is_empty() {
            continue;
        }
        let mut p = Paper::new(format!("wikipedia:{}", title_to_slug(&title)), Source::Wikipedia, title.clone());
        let extract = collapse_ws(page["extract"].as_str().unwrap_or_default());
        if !extract.is_empty() {
            p.abstract_text = Some(extract);
        }
        p.url = page["fullurl"]
            .as_str()
            .or_else(|| page["canonicalurl"].as_str())
            .map(|s| s.to_string())
            .or_else(|| Some(article_url(&title)));
        return Ok(Some(p));
    }
    Ok(None)
}

/// Parse a full `prop=extracts` (whole-article) response into plain text. Pure.
pub fn parse_fulltext(body: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("wikipedia json parse: {e}"))?;
    if let Some(pages) = v["query"]["pages"].as_array() {
        for page in pages {
            if page["missing"].as_bool() == Some(true) {
                continue;
            }
            let text = page["extract"].as_str().unwrap_or_default().trim();
            if !text.is_empty() {
                return Ok(text.to_string());
            }
        }
    }
    Err("no Wikipedia article text found".into())
}

// ── small helpers ────────────────────────────────────────────────────────────

/// Article title → URL/id slug (spaces to underscores). Wikipedia keeps parentheses literal.
fn title_to_slug(title: &str) -> String {
    title.trim().replace(' ', "_")
}

/// Canonical id → the API `titles=` value (underscores back to spaces; `wikipedia:` prefix dropped).
fn title_from_id(id: &str) -> String {
    id.trim().strip_prefix("wikipedia:").unwrap_or(id).replace('_', " ")
}

/// The canonical article URL for a title.
fn article_url(title: &str) -> String {
    format!("https://en.wikipedia.org/wiki/{}", title_to_slug(title))
}

/// Strip HTML tags + decode the handful of entities Wikipedia snippets use, then collapse whitespace.
fn strip_html(s: &str) -> String {
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
    let out = out
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&");
    collapse_ws(&out)
}

/// Collapse runs of whitespace to single spaces, trimmed.
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEARCH_FIXTURE: &str = include_str!("../../fixtures/wikipedia_search.json");
    const PAGE_FIXTURE: &str = include_str!("../../fixtures/wikipedia_page.json");
    const MISSING_FIXTURE: &str = include_str!("../../fixtures/wikipedia_missing.json");
    const FULLTEXT_FIXTURE: &str = include_str!("../../fixtures/wikipedia_fulltext.json");

    #[test]
    fn parses_search_into_normalized_records() {
        let papers = parse_search(SEARCH_FIXTURE).unwrap();
        assert_eq!(papers.len(), 2);

        let a = &papers[0];
        assert_eq!(a.id, "wikipedia:Ray_tracing_(graphics)");
        assert_eq!(a.source, Source::Wikipedia);
        assert_eq!(a.title, "Ray tracing (graphics)");
        // HTML tags stripped from the snippet.
        assert_eq!(
            a.abstract_text.as_deref(),
            Some("In 3D computer graphics, ray tracing is a technique for modeling light transport.")
        );
        assert_eq!(a.url.as_deref(), Some("https://en.wikipedia.org/wiki/Ray_tracing_(graphics)"));
        // Encyclopedia articles carry no publication year.
        assert_eq!(a.year, None);

        assert_eq!(papers[1].id, "wikipedia:Path_tracing");
    }

    #[test]
    fn parses_intro_page_with_fullurl() {
        let p = parse_page(PAGE_FIXTURE).unwrap().unwrap();
        assert_eq!(p.id, "wikipedia:Ray_tracing_(graphics)");
        assert_eq!(p.source, Source::Wikipedia);
        assert!(p.abstract_text.as_deref().unwrap().starts_with("In 3D computer graphics"));
        assert_eq!(p.url.as_deref(), Some("https://en.wikipedia.org/wiki/Ray_tracing_(graphics)"));
    }

    #[test]
    fn missing_page_is_none() {
        assert!(parse_page(MISSING_FIXTURE).unwrap().is_none());
    }

    #[test]
    fn parses_fulltext_preserving_section_markers() {
        let text = parse_fulltext(FULLTEXT_FIXTURE).unwrap();
        assert!(text.contains("== History =="));
        assert!(text.contains("ray tracing follows a path") || text.contains("Ray tracing follows a path"));
        // A missing-only response is an error, not an empty string.
        assert!(parse_fulltext(MISSING_FIXTURE).is_err());
    }

    #[test]
    fn id_and_slug_round_trip() {
        assert_eq!(title_to_slug("Ray tracing (graphics)"), "Ray_tracing_(graphics)");
        assert_eq!(title_from_id("wikipedia:Ray_tracing_(graphics)"), "Ray tracing (graphics)");
        // A bare title (no prefix) is accepted too.
        assert_eq!(title_from_id("Path_tracing"), "Path tracing");
    }

    #[test]
    fn strip_html_removes_tags_and_decodes_entities() {
        assert_eq!(
            strip_html("a <span class=\"searchmatch\">b</span> &amp; c &quot;d&quot;"),
            "a b & c \"d\""
        );
    }
}
