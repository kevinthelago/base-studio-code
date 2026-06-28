//! Model-agnostic LLM provider layer (#1079 / epic #1078).
//!
//! `llm_complete` builds a normalized [`LlmRequest`] and dispatches to a provider; each
//! provider returns the existing `{ "content": [...], "usage": {...} }` response
//! shape, so llm_complete's consumers (`oneShotComplete`, `gradeLLM`) are unchanged
//! across providers. This is the same provider abstraction `bsc-agent` will reuse.

mod anthropic;
mod gemini;
mod local;
mod ollama;
mod openai;
mod toolparse;
mod turn;

#[cfg(test)]
mod http_it;

pub use anthropic::AnthropicProvider;
pub use gemini::GeminiProvider;
pub use local::{LocalProvider, DEFAULT_LOCAL_BASE_URL};
pub use ollama::{detect_ollama_profile, list_models, OllamaProfile, OllamaProvider};
pub use openai::OpenAiProvider;
pub use toolparse::{recover_tool_calls, strip_tool_syntax};
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

/// Connect timeout — how long to wait for the TCP/TLS connection before failing. Short so an
/// unreachable endpoint (e.g. Ollama not running) surfaces quickly instead of hanging the session.
const CONNECT_TIMEOUT_SECS: u64 = 30;
/// Overall request timeout — a hard ceiling on a single call so a stuck server (or a non-streaming
/// local model wedged on a huge prompt) can't hang the agent forever. Generous, since a local model
/// can be slow on the first inference (model load + long context); it's a backstop, not a target.
const REQUEST_TIMEOUT_SECS: u64 = 600;

/// Issue a JSON POST and return the parsed response body, collapsing the
/// request/status-check/error-format block every provider repeated. Headers
/// (auth, API version, …) vary per provider, so the caller passes them in; the
/// JSON content-type is set by `.json()`.
///
/// The client carries a connect + overall timeout (see the consts above) so a down/stuck endpoint
/// fails with a `"Request failed: …"` error instead of hanging indefinitely.
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
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Request failed: {}", e))?;
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

/// Issue a GET and return the parsed JSON body — same timeouts + error-string formats as [`post_json`]
/// (a down endpoint fails with `"Request failed: …"`). For Ollama's GET endpoints, e.g. `/api/tags`
/// model discovery (#1830).
pub(crate) async fn get_json(url: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Request failed: {}", e))?;
    let response = client.get(url).send().await.map_err(|e| format!("Request failed: {}", e))?;
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
    Ollama,
}

/// Resolve a provider name (`"anthropic"` | `"openai"` | `"gemini"` | `"local"` | `"ollama"`) to a
/// [`ProviderKind`]. Errors on an unknown provider rather than silently defaulting.
pub fn resolve_provider(name: &str) -> Result<ProviderKind, String> {
    match name {
        "anthropic" => Ok(ProviderKind::Anthropic),
        "openai" => Ok(ProviderKind::OpenAi),
        "gemini" => Ok(ProviderKind::Gemini),
        "local" => Ok(ProviderKind::Local),
        "ollama" => Ok(ProviderKind::Ollama),
        other => Err(format!("Unknown LLM provider: '{other}'")),
    }
}

/// Resolve a local/ollama `base_url`, defaulting to [`DEFAULT_LOCAL_BASE_URL`] when unset/empty.
fn resolve_base_url(base_url: Option<String>) -> String {
    base_url.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| DEFAULT_LOCAL_BASE_URL.to_string())
}

/// A concrete, dispatch-by-enum wrapper over every [`LlmProvider`]. The trait uses `async fn`, so it
/// isn't object-safe (`Box<dyn LlmProvider>` won't compile) — this enum is the single concrete type
/// both call sites (the `llm_complete` command + the `bsc-agent` loop) build via [`build_provider`]
/// and then call `complete`/`turn` on, instead of each repeating the 5-arm construction match (#1845).
pub enum Provider {
    Anthropic(AnthropicProvider),
    OpenAi(OpenAiProvider),
    Gemini(GeminiProvider),
    Local(LocalProvider),
    Ollama(OllamaProvider),
}

impl Provider {
    /// The model's usable context window in tokens — the budget the `bsc-agent` loop compacts older
    /// turns against (#1831). Ollama: the `num_ctx` we send (sized from the detected context, clamped),
    /// else 8192. Local (generic OpenAI-compat): a conservative 8192. Hosted models have large
    /// contexts, so a high value (compaction effectively never fires for them).
    pub fn context_budget_tokens(&self) -> usize {
        match self {
            Provider::Ollama(p) => p.num_ctx().unwrap_or(8192) as usize,
            Provider::Local(_) => 8192,
            _ => 200_000,
        }
    }
}

