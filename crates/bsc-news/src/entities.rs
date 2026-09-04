//! Who, where and what — extracting people, places and circumstances from stored headlines.
//!
//! No model runs here either. Places and circumstances come from [`crate::gazetteer`]; people come
//! from proper-noun runs plus the three cues news copy actually uses — a preceding role
//! (`President`, `spokesman`), a following attribution verb (`X said`), and the wire's em-dash
//! byline (`… — Zelensky`, which is TASS house style and constant in the corpus).
//!
//! Two traps, both found in real data rather than imagined:
//!
//! **Title Case destroys the capitalization signal.** AP ships headlines like *"Ex-Deputy Convicted
//! of Assaulting Women Out at Christian Group"*. A naive extractor reports `Convicted`, `Assaulting`
//! and `Christian Group` as people. So case style is detected per headline, and a Title Case one
//! falls back to gazetteer matching only.
//!
//! **A sentence-initial capital is not a name.** *"Vance says"* and *"Teen says"* are the same
//! shape. The discriminator is learned from the corpus rather than hand-listed: a token that appears
//! **lowercase anywhere** in the store is not a name — `teen` does, `Vance` does not. That adapts as
//! the roster grows and encodes nobody's opinion about which words are names.

use crate::gazetteer::{CIRCUMSTANCES, PLACES};
use crate::types::ArticleVersion;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// What kind of thing a mention is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A proper-noun run confirmed by a role, attribution or byline cue — very likely a person.
    Person,
    /// An unconfirmed proper-noun run. Often a person, but also organisations, products and events
    /// (`Venice Film Festival`). Kept distinct rather than guessed at, and `--person` matches both.
    Name,
    /// A gazetteer place.
    Place,
    /// A gazetteer circumstance.
    Circumstance,
}

/// One extracted mention.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mention {
    pub kind: Kind,
    /// Canonical key — the gazetteer key for a place/circumstance, the lowercased surface otherwise.
    pub key: String,
    /// The text as it appeared.
    pub surface: String,
    pub url: String,
    pub outlet_id: String,
    pub start: usize,
    pub end: usize,
    /// Which cue promoted a [`Kind::Name`] to a [`Kind::Person`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cue: Option<String>,
}

/// Role words that precede a name.
const ROLES: &[&str] = &[
    "president", "vice", "prime", "deputy", "foreign", "defense", "defence", "premier", "chancellor", "minister", "ministers", "secretary", "senator", "sen", "rep",
    "representative", "governor", "mayor", "ambassador", "envoy", "spokesman", "spokeswoman", "spokesperson",
    "general", "colonel", "admiral", "chief", "commander", "director", "chairman", "ceo", "dr", "prof", "professor",
    "judge", "justice", "prosecutor", "pope", "king", "queen", "prince", "princess", "sheikh", "imam", "rabbi",
    "coach", "captain", "leader", "candidate", "lawmaker", "adviser", "advisor", "analyst", "official",
];

/// Verbs that follow a source's name.
const ATTRIBUTION: &[&str] = &["said", "says", "told", "tells", "warned", "warns", "denied", "denies", "claimed", "claims", "announced", "announces", "insists", "insisted", "adds", "added"];

/// Calendar words. Capitalized always and lowercase never, so the corpus discriminator cannot
/// reject them — but they are a genuinely CLOSED class, which is what makes a hardcoded list honest
/// here where a general stopword list would just be someone's opinion about which words are names.
const CALENDAR: &[&str] = &[
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march",
    "april", "may", "june", "july", "august", "september", "october", "november", "december",
];

/// A Name in at least this share of ONE outlet's articles, and in no other outlet, is that outlet's
/// feed furniture rather than an entity — `rt.com` and `read full article` appeared in 99 and 78
/// articles from a single source. Content varies across an outlet's stories; a template does not.
const BOILERPLATE_SHARE: f64 = 0.4;

/// Above this share of capitalized words, a headline is Title Case and capitalization tells us
/// nothing. Measured across the live roster, ordinary sentence-case headlines run 0.19-0.37.
const TITLE_CASE_RATIO: f64 = 0.7;

/// Corpus-derived evidence for telling names from sentence-initial common nouns.
#[derive(Debug, Default, Clone)]
pub struct Lexis {
    ever_lowercase: BTreeSet<String>,
}

