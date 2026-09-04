//! Corroboration with wire ancestry — the headline signal.
//!
//! **"Forty outlets reported it" is a statement about reprinting, not about corroboration.** When
//! thirty-eight of them ran the same agency copy, there is one source and thirty-nine echoes, and
//! reporting the raw count as independent confirmation is the specific deception this crate exists
//! to undo.
//!
//! The method is deliberately mechanical and has no model in it: normalize to word shingles, group
//! articles whose text overlaps above a threshold into a **lineage**, and name each lineage's
//! origin. Origin is the lineage's wire agency when one is present — a wire moves to subscribers
//! before it appears on any website, so the earliest *observed* member is often an echo that
//! published fast — and otherwise the earliest first-seen member.
//!
//! Every echo carries the longest word run it shares with its origin, so a reader can see the
//! reprint rather than take the score on faith.

use crate::types::{ArticleVersion, OutletKind, Span};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Widest shingle, used once a text is long enough to support it. Eight words is long enough that
/// ordinary shared phrasing about the same event ("the ministry said on Thursday") does not
/// collide, and short enough to survive the light trimming an editor applies to wire copy.
pub const SHINGLE_MAX: usize = 8;

/// Narrowest shingle, used for headline-only texts.
pub const SHINGLE_MIN: usize = 3;

/// Shingle width for a comparison between texts of `a` and `b` words.
///
/// **A window wider than the text is a broken measurement, not a strict one.** A fixed eight-word
/// window over a ten-word headline yields three shingles, so containment can only be 0, ⅓, ⅔ or 1 —
/// and two outlets that rewrote the same headline share no eight consecutive words at all. At that
/// width the signal answers *"did an outlet copy the headline verbatim"*, which is a far narrower
/// question than *"is this the same story"*. Half the corpus is headline-only by construction (news
/// sitemaps carry no summary), so this is the common path rather than a corner.
///
/// The width therefore scales with the SHORTER text — it is the one that bounds how much overlap is
/// expressible — targeting roughly five windows before clamping.
pub fn shingle_width(a: usize, b: usize) -> usize {
    (a.min(b) / 5).clamp(SHINGLE_MIN, SHINGLE_MAX)
}

/// Where a comparison's evidence came from, carried into the result so a headline-only match is
/// never mistaken for body-text evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Basis {
    /// Every article carried body text: reprint detection is reliable.
    BodyText,
    /// At least one side was headline-only. A rewritten headline still clusters, but a reprint of
    /// an unquoted body cannot be seen at all — so an echo count here is a FLOOR, not a total.
    HeadlineOnly,
}

/// Words below which a text is treated as a headline rather than a body.
const HEADLINE_WORDS: usize = 25;

/// Containment above which two articles are the same text lineage. Containment rather than Jaccard
/// because a reprint is usually a TRUNCATION of the wire story, and Jaccard punishes the length
/// difference that reprinting actually produces.
pub const THRESHOLD: f64 = 0.35;

/// One article's place in a lineage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Member {
    pub url: String,
    pub outlet_id: String,
    pub first_seen: i64,
    pub title: String,
    /// Containment against the lineage origin (1.0 for the origin itself).
    pub overlap: f64,
    /// The longest word run this article shares with the origin — the reprint, quoted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared: Option<Span>,
}

/// A set of articles carrying the same text, and the one it came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lineage {
    pub origin: Member,
    /// Why this member was named the origin — `wire` or `first-seen`.
    pub origin_basis: String,
    pub echoes: Vec<Member>,
}

/// The signal's result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Corroboration {
    /// Articles examined.
    pub articles: usize,
    /// **The number that matters**: distinct text lineages, i.e. actually independent reports.
    pub independent_sources: usize,
    /// Articles that are reprints of another article in the set.
    pub echoes: usize,
    /// What the comparison had to work with. On [`Basis::HeadlineOnly`] the echo count is a FLOOR:
    /// an outlet that reprinted the body while rewriting the headline is invisible here.
    pub basis: Basis,
    pub lineages: Vec<Lineage>,
}

/// Lowercase alphanumeric words, in order. Punctuation and case are dropped because they are the
/// first thing a subeditor changes and the last thing that carries meaning.
pub fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect()
}

