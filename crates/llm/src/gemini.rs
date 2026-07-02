//! Google Gemini (Generative Language API) provider. Maps the normalized request
//! onto Gemini's `contents` / `systemInstruction` shape, and folds the response's
//! `candidates[0].content.parts[].text` back into the normalized `{content,usage}`
//! so llm_complete's consumers read it unchanged.

use super::{canonical_usage, post_json, tool_decl_inner, usage_u64, LlmProvider, LlmRequest, Msg, ToolCall, Turn, TurnResult};

/// Map `tools` onto Gemini's `[{ functionDeclarations: [...] }]` shape (its one wrapper). Shared by the
/// tool-using `turn` path and the one-shot `complete` path so both attach tools identically.
fn function_declarations(tools: &[super::ToolDef]) -> serde_json::Value {
    let decls: Vec<serde_json::Value> = tools.iter().map(tool_decl_inner).collect();
    serde_json::json!([ { "functionDeclarations": decls } ])
}

pub struct GeminiProvider;

/// Map the normalized messages onto Gemini `contents`. Assistant tool calls become
/// `functionCall` parts; tool results become `functionResponse` parts. Gemini keys
/// responses by the function NAME (not an id), so the round-trip uses `ToolCall.id`
/// = the function name (see [`parse_turn_response`]). Consecutive tool results
/// collapse into one user message with multiple `functionResponse` parts.
fn build_contents(msgs: &[Msg]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < msgs.len() {
        match &msgs[i] {
            Msg::User(s) => {
                out.push(serde_json::json!({ "role": "user", "parts": [ { "text": s } ] }));
                i += 1;
            }
            Msg::Assistant { text, tool_calls } => {
                let mut parts = Vec::new();
                if !text.is_empty() {
                    parts.push(serde_json::json!({ "text": text }));
                }
                for tc in tool_calls {
                    parts.push(serde_json::json!({ "functionCall": { "name": tc.name, "args": tc.args } }));
                }
                out.push(serde_json::json!({ "role": "model", "parts": parts }));
                i += 1;
            }
            Msg::ToolResult { .. } => {
                let mut parts = Vec::new();
                while let Some(Msg::ToolResult { id, content }) = msgs.get(i) {
                    // `id` carries the function name for Gemini's name-keyed responses.
                    parts.push(serde_json::json!({
                        "functionResponse": { "name": id, "response": { "content": content } }
                    }));
                    i += 1;
                }
                out.push(serde_json::json!({ "role": "user", "parts": parts }));
            }
        }
    }
    out
}

/// Build the Gemini `:generateContent` request body for a tool-using turn.
/// Pure — unit-testable without I/O.
pub(crate) fn turn_request_body(t: &Turn) -> serde_json::Value {
    let mut body = serde_json::json!({
        "contents": build_contents(&t.messages),
        "generationConfig": { "maxOutputTokens": t.max_tokens },
    });
    if !t.system.is_empty() {
        body["systemInstruction"] = serde_json::json!({ "parts": [ { "text": t.system } ] });
    }
    if !t.tools.is_empty() {
        body["tools"] = function_declarations(&t.tools);
    }
    body
}

/// Normalize Gemini usage (`usageMetadata.promptTokenCount`/`candidatesTokenCount`)
/// to the canonical 4-key shape `tokens.rs` parses; Gemini has no prompt-cache split,
/// so cache_* = 0. Pure.
pub(crate) fn normalize_usage(u: &serde_json::Value) -> serde_json::Value {
    canonical_usage(usage_u64(u, "promptTokenCount"), usage_u64(u, "candidatesTokenCount"))
}