impl Lexis {
    /// Learn from the corpus: which tokens are ever written lowercase.
    ///
    /// **Must be fed the same text [`extract`] reads.** Built over titles alone while extraction ran
    /// over title+summary, `according` never appeared lowercase in the evidence and was promoted to
    /// a person fifteen times. Use [`Lexis::from_articles`] rather than assembling this by hand.
    pub fn from_corpus<'a>(texts: impl IntoIterator<Item = &'a str>) -> Lexis {
        let mut ever_lowercase = BTreeSet::new();
        for t in texts {
            for tok in tokens(t) {
                if tok.word.chars().next().is_some_and(|c| c.is_lowercase()) {
                    ever_lowercase.insert(tok.word.to_lowercase());
                }
            }
        }
        Lexis { ever_lowercase }
    }

    /// Learn from articles, over exactly the text [`extract`] will read. The right constructor.
    pub fn from_articles(articles: &[ArticleVersion]) -> Lexis {
        let texts: Vec<String> = articles.iter().map(|a| a.text()).collect();
        Lexis::from_corpus(texts.iter().map(String::as_str))
    }

    /// Could this token be a name? A word seen lowercase somewhere is a common noun, and a calendar
    /// word never is one.
    pub fn plausible_name(&self, word: &str) -> bool {
        let w = word.to_lowercase();
        !self.ever_lowercase.contains(&w) && !CALENDAR.contains(&w.as_str())
    }
}

struct Tok {
    word: String,
    start: usize,
    end: usize,
}

/// Split into word tokens with byte offsets, keeping internal apostrophes and hyphens.
fn tokens(text: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in text.char_indices() {
        let wordish = c.is_alphanumeric() || c == '\'' || c == '\u{2019}' || c == '-' || c == '.';
        if wordish {
            start.get_or_insert(i);
        } else if let Some(s) = start.take() {
            push(&mut out, text, s, i);
        }
    }
    if let Some(s) = start {
        push(&mut out, text, s, text.len());
    }
    out
}

fn push(out: &mut Vec<Tok>, text: &str, s: usize, e: usize) {
    let w = text[s..e].trim_matches(|c: char| c == '.' || c == '-' || c == '\'' || c == '\u{2019}');
    if !w.is_empty() {
        let off = text[s..e].find(w).unwrap_or(0);
        out.push(Tok { word: w.to_string(), start: s + off, end: s + off + w.len() });
    }
}

/// Canonical form of a name: lowercased, with a trailing possessive removed.
pub fn normalize_key(surface: &str) -> String {
    let k = surface.to_lowercase();
    k.trim_end_matches("'s")
        .trim_end_matches("\u{2019}s")
        .trim_end_matches(['\'', '\u{2019}', '.'])
        .trim()
        .to_string()
}

fn is_capitalized(w: &str) -> bool {
    w.chars().next().is_some_and(|c| c.is_uppercase())
}

/// Is this headline Title Case, i.e. is capitalization uninformative?
pub fn is_title_case(text: &str) -> bool {
    let toks = tokens(text);
    // The first token is capitalized in BOTH styles, so it carries no information and is skipped.
    // Short words are skipped too: Title Case leaves `of`, `at` and `the` lowercase by convention,
    // so counting them would drag every Title Case headline back under the threshold.
    let considered: Vec<&Tok> = toks
        .iter()
        .skip(1)
        .filter(|t| t.word.len() > 3 && t.word.chars().next().is_some_and(char::is_alphabetic))
        .collect();
    if considered.len() < 4 {
        // Too short to judge; treat as sentence case so the extractor still works on it.
        return false;
    }
    let caps = considered.iter().filter(|t| is_capitalized(&t.word)).count();
    caps as f64 / considered.len() as f64 >= TITLE_CASE_RATIO
}

