//! Local / self-hosted provider via an OpenAI-compatible endpoint (default Ollama
//! at `http://localhost:11434/v1`). Reuses OpenAI's request/response mapping; the
//! API key is optional (Ollama needs none), so the bearer header is sent only when
//! a key is present.

use super::{openai, post_json, LlmProvider, LlmRequest, Turn, TurnResult};

/// A local / self-hosted OpenAI-compatible provider, pointed at a configurable
/// `base_url` (Settings → Integrations; defaults to Ollama via [`DEFAULT_LOCAL_BASE_URL`]).
pub struct LocalProvider {
    pub base_url: String,
}

/// Ollama's default OpenAI-compatible base URL — used when none is configured.
pub const DEFAULT_LOCAL_BASE_URL: &str = "http://localhost:11434/v1";

/// The chat-completions endpoint for a base URL (tolerant of a trailing slash).
pub(crate) fn chat_completions_url(base: &str) -> String {
    format!("{}/chat/completions", base.trim_end_matches('/'))
}

/// Auth headers for the local endpoint. Ollama needs no auth, so the bearer token
/// is forwarded only when an API key is configured (an empty key sends no header).
fn local_headers(api_key: &str) -> Vec<(&'static str, String)> {
    if api_key.is_empty() {
        Vec::new()
    } else {
        vec![("authorization", format!("Bearer {}", api_key))]
    }
}

impl LlmProvider for LocalProvider {
    async fn complete(&self, req: &LlmRequest, api_key: &str) -> Result<serde_json::Value, String> {
        let json = post_json(
            &chat_completions_url(&self.base_url),
            &local_headers(api_key),
            &openai::build_request_body(req),
        )
        .await?;
        Ok(openai::normalize_response(&json))
    }

    async fn turn(&self, t: &Turn, api_key: &str) -> Result<TurnResult, String> {
        // Reuse OpenAI's turn mapping against the configured (OpenAI-compatible) endpoint.
        let json = post_json(
            &chat_completions_url(&self.base_url),
            &local_headers(api_key),
            &openai::turn_request_body(t),
        )
        .await?;
        Ok(openai::parse_turn_response(&json))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_completions_url_appends_path_and_trims_trailing_slash() {
        assert_eq!(
            chat_completions_url("http://localhost:11434/v1"),
            "http://localhost:11434/v1/chat/completions"
        );
        // A user-entered base URL with a trailing slash must not double up.
        assert_eq!(
            chat_completions_url("http://10.0.0.5:8080/v1/"),
            "http://10.0.0.5:8080/v1/chat/completions"
        );
    }
}
