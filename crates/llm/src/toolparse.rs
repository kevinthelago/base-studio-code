//! Recover tool calls a model emitted as TEXT instead of the structured `tool_calls` field, across
//! the common local-model dialects. Ollama's OpenAI-compatible endpoint *usually* transcribes a
//! tool-capable model's call into the structured field — but inconsistently (qwen3-coder leaks
//! `<function=list_files>…</function>` text), so this is the safety net. Provider-neutral and pure →
//! unit-tested. Used by the Ollama provider (after its structured parse) and by bsc-agent's loop.

use crate::ToolCall;
use serde_json::Value;

fn empty_obj() -> Value {
    Value::Object(Default::default())
}

fn push(calls: &mut Vec<ToolCall>, name: &str, args: Value) {
    let id = format!("rec-{}", calls.len());
    calls.push(ToolCall { id, name: name.to_string(), args });
}

/// Pull `arguments` (or `parameters`) out of a `{name, arguments}` object, defaulting to `{}`.
fn args_of(v: &Value) -> Value {
    v.get("arguments").or_else(|| v.get("parameters")).cloned().unwrap_or_else(empty_obj)
}

/// Recover tool calls from assistant `text`, trying every known local-model dialect in turn and
/// returning the first non-empty set:
///   - `<tool_call>{ "name", "arguments" }</tool_call>`        (Qwen / Hermes)
///   - `<function=NAME>{json args?}</function>`                (the variant qwen3-coder emitted)
///   - `[TOOL_CALLS] [ {…}, … ]`                                (Mistral)
///   - `<|python_tag|>{ "name", "parameters" }`                (Llama 3.1)
///
/// Empty when the text holds no tool syntax (a normal final answer).
pub fn recover_tool_calls(text: &str) -> Vec<ToolCall> {
    for extract in [extract_tool_call_tags, extract_function_tags, extract_mistral, extract_llama] {
        let calls = extract(text);
        if !calls.is_empty() {
            return calls;
        }
    }
    Vec::new()
}

/// The "empty structured `tool_calls` → recover a call emitted as TEXT" fallback, as one step: if `text`
/// carries tool syntax ([`recover_tool_calls`]), return the cleaned text ([`strip_tool_syntax`]) plus the
/// recovered calls; `None` when it's a normal final answer. Collapses the block the Ollama
/// `turn`/`turn_streaming` paths and bsc-agent's loop each repeated.
pub fn recover_text_calls(text: &str) -> Option<(String, Vec<ToolCall>)> {
    let recovered = recover_tool_calls(text);
    if recovered.is_empty() {
        return None;
    }
    Some((strip_tool_syntax(text), recovered))
}

/// `<tool_call>{json}</tool_call>` — the Hermes/Qwen structured form.
fn extract_tool_call_tags(text: &str) -> Vec<ToolCall> {
    let mut calls = Vec::new();
    if let Ok(re) = regex::Regex::new(r"(?s)<tool_call>\s*(\{.*?\})\s*</tool_call>") {
        for cap in re.captures_iter(text) {
            if let Ok(v) = serde_json::from_str::<Value>(&cap[1]) {
                if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
                    push(&mut calls, name, args_of(&v));
                }
            }
        }
    }
    calls
}

/// `<function=NAME>BODY</function>` — name in the tag, optional JSON args in the body.
fn extract_function_tags(text: &str) -> Vec<ToolCall> {
    let mut calls = Vec::new();
    if let Ok(re) = regex::Regex::new(r"(?s)<function=([^>\s]+)\s*>(.*?)</function>") {
        for cap in re.captures_iter(text) {
            let name = cap[1].trim();
            let body = cap[2].trim();
            let args = if body.is_empty() { empty_obj() } else { serde_json::from_str(body).unwrap_or_else(|_| empty_obj()) };
            push(&mut calls, name, args);
        }
    }
    calls
}

/// `[TOOL_CALLS] [ {"name", "arguments"}, … ]` — Mistral's array form.
fn extract_mistral(text: &str) -> Vec<ToolCall> {
    let mut calls = Vec::new();
    if let Ok(re) = regex::Regex::new(r"(?s)\[TOOL_CALLS\]\s*(\[.*\])") {
        if let Some(cap) = re.captures(text) {
            if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&cap[1]) {
                for v in arr {
                    if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
                        push(&mut calls, name, args_of(&v));
                    }
                }
            }
        }
    }
    calls
}

/// `<|python_tag|>{ "name", "parameters" }` — Llama 3.1's single-call form.
fn extract_llama(text: &str) -> Vec<ToolCall> {
    let mut calls = Vec::new();
    if let Ok(re) = regex::Regex::new(r"(?s)<\|python_tag\|>\s*(\{.*\})") {
        if let Some(cap) = re.captures(text) {
            if let Ok(v) = serde_json::from_str::<Value>(&cap[1]) {
                if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
                    push(&mut calls, name, args_of(&v));
                }
            }
        }
    }
    calls
}

/// Strip the raw tool-call syntax out of displayed assistant text once the call has been recovered,
/// so the pane doesn't show the noisy markup. Pure.
pub fn strip_tool_syntax(text: &str) -> String {
    let pat = r"(?s)<tool_call>.*?</tool_call>|<function=[^>]*>.*?</function>|\[TOOL_CALLS\].*|<\|python_tag\|>.*|</?tool_call>";
    match regex::Regex::new(pat) {
        Ok(re) => re.replace_all(text, "").trim().to_string(),
        Err(_) => text.trim().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovers_qwen_function_tag_the_exact_observed_shape() {
        let got = recover_tool_calls("<function=list_files>\n</function>\n</tool_call>");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "list_files");
        assert!(got[0].args.is_object());
    }

    #[test]
    fn recovers_hermes_tool_call_with_args() {
        let got = recover_tool_calls(r#"sure<tool_call>{"name":"file_info","arguments":{"path":"src/main.rs"}}</tool_call>"#);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "file_info");
        assert_eq!(got[0].args["path"], "src/main.rs");
    }

    #[test]
    fn recovers_mistral_array() {
        let got = recover_tool_calls(r#"[TOOL_CALLS][{"name":"list_files","arguments":{"depth":2}}]"#);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "list_files");
        assert_eq!(got[0].args["depth"], 2);
    }

    #[test]
    fn recovers_llama_python_tag() {
        let got = recover_tool_calls(r#"<|python_tag|>{"name":"file_info","parameters":{"path":"x"}}"#);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "file_info");
        assert_eq!(got[0].args["path"], "x");
    }

    #[test]
    fn plain_text_recovers_nothing() {
        assert!(recover_tool_calls("Here is the project layout you asked about.").is_empty());
    }

    #[test]
    fn strip_cleans_each_dialect() {
        assert_eq!(strip_tool_syntax("here<function=list_files></function></tool_call>"), "here");
        assert_eq!(strip_tool_syntax(r#"a <tool_call>{"name":"x"}</tool_call> b"#), "a  b");
        assert_eq!(strip_tool_syntax("plain answer"), "plain answer");
    }
}
