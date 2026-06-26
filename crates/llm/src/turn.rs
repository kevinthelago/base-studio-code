//! Model-agnostic tool-use *turn* API (#1098 / epic #1078, P2).
//!
//! `complete` (the single-shot text path) powers llm_complete; `turn` adds the
//! multi-turn, tool-using conversation the `bsc-agent` runtime loop drives. The
//! types here are provider-neutral; each provider maps them onto its own wire
//! format (Anthropic `tool_use`/`tool_result`, OpenAI `tool_calls`/role:tool,
//! Gemini `functionCall`/`functionResponse`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A tool the model may call: a name, a one-line description, and a JSON-Schema
/// for its parameters (the `args` the model fills in).
#[derive(Clone, Debug)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

/// A tool invocation the model emitted. `id` correlates the call with its result
/// (synthesized from the name for providers — e.g. Gemini — that don't issue ids).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: Value,
}

/// One conversation message in the normalized turn protocol.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Msg {
    User(String),
    Assistant { text: String, tool_calls: Vec<ToolCall> },
    ToolResult { id: String, content: String },
}

/// A full turn request: the system prompt, the conversation so far, the available
/// tools, and the model + token budget.
#[derive(Clone, Debug)]
pub struct Turn {
    pub system: String,
    pub messages: Vec<Msg>,
    pub tools: Vec<ToolDef>,
    pub model: String,
    pub max_tokens: u32,
}

/// The model's normalized response for a turn: any assistant text, the tool calls
/// it wants run (empty ⇒ the turn is final), token usage, and the stop reason.
#[derive(Clone, Debug, Default)]
pub struct TurnResult {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Value,
    pub stop_reason: String,
}
