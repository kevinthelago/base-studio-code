
/// Provider-agnostic one-shot chat completion (#1079 / epic #1078). Dispatches to
/// the `provider` (default `"anthropic"`) via the [`llm`] layer; every provider
/// normalizes its reply to `{ content: [...], usage }`, so callers are unchanged.
/// `provider`/`model` are optional — omitting them preserves the legacy Anthropic
/// `claude-sonnet-4-6` behavior verbatim.
///
/// This module shares its name with the `llm` crate it dispatches to, so the crate is
/// referenced as `::llm` (a leading `::` resolves to the extern crate, not this module).
#[tauri::command]
pub(crate) async fn llm_complete(
    messages: Vec<serde_json::Value>,
    system: String,
    tools: Vec<serde_json::Value>,
    api_key: String,
    provider: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<serde_json::Value, String> {
    use ::llm::LlmProvider;
    let provider = provider.unwrap_or_else(|| "anthropic".to_string());
    let kind = ::llm::resolve_provider(&provider)?;
    // Local (Ollama) needs no API key; every hosted provider does.
    if api_key.is_empty() && !matches!(kind, ::llm::ProviderKind::Local) {
        return Err("No API key configured. Add it in Settings → Integrations.".to_string());
    }
    let req = ::llm::LlmRequest {
        model: model.unwrap_or_else(|| "claude-sonnet-4-6".to_string()),
        system,
        messages,
        tools,
        max_tokens: 4096,
    };
    match kind {
        ::llm::ProviderKind::Anthropic => ::llm::AnthropicProvider.complete(&req, &api_key).await,
        ::llm::ProviderKind::OpenAi => ::llm::OpenAiProvider.complete(&req, &api_key).await,
        ::llm::ProviderKind::Gemini => ::llm::GeminiProvider.complete(&req, &api_key).await,
        ::llm::ProviderKind::Local => {
            let base = base_url
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| ::llm::DEFAULT_LOCAL_BASE_URL.to_string());
            ::llm::LocalProvider { base_url: base }.complete(&req, &api_key).await
        }
    }
}
