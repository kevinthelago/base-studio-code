//! The research engine (#1196) — wires [`crate::http`] + [`crate::cache`] + [`crate::sources`] +
//! [`crate::pdf`] + [`crate::search`] into the five operations the MCP server exposes:
//! `search`, `get_paper`, `get_fulltext`, `get_references`, `semantic_search`. The cache is a pure
//! optimization (every miss falls through to the network), so a missing/locked cache never breaks a
//! call.

use crate::cache::Cache;
use crate::http::Http;
use crate::pdf;
use crate::search::{self, Doc, Passage};
use crate::sources;
use crate::types::{Paper, Reference, SearchQuery};

pub struct Engine {
    http: Http,
    cache: Option<Cache>,
}

impl Engine {
    /// Build the engine from the environment (HTTP credentials + the default cache path). A cache
    /// that fails to open is simply disabled — the engine still works, just without memoization.
    pub fn from_env() -> Result<Engine, String> {
        let http = Http::from_env()?;
        let cache = Cache::default_path().and_then(|p| Cache::open(&p).ok());
        Ok(Engine { http, cache })
    }

    /// Search across the query's effective sources, dedupe, and cache each record. A failing source
    /// is logged to stderr and skipped so one flaky upstream can't fail the whole fan-out.
    pub fn search(&self, query: &SearchQuery) -> Vec<Paper> {
        let mut papers = Vec::new();
        for source in query.effective_sources() {
            match sources::search_source(&self.http, source, query) {
                Ok(mut ps) => papers.append(&mut ps),
                Err(e) => eprintln!("research: {} search failed: {e}", source.as_str()),
            }
        }
        dedup_papers(&mut papers);
        if let Some(c) = &self.cache {
            for p in &papers {
                let _ = c.put_paper(p);
            }
        }
        papers
    }

    /// Fetch one record by canonical id, cache-first.
    pub fn get_paper(&self, id: &str) -> Result<Option<Paper>, String> {
        if let Some(c) = &self.cache {
            if let Some(p) = c.get_paper(id) {
                return Ok(Some(p));
            }
        }
        let paper = sources::fetch_paper(&self.http, id)?;
        if let (Some(c), Some(p)) = (&self.cache, &paper) {
            let _ = c.put_paper(p);
        }
        Ok(paper)
    }

    /// Download + extract a paper's full text natively (cache-first). Errors when the paper is
    /// unknown or has no resolvable PDF; a text-less PDF yields a short/empty string.
    pub fn get_fulltext(&self, id: &str) -> Result<String, String> {
        if let Some(c) = &self.cache {
            if let Some(t) = c.get_fulltext(id) {
                return Ok(t);
            }
        }
        // Sources that serve article text directly (Wikipedia) — no PDF to download/extract.
        if let Some(text) = sources::fetch_fulltext(&self.http, id)? {
            if let Some(c) = &self.cache {
                let _ = c.put_fulltext(id, &text);
            }
            return Ok(text);
        }
        let paper = self.get_paper(id)?.ok_or_else(|| format!("paper not found: {id}"))?;
        let url = paper
            .pdf_url
            .clone()
            .ok_or_else(|| format!("no PDF URL known for {id}"))?;
        let text = pdf::download_and_extract(&self.http, &url)?;
        if let Some(c) = &self.cache {
            let _ = c.put_fulltext(id, &text);
        }
        Ok(text)
    }

    /// Resolve a paper's reference list (Crossref/S2; empty when the source serves none).
    pub fn get_references(&self, id: &str) -> Result<Vec<Reference>, String> {
        sources::fetch_references(&self.http, id)
    }

    /// Citation-grounded semantic search over the given papers: build a corpus from each paper's
    /// full text (chunked, section-tagged) — falling back to its abstract when no text layer is
    /// available — then BM25-rank the chunks, returning the top `top_k` passages with provenance.
    pub fn semantic_search(&self, query: &str, ids: &[String], top_k: usize) -> Result<Vec<Passage>, String> {
        let mut docs: Vec<Doc> = Vec::new();
        for id in ids {
            let full = self.get_fulltext(id).ok().filter(|t| t.trim().len() > 200);
            if let Some(text) = full {
                for ch in pdf::chunk_sections(&text) {
                    docs.push(Doc { paper_id: id.clone(), section: ch.section, text: ch.text });
                }
                continue;
            }
            // No usable full text → fall back to the abstract so the paper is still searchable.
            if let Ok(Some(p)) = self.get_paper(id) {
                if let Some(ab) = p.abstract_text {
                    docs.push(Doc { paper_id: id.clone(), section: "Abstract".into(), text: ab });
                }
            }
        }
        Ok(search::rank(query, &docs, top_k))
    }
}

/// Dedupe a fanned-out result set in place. A paper is a duplicate if EITHER its DOI or its
/// normalized title was already seen — so the same work coming back from two sources (one with a
/// DOI, one without) collapses to a single entry. First occurrence wins (sources are appended in
/// query order), and each kept paper records both its DOI and title for later comparisons.
pub fn dedup_papers(papers: &mut Vec<Paper>) {
    let mut seen_doi = std::collections::HashSet::new();
    let mut seen_title = std::collections::HashSet::new();
    papers.retain(|p| {
        let doi_key = p
            .doi
            .as_ref()
            .map(|d| d.trim().to_ascii_lowercase())
            .filter(|d| !d.is_empty());
        let title_key = normalize_title(&p.title);
        let dup = doi_key.as_ref().is_some_and(|d| seen_doi.contains(d))
            || (!title_key.is_empty() && seen_title.contains(&title_key));
        if dup {
            return false;
        }
        if let Some(d) = doi_key {
            seen_doi.insert(d);
        }
        if !title_key.is_empty() {
            seen_title.insert(title_key);
        }
        true
    });
}

fn normalize_title(title: &str) -> String {
    title
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Source;

    #[test]
    fn dedup_collapses_same_doi_and_title() {
        let mut a = Paper::new("arxiv:1", Source::Arxiv, "Real-Time Path Tracing");
        a.doi = Some("10.1/X".into());
        let mut b = Paper::new("crossref:1", Source::Crossref, "Real Time Path Tracing!");
        b.doi = Some("10.1/x".into()); // same DOI, different case → duplicate
        let c = Paper::new("s2:1", Source::SemanticScholar, "real-time   path tracing"); // same title, no DOI
        let d = Paper::new("arxiv:2", Source::Arxiv, "A Different Paper");

        let mut papers = vec![a.clone(), b, c, d];
        dedup_papers(&mut papers);
        let ids: Vec<&str> = papers.iter().map(|p| p.id.as_str()).collect();
        // a kept (doi), b dropped (same doi), c dropped (same normalized title as a), d kept.
        assert_eq!(ids, vec!["arxiv:1", "arxiv:2"]);
    }
}
