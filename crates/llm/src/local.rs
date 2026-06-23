//! Local / self-hosted provider via an OpenAI-compatible endpoint (default Ollama
//! at `http://localhost:11434/v1`). Reuses OpenAI's request/response mapping; the
//! API key is optional (Ollama needs none), so the bearer header is sent only when
//! a key is present.

use super::{openai, LlmProvider, LlmRequest, Turn, TurnResult};

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

impl LlmProvider for LocalProvider {
    async fn complete(&self, req: &LlmRequest, api_key: &str) -> Result<serde_json::Value, String> {
        let client = reqwest::Client::new();
        let mut builder = client
            .post(chat_completions_url(&self.base_url))
            .header("content-type", "application/json")
            .json(&openai::build_request_body(req));
        // Ollama needs no auth; only forward a bearer token when one is configured.
        if !api_key.is_empty() {
            builder = builder.header("authorization", format!("Bearer {}", api_key));
        }
        let response = builder
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;
        let status = response.status();
        let json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;
        if !status.is_success() {
            let err = json["error"]["message"]
                .as_str()
                .unwrap_or("Unknown error")
                .to_string();
            return Err(format!("API error ({}): {}", status, err));
        }
        Ok(openai::normalize_response(&json))
    }

    async fn turn(&self, t: &Turn, api_key: &str) -> Result<TurnResult, String> {
        let client = reqwest::Client::new();
        // Reuse OpenAI's turn mapping against the configured (OpenAI-compatible) endpoint.
        let mut builder = client
            .post(chat_completions_url(&self.base_url))
            .header("content-type", "application/json")
            .json(&openai::turn_request_body(t));
        if !api_key.is_empty() {
            builder = builder.header("authorization", format!("Bearer {}", api_key));
        }
        let response = builder.send().await.map_err(|e| format!("Request failed: {}", e))?;
        let status = response.status();
        let json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;
        if !status.is_success() {
            let err = json["error"]["message"].as_str().unwrap_or("Unknown error").to_string();
            return Err(format!("API error ({}): {}", status, err));
        }
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
