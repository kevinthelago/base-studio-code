//! Thin blocking HTTP wrapper for the feed clients. Kept separate from the parsers so the parse
//! logic stays pure and fixture-tested; only the `fetch` entry points touch the network.
//!
//! No API keys: every outlet in the roster is polled over a public feed, which is the whole reason
//! RSS and news sitemaps are the sanctioned acquisition path. Anything needing a credential does
//! not belong in this layer.

use std::time::Duration;

/// User-agent advertised to every upstream. Feeds are a published interface, but an identifying UA
/// is the courtesy that keeps a poller from looking like a scraper.
const USER_AGENT: &str =
    concat!("bsc-news/", env!("CARGO_PKG_VERSION"), " (+https://github.com/kevinthelago/base-studio-code)");

/// A configured blocking HTTP client.
pub struct Http {
    client: reqwest::blocking::Client,
}

impl Http {
    /// Build a client with sensible timeouts.
    pub fn new() -> Result<Http, String> {
        let client = reqwest::blocking::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(30))
            // Feeds redirect constantly (http→https, apex→www, and Reuters' index to its CDN).
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|e| format!("http client build failed: {e}"))?;
        Ok(Http { client })
    }

    /// GET a URL, returning the body as text.
    pub fn get_text(&self, url: &str) -> Result<String, String> {
        let resp = self.client.get(url).send().map_err(|e| format!("GET {url} failed: {e}"))?;
        let status = resp.status();
        let body = resp.text().map_err(|e| format!("GET {url} read body failed: {e}"))?;
        if !status.is_success() {
            return Err(format!("GET {url} → HTTP {status}"));
        }
        Ok(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_user_agent_identifies_the_poller_and_its_version() {
        assert!(USER_AGENT.starts_with("bsc-news/"));
        assert!(USER_AGENT.contains(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn client_builds() {
        assert!(Http::new().is_ok());
    }
}
