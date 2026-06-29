//! Ollama provider. The one-shot `complete` path uses Ollama's OpenAI-compatible endpoint (default at
//! `http://localhost:11434/v1`); the tool-using `turn` path (the `bsc-agent` agent loop) uses Ollama's
//! **native** `/api/chat` endpoint so it can set the things the OpenAI-compat layer can't (#1829).
//!
//! **Why native for turns (#1829).** The OpenAI-compat `/v1/chat/completions` endpoint accepts no
//! `num_ctx`, so Ollama applies its small default context window (~4096) and **silently truncates the
//! prompt from the front** — and an agent turn's system prompt (the CLAUDE.md chain + agent
//! instructions + the CLI inventory + serialized tool schemas) routinely exceeds that, so the model
//! quietly loses its own instructions/task. The native `/api/chat` `options` block lets us set
//! `num_ctx` (sized from the model's real context length, detected below), `keep_alive` (so the model
//! stays warm across turns instead of reloading mid-session), and a low `temperature` + fixed `seed`
//! for tool-calling determinism.
//!
//! Per-model adaptation (#1078 follow-up): different models speak different tool-calling dialects, so
//! at session start we query Ollama's native `/api/show` for the model's **capabilities**, **stop**
//! parameters, and **context length** ([`detect_ollama_profile`]) and adapt:
//!   - **tool-capable models** keep the native `tools` field (Ollama applies the model's template);
//!   - **non-tool models** drop it and get a `<tools>` manifest injected into the system prompt
//!     (Hermes-style), so they still have a way to call tools;
//!   - either way, the response is parsed structured-first, then recovered from text across dialects
//!     ([`crate::recover_tool_calls`]) — because Ollama's transcription is inconsistent.

use super::{openai, post_json, toolparse, LlmProvider, LlmRequest, Msg, ToolCall, Turn, TurnResult};
use serde_json::{json, Value};

/// The default ceiling we clamp a model's `num_ctx` to. A model may advertise a huge context (256k+),
/// but `num_ctx` is VRAM-bound, so we cap it to something a consumer GPU can hold. The app can lower
/// this per-session (VRAM-bound) via `$BSC_AGENT_NUM_CTX`; `0` disables setting `num_ctx` entirely.
const DEFAULT_NUM_CTX_CAP: u64 = 32_768;
/// The `num_ctx` to request when `/api/show` didn't report a context length (older Ollama / non-Ollama
/// endpoint). Bigger than Ollama's ~4096 default so a long agent prompt isn't silently truncated, but
/// conservative enough to fit most models + GPUs.
const DEFAULT_NUM_CTX_FALLBACK: u64 = 8_192;
/// How long Ollama keeps the model resident after a request. Long enough that the model doesn't unload
/// (and pay a multi-second reload) between agent turns, but not pinned forever.
const DEFAULT_KEEP_ALIVE: &str = "30m";

/// Resolve the `num_ctx` to request: the detected model context (or [`DEFAULT_NUM_CTX_FALLBACK`] when
/// unknown), clamped to `cap`. A `cap` of 0 means "don't set `num_ctx`" (defer to Ollama). Pure.
fn resolve_num_ctx(detected: Option<u64>, cap: u64) -> Option<u64> {
    if cap == 0 {
        return None;
    }
    Some(detected.unwrap_or(DEFAULT_NUM_CTX_FALLBACK).min(cap))
}

/// What `/api/show` told us about a model, driving how we advertise + parse tools and size the context.
#[derive(Clone, Debug)]
pub struct OllamaProfile {
    /// The model advertises tool support (`capabilities` includes `"tools"`). Absent capabilities
    /// (older Ollama) ⇒ assume `true` and let the structured/text parse sort it out.
    pub supports_tools: bool,
    /// Stop sequences from the model's parameters, passed through so generation halts cleanly.
    pub stop: Vec<String>,
    /// The model's trained context length (from `/api/show` `model_info`'s `<arch>.context_length`),
    /// used to size `num_ctx`. `None` when not reported.
    pub context_length: Option<u64>,
}

impl Default for OllamaProfile {
    /// The safe generic profile used when `/api/show` is unreachable: assume tool support, no extra
    /// stops, unknown context — identical to the pre-detection behavior.
    fn default() -> Self {
        OllamaProfile { supports_tools: true, stop: Vec::new(), context_length: None }
    }
}

