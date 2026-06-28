//! The agent loop (epic #1078, P2a). Provider-agnostic: drive any `LlmProvider`
//! through tool-using turns until it returns a final answer.

use crate::permissions::Permissions;
use crate::telemetry::Telemetry;
use llm::{LlmProvider, Msg, ToolDef, Turn, TurnResult};
use serde_json::Value;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// A tool executor: takes the model-supplied `args` and returns its result (or error).
pub type ToolFn = Box<dyn Fn(&Value) -> Result<String, String>>;

/// A tool the agent can run: its declaration (sent to the model) plus an executor.
pub struct Tool {
    pub def: ToolDef,
    pub run: ToolFn,
}

/// Normalize a tool name for tolerant matching: lowercase, fold separators (`-`/space) to `_`, and
/// collapse the MCP-style double underscore a local model imitates (`file__create` → `file_create`).
fn normalize_tool_name(s: &str) -> String {
    s.trim().to_ascii_lowercase().replace(['-', ' '], "_").replace("__", "_")
}

/// Resolve a model-emitted tool name to a real [`Tool`], tolerating the near-miss names local models
/// reach for instead of bouncing the call as "unknown tool". Three tiers, most-specific first:
///   1. exact name match (the normal path — Anthropic + a well-behaved local model);
///   2. normalized match (`file__create` → `file_create`, `File-Info` → `file_info`) — qwen3-coder
///      MCP-namespaces the file verbs with `__`, which otherwise never matches;
///   3. a small alias map for common synonyms (`create_file`/`str_replace`/`run`/`cat`/…).
///
/// An exact match always wins, so a real tool name is never remapped. Pure → unit-tested.
/// Tool-name aliases: a near-miss name a local model reaches for → the canonical tool. Table-driven
/// (#1846) so the synonyms live in data, not a match arm; `every_alias_targets_a_real_native_tool…`
/// asserts every target is a real native tool, so the table can't point at a renamed/removed tool.
const TOOL_ALIASES: &[(&str, &str)] = &[
    ("file_create", "write_file"), ("create_file", "write_file"), ("file_write", "write_file"),
    ("new_file", "write_file"), ("newfile", "write_file"), ("make_file", "write_file"), ("save_file", "write_file"),
    ("file_edit", "edit_file"), ("str_replace", "edit_file"), ("str_replace_editor", "edit_file"),
    ("replace_in_file", "edit_file"), ("apply_patch", "edit_file"), ("patch_file", "edit_file"),
    ("file_read", "read_file"), ("open_file", "read_file"), ("cat", "read_file"), ("view_file", "read_file"),
    ("file_list", "list_files"), ("list_dir", "list_files"), ("listdir", "list_files"),
    ("list_directory", "list_files"), ("ls", "list_files"),
    ("file_stat", "file_info"), ("stat", "file_info"),
    ("run", "bash"), ("run_command", "bash"), ("shell", "bash"), ("exec", "bash"),
    ("execute", "bash"), ("command", "bash"), ("run_shell", "bash"),
    ("search", "grep"), ("grep_search", "grep"), ("ripgrep", "grep"),
    ("glob_search", "glob"), ("find_files", "glob"),
    ("fetch", "webfetch"), ("http_get", "webfetch"), ("web_fetch", "webfetch"), ("curl", "webfetch"),
];

fn resolve_tool<'a>(name: &str, tools: &'a [Tool]) -> Option<&'a Tool> {
    if let Some(t) = tools.iter().find(|t| t.def.name == name) {
        return Some(t);
    }
    let n = normalize_tool_name(name);
    if let Some(t) = tools.iter().find(|t| normalize_tool_name(&t.def.name) == n) {
        return Some(t);
    }
    // Synonyms a model invents when it doesn't echo our exact verb (the TOOL_ALIASES table). Map to a
    // canonical tool name, then look it up in the live set (so an alias for an unavailable tool misses).
    let alias = TOOL_ALIASES.iter().find(|(a, _)| *a == n.as_str()).map(|(_, target)| *target)?;
    tools.iter().find(|t| t.def.name == alias)
}

// --- Runtime bridges -------------------------------------------------------
//
// A tool's [`ToolFn`] is **synchronous** (`Fn(&Value) -> Result<String, String>`) and runs inline
// on the tokio worker that drives the agent loop, but some tools need work that can't simply run
// there. There are two distinct sync→async bridges, deliberately kept as TWO helpers because they
// are NOT interchangeable:
//
// - [`run_off_runtime`] moves the work onto a **dedicated OS thread** and joins it. Used when the
//   work must run with NO ambient tokio runtime: `reqwest::blocking` panics if started inside a
//   runtime (`webfetch`), and the `task` sub-agent builds its OWN current-thread runtime on that
//   thread (a `block_on` would refuse to nest inside the parent runtime).
// - [`block_on_tool`] stays on the **current** (ambient) multi-thread runtime: `block_in_place` so
//   blocking the worker doesn't stall the whole runtime, then `block_on`s the future. Used when the
//   async work needs the live runtime (the MCP executor's shared client + I/O). It REQUIRES the
//   multi-thread runtime `bsc-agent` runs on — `block_in_place` panics on a current-thread runtime.

/// Run blocking work on a dedicated OS thread, away from the agent's tokio worker, and return its
/// result. See the module's "Runtime bridges" note for why this is separate from [`block_on_tool`].
pub fn run_off_runtime<T: Send>(f: impl FnOnce() -> Result<T, String> + Send) -> Result<T, String> {
    std::thread::scope(|s| s.spawn(f).join()).map_err(|_| "tool worker thread panicked".to_string())?
}

