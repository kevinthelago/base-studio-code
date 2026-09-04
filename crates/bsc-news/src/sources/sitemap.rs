//! Google News sitemap parsing — the agencies' only remaining machine-readable surface.
//!
//! AP dropped RSS entirely and Reuters serves a sitemap *index* pointing at paginated child
//! sitemaps. Since the corroboration signal is built on wire ancestry, this parser is not an
//! optional second format: without it the slice cannot demonstrate its headline result.
//!
//! Same split as [`crate::sources::rss`] — [`parse`] and [`parse_index`] are pure and
//! fixture-tested; the `fetch_*` entry points are the only things that touch the network.

use crate::http::Http;
use crate::types::FeedItem;
use roxmltree::{Document, Node};

/// Text of the first descendant with this local name, trimmed. Descendant rather than child,
/// because the news block nests (`news:news` → `news:publication` → `news:name`).
fn desc_text(node: Node, name: &str) -> Option<String> {
    node.descendants()
        .find(|c| c.is_element() && c.tag_name().name() == name)
        .and_then(|c| c.text().map(|t| t.trim().to_string()))
        .filter(|s| !s.is_empty())
}

/// Parse a `<urlset>` news sitemap into items.
///
/// A `<url>` with no `news:` block is **skipped**: a sitemap mixes article URLs with section and
/// hub pages, and a hub has no headline to analyse. Taking it anyway would fill the store with
/// title-less rows that every signal then scores as empty.
pub fn parse(body: &str) -> Result<Vec<FeedItem>, String> {
    let doc = Document::parse(body).map_err(|e| format!("sitemap is not well-formed XML: {e}"))?;
    let mut items = Vec::new();
    for node in doc.descendants().filter(|n| n.is_element() && n.tag_name().name() == "url") {
        let Some(url) = desc_text(node, "loc") else { continue };
        // The title lives in the news block; its absence is what marks a non-article URL.
        let Some(title) = desc_text(node, "title") else { continue };
        items.push(FeedItem {
            url,
            title: super::rss::strip_html(&title),
            // A news sitemap carries no summary. Headline-only is the honest state for these
            // outlets, and the framing signals read headlines perfectly well.
            summary: String::new(),
            published_claim: desc_text(node, "publication_date").or_else(|| desc_text(node, "lastmod")),
        });
    }
    Ok(items)
}

/// Parse a `<sitemapindex>` into the child sitemap URLs it names, in document order.
pub fn parse_index(body: &str) -> Result<Vec<String>, String> {
    let doc = Document::parse(body).map_err(|e| format!("sitemap index is not well-formed XML: {e}"))?;
    Ok(doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "sitemap")
        .filter_map(|n| desc_text(n, "loc"))
        .collect())
}

/// Fetch and parse one news sitemap.
pub fn fetch(http: &Http, url: &str) -> Result<Vec<FeedItem>, String> {
    parse(&http.get_text(url)?)
}

/// Fetch a sitemap index and then its first `max_children` child sitemaps.
///
/// Bounded on purpose: Reuters' index names dozens of paginated children and the newest articles
/// are in the first. Walking all of them would multiply one outlet's poll cost by an order of
/// magnitude for pages the brief will never reach.
pub fn fetch_index(http: &Http, url: &str, max_children: usize) -> Result<Vec<FeedItem>, String> {
    let children = parse_index(&http.get_text(url)?)?;
    let mut items = Vec::new();
    let mut last_err = None;
    for child in children.iter().take(max_children) {
        match fetch(http, child) {
            Ok(mut got) => items.append(&mut got),
            // One dead child must not cost the outlet's whole poll — but if every child failed the
            // caller deserves the error rather than a silent empty list.
            Err(e) => last_err = Some(e),
        }
    }
    match last_err {
        Some(e) if items.is_empty() => Err(e),
        _ => Ok(items),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SITEMAP: &str = include_str!("../../fixtures/news-sitemap.xml");
    const INDEX: &str = include_str!("../../fixtures/sitemap-index.xml");

    #[test]
    fn parses_the_news_block_of_a_sitemap_url() {
        let items = parse(SITEMAP).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].url, "https://example.org/wire-one");
        assert_eq!(items[0].title, "Two killed in strike on port, officials say");
        assert_eq!(items[0].published_claim.as_deref(), Some("2026-09-04T06:30:00-04:00"));
        assert!(items[0].summary.is_empty(), "a news sitemap carries no summary; headline-only is honest");
    }

    #[test]
    fn a_url_without_a_news_block_is_skipped() {
        // The fixture's second <url> is a hub page. Taking it would add a title-less row that every
        // signal downstream scores as empty text.
        let items = parse(SITEMAP).unwrap();
        assert!(
            !items.iter().any(|i| i.url.contains("no-news-block")),
            "a section/hub URL has no headline and must not enter the store"
        );
    }

    #[test]
    fn parses_a_sitemap_index_in_document_order() {
        let children = parse_index(INDEX).unwrap();
        assert_eq!(children.len(), 3);
        assert_eq!(children[0], "https://example.org/news-sitemap/?outputType=xml");
        assert_eq!(
            children[1], "https://example.org/news-sitemap/?outputType=xml&from=100",
            "the XML entity in the query string must be decoded, or the second hop 404s"
        );
    }

    #[test]
    fn an_index_body_parses_as_no_articles_and_vice_versa() {
        // The two shapes are distinguished by the roster's FeedKind, so a mis-set kind should
        // degrade to "nothing found" rather than to garbage rows.
        assert!(parse(INDEX).unwrap().is_empty());
        assert!(parse_index(SITEMAP).unwrap().is_empty());
    }

    #[test]
    fn malformed_xml_is_an_error_for_both_parsers() {
        assert!(parse("<urlset><url>").is_err());
        assert!(parse_index("<sitemapindex>").is_err());
    }
}
