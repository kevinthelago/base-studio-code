//! Google Gemini (Generative Language API) provider. Maps the normalized request
//! onto Gemini's `contents` / `systemInstruction` shape, and folds the response's
//! `candidates[0].content.parts[].text` back into the normalized `{content,usage}`
//! so kb_chat's consumers read it unchanged.

use super::{LlmProvider, LlmRequest};

pub struct GeminiProvider;

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
    // TODO tools: map req.tools -> Gemini `tools.functionDeclarations` when callers pass tools.
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

impl LlmProvider for GeminiProvider {
    async fn complete(&self, req: &LlmRequest, api_key: &str) -> Result<serde_json::Value, String> {
        let client = reqwest::Client::new();
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
            req.model
        );
        let response = client
            .post(&url)
            .header("x-goog-api-key", api_key)
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
}
