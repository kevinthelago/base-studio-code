//! Ties the pieces together: poll the roster into the store, and assemble a brief over one event.

use crate::entities::{self, Kind, Lexis, Mention};
use crate::http::Http;
use crate::signals::{agency, corroborate, framing};
use crate::store::{Store, Wrote};
use crate::types::{ArticleVersion, Bloc, Outlet, OutletKind};
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


/// What to narrow the corpus to. Every field is AND-ed, and an empty filter matches everything.
///
/// The kinds are deliberately distinct rather than one free-text box: `putin` as a keyword cannot
/// tell the person from the place from the coincidence, and a keyword filter is useless unless you
/// already know the string to type — which is what [`entities::index`] exists to fix.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Filter {
    /// Free text — every term must appear.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub query: String,
    /// A person or name, matched against extracted mentions (case-insensitive, substring on the
    /// canonical key so `putin` finds `Putin’s`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub person: Vec<String>,
    /// A gazetteer place KEY (`russia`), which also matches its demonym and cities.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub place: Vec<String>,
    /// A gazetteer circumstance key (`flood`) or family (`disaster`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub circumstance: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outlet: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bloc: Vec<String>,
}

impl Filter {
    /// True when nothing is set — used to skip the extraction pass entirely.
    pub fn is_empty(&self) -> bool {
        self.query.is_empty()
            && self.person.is_empty()
            && self.place.is_empty()
            && self.circumstance.is_empty()
            && self.outlet.is_empty()
            && self.bloc.is_empty()
    }

    /// Does this filter need entity extraction, or is a text scan enough?
    fn needs_entities(&self) -> bool {
        !self.person.is_empty() || !self.place.is_empty() || !self.circumstance.is_empty()
    }
}

fn circumstance_keys_for(name: &str) -> Vec<&'static str> {
    let n = name.to_lowercase();
    // A family name (`disaster`) expands to every circumstance in it, so "what disasters is anyone
    // covering" is answerable without naming one.
    let by_family: Vec<&'static str> =
        crate::gazetteer::CIRCUMSTANCES.iter().filter(|c| c.family == n).map(|c| c.key).collect();
    if by_family.is_empty() {
        crate::gazetteer::CIRCUMSTANCES.iter().filter(|c| c.key == n).map(|c| c.key).collect()
    } else {
        by_family
    }
}

/// Apply a filter, returning the surviving articles paired with the mentions that matched.
pub fn apply(articles: Vec<ArticleVersion>, filter: &Filter) -> Vec<(ArticleVersion, Vec<Mention>)> {
    let blocs: Vec<Bloc> = filter.bloc.iter().filter_map(|b| Bloc::parse(b)).collect();
    let outlet_bloc: BTreeMap<String, Bloc> = outlets::roster().into_iter().map(|o| (o.id, o.bloc)).collect();
    let terms: Vec<String> = filter.query.split_whitespace().map(|t| t.to_lowercase()).collect();
    let wanted_circ: Vec<&str> = filter.circumstance.iter().flat_map(|c| circumstance_keys_for(c)).collect();
    let wanted_place: Vec<String> = filter.place.iter().map(|p| p.to_lowercase()).collect();
    let wanted_person: Vec<String> = filter.person.iter().map(|p| p.to_lowercase()).collect();

    // The lexis is learned once over the WHOLE candidate set, not per article — the discriminator
    // for a name is corpus-wide by construction.
    let lexis = if filter.needs_entities() { Lexis::from_articles(&articles) } else { Lexis::default() };

    articles
        .into_iter()
        .filter(|a| {
            if !filter.outlet.is_empty() && !filter.outlet.iter().any(|o| o == &a.outlet_id) {
                return false;
            }
            if !blocs.is_empty() && !outlet_bloc.get(&a.outlet_id).is_some_and(|b| blocs.contains(b)) {
                return false;
            }
            let text = a.text().to_lowercase();
            terms.iter().all(|t| text.contains(t))
        })
        .filter_map(|a| {
            if !filter.needs_entities() {
                return Some((a, Vec::new()));
            }
            let mentions = entities::extract(&a, &lexis);
            let hit_person = wanted_person.is_empty()
                || mentions.iter().any(|m| {
                    matches!(m.kind, Kind::Person | Kind::Name) && wanted_person.iter().any(|w| m.key.contains(w))
                });
            let hit_place = wanted_place.is_empty()
                || mentions.iter().any(|m| m.kind == Kind::Place && wanted_place.contains(&m.key));
            let hit_circ = wanted_circ.is_empty()
                || mentions.iter().any(|m| m.kind == Kind::Circumstance && wanted_circ.contains(&m.key.as_str()));
            if hit_person && hit_place && hit_circ {
                // Keep only the mentions that DID the matching, so the caller can show why.
                let why: Vec<Mention> = mentions
                    .into_iter()
                    .filter(|m| match m.kind {
                        Kind::Person | Kind::Name => wanted_person.iter().any(|w| m.key.contains(w)),
                        Kind::Place => wanted_place.contains(&m.key),
                        Kind::Circumstance => wanted_circ.contains(&m.key.as_str()),
                    })
                    .collect();
                Some((a, why))
            } else {
                None
            }
        })
        .collect()
}

