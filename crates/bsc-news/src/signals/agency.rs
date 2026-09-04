//! Agency deletion — passive constructions that remove whoever acted.
//!
//! *"Shots were fired"* and *"a building was struck"* describe an event while deleting the actor.
//! The construction is grammatically ordinary and often innocent; what makes it a signal is the
//! **comparison**. When one outlet writes *"forces killed eleven"* and another writes *"eleven were
//! killed"* about the same event, the second has made a choice, and the matrix makes it visible.
//!
//! **This is a heuristic and the output says so.** It matches a form of English — a `be` verb
//! followed by a past participle with no `by`-phrase before the clause ends — not a meaning. It
//! will over-count some innocuous prose and miss actor deletion achieved by other means. That is
//! acceptable precisely because every count is reported with the span that produced it: a reader
//! can see each hit and discard the ones that do not hold. A signal that could not be checked this
//! way would not belong here.

use crate::types::{ArticleVersion, Span};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Forms of *to be* that can head an English passive.
const BE: &[&str] = &["was", "were", "is", "are", "been", "being", "be", "gets", "got"];

/// Irregular past participles that do not end in `-ed`. Without these the detector silently misses
/// the most common violent verbs in news copy, which is exactly where it needs to work.
const IRREGULAR: &[&str] = &[
    "shot", "struck", "hit", "hurt", "put", "set", "cut", "left", "lost", "held", "sent", "told", "taken", "beaten",
    "driven", "torn", "blown", "thrown", "shown", "found", "made", "seen", "known", "given", "written", "broken",
    "stolen", "burnt", "burned", "dealt", "flown", "overrun", "shaken", "slain", "spent", "swept", "withdrawn",
];

/// Words that end a clause, bounding the search for a `by`-phrase.
const CLAUSE_END: &[char] = &['.', ';', ':', '!', '?'];

/// How many words after the participle to search for `by` before concluding the actor is absent.
const BY_WINDOW: usize = 6;

/// One outlet's agency-deletion tally.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tally {
    /// Passives with no `by`-phrase — the actor is deleted.
    pub deleted: usize,
    /// Passives that DO name their actor (`were killed by shelling`), for contrast.
    pub attributed: usize,
    /// Where each deletion was.
    pub spans: Vec<Span>,
}

/// Outlet id → tally.
pub type Report = BTreeMap<String, Tally>;

fn is_participle(w: &str) -> bool {
    let w = w.trim_end_matches(|c: char| !c.is_alphanumeric());
    // `-ed` covers the regular case; the irregular list covers the verbs news copy actually uses.
    (w.len() > 3 && w.ends_with("ed")) || IRREGULAR.contains(&w)
}

/// Split text into words carrying their byte offsets, so a hit can be located exactly.
fn words_with_offsets(text: &str) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, c) in text.char_indices() {
        if c.is_alphanumeric() || c == '\'' || c == '-' {
            start.get_or_insert(i);
        } else if let Some(s) = start.take() {
            out.push((s, i, text[s..i].to_lowercase()));
        }
    }
    if let Some(s) = start {
        out.push((s, text.len(), text[s..].to_lowercase()));
    }
    out
}

/// Scan one article. Returns (deleted spans, attributed count).
pub fn scan(article: &ArticleVersion) -> (Vec<Span>, usize) {
    let text = article.text();
    let ws = words_with_offsets(&text);
    let (mut spans, mut attributed) = (Vec::new(), 0usize);
    for i in 0..ws.len() {
        if !BE.contains(&ws[i].2.as_str()) {
            continue;
        }
        // The participle may be one or two words on (`was badly damaged`).
        let Some(p) = (i + 1..=(i + 2).min(ws.len().saturating_sub(1))).find(|&j| is_participle(&ws[j].2)) else {
            continue;
        };
        // Look ahead for `by`, stopping at the end of the clause.
        let mut has_by = false;
        for k in (p + 1)..(p + 1 + BY_WINDOW).min(ws.len()) {
            if text[ws[k - 1].1..ws[k].0].contains(CLAUSE_END) {
                break;
            }
            if ws[k].2 == "by" {
                has_by = true;
                break;
            }
        }
        if has_by {
            attributed += 1;
        } else {
            spans.push(Span {
                url: article.url.clone(),
                outlet_id: article.outlet_id.clone(),
                start: ws[i].0,
                end: ws[p].1,
                text: text[ws[i].0..ws[p].1].to_string(),
            });
        }
    }
    (spans, attributed)
}