/// Hashed word shingles at an explicit width. Hashing keeps the set small; collisions at these
/// widths are far rarer than the noise already present in the threshold.
fn shingles(words: &[String], width: usize) -> BTreeSet<u64> {
    use std::hash::{Hash, Hasher};
    if words.len() < width {
        // Too short even for the narrowest window — hash the whole thing so it still compares.
        let mut h = std::collections::hash_map::DefaultHasher::new();
        words.hash(&mut h);
        return BTreeSet::from([h.finish()]);
    }
    words
        .windows(width)
        .map(|w| {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            w.hash(&mut h);
            h.finish()
        })
        .collect()
}

/// |a ∩ b| / min(|a|, |b|) — how much of the SHORTER text is contained in the longer.
fn containment(a: &BTreeSet<u64>, b: &BTreeSet<u64>) -> f64 {
    let smaller = a.len().min(b.len());
    if smaller == 0 {
        return 0.0;
    }
    a.intersection(b).count() as f64 / smaller as f64
}

/// The longest run of consecutive words `a` and `b` share, as a span into `a`'s text.
fn longest_shared_run(a: &ArticleVersion, b: &ArticleVersion) -> Option<Span> {
    let (aw, bw) = (words(&a.text()), words(&b.text()));
    if aw.is_empty() || bw.is_empty() {
        return None;
    }
    // Classic DP over word arrays; texts here are headline+summary, so this stays small.
    let mut prev = vec![0usize; bw.len() + 1];
    let mut cur = vec![0usize; bw.len() + 1];
    let (mut best, mut best_end_a) = (0usize, 0usize);
    for i in 1..=aw.len() {
        for j in 1..=bw.len() {
            cur[j] = if aw[i - 1] == bw[j - 1] { prev[j - 1] + 1 } else { 0 };
            if cur[j] > best {
                best = cur[j];
                best_end_a = i;
            }
        }
        std::mem::swap(&mut prev, &mut cur);
        cur.iter_mut().for_each(|c| *c = 0);
    }
    // A run shorter than the width these two were compared at is coincidence, not evidence.
    if best < shingle_width(aw.len(), bw.len()) {
        return None;
    }
    let run = aw[best_end_a - best..best_end_a].join(" ");
    let text = a.text();
    // Locate the run in the original text so the offset points at real characters. The words are
    // normalized, so fall back to the first word's position when the join does not match verbatim.
    let start = text
        .to_lowercase()
        .find(&run)
        .or_else(|| text.to_lowercase().find(aw[best_end_a - best].as_str()))?;
    Some(Span {
        url: a.url.clone(),
        outlet_id: a.outlet_id.clone(),
        start,
        end: (start + run.len()).min(text.len()),
        text: run,
    })
}

