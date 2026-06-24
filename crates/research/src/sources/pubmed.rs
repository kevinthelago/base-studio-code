//! PubMed/PMC client (#1196) — NCBI E-utilities (esearch → efetch, XML). Mirrors the arXiv reference
//! impl: pure parsers ([`parse_esearch_ids`]/[`parse_efetch`], fixture-tested, no network) plus thin
//! [`search`]/[`fetch`] entry points. XML is matched by LOCAL element name (namespace-agnostic), like
//! the arXiv parser. `&api_key=<key>` is appended only when an `ncbi_api_key` is configured — every
//! call works key-less (lower rate limits).

use crate::http::{encode, Http};
use crate::types::{Author, Paper, SearchQuery, Source};
use roxmltree::{Document, Node, ParsingOptions};

const ESEARCH: &str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const EFETCH: &str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

/// Search PubMed (two-step: esearch for PMIDs, then efetch for records), capped to `limit`;
/// `year_from` is applied client-side.
pub fn search(http: &Http, query: &SearchQuery) -> Result<Vec<Paper>, String> {
    let limit = query.limit.max(1);
    let mut esearch_url = format!(
        "{ESEARCH}?db=pubmed&term={}&retmax={}&retmode=json",
        encode(&query.query),
        limit,
    );
    if let Some(key) = &http.ncbi_api_key {
        esearch_url.push_str(&format!("&api_key={}", encode(key)));
    }
    let ids = parse_esearch_ids(&http.get_text(&esearch_url, &[])?);
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut efetch_url =
        format!("{EFETCH}?db=pubmed&id={}&retmode=xml", encode(&ids.join(",")));
    if let Some(key) = &http.ncbi_api_key {
        efetch_url.push_str(&format!("&api_key={}", encode(key)));
    }
    let mut papers = parse_efetch(&http.get_text(&efetch_url, &[])?)?;
    if let Some(yf) = query.year_from {
        papers.retain(|p| p.year.is_none_or(|y| y >= yf));
    }
    papers.truncate(limit);
    Ok(papers)
}

/// Fetch one record by canonical id (`pmid:31452104`) via a single-id efetch.
pub fn fetch(http: &Http, id: &str) -> Result<Option<Paper>, String> {
    let pmid = id.strip_prefix("pmid:").unwrap_or(id);
    let mut url = format!("{EFETCH}?db=pubmed&id={}&retmode=xml", encode(pmid));
    if let Some(key) = &http.ncbi_api_key {
        url.push_str(&format!("&api_key={}", encode(key)));
    }
    Ok(parse_efetch(&http.get_text(&url, &[])?)?.into_iter().next())
}

/// Parse an esearch JSON response into the ordered PMID list. Pure.
pub fn parse_esearch_ids(body: &str) -> Vec<String> {
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    v["esearchresult"]["idlist"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default()
}

/// Parse an efetch `PubmedArticleSet` into normalized papers. Pure — the unit of fixture testing.
pub fn parse_efetch(xml: &str) -> Result<Vec<Paper>, String> {
    // efetch responses carry a DOCTYPE/DTD; allow it (roxmltree rejects DTDs by default).
    let opts = ParsingOptions { allow_dtd: true, ..ParsingOptions::default() };
    let doc =
        Document::parse_with_options(xml, opts).map_err(|e| format!("pubmed xml parse: {e}"))?;
    let mut out = Vec::new();
    for article in doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "PubmedArticle")
    {
        if let Some(p) = article_to_paper(&article) {
            out.push(p);
        }
    }
    Ok(out)
}

// ── mapping ──────────────────────────────────────────────────────────────────

/// Map one `<PubmedArticle>` to a [`Paper`], or `None` if it has no PMID/title.
fn article_to_paper(article: &Node) -> Option<Paper> {
    let pmid = find_local(article, "PMID")
        .and_then(|n| n.text())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let title = find_local(article, "ArticleTitle")
        .map(|n| collapse_ws(&node_text(&n)))
        .filter(|s| !s.is_empty())?;
    let mut p = Paper::new(format!("pmid:{pmid}"), Source::Pubmed, title);

    // Abstract: join all AbstractText children.
    let abstract_parts: Vec<String> = article
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "AbstractText")
        .map(|n| collapse_ws(&node_text(&n)))
        .filter(|s| !s.is_empty())
        .collect();
    if !abstract_parts.is_empty() {
        p.abstract_text = Some(abstract_parts.join(" "));
    }

    // Authors: "ForeName LastName" or CollectiveName.
    if let Some(list) = find_local(article, "AuthorList") {
        for a in list.children().filter(|n| n.is_element() && n.tag_name().name() == "Author") {
            if let Some(name) = author_name(&a) {
                p.authors.push(Author::new(name));
            }
        }
    }

    p.year = year_from_pubdate(article);
    p.venue = journal_title(article);

    // ArticleId list: doi + pmc.
    let mut pmcid: Option<String> = None;
    if let Some(list) = find_local(article, "ArticleIdList") {
        for aid in list.children().filter(|n| n.is_element() && n.tag_name().name() == "ArticleId") {
            let id_type = aid.attribute("IdType").unwrap_or_default();
            let val = aid.text().unwrap_or_default().trim().to_string();
            if val.is_empty() {
                continue;
            }
            match id_type {
                "doi" => p.doi = Some(val),
                "pmc" => pmcid = Some(val),
                _ => {}
            }
        }
    }

    p.url = Some(format!("https://pubmed.ncbi.nlm.nih.gov/{pmid}/"));
    if let Some(pmc) = &pmcid {
        p.pdf_url = Some(format!("https://www.ncbi.nlm.nih.gov/pmc/articles/{pmc}/pdf/"));
    }
    Some(p)
}