/// Block on `fut` from a sync tool body using the **current** multi-thread runtime
/// (`block_in_place` + `Handle::block_on`). See the module's "Runtime bridges" note; panics if the
/// ambient runtime is current-thread.
pub fn block_on_tool<F: std::future::Future>(fut: F) -> F::Output {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(fut))
}

/// Tokens held back from the context budget for the model's response + an incoming tool result — so a
/// compacted prompt still has room to answer. (`max_tokens` is 4096.) (#1831)
const COMPACT_RESERVE_TOKENS: usize = 4096 + 512;

/// Rough token estimate for a string — chars/4 (good enough to keep a conversation under the model's
/// context window; exact per-model tokenization isn't worth a dependency here). (#1831)
fn estimate_tokens(s: &str) -> usize {
    s.len() / 4 + 1
}

/// Approximate tokens a message contributes to the prompt.
fn msg_tokens(m: &Msg) -> usize {
    match m {
        Msg::User(s) => estimate_tokens(s),
        Msg::Assistant { text, tool_calls } => {
            estimate_tokens(text)
                + tool_calls
                    .iter()
                    .map(|tc| estimate_tokens(&tc.name) + estimate_tokens(&tc.args.to_string()))
                    .sum::<usize>()
        }
        Msg::ToolResult { content, .. } => estimate_tokens(content),
    }
}

/// Compact a conversation to fit a context `budget` (#1831): keep the system prompt (counted via
/// `system_tokens`, separate from `messages`), the first user message (the task), and the most-recent
/// messages that fit; elide the middle, replacing it with a marker. Drops only at safe boundaries — a
/// dangling tool-result whose assistant call was elided is removed too — so the OpenAI/Ollama
/// tool_call↔result pairing stays valid. Returns the (possibly) compacted messages + whether it
/// changed anything. Pure → unit-tested. (Elision, not summarization — a summarize pass is a future
/// refinement.)
pub(crate) fn compact_messages(
    system_tokens: usize,
    messages: Vec<Msg>,
    budget: usize,
    reserve: usize,
) -> (Vec<Msg>, bool) {
    let usable = budget.saturating_sub(reserve);
    let total: usize = system_tokens + messages.iter().map(msg_tokens).sum::<usize>();
    if total <= usable || messages.len() <= 2 {
        return (messages, false);
    }
    // Anchor the first user message (the task), if the head is one.
    let mut head: Vec<Msg> = Vec::new();
    if matches!(messages.first(), Some(Msg::User(_))) {
        head.push(messages[0].clone());
    }
    let marker = Msg::User("[earlier conversation elided to fit the context window]".to_string());
    let head_tokens: usize = head.iter().map(msg_tokens).sum::<usize>() + msg_tokens(&marker);
    let mut budget_left = usable.saturating_sub(system_tokens + head_tokens);
    // Keep the most-recent messages that fit (scanning from the end, after the anchored head).
    let mut kept_rev: Vec<Msg> = Vec::new();
    for m in messages[head.len()..].iter().rev() {
        let t = msg_tokens(m);
        if t > budget_left {
            break;
        }
        budget_left -= t;
        kept_rev.push(m.clone());
    }
    kept_rev.reverse();
    // The kept region must not begin with a dangling tool-result (its assistant call was elided).
    while matches!(kept_rev.first(), Some(Msg::ToolResult { .. })) {
        kept_rev.remove(0);
    }
    let mut out = head;
    out.push(marker);
    out.extend(kept_rev);
    (out, true)
}

