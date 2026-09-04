//! The roster — twelve institutions, three per bloc, one wire agency in each.
//!
//! It is a fixture on purpose. The epic's registry layer (Media Cloud's 25k sources ∪ Wikidata's
//! ownership graph) is deferred behind the question this slice exists to answer: *is the digest
//! worth reading at all?* Twelve outlets answer that; twenty-five thousand only make it slower to
//! find out.
//!
//! Chosen for SPREAD rather than volume, since the signal wanted is disagreement. Each bloc
//! contributes one agency and two outlets, so [`crate::signals::corroborate`] has a wire to
//! attribute a cascade to in every bloc.
//!
//! **Xinhua's dead feed is deliberate.** `english.news.cn/rss/worldrss.xml` answers `200` and
//! serves items from 2017-2018; the host has no `robots.txt` and no news sitemap. It stays in the
//! roster flagged, because a registry that trusts status codes would record the state agency with
//! the widest global reprint footprint as covering nothing — and a real abandoned feed proves the
//! freshness check in a way a synthetic one cannot.

use crate::types::{Bloc, FeedKind, Outlet, OutletKind};

/// Build the roster. A function rather than a `const` so the `String` fields stay ordinary owned
/// data — the roster is small and read once per command.
pub fn roster() -> Vec<Outlet> {
    fn o(
        id: &str,
        name: &str,
        bloc: Bloc,
        kind: OutletKind,
        feed_kind: FeedKind,
        feed: &str,
        known_stale: Option<&str>,
    ) -> Outlet {
        Outlet {
            id: id.into(),
            name: name.into(),
            bloc,
            kind,
            feed_kind,
            feed: feed.into(),
            known_stale: known_stale.map(str::to_string),
        }
    }
    use Bloc::{Cn, Ru, Uk, Us};
    use FeedKind::{Rss, Sitemap, SitemapIndex};
    use OutletKind::{Agency, Outlet as Out};
    vec![
        // ── US ──────────────────────────────────────────────────────────────────────────────────
        // AP dropped RSS; its Google News sitemap is the only machine-readable surface left.
        o("ap", "Associated Press", Us, Agency, Sitemap, "https://apnews.com/news-sitemap-content.xml", None),
        o("npr", "NPR", Us, Out, Rss, "https://feeds.npr.org/1001/rss.xml", None),
        o("fox", "Fox News", Us, Out, Rss, "https://moxie.foxnews.com/google-publisher/world.xml", None),
        // ── UK ──────────────────────────────────────────────────────────────────────────────────
        // Reuters publishes only a sitemap INDEX, so this one costs a second hop.
        o(
            "reuters",
            "Reuters",
            Uk,
            Agency,
            SitemapIndex,
            "https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml",
            None,
        ),
        o("bbc", "BBC News", Uk, Out, Rss, "https://feeds.bbci.co.uk/news/world/rss.xml", None),
        o("guardian", "The Guardian", Uk, Out, Rss, "https://www.theguardian.com/world/rss", None),
        // ── RU ──────────────────────────────────────────────────────────────────────────────────
        o("tass", "TASS", Ru, Agency, Rss, "https://tass.com/rss/v2.xml", None),
        o("rt", "RT", Ru, Out, Rss, "https://www.rt.com/rss/news/", None),
        o("meduza", "Meduza", Ru, Out, Rss, "https://meduza.io/rss/en/all", None),
        // ── CN ──────────────────────────────────────────────────────────────────────────────────
        o(
            "xinhua",
            "Xinhua",
            Cn,
            Agency,
            Rss,
            "https://english.news.cn/rss/worldrss.xml",
            Some("abandoned upstream: answers 200 with items from 2017-2018; no robots.txt, no news sitemap (probed 2026-09-04)"),
        ),
        o("globaltimes", "Global Times", Cn, Out, Rss, "https://www.globaltimes.cn/rss/outbrain.xml", None),
        o("scmp", "South China Morning Post", Cn, Out, Rss, "https://www.scmp.com/rss/91/feed", None),
    ]
}

/// One outlet by id.
pub fn get(id: &str) -> Option<Outlet> {
    roster().into_iter().find(|o| o.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn roster_is_twelve_outlets_with_unique_ids() {
        let r = roster();
        assert_eq!(r.len(), 12, "the slice is scoped to exactly twelve outlets");
        let ids: BTreeSet<_> = r.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids.len(), 12, "outlet ids are the primary key and must be unique");
    }

    #[test]
    fn every_bloc_has_three_outlets_and_exactly_one_agency() {
        // Spread is the point of the roster, so an edit that quietly stacks one bloc fails here.
        for bloc in [Bloc::Us, Bloc::Uk, Bloc::Ru, Bloc::Cn] {
            let in_bloc: Vec<_> = roster().into_iter().filter(|o| o.bloc == bloc).collect();
            assert_eq!(in_bloc.len(), 3, "{} should carry three outlets", bloc.code());
            let agencies = in_bloc.iter().filter(|o| o.kind == OutletKind::Agency).count();
            assert_eq!(agencies, 1, "{} needs exactly one wire to attribute a cascade to", bloc.code());
        }
    }

    #[test]
    fn every_feed_is_https_and_non_empty() {
        for o in roster() {
            assert!(o.feed.starts_with("https://"), "{} must be fetched over TLS", o.id);
            assert!(!o.name.trim().is_empty(), "{} needs a display name", o.id);
        }
    }

    #[test]
    fn a_known_stale_feed_carries_its_reason() {
        // The flag exists to be read by a human deciding whether a zero count is real, so an empty
        // reason would be worse than no flag at all.
        let stale: Vec<_> = roster().into_iter().filter(|o| o.known_stale.is_some()).collect();
        assert_eq!(stale.len(), 1, "xinhua is the one known-dead feed in the roster");
        assert_eq!(stale[0].id, "xinhua");
        let why = stale[0].known_stale.clone().unwrap();
        assert!(why.len() > 40, "a staleness flag must say what was observed and when, not just `true`");
    }

    #[test]
    fn get_finds_by_id() {
        assert_eq!(get("bbc").map(|o| o.name), Some("BBC News".to_string()));
        assert!(get("nope").is_none());
    }
}