/// Author display name: "ForeName LastName", else CollectiveName.
fn author_name(a: &Node) -> Option<String> {
    let fore = find_local(a, "ForeName").and_then(|n| n.text()).unwrap_or("").trim();
    let last = find_local(a, "LastName").and_then(|n| n.text()).unwrap_or("").trim();
    let combined = format!("{fore} {last}");
    let combined = combined.trim();
    if !combined.is_empty() {
        return Some(combined.to_string());
    }
    find_local(a, "CollectiveName")
        .and_then(|n| n.text())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Year from `PubDate/Year`, falling back to the first 4 digits of `MedlineDate`.
fn year_from_pubdate(article: &Node) -> Option<u32> {
    let pubdate = find_local(article, "PubDate")?;
    if let Some(year) = find_local(&pubdate, "Year").and_then(|n| n.text()) {
        if let Ok(y) = year.trim().parse() {
            return Some(y);
        }
    }
    let medline = find_local(&pubdate, "MedlineDate").and_then(|n| n.text())?;
    let digits: String = medline.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Journal title (`Journal/Title`), the article's venue.
fn journal_title(article: &Node) -> Option<String> {
    let journal = find_local(article, "Journal")?;
    find_local(&journal, "Title")
        .map(|n| collapse_ws(&node_text(&n)))
        .filter(|s| !s.is_empty())
}

// ── small helpers ────────────────────────────────────────────────────────────

/// The first descendant element with this local name (namespace-agnostic).
fn find_local<'a, 'input>(node: &Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.descendants().find(|n| n.is_element() && n.tag_name().name() == name)
}

/// All text under a node (handles mixed/markup content like `<i>` inside a title). Collects only
/// actual text nodes — `Node::text()` on an element also returns its first text child, so iterating
/// elements would double-count.
fn node_text(node: &Node) -> String {
    node.descendants().filter(|n| n.is_text()).filter_map(|n| n.text()).collect::<String>()
}

/// Collapse runs of whitespace to single spaces, trimmed.
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const EFETCH_FIXTURE: &str = include_str!("../../fixtures/pubmed_efetch.xml");
    const ESEARCH_FIXTURE: &str = include_str!("../../fixtures/pubmed_esearch.json");

    #[test]
    fn parses_esearch_id_list() {
        let ids = parse_esearch_ids(ESEARCH_FIXTURE);
        assert_eq!(ids, vec!["31452104", "12345678"]);
    }

    #[test]
    fn parses_efetch_with_normalized_fields() {
        let papers = parse_efetch(EFETCH_FIXTURE).unwrap();
        assert_eq!(papers.len(), 2);

        let a = &papers[0];
        assert_eq!(a.id, "pmid:31452104");
        assert_eq!(a.source, Source::Pubmed);
        assert_eq!(a.title, "Deep learning for cellular image analysis.");
        assert_eq!(a.year, Some(2019));
        assert_eq!(
            a.authors,
            vec![Author::new("Erick Moen"), Author::new("Dylan Bannon")]
        );
        // Both AbstractText children joined.
        assert_eq!(
            a.abstract_text.as_deref(),
            Some("Recent advances enable new applications. We review deep learning methods.")
        );
        assert_eq!(a.doi.as_deref(), Some("10.1038/s41592-019-0403-1"));
        assert_eq!(a.venue.as_deref(), Some("Nature Methods"));
        assert_eq!(a.url.as_deref(), Some("https://pubmed.ncbi.nlm.nih.gov/31452104/"));
        assert_eq!(
            a.pdf_url.as_deref(),
            Some("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6831029/pdf/")
        );
    }

    #[test]
    fn falls_back_to_medline_date_and_collective_name() {
        let papers = parse_efetch(EFETCH_FIXTURE).unwrap();
        let b = &papers[1];
        assert_eq!(b.id, "pmid:12345678");
        // Year parsed from "2005 Spring".
        assert_eq!(b.year, Some(2005));
        assert_eq!(b.authors, vec![Author::new("The Modeling Consortium")]);
        // No DOI / PMC id in the fixture.
        assert_eq!(b.doi, None);
        assert_eq!(b.pdf_url, None);
        assert_eq!(b.abstract_text, None);
    }
}
