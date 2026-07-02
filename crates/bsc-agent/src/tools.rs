//! The native tool builders every `bsc-agent` session is launched with — the file / shell / search /
//! web / delegation verbs (Claude Code tool-set parity, epic #1078). Each builder returns a [`Tool`]
//! (declaration + synchronous executor); the agent loop in [`crate::agent`] drives them. Split out of
//! `agent.rs` so the loop / compaction and the tool implementations live in separate modules.

use crate::agent::{run_agent, run_off_runtime, Tool};
use crate::permissions::Permissions;
use crate::telemetry::Telemetry;
use llm::{LlmProvider, ToolDef};
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Combine a finished process's stdout + stderr into one string, appending an `[exit N]` line on a
/// non-zero exit (a signal death renders as `[exit signal]`). Shared by the `bash` tool and the
/// `bsc-*` CLIs: a non-zero exit is NOT an error — the output is returned so the model can read it.
fn combine_output(output: &std::process::Output) -> String {
    let mut out = String::new();
    out.push_str(&String::from_utf8_lossy(&output.stdout));
    out.push_str(&String::from_utf8_lossy(&output.stderr));
    if !output.status.success() {
        let code = output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
        out.push_str(&format!("\n[exit {code}]"));
    }
    out
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
            Ok(combine_output(&output))
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
    Ok(combine_output(&output))
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

/// A FIRST-CLASS tool for one `bsc <sub>` project CLI subcommand (#qwen / #1877). Local models (qwen
/// especially) call a CLI like `bsc-plan` as a *tool*, not via the `bash` tool — and then bounce off
/// "unknown tool" and give up. So we hand them the tool by a recognizable name `bsc-<sub>` (e.g.
/// `bsc-plan`): `args` is the CLI argument string (`"summary"`, `"list --status open"`), `stdin`
/// optionally pipes input (JSON for a write like `add`). It runs `bsc <sub> <args>` through bash (the
/// `bsc` shell helper execs the staged $BSC_BIN). Same intent-named-tool fix as `list_files`. Only
/// registered when the unified `bsc` binary is staged this session ($BSC_BIN set).
pub fn bsc_cli_tool(sub: &'static str) -> Tool {
    Tool {
        def: ToolDef {
            name: format!("bsc-{sub}"),
            description: format!(
                "Run the `bsc {sub}` project CLI. Put the CLI arguments in `args` (e.g. \"summary\" or \
                 \"list --limit 5\"); use `args: \"help\"` to see its commands, then `args: \"<command> help\"` \
                 for one command's args. Pipe input (e.g. JSON for a write) via `stdin`. Equivalent to \
                 running `bsc {sub} <args>` in the shell."
            ),
            schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "args": { "type": "string", "description": "the CLI arguments, e.g. \"summary\" or \"list --limit 5\" (empty runs the subcommand with no args — its help/overview)" },
                    "stdin": { "type": "string", "description": "optional text piped to the command's stdin (e.g. JSON for a write command)" }
                }
            }),
        },
        run: Box::new(move |args| {
            // Tolerant of however the model shaped the call, so it runs like the normal command it is.
            let (a, stdin) = extract_cli_args(args);
            // Run via the unified binary: `bsc <sub> <args>` (the `bsc` shell helper execs $BSC_BIN).
            let full = if a.is_empty() { sub.to_string() } else { format!("{sub} {a}") };
            run_bsc_cli("bsc", &full, stdin.as_deref())
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

static TASK_CHILDREN_SPAWNED: AtomicUsize = AtomicUsize::new(0);

/// The native tool builders every `bsc-agent` session is launched with — the file/shell/search/web
/// verbs as one registry (#1846), so adding a verb is one line here. `list_files`/`file_info` are
/// FIRST-CLASS, INTENT-NAMED tools (backed by the `bsc-files` LIBRARY in-process — no subprocess, no
/// binary-path fragility) because a local model reaches for "list/show the files" and kept inventing
/// `*_list` names when nothing matched — clearly-named tools it calls as reliably as MCP tools (the
/// prose-only hint didn't work, and a single args-string tool got fumbled).
pub(crate) const NATIVE_TOOL_BUILDERS: &[fn() -> Tool] = &[
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
pub(crate) fn list_files_tool() -> Tool {
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
pub(crate) fn file_info_tool() -> Tool {
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
    use llm::{LlmProvider, LlmRequest, ToolCall, Turn, TurnResult};
    use std::sync::atomic::{AtomicUsize, Ordering};

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
        // qwen calls `bsc-plan` as a tool; we register the `plan` subcommand by the recognizable name
        // `bsc-plan` so the call resolves instead of bouncing as "unknown tool". args + stdin let it
        // run any subcommand (incl. writes); under the hood it execs `bsc plan <args>` (#1877).
        let t = bsc_cli_tool("plan");
        assert_eq!(t.def.name, "bsc-plan");
        assert!(t.def.description.contains("bsc plan"));
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
    /// `task_tool` needs `P: Send + Sync`). Each `turn` is driven purely by an atomic call
    /// counter: turn 1 optionally emits one tool call, every later turn returns final text.
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
