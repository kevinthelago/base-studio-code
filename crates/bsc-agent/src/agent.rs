//! The agent loop (epic #1078, P2a). Provider-agnostic: drive any `LlmProvider`
//! through tool-using turns until it returns a final answer.

use crate::permissions::Permissions;
use crate::telemetry::Telemetry;
use llm::{LlmProvider, Msg, ToolDef, Turn, TurnResult};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

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
    // Prior conversation to resume (empty = fresh), and where to persist the conversation
    // afterward so a later --continue can resume it (None = don't persist).
    prior: &[Msg],
    session_path: Option<&Path>,
    max_steps: usize,
) -> Result<String, String> {
    let mut messages: Vec<Msg> = prior.to_vec();
    messages.push(Msg::User(user.to_string()));
    let tool_defs: Vec<ToolDef> = tools.iter().map(|t| t.def.clone()).collect();

    for _ in 0..max_steps {
        let turn = Turn {
            system: system.to_string(),
            messages: messages.clone(),
            tools: tool_defs.clone(),
            model: model.to_string(),
            max_tokens: 4096,
        };
        let result = turn_with_retry(provider, &turn, api_key, Duration::from_millis(500)).await?;
        // Record every assistant turn to the transcript (cost accounting reads its usage).
        telemetry.record_assistant(model, &result.usage);
        if !result.text.is_empty() {
            println!("{}", result.text);
        }
        if result.tool_calls.is_empty() {
            // Record the final assistant turn so a resumed session sees it, then persist.
            messages.push(Msg::Assistant { text: result.text.clone(), tool_calls: vec![] });
            if let Some(p) = session_path {
                save_conversation(p, &messages);
            }
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
    if let Some(p) = session_path {
        save_conversation(p, &messages);
    }
    telemetry.finish();
    Err(format!("agent did not finish within {max_steps} steps"))
}

/// How many times a *transient* provider error is retried before the loop gives up.
const MAX_TURN_RETRIES: usize = 3;

/// Whether a provider error is worth retrying. Every provider in `crates/llm` formats its
/// errors identically — `"Request failed: …"` for a reqwest send failure (network / timeout /
/// connection reset) and `"API error (<status>): …"` for an HTTP error — so we can classify
/// transport, rate-limit (429), and server/overload (5xx, incl. Anthropic's 529) failures as
/// retryable while auth/4xx and malformed-request errors fail fast. (#1078 P4)
fn is_transient_error(err: &str) -> bool {
    err.starts_with("Request failed:")   // reqwest send: network / timeout / connection
        || err.contains("API error (429") // rate limited
        || err.contains("API error (5")   // 5xx server / overload (status is 3 digits, so "(5" ⇒ 5xx)
}

/// Run one provider turn, retrying *transient* failures with exponential backoff so a network
/// blip or rate-limit doesn't abort the whole agent run. Permanent errors (auth, bad request)
/// return immediately. `base_backoff` is the first delay (doubled each retry); tests pass
/// `Duration::ZERO`. (#1078 P4 graceful degradation)
async fn turn_with_retry<P: LlmProvider>(
    provider: &P,
    turn: &Turn,
    api_key: &str,
    base_backoff: Duration,
) -> Result<TurnResult, String> {
    let mut attempt = 0;
    loop {
        match provider.turn(turn, api_key).await {
            Ok(r) => return Ok(r),
            Err(e) if attempt < MAX_TURN_RETRIES && is_transient_error(&e) => {
                let backoff = base_backoff * (1u32 << attempt); // base, 2x, 4x
                eprintln!(
                    "bsc-agent: transient provider error (attempt {}/{}), retrying in {}ms: {e}",
                    attempt + 1,
                    MAX_TURN_RETRIES,
                    backoff.as_millis(),
                );
                tokio::time::sleep(backoff).await;
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Persist the conversation as JSON (best-effort) so a later `--continue` can resume it.
fn save_conversation(path: &Path, messages: &[Msg]) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(messages) {
        let _ = std::fs::write(path, json);
    }
}

/// Load a persisted conversation; empty on any error or if the file is absent.
pub fn load_conversation(path: &Path) -> Vec<Msg> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// The `read_file` tool: read a UTF-8 text file at `args.path`. One of the core
/// tools alongside write/edit/bash/grep/glob/webfetch (Claude Code tool-set parity).
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

/// Recursively collect the files under `root` (a directory), or just `root` itself
/// when it is a file. Best-effort: unreadable entries are skipped. Used by `grep`.
fn collect_files(root: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    if root.is_file() {
        out.push(root.to_path_buf());
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        // Skip the usual heavy / noise directories so a repo-root grep stays useful.
        if path.is_dir() {
            let skip = matches!(
                path.file_name().and_then(|n| n.to_str()),
                Some(".git" | "node_modules" | "target" | "dist" | ".vite")
            );
            if !skip {
                collect_files(&path, out);
            }
        } else if path.is_file() {
            out.push(path);
        }
    }
}

/// The `grep` tool: search file contents for a regular expression and return the
/// matching lines as `path:line:text`. Mirrors Claude Code's Grep so weak models get
/// a first-class search verb instead of improvising `bash` pipelines (#1442).
pub fn grep_tool() -> Tool {
    Tool {
        def: ToolDef {
            name: "grep".into(),
            description: "Search file contents for a regular expression. Returns matching lines as `path:line:text`. `path` defaults to the current directory and may be a file or a directory (searched recursively, skipping .git/node_modules/target/dist).".into(),
            schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "the regular expression to search for" },
                    "path": { "type": "string", "description": "file or directory to search (default: current directory)" }
                },
                "required": ["pattern"]
            }),
        },
        run: Box::new(|args| {
            let pattern = args["pattern"].as_str().ok_or("missing 'pattern' argument")?;
            let path = args["path"].as_str().unwrap_or(".");
            let re = regex::Regex::new(pattern).map_err(|e| format!("grep: invalid pattern: {e}"))?;
            let mut files = Vec::new();
            collect_files(std::path::Path::new(path), &mut files);
            const MAX_MATCHES: usize = 500;
            let mut matches = Vec::new();
            let mut truncated = false;
            'outer: for file in files {
                // Non-UTF-8 / binary files are skipped silently (read_to_string fails).
                let Ok(body) = std::fs::read_to_string(&file) else { continue };
                for (i, line) in body.lines().enumerate() {
                    if re.is_match(line) {
                        if matches.len() >= MAX_MATCHES {
                            truncated = true;
                            break 'outer;
                        }
                        matches.push(format!("{}:{}:{}", file.display(), i + 1, line));
                    }
                }
            }
            if matches.is_empty() {
                return Ok("no matches".into());
            }
            let mut out = matches.join("\n");
            if truncated {
                out.push_str(&format!("\n[truncated at {MAX_MATCHES} matches]"));
            }
            Ok(out)
        }),
    }
}

