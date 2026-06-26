//! OpenAI Chat Completions provider (api.openai.com). Maps OpenAI's request/response
//! onto the normalized shape: the system prompt is folded in as a leading
//! `{role:"system"}` message, and `choices[0].message.content` becomes a single
//! `{type:"text", text}` block so llm_complete's consumers read it unchanged.

use super::{post_json, usage_u64, LlmProvider, LlmRequest, Msg, ToolCall, Turn, TurnResult};

pub struct OpenAiProvider;

/// Map the normalized messages onto OpenAI's chat messages. Assistant tool calls
/// become `tool_calls` (args serialized to a JSON string, as OpenAI requires);
/// each tool result is its own `{role:"tool", tool_call_id, content}` message.
pub(crate) fn build_turn_messages(t: &Turn) -> Vec<serde_json::Value> {
    let mut msgs = Vec::new();
    if !t.system.is_empty() {
        msgs.push(serde_json::json!({ "role": "system", "content": t.system }));
    }
    for m in &t.messages {
        match m {
            Msg::User(s) => msgs.push(serde_json::json!({ "role": "user", "content": s })),
            Msg::Assistant { text, tool_calls } => {
                let calls: Vec<serde_json::Value> = tool_calls
                    .iter()
                    .map(|tc| {
                        serde_json::json!({
                            "id": tc.id,
                            "type": "function",
                            "function": { "name": tc.name, "arguments": tc.args.to_string() }
                        })
                    })
                    .collect();
                let mut am = serde_json::json!({ "role": "assistant", "content": text });
                if !calls.is_empty() {
                    am["tool_calls"] = serde_json::Value::Array(calls);
                }
                msgs.push(am);
            }
            Msg::ToolResult { id, content } => msgs.push(serde_json::json!({
                "role": "tool", "tool_call_id": id, "content": content
            })),
        }
    }
    msgs
}

/// Build the OpenAI `/v1/chat/completions` request body for a tool-using turn.
/// Pure — unit-testable without I/O (reused by the local provider).
pub(crate) fn turn_request_body(t: &Turn) -> serde_json::Value {
    let tools: Vec<serde_json::Value> = t
        .tools
        .iter()
        .map(|d| serde_json::json!({
            "type": "function",
            "function": { "name": d.name, "description": d.description, "parameters": d.schema }
        }))
        .collect();
    let mut body = serde_json::json!({
        "model": t.model,
        "messages": build_turn_messages(t),
    });
    if !tools.is_empty() {
        body["tools"] = serde_json::Value::Array(tools);
    }
    body[token_param(&t.model)] = serde_json::json!(t.max_tokens);
    body
}

/// Normalize OpenAI usage (`prompt_tokens`/`completion_tokens`) to the canonical
/// 4-key shape `tokens.rs` parses; OpenAI has no prompt-cache split, so cache_* = 0.
/// Shared by the `local` provider (OpenAI-compatible). Pure.
pub(crate) fn normalize_usage(u: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "input_tokens": usage_u64(u, "prompt_tokens"),
        "output_tokens": usage_u64(u, "completion_tokens"),
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    })
}

