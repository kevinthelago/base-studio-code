//! Local / self-hosted provider via an OpenAI-compatible endpoint (default Ollama
//! at `http://localhost:11434/v1`). Reuses OpenAI's request/response mapping; the
//! API key is optional (Ollama needs none), so the bearer header is sent only when
//! a key is present.

use super::{openai, LlmProvider, LlmRequest};

pub struct LocalProvider;

/// The OpenAI-compatible base URL local models are served at. Ollama's default;
/// a configurable base URL arrives with the provider/model selection UX (later P1).
const LOCAL_BASE_URL: &str = "http://localhost:11434/v1";

impl LlmProvider for LocalProvider {
    async fn complete(&self, req: &LlmRequest, api_key: &str) -> Result<serde_json::Value, String> {
        let client = reqwest::Client::new();
        let mut builder = client
            .post(format!("{}/chat/completions", LOCAL_BASE_URL))
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
}