impl LlmProvider for Provider {
    async fn complete(&self, req: &LlmRequest, api_key: &str) -> Result<serde_json::Value, String> {
        match self {
            Provider::Anthropic(p) => p.complete(req, api_key).await,
            Provider::OpenAi(p) => p.complete(req, api_key).await,
            Provider::Gemini(p) => p.complete(req, api_key).await,
            Provider::Local(p) => p.complete(req, api_key).await,
            Provider::Ollama(p) => p.complete(req, api_key).await,
        }
    }
    async fn turn(&self, t: &Turn, api_key: &str) -> Result<TurnResult, String> {
        match self {
            Provider::Anthropic(p) => p.turn(t, api_key).await,
            Provider::OpenAi(p) => p.turn(t, api_key).await,
            Provider::Gemini(p) => p.turn(t, api_key).await,
            Provider::Local(p) => p.turn(t, api_key).await,
            Provider::Ollama(p) => p.turn(t, api_key).await,
        }
    }
}

/// Construct the [`Provider`] for a [`ProviderKind`] — the ONE provider-construction site (#1845),
/// replacing the identical 5-arm match the `llm_complete` command and the `bsc-agent` loop each had.
/// `base_url` is used only for `local`/`ollama` (resolved to [`DEFAULT_LOCAL_BASE_URL`] when
/// unset/empty); `ollama_profile` is the tool-using path's pre-detected `/api/show` profile (`None` ⇒
/// the generic profile, which is correct for the one-shot `complete` path that doesn't tool-call).
pub fn build_provider(
    kind: ProviderKind,
    base_url: Option<String>,
    ollama_profile: Option<OllamaProfile>,
    num_ctx_cap: Option<u64>,
) -> Provider {
    match kind {
        ProviderKind::Anthropic => Provider::Anthropic(AnthropicProvider),
        ProviderKind::OpenAi => Provider::OpenAi(OpenAiProvider),
        ProviderKind::Gemini => Provider::Gemini(GeminiProvider),
        ProviderKind::Local => Provider::Local(LocalProvider { base_url: resolve_base_url(base_url) }),
        ProviderKind::Ollama => {
            let base = resolve_base_url(base_url);
            let provider = match ollama_profile {
                Some(p) => OllamaProvider::with_profile(base, p),
                None => OllamaProvider::new(base),
            };
            // The user's per-agent context cap (VRAM-bound, $BSC_AGENT_NUM_CTX) overrides the default
            // num_ctx ceiling sized from the detected context length (#1829).
            let provider = match num_ctx_cap {
                Some(cap) => provider.with_num_ctx_cap(cap),
                None => provider,
            };
            Provider::Ollama(provider)
        }
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
        assert!(matches!(resolve_provider("ollama"), Ok(ProviderKind::Ollama)));
        assert!(resolve_provider("mistral").is_err());
        assert!(resolve_provider("").is_err());
    }

    #[test]
    fn build_provider_maps_each_kind_and_resolves_base() {
        assert!(matches!(build_provider(ProviderKind::Anthropic, None, None, None), Provider::Anthropic(_)));
        assert!(matches!(build_provider(ProviderKind::OpenAi, None, None, None), Provider::OpenAi(_)));
        assert!(matches!(build_provider(ProviderKind::Gemini, None, None, None), Provider::Gemini(_)));
        // local/ollama default the base url when unset or blank.
        match build_provider(ProviderKind::Local, None, None, None) {
            Provider::Local(p) => assert_eq!(p.base_url, DEFAULT_LOCAL_BASE_URL),
            _ => panic!("expected Local"),
        }
        match build_provider(ProviderKind::Local, Some("   ".into()), None, None) {
            Provider::Local(p) => assert_eq!(p.base_url, DEFAULT_LOCAL_BASE_URL), // blank → default
            _ => panic!("expected Local"),
        }
        match build_provider(ProviderKind::Local, Some("http://10.0.0.5:8080/v1".into()), None, None) {
            Provider::Local(p) => assert_eq!(p.base_url, "http://10.0.0.5:8080/v1"),
            _ => panic!("expected Local"),
        }
        // ollama: generic profile (None) for the one-shot path, or a pre-detected profile.
        assert!(matches!(build_provider(ProviderKind::Ollama, None, None, None), Provider::Ollama(_)));
        let profile = OllamaProfile { supports_tools: false, stop: vec![], context_length: Some(131072) };
        // The $BSC_AGENT_NUM_CTX cap clamps num_ctx below the detected context length (#1829).
        match build_provider(ProviderKind::Ollama, None, Some(profile), Some(8192)) {
            Provider::Ollama(p) => assert_eq!(p.num_ctx(), Some(8192)),
            _ => panic!("expected Ollama"),
        }
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
