//! The agent loop (epic #1078, P2a). Provider-agnostic: drive any `LlmProvider`
//! through tool-using turns until it returns a final answer.

use crate::permissions::Permissions;
use crate::telemetry::Telemetry;
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
#[allow(clippy::too_many_arguments)] // the agent entrypoint legitimately takes the full session config
pub async fn run_agent<P: LlmProvider>(
    provider: &P,
    api_key: &str,
    model: &str,
    system: &str,
    user: &str,
    tools: &[Tool],
    perms: &Permissions,
    telemetry: &Telemetry,
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
        // Record every assistant turn to the transcript (cost accounting reads its usage).
        telemetry.record_assistant(model, &result.usage);
        if !result.text.is_empty() {
            println!("{}", result.text);
        }
        if result.tool_calls.is_empty() {
            telemetry.finish();
            return Ok(result.text);
        }
        messages.push(Msg::Assistant {
            text: result.text.clone(),
            tool_calls: result.tool_calls.clone(),
        });
        for tc in &result.tool_calls {
            println!("[tool] {}", tc.name);
            // Permission gate: a denial is fed back as the tool result (so the model
            // sees it and adapts) rather than crashing the loop.
            let output = match perms.check(&tc.name, &tc.args) {
                Err(reason) => {
                    println!("[denied] {}", tc.name);
                    reason
                }
                Ok(()) => {
                    telemetry.audit(&tc.name, &tc.args); // one audit line per executed tool
                    match tools.iter().find(|t| t.def.name == tc.name) {
                        Some(tool) => (tool.run)(&tc.args).unwrap_or_else(|e| format!("error: {e}")),
                        None => format!("error: unknown tool '{}'", tc.name),
                    }
                }
            };
            messages.push(Msg::ToolResult { id: tc.id.clone(), content: output });
        }
    }
    telemetry.finish();
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

/// The `write_file` tool: write (create/overwrite) a UTF-8 file, creating parent dirs.
pub fn write_file_tool() -> Tool {
    Tool {
        def: ToolDef {
            name: "write_file".into(),
            description: "Write a UTF-8 text file (creating or overwriting it), making parent directories as needed.".into(),
            schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "path to the file" },
                    "content": { "type": "string", "description": "full file contents to write" }
                },
                "required": ["path", "content"]
            }),
        },
        run: Box::new(|args| {
            let path = args["path"].as_str().ok_or("missing 'path' argument")?;
            let content = args["content"].as_str().ok_or("missing 'content' argument")?;
            if let Some(parent) = std::path::Path::new(path).parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("write_file {path}: {e}"))?;
                }
            }
            std::fs::write(path, content).map_err(|e| format!("write_file {path}: {e}"))?;
            Ok(format!("wrote {} bytes to {path}", content.len()))
        }),
    }
}

/// The `edit_file` tool: replace the first occurrence of `old_string` with `new_string`.
pub fn edit_file_tool() -> Tool {
    Tool {
        def: ToolDef {
            name: "edit_file".into(),
            description: "Replace the first occurrence of old_string with new_string in a UTF-8 file.".into(),
            schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "path to the file" },
                    "old_string": { "type": "string", "description": "exact text to find" },
                    "new_string": { "type": "string", "description": "replacement text" }
                },
                "required": ["path", "old_string", "new_string"]
            }),
        },
        run: Box::new(|args| {
            let path = args["path"].as_str().ok_or("missing 'path' argument")?;
            let old = args["old_string"].as_str().ok_or("missing 'old_string' argument")?;
            let new = args["new_string"].as_str().ok_or("missing 'new_string' argument")?;
            let body = std::fs::read_to_string(path).map_err(|e| format!("edit_file {path}: {e}"))?;
            if !body.contains(old) {
                return Err(format!("edit_file: old_string not found in {path}"));
            }
            std::fs::write(path, body.replacen(old, new, 1)).map_err(|e| format!("edit_file {path}: {e}"))?;
            Ok(format!("edited {path}"))
        }),
    }
}

