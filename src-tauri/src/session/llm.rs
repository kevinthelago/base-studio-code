
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
    // Local / Ollama need no API key; every hosted provider does.
    if api_key.is_empty() && !matches!(kind, ::llm::ProviderKind::Local | ::llm::ProviderKind::Ollama) {
        return Err("No API key configured. Add it in Settings → Integrations.".to_string());
    }
    let req = ::llm::LlmRequest {
        model: model.unwrap_or_else(|| "claude-sonnet-4-6".to_string()),
        system,
        messages,
        tools,
        max_tokens: 4096,
    };
    // Build the provider once via the shared factory (#1845). The one-shot completion path doesn't
    // tool-call, so Ollama uses the generic profile (no `/api/show` round-trip needed here).
    let provider = ::llm::build_provider(kind, base_url, None, None);
    provider.complete(&req, &api_key).await
}

/// List the models installed on the local Ollama endpoint (#1830) — drives the Settings model
/// dropdown + the "test connection" button. `base_url` defaults to Ollama's local endpoint; an `Err`
/// means the endpoint is unreachable (Ollama not running / wrong URL).
#[tauri::command]
pub(crate) async fn ollama_models(base_url: Option<String>) -> Result<Vec<String>, String> {
    let base = base_url
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| ::llm::DEFAULT_LOCAL_BASE_URL.to_string());
    ::llm::list_models(&base).await
}
