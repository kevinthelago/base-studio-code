//! RSS 2.0 / Atom parsing.
//!
//! [`parse`] is pure and fixture-tested with no network; [`fetch`] is the thin entry point that
//! calls [`crate::http`] and hands the body here. That split is the research crate's convention and
//! the reason its sources are cheap to add to: the format quirks — and every feed has them — are
//! testable against a recorded byte-for-byte payload rather than against whatever the wire served
//! the day the test ran.

use crate::http::Http;
use crate::types::FeedItem;
use roxmltree::Document;

/// Text of the first direct child with this tag name, trimmed. Namespace-agnostic (feeds disagree
/// about whether `dc:` is declared), so the local name is what matches.
fn child_text(node: roxmltree::Node, name: &str) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.tag_name().name() == name)
        .and_then(|c| c.text().map(|t| t.trim().to_string()))
        .filter(|s| !s.is_empty())
}

/// Atom puts the URL in `<link href="…"/>`; RSS puts it in the element's text. Try both, and prefer
/// an `alternate`/unlabelled link over `self`/`replies`, which point at the feed rather than a story.
fn link_of(node: roxmltree::Node) -> Option<String> {
    let mut fallback = None;
    for c in node.children().filter(|c| c.is_element() && c.tag_name().name() == "link") {
        if let Some(href) = c.attribute("href") {
            let rel = c.attribute("rel").unwrap_or("alternate");
            if rel == "alternate" {
                return Some(href.trim().to_string());
            }
            fallback.get_or_insert_with(|| href.trim().to_string());
        } else if let Some(t) = c.text() {
            let t = t.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    fallback
}

/// Strip HTML tags and collapse whitespace. Feed summaries routinely carry markup (Xinhua ships an
/// `<img>` before every description), and a tag left in the text would be scored as prose by every
/// signal downstream.
pub fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0usize;
    for ch in s.chars() {
        match ch {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    let decoded = out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Parse an RSS 2.0 or Atom document into items. Malformed XML is an error; a malformed *item*
/// inside good XML is skipped, because one broken entry must not cost the whole poll.
pub fn parse(body: &str) -> Result<Vec<FeedItem>, String> {
    let doc = Document::parse(body).map_err(|e| format!("feed is not well-formed XML: {e}"))?;
    let mut items = Vec::new();
    for node in doc.descendants() {
        if !node.is_element() {
            continue;
        }
        let tag = node.tag_name().name();
        // `item` is RSS, `entry` is Atom.
        if tag != "item" && tag != "entry" {
            continue;
        }
        let (Some(url), Some(title)) = (link_of(node), child_text(node, "title")) else {
            continue;
        };
        let summary = child_text(node, "description")
            .or_else(|| child_text(node, "summary"))
            .or_else(|| child_text(node, "content"))
            .map(|s| strip_html(&s))
            .unwrap_or_default();
        items.push(FeedItem {
            url,
            title: strip_html(&title),
            summary,
            published_claim: child_text(node, "pubDate")
                .or_else(|| child_text(node, "published"))
                .or_else(|| child_text(node, "updated"))
                .or_else(|| child_text(node, "date")),
        });
    }
    Ok(items)
}

/// Fetch and parse one RSS/Atom feed.
pub fn fetch(http: &Http, url: &str) -> Result<Vec<FeedItem>, String> {
    parse(&http.get_text(url)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSS: &str = include_str!("../../fixtures/rss2.xml");
    const ATOM: &str = include_str!("../../fixtures/atom.xml");

    #[test]
    fn parses_rss_2_items() {
        let items = parse(RSS).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].url, "https://example.org/story-one");
        assert_eq!(items[0].title, "Two killed in strike on port");
        assert_eq!(items[0].published_claim.as_deref(), Some("Fri, 04 Sep 2026 14:17:35 GMT"));
    }

    #[test]
    fn cdata_and_markup_are_stripped_from_the_summary() {
        // Xinhua ships an <img> tag inside every CDATA description; leaving it in would let markup
        // be scored as prose by the framing and agency-deletion signals.
        let items = parse(RSS).unwrap();
        assert_eq!(items[1].summary, "A building was struck overnight.");
        assert!(!items[1].summary.contains('<'), "no markup survives into the text signals read");
    }

    #[test]
    fn parses_atom_entries_preferring_the_alternate_link() {
        let items = parse(ATOM).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].url, "https://example.org/atom-story", "the self link must not win");
        assert_eq!(items[0].title, "Forces detained three men");
        assert_eq!(items[0].published_claim.as_deref(), Some("2026-09-04T16:05:07Z"));
    }

    #[test]
    fn an_item_missing_a_link_or_title_is_skipped_not_fatal() {
        let body = "<rss><channel>\
            <item><title>no link</title></item>\
            <item><link>https://example.org/ok</link><title>fine</title></item>\
            </channel></rss>";
        let items = parse(body).unwrap();
        assert_eq!(items.len(), 1, "one unusable entry must not cost the whole poll");
        assert_eq!(items[0].url, "https://example.org/ok");
    }

    #[test]
    fn malformed_xml_is_an_error() {
        assert!(parse("<rss><channel><item>").is_err());
    }

    #[test]
    fn strip_html_collapses_entities_and_whitespace() {
        assert_eq!(strip_html("<p>a &amp;  b</p>\n<i>c</i>"), "a & b c");
        assert_eq!(strip_html("plain"), "plain");
    }
}
