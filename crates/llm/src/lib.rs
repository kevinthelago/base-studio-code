//! Model-agnostic LLM provider layer (#1079 / epic #1078).
//!
//! `llm_complete` builds a normalized [`LlmRequest`] and dispatches to a provider; each
//! provider returns the existing `{ "content": [...], "usage": {...} }` response
//! shape, so llm_complete's consumers (`oneShotComplete`, `gradeLLM`) are unchanged
//! across providers. This is the same provider abstraction `bsc-agent` will reuse.

mod anthropic;
mod gemini;
mod local;
mod openai;
mod turn;

pub use anthropic::AnthropicProvider;
pub use gemini::GeminiProvider;
pub use local::{LocalProvider, DEFAULT_LOCAL_BASE_URL};
pub use openai::OpenAiProvider;
pub use turn::{Msg, ToolCall, ToolDef, Turn, TurnResult};

/// A provider-agnostic chat-completion request. `messages` and `tools` are passed
/// through as raw JSON (the caller already speaks the message/tool shape); each
/// provider maps them onto its own wire format.
pub struct LlmRequest {
    pub model: String,
    pub system: String,
    pub messages: Vec<serde_json::Value>,
    pub tools: Vec<serde_json::Value>,
    pub max_tokens: u32,
}

/// A chat-completion provider. `complete` returns the normalized response JSON
/// (`{ content: [...], usage }`) — the same shape every consumer already reads.
/// `turn` is the tool-using, multi-turn path the `bsc-agent` loop drives; it maps
/// the normalized [`Turn`] onto the provider's wire format and back into a
/// [`TurnResult`].
#[allow(async_fn_in_trait)]
pub trait LlmProvider {
    async fn complete(&self, req: &LlmRequest, api_key: &str) -> Result<serde_json::Value, String>;
    async fn turn(&self, t: &Turn, api_key: &str) -> Result<TurnResult, String>;
}

/// Format the non-2xx error string a provider returns, in the exact shape
/// `bsc-agent`'s `is_transient_error` matches on: `"API error (<status>): <message>"`.
/// The message is read from the response body's `error.message`, defaulting to
/// `"Unknown error"`. Pure — extracted so the format can be unit-tested without I/O.
///
/// **CRITICAL:** this format is string-matched (`"API error (429"`, `"API error (5"`),
/// so the `"API error ({status}): {message}"` shape must not change.
pub(crate) fn format_api_error(status: reqwest::StatusCode, json: &serde_json::Value) -> String {
    let err = json["error"]["message"].as_str().unwrap_or("Unknown error").to_string();
    format!("API error ({}): {}", status, err)
}

/// Issue a JSON POST and return the parsed response body, collapsing the
/// request/status-check/error-format block every provider repeated. Headers
/// (auth, API version, …) vary per provider, so the caller passes them in; the
/// JSON content-type is set by `.json()`.
///
/// **CRITICAL:** the error strings produced here (`"Request failed: …"` on a
/// transport failure and `"API error (<status>): …"` on a non-2xx response) are
/// string-matched by `bsc-agent`'s `is_transient_error`, so their formats must not
/// change (see [`format_api_error`]).
pub(crate) async fn post_json(
    url: &str,
    headers: &[(&str, String)],
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let mut builder = client.post(url);
    for (name, value) in headers {
        builder = builder.header(*name, value);
    }
    let response = builder
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    if !status.is_success() {
        return Err(format_api_error(status, &json));
    }
    Ok(json)
}

/// Read `u[key]` as a `u64`, defaulting a missing or non-numeric value to 0.
/// Shared by every provider's `normalize_usage` (the canonical usage shape
/// `tokens.rs` parses).
pub(crate) fn usage_u64(u: &serde_json::Value, key: &str) -> u64 {
    u.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Which provider a request targets.
pub enum ProviderKind {
    Anthropic,
    OpenAi,
    Gemini,
    Local,
}

/// Resolve a provider name (`"anthropic"` | `"openai"` | `"gemini"` | `"local"`) to a
/// [`ProviderKind`]. Errors on an unknown provider rather than silently defaulting.
pub fn resolve_provider(name: &str) -> Result<ProviderKind, String> {
    match name {
        "anthropic" => Ok(ProviderKind::Anthropic),
        "openai" => Ok(ProviderKind::OpenAi),
        "gemini" => Ok(ProviderKind::Gemini),
        "local" => Ok(ProviderKind::Local),
        other => Err(format!("Unknown LLM provider: '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_provider_accepts_known_and_rejects_unknown() {
        assert!(matches!(resolve_provider("anthropic"), Ok(ProviderKind::Anthropic)));
        assert!(matches!(resolve_provider("openai"), Ok(ProviderKind::OpenAi)));
        assert!(matches!(resolve_provider("gemini"), Ok(ProviderKind::Gemini)));
        assert!(matches!(resolve_provider("local"), Ok(ProviderKind::Local)));
        assert!(resolve_provider("mistral").is_err());
        assert!(resolve_provider("").is_err());
    }

    // Mirror of `bsc-agent`'s `is_transient_error` — duplicated here (the `llm` crate
    // can't depend on `bsc-agent`) to lock in that `format_api_error`'s output is
    // classified the same way. If this and the real one drift, retries break.
    fn is_transient_error(err: &str) -> bool {
        err.starts_with("Request failed:")
            || err.contains("API error (429")
            || err.contains("API error (5")
    }

    fn status(code: u16) -> reqwest::StatusCode {
        reqwest::StatusCode::from_u16(code).unwrap()
    }

    #[test]
    fn format_api_error_preserves_transient_classification() {
        let body = serde_json::json!({ "error": { "message": "slow down" } });
        // 429 + 5xx must classify as transient (retryable).
        let e429 = format_api_error(status(429), &body);
        assert_eq!(e429, "API error (429 Too Many Requests): slow down");
        assert!(is_transient_error(&e429));
        let e503 = format_api_error(status(503), &body);
        assert!(is_transient_error(&e503));
        // 4xx (non-429) must classify as permanent (no retry).
        let e401 = format_api_error(status(401), &body);
        assert_eq!(e401, "API error (401 Unauthorized): slow down");
        assert!(!is_transient_error(&e401));
        let e400 = format_api_error(status(400), &body);
        assert!(!is_transient_error(&e400));
    }

    #[test]
    fn format_api_error_defaults_missing_message() {
        let e = format_api_error(status(500), &serde_json::json!({}));
        assert_eq!(e, "API error (500 Internal Server Error): Unknown error");
        assert!(is_transient_error(&e));
    }

    #[test]
    fn usage_u64_reads_and_defaults() {
        let u = serde_json::json!({ "input_tokens": 7, "junk": "x" });
        assert_eq!(usage_u64(&u, "input_tokens"), 7);
        assert_eq!(usage_u64(&u, "junk"), 0); // non-numeric -> 0
        assert_eq!(usage_u64(&u, "missing"), 0); // absent -> 0
    }
}
