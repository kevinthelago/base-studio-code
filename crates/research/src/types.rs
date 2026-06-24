//! Normalized record types shared by every source client (#1196). Each client parses its upstream
//! payload into these so the MCP tool surface returns one consistent shape regardless of where a
//! paper came from. Pure data + serde — no I/O — so the parsers are unit-testable against fixtures.

use serde::{Deserialize, Serialize};

/// A literature source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Arxiv,
    SemanticScholar,
    Pubmed,
    Crossref,
}

impl Source {
    /// The lowercase token used in queries / the `sources` tool argument.
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Arxiv => "arxiv",
            Source::SemanticScholar => "semantic_scholar",
            Source::Pubmed => "pubmed",
            Source::Crossref => "crossref",
        }
    }

    /// Parse a source token (case-insensitive); accepts a few common aliases.
    pub fn parse(s: &str) -> Option<Source> {
        match s.trim().to_ascii_lowercase().as_str() {
            "arxiv" => Some(Source::Arxiv),
            "semantic_scholar" | "semanticscholar" | "s2" => Some(Source::SemanticScholar),
            "pubmed" | "pmc" | "pubmed/pmc" => Some(Source::Pubmed),
            "crossref" => Some(Source::Crossref),
            _ => None,
        }
    }

    /// Every source, the default fan-out for a search with no `sources` filter.
    pub fn all() -> Vec<Source> {
        vec![
            Source::Arxiv,
            Source::SemanticScholar,
            Source::Pubmed,
            Source::Crossref,
        ]
    }
}

/// A normalized author.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Author {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub orcid: Option<String>,
}

impl Author {
    pub fn new(name: impl Into<String>) -> Author {
        Author { name: name.into(), orcid: None }
    }
}

/// A normalized paper/record from any source. `id` is the canonical id (e.g. `arxiv:2401.00001`,
/// `doi:10.1145/3592433`, `pmid:31452104`) used as the cache key and the handle the other tools
/// (`get_paper`, `get_fulltext`, `get_references`) accept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paper {
    pub id: String,
    pub source: Source,
    pub title: String,
    #[serde(default)]
    pub authors: Vec<Author>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub year: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "abstract")]
    pub abstract_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub arxiv_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub pdf_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub venue: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub citation_count: Option<u64>,
}

impl Paper {
    /// A minimal record — title + source + canonical id — that source parsers fill out.
    pub fn new(id: impl Into<String>, source: Source, title: impl Into<String>) -> Paper {
        Paper {
            id: id.into(),
            source,
            title: title.into(),
            authors: Vec::new(),
            year: None,
            abstract_text: None,
            doi: None,
            arxiv_id: None,
            url: None,
            pdf_url: None,
            venue: None,
            citation_count: None,
        }
    }
}

/// A parsed/resolved reference (one citation in a paper's bibliography).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reference {
    /// The raw reference string as parsed from the source, kept even when resolved.
    pub raw: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub arxiv_id: Option<String>,
    /// True once the reference resolved to a concrete identifier (DOI / arXiv id).
    pub resolved: bool,
}

impl Reference {
    pub fn unresolved(raw: impl Into<String>) -> Reference {
        Reference { raw: raw.into(), title: None, doi: None, arxiv_id: None, resolved: false }
    }
}

/// A search request fanned out across one or more sources.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchQuery {
    pub query: String,
    /// Max results PER SOURCE.
    pub limit: usize,
    /// Restrict to papers published in/after this year, when set.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub year_from: Option<u32>,
    /// Sources to query; empty ⇒ all.
    #[serde(default)]
    pub sources: Vec<Source>,
}

impl SearchQuery {
    pub fn new(query: impl Into<String>) -> SearchQuery {
        SearchQuery { query: query.into(), limit: 10, year_from: None, sources: Vec::new() }
    }

    /// The effective source set — the requested ones, or all when unspecified.
    pub fn effective_sources(&self) -> Vec<Source> {
        if self.sources.is_empty() { Source::all() } else { self.sources.clone() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_round_trips_through_token() {
        for s in Source::all() {
            assert_eq!(Source::parse(s.as_str()), Some(s));
        }
        assert_eq!(Source::parse("S2"), Some(Source::SemanticScholar));
        assert_eq!(Source::parse("PMC"), Some(Source::Pubmed));
        assert_eq!(Source::parse("nonsense"), None);
    }

    #[test]
    fn effective_sources_defaults_to_all() {
        assert_eq!(SearchQuery::new("q").effective_sources(), Source::all());
        let mut q = SearchQuery::new("q");
        q.sources = vec![Source::Arxiv];
        assert_eq!(q.effective_sources(), vec![Source::Arxiv]);
    }

    #[test]
    fn paper_abstract_serializes_as_abstract_key() {
        let mut p = Paper::new("arxiv:2401.00001", Source::Arxiv, "Title");
        p.abstract_text = Some("body".into());
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["abstract"], "body");
        assert_eq!(v["source"], "arxiv");
        // None fields are omitted.
        assert!(v.get("doi").is_none());
    }
}