/// Longest-form gazetteer matching over the lowercased text.
fn gazetteer_mentions(article: &ArticleVersion, text: &str) -> Vec<Mention> {
    let lower = text.to_lowercase();
    let mut out = Vec::new();
    let hit = |kind: Kind, key: &str, forms: &[&str], out: &mut Vec<Mention>| {
        // Longest form first so `hong kong` wins over any shorter substring.
        let mut sorted: Vec<&&str> = forms.iter().collect();
        sorted.sort_by_key(|f| std::cmp::Reverse(f.len()));
        for form in sorted {
            let mut from = 0usize;
            while let Some(rel) = lower[from..].find(*form) {
                let (s, e) = (from + rel, from + rel + form.len());
                let before_ok = s == 0 || !lower[..s].chars().next_back().is_some_and(|c| c.is_alphanumeric());
                let after_ok = e >= lower.len() || !lower[e..].chars().next().is_some_and(|c| c.is_alphanumeric());
                // Do not report the same characters twice under two forms of the same entry.
                let overlaps = out.iter().any(|m: &Mention| m.kind == kind && m.start < e && s < m.end);
                if before_ok && after_ok && !overlaps {
                    out.push(Mention {
                        kind,
                        key: key.to_string(),
                        surface: text[s..e].to_string(),
                        url: article.url.clone(),
                        outlet_id: article.outlet_id.clone(),
                        start: s,
                        end: e,
                        cue: None,
                    });
                }
                from = e.max(s + 1);
                if from >= lower.len() {
                    break;
                }
            }
        }
    };
    for p in PLACES {
        hit(Kind::Place, p.key, p.forms, &mut out);
    }
    for c in CIRCUMSTANCES {
        hit(Kind::Circumstance, c.key, c.forms, &mut out);
    }
    out
}

/// Extract every mention from one article.
pub fn extract(article: &ArticleVersion, lexis: &Lexis) -> Vec<Mention> {
    let text = article.text();
    let mut out = gazetteer_mentions(article, &text);

    // Title Case: capitalization carries no information, so proper-noun runs are not attempted.
    // The gazetteer still works, because it matches words rather than shapes.
    if is_title_case(&text) {
        return out;
    }

    let toks = tokens(&text);
    // Normalized on BOTH sides: the tokenizer strips trailing dots (`U.S.` → `U.S`) and keeps
    // possessives (`Russia’s`), so a raw comparison misses places it already knows and reports them
    // as names instead.
    let place_words: BTreeSet<String> =
        PLACES.iter().flat_map(|p| p.forms.iter()).flat_map(|f| f.split(' ')).map(normalize_key).collect();

    let mut i = 0usize;
    while i < toks.len() {
        if !is_capitalized(&toks[i].word) || !toks[i].word.chars().next().is_some_and(char::is_alphabetic) {
            i += 1;
            continue;
        }
        // Gather the run of capitalized tokens. **A run must not cross punctuation**: in
        // `… in central Kiev — Zelensky` the em-dash is not a token, so without this check `Kiev`
        // and `Zelensky` are adjacent in the token list and merge into one bogus name.
        let mut j = i;
        while j < toks.len()
            && is_capitalized(&toks[j].word)
            && toks[j].word.chars().next().is_some_and(char::is_alphabetic)
            && (j == i || text[toks[j - 1].end..toks[j].start].chars().all(char::is_whitespace))
        {
            j += 1;
        }

        // Trim leading tokens that qualify the name rather than being it: a demonym
        // (`Spanish Prime Minister Pedro Sánchez`) and then any role words, which double as the cue.
        let mut k = i;
        while k < j && place_words.contains(&normalize_key(&toks[k].word)) {
            k += 1;
        }
        let mut role_cue = None;
        while k < j && ROLES.contains(&toks[k].word.to_lowercase().trim_end_matches('.')) {
            role_cue = Some(format!("role:{}", toks[k].word.to_lowercase()));
            k += 1;
        }
        if k >= j {
            // The whole run was qualifiers; the place half is already reported by the gazetteer.
            i = j.max(i + 1);
            continue;
        }
        let run = &toks[k..j];
        // A run that is a known place is already reported as one.
        let all_place = run.iter().all(|t| place_words.contains(&normalize_key(&t.word)));
        // The sentence-initial trap: a single leading capitalized token is only a name if the corpus
        // never writes it lowercase.
        let initial_only = k == 0 && run.len() == 1;
        let plausible = run.iter().any(|t| lexis.plausible_name(&t.word));
        if !all_place && !(initial_only && !plausible) && plausible && run.len() <= 4 {
            let (s, e) = (run[0].start, run[run.len() - 1].end);
            let surface = text[s..e].to_string();
            // Cues, checked in the order they appear in copy.
            let cue = if role_cue.is_some() {
                role_cue
            } else if k > 0 && ROLES.contains(&toks[k - 1].word.to_lowercase().trim_end_matches('.')) {
                Some(format!("role:{}", toks[k - 1].word.to_lowercase()))
            } else if j < toks.len() && ATTRIBUTION.contains(&toks[j].word.to_lowercase().as_str()) {
                Some(format!("attribution:{}", toks[j].word.to_lowercase()))
            } else if k > 0 && text[..s].trim_end().ends_with(['—', '–']) && j >= toks.len() {
                Some("byline:em-dash".to_string())
            } else {
                None
            };
            out.push(Mention {
                kind: if cue.is_some() { Kind::Person } else { Kind::Name },
                // Normalize the possessive so `Russia’s` and `Russia` are one entity, not two.
                key: normalize_key(&surface),
                surface,
                url: article.url.clone(),
                outlet_id: article.outlet_id.clone(),
                start: s,
                end: e,
                cue,
            });
        }
        i = j.max(i + 1);
    }
    out
}