/// Parse a Gemini response into a [`TurnResult`]: text from `text` parts, tool
/// calls from `functionCall` parts (id synthesized from the name). Pure.
pub(crate) fn parse_turn_response(raw: &serde_json::Value) -> TurnResult {
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    if let Some(parts) = raw["candidates"][0]["content"]["parts"].as_array() {
        for p in parts {
            if let Some(s) = p["text"].as_str() {
                text.push_str(s);
            }
            if let Some(fc) = p.get("functionCall") {
                let name = fc["name"].as_str().unwrap_or("").to_string();
                tool_calls.push(ToolCall {
                    id: name.clone(), // Gemini has no call id; round-trip by name
                    name,
                    args: fc.get("args").cloned().unwrap_or(serde_json::Value::Null),
                });
            }
        }
    }
    let usage = normalize_usage(raw.get("usageMetadata").unwrap_or(&serde_json::Value::Null));
    TurnResult {
        text,
        tool_calls,
        usage,
        stop_reason: raw["candidates"][0]["finishReason"].as_str().unwrap_or("").to_string(),
    }
}

/// Gemini roles are `user` / `model` (assistant). Anything else maps to `user`.
fn gemini_role(msg: &serde_json::Value) -> &'static str {
    match msg.get("role").and_then(|r| r.as_str()) {
        Some("assistant") | Some("model") => "model",
        _ => "user",
    }
}

/// The message text. Caller content is a string today; anything else is stringified
/// defensively rather than dropped.
fn message_text(msg: &serde_json::Value) -> String {
    match msg.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// Build the Gemini `:generateContent` request body. The system prompt becomes
/// `systemInstruction` (only when non-empty); messages become `contents`.
/// Pure — extracted so it can be unit-tested without I/O.
pub(crate) fn build_request_body(req: &LlmRequest) -> serde_json::Value {
    let contents: Vec<serde_json::Value> = req
        .messages
        .iter()
        .map(|m| serde_json::json!({ "role": gemini_role(m), "parts": [ { "text": message_text(m) } ] }))
        .collect();
    let mut body = serde_json::json!({
        "contents": contents,
        "generationConfig": { "maxOutputTokens": req.max_tokens },
    });
    if !req.system.is_empty() {
        body["systemInstruction"] = serde_json::json!({ "parts": [ { "text": req.system } ] });
    }
    // Attach tool declarations when the caller passes any (#2093) — the one-shot path formerly dropped
    // them, so a `complete` call with tools ran as if it had none. Gemini's `req.tools` are the raw
    // JSON the caller already speaks; each is expected to be a `{name, description, parameters/schema}`
    // object, mapped to Gemini's single `functionDeclarations` wrapper.
    let decls: Vec<serde_json::Value> = req
        .tools
        .iter()
        .map(|t| serde_json::json!({
            "name": t.get("name").cloned().unwrap_or(serde_json::Value::Null),
            "description": t.get("description").cloned().unwrap_or(serde_json::Value::Null),
            "parameters": t.get("parameters").or_else(|| t.get("schema")).cloned().unwrap_or(serde_json::Value::Null),
        }))
        .collect();
    if !decls.is_empty() {
        body["tools"] = serde_json::json!([ { "functionDeclarations": decls } ]);
    }
    body
}

/// Map a Gemini response into the normalized shape: join `candidates[0].content.parts[].text`
/// into one text block; map `usageMetadata` -> `usage`. Pure — unit-testable without I/O.
pub(crate) fn normalize_response(raw: &serde_json::Value) -> serde_json::Value {
    let text = raw["candidates"][0]["content"]["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    let usage = raw
        .get("usageMetadata")
        .map(|u| {
            serde_json::json!({
                "input_tokens": u.get("promptTokenCount").cloned().unwrap_or(serde_json::Value::Null),
                "output_tokens": u.get("candidatesTokenCount").cloned().unwrap_or(serde_json::Value::Null),
                "total_tokens": u.get("totalTokenCount").cloned().unwrap_or(serde_json::Value::Null),
            })
        })
        .unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "content": [ { "type": "text", "text": text } ],
        "usage": usage,
    })
}

/// Base URL for the Gemini Generative Language API. Production passes this; tests point
/// the `*_at` helpers at a localhost mock so the real send path is exercised offline.
pub(crate) const GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com";

/// The `:generateContent` endpoint for a base URL + model.
fn generate_content_url(base_url: &str, model: &str) -> String {
    format!("{base_url}/v1beta/models/{model}:generateContent")
}