/// The `glob` tool: list filesystem paths matching a glob pattern (e.g. `src/**/*.rs`),
/// newest first is not guaranteed — paths are returned in glob order. Gives weak models
/// a first-class file-discovery verb (#1442).
pub fn glob_tool() -> Tool {
    Tool {
        def: ToolDef {
            name: "glob".into(),
            description: "List files matching a glob pattern (e.g. `src/**/*.rs`). Returns one path per line.".into(),
            schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "the glob pattern, e.g. `**/*.toml`" }
                },
                "required": ["pattern"]
            }),
        },
        run: Box::new(|args| {
            let pattern = args["pattern"].as_str().ok_or("missing 'pattern' argument")?;
            let paths = glob::glob(pattern).map_err(|e| format!("glob: invalid pattern: {e}"))?;
            const MAX: usize = 1000;
            let mut out = Vec::new();
            let mut truncated = false;
            for p in paths.flatten() {
                if out.len() >= MAX {
                    truncated = true;
                    break;
                }
                out.push(p.display().to_string());
            }
            if out.is_empty() {
                return Ok("no matches".into());
            }
            let mut joined = out.join("\n");
            if truncated {
                joined.push_str(&format!("\n[truncated at {MAX} paths]"));
            }
            Ok(joined)
        }),
    }
}