/// A local Ollama provider, pointed at a configurable `base_url`, with a detected per-model profile and
/// the native generation options the `turn` path sends (`num_ctx` / `keep_alive` / `temperature` /
/// `seed`).
pub struct OllamaProvider {
    pub base_url: String,
    pub profile: OllamaProfile,
    /// `options.num_ctx` for the native turn path (sized from the profile, clamped). `None` ⇒ unset.
    num_ctx: Option<u64>,
    /// `keep_alive` for the native turn path. `None` ⇒ unset (Ollama's default).
    keep_alive: Option<String>,
    /// `options.temperature` — low by default for tool-calling determinism.
    temperature: f64,
    /// `options.seed` — fixed by default so a turn is reproducible. `None` ⇒ unset.
    seed: Option<i64>,
}

impl OllamaProvider {
    /// Construct with the default (generic) profile — for callers that don't tool-call (the one-shot
    /// `complete` path) or can't run detection.
    pub fn new(base_url: String) -> Self {
        OllamaProvider {
            base_url,
            profile: OllamaProfile::default(),
            num_ctx: None,
            keep_alive: Some(DEFAULT_KEEP_ALIVE.to_string()),
            temperature: 0.0,
            seed: Some(0),
        }
    }

    /// Construct with an already-detected profile (the `bsc-agent` tool-using path). Sizes `num_ctx`
    /// from the profile's context length, clamped to [`DEFAULT_NUM_CTX_CAP`].
    pub fn with_profile(base_url: String, profile: OllamaProfile) -> Self {
        let num_ctx = resolve_num_ctx(profile.context_length, DEFAULT_NUM_CTX_CAP);
        OllamaProvider {
            base_url,
            profile,
            num_ctx,
            keep_alive: Some(DEFAULT_KEEP_ALIVE.to_string()),
            temperature: 0.0,
            seed: Some(0),
        }
    }

    /// Override the `num_ctx` ceiling (VRAM-bound) — recomputes `num_ctx` from the detected context
    /// length clamped to `cap`. `cap == 0` disables setting `num_ctx`. The app passes the user's
    /// per-agent context cap here.
    pub fn with_num_ctx_cap(mut self, cap: u64) -> Self {
        self.num_ctx = resolve_num_ctx(self.profile.context_length, cap);
        self
    }

    /// The effective `num_ctx` this provider will request (for the startup banner / diagnostics).
    pub fn num_ctx(&self) -> Option<u64> {
        self.num_ctx
    }
}

/// The Ollama native API root for a base URL: strip a trailing slash and the OpenAI-compat `/v1`
/// suffix, so an OpenAI-style base (`…:11434/v1`) and a native base (`…:11434`) both resolve here.
fn native_root(base: &str) -> String {
    let root = base.trim_end_matches('/');
    root.strip_suffix("/v1").unwrap_or(root).trim_end_matches('/').to_string()
}

/// The OpenAI-compat chat-completions endpoint for a base URL (tolerant of a trailing slash). Used by
/// the one-shot `complete` path.
pub(crate) fn chat_completions_url(base: &str) -> String {
    format!("{}/chat/completions", base.trim_end_matches('/'))
}

/// Ollama's native `/api/chat` endpoint (the tool-using `turn` path).
fn native_chat_url(base: &str) -> String {
    format!("{}/api/chat", native_root(base))
}

/// Ollama's native `/api/show` endpoint.
fn show_url(base: &str) -> String {
    format!("{}/api/show", native_root(base))
}

/// Ollama's native `/api/tags` endpoint — the installed-model list (#1830).
fn tags_url(base: &str) -> String {
    format!("{}/api/tags", native_root(base))
}

/// List the model names installed on the Ollama endpoint, sorted (#1830). Drives the Settings model
/// dropdown and doubles as a connectivity probe — `Err("Request failed: …")` means the endpoint is
/// unreachable (Ollama not running / wrong URL). Pure parse in [`parse_models`].
pub async fn list_models(base_url: &str) -> Result<Vec<String>, String> {
    let v = super::get_json(&tags_url(base_url)).await?;
    Ok(parse_models(&v))
}

