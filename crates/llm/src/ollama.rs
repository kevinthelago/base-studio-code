//! Ollama provider via its OpenAI-compatible endpoint (default at `http://localhost:11434/v1`).
//! Reuses OpenAI's request/response mapping; no API key is required.
//!
//! Per-model adaptation (#1078 follow-up): different models speak different tool-calling dialects, so
//! at session start we query Ollama's native `/api/show` for the model's **capabilities** and
//! **stop** parameters ([`detect_ollama_profile`]) and adapt:
//!   - **tool-capable models** keep the native `tools` field (Ollama applies the model's template);
//!   - **non-tool models** drop it and get a `<tools>` manifest injected into the system prompt
//!     (Hermes-style), so they still have a way to call tools;
//!   - either way, the response is parsed structured-first, then recovered from text across dialects
//!     ([`crate::recover_tool_calls`]) — because Ollama's transcription is inconsistent.

use super::{openai, post_json, toolparse, LlmProvider, LlmRequest, Turn, TurnResult};
use serde_json::{json, Value};

/// What `/api/show` told us about a model, driving how we advertise + parse tools.
#[derive(Clone, Debug)]
pub struct OllamaProfile {
    /// The model advertises tool support (`capabilities` includes `"tools"`). Absent capabilities
    /// (older Ollama) ⇒ assume `true` and let the structured/text parse sort it out.
    pub supports_tools: bool,
    /// Stop sequences from the model's parameters, passed through so generation halts cleanly.
    pub stop: Vec<String>,
}

impl Default for OllamaProfile {
    /// The safe generic profile used when `/api/show` is unreachable: assume tool support, no extra
    /// stops — identical to the pre-detection behavior.
    fn default() -> Self {
        OllamaProfile { supports_tools: true, stop: Vec::new() }
    }
}

/// A local Ollama provider, pointed at a configurable `base_url`, with a detected per-model profile.
pub struct OllamaProvider {
    pub base_url: String,
    pub profile: OllamaProfile,
}

impl OllamaProvider {
    /// Construct with the default (generic) profile — for callers that don't tool-call (the one-shot
    /// `complete` path) or can't run detection.
    pub fn new(base_url: String) -> Self {
        OllamaProvider { base_url, profile: OllamaProfile::default() }
    }

    /// Construct with an already-detected profile (the `bsc-agent` tool-using path).
    pub fn with_profile(base_url: String, profile: OllamaProfile) -> Self {
        OllamaProvider { base_url, profile }
    }
}

/// The chat-completions endpoint for a base URL (tolerant of a trailing slash).
pub(crate) fn chat_completions_url(base: &str) -> String {
    format!("{}/chat/completions", base.trim_end_matches('/'))
}

/// The native `/api/show` endpoint: strip the OpenAI-compat `/v1` suffix off the base URL to reach
/// Ollama's native API root.
fn show_url(base: &str) -> String {
    let root = base.trim_end_matches('/');
    let root = root.strip_suffix("/v1").unwrap_or(root);
    format!("{}/api/show", root.trim_end_matches('/'))
}

/// Query Ollama's `/api/show` for `model` and derive its [`OllamaProfile`]. Best-effort: any failure
/// (server down, old version, non-Ollama endpoint) yields [`OllamaProfile::default`] so the session
/// still runs with the generic behavior. Pure derivation is in [`profile_from_show`].
pub async fn detect_ollama_profile(base_url: &str, model: &str) -> OllamaProfile {
    match post_json(&show_url(base_url), &[], &json!({ "model": model })).await {
        Ok(v) => profile_from_show(&v),
        Err(_) => OllamaProfile::default(),
    }
}

/// Derive a profile from an `/api/show` response. Pure → unit-testable without a server.
fn profile_from_show(v: &Value) -> OllamaProfile {
    let supports_tools = match v.get("capabilities").and_then(|c| c.as_array()) {
        Some(caps) => caps.iter().any(|c| c.as_str() == Some("tools")),
        None => true, // capabilities not reported (older Ollama) ⇒ don't assume "no tools"
    };
    let stop = parse_stop_params(v.get("parameters").and_then(|p| p.as_str()).unwrap_or(""));
    OllamaProfile { supports_tools, stop }
}

/// Pull `stop` sequences out of `/api/show`'s `parameters` text (lines like `stop  "<|im_end|>"`).
fn parse_stop_params(params: &str) -> Vec<String> {
    params
        .lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("stop")?.trim();
            let s = rest.trim_matches('"');
            (!s.is_empty()).then(|| s.to_string())
        })
        .collect()
}

/// Build the chat-completions body for a turn, adapted to the profile: pass the model's `stop`
/// sequences, and for a non-tool model drop the `tools` field + inject a `<tools>` manifest into the
/// system message instead. Pure → unit-testable.
fn build_turn_body(t: &Turn, profile: &OllamaProfile) -> Value {
    let mut body = openai::turn_request_body(t);
    if !profile.stop.is_empty() {
        body["stop"] = json!(profile.stop);
    }
    if !profile.supports_tools {
        if let Some(obj) = body.as_object_mut() {
            obj.remove("tools");
        }
        inject_tools_manifest(&mut body, t);
    }
    body
}

