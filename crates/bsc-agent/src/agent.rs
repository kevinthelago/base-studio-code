//! The agent loop (epic #1078, P2a). Provider-agnostic: drive any `LlmProvider`
//! through tool-using turns until it returns a final answer.

use llm::{LlmProvider, Msg, ToolDef, Turn};
use serde_json::Value;

/// A tool executor: takes the model-supplied `args` and returns its result (or error).
pub type ToolFn = Box<dyn Fn(&Value) -> Result<String, String>>;

/// A tool the agent can run: its declaration (sent to the model) plus an executor.
pub struct Tool {
    pub def: ToolDef,
    pub run: ToolFn,
}

/// Run the agent loop: build a [`Turn`] from the conversation + tools, ask the
/// provider, and while it returns tool calls, execute them, append the results, and
/// continue — until the provider answers with no tool calls (final text) or the
/// step budget runs out. Assistant text and a `[tool] <name>` trace are printed as
/// they happen (the binary runs inside the PTY).
pub async fn run_agent<P: LlmProvider>(
    provider: &P,
    api_key: &str,
    model: &str,
    system: &str,
    user: &str,
    tools: &[Tool],
    max_steps: usize,
) -> Result<String, String> {
    let mut messages: Vec<Msg> = vec![Msg::User(user.to_string())];
    let tool_defs: Vec<ToolDef> = tools.iter().map(|t| t.def.clone()).collect();

    for _ in 0..max_steps {
        let turn = Turn {
            system: system.to_string(),
            messages: messages.clone(),
            tools: tool_defs.clone(),
            model: model.to_string(),
            max_tokens: 4096,
        };
        let result = provider.turn(&turn, api_key).await?;
        if !result.text.is_empty() {
            println!("{}", result.text);
        }
        if result.tool_calls.is_empty() {
            return Ok(result.text);
        }
        messages.push(Msg::Assistant {
            text: result.text.clone(),
            tool_calls: result.tool_calls.clone(),
        });
        for tc in &result.tool_calls {
            println!("[tool] {}", tc.name);
            let output = match tools.iter().find(|t| t.def.name == tc.name) {
                Some(tool) => (tool.run)(&tc.args).unwrap_or_else(|e| format!("error: {e}")),
                None => format!("error: unknown tool '{}'", tc.name),
            };
            messages.push(Msg::ToolResult { id: tc.id.clone(), content: output });
        }
    }
    Err(format!("agent did not finish within {max_steps} steps"))
}

/// The `read_file` tool: read a UTF-8 text file at `args.path`. The first of the
/// core tools (P2a); more (write/edit/bash/grep/glob) follow in later P2 slices.
pub fn read_file_tool() -> Tool {
    Tool {
        def: ToolDef {
            name: "read_file".into(),
            description: "Read a UTF-8 text file and return its contents.".into(),
            schema: serde_json::json!({
                "type": "object",
                "properties": { "path": { "type": "string", "description": "path to the file" } },
                "required": ["path"]
            }),
        },
        run: Box::new(|args| {
            let path = args["path"].as_str().ok_or("missing 'path' argument")?;
            std::fs::read_to_string(path).map_err(|e| format!("read_file {path}: {e}"))
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use llm::{LlmRequest, ToolCall, TurnResult};
    use std::cell::Cell;

    /// A provider that scripts two turns: (1) call `read_file` on a temp path, then
    /// (2) — once it sees the tool result echoed back — return the final text. Proves
    /// the loop executes a tool and feeds the result into the next turn. No network.
    struct MockProvider {
        step: Cell<usize>,
        file: String,
    }

    impl LlmProvider for MockProvider {
        async fn complete(&self, _req: &LlmRequest, _key: &str) -> Result<serde_json::Value, String> {
            unreachable!("agent loop uses turn(), not complete()")
        }

        async fn turn(&self, t: &Turn, _key: &str) -> Result<TurnResult, String> {
            let n = self.step.get() + 1;
            self.step.set(n);
            if n == 1 {
                Ok(TurnResult {
                    text: String::new(),
                    tool_calls: vec![ToolCall {
                        id: "c1".into(),
                        name: "read_file".into(),
                        args: serde_json::json!({ "path": self.file }),
                    }],
                    usage: serde_json::Value::Null,
                    stop_reason: "tool_use".into(),
                })
            } else {
                let saw_result = t.messages.iter().any(
                    |m| matches!(m, Msg::ToolResult { content, .. } if content.contains("HELLO")),
                );
                Ok(TurnResult {
                    text: if saw_result { "done: saw HELLO".into() } else { "missing tool result".into() },
                    tool_calls: vec![],
                    usage: serde_json::Value::Null,
                    stop_reason: "end_turn".into(),
                })
            }
        }
    }

    #[tokio::test]
    async fn loop_runs_tool_then_returns_final_text() {
        let path = std::env::temp_dir().join("bsc_agent_p2a_test.txt");
        std::fs::write(&path, "HELLO world").unwrap();
        let mock = MockProvider {
            step: Cell::new(0),
            file: path.to_string_lossy().into_owned(),
        };
        let tools = vec![read_file_tool()];
        let out = run_agent(&mock, "", "m", "", "read the file", &tools, 5)
            .await
            .unwrap();
        assert_eq!(out, "done: saw HELLO");
        assert_eq!(mock.step.get(), 2); // exactly two turns
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn loop_errors_when_step_budget_exhausted() {
        // A provider that always asks for a tool never terminates → budget error.
        struct Loopy;
        impl LlmProvider for Loopy {
            async fn complete(&self, _r: &LlmRequest, _k: &str) -> Result<serde_json::Value, String> {
                unreachable!()
            }
            async fn turn(&self, _t: &Turn, _k: &str) -> Result<TurnResult, String> {
                Ok(TurnResult {
                    text: String::new(),
                    tool_calls: vec![ToolCall { id: "x".into(), name: "read_file".into(), args: serde_json::json!({"path":"/nope"}) }],
                    usage: serde_json::Value::Null,
                    stop_reason: "tool_use".into(),
                })
            }
        }
        let tools = vec![read_file_tool()];
        let err = run_agent(&Loopy, "", "m", "", "go", &tools, 3).await.unwrap_err();
        assert!(err.contains("did not finish"));
    }
}