/// Run the agent loop: build a [`Turn`] from the conversation + tools, ask the
/// provider, and while it returns tool calls, execute them, append the results, and
/// continue — until the provider answers with no tool calls (final text) or the
/// step budget runs out. Assistant text and a `[tool] <name>` trace are printed as
/// they happen (the binary runs inside the PTY).
///
/// `interactive` keeps the session alive like Claude Code's REPL: after a task settles (a final
/// answer or an exhausted budget) it reads the next user turn from **stdin** and continues the
/// conversation, persisting after each turn, until stdin reaches EOF (the pane closed). Without it
/// the loop runs the one task and returns — the right behavior for a sub-agent / one-shot call. The
/// interactive path is what makes the planner / director usable on bsc-agent: the user keeps steering
/// instead of the process exiting (and ending the PTY) after the first response.
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
    interactive: bool,
) -> Result<String, String> {
    let mut messages: Vec<Msg> = prior.to_vec();
    messages.push(Msg::User(user.to_string()));
    let tool_defs: Vec<ToolDef> = tools.iter().map(|t| t.def.clone()).collect();
    let mut last_text = String::new();

    // Context-budget compaction (#1831): the model's usable window in tokens, set by the app from the
    // provider's num_ctx ($BSC_AGENT_CONTEXT_BUDGET; defaults high for hosted models, so a no-op there).
    // The fixed system prompt + a response reserve are subtracted; older turns are elided to fit.
    let context_budget: usize = std::env::var("BSC_AGENT_CONTEXT_BUDGET")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(200_000);
    let system_tokens = estimate_tokens(&format!("{AGENT_INSTRUCTIONS}\n\n{system}"));
    let mut announced_compaction = false;

    // Outer loop = one iteration per USER turn. One-shot (non-interactive) runs it exactly once; in
    // interactive mode each pass handles a user message, then blocks for the next on stdin.
    loop {
        let mut answered = false;
        for step in 0..max_steps {
            // Compact older turns to fit the model's context window (#1831) — a clone for THIS request;
            // the persisted `messages` keep the full history (a later `--continue` loses nothing it
            // wouldn't have had to drop anyway).
            let (turn_messages, did_compact) =
                compact_messages(system_tokens, messages.clone(), context_budget, COMPACT_RESERVE_TOKENS);
            if did_compact && !announced_compaction {
                eprintln!("\x1b[2m· compacted older turns to fit the ~{context_budget}-token context window\x1b[0m");
                announced_compaction = true;
            }
            let turn = Turn {
                system: format!(
                    "{AGENT_INSTRUCTIONS}\n\n{}",
                    system
                ),
                messages: turn_messages,
                tools: tool_defs.clone(),
                model: model.to_string(),
                max_tokens: 4096,
            };
            // Per-turn heartbeat to the PTY (stderr): the request is non-streaming, so without this
            // the pane shows nothing while the model thinks — indistinguishable from a hang. Dim, so
            // it doesn't clutter the real output.
            eprintln!("\x1b[2m· thinking (step {}/{max_steps})…\x1b[0m", step + 1);
            let mut result = turn_with_retry(provider, &turn, api_key, Duration::from_millis(500)).await?;
            // Fallback for local models (#1078): some — notably qwen via Ollama — emit tool calls as
            // TEXT (`<tool_call>{…}</tool_call>` / `<function=name>…</function>`) instead of the
            // structured `tool_calls` field, which the OpenAI-compat endpoint then doesn't convert.
            // When the structured field is empty, recover any call from the text so it still runs (and
            // strip the raw syntax from what we display).
            if result.tool_calls.is_empty() {
                let recovered = llm::recover_tool_calls(&result.text);
                if !recovered.is_empty() {
                    result.text = llm::strip_tool_syntax(&result.text);
                    result.tool_calls = recovered;
                }
            }
            // Record every assistant turn to the transcript (cost accounting reads its usage).
            telemetry.record_assistant(model, &result.usage);
            if !result.text.is_empty() {
                println!("{}", result.text);
            }
            if result.tool_calls.is_empty() {
                // Final answer for this user turn: record it, persist, stop stepping.
                messages.push(Msg::Assistant { text: result.text.clone(), tool_calls: vec![] });
                if let Some(p) = session_path {
                    save_conversation(p, &messages);
                }
                last_text = result.text.clone();
                answered = true;
                break;
            }
            messages.push(Msg::Assistant {
                text: result.text.clone(),
                tool_calls: result.tool_calls.clone(),
            });
            for tc in &result.tool_calls {
                // Tolerant name resolution (#qwen): map a near-miss name (`file__create`) to the real
                // tool BEFORE gating/auditing, so perms + audit + the trace all use the canonical name.
                let resolved = resolve_tool(&tc.name, tools);
                let name = resolved.map(|t| t.def.name.as_str()).unwrap_or(tc.name.as_str());
                println!("[tool] {name}");
                // Permission gate: a denial is fed back as the tool result (so the model
                // sees it and adapts) rather than crashing the loop.
                let output = match perms.check(name, &tc.args) {
                    Err(reason) => {
                        println!("[denied] {name}");
                        reason
                    }
                    Ok(()) => {
                        telemetry.audit(name, &tc.args); // one audit line per executed tool
                        match resolved {
                            Some(tool) => (tool.run)(&tc.args).unwrap_or_else(|e| format!("error: {e}")),
                            None => format!("error: unknown tool '{}'", tc.name),
                        }
                    }
                };
                messages.push(Msg::ToolResult { id: tc.id.clone(), content: output });
            }
        }

        // The agentic loop for this user turn ended. If it ran out of steps without a final answer,
        // persist what we have; one-shot surfaces the budget error, interactive notes it and waits.
        if !answered {
            if let Some(p) = session_path {
                save_conversation(p, &messages);
            }
            if !interactive {
                telemetry.finish();
                return Err(format!("agent did not finish within {max_steps} steps"));
            }
            eprintln!("\x1b[2m· (reached the {max_steps}-step budget for this turn — add direction to continue)\x1b[0m");
        }

        // One-shot mode returns the final answer (the historical contract). Interactive mode waits
        // for the next user message and loops; EOF on stdin (pane closed / Ctrl-D) ends the session.
        if !interactive {
            telemetry.finish();
            return Ok(last_text);
        }
        match read_next_user_turn().await {
            Some(next) => messages.push(Msg::User(next)),
            None => {
                telemetry.finish();
                return Ok(last_text);
            }
        }
    }
}

/// Block (off the async worker) for the next user turn from stdin, echoing a prompt first. Returns
/// `None` on EOF (the PTY closed) so the caller ends the session; skips blank lines so a stray Enter
/// doesn't submit an empty turn. The PTY is in canonical mode, so the terminal line-edits + echoes
/// the user's typing — they see what they enter.
async fn read_next_user_turn() -> Option<String> {
    use std::io::{BufRead, Write};
    loop {
        // A visible, distinct prompt so the user knows the agent is waiting for them (not hung).
        eprint!("\n\x1b[1;36m› \x1b[0m");
        let _ = std::io::stderr().flush();
        let line = tokio::task::spawn_blocking(|| {
            let mut s = String::new();
            match std::io::stdin().lock().read_line(&mut s) {
                Ok(0) | Err(_) => None, // EOF or read error
                Ok(_) => Some(s),
            }
        })
        .await
        .ok()
        .flatten()?;
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
        // Blank line — re-prompt rather than submitting an empty turn.
    }
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

/// Resolve a real `bash` for the `bash` tool. **Critical on Windows:** a bare `bash` on PATH
/// resolves to `C:\Windows\System32\bash.exe` — the WSL launcher — which fails with
/// `execvpe(/bin/bash): No such file or directory` when no WSL distro is installed. So prefer, in
/// order: `$BSC_AGENT_BASH` (the exact Git Bash the app's session shell runs under, set in
/// `wire_bsc_env`), then a real `$SHELL`, then a located Git Bash, before the bare `bash` fallback.
/// (Mirrors the app's `platform::shell::resolve_shell`; bsc-agent can't depend on `src-tauri`, so the
/// minimal Windows search is duplicated here to keep the standalone binary self-sufficient.)
fn resolve_bash() -> String {
    if let Ok(b) = std::env::var("BSC_AGENT_BASH") {
        let b = b.trim();
        if !b.is_empty() {
            return b.to_string();
        }
    }
    if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() && std::path::Path::new(&s).exists() {
            return s;
        }
    }
    #[cfg(windows)]
    if let Some(b) = find_git_bash() {
        return b;
    }
    "bash".to_string()
}

