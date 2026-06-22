//! Anthropic Messages API provider (api.anthropic.com). Returns Anthropic's native
//! response JSON unchanged — it already carries `content` blocks (text + any
//! `tool_use`) and `usage`, which is exactly the normalized shape kb_chat returns.

use super::{LlmProvider, LlmRequest, Msg, ToolCall, Turn, TurnResult};

pub struct AnthropicProvider;

/// Map the normalized messages onto Anthropic's `messages` array. Assistant turns
/// carry `text` + `tool_use` blocks; tool results become `tool_result` blocks in a
/// user message. Consecutive `ToolResult`s are coalesced into ONE user message —
/// Anthropic requires strict user/assistant alternation and groups parallel tool
/// results together.
fn build_messages(msgs: &[Msg]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < msgs.len() {
        match &msgs[i] {
            Msg::User(s) => {
                out.push(serde_json::json!({ "role": "user", "content": s }));
                i += 1;
            }
            Msg::Assistant { text, tool_calls } => {
                let mut content = Vec::new();
                if !text.is_empty() {
                    content.push(serde_json::json!({ "type": "text", "text": text }));
                }
                for tc in tool_calls {
                    content.push(serde_json::json!({
                        "type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.args
                    }));
                }
                out.push(serde_json::json!({ "role": "assistant", "content": content }));
                i += 1;
            }
            Msg::ToolResult { .. } => {
                let mut blocks = Vec::new();
                while let Some(Msg::ToolResult { id, content }) = msgs.get(i) {
                    blocks.push(serde_json::json!({
                        "type": "tool_result", "tool_use_id": id, "content": content
                    }));
                    i += 1;
                }
                out.push(serde_json::json!({ "role": "user", "content": blocks }));
            }
        }
    }
    out
}

/// Build the Anthropic `/v1/messages` request body for a tool-using turn.
/// Pure — unit-testable without I/O.
pub(crate) fn turn_request_body(t: &Turn) -> serde_json::Value {
    let tools: Vec<serde_json::Value> = t
        .tools
        .iter()
        .map(|d| serde_json::json!({ "name": d.name, "description": d.description, "input_schema": d.schema }))
        .collect();
    serde_json::json!({
        "model": t.model,
        "max_tokens": t.max_tokens,
        "system": t.system,
        "messages": build_messages(&t.messages),
        "tools": tools,
    })
}

/// Parse an Anthropic response into a [`TurnResult`]: text from `text` blocks,
/// tool calls from `tool_use` blocks. Pure — unit-testable without I/O.
pub(crate) fn parse_turn_response(raw: &serde_json::Value) -> TurnResult {
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    if let Some(blocks) = raw["content"].as_array() {
        for b in blocks {
            match b["type"].as_str() {
                Some("text") => text.push_str(b["text"].as_str().unwrap_or("")),
                Some("tool_use") => tool_calls.push(ToolCall {
                    id: b["id"].as_str().unwrap_or("").to_string(),
                    name: b["name"].as_str().unwrap_or("").to_string(),
                    args: b["input"].clone(),
                }),
                _ => {}
            }
        }
    }
    TurnResult {
        text,
        tool_calls,
        usage: raw.get("usage").cloned().unwrap_or(serde_json::Value::Null),
        stop_reason: raw["stop_reason"].as_str().unwrap_or("").to_string(),
    }
}

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

    async fn turn(&self, t: &Turn, api_key: &str) -> Result<TurnResult, String> {
        let client = reqwest::Client::new();
        let response = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&turn_request_body(t))
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;
        let status = response.status();
        let json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;
        if !status.is_success() {
            let err = json["error"]["message"].as_str().unwrap_or("Unknown error").to_string();
            return Err(format!("API error ({}): {}", status, err));
        }
        Ok(parse_turn_response(&json))
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

    use super::super::{Msg, ToolCall, ToolDef, Turn};

    fn turn_with_tool_and_result() -> Turn {
        Turn {
            system: "be terse".into(),
            model: "claude-sonnet-4-6".into(),
            max_tokens: 4096,
            tools: vec![ToolDef {
                name: "read_file".into(),
                description: "read a file".into(),
                schema: serde_json::json!({"type":"object","properties":{"path":{"type":"string"}}}),
            }],
            messages: vec![
                Msg::User("read x".into()),
                Msg::Assistant {
                    text: "ok".into(),
                    tool_calls: vec![ToolCall { id: "c1".into(), name: "read_file".into(), args: serde_json::json!({"path":"x"}) }],
                },
                Msg::ToolResult { id: "c1".into(), content: "FILE BODY".into() },
            ],
        }
    }

    #[test]
    fn turn_request_maps_tools_tooluse_and_toolresult() {
        let body = turn_request_body(&turn_with_tool_and_result());
        // tool def -> input_schema
        assert_eq!(body["tools"][0]["name"], "read_file");
        assert!(body["tools"][0]["input_schema"]["properties"]["path"].is_object());
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "user");
        // assistant carries a text block + a tool_use block
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"][0]["type"], "text");
        assert_eq!(msgs[1]["content"][1]["type"], "tool_use");
        assert_eq!(msgs[1]["content"][1]["id"], "c1");
        assert_eq!(msgs[1]["content"][1]["input"]["path"], "x");
        // tool result -> user message with a tool_result block
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
        assert_eq!(msgs[2]["content"][0]["tool_use_id"], "c1");
        assert_eq!(msgs[2]["content"][0]["content"], "FILE BODY");
    }

    #[test]
    fn turn_request_coalesces_consecutive_tool_results() {
        let mut t = turn_with_tool_and_result();
        t.messages.push(Msg::ToolResult { id: "c2".into(), content: "SECOND".into() });
        let body = turn_request_body(&t);
        let msgs = body["messages"].as_array().unwrap();
        // the two trailing ToolResults collapse into a single user message, two blocks
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[2]["content"].as_array().unwrap().len(), 2);
        assert_eq!(msgs[2]["content"][1]["tool_use_id"], "c2");
    }

    #[test]
    fn parse_turn_extracts_text_and_tool_calls() {
        let raw = serde_json::json!({
            "content": [
                {"type":"text","text":"sure"},
                {"type":"tool_use","id":"c9","name":"read_file","input":{"path":"y"}}
            ],
            "usage": {"input_tokens": 5, "output_tokens": 7},
            "stop_reason": "tool_use"
        });
        let r = parse_turn_response(&raw);
        assert_eq!(r.text, "sure");
        assert_eq!(r.stop_reason, "tool_use");
        assert_eq!(r.usage["input_tokens"], 5);
        assert_eq!(r.tool_calls.len(), 1);
        assert_eq!(r.tool_calls[0].id, "c9");
        assert_eq!(r.tool_calls[0].name, "read_file");
        assert_eq!(r.tool_calls[0].args["path"], "y");
    }
}