/// The `bash` tool: run a command with `bash -c` and return combined stdout+stderr.
/// A non-zero exit is NOT an error — the output (plus an `[exit N]` line) is returned
/// so the agent can read it; only a spawn failure is an `Err`.
pub fn bash_tool() -> Tool {
    Tool {
        def: ToolDef {
            name: "bash".into(),
            description: "Run a shell command with `bash -c` and return its combined stdout and stderr.".into(),
            schema: serde_json::json!({
                "type": "object",
                "properties": { "command": { "type": "string", "description": "the shell command to run" } },
                "required": ["command"]
            }),
        },
        run: Box::new(|args| {
            let command = args["command"].as_str().ok_or("missing 'command' argument")?;
            let output = std::process::Command::new("bash")
                .arg("-c")
                .arg(command)
                .output()
                .map_err(|e| format!("bash: failed to spawn: {e}"))?;
            let mut out = String::new();
            out.push_str(&String::from_utf8_lossy(&output.stdout));
            out.push_str(&String::from_utf8_lossy(&output.stderr));
            if !output.status.success() {
                let code = output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
                out.push_str(&format!("\n[exit {code}]"));
            }
            Ok(out)
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
        let out = run_agent(&mock, "", "m", "", "read the file", &tools, &Permissions::default(), &Telemetry::disabled(), 5)
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
        let err = run_agent(&Loopy, "", "m", "", "go", &tools, &Permissions::default(), &Telemetry::disabled(), 3)
            .await
            .unwrap_err();
        assert!(err.contains("did not finish"));
    }

    /// A denied tool call is fed back to the model as the result (not a crash) and the
    /// loop continues to completion.
    #[tokio::test]
    async fn loop_feeds_denial_and_continues() {
        // Turn 1: ask for a denied `bash`. Turn 2: after seeing the denial echoed into
        // the conversation, finish.
        struct BashMock {
            step: Cell<usize>,
        }
        impl LlmProvider for BashMock {
            async fn complete(&self, _r: &LlmRequest, _k: &str) -> Result<serde_json::Value, String> {
                unreachable!()
            }
            async fn turn(&self, t: &Turn, _k: &str) -> Result<TurnResult, String> {
                let n = self.step.get() + 1;
                self.step.set(n);
                if n == 1 {
                    Ok(TurnResult {
                        text: String::new(),
                        tool_calls: vec![ToolCall {
                            id: "b1".into(),
                            name: "bash".into(),
                            args: serde_json::json!({ "command": "rm -rf /tmp/x" }),
                        }],
                        usage: serde_json::Value::Null,
                        stop_reason: "tool_use".into(),
                    })
                } else {
                    let denied = t.messages.iter().any(
                        |m| matches!(m, Msg::ToolResult { content, .. } if content.contains("permission denied")),
                    );
                    Ok(TurnResult {
                        text: if denied { "ok: was denied".into() } else { "no denial seen".into() },
                        tool_calls: vec![],
                        usage: serde_json::Value::Null,
                        stop_reason: "end_turn".into(),
                    })
                }
            }
        }
        let mock = BashMock { step: Cell::new(0) };
        let tools = vec![bash_tool()];
        let perms = Permissions { deny_bash: vec!["rm -rf".into()], ..Default::default() };
        let out = run_agent(&mock, "", "m", "", "clean up", &tools, &perms, &Telemetry::disabled(), 5)
            .await
            .unwrap();
        assert_eq!(out, "ok: was denied");
    }

    /// run_agent records the assistant turn to the transcript (schema tokens.rs reads)
    /// when telemetry is configured — proves the loop wires emission end-to-end.
    #[tokio::test]
    async fn loop_emits_transcript_when_telemetry_configured() {
        struct FinalMock;
        impl LlmProvider for FinalMock {
            async fn complete(&self, _r: &LlmRequest, _k: &str) -> Result<serde_json::Value, String> {
                unreachable!()
            }
            async fn turn(&self, _t: &Turn, _k: &str) -> Result<TurnResult, String> {
                Ok(TurnResult {
                    text: "all done".into(),
                    tool_calls: vec![],
                    usage: serde_json::json!({
                        "input_tokens": 12, "output_tokens": 3,
                        "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0
                    }),
                    stop_reason: "end_turn".into(),
                })
            }
        }
        let dir = std::env::temp_dir().join(format!("bsc_p2d_loopemit_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tx = dir.join("s.jsonl");
        let tokens = dir.join("tokens.log").to_string_lossy().into_owned();
        let tele = Telemetry::for_test(Some(tokens), Some(tx.clone()));
        let out = run_agent(&FinalMock, "", "claude-x", "", "hi", &[], &Permissions::default(), &tele, 5)
            .await
            .unwrap();
        assert_eq!(out, "all done");
        let v: serde_json::Value = serde_json::from_str(std::fs::read_to_string(&tx).unwrap().trim()).unwrap();
        assert_eq!(v["message"]["model"], "claude-x");
        assert_eq!(v["message"]["usage"]["input_tokens"], 12);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_file_creates_and_writes() {
        let path = std::env::temp_dir().join(format!("bsc_p2b_write_{}.txt", std::process::id()));
        let p = path.to_string_lossy().into_owned();
        let msg = (write_file_tool().run)(&serde_json::json!({ "path": p, "content": "hi there" })).unwrap();
        assert!(msg.contains("wrote"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hi there");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn edit_file_replaces_first_then_errors_when_absent() {
        let path = std::env::temp_dir().join(format!("bsc_p2b_edit_{}.txt", std::process::id()));
        std::fs::write(&path, "foo bar foo").unwrap();
        let p = path.to_string_lossy().into_owned();
        let tool = edit_file_tool();
        let msg = (tool.run)(&serde_json::json!({ "path": &p, "old_string": "foo", "new_string": "baz" })).unwrap();
        assert!(msg.contains("edited"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "baz bar foo"); // first occurrence only
        let err = (tool.run)(&serde_json::json!({ "path": &p, "old_string": "zzz", "new_string": "x" })).unwrap_err();
        assert!(err.contains("not found"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn bash_runs_command() {
        // Tolerant: `bash` may be absent or shadowed (e.g. by WSL) in CI/dev. Verify the
        // happy path when a working bash is present; otherwise skip rather than flake.
        match (bash_tool().run)(&serde_json::json!({ "command": "echo hello" })) {
            Ok(out) if out.contains("hello") => {} // a working bash → behavior verified
            Ok(out) => eprintln!("skipping bash assert (bash misconfigured here): {out:?}"),
            Err(e) => eprintln!("skipping bash test (bash unavailable): {e}"),
        }
    }
}