impl GeminiProvider {
    /// `complete` against an arbitrary base URL (production passes [`GEMINI_BASE_URL`];
    /// tests point it at a localhost mock). Threading the base-url here lets the real
    /// send path (`post_json` + status/error handling) be exercised end-to-end without
    /// the network — the trait method below just supplies the production host.
    pub(crate) async fn complete_at(
        &self,
        base_url: &str,
        req: &LlmRequest,
        api_key: &str,
    ) -> Result<serde_json::Value, String> {
        let json = post_json(
            &generate_content_url(base_url, &req.model),
            &[("x-goog-api-key", api_key.to_string())],
            &build_request_body(req),
        )
        .await?;
        Ok(normalize_response(&json))
    }

    /// `turn` against an arbitrary base URL (see [`Self::complete_at`]).
    pub(crate) async fn turn_at(
        &self,
        base_url: &str,
        t: &Turn,
        api_key: &str,
    ) -> Result<TurnResult, String> {
        let json = post_json(
            &generate_content_url(base_url, &t.model),
            &[("x-goog-api-key", api_key.to_string())],
            &turn_request_body(t),
        )
        .await?;
        Ok(parse_turn_response(&json))
    }
}

impl LlmProvider for GeminiProvider {
    async fn complete(&self, req: &LlmRequest, api_key: &str) -> Result<serde_json::Value, String> {
        self.complete_at(GEMINI_BASE_URL, req, api_key).await
    }