/// One row of `bsc news find`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hit {
    pub url: String,
    pub outlet_id: String,
    pub bloc: String,
    pub first_seen: i64,
    pub title: String,
    /// The mentions that satisfied the filter — why this article is here.
    pub matched: Vec<Mention>,
}

/// Find articles matching a filter.
pub fn find(store: &Store, filter: &Filter, since: i64) -> Result<Vec<Hit>, String> {
    let blocs: BTreeMap<String, Bloc> = outlets::roster().into_iter().map(|o| (o.id, o.bloc)).collect();
    Ok(apply(store.first_versions(since)?, filter)
        .into_iter()
        .map(|(a, matched)| Hit {
            bloc: blocs.get(&a.outlet_id).map_or("--", |b| b.code()).to_string(),
            url: a.url,
            outlet_id: a.outlet_id,
            first_seen: a.fetched_at,
            title: a.title,
            matched,
        })
        .collect())
}

/// The discovery index over the stored corpus.
pub fn entity_index(store: &Store, since: i64, kind: Option<Kind>) -> Result<Vec<entities::Entity>, String> {
    let rows = entities::index(&store.first_versions(since)?);
    Ok(match kind {
        // Person and Name are one axis to a reader asking "who is in here".
        Some(Kind::Person) => rows.into_iter().filter(|r| matches!(r.kind, Kind::Person | Kind::Name)).collect(),
        Some(k) => rows.into_iter().filter(|r| r.kind == k).collect(),
        None => rows,
    })
}