/// Pull the sorted model names out of an `/api/tags` response (`{ models: [{ name, … }] }`). Pure.
fn parse_models(v: &Value) -> Vec<String> {
    let mut names: Vec<String> = v
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
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
    let context_length = parse_context_length(v);
    OllamaProfile { supports_tools, stop, context_length }
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

/// Pull the model's context length out of `/api/show`'s `model_info`. The key is architecture-prefixed
/// (`qwen3moe.context_length`, `llama.context_length`, …), so match any key ending `context_length`.
fn parse_context_length(v: &Value) -> Option<u64> {
    let mi = v.get("model_info")?.as_object()?;
    mi.iter()
        .find_map(|(k, val)| if k.ends_with("context_length") { val.as_u64() } else { None })
}

/// Map the normalized messages onto Ollama's native `/api/chat` messages. Assistant tool calls become
/// `tool_calls[].function.{name,arguments}` with **arguments as a JSON object** (native Ollama, unlike
/// OpenAI, does not stringify them); each tool result is a `{role:"tool", content}` message (native
/// matches results positionally, so no id is needed). Pure.
fn build_native_messages(t: &Turn) -> Vec<Value> {
    let mut msgs = Vec::new();
    if !t.system.is_empty() {
        msgs.push(json!({ "role": "system", "content": t.system }));
    }
    for m in &t.messages {
        match m {
            Msg::User(s) => msgs.push(json!({ "role": "user", "content": s })),
            Msg::Assistant { text, tool_calls } => {
                let mut am = json!({ "role": "assistant", "content": text });
                if !tool_calls.is_empty() {
                    let calls: Vec<Value> = tool_calls
                        .iter()
                        .map(|tc| json!({ "function": { "name": tc.name, "arguments": tc.args } }))
                        .collect();
                    am["tool_calls"] = Value::Array(calls);
                }
                msgs.push(am);
            }
            Msg::ToolResult { content, .. } => {
                msgs.push(json!({ "role": "tool", "content": content }))
            }
        }
    }
    msgs
}

/// Build the native `/api/chat` body for a turn: messages, tools (for a tool-capable model), the
/// generation `options` (`num_ctx` / `temperature` / `seed` / `num_predict` / `stop`), and
/// `keep_alive`. For a non-tool model the `tools` field is omitted and a `<tools>` manifest is injected
/// into the system message instead. Pure → unit-testable.
fn build_native_turn_body(
    t: &Turn,
    profile: &OllamaProfile,
    num_ctx: Option<u64>,
    keep_alive: Option<&str>,
    temperature: f64,
    seed: Option<i64>,
) -> Value {
    let mut body = json!({
        "model": t.model,
        "messages": build_native_messages(t),
        "stream": false,
    });
    if profile.supports_tools && !t.tools.is_empty() {
        let tools: Vec<Value> = t
            .tools
            .iter()
            .map(|d| json!({
                "type": "function",
                "function": { "name": d.name, "description": d.description, "parameters": d.schema }
            }))
            .collect();
        body["tools"] = Value::Array(tools);
    }
    // A non-tool model gets the Hermes-style manifest in its system prompt (no native `tools` field).
    if !profile.supports_tools {
        inject_tools_manifest(&mut body, t);
    }
    if let Some(ka) = keep_alive {
        body["keep_alive"] = json!(ka);
    }
    // `num_predict` is the native name for the output-token budget (OpenAI's `max_tokens`).
    let mut opts = serde_json::Map::new();
    if let Some(n) = num_ctx {
        opts.insert("num_ctx".into(), json!(n));
    }
    opts.insert("temperature".into(), json!(temperature));
    if let Some(s) = seed {
        opts.insert("seed".into(), json!(s));
    }
    opts.insert("num_predict".into(), json!(t.max_tokens));
    if !profile.stop.is_empty() {
        opts.insert("stop".into(), json!(profile.stop));
    }
    body["options"] = Value::Object(opts);
    body
}

/// Parse Ollama's native `/api/chat` response into a [`TurnResult`]. Native puts the reply in a
/// top-level `message` (not `choices[0].message`); `tool_calls[].function.arguments` is already a JSON
/// object (but tolerate a string just in case); usage is `prompt_eval_count` / `eval_count`. Native
/// issues no call ids, so one is synthesized. Pure → unit-testable.
fn parse_native_turn_response(raw: &Value) -> TurnResult {
    let msg = &raw["message"];
    let text = msg["content"].as_str().unwrap_or("").to_string();
    let tool_calls = msg["tool_calls"]
        .as_array()
        .map(|calls| {
            calls
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    let name = c["function"]["name"].as_str().unwrap_or("").to_string();
                    let args = match &c["function"]["arguments"] {
                        Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
                        other => other.clone(),
                    };
                    ToolCall { id: format!("ollama-{i}"), name, args }
                })
                .collect()
        })
        .unwrap_or_default();
    TurnResult {
        text,
        tool_calls,
        usage: native_usage(raw),
        stop_reason: raw["done_reason"].as_str().unwrap_or("").to_string(),
    }
}

