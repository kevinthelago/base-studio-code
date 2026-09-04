//! The framing matrix — which contested word each outlet chose for the same thing.
//!
//! Outlets covering one event pick different words for the identical referent: *militant* or
//! *terrorist* or *fighter*; *regime* or *government*; *detained* or *kidnapped*. The choice is
//! editorial and it is the most legible bias signal available, because it needs no interpretation —
//! the matrix simply shows who said what, and the reader draws the conclusion.
//!
//! The lexicon is data, not judgement: it names axes of contested vocabulary and never labels a
//! term as biased or correct. That restraint is deliberate. The moment this file ranks *terrorist*
//! above *militant* it becomes another outlet, and the reader loses the ability to disagree with it.

use crate::types::{ArticleVersion, Span};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// One axis of contested vocabulary: a referent, and the competing words used for it.
pub struct Axis {
    /// What the words all refer to.
    pub name: &'static str,
    /// The competing terms, lowercase. Order carries no meaning — it is not a scale.
    pub terms: &'static [&'static str],
}

/// The lexicon. Terms are matched on whole words, so `raid` never fires inside `afraid`.
pub const AXES: &[Axis] = &[
    Axis {
        name: "actor",
        terms: &["militant", "militants", "terrorist", "terrorists", "insurgent", "insurgents", "rebel", "rebels", "fighter", "fighters", "extremist", "extremists", "gunman", "gunmen", "attacker", "attackers", "separatist", "separatists"],
    },
    Axis {
        name: "governance",
        terms: &["regime", "government", "administration", "authorities", "junta", "leadership"],
    },
    Axis {
        name: "detention",
        terms: &["detained", "arrested", "kidnapped", "abducted", "seized", "captured", "held", "jailed"],
    },
    Axis {
        name: "violence",
        terms: &["strike", "strikes", "attack", "attacks", "massacre", "operation", "operations", "incident", "raid", "raids", "clash", "clashes", "offensive", "assault"],
    },
    Axis {
        name: "death",
        terms: &["killed", "died", "slain", "murdered", "executed", "eliminated", "neutralized", "neutralised", "perished", "casualties", "fatalities"],
    },
    Axis {
        name: "displacement",
        terms: &["refugee", "refugees", "migrant", "migrants", "asylum", "displaced", "evacuees"],
    },
    Axis {
        name: "attribution",
        terms: &["alleged", "allegedly", "reportedly", "claimed", "purported", "so-called", "supposed"],
    },
];

/// One outlet's term choices on one axis.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cell {
    /// Term → how many times this outlet used it.
    pub terms: BTreeMap<String, usize>,
    /// Where each hit was, so a count can be read back to the sentence it came from.
    pub spans: Vec<Span>,
}

/// The matrix: axis → outlet → cell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Matrix {
    pub axes: BTreeMap<String, BTreeMap<String, Cell>>,
    /// Axes where the outlets did not all choose the same word — the rows worth reading first.
    pub contested: Vec<String>,
}

/// Whole-word, case-insensitive occurrences of `term` in `text`, as byte offsets.
fn find_term(text: &str, term: &str) -> Vec<(usize, usize)> {
    let lower = text.to_lowercase();
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find(term) {
        let start = from + rel;
        let end = start + term.len();
        let before_ok = start == 0 || !lower[..start].chars().next_back().is_some_and(|c| c.is_alphanumeric());
        let after_ok = end >= lower.len() || !lower[end..].chars().next().is_some_and(|c| c.is_alphanumeric());
        if before_ok && after_ok {
            out.push((start, end));
        }
        from = end.max(start + 1);
        if from >= lower.len() {
            break;
        }
    }
    out
}

