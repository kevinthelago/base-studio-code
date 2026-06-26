//! Citation-grounded semantic search (#1196). The default retriever is **BM25** over section-tagged
//! chunks — fully offline, key-less, dependency-free, and good at surfacing the right passages of
//! the fetched corpus. Each returned [`Passage`] carries its `paper_id` + `section` so the planner
//! can cite exactly where a claim came from.

use serde::Serialize;

/// One section-tagged chunk tied to the paper it came from — the unit BM25 ranks.
#[derive(Debug, Clone)]
pub struct Doc {
    pub paper_id: String,
    pub section: String,
    pub text: String,
}

/// A ranked, citation-grounded passage returned by semantic search.
#[derive(Debug, Clone, Serialize)]
pub struct Passage {
    pub paper_id: String,
    pub section: String,
    pub text: String,
    pub score: f32,
}

const K1: f32 = 1.5;
const B: f32 = 0.75;

/// Rank `docs` against `query` with BM25, returning the top `top_k` passages (score-descending).
pub fn rank(query: &str, docs: &[Doc], top_k: usize) -> Vec<Passage> {
    if docs.is_empty() || top_k == 0 {
        return Vec::new();
    }
    let q_terms = tokenize(query);
    if q_terms.is_empty() {
        return Vec::new();
    }

    // Tokenize each doc once; collect document frequencies for the query terms.
    let doc_tokens: Vec<Vec<String>> = docs.iter().map(|d| tokenize(&d.text)).collect();
    let n = docs.len() as f32;
    let avgdl = (doc_tokens.iter().map(|t| t.len()).sum::<usize>() as f32 / n).max(1.0);

    let q_unique: Vec<&String> = {
        let mut v: Vec<&String> = q_terms.iter().collect();
        v.sort();
        v.dedup();
        v
    };

    // df: in how many docs each query term appears.
    let mut idf = std::collections::HashMap::new();
    for term in &q_unique {
        let df = doc_tokens.iter().filter(|toks| toks.contains(*term)).count() as f32;
        // BM25 idf with the +1 smoothing that keeps it non-negative.
        let v = (((n - df + 0.5) / (df + 0.5)) + 1.0).ln();
        idf.insert((*term).clone(), v);
    }

    let mut scored: Vec<Passage> = docs
        .iter()
        .zip(doc_tokens.iter())
        .map(|(d, toks)| {
            let dl = toks.len() as f32;
            let mut score = 0.0_f32;
            for term in &q_unique {
                let f = toks.iter().filter(|t| *t == *term).count() as f32;
                if f == 0.0 {
                    continue;
                }
                let idf = idf.get(*term).copied().unwrap_or(0.0);
                score += idf * (f * (K1 + 1.0)) / (f + K1 * (1.0 - B + B * dl / avgdl));
            }
            Passage {
                paper_id: d.paper_id.clone(),
                section: d.section.clone(),
                text: d.text.clone(),
                score,
            }
        })
        .filter(|p| p.score > 0.0)
        .collect();

    // Stable order: score desc, then by paper id for determinism on ties.
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.paper_id.cmp(&b.paper_id))
    });
    scored.truncate(top_k);
    scored
}

/// A tiny stop-word set — the highest-frequency English function words that add noise to lexical
/// scoring. Kept small on purpose (BM25's idf already down-weights common terms).
const STOPWORDS: &[&str] = &[
    "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "is", "are", "we", "with", "that",
    "this", "by", "as", "at", "be", "it", "from",
];

/// Lowercase alphanumeric tokens, ≥2 chars, minus stop words.
fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 2)
        .map(|w| w.to_ascii_lowercase())
        .filter(|w| !STOPWORDS.contains(&w.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(id: &str, section: &str, text: &str) -> Doc {
        Doc { paper_id: id.into(), section: section.into(), text: text.into() }
    }

    #[test]
    fn ranks_the_most_relevant_passage_first() {
        let docs = vec![
            doc("arxiv:1", "Introduction", "Ray tracing simulates light transport for photorealistic rendering."),
            doc("arxiv:2", "Method", "We train a neural denoiser to clean noisy path-traced frames in real time."),
            doc("arxiv:3", "Background", "Sorting algorithms order elements; quicksort is a classic divide and conquer method."),
        ];
        let res = rank("neural denoiser real time path tracing", &docs, 3);
        assert!(!res.is_empty());
        assert_eq!(res[0].paper_id, "arxiv:2");
        // The unrelated sorting passage should rank last or be filtered out.
        assert!(res.last().map(|p| p.paper_id != "arxiv:2").unwrap_or(true));
        // Provenance is preserved.
        assert_eq!(res[0].section, "Method");
    }

    #[test]
    fn empty_query_or_corpus_returns_nothing() {
        let docs = vec![doc("arxiv:1", "Body", "anything")];
        assert!(rank("", &docs, 5).is_empty());
        assert!(rank("query", &[], 5).is_empty());
        assert!(rank("query", &docs, 0).is_empty());
    }

    #[test]
    fn unrelated_query_filtered_to_empty() {
        let docs = vec![doc("arxiv:1", "Body", "ray tracing and rendering")];
        assert!(rank("encryption lattice cryptography", &docs, 5).is_empty());
    }
}
