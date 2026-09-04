//! Ties the pieces together: poll the roster into the store, and assemble a brief over one event.

use crate::http::Http;
use crate::signals::{agency, corroborate, framing};
use crate::store::{Store, Wrote};
use crate::types::{ArticleVersion, Outlet, OutletKind};
use crate::{outlets, sources};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// What one outlet's poll did.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PollResult {
    pub outlet_id: String,
    pub name: String,
    pub bloc: String,
    pub items: usize,
    pub new: usize,
    pub revised: usize,
    pub unchanged: usize,
    /// Present when the fetch failed. One dead feed never fails the whole poll.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Carried through from the roster so a zero can be read as "abandoned upstream" rather than
    /// "nothing happened today".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_stale: Option<String>,
}

/// Poll every outlet in the roster (or the subset named by `only`).
pub fn poll(store: &Store, http: &Http, only: &[String], at: i64) -> Vec<PollResult> {
    let roster: Vec<Outlet> = outlets::roster()
        .into_iter()
        .filter(|o| only.is_empty() || only.iter().any(|id| id == &o.id))
        .collect();
    roster
        .into_iter()
        .map(|o| {
            let mut r = PollResult {
                outlet_id: o.id.clone(),
                name: o.name.clone(),
                bloc: o.bloc.code().to_string(),
                items: 0,
                new: 0,
                revised: 0,
                unchanged: 0,
                error: None,
                known_stale: o.known_stale.clone(),
            };
            match sources::fetch_outlet(http, &o) {
                Err(e) => r.error = Some(e),
                Ok(items) => {
                    r.items = items.len();
                    for item in &items {
                        match store.record(&o.id, item, at) {
                            Ok(Wrote::New) => r.new += 1,
                            Ok(Wrote::Revised) => r.revised += 1,
                            Ok(Wrote::Unchanged) => r.unchanged += 1,
                            // A single bad row is worth reporting but not worth losing the poll over.
                            Err(e) => {
                                r.error.get_or_insert(e);
                            }
                        };
                    }
                }
            }
            r
        })
        .collect()
}

/// The assembled digest for one event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Brief {
    /// The query the event was selected by.
    pub query: String,
    pub matched: usize,
    /// Which outlets covered it — and, by omission, which did not.
    pub outlets: Vec<String>,
    /// Roster outlets with NO matching article. Silence is a finding, not a gap.
    pub silent: Vec<String>,
    pub corroboration: corroborate::Corroboration,
    pub framing: framing::Matrix,
    pub agency_deletion: agency::Report,
}

/// Select the articles matching `query` — all terms must appear, case-insensitively.
///
/// This is a keyword filter, not an event clusterer, and the epic says so: real cross-lingual event
/// clustering is L3 and is deliberately deferred behind the question of whether the digest is worth
/// reading at all. A keyword is enough to answer that and is honest about what it did.
pub fn select(articles: Vec<ArticleVersion>, query: &str) -> Vec<ArticleVersion> {
    let terms: Vec<String> = query.split_whitespace().map(|t| t.to_lowercase()).collect();
    if terms.is_empty() {
        return articles;
    }
    articles
        .into_iter()
        .filter(|a| {
            let text = a.text().to_lowercase();
            terms.iter().all(|t| text.contains(t))
        })
        .collect()
}

/// Build the brief for one event over the articles first seen since `since`.
pub fn brief(store: &Store, query: &str, since: i64) -> Result<Brief, String> {
    let matched = select(store.first_versions(since)?, query);
    let kinds: BTreeMap<String, OutletKind> =
        outlets::roster().into_iter().map(|o| (o.id, o.kind)).collect();

    let mut covering: Vec<String> = matched.iter().map(|a| a.outlet_id.clone()).collect();
    covering.sort();
    covering.dedup();
    let silent = outlets::roster()
        .into_iter()
        .map(|o| o.id)
        .filter(|id| !covering.contains(id))
        .collect();

    Ok(Brief {
        query: query.to_string(),
        matched: matched.len(),
        outlets: covering,
        silent,
        corroboration: corroborate::corroborate(&matched, &kinds),
        framing: framing::matrix(&matched),
        agency_deletion: agency::report(&matched),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::FeedItem;

    fn item(url: &str, title: &str, summary: &str) -> FeedItem {
        FeedItem { url: url.into(), title: title.into(), summary: summary.into(), published_claim: None }
    }

    const WIRE: &str = "Officials said two people were killed and eleven wounded when a missile hit \
                        the southern port early on Thursday, according to the emergency service.";

    fn seeded() -> Store {
        let s = Store::in_memory().unwrap();
        s.record("ap", &item("ap/1", "Strike on port kills two", WIRE), 100).unwrap();
        s.record("bbc", &item("bbc/1", "Two killed in port strike", WIRE), 140).unwrap();
        s.record("rt", &item("rt/1", "Port incident reported", "A building was struck at the port overnight."), 160)
            .unwrap();
        s.record("npr", &item("npr/1", "Rail talks collapse", "Union negotiators walked out on Tuesday."), 200)
            .unwrap();
        s
    }

    #[test]
    fn select_requires_every_term() {
        let arts = seeded().first_versions(0).unwrap();
        assert_eq!(select(arts.clone(), "port").len(), 3);
        assert_eq!(select(arts.clone(), "port strike").len(), 2, "both terms must appear");
        assert_eq!(select(arts, "unrelated").len(), 0);
    }

    #[test]
    fn a_brief_reports_the_cascade_rather_than_the_headcount() {
        let b = brief(&seeded(), "port", 0).unwrap();
        assert_eq!(b.matched, 3);
        assert_eq!(b.corroboration.independent_sources, 2, "the AP/BBC pair is ONE source, RT is another");
        assert_eq!(b.corroboration.echoes, 1);
        assert_eq!(b.corroboration.lineages[0].origin.outlet_id, "ap");
    }

    #[test]
    fn silence_is_reported_as_a_finding() {
        // What an outlet did NOT cover is the omission signal, and it only exists because the
        // roster is a closed, known set.
        let b = brief(&seeded(), "port", 0).unwrap();
        assert!(b.outlets.contains(&"ap".to_string()));
        assert!(b.silent.contains(&"tass".to_string()), "an outlet with no matching article is silent");
        assert!(b.silent.contains(&"npr".to_string()), "covering a DIFFERENT story still counts as silent here");
        assert_eq!(b.outlets.len() + b.silent.len(), 12, "every roster outlet is accounted for either way");
    }

    #[test]
    fn the_brief_carries_the_agency_deletion_contrast() {
        let b = brief(&seeded(), "port", 0).unwrap();
        assert_eq!(b.agency_deletion["rt"].deleted, 1, "`a building was struck` deletes its actor");
        assert!(b.agency_deletion["rt"].spans[0].text.contains("struck"));
    }

    #[test]
    fn an_unmatched_query_is_an_empty_brief_not_an_error() {
        let b = brief(&seeded(), "nothing-matches-this", 0).unwrap();
        assert_eq!(b.matched, 0);
        assert_eq!(b.corroboration.independent_sources, 0);
        assert_eq!(b.silent.len(), 12, "every outlet is silent on a story none of them ran");
    }
}