    async fn turn(&self, t: &Turn, api_key: &str) -> Result<TurnResult, String> {
        self.turn_at(GEMINI_BASE_URL, t, api_key).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_request_maps_roles_and_system_instruction() {
        let req = LlmRequest {
            model: "gemini-x".into(),
            system: "be terse".into(),
            messages: vec![
                serde_json::json!({"role":"user","content":"hi"}),
                serde_json::json!({"role":"assistant","content":"yo"}),
            ],
            tools: vec![],
            max_tokens: 1024,
        };
        let body = build_request_body(&req);
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "be terse");
        assert_eq!(body["contents"][0]["role"], "user");
        assert_eq!(body["contents"][0]["parts"][0]["text"], "hi");
        assert_eq!(body["contents"][1]["role"], "model"); // assistant -> model
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 1024);
    }

    #[test]
    fn build_request_attaches_tools_on_the_one_shot_path() {
        // #2093 regression: the one-shot `complete` path formerly dropped tools (`// TODO tools`), so a
        // `complete` call with tools ran as if it had none. It must now map them to Gemini's single
        // `functionDeclarations` wrapper. One-shot `req.tools` are raw JSON `{name,description,parameters}`.
        let req = LlmRequest {
            model: "gemini-x".into(),
            system: String::new(),
            messages: vec![serde_json::json!({"role":"user","content":"hi"})],
            tools: vec![serde_json::json!({
                "name": "read_file",
                "description": "read a file",
                "parameters": {"type":"object","properties":{"path":{"type":"string"}}}
            })],
            max_tokens: 16,
        };
        let body = build_request_body(&req);
        assert_eq!(body["tools"][0]["functionDeclarations"][0]["name"], "read_file");
        assert_eq!(body["tools"][0]["functionDeclarations"][0]["description"], "read a file");
        assert_eq!(body["tools"][0]["functionDeclarations"][0]["parameters"]["type"], "object");
    }

    #[test]
    fn build_request_omits_tools_when_none_passed() {
        let req = LlmRequest {
            model: "gemini-x".into(),
            system: String::new(),
            messages: vec![serde_json::json!({"role":"user","content":"hi"})],
            tools: vec![],
            max_tokens: 16,
        };
        assert!(build_request_body(&req).get("tools").is_none());
    }

    #[test]
    fn build_request_omits_empty_system_instruction() {
        let req = LlmRequest {
            model: "gemini-x".into(),
            system: String::new(),
            messages: vec![serde_json::json!({"role":"user","content":"hi"})],
            tools: vec![],
            max_tokens: 16,
        };
        let body = build_request_body(&req);
        assert!(body.get("systemInstruction").is_none());
    }

    #[test]
    fn normalize_joins_parts_and_maps_usage() {
        let raw = serde_json::json!({
            "candidates": [ { "content": { "parts": [ {"text":"hello "}, {"text":"there"} ] } } ],
            "usageMetadata": { "promptTokenCount": 3, "candidatesTokenCount": 2, "totalTokenCount": 5 }
        });
        let norm = normalize_response(&raw);
        assert_eq!(norm["content"][0]["type"], "text");
        assert_eq!(norm["content"][0]["text"], "hello there");
        assert_eq!(norm["usage"]["total_tokens"], 5);
        assert_eq!(norm["usage"]["input_tokens"], 3);
    }

    #[test]
    fn normalize_tolerates_missing_candidates_and_usage() {
        let norm = normalize_response(&serde_json::json!({}));
        assert_eq!(norm["content"][0]["text"], "");
        assert!(norm["usage"].is_null());
    }

    use super::super::{Msg, ToolCall, ToolDef, Turn};

    #[test]
    fn turn_request_maps_functiondecls_call_and_response() {
        let t = Turn {
            system: "be terse".into(),
            model: "gemini-x".into(),
            max_tokens: 1024,
            tools: vec![ToolDef {
                name: "read_file".into(),
                description: "read a file".into(),
                schema: serde_json::json!({"type":"object","properties":{"path":{"type":"string"}}}),
            }],
            messages: vec![
                Msg::User("read x".into()),
                Msg::Assistant {
                    text: String::new(),
                    tool_calls: vec![ToolCall { id: "read_file".into(), name: "read_file".into(), args: serde_json::json!({"path":"x"}) }],
                },
                Msg::ToolResult { id: "read_file".into(), content: "FILE BODY".into() },
            ],
        };
        let body = turn_request_body(&t);
        assert_eq!(body["tools"][0]["functionDeclarations"][0]["name"], "read_file");
        let c = body["contents"].as_array().unwrap();
        assert_eq!(c[1]["role"], "model");
        assert_eq!(c[1]["parts"][0]["functionCall"]["name"], "read_file");
        assert_eq!(c[1]["parts"][0]["functionCall"]["args"]["path"], "x");
        assert_eq!(c[2]["role"], "user");
        assert_eq!(c[2]["parts"][0]["functionResponse"]["name"], "read_file");
        assert_eq!(c[2]["parts"][0]["functionResponse"]["response"]["content"], "FILE BODY");
    }

    #[test]
    fn parse_turn_extracts_text_and_function_calls() {
        let raw = serde_json::json!({
            "candidates": [ {
                "content": { "parts": [
                    { "text": "sure" },
                    { "functionCall": { "name": "read_file", "args": { "path": "y" } } }
                ] },
                "finishReason": "STOP"
            } ],
            "usageMetadata": { "promptTokenCount": 3, "candidatesTokenCount": 2, "totalTokenCount": 5 }
        });
        let r = parse_turn_response(&raw);
        assert_eq!(r.text, "sure");
        assert_eq!(r.stop_reason, "STOP");
        // usage normalized to the canonical shape tokens.rs parses
        assert_eq!(r.usage["input_tokens"], 3);
        assert_eq!(r.usage["output_tokens"], 2);
        assert_eq!(r.tool_calls.len(), 1);
        assert_eq!(r.tool_calls[0].name, "read_file");
        assert_eq!(r.tool_calls[0].id, "read_file"); // id synthesized from name
        assert_eq!(r.tool_calls[0].args["path"], "y");
    }

    #[test]
    fn normalize_usage_maps_gemini_counts_to_canonical() {
        let u = normalize_usage(&serde_json::json!({ "promptTokenCount": 8, "candidatesTokenCount": 5, "totalTokenCount": 13 }));
        assert_eq!(u["input_tokens"], 8);
        assert_eq!(u["output_tokens"], 5);
        assert_eq!(u["cache_creation_input_tokens"], 0);
        assert_eq!(u["cache_read_input_tokens"], 0);
    }
}