/// Group articles into lineages and name each origin.
///
/// `kinds` maps an outlet id to whether it is a wire agency; an outlet missing from the map is
/// treated as a plain outlet, so an unknown source can never be crowned the origin of a cascade.
pub fn corroborate(articles: &[ArticleVersion], kinds: &BTreeMap<String, OutletKind>) -> Corroboration {
    let word_lists: Vec<Vec<String>> = articles.iter().map(|a| words(&a.text())).collect();
    // A pair is compared at the width its SHORTER member can support, so each set is built per
    // comparison rather than once — the cost is trivial at these corpus sizes and the alternative
    // is measuring long texts against a window their partner cannot fill.
    let overlap = |i: usize, j: usize| -> f64 {
        let w = shingle_width(word_lists[i].len(), word_lists[j].len());
        containment(&shingles(&word_lists[i], w), &shingles(&word_lists[j], w))
    };
    let basis = if word_lists.iter().all(|w| w.len() >= HEADLINE_WORDS) {
        Basis::BodyText
    } else {
        Basis::HeadlineOnly
    };

    // Union-find over the overlap graph: reprinting is transitive (A→B→C is one lineage even when
    // A and C were trimmed differently enough to fall under the threshold against each other).
    let mut parent: Vec<usize> = (0..articles.len()).collect();
    fn find(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    for i in 0..articles.len() {
        for j in (i + 1)..articles.len() {
            if overlap(i, j) >= THRESHOLD {
                let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                if ri != rj {
                    parent[ri] = rj;
                }
            }
        }
    }

    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for i in 0..articles.len() {
        let root = find(&mut parent, i);
        groups.entry(root).or_default().push(i);
    }

    let is_agency = |idx: usize| {
        kinds.get(&articles[idx].outlet_id).copied().unwrap_or(OutletKind::Outlet) == OutletKind::Agency
    };

    let mut lineages: Vec<Lineage> = groups
        .into_values()
        .map(|mut idxs| {
            // Earliest first-seen first; ties broken by URL so the output is deterministic.
            idxs.sort_by(|&a, &b| {
                articles[a]
                    .fetched_at
                    .cmp(&articles[b].fetched_at)
                    .then_with(|| articles[a].url.cmp(&articles[b].url))
            });
            // A wire in the group is the origin regardless of when we happened to see it: the wire
            // moves to subscribers before it appears on any public site, so observation order alone
            // would routinely crown a fast-publishing subscriber.
            let (origin_at, basis) = match idxs.iter().position(|&i| is_agency(i)) {
                Some(pos) => (pos, "wire"),
                None => (0, "first-seen"),
            };
            let origin_idx = idxs[origin_at];
            let member = |i: usize| Member {
                url: articles[i].url.clone(),
                outlet_id: articles[i].outlet_id.clone(),
                first_seen: articles[i].fetched_at,
                title: articles[i].title.clone(),
                overlap: if i == origin_idx {
                    1.0
                } else {
                    (overlap(i, origin_idx) * 1000.0).round() / 1000.0
                },
                shared: if i == origin_idx {
                    None
                } else {
                    longest_shared_run(&articles[i], &articles[origin_idx])
                },
            };
            Lineage {
                origin: member(origin_idx),
                origin_basis: basis.to_string(),
                echoes: idxs.into_iter().filter(|&i| i != origin_idx).map(member).collect(),
            }
        })
        .collect();

    // Biggest cascade first — the most-reprinted story is the one a reader most needs warning about.
    lineages.sort_by(|a, b| {
        b.echoes
            .len()
            .cmp(&a.echoes.len())
            .then_with(|| a.origin.first_seen.cmp(&b.origin.first_seen))
            .then_with(|| a.origin.url.cmp(&b.origin.url))
    });

    Corroboration {
        articles: articles.len(),
        independent_sources: lineages.len(),
        echoes: lineages.iter().map(|l| l.echoes.len()).sum(),
        basis,
        lineages,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn av(url: &str, outlet: &str, at: i64, title: &str, summary: &str) -> ArticleVersion {
        ArticleVersion {
            url: url.into(),
            outlet_id: outlet.into(),
            seq: 1,
            fetched_at: at,
            published_claim: None,
            title: title.into(),
            summary: summary.into(),
        }
    }

    /// The wire sentence every echo reprints, long enough to shingle.
    const WIRE: &str = "Officials said two people were killed and eleven wounded when a missile hit \
                        the southern port early on Thursday, according to the emergency service.";

    fn kinds() -> BTreeMap<String, OutletKind> {
        BTreeMap::from([
            ("ap".to_string(), OutletKind::Agency),
            ("reuters".to_string(), OutletKind::Agency),
            ("bbc".to_string(), OutletKind::Outlet),
            ("fox".to_string(), OutletKind::Outlet),
            ("npr".to_string(), OutletKind::Outlet),
        ])
    }

    #[test]
    fn a_wire_cascade_reports_one_source_not_four() {
        // The failure this signal exists to prevent: four outlets, one story.
        let arts = vec![
            av("ap/1", "ap", 100, "Strike on port kills two", WIRE),
            av("bbc/1", "bbc", 140, "Two killed in port strike", WIRE),
            av("fox/1", "fox", 150, "Missile hits port, two dead", WIRE),
            av("npr/1", "npr", 160, "Two die in strike on port", WIRE),
        ];
        let c = corroborate(&arts, &kinds());
        assert_eq!(c.articles, 4);
        assert_eq!(c.independent_sources, 1, "four reprints of one wire story are ONE source");
        assert_eq!(c.echoes, 3);
        assert_eq!(c.lineages[0].origin.outlet_id, "ap");
    }

    #[test]
    fn the_wire_is_the_origin_even_when_an_outlet_published_first() {
        // A wire moves to subscribers before it is public, so observation order alone would crown
        // the fastest subscriber. This is the ordering bug the `wire` basis exists to prevent.
        let arts = vec![
            av("bbc/1", "bbc", 100, "Two killed in port strike", WIRE),
            av("ap/1", "ap", 500, "Strike on port kills two", WIRE),
        ];
        let c = corroborate(&arts, &kinds());
        assert_eq!(c.lineages[0].origin.outlet_id, "ap");
        assert_eq!(c.lineages[0].origin_basis, "wire");
        assert_eq!(c.lineages[0].origin.first_seen, 500, "the origin keeps its own observed time");
    }

    #[test]
    fn with_no_wire_the_earliest_first_seen_is_the_origin() {
        let arts = vec![
            av("fox/1", "fox", 300, "Missile hits port", WIRE),
            av("bbc/1", "bbc", 100, "Two killed in port strike", WIRE),
        ];
        let c = corroborate(&arts, &kinds());
        assert_eq!(c.lineages[0].origin.outlet_id, "bbc");
        assert_eq!(c.lineages[0].origin_basis, "first-seen");
    }

    #[test]
    fn genuinely_independent_reports_stay_separate() {
        let arts = vec![
            av("ap/1", "ap", 100, "Strike on port kills two", WIRE),
            av(
                "bbc/1",
                "bbc",
                200,
                "Rail dispute talks collapse",
                "Union negotiators walked out of the arbitration meeting on Tuesday afternoon after \
                 the operator withdrew its revised pay offer without explanation.",
            ),
        ];
        let c = corroborate(&arts, &kinds());
        assert_eq!(c.independent_sources, 2, "different stories must not be folded into one lineage");
        assert_eq!(c.echoes, 0);
    }

    #[test]
    fn an_echo_carries_the_shared_run_as_evidence() {
        // Criterion: no number is reported without the text that produced it.
        let arts = vec![av("ap/1", "ap", 100, "Strike on port", WIRE), av("bbc/1", "bbc", 140, "Port strike", WIRE)];
        let c = corroborate(&arts, &kinds());
        let echo = &c.lineages[0].echoes[0];
        let span = echo.shared.as_ref().expect("an echo must quote the run it shares with the origin");
        assert!(span.text.split_whitespace().count() >= SHINGLE_MIN, "the quoted run is at least a shingle long");
        assert_eq!(span.url, "bbc/1", "the span points at the ECHO's own text");
        assert!(span.end > span.start);
        assert!(echo.overlap > THRESHOLD);
    }

    #[test]
    fn reprinting_is_transitive_across_trimmed_intermediates() {
        // A→B→C is one lineage even when A and C were trimmed differently enough to miss each other.
        let head = "Officials said two people were killed and eleven wounded when a missile hit the southern port";
        let tail = "when a missile hit the southern port early on Thursday according to the emergency service";
        let arts = vec![
            av("ap/1", "ap", 100, "Full", WIRE),
            av("bbc/1", "bbc", 200, "Head", head),
            av("fox/1", "fox", 300, "Tail", tail),
        ];
        let c = corroborate(&arts, &kinds());
        assert_eq!(c.independent_sources, 1);
        assert_eq!(c.lineages[0].echoes.len(), 2);
    }

    #[test]
    fn an_unknown_outlet_is_never_crowned_the_origin_of_a_wire_cascade() {
        // A source missing from the roster defaults to Outlet, so a bad id cannot fake wire status.
        let arts = vec![av("mystery", "mystery", 50, "Early", WIRE), av("ap/1", "ap", 100, "Wire", WIRE)];
        let c = corroborate(&arts, &kinds());
        assert_eq!(c.lineages[0].origin.outlet_id, "ap");
        assert_eq!(c.lineages[0].origin_basis, "wire");
    }

    /// Real headlines, taken verbatim from the 2026-09-04 live poll. Four outlets, one story — the
    /// case a fixed eight-word shingle could not see, which is why the width is adaptive.
    const NEPAL: &[(&str, &str)] = &[
        ("ap", "2 trapped workers rescued from a tunnel 9 days after Nepal floods"),
        ("scmp", "2 trapped workers rescued alive from Nepal tunnel 9 days after floods"),
        ("guardian", "Two workers pulled alive from tunnel nine days after Nepal-Tibet floods"),
        ("fox", "Trapped Nepal workers pulled alive from tunnel 9 days after deadly flooding"),
    ];

    #[test]
    fn rewritten_headlines_about_one_story_cluster() {
        // The live-run defect, pinned. At a fixed SHINGLE_MAX these four shared no eight consecutive
        // words and were reported as four independent sources.
        let arts: Vec<_> = NEPAL
            .iter()
            .enumerate()
            .map(|(i, (o, t))| av(&format!("{o}/1"), o, 100 + i as i64 * 10, t, ""))
            .collect();
        let c = corroborate(&arts, &kinds());
        assert!(
            c.independent_sources < 4,
            "four rewrites of one story must not read as four independent sources (got {})",
            c.independent_sources
        );
        assert!(c.echoes >= 1, "at least one of them is visibly a reprint");
    }

    #[test]
    fn a_wider_shingle_would_have_missed_that_cascade() {
        // Proves the fix is the ADAPTIVE WIDTH and not some other change: at the old fixed width the
        // same four headlines share nothing. If this ever passes, the width stopped adapting.
        let texts: Vec<Vec<String>> = NEPAL.iter().map(|(_, t)| words(t)).collect();
        let fixed: Vec<_> = texts.iter().map(|w| shingles(w, SHINGLE_MAX)).collect();
        for i in 0..fixed.len() {
            for j in (i + 1)..fixed.len() {
                assert!(
                    containment(&fixed[i], &fixed[j]) < THRESHOLD,
                    "at the fixed width these headlines were invisible to each other — that is the bug"
                );
            }
        }
    }

    #[test]
    fn unrelated_headlines_stay_in_separate_lineages() {
        // The guard in the OTHER direction, and the one that matters: a width chosen to find
        // cascades will find them everywhere unless the negative case is pinned. These are real
        // same-day headlines from the live poll that share nothing but their register.
        let heads = [
            ("bbc", "Why Nepal floods should worry India"),
            ("tass", "Russians trust in Putin exceeds 72% — pollster"),
            ("guardian", "Pocock says skilled migrants should be top priority as Australia faces shortage"),
            ("meduza", "Germany begins mass production of attack drones for Ukraine"),
            ("rt", "Putin meets Xi and Modi at SCO summit: As it happened"),
        ];
        let arts: Vec<_> = heads
            .iter()
            .enumerate()
            .map(|(i, (o, t))| av(&format!("{o}/1"), o, 100 + i as i64, t, ""))
            .collect();
        let c = corroborate(&arts, &kinds());
        assert_eq!(c.independent_sources, 5, "five unrelated stories are five sources");
        assert_eq!(c.echoes, 0);
    }

    #[test]
    fn the_width_scales_with_the_shorter_text() {
        assert_eq!(shingle_width(10, 200), SHINGLE_MIN, "a headline bounds the comparison");
        assert_eq!(shingle_width(200, 200), SHINGLE_MAX, "two bodies get the full window");
        assert_eq!(shingle_width(0, 0), SHINGLE_MIN, "an empty text cannot go below the floor");
        // Monotonic, so there is no length at which lengthening a text narrows the window.
        let mut last = 0;
        for n in 0..300 {
            let w = shingle_width(n, n);
            assert!(w >= last, "width must not shrink as texts grow");
            last = w;
        }
    }

    #[test]
    fn the_basis_says_whether_body_text_was_available() {
        let long = "Officials said two people were killed and eleven wounded when a missile hit the \
                    southern port early on Thursday, according to the emergency service, which added \
                    that rescue teams were still searching the site late into the evening.";
        let bodies = vec![av("a", "ap", 100, "T", long), av("b", "bbc", 200, "T", long)];
        assert_eq!(corroborate(&bodies, &kinds()).basis, Basis::BodyText);

        let heads = vec![av("a", "ap", 100, "Short headline only", ""), av("b", "bbc", 200, "Another headline", "")];
        assert_eq!(
            corroborate(&heads, &kinds()).basis,
            Basis::HeadlineOnly,
            "half the roster ships news sitemaps with no summary, and the reader must be told"
        );
    }

    #[test]
    fn an_empty_set_is_zero_sources_not_a_panic() {
        let c = corroborate(&[], &kinds());
        assert_eq!(c.independent_sources, 0);
        assert_eq!(c.articles, 0);
        assert!(c.lineages.is_empty());
    }

    #[test]
    fn output_is_deterministic_regardless_of_input_order() {
        let a = av("ap/1", "ap", 100, "Strike on port", WIRE);
        let b = av("bbc/1", "bbc", 140, "Port strike", WIRE);
        let one = corroborate(&[a.clone(), b.clone()], &kinds());
        let two = corroborate(&[b, a], &kinds());
        assert_eq!(one, two, "a digest that reorders between runs cannot be diffed against itself");
    }
}