/// One row of the discovery index.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entity {
    pub kind: Kind,
    pub key: String,
    /// The most common surface form, for display.
    pub surface: String,
    /// How many articles mention it.
    pub articles: usize,
    /// How many distinct outlets mention it — the number that separates a real story from one
    /// outlet's obsession.
    pub outlets: usize,
    /// True when at least one mention was cue-confirmed as a person.
    pub confirmed: bool,
}

/// What one (kind, key) has accumulated while the index is being built: surface forms and their
/// counts, the URLs and outlets it appeared in, and whether any mention was cue-confirmed.
#[derive(Default)]
struct Agg {
    surfaces: BTreeMap<String, usize>,
    urls: BTreeSet<String>,
    outlets: BTreeSet<String>,
    confirmed: bool,
}

/// Rank what is actually in the corpus, so a filter is reachable without knowing the name first.
pub fn index(articles: &[ArticleVersion]) -> Vec<Entity> {
    let lexis = Lexis::from_articles(articles);
    // How many articles each outlet contributed, so a name's share of ONE outlet is measurable.
    let mut per_outlet: BTreeMap<String, usize> = BTreeMap::new();
    for a in articles {
        *per_outlet.entry(a.outlet_id.clone()).or_insert(0) += 1;
    }
    let mut agg: BTreeMap<(Kind, String), Agg> = BTreeMap::new();
    for a in articles {
        for m in extract(a, &lexis) {
            // Person and Name share a key space so a cue on one day does not split the tally.
            let kind = if m.kind == Kind::Person { Kind::Name } else { m.kind };
            let e = agg.entry((kind, m.key.clone())).or_default();
            *e.surfaces.entry(m.surface.clone()).or_insert(0) += 1;
            e.urls.insert(m.url.clone());
            e.outlets.insert(m.outlet_id.clone());
            e.confirmed |= m.cue.is_some();
        }
    }
    let mut rows: Vec<Entity> = agg
        .into_iter()
        .filter(|((kind, _), a)| {
            // Drop one outlet's feed furniture. A name confined to a SINGLE outlet and appearing in
            // a large share of that outlet's articles is a template, not something anyone reported:
            // `rt.com` and `read full article` were in 99 and 78 articles from one source, above
            // every real name in the index. Content varies across an outlet's stories; a template
            // does not. Places and circumstances are exempt — they come from a curated gazetteer, so
            // they cannot be boilerplate by construction.
            if matches!(kind, Kind::Place | Kind::Circumstance) || a.outlets.len() != 1 {
                return true;
            }
            let sole = a.outlets.iter().next().expect("exactly one outlet");
            let total = per_outlet.get(sole).copied().unwrap_or(0).max(1);
            (a.urls.len() as f64 / total as f64) < BOILERPLATE_SHARE
        })
        .map(|((kind, key), a)| Entity {
            kind: if kind == Kind::Name && a.confirmed { Kind::Person } else { kind },
            key,
            surface: a.surfaces.iter().max_by_key(|(_, n)| **n).map(|(s, _)| s.clone()).unwrap_or_default(),
            articles: a.urls.len(),
            outlets: a.outlets.len(),
            confirmed: a.confirmed,
        })
        .collect();
    // Most-covered first; outlet breadth breaks ties, because a thing five outlets mention is a
    // better filter candidate than one thing one outlet mentioned five times.
    rows.sort_by(|a, b| {
        b.articles.cmp(&a.articles).then_with(|| b.outlets.cmp(&a.outlets)).then_with(|| a.key.cmp(&b.key))
    });
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn av(outlet: &str, title: &str) -> ArticleVersion {
        ArticleVersion {
            url: format!("{outlet}/{}", title.len()),
            outlet_id: outlet.into(),
            seq: 1,
            fetched_at: 0,
            published_claim: None,
            title: title.into(),
            summary: String::new(),
        }
    }

    /// Real headlines from the 2026-09-04 live poll.
    fn corpus() -> Vec<ArticleVersion> {
        vec![
            av("tass", "Explosion rocks Ukrainian Security Service headquarters in central Kiev — Zelensky"),
            av("tass", "Russians’ trust in Putin exceeds 72% — pollster"),
            av("fox", "Vance says Iran fight isn’t a ‘war,’ dramatic rescue in Nepal"),
            av("ap", "Spanish Prime Minister Pedro Sánchez struggles to answer lawmaker questions about Ceuta crisis"),
            av("ap", "Ex-Deputy Convicted of Assaulting Women Out at Christian Group"),
            av("scmp", "2 trapped workers rescued alive from Nepal tunnel 9 days after floods"),
            av("bbc", "Teen says 'demon' made him fatally stab his girlfriend"),
            av("guardian", "Two workers pulled alive from tunnel nine days after Nepal-Tibet floods"),
        ]
    }

    fn lexis() -> Lexis {
        Lexis::from_corpus(corpus().iter().map(|a| a.title.as_str()).collect::<Vec<_>>())
    }

    #[test]
    fn a_place_matches_its_country_demonym_and_city() {
        let l = lexis();
        let keys = |t: &str| -> BTreeSet<String> {
            extract(&av("x", t), &l).into_iter().filter(|m| m.kind == Kind::Place).map(|m| m.key).collect()
        };
        assert!(keys("Fighting in Russia").contains("russia"));
        assert!(keys("Russian forces advanced").contains("russia"), "the demonym must match");
        assert!(keys("Talks in Moscow").contains("russia"), "a major city resolves to its country");
    }

    #[test]
    fn a_title_case_headline_does_not_manufacture_people() {
        // The AP row in the fixture. Without the guard this yields Convicted, Assaulting, Women and
        // Christian Group as names.
        let title = "Ex-Deputy Convicted of Assaulting Women Out at Christian Group";
        assert!(is_title_case(title), "this really is Title Case");
        let names: Vec<_> =
            extract(&av("ap", title), &lexis()).into_iter().filter(|m| matches!(m.kind, Kind::Person | Kind::Name)).collect();
        assert!(names.is_empty(), "Title Case carries no capitalization signal, so no names: {names:?}");
    }

    #[test]
    fn an_ordinary_headline_is_not_mistaken_for_title_case() {
        for t in [
            "2 trapped workers rescued alive from Nepal tunnel 9 days after floods",
            "Explosion rocks Ukrainian Security Service headquarters in central Kiev — Zelensky",
        ] {
            assert!(!is_title_case(t), "sentence case must stay usable: {t}");
        }
    }

    #[test]
    fn an_attribution_verb_confirms_a_person() {
        let m = extract(&av("fox", "Vance says Iran fight isn’t a ‘war,’ dramatic rescue in Nepal"), &lexis());
        let vance = m.iter().find(|m| m.key.starts_with("vance")).expect("Vance is extracted");
        assert_eq!(vance.kind, Kind::Person);
        assert_eq!(vance.cue.as_deref(), Some("attribution:says"));
    }

    #[test]
    fn a_sentence_initial_common_noun_is_not_a_person() {
        // `Teen says` has exactly the shape of `Vance says`. The corpus is the discriminator: `teen`
        // appears lowercase elsewhere, `Vance` never does.
        let l = Lexis::from_corpus(
            corpus().iter().map(|a| a.title.as_str()).chain(["a teen was arrested"]).collect::<Vec<_>>(),
        );
        let m = extract(&av("bbc", "Teen says 'demon' made him fatally stab his girlfriend"), &l);
        assert!(
            !m.iter().any(|m| m.key == "teen"),
            "a word the corpus writes lowercase is a common noun, not a name"
        );
    }

    #[test]
    fn a_role_prefix_confirms_a_person() {
        let m = extract(
            &av("ap", "Spanish Prime Minister Pedro Sánchez struggles to answer lawmaker questions about Ceuta crisis"),
            &lexis(),
        );
        let p = m.iter().find(|m| m.surface.contains("Pedro")).expect("Pedro Sánchez is extracted");
        assert_eq!(p.kind, Kind::Person);
        assert!(p.cue.as_deref().unwrap_or("").starts_with("role:"));
    }

    #[test]
    fn an_em_dash_byline_confirms_the_wire_source() {
        // TASS house style, and constant in the corpus.
        let m = extract(&av("tass", "Russians’ trust in Putin exceeds 72% — pollster"), &lexis());
        assert!(m.iter().any(|m| m.key == "putin"), "Putin is extracted from the body of the headline");
        let m2 = extract(
            &av("tass", "Explosion rocks Ukrainian Security Service headquarters in central Kiev — Zelensky"),
            &lexis(),
        );
        let z = m2.iter().find(|m| m.key == "zelensky").expect("the byline tail is extracted");
        assert_eq!(z.kind, Kind::Person);
        assert_eq!(z.cue.as_deref(), Some("byline:em-dash"));
    }

    #[test]
    fn a_name_run_does_not_cross_punctuation() {
        // The em-dash is not a token, so `Kiev` and `Zelensky` are ADJACENT in the token list and
        // used to merge into one bogus name. Punctuation between two tokens ends the run.
        let m = extract(
            &av("tass", "Explosion rocks Ukrainian Security Service headquarters in central Kiev — Zelensky"),
            &lexis(),
        );
        assert!(
            !m.iter().any(|m| m.key.contains("kiev zelensky")),
            "a run must not span the em-dash: {:?}",
            m.iter().map(|m| &m.key).collect::<Vec<_>>()
        );
        assert!(m.iter().any(|m| m.key == "zelensky"));
    }

    #[test]
    fn a_demonym_and_role_prefix_are_trimmed_off_the_name() {
        // `Spanish Prime Minister Pedro Sánchez` is one capitalized run five tokens long. Untrimmed
        // it exceeds the run cap and no name is extracted at all.
        let m = extract(
            &av("ap", "Spanish Prime Minister Pedro Sánchez struggles to answer lawmaker questions about Ceuta crisis"),
            &lexis(),
        );
        let p = m.iter().find(|m| m.kind == Kind::Person).expect("a person survives the trim");
        assert_eq!(p.surface, "Pedro Sánchez", "the demonym and the role are qualifiers, not the name");
        assert!(m.iter().any(|m| m.kind == Kind::Place && m.key == "spain"), "the demonym is still a place");
    }

    #[test]
    fn circumstances_are_found_by_family_words() {
        let l = lexis();
        let keys = |t: &str| -> BTreeSet<String> {
            extract(&av("x", t), &l).into_iter().filter(|m| m.kind == Kind::Circumstance).map(|m| m.key).collect()
        };
        assert!(keys("Nepal floods kill hundreds").contains("flood"));
        assert!(keys("Two workers pulled alive from tunnel nine days after floods").contains("flood"));
        assert!(keys("Court convicted the former mayor").contains("trial"));
    }

    #[test]
    fn every_mention_offset_resolves_to_its_own_surface() {
        let l = lexis();
        for a in corpus() {
            let text = a.text();
            for m in extract(&a, &l) {
                assert_eq!(&text[m.start..m.end], m.surface, "an offset that does not resolve is not evidence");
            }
        }
    }

    #[test]
    fn the_index_ranks_by_coverage_and_counts_outlets() {
        let rows = index(&corpus());
        let nepal = rows.iter().find(|r| r.key == "nepal").expect("nepal is in the corpus");
        assert_eq!(nepal.kind, Kind::Place);
        assert!(nepal.outlets >= 3, "four outlets ran Nepal; breadth is what makes it a good filter");
        // Ranking is by article count, so the most-covered thing is reachable first.
        let counts: Vec<usize> = rows.iter().map(|r| r.articles).collect();
        assert!(counts.windows(2).all(|w| w[0] >= w[1]), "the index must be sorted most-covered first");
    }

    #[test]
    fn one_outlets_feed_furniture_is_dropped_from_the_index() {
        // `rt.com` appeared in 99 of RT's articles and nowhere else, above every real name. A name
        // confined to one outlet across most of its output is a template, not an entity.
        let mut arts: Vec<ArticleVersion> = (0..10)
            .map(|i| {
                let mut a = av("rt", &format!("Ukraine story number {i} of the day"));
                a.summary = "Boilerplate Sentinel — read the rest at the site".into();
                a.url = format!("rt/{i}");
                a
            })
            .collect();
        arts.push(av("bbc", "A different story entirely about Nepal"));
        let rows = index(&arts);
        assert!(
            !rows.iter().any(|r| r.key == "boilerplate sentinel"),
            "furniture in most of one outlet's articles must not outrank real names: {:?}",
            rows.iter().map(|r| &r.key).collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_name_in_several_outlets_survives_however_common() {
        // The guard in the other direction — the boilerplate rule must never reach a real story.
        let arts: Vec<ArticleVersion> = ["ap", "bbc", "rt", "tass"]
            .iter()
            .enumerate()
            .map(|(i, o)| {
                let mut a = av(o, "Zelensky addressed the assembly");
                a.url = format!("{o}/{i}");
                a
            })
            .collect();
        let rows = index(&arts);
        assert!(rows.iter().any(|r| r.key == "zelensky"), "a name four outlets used is not boilerplate");
    }

    #[test]
    fn a_possessive_or_dotted_place_is_still_a_place_not_a_name() {
        // The tokenizer strips trailing dots and keeps possessives, so `Russia’s` and `U.S.` used to
        // miss the place table and be reported as names — `russia` ranked 2nd in the people index.
        let l = lexis();
        for (text, key) in [("Russia’s economy slowed", "russia"), ("The U.S. said little", "united-states")] {
            let m = extract(&av("x", text), &l);
            assert!(m.iter().any(|x| x.kind == Kind::Place && x.key == key), "{text} should resolve to {key}");
            assert!(
                !m.iter().any(|x| matches!(x.kind, Kind::Person | Kind::Name) && x.key.contains(&key[..6])),
                "{text} must not ALSO be reported as a name"
            );
        }
    }

    #[test]
    fn calendar_words_are_not_names() {
        // `Friday` is capitalized always and lowercase never, so the corpus discriminator cannot
        // reject it — it outranked Putin in the live index.
        let arts = vec![av("bbc", "Friday brought fresh talks in Geneva"), av("ap", "September ended quietly")];
        let rows = index(&arts);
        for bad in ["friday", "september"] {
            assert!(!rows.iter().any(|r| r.key == bad), "{bad} is a calendar word, not a name");
        }
    }

    #[test]
    fn the_lexis_reads_the_same_text_extraction_does() {
        // Built over titles alone while extract() ran over title+summary, `according` never appeared
        // lowercase in the evidence and was promoted to a cue-confirmed person fifteen times.
        let mut a = av("bbc", "According to officials the bridge reopened");
        a.summary = "The ministry said the closure ended, according to officials.".into();
        let lexis = Lexis::from_articles(std::slice::from_ref(&a));
        assert!(
            !lexis.plausible_name("According"),
            "a word the SUMMARY writes lowercase is a common noun, and the summary is text we read"
        );
        assert!(!extract(&a, &lexis).iter().any(|m| m.key == "according"));
    }

    #[test]
    fn a_possessive_is_the_same_entity_as_the_bare_name() {
        assert_eq!(normalize_key("Russia’s"), "russia");
        assert_eq!(normalize_key("Zelenskyy's"), "zelenskyy");
        assert_eq!(normalize_key("Putin"), "putin");
    }

    #[test]
    fn an_empty_corpus_indexes_to_nothing_rather_than_panicking() {
        assert!(index(&[]).is_empty());
        assert!(extract(&av("x", ""), &Lexis::default()).is_empty());
    }
}