/// Normalize Ollama's native usage (`prompt_eval_count` / `eval_count`) to the canonical 4-key shape
/// `tokens.rs` parses. Ollama has no prompt-cache split, so cache_* = 0. Pure.
fn native_usage(raw: &Value) -> Value {
    let u = |k: &str| raw.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    json!({
        "input_tokens": u("prompt_eval_count"),
        "output_tokens": u("eval_count"),
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    })
}

/// One parsed line of Ollama's streaming `/api/chat` NDJSON response (#1832).
struct StreamLine {
    content: Option<String>,
    tool_calls: Vec<ToolCall>,
    done: bool,
    usage: Value,
    done_reason: String,
}

/// Parse one NDJSON line of a streamed `/api/chat` response. `None` for a non-JSON / partial line
/// (skipped). `content` is this chunk's text fragment; `usage`/`done_reason` are only meaningful when
/// `done`. Pure → unit-testable. (#1832)
fn parse_stream_line(line: &str) -> Option<StreamLine> {
    let v: Value = serde_json::from_str(line).ok()?;
    let content = v["message"]["content"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
    let tool_calls = v["message"]["tool_calls"]
        .as_array()
        .map(|calls| {
            calls
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    let name = c["function"]["name"].as_str().unwrap_or("").to_string();
                    let args = match &c["function"]["arguments"] {
                        Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
                        other => other.clone(),
                    };
                    ToolCall { id: format!("ollama-{i}"), name, args }
                })
                .collect()
        })
        .unwrap_or_default();
    let done = v["done"].as_bool() == Some(true);
    let usage = if done { native_usage(&v) } else { Value::Null };
    let done_reason = v["done_reason"].as_str().unwrap_or("").to_string();
    Some(StreamLine { content, tool_calls, done, usage, done_reason })
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
        // The one-shot path stays on the OpenAI-compat endpoint (no tools, shorter prompts).
        let json = post_json(
            &chat_completions_url(&self.base_url),
            &[],
            &openai::build_request_body(req),
        )
        .await?;
        Ok(openai::normalize_response(&json))
    }

    async fn turn(&self, t: &Turn, _api_key: &str) -> Result<TurnResult, String> {
        let body = build_native_turn_body(
            t,
            &self.profile,
            self.num_ctx,
            self.keep_alive.as_deref(),
            self.temperature,
            self.seed,
        );
        let json = post_json(&native_chat_url(&self.base_url), &[], &body).await?;
        let mut result = parse_native_turn_response(&json);
        // Even on the native endpoint some models emit the call as TEXT (`<tool_call>…` /
        // `<function=name>…`) instead of the structured field — recover it across dialects when empty.
        if result.tool_calls.is_empty() {
            let recovered = toolparse::recover_tool_calls(&result.text);
            if !recovered.is_empty() {
                result.text = toolparse::strip_tool_syntax(&result.text);
                result.tool_calls = recovered;
            }
        }
        Ok(result)
    }

    async fn turn_streaming(
        &self,
        t: &Turn,
        _api_key: &str,
        on_chunk: &mut dyn FnMut(&str),
    ) -> Result<TurnResult, String> {
        use futures_util::StreamExt;
        let mut body = build_native_turn_body(
            t, &self.profile, self.num_ctx, self.keep_alive.as_deref(), self.temperature, self.seed,
        );
        body["stream"] = json!(true);
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(super::CONNECT_TIMEOUT_SECS))
            .timeout(std::time::Duration::from_secs(super::REQUEST_TIMEOUT_SECS))
            .build()
            .map_err(|e| format!("Request failed: {}", e))?;
        let resp = client
            .post(native_chat_url(&self.base_url))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;
        let status = resp.status();
        if !status.is_success() {
            let v = resp.json::<Value>().await.unwrap_or(Value::Null);
            return Err(super::format_api_error(status, &v));
        }
        // Ollama streams the native /api/chat reply as newline-delimited JSON: one object per line,
        // each carrying a `message.content` fragment (and the final one `done:true` + usage). Emit each
        // fragment as it arrives; assemble the final TurnResult.
        let mut text = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut usage = native_usage(&Value::Null);
        let mut stop_reason = String::new();
        let mut buf = String::new();
        let mut stream = resp.bytes_stream();
        let mut apply = |line: &str,
                         text: &mut String,
                         tool_calls: &mut Vec<ToolCall>,
                         usage: &mut Value,
                         stop_reason: &mut String| {
            if let Some(sl) = parse_stream_line(line) {
                if let Some(frag) = sl.content {
                    on_chunk(&frag);
                    text.push_str(&frag);
                }
                if !sl.tool_calls.is_empty() {
                    *tool_calls = sl.tool_calls;
                }
                if sl.done {
                    *usage = sl.usage;
                    *stop_reason = sl.done_reason;
                }
            }
        };
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| format!("Request failed: {}", e))?;
            buf.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(nl) = buf.find('\n') {
                let line: String = buf.drain(..=nl).collect();
                let line = line.trim();
                if !line.is_empty() {
                    apply(line, &mut text, &mut tool_calls, &mut usage, &mut stop_reason);
                }
            }
        }
        let tail = buf.trim().to_string();
        if !tail.is_empty() {
            apply(&tail, &mut text, &mut tool_calls, &mut usage, &mut stop_reason);
        }
        // Recover a tool call emitted as text (non-tool models) — mirrors the non-streaming `turn`.
        if tool_calls.is_empty() {
            let recovered = toolparse::recover_tool_calls(&text);
            if !recovered.is_empty() {
                text = toolparse::strip_tool_syntax(&text);
                tool_calls = recovered;
            }
        }
        Ok(TurnResult { text, tool_calls, usage, stop_reason })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Msg, ToolCall, ToolDef};

    #[test]
    fn parse_stream_line_reads_fragments_calls_and_done() {
        // A content fragment.
        let sl = parse_stream_line(r#"{"message":{"content":"hel"},"done":false}"#).unwrap();
        assert_eq!(sl.content.as_deref(), Some("hel"));
        assert!(!sl.done);
        // A tool call (arguments as a native object).
        let sl = parse_stream_line(r#"{"message":{"content":"","tool_calls":[{"function":{"name":"grep","arguments":{"pattern":"fn"}}}]}}"#).unwrap();
        assert_eq!(sl.content, None); // empty content ⇒ no fragment emitted
        assert_eq!(sl.tool_calls.len(), 1);
        assert_eq!(sl.tool_calls[0].name, "grep");
        assert_eq!(sl.tool_calls[0].args["pattern"], "fn");
        // The final line carries done + usage.
        let sl = parse_stream_line(r#"{"message":{"content":""},"done":true,"done_reason":"stop","prompt_eval_count":12,"eval_count":7}"#).unwrap();
        assert!(sl.done);
        assert_eq!(sl.done_reason, "stop");
        assert_eq!(sl.usage["input_tokens"], 12);
        assert_eq!(sl.usage["output_tokens"], 7);
        // A non-JSON / partial line is skipped.
        assert!(parse_stream_line("{partial").is_none());
    }

    #[test]
    fn native_root_and_urls_strip_v1_suffix() {
        assert_eq!(show_url("http://localhost:11434/v1"), "http://localhost:11434/api/show");
        assert_eq!(show_url("http://localhost:11434/v1/"), "http://localhost:11434/api/show");
        // A base without /v1 still resolves to the native endpoints.
        assert_eq!(show_url("http://localhost:11434"), "http://localhost:11434/api/show");
        assert_eq!(native_chat_url("http://localhost:11434/v1"), "http://localhost:11434/api/chat");
        assert_eq!(native_chat_url("http://10.0.0.5:8080"), "http://10.0.0.5:8080/api/chat");
        // The one-shot path keeps the OpenAI-compat endpoint.
        assert_eq!(chat_completions_url("http://localhost:11434/v1"), "http://localhost:11434/v1/chat/completions");
    }

    #[test]
    fn tags_url_and_parse_models() {
        assert_eq!(tags_url("http://localhost:11434/v1"), "http://localhost:11434/api/tags");
        assert_eq!(tags_url("http://localhost:11434"), "http://localhost:11434/api/tags");
        // Names are pulled from models[].name and sorted; entries without a name are skipped.
        let v = json!({ "models": [
            { "name": "qwen3-coder:latest", "size": 1 },
            { "name": "llama3.1:8b" },
            { "size": 9 },
        ]});
        assert_eq!(parse_models(&v), vec!["llama3.1:8b", "qwen3-coder:latest"]);
        // No models array (unreachable-ish / empty) → empty list, not a panic.
        assert!(parse_models(&json!({})).is_empty());
    }

    #[test]
    fn profile_from_show_reads_capabilities_stops_and_context() {
        let v = json!({
            "capabilities": ["completion", "tools"],
            "parameters": "stop                           \"<|im_start|>\"\nstop                           \"<|im_end|>\"\ntemperature                    0.7",
            "model_info": { "general.architecture": "qwen3moe", "qwen3moe.context_length": 262144 }
        });
        let p = profile_from_show(&v);
        assert!(p.supports_tools);
        assert_eq!(p.stop, vec!["<|im_start|>", "<|im_end|>"]);
        assert_eq!(p.context_length, Some(262144));

        // No tools capability ⇒ supports_tools false; no model_info ⇒ context_length None.
        let v = json!({ "capabilities": ["completion"], "parameters": "" });
        let p = profile_from_show(&v);
        assert!(!p.supports_tools);
        assert_eq!(p.context_length, None);

        // Missing capabilities (older Ollama) ⇒ assume tool support (don't break working models).
        let v = json!({ "parameters": "", "model_info": { "llama.context_length": 8192 } });
        let p = profile_from_show(&v);
        assert!(p.supports_tools);
        assert_eq!(p.context_length, Some(8192));
    }

    #[test]
    fn resolve_num_ctx_clamps_and_defaults() {
        // Detected context is clamped to the cap.
        assert_eq!(resolve_num_ctx(Some(262144), 32768), Some(32768));
        // A small model keeps its smaller context (don't inflate beyond what it was trained on).
        assert_eq!(resolve_num_ctx(Some(4096), 32768), Some(4096));
        // Unknown context ⇒ the fallback (well above Ollama's silent ~4096 default).
        assert_eq!(resolve_num_ctx(None, 32768), Some(DEFAULT_NUM_CTX_FALLBACK));
        // cap 0 ⇒ don't set num_ctx at all.
        assert_eq!(resolve_num_ctx(Some(8192), 0), None);
    }

    #[test]
    fn with_num_ctx_cap_recomputes_from_profile() {
        let profile = OllamaProfile { supports_tools: true, stop: vec![], context_length: Some(131072) };
        let p = OllamaProvider::with_profile("http://x/v1".into(), profile);
        assert_eq!(p.num_ctx(), Some(DEFAULT_NUM_CTX_CAP)); // clamped to the default cap
        let p = p.with_num_ctx_cap(16384);
        assert_eq!(p.num_ctx(), Some(16384)); // user lowered the VRAM-bound cap
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
    fn native_body_tool_capable_keeps_tools_and_sets_options() {
        let profile = OllamaProfile { supports_tools: true, stop: vec!["<|im_end|>".into()], context_length: Some(32768) };
        let body = build_native_turn_body(&turn_with_tool(), &profile, Some(32768), Some("30m"), 0.0, Some(0));
        assert!(body.get("tools").is_some(), "tool-capable ⇒ native tools field kept");
        assert_eq!(body["stream"], false);
        assert_eq!(body["keep_alive"], "30m");
        // The reliability-critical options: num_ctx (no silent truncation), determinism, output budget.
        assert_eq!(body["options"]["num_ctx"], 32768);
        assert_eq!(body["options"]["temperature"], 0.0);
        assert_eq!(body["options"]["seed"], 0);
        assert_eq!(body["options"]["num_predict"], 4096);
        assert_eq!(body["options"]["stop"], json!(["<|im_end|>"]));
        // System message is untouched (no manifest injected).
        assert_eq!(body["messages"][0]["content"], "be terse");
    }

    #[test]
    fn native_body_non_tool_drops_field_and_injects_manifest() {
        let profile = OllamaProfile { supports_tools: false, stop: vec![], context_length: None };
        let body = build_native_turn_body(&turn_with_tool(), &profile, Some(8192), Some("30m"), 0.0, Some(0));
        assert!(body.get("tools").is_none(), "non-tool ⇒ tools field dropped");
        let sys = body["messages"][0]["content"].as_str().unwrap();
        assert!(sys.contains("<tools>"), "manifest injected into the system message");
        assert!(sys.contains("list_files"), "the tool is named in the manifest");
        assert!(sys.contains("<tool_call>"), "the call format is shown");
    }

    #[test]
    fn native_messages_map_assistant_calls_and_tool_results() {
        let t = Turn {
            system: "sys".into(),
            model: "m".into(),
            max_tokens: 1024,
            tools: vec![],
            messages: vec![
                Msg::User("read x".into()),
                Msg::Assistant {
                    text: String::new(),
                    tool_calls: vec![ToolCall { id: "c1".into(), name: "read_file".into(), args: json!({"path":"x"}) }],
                },
                Msg::ToolResult { id: "c1".into(), content: "FILE BODY".into() },
            ],
        };
        let msgs = build_native_messages(&t);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
        // assistant tool_calls carry arguments as an OBJECT (native), not a stringified JSON.
        assert_eq!(msgs[2]["role"], "assistant");
        assert_eq!(msgs[2]["tool_calls"][0]["function"]["name"], "read_file");
        assert_eq!(msgs[2]["tool_calls"][0]["function"]["arguments"]["path"], "x");
        assert!(msgs[2]["tool_calls"][0]["function"]["arguments"].is_object());
        // tool result → role:tool message
        assert_eq!(msgs[3]["role"], "tool");
        assert_eq!(msgs[3]["content"], "FILE BODY");
    }

    #[test]
    fn parse_native_extracts_text_tool_calls_and_usage() {
        let raw = json!({
            "model": "qwen3-coder",
            "message": {
                "role": "assistant",
                "content": "sure",
                "tool_calls": [ { "function": { "name": "read_file", "arguments": { "path": "y" } } } ]
            },
            "done_reason": "stop",
            "prompt_eval_count": 12,
            "eval_count": 7
        });
        let r = parse_native_turn_response(&raw);
        assert_eq!(r.text, "sure");
        assert_eq!(r.stop_reason, "stop");
        assert_eq!(r.tool_calls.len(), 1);
        assert_eq!(r.tool_calls[0].name, "read_file");
        assert_eq!(r.tool_calls[0].args["path"], "y"); // native arguments are already an object
        assert_eq!(r.tool_calls[0].id, "ollama-0"); // synthesized (native issues no id)
        // usage normalized to the canonical shape tokens.rs reads
        assert_eq!(r.usage["input_tokens"], 12);
        assert_eq!(r.usage["output_tokens"], 7);
        assert_eq!(r.usage["cache_read_input_tokens"], 0);
    }

    #[test]
    fn parse_native_tolerates_stringified_arguments_and_no_tools() {
        // Some builds stringify arguments like OpenAI — tolerate it.
        let raw = json!({
            "message": { "role": "assistant", "content": "", "tool_calls": [
                { "function": { "name": "grep", "arguments": "{\"pattern\":\"fn\"}" } }
            ] }
        });
        let r = parse_native_turn_response(&raw);
        assert_eq!(r.tool_calls[0].args["pattern"], "fn");

        // A plain final answer (no tool_calls) parses to empty calls.
        let raw = json!({ "message": { "role": "assistant", "content": "all done" }, "done_reason": "stop" });
        let r = parse_native_turn_response(&raw);
        assert_eq!(r.text, "all done");
        assert!(r.tool_calls.is_empty());
    }
}