/// Locate Git Bash's `bash.exe` (never WSL's System32 stub) under the common install roots. Windows
/// only; returns the first existing `bin\bash.exe` or `usr\bin\bash.exe`.
#[cfg(windows)]
fn find_git_bash() -> Option<String> {
    use std::path::PathBuf;
    let mut roots: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Ok(p) = std::env::var(var) {
            roots.push(PathBuf::from(p).join("Git"));
        }
    }
    if let Ok(p) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(p).join("Programs").join("Git"));
    }
    roots.push(PathBuf::from(r"C:\Program Files\Git"));
    for root in roots {
        let bin = root.join("bin").join("bash.exe");
        if bin.exists() {
            return Some(bin.to_string_lossy().into_owned());
        }
        let usr = root.join("usr").join("bin").join("bash.exe");
        if usr.exists() {
            return Some(usr.to_string_lossy().into_owned());
        }
    }
    None
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
            let shell = resolve_bash();
            let output = std::process::Command::new(&shell)
                .arg("-c")
                .arg(command)
                .output()
                .map_err(|e| format!("bash: failed to spawn '{shell}': {e}"))?;
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

/// Run a project `bsc-*` CLI by name via `bash -c "<cli> <args>"` (so the BASH_ENV shell function that
/// execs the staged sidecar is in scope), feeding `stdin` to it when provided. Returns combined
/// stdout+stderr (a non-zero exit is appended as `[exit N]`, not an error — the model reads it).
/// Shared by every [`bsc_cli_tool`]. (#qwen)
fn run_bsc_cli(cli: &str, args: &str, stdin: Option<&str>) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;
    let shell = resolve_bash();
    let line = if args.trim().is_empty() { cli.to_string() } else { format!("{cli} {}", args.trim()) };
    let mut child = std::process::Command::new(&shell)
        .arg("-c")
        .arg(&line)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{cli}: failed to spawn '{shell}': {e}"))?;
    if let Some(s) = stdin {
        if let Some(mut si) = child.stdin.take() {
            let _ = si.write_all(s.as_bytes());
        } // dropped here → EOF, so a CLI that reads stdin (e.g. `bsc-plan add`) doesn't hang
    }
    let output = child.wait_with_output().map_err(|e| format!("{cli}: {e}"))?;
    let mut out = String::new();
    out.push_str(&String::from_utf8_lossy(&output.stdout));
    out.push_str(&String::from_utf8_lossy(&output.stderr));
    if !output.status.success() {
        let code = output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
        out.push_str(&format!("\n[exit {code}]"));
    }
    Ok(out)
}

