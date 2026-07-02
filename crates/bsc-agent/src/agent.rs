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

/// The always-injected agent preamble (teaches a local model to run CLIs through `bash`, to use the
/// intent-named file tools, and to never refuse a command as "unsupported"). Prepended to the caller's
/// system prompt by [`run_agent`]. (#1078 P3)
const AGENT_INSTRUCTIONS: &str = include_str!("../data/agent-instructions.md");

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
            // Stream assistant text to the PTY token-by-token as it's generated (#1832), instead of
            // dumping the whole answer after the turn settles.
            let mut streamed_any = false;
            let mut result = turn_streaming_with_retry(
                provider,
                &turn,
                api_key,
                Duration::from_millis(500),
                &mut |chunk| {
                    use std::io::Write;
                    print!("{chunk}");
                    let _ = std::io::stdout().flush();
                    streamed_any = true;
                },
            )
            .await?;
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
            // The text was streamed live above (#1832); just terminate the line. (Nothing to print for
            // a pure tool-call turn that produced no text.)
            if streamed_any {
                println!();
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

/// Run one provider turn — streaming assistant text to `on_chunk` as it generates (#1832) — and retry
/// *transient* failures with exponential backoff so a network blip or rate-limit doesn't abort the
/// agent run. Permanent errors (auth, bad request) return immediately; a transient failure is NOT
/// retried once text has streamed (re-streaming would double what the PTY already showed). `base_backoff`
/// is the first delay (doubled each retry); tests pass `Duration::ZERO`. (#1078 P4 / #1832)
async fn turn_streaming_with_retry<P: LlmProvider>(
    provider: &P,
    turn: &Turn,
    api_key: &str,
    base_backoff: Duration,
    on_chunk: &mut dyn FnMut(&str),
) -> Result<TurnResult, String> {
    let mut attempt = 0;
    loop {
        // Whether THIS attempt streamed any text — gates retry (see the doc above).
        let emitted = std::cell::Cell::new(false);
        let result = {
            let mut guarded = |c: &str| {
                emitted.set(true);
                on_chunk(c);
            };
            provider.turn_streaming(turn, api_key, &mut guarded).await
        };
        match result {
            Ok(r) => return Ok(r),
            Err(e) if attempt < MAX_TURN_RETRIES && is_transient_error(&e) && !emitted.get() => {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{
        bash_tool, edit_file_tool, file_info_tool, list_files_tool, read_file_tool, write_file_tool,
        NATIVE_TOOL_BUILDERS,
    };
    use llm::{LlmRequest, ToolCall};
    use std::cell::Cell;
    use std::sync::atomic::{AtomicUsize, Ordering};

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
        let r = turn_streaming_with_retry(&p, &empty_turn(), "", Duration::ZERO, &mut |_| {}).await.unwrap();
        assert_eq!(r.text, "ok");
        assert_eq!(p.calls.load(Ordering::SeqCst), 3, "two transient failures then success");
    }

    #[tokio::test]
    async fn turn_with_retry_fails_fast_on_permanent_error() {
        let p = FlakyProvider { calls: AtomicUsize::new(0), fail_times: 9, err: "API error (401): bad key".into() };
        let err = turn_streaming_with_retry(&p, &empty_turn(), "", Duration::ZERO, &mut |_| {}).await.unwrap_err();
        assert!(err.contains("401"));
        assert_eq!(p.calls.load(Ordering::SeqCst), 1, "permanent error is not retried");
    }

    #[tokio::test]
    async fn turn_with_retry_gives_up_after_max_transient() {
        let p = FlakyProvider { calls: AtomicUsize::new(0), fail_times: 99, err: "Request failed: timed out".into() };
        let err = turn_streaming_with_retry(&p, &empty_turn(), "", Duration::ZERO, &mut |_| {}).await.unwrap_err();
        assert!(err.contains("timed out"));
        // 1 initial attempt + MAX_TURN_RETRIES retries.
        assert_eq!(p.calls.load(Ordering::SeqCst), MAX_TURN_RETRIES + 1);
    }
}