/// Tally agency deletion per outlet across a set of articles.
pub fn report(articles: &[ArticleVersion]) -> Report {
    let mut out: Report = BTreeMap::new();
    for a in articles {
        let (spans, attributed) = scan(a);
        let t = out
            .entry(a.outlet_id.clone())
            .or_insert_with(|| Tally { deleted: 0, attributed: 0, spans: Vec::new() });
        t.deleted += spans.len();
        t.attributed += attributed;
        t.spans.extend(spans);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn av(outlet: &str, text: &str) -> ArticleVersion {
        ArticleVersion {
            url: format!("{outlet}/1"),
            outlet_id: outlet.into(),
            seq: 1,
            fetched_at: 0,
            published_claim: None,
            title: text.into(),
            summary: String::new(),
        }
    }

    #[test]
    fn a_passive_with_no_actor_is_a_deletion() {
        let (spans, attributed) = scan(&av("x", "Shots were fired near the crossing."));
        assert_eq!(spans.len(), 1);
        assert_eq!(attributed, 0);
        assert_eq!(spans[0].text, "were fired");
    }

    #[test]
    fn a_passive_naming_its_actor_is_attributed_not_deleted() {
        let (spans, attributed) = scan(&av("x", "Eleven were killed by shelling."));
        assert!(spans.is_empty(), "the actor is present, so nothing was deleted");
        assert_eq!(attributed, 1);
    }

    #[test]
    fn irregular_participles_are_caught() {
        // Without the irregular list the detector misses the verbs news copy uses most.
        for s in ["A building was struck overnight.", "Two men were shot.", "The convoy was hit."] {
            let (spans, _) = scan(&av("x", s));
            assert_eq!(spans.len(), 1, "missed the passive in: {s}");
        }
    }

    #[test]
    fn an_active_sentence_is_not_a_passive() {
        let (spans, attributed) = scan(&av("x", "Forces killed eleven people and wounded twenty."));
        assert!(spans.is_empty());
        assert_eq!(attributed, 0);
    }

    #[test]
    fn a_by_phrase_in_the_next_clause_does_not_rescue_the_passive() {
        // The clause boundary matters: without it, any later `by` would mask the deletion.
        let (spans, attributed) = scan(&av("x", "A building was struck. Repairs were funded by the council."));
        assert_eq!(spans.len(), 1, "the first clause still deletes its actor");
        assert_eq!(spans[0].text, "was struck");
        assert_eq!(attributed, 1, "and the second clause names its own");
    }

    #[test]
    fn an_adverb_between_be_and_participle_is_tolerated() {
        let (spans, _) = scan(&av("x", "The market was badly damaged."));
        assert_eq!(spans.len(), 1);
    }

    #[test]
    fn every_deletion_carries_a_span_that_resolves_to_its_own_text() {
        let a = av("x", "Shots were fired and a building was struck.");
        let (spans, _) = scan(&a);
        assert_eq!(spans.len(), 2);
        for s in &spans {
            assert_eq!(&a.text()[s.start..s.end], s.text, "an offset that does not resolve is not evidence");
        }
    }

    #[test]
    fn the_report_contrasts_two_outlets_on_the_same_event() {
        // The comparison IS the signal — one number alone says nothing.
        let arts = vec![
            av("a", "Forces killed eleven people in the raid."),
            av("b", "Eleven were killed and a building was struck."),
        ];
        let r = report(&arts);
        assert_eq!(r["a"].deleted, 0);
        assert_eq!(r["b"].deleted, 2);
    }

    #[test]
    fn empty_text_is_zero_not_a_panic() {
        assert!(report(&[]).is_empty());
        let (spans, attributed) = scan(&av("x", ""));
        assert!(spans.is_empty());
        assert_eq!(attributed, 0);
    }
}
