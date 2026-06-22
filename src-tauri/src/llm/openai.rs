//! OpenAI Chat Completions provider (api.openai.com). Maps OpenAI's request/response
//! onto the normalized shape: the system prompt is folded in as a leading
//! `{role:"system"}` message, and `choices[0].message.content` becomes a single
//! `{type:"text", text}` block so kb_chat's consumers read it unchanged.

use super::{LlmProvider, LlmRequest};

pub struct OpenAiProvider;

/// The token-limit field this model expects. Newer OpenAI models (o-series and
/// gpt-5-class) reject `max_tokens` and require `max_completion_tokens`; older
/// models (gpt-4o, gpt-4, gpt-3.5, …) take `max_tokens`. Ollama's OpenAI-compatible
/// endpoint (reused by the local provider) accepts `max_tokens` for its models too.
pub(crate) fn token_param(model: &str) -> &'static str {
    let m = model.to_ascii_lowercase();
    if m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o4") || m.starts_with("gpt-5") {
        "max_completion_tokens"
    } else {
        "max_tokens"
    }
}

/// Build the OpenAI `/v1/chat/completions` request body. OpenAI has no top-level
/// `system` field, so a non-empty system prompt is prepended as the first message.
/// The token-limit field name varies by model (see [`token_param`]).
/// Pure — extracted so it can be unit-tested without I/O (and reused by the local provider).
pub(crate) fn build_request_body(req: &LlmRequest) -> serde_json::Value {
    let mut messages: Vec<serde_json::Value> = Vec::with_capacity(req.messages.len() + 1);
    if !req.system.is_empty() {
        messages.push(serde_json::json!({ "role": "system", "content": req.system }));
    }
    messages.extend(req.messages.iter().cloned());
    let mut body = serde_json::json!({
        "model": req.model,
        "messages": messages,
    });
    body[token_param(&req.model)] = serde_json::json!(req.max_tokens);
    body
}

/// Map an OpenAI chat-completions response into the normalized response shape:
/// `choices[0].message.content` -> a single text block; `usage` carried through.
/// Pure — extracted so it can be unit-tested without I/O (and reused by the local provider).
pub(crate) fn normalize_response(raw: &serde_json::Value) -> serde_json::Value {
    let text = raw["choices"][0]["message"]["content"].as_str().unwrap_or("");
    serde_json::json!({
        "content": [ { "type": "text", "text": text } ],
        "usage": raw.get("usage").cloned().unwrap_or(serde_json::Value::Null),
    })
}

impl LlmProvider for OpenAiProvider {
    async fn complete(&self, req: &LlmRequest, api_key: &str) -> Result<serde_json::Value, String> {
        let client = reqwest::Client::new();
        let response = client
            .post("https://api.openai.com/v1/chat/completions")
            .header("authorization", format!("Bearer {}", api_key))
            .header("content-type", "application/json")
            .json(&build_request_body(req))
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
        Ok(normalize_response(&json))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_req() -> LlmRequest {
        LlmRequest {
            model: "gpt-x".into(),
            system: "be terse".into(),
            messages: vec![serde_json::json!({"role":"user","content":"hi"})],
            tools: vec![],
            max_tokens: 4096,
        }
    }

    #[test]
    fn build_request_folds_system_in_as_first_message() {
        let body = build_request_body(&sample_req());
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "be terse");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(body["model"], "gpt-x");
        assert_eq!(body["max_tokens"], 4096);
    }

    #[test]
    fn build_request_omits_empty_system() {
        let mut req = sample_req();
        req.system = String::new();
        let body = build_request_body(&req);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
    }

    #[test]
    fn normalize_maps_content_and_carries_usage() {
        let raw = serde_json::json!({
            "choices": [ { "message": { "role": "assistant", "content": "hello there" } } ],
            "usage": { "prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5 }
        });
        let norm = normalize_response(&raw);
        assert_eq!(norm["content"][0]["type"], "text");
        assert_eq!(norm["content"][0]["text"], "hello there");
        assert_eq!(norm["usage"]["total_tokens"], 5);
    }

    #[test]
    fn normalize_tolerates_missing_content_and_usage() {
        let raw = serde_json::json!({ "choices": [ { "message": { "role": "assistant" } } ] });
        let norm = normalize_response(&raw);
        assert_eq!(norm["content"][0]["text"], "");
        assert!(norm["usage"].is_null());
    }

    #[test]
    fn token_param_selects_field_by_model() {
        // Older models take max_tokens.
        assert_eq!(token_param("gpt-4o"), "max_tokens");
        assert_eq!(token_param("gpt-4-turbo"), "max_tokens");
        assert_eq!(token_param("gpt-3.5-turbo"), "max_tokens");
        // o-series and gpt-5-class require max_completion_tokens.
        assert_eq!(token_param("o1-preview"), "max_completion_tokens");
        assert_eq!(token_param("o3-mini"), "max_completion_tokens");
        assert_eq!(token_param("o4-mini"), "max_completion_tokens");
        assert_eq!(token_param("gpt-5"), "max_completion_tokens");
        assert_eq!(token_param("gpt-5-mini"), "max_completion_tokens");
    }

    #[test]
    fn build_request_uses_completion_token_field_for_new_models() {
        let mut req = sample_req();
        req.model = "o3-mini".into();
        let body = build_request_body(&req);
        assert_eq!(body["max_completion_tokens"], 4096);
        assert!(body.get("max_tokens").is_none());
    }
}
