//! Model-agnostic LLM provider layer (#1079 / epic #1078).
//!
//! `kb_chat` builds a normalized [`LlmRequest`] and dispatches to a provider; each
//! provider returns the existing `{ "content": [...], "usage": {...} }` response
//! shape, so kb_chat's consumers (`oneShotComplete`, `gradeLLM`) are unchanged
//! across providers. This is the same provider abstraction `bsc-agent` will reuse.

mod anthropic;
mod gemini;
mod local;
mod openai;

pub use anthropic::AnthropicProvider;
pub use gemini::GeminiProvider;
pub use local::{LocalProvider, DEFAULT_LOCAL_BASE_URL};
pub use openai::OpenAiProvider;

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
#[allow(async_fn_in_trait)]
pub trait LlmProvider {
    async fn complete(&self, req: &LlmRequest, api_key: &str) -> Result<serde_json::Value, String>;
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
}