/// Pull the command-argument string + optional stdin out of a model's tool-call arguments, however it
/// shaped them — so a `bsc-*` tool runs like the normal command it is rather than depending on one
/// exact arg key (#qwen). A local model may pass the args under `args`/`command`/`cmd`/`argv`/
/// `subcommand`, as a string OR an argv array, or just splat positional values into the object; any of
/// those reconstructs the same command line. `stdin` (or `input`) pipes input for a write. Pure.
fn extract_cli_args(v: &Value) -> (String, Option<String>) {
    let stdin = ["stdin", "input"]
        .iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    // An explicit arguments field wins — as a string ("list --limit 5") or an argv array.
    for key in ["args", "arguments", "command", "cmd", "argv", "subcommand"] {
        match v.get(key) {
            Some(Value::String(s)) => return (s.trim().to_string(), stdin),
            Some(Value::Array(arr)) => {
                let joined = arr.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ");
                return (joined.trim().to_string(), stdin);
            }
            _ => {}
        }
    }
    // Fallback: treat the object as positional args — join its scalar values (skipping the stdin
    // keys), so `{ "0": "list", "1": "--limit", "2": "5" }` or `{ "x": "summary" }` still runs.
    let positional: Vec<String> = v
        .as_object()
        .map(|o| {
            o.iter()
                .filter(|(k, _)| !matches!(k.as_str(), "stdin" | "input"))
                .filter_map(|(_, val)| match val {
                    Value::String(s) => Some(s.clone()),
                    Value::Number(n) => Some(n.to_string()),
                    Value::Bool(b) => Some(b.to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    (positional.join(" ").trim().to_string(), stdin)
}

/// A FIRST-CLASS tool for one project `bsc-*` CLI (#qwen). Local models (qwen especially) call a CLI
/// like `bsc-plan` as a *tool*, not via the `bash` tool — and then bounce off "unknown tool" and give
/// up. So we hand them the tool by its real name: `args` is the CLI argument string (`"summary"`,
/// `"list --status open"`), `stdin` optionally pipes input (JSON for a write like `add`). It runs
/// `<cli> <args>` through bash exactly as the user would. Same intent-named-tool fix as `list_files`.
/// Only registered when the CLI is actually staged this session (its `$BSC_*_BIN` is set), so an
/// alias for an absent CLI never appears.
pub fn bsc_cli_tool(cli: &'static str) -> Tool {
    Tool {
        def: ToolDef {
            name: cli.to_string(),
            description: format!(
                "Run the `{cli}` project CLI. Put the CLI arguments in `args` (e.g. \"summary\" or \
                 \"list --limit 5\"); use `args: \"help\"` to see its commands, then `args: \"<command> help\"` \
                 for one command's args. Pipe input (e.g. JSON for a write) via `stdin`. Equivalent to \
                 running `{cli} <args>` in the shell."
            ),
            schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "args": { "type": "string", "description": "the CLI arguments, e.g. \"summary\" or \"list --limit 5\" (empty runs the CLI with no args — its help/overview)" },
                    "stdin": { "type": "string", "description": "optional text piped to the command's stdin (e.g. JSON for a write command)" }
                }
            }),
        },
        run: Box::new(move |args| {
            // Tolerant of however the model shaped the call, so it runs like the normal command it is.
            let (a, stdin) = extract_cli_args(args);
            run_bsc_cli(cli, &a, stdin.as_deref())
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
            let body = run_off_runtime(move || -> Result<String, String> {
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
            })?;
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

/// Max sub-agent nesting depth. A `task` tool built at depth `d` refuses to spawn when
/// `d >= MAX_TASK_DEPTH` — the root tool set is depth 0, so this permits `MAX_TASK_DEPTH`
/// levels of delegation (director → sub-agent → sub-sub-agent) before the backstop trips.
const MAX_TASK_DEPTH: usize = 2;
/// Process-wide cap on the total number of sub-agents spawned in one run — a backstop
/// against a model fanning out unboundedly. Never reset (one process = one agent run).
const MAX_TASK_CHILDREN: usize = 32;
/// Step budget for a sub-agent loop (mirrors the root loop's 20).
const MAX_TASK_STEPS: usize = 20;
/// Prepended to the inherited project context so a delegated child knows its remit.
const TASK_SYSTEM_PREFIX: &str = "You are a sub-agent spawned to complete one focused task. Work autonomously with the tools available and return your final answer as plain text when you are done.\n\n";
const AGENT_INSTRUCTIONS: &str = include_str!("../data/agent-instructions.md");

static TASK_CHILDREN_SPAWNED: AtomicUsize = AtomicUsize::new(0);

/// The native tool builders every `bsc-agent` session is launched with — the file/shell/search/web
/// verbs as one registry (#1846), so adding a verb is one line here. `list_files`/`file_info` are
/// FIRST-CLASS, INTENT-NAMED tools (backed by the `bsc-files` LIBRARY in-process — no subprocess, no
/// binary-path fragility) because a local model reaches for "list/show the files" and kept inventing
/// `*_list` names when nothing matched — clearly-named tools it calls as reliably as MCP tools (the
/// prose-only hint didn't work, and a single args-string tool got fumbled).
const NATIVE_TOOL_BUILDERS: &[fn() -> Tool] = &[
    read_file_tool,
    write_file_tool,
    edit_file_tool,
    bash_tool,
    grep_tool,
    glob_tool,
    webfetch_tool,
    list_files_tool,
    file_info_tool,
];

/// The standard tool set every `bsc-agent` session (root or sub-agent) is launched with: the native
/// [`NATIVE_TOOL_BUILDERS`] verbs plus a [`task_tool`] for delegation. The provider / model /
/// permissions are threaded through so the `task` tool can spawn a child loop on the same provider
/// under the same (no broader) grants. `depth` is the caller's nesting level (0 at the root); the
/// child receives `depth + 1`.
pub fn default_tools<P: LlmProvider + Send + Sync + 'static>(
    provider: Arc<P>,
    api_key: String,
    model: String,
    system: String,
    perms: Permissions,
    depth: usize,
) -> Vec<Tool> {
    let mut tools: Vec<Tool> = NATIVE_TOOL_BUILDERS.iter().map(|b| b()).collect();
    tools.push(task_tool(provider, api_key, model, system, perms, depth));
    tools
}

/// `list_files` — the project's folder structure with file sizes/counts/language (gitignore-aware),
/// rendered from `bsc_files::build_tree`. The model's natural "list/show the files" verb.
fn list_files_tool() -> Tool {
    Tool {
        def: ToolDef {
            name: "list_files".into(),
            description: "List the project's files and folders under a path — each file's size and language, each directory's aggregate size and file count. The fast way to understand the codebase layout; respects .gitignore. Use this instead of guessing at the structure.".into(),
            schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "directory to list, relative to the project root (default \".\")" },
                    "depth": { "type": "integer", "description": "limit the tree to this many levels (optional)" }
                }
            }),
        },
        run: Box::new(|args| {
            let rel = args["path"].as_str().filter(|s| !s.is_empty()).unwrap_or(".");
            let depth = args["depth"].as_u64().map(|d| d as usize);
            let base = std::env::current_dir().map_err(|e| format!("list_files: cwd: {e}"))?.join(rel);
            let node = bsc_files::build_tree(&base, &bsc_files::TreeOpts::default())?;
            let mut out = bsc_files::render_tree(&node, depth);
            out.push_str(&format!("\n{} files, {}", node.files, bsc_files::human_size(node.size)));
            Ok(out)
        }),
    }
}

/// `file_info` — size, language, and line count for one path, from `bsc_files::stat`.
fn file_info_tool() -> Tool {
    Tool {
        def: ToolDef {
            name: "file_info".into(),
            description: "Report a single file or directory's size, language, and line count.".into(),
            schema: serde_json::json!({
                "type": "object",
                "properties": { "path": { "type": "string", "description": "the file or directory, relative to the project root" } },
                "required": ["path"]
            }),
        },
        run: Box::new(|args| {
            let rel = args["path"].as_str().ok_or("file_info: missing 'path'")?;
            let base = std::env::current_dir().map_err(|e| format!("file_info: cwd: {e}"))?.join(rel);
            Ok(bsc_files::stat(&base, true)?.lean())
        }),
    }
}

/// The `task` tool: delegate a focused sub-task to a child agent loop. The child runs the
/// SAME provider/model under the SAME [`Permissions`] (a sub-agent can never exceed its
/// parent's grants — the permission set is passed through unchanged), with a fresh
/// conversation that is not persisted, and returns its final text as the tool result.
///
/// Two backstops bound runaway delegation: a per-call depth check ([`MAX_TASK_DEPTH`]) and
/// a process-wide child counter ([`MAX_TASK_CHILDREN`]).
///
/// The child loop is async but the agent runs tools inline on a tokio worker, so the child
/// runs on a dedicated OS thread with its own current-thread runtime — `block_on` inside
/// the parent runtime would panic (mirrors `webfetch`'s blocking isolation).
pub fn task_tool<P: LlmProvider + Send + Sync + 'static>(
    provider: Arc<P>,
    api_key: String,
    model: String,
    system: String,
    perms: Permissions,
    depth: usize,
) -> Tool {
    Tool {
        def: ToolDef {
            name: "task".into(),
            description: "Delegate a focused, self-contained sub-task to a sub-agent. The sub-agent runs its own tool-using loop under the same permissions and returns its final answer as text. Use it to hand off independent work (research, a contained edit, a verification pass).".into(),
            schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "the task for the sub-agent to complete, with all the context it needs" }
                },
                "required": ["prompt"]
            }),
        },
        run: Box::new(move |args| {
            let prompt = args["prompt"].as_str().ok_or("missing 'prompt' argument")?.to_string();
            if depth >= MAX_TASK_DEPTH {
                return Err(format!(
                    "task: max sub-agent depth ({MAX_TASK_DEPTH}) reached — handle this work directly"
                ));
            }
            if TASK_CHILDREN_SPAWNED.fetch_add(1, Ordering::SeqCst) >= MAX_TASK_CHILDREN {
                return Err(format!("task: max sub-agent count ({MAX_TASK_CHILDREN}) reached"));
            }
            // Clone the captured session config for the child (the closure is `Fn`, so it
            // may run many times — each spawns its own child).
            let provider = Arc::clone(&provider);
            let (api_key, model, perms) = (api_key.clone(), model.clone(), perms.clone());
            let system = format!("{TASK_SYSTEM_PREFIX}{system}");
            run_off_runtime(move || -> Result<String, String> {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|e| format!("task: runtime: {e}"))?;
                rt.block_on(async {
                    // The child gets its own telemetry session (own id + transcript) writing to
                    // the SAME log files, so the nested run is visible to the app's readers.
                    let tele = Telemetry::from_env();
                    let child_tools = default_tools(
                        Arc::clone(&provider),
                        api_key.clone(),
                        model.clone(),
                        system.clone(),
                        perms.clone(),
                        depth + 1,
                    );
                    run_agent(
                        &*provider, &api_key, &model, &system, &prompt, &child_tools, &perms, &tele,
                        &[], None, MAX_TASK_STEPS, false, // sub-agent: one-shot, never reads stdin
                    )
                    .await
                })
            })
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use llm::{LlmRequest, ToolCall};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::cell::Cell;

    #[test]
    fn compact_messages_leaves_a_short_conversation_unchanged() {
        let msgs = vec![
            Msg::User("hi".into()),
            Msg::Assistant { text: "hello".into(), tool_calls: vec![] },
        ];
        let (out, did) = compact_messages(10, msgs.clone(), 10_000, 100);
        assert!(!did, "well under budget ⇒ no compaction");
        assert_eq!(out.len(), msgs.len());
    }

    #[test]
    fn compact_messages_elides_the_middle_and_keeps_tool_pairing() {
        // task + 10 tool rounds (~100 tokens of content each) + a final turn; a tight budget forces
        // elision of the middle.
        let mut msgs = vec![Msg::User("TASK: do the thing".into())];
        for i in 0..10 {
            msgs.push(Msg::Assistant {
                text: String::new(),
                tool_calls: vec![ToolCall { id: format!("c{i}"), name: "read_file".into(), args: serde_json::json!({ "path": format!("file{i}") }) }],
            });
            msgs.push(Msg::ToolResult { id: format!("c{i}"), content: "x".repeat(400) });
        }
        msgs.push(Msg::User("FINAL question".into()));
        let before = msgs.len();

        let (out, did) = compact_messages(100, msgs, 600, 100); // usable = 500 tokens
        assert!(did, "over budget ⇒ compacts");
        assert!(out.len() < before, "the middle is elided");
        // Anchored: the original task first, then the elision marker.
        assert!(matches!(&out[0], Msg::User(s) if s.starts_with("TASK")));
        assert!(matches!(&out[1], Msg::User(s) if s.contains("elided")));
        // The most-recent turn survives.
        assert!(matches!(out.last(), Some(Msg::User(s)) if s.starts_with("FINAL")));
        // Pairing intact: every kept tool-result follows an assistant tool-call (or another result) —
        // never a dangling result whose call was elided.
        for w in out.windows(2) {
            if matches!(&w[1], Msg::ToolResult { .. }) {
                assert!(
                    matches!(&w[0], Msg::Assistant { tool_calls, .. } if !tool_calls.is_empty())
                        || matches!(&w[0], Msg::ToolResult { .. }),
                    "a kept tool-result must follow its assistant call (or another result)",
                );
            }
        }
        // Fits the usable budget after compaction.
        let after: usize = 100 + out.iter().map(msg_tokens).sum::<usize>();
        assert!(after <= 500, "compacted to within usable budget, got {after}");
    }

    /// The injected instructions must teach a local model the thing it kept getting wrong: a CLI like
    /// `bsc-files` is run THROUGH the `bash` tool, not as its own function — and it must never refuse
    /// a command as "unsupported". Guards against the preamble drifting back to a bare tool list.
    /// The file-structure tools are the reliable, MCP-style surface a local model actually calls (vs.
    /// the prose-only hint it ignored / the args-string it fumbled). Intent-named, and they run.
    #[test]
    fn resolve_tool_maps_near_miss_names_to_real_tools() {
        // The real set a session is launched with (a representative subset).
        let tools = vec![write_file_tool(), edit_file_tool(), read_file_tool(), bash_tool(), list_files_tool(), file_info_tool()];
        let name = |n: &str| super::resolve_tool(n, &tools).map(|t| t.def.name.as_str());
        // Exact match wins (a real name is never remapped).
        assert_eq!(name("write_file"), Some("write_file"));
        // qwen's MCP-namespaced verbs: normalized + aliased.
        assert_eq!(name("file__create"), Some("write_file"));
        assert_eq!(name("file__edit"), Some("edit_file"));
        assert_eq!(name("file__info"), Some("file_info")); // normalized match, no alias needed
        // Common synonyms from other local models.
        assert_eq!(name("create_file"), Some("write_file"));
        assert_eq!(name("str_replace"), Some("edit_file"));
        assert_eq!(name("run"), Some("bash"));
        assert_eq!(name("File-Info"), Some("file_info")); // case + separator folding
        // A genuinely unknown name still misses (fed back to the model as an error).
        assert_eq!(name("frobnicate"), None);
        // An alias for a tool that ISN'T in this session's set misses (grep absent here).
        assert_eq!(name("ripgrep"), None);
    }

    #[test]
    fn every_alias_targets_a_real_native_tool_and_aliases_are_unique() {
        // #1846 drift guard: the TOOL_ALIASES table can only point at a tool NATIVE_TOOL_BUILDERS
        // actually builds, so renaming/removing a tool forces fixing its aliases (else this fails) —
        // the alias table and the tool registry can't diverge.
        let names: std::collections::HashSet<String> =
            NATIVE_TOOL_BUILDERS.iter().map(|b| b().def.name).collect();
        let mut seen = std::collections::HashSet::new();
        for (alias, target) in TOOL_ALIASES {
            assert!(names.contains(*target), "alias '{alias}' targets unknown tool '{target}'");
            assert!(seen.insert(*alias), "duplicate alias '{alias}'");
        }
    }

    #[test]
    fn extract_cli_args_handles_the_shapes_a_local_model_uses() {
        use serde_json::json;
        let go = |v| super::extract_cli_args(&v);
        // The documented shape.
        assert_eq!(go(json!({ "args": "summary" })), ("summary".to_string(), None));
        // Alternate arg keys, an argv array, and stdin for a write.
        assert_eq!(go(json!({ "command": "list --limit 5" })).0, "list --limit 5");
        assert_eq!(go(json!({ "argv": ["list", "--status", "open"] })).0, "list --status open");
        assert_eq!(go(json!({ "args": "add", "stdin": "[{}]" })), ("add".to_string(), Some("[{}]".to_string())));
        // Positional splat fallback (sorted keys "0","1" → "fleet get").
        assert_eq!(go(json!({ "0": "fleet", "1": "get" })).0, "fleet get");
        // Empty → runs the CLI bare (its help/overview).
        assert_eq!(go(json!({})), (String::new(), None));
    }

    #[test]
    fn bsc_cli_tool_is_named_after_the_cli_and_takes_args_plus_stdin() {
        // qwen calls `bsc-plan` as a tool; we register it by that exact name so the call resolves
        // instead of bouncing as "unknown tool". args + stdin let it run any subcommand (incl. writes).
        let t = bsc_cli_tool("bsc-plan");
        assert_eq!(t.def.name, "bsc-plan");
        assert!(t.def.description.contains("bsc-plan"));
        assert!(t.def.description.contains("help"), "points the model at the CLI's own help");
        let props = &t.def.schema["properties"];
        assert!(props.get("args").is_some(), "exposes an args string");
        assert!(props.get("stdin").is_some(), "exposes an optional stdin");
    }

    #[test]
    fn file_structure_tools_are_named_and_run() {
        let lf = list_files_tool();
        assert_eq!(lf.def.name, "list_files");
        let fi = file_info_tool();
        assert_eq!(fi.def.name, "file_info");
        // list_files runs against the cwd (the crate dir under test) and returns a tree + summary.
        let out = (lf.run)(&serde_json::json!({ "path": ".", "depth": 1 })).unwrap();
        assert!(out.contains("files,"), "summary line present: {out}");
        // file_info on a missing path is a clean Err fed back to the model, not a panic.
        assert!((fi.run)(&serde_json::json!({ "path": "definitely-not-a-real-file-xyz" })).is_err());
    }

    #[test]
    fn agent_instructions_point_at_the_real_tools_and_forbid_the_refusal() {
        let i = AGENT_INSTRUCTIONS;
        // The intent-named file tools the model should call (not a prose-only CLI hint).
        assert!(i.contains("list_files"), "must name the list_files tool");
        assert!(i.contains("file_info"), "must name the file_info tool");
        assert!(i.contains("bash"), "must name the bash tool for shell commands");
        // The exact failure mode we're fixing: the model calling a command 'unsupported'.
        assert!(i.contains("unsupported") || i.contains("not in my toolset"),
            "must explicitly forbid the 'command is unsupported' refusal");
    }

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
        let out = run_agent(&mock, "", "m", "", "read the file", &tools, &Permissions::default(), &Telemetry::disabled(), &[], None, 5, false)
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
        let err = run_agent(&Loopy, "", "m", "", "go", &tools, &Permissions::default(), &Telemetry::disabled(), &[], None, 3, false)
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
        let out = run_agent(&mock, "", "m", "", "clean up", &tools, &perms, &Telemetry::disabled(), &[], None, 5, false)
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
        let out = run_agent(&FinalMock, "", "claude-x", "", "hi", &[], &Permissions::default(), &tele, &[], None, 5, false)
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
        run_agent(&OneShot, "", "m", "", "first", &[], &Permissions::default(), &Telemetry::disabled(), &[], Some(&session), 5, false)
            .await
            .unwrap();
        let prior = load_conversation(&session);
        assert_eq!(prior.len(), 2, "fresh run persists user + assistant");
        assert!(matches!(&prior[0], Msg::User(s) if s == "first"));

        // Resume: seeded with `prior`, the second exchange appends to the same file.
        run_agent(&OneShot, "", "m", "", "second", &[], &Permissions::default(), &Telemetry::disabled(), &prior, Some(&session), 5, false)
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
    fn resolve_bash_prefers_app_provided_path() {
        // The app hands the runtime the exact Git Bash via $BSC_AGENT_BASH; it wins over everything
        // (so the `bash` tool never falls through to the Windows WSL launcher). Unique value so the
        // assertion is unambiguous even though env is process-global.
        std::env::set_var("BSC_AGENT_BASH", "/opt/from-app/bash");
        assert_eq!(resolve_bash(), "/opt/from-app/bash");
        // Trimmed + empty is treated as unset (falls through, not returned blank).
        std::env::set_var("BSC_AGENT_BASH", "   ");
        assert_ne!(resolve_bash(), "");
        std::env::remove_var("BSC_AGENT_BASH");
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

    /// A `Sync` scripted provider for the `task` tests (the real `Arc<P>` capture in
    /// `task_tool` needs `P: Send + Sync`, which `MockProvider`'s `Cell` is not). Each
    /// `turn` is driven purely by an atomic call counter: turn 1 optionally emits one
    /// tool call, every later turn returns final text.
    struct ScriptedProvider {
        calls: AtomicUsize,
        first_call: Option<ToolCall>,
        final_text: String,
    }
    impl ScriptedProvider {
        fn finishing(text: &str) -> Self {
            ScriptedProvider { calls: AtomicUsize::new(0), first_call: None, final_text: text.into() }
        }
        fn calling(tc: ToolCall, then: &str) -> Self {
            ScriptedProvider { calls: AtomicUsize::new(0), first_call: Some(tc), final_text: then.into() }
        }
    }
    impl LlmProvider for ScriptedProvider {
        async fn complete(&self, _r: &LlmRequest, _k: &str) -> Result<serde_json::Value, String> {
            unreachable!()
        }
        async fn turn(&self, _t: &Turn, _k: &str) -> Result<TurnResult, String> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            let tool_calls = match (n, &self.first_call) {
                (0, Some(tc)) => vec![tc.clone()],
                _ => vec![],
            };
            let text = if tool_calls.is_empty() { self.final_text.clone() } else { String::new() };
            Ok(TurnResult { text, tool_calls, usage: serde_json::Value::Null, stop_reason: "x".into() })
        }
    }

    #[test]
    fn task_refuses_at_max_depth_without_spawning() {
        // A tool built at the depth limit must reject immediately (no thread / no provider call).
        let provider = Arc::new(ScriptedProvider::finishing("unused"));
        let tool = task_tool(provider, String::new(), "m".into(), String::new(), Permissions::default(), MAX_TASK_DEPTH);
        let err = (tool.run)(&serde_json::json!({ "prompt": "do it" })).unwrap_err();
        assert!(err.contains("max sub-agent depth"), "got: {err}");
    }

    #[test]
    fn task_delegates_and_returns_child_final_text() {
        // The child finishes on its first turn; the tool returns that text verbatim.
        let provider = Arc::new(ScriptedProvider::finishing("sub-agent answer"));
        let tool = task_tool(provider, String::new(), "m".into(), String::new(), Permissions::default(), 0);
        let out = (tool.run)(&serde_json::json!({ "prompt": "summarize" })).unwrap();
        assert_eq!(out, "sub-agent answer");
    }

    #[test]
    fn sub_agent_inherits_parent_permission_denies() {
        // The child is given the parent's perms (bash denied). It scripts a `bash` that would
        // create a sentinel file; the inherited deny must block execution, so the file never
        // appears even though the child loop runs to completion.
        let sentinel = std::env::temp_dir().join(format!("bsc_task_perm_{}.flag", std::process::id()));
        let _ = std::fs::remove_file(&sentinel);
        let bash = ToolCall {
            id: "t1".into(),
            name: "bash".into(),
            args: serde_json::json!({ "command": format!("touch {}", sentinel.display()) }),
        };
        let provider = Arc::new(ScriptedProvider::calling(bash, "done"));
        let perms = Permissions { deny_tools: vec!["bash".into()], ..Default::default() };
        let tool = task_tool(provider, String::new(), "m".into(), String::new(), perms, 0);
        let out = (tool.run)(&serde_json::json!({ "prompt": "run it" })).unwrap();
        assert_eq!(out, "done");
        assert!(!sentinel.exists(), "denied bash must not have executed in the sub-agent");
        let _ = std::fs::remove_file(&sentinel);
    }
}
