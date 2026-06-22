//! Anthropic Messages API provider (api.anthropic.com). Returns Anthropic's native
//! response JSON unchanged — it already carries `content` blocks (text + any
//! `tool_use`) and `usage`, which is exactly the normalized shape kb_chat returns.

use super::{LlmProvider, LlmRequest};

pub struct AnthropicProvider;

/// Build the Anthropic `/v1/messages` request body (top-level `system`, native
/// `messages` + `tools`). Pure — extracted so it can be unit-tested without I/O.
pub(super) fn build_request_body(req: &LlmRequest) -> serde_json::Value {
    serde_json::json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "system": req.system,
        "messages": req.messages,
        "tools": req.tools,
    })
}

impl LlmProvider for AnthropicProvider {
    async fn complete(&self, req: &LlmRequest, api_key: &str) -> Result<serde_json::Value, String> {
        let client = reqwest::Client::new();
        let response = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
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
        Ok(json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_request_carries_system_messages_and_tools() {
        let req = LlmRequest {
            model: "claude-sonnet-4-6".into(),
            system: "be terse".into(),
            messages: vec![serde_json::json!({"role":"user","content":"hi"})],
            tools: vec![serde_json::json!({"name":"t"})],
            max_tokens: 4096,
        };
        let body = build_request_body(&req);
        assert_eq!(body["model"], "claude-sonnet-4-6");
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["system"], "be terse");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["tools"][0]["name"], "t");
    }
}