/// A human label for what a filter selected, used as the brief's header.
pub fn describe(f: &Filter) -> String {
    let mut parts = Vec::new();
    if !f.query.is_empty() {
        parts.push(f.query.clone());
    }
    for (label, vals) in
        [("person", &f.person), ("place", &f.place), ("circumstance", &f.circumstance), ("outlet", &f.outlet), ("bloc", &f.bloc)]
    {
        if !vals.is_empty() {
            parts.push(format!("{label}={}", vals.join("|")));
        }
    }
    if parts.is_empty() {
        "(everything)".to_string()
    } else {
        parts.join(" ")
    }
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
pub fn brief(store: &Store, filter: &Filter, since: i64) -> Result<Brief, String> {
    let matched: Vec<ArticleVersion> =
        apply(store.first_versions(since)?, filter).into_iter().map(|(a, _)| a).collect();
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
        query: describe(filter),
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

    /// A query-only filter — the shape the old `brief(store, "port", …)` had.
    fn q(query: &str) -> Filter {
        Filter { query: query.into(), ..Default::default() }
    }

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
        let b = brief(&seeded(), &q("port"), 0).unwrap();
        assert_eq!(b.matched, 3);
        assert_eq!(b.corroboration.independent_sources, 2, "the AP/BBC pair is ONE source, RT is another");
        assert_eq!(b.corroboration.echoes, 1);
        assert_eq!(b.corroboration.lineages[0].origin.outlet_id, "ap");
    }

    #[test]
    fn silence_is_reported_as_a_finding() {
        // What an outlet did NOT cover is the omission signal, and it only exists because the
        // roster is a closed, known set.
        let b = brief(&seeded(), &q("port"), 0).unwrap();
        assert!(b.outlets.contains(&"ap".to_string()));
        assert!(b.silent.contains(&"tass".to_string()), "an outlet with no matching article is silent");
        assert!(b.silent.contains(&"npr".to_string()), "covering a DIFFERENT story still counts as silent here");
        assert_eq!(b.outlets.len() + b.silent.len(), 12, "every roster outlet is accounted for either way");
    }

    #[test]
    fn the_brief_carries_the_agency_deletion_contrast() {
        let b = brief(&seeded(), &q("port"), 0).unwrap();
        assert_eq!(b.agency_deletion["rt"].deleted, 1, "`a building was struck` deletes its actor");
        assert!(b.agency_deletion["rt"].spans[0].text.contains("struck"));
    }

    fn filtered() -> Store {
        // Real headlines from the 2026-09-04 live poll, across four blocs.
        let s = Store::in_memory().unwrap();
        for (o, t, at) in [
            ("ap", "2 trapped workers rescued from a tunnel 9 days after Nepal floods", 100),
            ("bbc", "Nepal says it will need billions in funding to rebuild after flash floods", 110),
            ("tass", "Russians’ trust in Putin exceeds 72% — pollster", 120),
            ("rt", "Putin meets Xi and Modi at SCO summit: As it happened", 130),
            ("meduza", "Russian drone strikes SBU headquarters in Kyiv, Zelensky says", 140),
            ("scmp", "How natural disasters are putting China’s neighbourhood diplomacy to the test", 150),
            ("fox", "Billions in US aid to Ukraine under microscope as corruption rocks Zelenskyy’s inner circle", 160),
        ] {
            s.record(o, &item(&format!("{o}/1"), t, ""), at).unwrap();
        }
        s
    }

    #[test]
    fn a_place_filter_matches_the_demonym_and_the_city_not_just_the_country() {
        // The reason the gazetteer carries `forms` at all: `Russian` and `Kyiv` never contain the
        // country name, and between them they are most of the real hits.
        let hits = find(&filtered(), &Filter { place: vec!["russia".into()], ..Default::default() }, 0).unwrap();
        let outlets: Vec<&str> = hits.iter().map(|h| h.outlet_id.as_str()).collect();
        assert!(outlets.contains(&"tass"), "`Russians` must match place=russia");
        assert!(outlets.contains(&"meduza"), "`Russian` must match place=russia");
        assert!(!outlets.contains(&"scmp"), "an unrelated article must not be swept in");
    }

    #[test]
    fn a_circumstance_family_expands_to_its_members() {
        // `disaster` names no single event, which is the point — it is how you ask what disasters
        // anyone is covering without already knowing there was a flood.
        let f = Filter { circumstance: vec!["disaster".into()], ..Default::default() };
        let hits = find(&filtered(), &f, 0).unwrap();
        let outlets: Vec<&str> = hits.iter().map(|h| h.outlet_id.as_str()).collect();
        assert!(outlets.contains(&"ap") && outlets.contains(&"bbc"), "both flood stories are disasters");
        let just_flood = find(&filtered(), &Filter { circumstance: vec!["flood".into()], ..Default::default() }, 0).unwrap();
        assert_eq!(just_flood.len(), 2, "the specific key still works");
    }

    #[test]
    fn a_person_filter_matches_extracted_names_and_carries_its_evidence() {
        let hits = find(&filtered(), &Filter { person: vec!["putin".into()], ..Default::default() }, 0).unwrap();
        assert_eq!(hits.len(), 2, "TASS and RT both name Putin");
        for h in &hits {
            assert!(!h.matched.is_empty(), "a hit must say WHY it matched");
            assert!(h.matched.iter().any(|m| m.key.contains("putin")));
        }
    }

    #[test]
    fn filters_are_and_ed() {
        let f = Filter { person: vec!["putin".into()], circumstance: vec!["summit".into()], ..Default::default() };
        let hits = find(&filtered(), &f, 0).unwrap();
        assert_eq!(hits.len(), 1, "TASS names Putin but reports no summit; only RT is both");
        assert_eq!(hits[0].outlet_id, "rt");
    }

    #[test]
    fn a_person_does_not_imply_their_country() {
        // `--place russia` asks what the article MENTIONS, not what it is tacitly about. RT's SCO
        // summit headline names Putin and no Russian place, so it is correctly absent — inferring
        // the country from the person would be the layer guessing, which is what it must not do.
        let hits = find(&filtered(), &Filter { place: vec!["russia".into()], ..Default::default() }, 0).unwrap();
        assert!(
            !hits.iter().any(|h| h.outlet_id == "rt"),
            "a place filter must not silently expand to people associated with that place"
        );
    }

    #[test]
    fn bloc_and_outlet_narrow_without_entity_extraction() {
        let hits = find(&filtered(), &Filter { bloc: vec!["RU".into()], ..Default::default() }, 0).unwrap();
        assert_eq!(hits.len(), 3, "tass, rt and meduza are the RU bloc");
        let one = find(&filtered(), &Filter { outlet: vec!["bbc".into()], ..Default::default() }, 0).unwrap();
        assert_eq!(one.len(), 1);
    }

    #[test]
    fn an_empty_filter_is_refused_by_the_caller_but_matches_everything_here() {
        // `apply` is the pure primitive and stays total; the CLI is what refuses an empty filter,
        // because "brief everything" is a mistake rather than a query.
        assert!(Filter::default().is_empty());
        let all = apply(filtered().first_versions(0).unwrap(), &Filter::default());
        assert_eq!(all.len(), 7);
    }

    #[test]
    fn a_brief_can_be_scoped_by_filter_rather_than_keyword() {
        let b = brief(&filtered(), &Filter { place: vec!["nepal".into()], ..Default::default() }, 0).unwrap();
        assert_eq!(b.matched, 2);
        assert!(b.query.contains("place=nepal"), "the header names what selected it: {}", b.query);
    }

    #[test]
    fn the_entity_index_surfaces_what_can_be_filtered_on() {
        // The discovery half: these keys are exactly the ones `find` accepts.
        let rows = entity_index(&filtered(), 0, Some(Kind::Place)).unwrap();
        let keys: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
        assert!(keys.contains(&"russia") && keys.contains(&"nepal"));
        for r in &rows {
            assert!(
                !find(&filtered(), &Filter { place: vec![r.key.clone()], ..Default::default() }, 0).unwrap().is_empty(),
                "every key the index advertises must be usable as a filter: {}",
                r.key
            );
        }
    }

    #[test]
    fn an_unmatched_query_is_an_empty_brief_not_an_error() {
        let b = brief(&seeded(), &q("nothing-matches-this"), 0).unwrap();
        assert_eq!(b.matched, 0);
        assert_eq!(b.corroboration.independent_sources, 0);
        assert_eq!(b.silent.len(), 12, "every outlet is silent on a story none of them ran");
    }
}
