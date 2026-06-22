//! OpenAI Chat Completions provider (api.openai.com). Maps OpenAI's request/response
//! onto the normalized shape: the system prompt is folded in as a leading
//! `{role:"system"}` message, and `choices[0].message.content` becomes a single
//! `{type:"text", text}` block so kb_chat's consumers read it unchanged.

use super::{LlmProvider, LlmRequest};

pub struct OpenAiProvider;

/// Build the OpenAI `/v1/chat/completions` request body. OpenAI has no top-level
/// `system` field, so a non-empty system prompt is prepended as the first message.
/// Pure — extracted so it can be unit-tested without I/O.
pub(super) fn build_request_body(req: &LlmRequest) -> serde_json::Value {
    let mut messages: Vec<serde_json::Value> = Vec::with_capacity(req.messages.len() + 1);
    if !req.system.is_empty() {
        messages.push(serde_json::json!({ "role": "system", "content": req.system }));
    }
    messages.extend(req.messages.iter().cloned());
    serde_json::json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "messages": messages,
    })
}

/// Map an OpenAI chat-completions response into the normalized response shape:
/// `choices[0].message.content` -> a single text block; `usage` carried through.
/// Pure — extracted so it can be unit-tested without I/O.
pub(super) fn normalize_response(raw: &serde_json::Value) -> serde_json::Value {
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
}