/// Build the framing matrix over a set of articles.
pub fn matrix(articles: &[ArticleVersion]) -> Matrix {
    let mut axes: BTreeMap<String, BTreeMap<String, Cell>> = BTreeMap::new();
    for axis in AXES {
        let mut per_outlet: BTreeMap<String, Cell> = BTreeMap::new();
        for art in articles {
            let text = art.text();
            for term in axis.terms {
                for (start, end) in find_term(&text, term) {
                    let cell = per_outlet
                        .entry(art.outlet_id.clone())
                        .or_insert_with(|| Cell { terms: BTreeMap::new(), spans: Vec::new() });
                    *cell.terms.entry((*term).to_string()).or_insert(0) += 1;
                    cell.spans.push(Span {
                        url: art.url.clone(),
                        outlet_id: art.outlet_id.clone(),
                        start,
                        end,
                        text: text[start..end].to_string(),
                    });
                }
            }
        }
        if !per_outlet.is_empty() {
            axes.insert(axis.name.to_string(), per_outlet);
        }
    }

    // An axis is contested when at least two outlets used it and they did not all pick the same
    // vocabulary. An axis everyone words identically is agreement, and agreement is not news.
    let contested = axes
        .iter()
        .filter(|(_, per_outlet)| {
            if per_outlet.len() < 2 {
                return false;
            }
            let choices: std::collections::BTreeSet<Vec<&String>> =
                per_outlet.values().map(|c| c.terms.keys().collect()).collect();
            choices.len() > 1
        })
        .map(|(name, _)| name.clone())
        .collect();

    Matrix { axes, contested }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn av(url: &str, outlet: &str, text: &str) -> ArticleVersion {
        ArticleVersion {
            url: url.into(),
            outlet_id: outlet.into(),
            seq: 1,
            fetched_at: 0,
            published_claim: None,
            title: text.into(),
            summary: String::new(),
        }
    }

    #[test]
    fn the_same_referent_worded_differently_shows_up_as_contested() {
        let arts = vec![
            av("a", "bbc", "Militants attacked the government convoy"),
            av("b", "rt", "Terrorists attacked the regime convoy"),
        ];
        let m = matrix(&arts);
        assert!(m.contested.contains(&"actor".to_string()));
        assert!(m.contested.contains(&"governance".to_string()));
        assert_eq!(m.axes["actor"]["bbc"].terms.get("militants"), Some(&1));
        assert_eq!(m.axes["actor"]["rt"].terms.get("terrorists"), Some(&1));
    }

    #[test]
    fn an_axis_everyone_words_the_same_is_not_contested() {
        let arts = vec![av("a", "bbc", "Two were killed"), av("b", "rt", "Three were killed")];
        let m = matrix(&arts);
        assert!(m.axes.contains_key("death"), "the axis is still recorded");
        assert!(!m.contested.contains(&"death".to_string()), "agreement is not a finding");
    }

    #[test]
    fn a_single_outlet_axis_is_never_contested() {
        let m = matrix(&[av("a", "bbc", "Militants fled")]);
        assert!(m.contested.is_empty(), "one outlet cannot disagree with itself");
    }

    #[test]
    fn terms_match_whole_words_only() {
        // `raid` inside `afraid` was the first false positive this guard caught.
        let m = matrix(&[av("a", "bbc", "Residents were afraid to return"), av("b", "rt", "A raid followed")]);
        assert!(!m.axes["violence"].contains_key("bbc"), "afraid must not count as raid");
        assert_eq!(m.axes["violence"]["rt"].terms.get("raid"), Some(&1));
    }

    #[test]
    fn every_count_carries_a_span_pointing_at_the_matched_text() {
        let arts = vec![av("a", "bbc", "Militants and more militants")];
        let m = matrix(&arts);
        let cell = &m.axes["actor"]["bbc"];
        assert_eq!(cell.terms["militants"], 2, "both occurrences are counted");
        assert_eq!(cell.spans.len(), 2, "and both are located");
        for s in &cell.spans {
            assert_eq!(s.text.to_lowercase(), "militants", "a span must quote what it matched");
            assert_eq!(&arts[0].text()[s.start..s.end], s.text, "and its offsets must resolve to that text");
        }
    }

    #[test]
    fn matching_is_case_insensitive_but_the_span_keeps_the_original_case() {
        let arts = vec![av("a", "bbc", "REGIME forces advanced")];
        let m = matrix(&arts);
        assert_eq!(m.axes["governance"]["bbc"].terms.get("regime"), Some(&1));
        assert_eq!(m.axes["governance"]["bbc"].spans[0].text, "REGIME");
    }

    #[test]
    fn the_lexicon_never_ranks_a_term() {
        // If a "preferred"/"loaded" field is ever added, this crate has started editorializing.
        for axis in AXES {
            assert!(!axis.terms.is_empty(), "{} needs terms", axis.name);
            let unique: std::collections::BTreeSet<_> = axis.terms.iter().collect();
            assert_eq!(unique.len(), axis.terms.len(), "{} repeats a term", axis.name);
            for t in axis.terms {
                assert_eq!(*t, t.to_lowercase(), "{t} must be lowercase to match");
            }
        }
    }

    #[test]
    fn no_articles_yields_an_empty_matrix_not_a_panic() {
        let m = matrix(&[]);
        assert!(m.axes.is_empty());
        assert!(m.contested.is_empty());
    }
}