/// For a model without native tool support, append a Hermes-style `<tools>` manifest + call-format
/// instruction to the system message (inserting one if absent), so it still has a way to call tools.
fn inject_tools_manifest(body: &mut Value, t: &Turn) {
    if t.tools.is_empty() {
        return;
    }
    let tools: Vec<Value> = t
        .tools
        .iter()
        .map(|d| json!({ "name": d.name, "description": d.description, "parameters": d.schema }))
        .collect();
    let manifest = format!(
        "\n\n# Tools\nYou can call tools. Available tools:\n<tools>\n{}\n</tools>\nTo call a tool, reply with EXACTLY one line:\n<tool_call>{{\"name\": \"<tool_name>\", \"arguments\": {{ ... }}}}</tool_call>",
        serde_json::to_string(&tools).unwrap_or_default(),
    );
    let msgs = body["messages"].as_array_mut();
    if let Some(msgs) = msgs {
        if let Some(first) = msgs.first_mut() {
            if first["role"] == "system" {
                let cur = first["content"].as_str().unwrap_or("").to_string();
                first["content"] = json!(format!("{cur}{manifest}"));
                return;
            }
        }
        msgs.insert(0, json!({ "role": "system", "content": manifest.trim_start() }));
    }
}

impl LlmProvider for OllamaProvider {
    async fn complete(&self, req: &LlmRequest, _api_key: &str) -> Result<serde_json::Value, String> {
        let json = post_json(
            &chat_completions_url(&self.base_url),
            &[],
            &openai::build_request_body(req),
        )
        .await?;
        Ok(openai::normalize_response(&json))
    }

    async fn turn(&self, t: &Turn, _api_key: &str) -> Result<TurnResult, String> {
        let json = post_json(&chat_completions_url(&self.base_url), &[], &build_turn_body(t, &self.profile)).await?;
        let mut result = openai::parse_turn_response(&json);
        // Ollama's OpenAI-compat layer doesn't always transcribe the model's tool call into the
        // structured field — recover it from the text across dialects when the field is empty.
        if result.tool_calls.is_empty() {
            let recovered = toolparse::recover_tool_calls(&result.text);
            if !recovered.is_empty() {
                result.text = toolparse::strip_tool_syntax(&result.text);
                result.tool_calls = recovered;
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Msg, ToolDef};

    #[test]
    fn show_url_strips_v1_suffix() {
        assert_eq!(show_url("http://localhost:11434/v1"), "http://localhost:11434/api/show");
        assert_eq!(show_url("http://localhost:11434/v1/"), "http://localhost:11434/api/show");
        // A base without /v1 still resolves to the native endpoint.
        assert_eq!(show_url("http://localhost:11434"), "http://localhost:11434/api/show");
    }

    #[test]
    fn profile_from_show_reads_capabilities_and_stops() {
        let v = json!({
            "capabilities": ["completion", "tools"],
            "parameters": "stop                           \"<|im_start|>\"\nstop                           \"<|im_end|>\"\ntemperature                    0.7"
        });
        let p = profile_from_show(&v);
        assert!(p.supports_tools);
        assert_eq!(p.stop, vec!["<|im_start|>", "<|im_end|>"]);

        // No tools capability ⇒ supports_tools false.
        let v = json!({ "capabilities": ["completion"], "parameters": "" });
        assert!(!profile_from_show(&v).supports_tools);

        // Missing capabilities (older Ollama) ⇒ assume tool support (don't break working models).
        let v = json!({ "parameters": "" });
        assert!(profile_from_show(&v).supports_tools);
    }

    fn turn_with_tool() -> Turn {
        Turn {
            system: "be terse".into(),
            model: "qwen3-coder".into(),
            max_tokens: 4096,
            tools: vec![ToolDef {
                name: "list_files".into(),
                description: "list files".into(),
                schema: json!({ "type": "object" }),
            }],
            messages: vec![Msg::User("hi".into())],
        }
    }

    #[test]
    fn tool_capable_profile_keeps_tools_field_and_adds_stops() {
        let profile = OllamaProfile { supports_tools: true, stop: vec!["<|im_end|>".into()] };
        let body = build_turn_body(&turn_with_tool(), &profile);
        assert!(body.get("tools").is_some(), "tool-capable ⇒ native tools field kept");
        assert_eq!(body["stop"], json!(["<|im_end|>"]));
        // System message is untouched (no manifest injected).
        assert_eq!(body["messages"][0]["content"], "be terse");
    }

    #[test]
    fn non_tool_profile_drops_field_and_injects_manifest() {
        let profile = OllamaProfile { supports_tools: false, stop: vec![] };
        let body = build_turn_body(&turn_with_tool(), &profile);
        assert!(body.get("tools").is_none(), "non-tool ⇒ tools field dropped");
        let sys = body["messages"][0]["content"].as_str().unwrap();
        assert!(sys.contains("<tools>"), "manifest injected into the system message");
        assert!(sys.contains("list_files"), "the tool is named in the manifest");
        assert!(sys.contains("<tool_call>"), "the call format is shown");
    }
}