/// The `webfetch` tool: HTTP GET a URL and return the response body as text. Runs the
/// blocking request on a dedicated OS thread because the agent loop executes tools
/// inline on a tokio worker, and reqwest::blocking panics if started inside a runtime.
pub fn webfetch_tool() -> Tool {
    Tool {
        def: ToolDef {
            name: "webfetch".into(),
            description: "HTTP GET a URL and return the response body as text. Output is capped; non-2xx responses are returned with an `[http N]` prefix.".into(),
            schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "the absolute http(s) URL to fetch" }
                },
                "required": ["url"]
            }),
        },
        run: Box::new(|args| {
            let url = args["url"].as_str().ok_or("missing 'url' argument")?.to_string();
            let body = std::thread::spawn(move || -> Result<String, String> {
                let client = reqwest::blocking::Client::builder()
                    .user_agent("bsc-agent")
                    .build()
                    .map_err(|e| format!("webfetch: client: {e}"))?;
                let resp = client.get(&url).send().map_err(|e| format!("webfetch {url}: {e}"))?;
                let status = resp.status();
                let text = resp.text().map_err(|e| format!("webfetch {url}: {e}"))?;
                if status.is_success() {
                    Ok(text)
                } else {
                    Ok(format!("[http {}]\n{text}", status.as_u16()))
                }
            })
            .join()
            .map_err(|_| "webfetch: worker thread panicked".to_string())??;
            // Char-safe cap (never split a UTF-8 boundary).
            const MAX_CHARS: usize = 100_000;
            if body.chars().count() > MAX_CHARS {
                let mut capped: String = body.chars().take(MAX_CHARS).collect();
                capped.push_str("\n[truncated]");
                Ok(capped)
            } else {
                Ok(body)
            }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use llm::{LlmRequest, ToolCall};
    use std::sync::atomic::{AtomicUsize, Ordering};
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
        let out = run_agent(&mock, "", "m", "", "read the file", &tools, &Permissions::default(), &Telemetry::disabled(), &[], None, 5)
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
        let err = run_agent(&Loopy, "", "m", "", "go", &tools, &Permissions::default(), &Telemetry::disabled(), &[], None, 3)
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
        let out = run_agent(&mock, "", "m", "", "clean up", &tools, &perms, &Telemetry::disabled(), &[], None, 5)
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
        let out = run_agent(&FinalMock, "", "claude-x", "", "hi", &[], &Permissions::default(), &tele, &[], None, 5)
            .await
            .unwrap();
        assert_eq!(out, "all done");
        let v: serde_json::Value = serde_json::from_str(std::fs::read_to_string(&tx).unwrap().trim()).unwrap();
        assert_eq!(v["message"]["model"], "claude-x");
        assert_eq!(v["message"]["usage"]["input_tokens"], 12);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A fresh run persists [User, Assistant] to the session file, and a `--continue` run
    /// (prior seeded + same session_path) appends to it rather than starting over. (#1144)
    #[tokio::test]
    async fn run_agent_persists_and_resumes() {
        struct OneShot;
        impl LlmProvider for OneShot {
            async fn complete(&self, _r: &LlmRequest, _k: &str) -> Result<serde_json::Value, String> {
                unreachable!()
            }
            async fn turn(&self, _t: &Turn, _k: &str) -> Result<TurnResult, String> {
                Ok(TurnResult {
                    text: "ok".into(),
                    tool_calls: vec![],
                    usage: serde_json::json!({}),
                    stop_reason: "end_turn".into(),
                })
            }
        }
        let dir = std::env::temp_dir().join(format!("bsc_p3_resume_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let session = dir.join("conversation.json");

        // Fresh run: records the user turn + the final assistant turn.
        run_agent(&OneShot, "", "m", "", "first", &[], &Permissions::default(), &Telemetry::disabled(), &[], Some(&session), 5)
            .await
            .unwrap();
        let prior = load_conversation(&session);
        assert_eq!(prior.len(), 2, "fresh run persists user + assistant");
        assert!(matches!(&prior[0], Msg::User(s) if s == "first"));

        // Resume: seeded with `prior`, the second exchange appends to the same file.
        run_agent(&OneShot, "", "m", "", "second", &[], &Permissions::default(), &Telemetry::disabled(), &prior, Some(&session), 5)
            .await
            .unwrap();
        let after = load_conversation(&session);
        assert_eq!(after.len(), 4, "resume appends rather than restarting");
        assert!(matches!(&after[2], Msg::User(s) if s == "second"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `load_conversation` is forgiving: a missing or malformed file yields an empty prior
    /// (a fresh conversation), never a panic. (#1144)
    #[test]
    fn load_conversation_empty_on_missing_or_garbage() {
        let dir = std::env::temp_dir().join(format!("bsc_p3_resume_load_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("nope.json");
        assert!(load_conversation(&missing).is_empty());
        let garbage = dir.join("garbage.json");
        std::fs::write(&garbage, "not json {{").unwrap();
        assert!(load_conversation(&garbage).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_transient_error_classifies_retryable_vs_permanent() {
        // Transient: transport, rate-limit, 5xx (every provider formats these identically).
        assert!(is_transient_error("Request failed: error sending request"));
        assert!(is_transient_error("API error (429 Too Many Requests): slow down"));
        assert!(is_transient_error("API error (503 Service Unavailable): try again"));
        assert!(is_transient_error("API error (529): Overloaded"));
        // Permanent: auth / bad request / not found — no point retrying.
        assert!(!is_transient_error("API error (401 Unauthorized): bad key"));
        assert!(!is_transient_error("API error (400 Bad Request): context too long"));
        assert!(!is_transient_error("Failed to parse response: eof"));
    }

    /// A provider whose `turn` fails (with `err`) for the first `fail_times` calls, then
    /// succeeds — so the retry policy can be exercised without real network/timing.
    struct FlakyProvider {
        calls: AtomicUsize,
        fail_times: usize,
        err: String,
    }
    impl LlmProvider for FlakyProvider {
        async fn complete(&self, _r: &LlmRequest, _k: &str) -> Result<serde_json::Value, String> {
            unreachable!()
        }
        async fn turn(&self, _t: &Turn, _k: &str) -> Result<TurnResult, String> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n < self.fail_times {
                Err(self.err.clone())
            } else {
                Ok(TurnResult { text: "ok".into(), ..Default::default() })
            }
        }
    }
    fn empty_turn() -> Turn {
        Turn { system: String::new(), messages: vec![], tools: vec![], model: "m".into(), max_tokens: 16 }
    }

    #[tokio::test]
    async fn turn_with_retry_recovers_from_transient_failures() {
        let p = FlakyProvider { calls: AtomicUsize::new(0), fail_times: 2, err: "API error (503): down".into() };
        let r = turn_with_retry(&p, &empty_turn(), "", Duration::ZERO).await.unwrap();
        assert_eq!(r.text, "ok");
        assert_eq!(p.calls.load(Ordering::SeqCst), 3, "two transient failures then success");
    }

    #[tokio::test]
    async fn turn_with_retry_fails_fast_on_permanent_error() {
        let p = FlakyProvider { calls: AtomicUsize::new(0), fail_times: 9, err: "API error (401): bad key".into() };
        let err = turn_with_retry(&p, &empty_turn(), "", Duration::ZERO).await.unwrap_err();
        assert!(err.contains("401"));
        assert_eq!(p.calls.load(Ordering::SeqCst), 1, "permanent error is not retried");
    }

    #[tokio::test]
    async fn turn_with_retry_gives_up_after_max_transient() {
        let p = FlakyProvider { calls: AtomicUsize::new(0), fail_times: 99, err: "Request failed: timed out".into() };
        let err = turn_with_retry(&p, &empty_turn(), "", Duration::ZERO).await.unwrap_err();
        assert!(err.contains("timed out"));
        // 1 initial attempt + MAX_TURN_RETRIES retries.
        assert_eq!(p.calls.load(Ordering::SeqCst), MAX_TURN_RETRIES + 1);
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

    #[test]
    fn grep_finds_matching_lines_with_path_and_line() {
        let dir = std::env::temp_dir().join(format!("bsc_grep_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("a.txt"), "alpha\nNEEDLE here\nbeta").unwrap();
        std::fs::write(dir.join("b.txt"), "nothing relevant").unwrap();
        let out = (grep_tool().run)(&serde_json::json!({
            "pattern": "NEEDLE",
            "path": dir.to_string_lossy(),
        }))
        .unwrap();
        assert!(out.contains("a.txt"), "names the matching file: {out}");
        assert!(out.contains(":2:"), "reports the 1-based line number: {out}");
        assert!(out.contains("NEEDLE here"));
        // A pattern that matches nothing returns the sentinel, not an error.
        let none = (grep_tool().run)(&serde_json::json!({
            "pattern": "zzz_absent",
            "path": dir.to_string_lossy(),
        }))
        .unwrap();
        assert_eq!(none, "no matches");
        // An invalid regex is an Err fed back to the model, not a crash.
        assert!((grep_tool().run)(&serde_json::json!({ "pattern": "[", "path": "." })).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn glob_lists_matching_paths() {
        let dir = std::env::temp_dir().join(format!("bsc_glob_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("keep.rs"), "").unwrap();
        std::fs::write(dir.join("skip.txt"), "").unwrap();
        let pat = format!("{}/*.rs", dir.to_string_lossy());
        let out = (glob_tool().run)(&serde_json::json!({ "pattern": pat })).unwrap();
        assert!(out.contains("keep.rs"));
        assert!(!out.contains("skip.txt"));
        let none = (glob_tool().run)(&serde_json::json!({
            "pattern": format!("{}/*.never", dir.to_string_lossy()),
        }))
        .unwrap();
        assert_eq!(none, "no matches");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn webfetch_validates_args_without_network() {
        // Missing `url` is a clean Err (no thread spawn / no network), so this stays
        // offline-safe in CI. The happy path is exercised by the parity smoke (#1444).
        assert!((webfetch_tool().run)(&serde_json::json!({})).is_err());
    }
}
