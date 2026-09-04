//! The canonical news types.
//!
//! **These are deliberately not `research`'s types, and there is no conversion between them.** A
//! [`Paper`](../../research/index.html) is a citable source; an [`Article`] is a *claim* whose value
//! comes from being corroborated against other articles. Collapsing the two would let an outlet's
//! assertion enter a plan with a paper's authority, which is the exact failure this crate exists to
//! avoid — so the separation is the schema, not a label, and nothing here grows a `From<Article>`
//! for a research type.

use serde::{Deserialize, Serialize};

/// Which geopolitical bloc an outlet publishes from. The point of the roster is *spread*, not
/// volume: an event covered by twelve outlets in one bloc says far less than one covered by three
/// in each of four, because the signal we want is disagreement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Bloc {
    /// United States.
    Us,
    /// United Kingdom.
    Uk,
    /// Russia (including Russian-language outlets publishing from exile).
    Ru,
    /// China (including Hong Kong).
    Cn,
}

impl Bloc {
    /// The bloc's short display code.
    pub fn code(self) -> &'static str {
        match self {
            Bloc::Us => "US",
            Bloc::Uk => "UK",
            Bloc::Ru => "RU",
            Bloc::Cn => "CN",
        }
    }

    /// Parse a bloc from its code, case-insensitively.
    pub fn parse(s: &str) -> Option<Bloc> {
        match s.trim().to_ascii_uppercase().as_str() {
            "US" => Some(Bloc::Us),
            "UK" | "GB" => Some(Bloc::Uk),
            "RU" => Some(Bloc::Ru),
            "CN" => Some(Bloc::Cn),
            _ => None,
        }
    }
}

/// Whether an outlet ORIGINATES copy or REPRINTS it.
///
/// This is the single most load-bearing field in the crate. Roughly twenty wire agencies originate
/// the majority of what tens of thousands of outlets publish, so "40 outlets reported it" is a
/// statement about reprinting, not about corroboration. Modelling agencies as a distinct kind is
/// what lets [`crate::signals::corroborate`] report *one primary source and thirty-nine echoes*.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutletKind {
    /// A wire service whose copy other outlets reprint (AP, Reuters, TASS, Xinhua, …).
    Agency,
    /// An outlet that publishes to readers directly.
    Outlet,
}

/// How an outlet's output is fetched. Both formats are carried from the first commit because the
/// agencies — the class the corroboration signal depends on — largely dropped RSS: AP publishes
/// only a Google News sitemap and Reuters only a sitemap *index*.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedKind {
    /// RSS 2.0 or Atom.
    Rss,
    /// A Google News sitemap (`<urlset>` with `news:` elements).
    Sitemap,
    /// A `<sitemapindex>` naming child sitemaps, each of which is a [`FeedKind::Sitemap`].
    SitemapIndex,
}

/// One institution in the roster.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outlet {
    /// Stable slug, used as the primary key everywhere (`ap`, `bbc`, `tass`).
    pub id: String,
    /// Display name.
    pub name: String,
    pub bloc: Bloc,
    pub kind: OutletKind,
    pub feed_kind: FeedKind,
    /// The feed URL polled for this outlet.
    pub feed: String,
    /// Set when the feed is KNOWN to be abandoned upstream. Kept in the roster on purpose: a dead
    /// feed that still answers `200` is the case a freshness guard has to survive, and a synthetic
    /// fixture cannot prove that.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub known_stale: Option<String>,
}

/// One fetched state of one article URL.
///
/// Versions are **append-only**: a poll that finds changed text writes a new row rather than
/// updating the old one, which is what makes a stealth edit observable at all. The earliest
/// version's `fetched_at` is the URL's first-seen time, and first-seen ordering is what makes wire
/// cascade detection possible — it cannot be recovered later from an upstream that snapshots once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArticleVersion {
    pub url: String,
    pub outlet_id: String,
    /// 1-based, monotonic per URL. Version 1 is the first time this poller saw the URL.
    pub seq: i64,
    /// Epoch seconds at which this poller fetched this state.
    pub fetched_at: i64,
    /// The publication timestamp the feed CLAIMED, verbatim and unparsed. Upstream timestamps are
    /// routinely wrong or backdated, so they are recorded but never used for ordering — `fetched_at`
    /// is ours and is the only one trusted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_claim: Option<String>,
    pub title: String,
    /// The summary/description the feed carried. For most outlets this is all the text available
    /// without fetching the article body, and it is enough for framing and headline analysis.
    #[serde(default)]
    pub summary: String,
}

impl ArticleVersion {
    /// Title and summary joined — the text every signal reads. Signals index into THIS string, so
    /// an evidence offset means the same thing everywhere.
    pub fn text(&self) -> String {
        if self.summary.is_empty() {
            self.title.clone()
        } else {
            format!("{}\n{}", self.title, self.summary)
        }
    }
}

/// One item as parsed out of a feed, before the store decides whether it is a new version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedItem {
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_claim: Option<String>,
}

/// A located piece of evidence for a signal.
///
/// Every number any signal reports carries these, so a reader can go from a count to the exact
/// characters that produced it. A signal that cannot cite its spans is not admissible here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub url: String,
    pub outlet_id: String,
    /// Byte offset into [`ArticleVersion::text`].
    pub start: usize,
    /// Byte offset (exclusive) into [`ArticleVersion::text`].
    pub end: usize,
    /// The matched text itself, so a span is readable without re-fetching.
    pub text: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bloc_codes_round_trip() {
        for b in [Bloc::Us, Bloc::Uk, Bloc::Ru, Bloc::Cn] {
            assert_eq!(Bloc::parse(b.code()), Some(b));
        }
        assert_eq!(Bloc::parse("gb"), Some(Bloc::Uk), "GB is accepted for the UK");
        assert_eq!(Bloc::parse("xx"), None);
    }

    #[test]
    fn version_text_joins_title_and_summary() {
        let mut v = ArticleVersion {
            url: "u".into(),
            outlet_id: "o".into(),
            seq: 1,
            fetched_at: 0,
            published_claim: None,
            title: "T".into(),
            summary: "S".into(),
        };
        assert_eq!(v.text(), "T\nS");
        v.summary = String::new();
        assert_eq!(v.text(), "T", "a summary-less item is just its headline, with no stray newline");
    }
}
