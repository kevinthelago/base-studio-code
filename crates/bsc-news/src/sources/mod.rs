//! Per-source feed clients. Each submodule keeps a **pure parser** (fixture-tested, no network)
//! separate from the thin `fetch` entry points that build the request and call [`crate::http`].
//! This module dispatches by the roster's [`FeedKind`].

pub mod rss;
pub mod sitemap;

use crate::http::Http;
use crate::types::{FeedItem, FeedKind, Outlet};

/// How many child sitemaps of an index to walk. The newest articles are in the first page; the rest
/// are pagination the brief will never reach.
pub const MAX_INDEX_CHILDREN: usize = 2;

/// Fetch one outlet's current items, routed by its feed kind.
pub fn fetch_outlet(http: &Http, outlet: &Outlet) -> Result<Vec<FeedItem>, String> {
    match outlet.feed_kind {
        FeedKind::Rss => rss::fetch(http, &outlet.feed),
        FeedKind::Sitemap => sitemap::fetch(http, &outlet.feed),
        FeedKind::SitemapIndex => sitemap::fetch_index(http, &outlet.feed, MAX_INDEX_CHILDREN),
    }
}
