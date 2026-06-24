//! Thin blocking HTTP wrapper for the source clients (#1196). Kept separate from the parsers so the
//! parse logic stays pure + fixture-tested; only the `fetch`/`search` entry points touch the network.
//!
//! API keys / polite-pool identity are read from env (the same MCP env mechanism the app injects):
//!   • `SEMANTIC_SCHOLAR_API_KEY` — higher Semantic Scholar rate limits (works key-less, slower).
//!   • `NCBI_API_KEY`            — higher PubMed/PMC E-utilities limits (works key-less).
//!   • `CROSSREF_MAILTO`         — Crossref "polite pool" contact email (recommended, not required).
//! Every listed source works WITHOUT a key; the keys only raise rate limits.

use std::time::Duration;

/// User-agent advertised to every upstream (Crossref/NCBI ask for an identifying UA).
const USER_AGENT: &str =
    concat!("bsc-research-mcp/", env!("CARGO_PKG_VERSION"), " (+https://github.com/kevinthelago/base-studio-code)");

/// A configured blocking HTTP client plus the env-sourced credentials.
pub struct Http {
    client: reqwest::blocking::Client,
    pub s2_api_key: Option<String>,
    pub ncbi_api_key: Option<String>,
    pub crossref_mailto: Option<String>,
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

impl Http {
    /// Build a client with sensible timeouts, reading credentials from the environment.
    pub fn from_env() -> Result<Http, String> {
        let client = reqwest::blocking::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| format!("http client build failed: {e}"))?;
        Ok(Http {
            client,
            s2_api_key: env_nonempty("SEMANTIC_SCHOLAR_API_KEY"),
            ncbi_api_key: env_nonempty("NCBI_API_KEY"),
            crossref_mailto: env_nonempty("CROSSREF_MAILTO"),
        })
    }

    /// GET a URL with optional extra headers, returning the body as text.
    pub fn get_text(&self, url: &str, headers: &[(&str, &str)]) -> Result<String, String> {
        let mut req = self.client.get(url);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let resp = req.send().map_err(|e| format!("GET {url} failed: {e}"))?;
        let status = resp.status();
        let body = resp.text().map_err(|e| format!("GET {url} read body failed: {e}"))?;
        if !status.is_success() {
            return Err(format!("GET {url} → HTTP {status}: {}", truncate(&body, 200)));
        }
        Ok(body)
    }

    /// GET a URL returning raw bytes (for PDF downloads).
    pub fn get_bytes(&self, url: &str) -> Result<Vec<u8>, String> {
        let resp = self.client.get(url).send().map_err(|e| format!("GET {url} failed: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("GET {url} → HTTP {status}"));
        }
        resp.bytes().map(|b| b.to_vec()).map_err(|e| format!("GET {url} read bytes failed: {e}"))
    }
}

/// percent-encode a query-string VALUE (RFC 3986 unreserved kept; everything else %XX). Small + dep-free.
pub fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n { s.to_string() } else { format!("{}…", &s[..s.floor_char_boundary(n)]) }
}

// `str::floor_char_boundary` is unstable; provide a tiny local equivalent.
trait FloorCharBoundary {
    fn floor_char_boundary(&self, index: usize) -> usize;
}
impl FloorCharBoundary for str {
    fn floor_char_boundary(&self, index: usize) -> usize {
        if index >= self.len() {
            self.len()
        } else {
            let mut i = index;
            while i > 0 && !self.is_char_boundary(i) {
                i -= 1;
            }
            i
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_escapes_spaces_and_keeps_unreserved() {
        assert_eq!(encode("ray tracing"), "ray%20tracing");
        assert_eq!(encode("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(encode("c++"), "c%2B%2B");
    }
}
