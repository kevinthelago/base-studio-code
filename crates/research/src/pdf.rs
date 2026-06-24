//! Native PDF full-text extraction + section-aware chunking (#1196). No Docker/GROBID: we download
//! the PDF (arXiv/PMC-OA/publisher) and extract text with the pure-Rust `pdf-extract`, then split it
//! into section-tagged chunks so the semantic-search layer can return citation-grounded passages
//! that carry their section provenance. Scanned/image-only PDFs (no text layer) extract empty — the
//! caller falls back to the abstract.

use crate::http::Http;

/// A section-tagged chunk of extracted text. `section` is the best-guess heading the chunk fell
/// under (provenance for grounded passages); `text` is the cleaned body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub section: String,
    pub text: String,
}

/// Extract raw text from PDF bytes. Returns an error only on a malformed PDF; a text-less PDF yields
/// an empty/short string (the caller decides whether to fall back to the abstract).
pub fn extract_text(bytes: &[u8]) -> Result<String, String> {
    pdf_extract::extract_text_from_mem(bytes).map_err(|e| format!("pdf extract: {e}"))
}

/// Download a PDF and extract its text.
pub fn download_and_extract(http: &Http, url: &str) -> Result<String, String> {
    let bytes = http.get_bytes(url)?;
    extract_text(&bytes)
}

/// Split extracted text into section-tagged chunks (~`MAX_CHARS` each), restarting the section label
/// whenever a heuristic header line is detected.
pub fn chunk_sections(text: &str) -> Vec<Chunk> {
    let mut out = Vec::new();
    let mut section = "Body".to_string();
    let mut buf = String::new();
    for line in text.lines() {
        if let Some(header) = is_section_header(line) {
            push_chunks(&mut out, &section, &buf);
            buf.clear();
            section = header;
        } else {
            buf.push_str(line.trim());
            buf.push('\n');
        }
    }
    push_chunks(&mut out, &section, &buf);
    out
}

const MAX_CHARS: usize = 800;

/// The known section names we recognize regardless of numbering/case.
const KNOWN_SECTIONS: &[&str] = &[
    "abstract", "introduction", "related work", "background", "preliminaries", "method", "methods",
    "methodology", "approach", "model", "architecture", "experiments", "experimental setup",
    "results", "evaluation", "analysis", "discussion", "limitations", "conclusion", "conclusions",
    "future work", "references", "acknowledgments", "acknowledgements", "appendix",
];

/// Whether a line looks like a section header; returns the normalized heading text if so.
fn is_section_header(line: &str) -> Option<String> {
    let t = line.trim();
    if t.is_empty() || t.len() > 80 {
        return None;
    }
    // Wikipedia plain-text extracts mark sections with `== Heading ==` / `=== Sub ===` (#1298).
    if t.starts_with("==") && t.ends_with("==") {
        let inner = t.trim_matches('=').trim();
        if !inner.is_empty() {
            return Some(inner.to_string());
        }
    }
    let lower = t.to_ascii_lowercase();
    let lower = lower.trim_end_matches('.');
    for k in KNOWN_SECTIONS {
        if lower == *k || lower.starts_with(&format!("{k} ")) {
            return Some(t.trim_end_matches('.').to_string());
        }
    }
    // Numbered headers: "1 Introduction", "2. Related Work", "3.1 Method".
    if let Some(rest) = strip_leading_number(t) {
        let words = rest.split_whitespace().count();
        if (1..=8).contains(&words) && rest.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
            return Some(t.to_string());
        }
    }
    None
}

/// If `s` starts with a section number like `1`, `2.`, `3.1`, `4.2.1`, return the remainder after the
/// number + following whitespace; else None.
fn strip_leading_number(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut saw_digit = false;
    while i < bytes.len() {
        match bytes[i] {
            b'0'..=b'9' => {
                saw_digit = true;
                i += 1;
            }
            b'.' if saw_digit => i += 1,
            _ => break,
        }
    }
    if !saw_digit {
        return None;
    }
    let rest = s[i..].trim_start();
    if rest.is_empty() || rest.len() == s.len() {
        None
    } else {
        Some(rest)
    }
}

/// Append `buf` to `out` as one or more ≤`MAX_CHARS` chunks under `section` (split on word
/// boundaries). Whitespace is collapsed; empty buffers are skipped.
fn push_chunks(out: &mut Vec<Chunk>, section: &str, buf: &str) {
    let text = buf.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return;
    }
    let mut cur = String::new();
    for word in text.split(' ') {
        if !cur.is_empty() && cur.len() + 1 + word.len() > MAX_CHARS {
            out.push(Chunk { section: section.to_string(), text: std::mem::take(&mut cur) });
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(word);
    }
    if !cur.is_empty() {
        out.push(Chunk { section: section.to_string(), text: cur });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_known_and_numbered_headers() {
        assert_eq!(is_section_header("Introduction").as_deref(), Some("Introduction"));
        assert_eq!(is_section_header("ABSTRACT").as_deref(), Some("ABSTRACT"));
        assert_eq!(is_section_header("2. Related Work").as_deref(), Some("2. Related Work"));
        assert_eq!(is_section_header("3.1 Neural Denoising").as_deref(), Some("3.1 Neural Denoising"));
        // Body prose is not a header.
        assert!(is_section_header("We present a method that uses a neural denoiser to clean frames.").is_none());
        // A bare number is not a header.
        assert!(is_section_header("42").is_none());
        // Wikipedia `== Heading ==` markers (#1298) — inner text, any level.
        assert_eq!(is_section_header("== History ==").as_deref(), Some("History"));
        assert_eq!(is_section_header("=== Backward ray tracing ===").as_deref(), Some("Backward ray tracing"));
        // Empty markers aren't headers.
        assert!(is_section_header("====").is_none());
    }

    #[test]
    fn chunks_carry_section_provenance() {
        let doc = "Abstract\nWe study real-time rendering.\n\nIntroduction\nRay tracing is expensive. \
                   Denoising helps a lot.\n\n2. Method\nWe train a small UNet.";
        let chunks = chunk_sections(doc);
        let sections: Vec<&str> = chunks.iter().map(|c| c.section.as_str()).collect();
        assert!(sections.contains(&"Abstract"));
        assert!(sections.contains(&"Introduction"));
        assert!(sections.contains(&"2. Method"));
        // Content landed under the right heading.
        let intro = chunks.iter().find(|c| c.section == "Introduction").unwrap();
        assert!(intro.text.contains("Ray tracing is expensive"));
    }

    #[test]
    fn long_section_splits_into_multiple_chunks() {
        let big = "word ".repeat(400); // ~2000 chars under one section
        let doc = format!("Introduction\n{big}");
        let chunks = chunk_sections(&doc);
        assert!(chunks.len() >= 2);
        assert!(chunks.iter().all(|c| c.text.len() <= MAX_CHARS));
        assert!(chunks.iter().all(|c| c.section == "Introduction"));
    }
}