/// Parse an OpenAI response into a [`TurnResult`]. `tool_calls[].function.arguments`
/// is a JSON string, parsed back into `args`. Pure — unit-testable (reused by local).
pub(crate) fn parse_turn_response(raw: &serde_json::Value) -> TurnResult {
    let msg = &raw["choices"][0]["message"];
    let text = msg["content"].as_str().unwrap_or("").to_string();
    let tool_calls = msg["tool_calls"]
        .as_array()
        .map(|calls| {
            calls
                .iter()
                .map(|c| ToolCall {
                    id: c["id"].as_str().unwrap_or("").to_string(),
                    name: c["function"]["name"].as_str().unwrap_or("").to_string(),
                    args: c["function"]["arguments"]
                        .as_str()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or(serde_json::Value::Null),
                })
                .collect()
        })
        .unwrap_or_default();
    TurnResult {
        text,
        tool_calls,
        usage: normalize_usage(raw.get("usage").unwrap_or(&serde_json::Value::Null)),
        stop_reason: raw["choices"][0]["finish_reason"].as_str().unwrap_or("").to_string(),
    }
}

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
        let json = post_json(
            "https://api.openai.com/v1/chat/completions",
            &[("authorization", format!("Bearer {}", api_key))],
            &build_request_body(req),
        )
        .await?;
        Ok(normalize_response(&json))
    }

    async fn turn(&self, t: &Turn, api_key: &str) -> Result<TurnResult, String> {
        let json = post_json(
            "https://api.openai.com/v1/chat/completions",
            &[("authorization", format!("Bearer {}", api_key))],
            &turn_request_body(t),
        )
        .await?;
        Ok(parse_turn_response(&json))
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

    use super::super::{Msg, ToolCall, ToolDef, Turn};

    fn sample_turn() -> Turn {
        Turn {
            system: "be terse".into(),
            model: "gpt-4o".into(),
            max_tokens: 4096,
            tools: vec![ToolDef {
                name: "read_file".into(),
                description: "read a file".into(),
                schema: serde_json::json!({"type":"object","properties":{"path":{"type":"string"}}}),
            }],
            messages: vec![
                Msg::User("read x".into()),
                Msg::Assistant {
                    text: String::new(),
                    tool_calls: vec![ToolCall { id: "call_1".into(), name: "read_file".into(), args: serde_json::json!({"path":"x"}) }],
                },
                Msg::ToolResult { id: "call_1".into(), content: "FILE BODY".into() },
            ],
        }
    }

    #[test]
    fn turn_request_maps_tools_toolcalls_and_toolmsg() {
        let body = turn_request_body(&sample_turn());
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "read_file");
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
        // assistant carries tool_calls with args serialized to a JSON string
        assert_eq!(msgs[2]["role"], "assistant");
        assert_eq!(msgs[2]["tool_calls"][0]["id"], "call_1");
        assert_eq!(msgs[2]["tool_calls"][0]["function"]["name"], "read_file");
        assert_eq!(msgs[2]["tool_calls"][0]["function"]["arguments"], "{\"path\":\"x\"}");
        // tool result -> role:tool message
        assert_eq!(msgs[3]["role"], "tool");
        assert_eq!(msgs[3]["tool_call_id"], "call_1");
        assert_eq!(msgs[3]["content"], "FILE BODY");
    }

    #[test]
    fn parse_turn_extracts_text_and_tool_calls() {
        let raw = serde_json::json!({
            "choices": [ {
                "message": {
                    "role": "assistant",
                    "content": "sure",
                    "tool_calls": [ { "id": "call_9", "type": "function",
                        "function": { "name": "read_file", "arguments": "{\"path\":\"y\"}" } } ]
                },
                "finish_reason": "tool_calls"
            } ],
            "usage": { "prompt_tokens": 4, "completion_tokens": 7, "total_tokens": 11 }
        });
        let r = parse_turn_response(&raw);
        assert_eq!(r.text, "sure");
        assert_eq!(r.stop_reason, "tool_calls");
        // usage is normalized to the canonical shape tokens.rs parses
        assert_eq!(r.usage["input_tokens"], 4);
        assert_eq!(r.usage["output_tokens"], 7);
        assert_eq!(r.usage["cache_read_input_tokens"], 0);
        assert_eq!(r.tool_calls.len(), 1);
        assert_eq!(r.tool_calls[0].id, "call_9");
        assert_eq!(r.tool_calls[0].name, "read_file");
        assert_eq!(r.tool_calls[0].args["path"], "y"); // arguments JSON string parsed back to a value
    }

    #[test]
    fn normalize_usage_maps_prompt_completion_to_canonical() {
        let u = normalize_usage(&serde_json::json!({ "prompt_tokens": 9, "completion_tokens": 4, "total_tokens": 13 }));
        assert_eq!(u["input_tokens"], 9);
        assert_eq!(u["output_tokens"], 4);
        assert_eq!(u["cache_creation_input_tokens"], 0);
        assert_eq!(u["cache_read_input_tokens"], 0);
    }
}
