use std::collections::HashMap;
use tauri::{Manager, RunEvent};

mod tunnel;
mod perf;
mod docstore;
mod tokens;
mod githooks;
mod oauth;
mod config;
mod github;
mod shell;
mod pty;
mod bsc;
mod planner;

// ── Logging / performance ────────────────────────────────────────────────────

/// ANSI color for a log level, used by the custom log format. Pure.
fn level_color(level: log::Level) -> &'static str {
    match level {
        log::Level::Error => "\x1b[31m", // red
        log::Level::Warn  => "\x1b[33m", // yellow
        log::Level::Info  => "\x1b[32m", // green
        log::Level::Debug => "\x1b[36m", // cyan
        log::Level::Trace => "\x1b[90m", // bright black
    }
}

/// RAII timer: logs how long a scope took when it drops, but only if the elapsed
/// time crosses `threshold_ms` — so it surfaces slow operations without noise.
/// Lives across `.await` points, so wrapping an async command times the whole call.
pub(crate) struct PerfSpan {
    label: &'static str,
    start: std::time::Instant,
    threshold_ms: u128,
}

impl PerfSpan {
    fn new(label: &'static str) -> Self {
        Self { label, start: std::time::Instant::now(), threshold_ms: 50 }
    }
}

impl Drop for PerfSpan {
    fn drop(&mut self) {
        let ms = self.start.elapsed().as_millis();
        if ms >= self.threshold_ms {
            log::info!("perf · {} took {}ms", self.label, ms);
        }
    }
}

// ── PTY commands ─────────────────────────────────────────────────────────────

/// Splits `bytes` at the last complete UTF-8 character boundary.
/// Returns `(valid_string, leftover_bytes)` where `leftover_bytes` is any
/// trailing incomplete multi-byte sequence to prepend to the next read.
pub(crate) fn split_utf8_at_boundary(bytes: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            if e.error_len().is_none() {
                // Incomplete sequence at end of buffer — hold the trailing
                // bytes for the next read rather than replacing with U+FFFD.
                let text = unsafe { std::str::from_utf8_unchecked(&bytes[..valid_up_to]) }.to_string();
                (text, bytes[valid_up_to..].to_vec())
            } else {
                // Genuinely invalid bytes mid-stream — keep going with lossy.
                (String::from_utf8_lossy(bytes).into_owned(), Vec::new())
            }
        }
    }
}

/// Converts a native OS path to a bash-compatible POSIX path.
/// On Windows (Git Bash): `C:\Users\foo` → `/c/Users/foo`.
/// On Unix: returns the path unchanged.
pub(crate) fn to_bash_path(p: &str) -> String {
    #[cfg(windows)]
    {
        let s = p.replace('\\', "/");
        if s.len() >= 2 && s.as_bytes()[1] == b':' {
            let drive = s[..1].to_lowercase();
            return format!("/{}{}", drive, &s[2..]);
        }
        s
    }
    #[cfg(not(windows))]
    p.to_string()
}

/// The nearest existing ancestor directory of `path` (native form), or "" if none
/// exists. Used by `pty_create` to avoid the silent $HOME fallback when a session's
/// configured cwd is missing — we land in the closest real directory instead (#367).
pub(crate) fn nearest_existing_ancestor(path: &str) -> String {
    let mut p = std::path::Path::new(path);
    loop {
        if p.as_os_str().is_empty() { return String::new(); }
        if p.is_dir() { return p.to_string_lossy().into_owned(); }
        match p.parent() {
            Some(parent) => p = parent,
            None => return String::new(),
        }
    }
}

/// Root of the flat, reusable document library: `~/.base-studio-code/documents`.
/// Holds standalone markdown blocks (`*.md`) plus the library's own `CLAUDE.md`
/// and `.claude/settings.json`. These are reusable across every project — they
/// are referenced from a project's `kb_index.md` via a relative path.
pub(crate) fn documents_dir() -> std::path::PathBuf {
    bsc_base_dir().join("documents")
}

/// The project hub directory and the planner session's CWD:
/// `~/.base-studio-code/projects/<sanitized-project-key>`. Holds the project's
/// `CLAUDE.md` (ancestor-loaded context for repo sessions), plan sections
/// (`goal.md`…`risks.md`), control files, `prompts/`, and the cloned repos as
/// subdirectories.
pub(crate) fn project_dir(project_key: &str) -> std::path::PathBuf {
    bsc_base_dir()
        .join("projects")
        .join(sanitize_project_key(project_key))
}

/// The on-disk clone location of a repo within its project hub:
/// `projects/<sanitized-project-key>/<short-repo-name>`, where the short name is
/// the part of `owner/name` after the `/`. Each repo clone is a repo session's CWD.
pub(crate) fn repo_dir(project_key: &str, repo_full_name: &str) -> std::path::PathBuf {
    let short = repo_full_name.rsplit('/').next().unwrap_or(repo_full_name);
    project_dir(project_key).join(short)
}

/// Absolute on-disk location of a project's plan section files, which live FLAT
/// in the project hub: `~/.base-studio-code/projects/<sanitized-project-key>`.
/// Plan sections sit alongside the control files (CLAUDE.md, kb_index.md, …) in
/// the planner's CWD.
fn plan_dir_for(project_key: &str) -> std::path::PathBuf {
    project_dir(project_key)
}

/// Delete a project's on-disk hub (`projects/<sanitized-key>`) and everything in
/// it — plan sections, prompts, cloned repos. Best-effort: a missing dir is fine.
/// Refuses an empty key so it can never wipe the `projects/` root.
#[tauri::command]
fn delete_project_dir(project_key: String) -> Result<(), String> {
    if sanitize_project_key(&project_key).is_empty() {
        return Err("delete_project_dir: empty project_key".to_string());
    }
    let dir = project_dir(&project_key);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("delete_project_dir: {e}"))?;
        log::info!("deleted project hub {:?}", dir);
    }
    Ok(())
}

/// Clear every project's plan files for a from-scratch dev reset, WITHOUT touching
/// the cloned repos. Deletes only the top-level `.md` / `.json` plan files in each
/// `projects/<key>/` dir (goal.md, issues.json, phases.json, fleet.json, the
/// context docs, …) and leaves all SUBDIRECTORIES — the cloned repos, their
/// `.worktrees`, and `prompts/` — intact. Best-effort; returns how many files were
/// removed. Without this, the planning poll re-reads the files and a store-only
/// clear is undone within a tick.
#[tauri::command]
fn clear_all_plan_files() -> Result<u32, String> {
    let projects = bsc_base_dir().join("projects");
    if !projects.exists() {
        return Ok(0);
    }
    let mut removed = 0u32;
    let entries = std::fs::read_dir(&projects).map_err(|e| format!("clear_all_plan_files: {e}"))?;
    for entry in entries.flatten() {
        let proj = entry.path();
        if !proj.is_dir() {
            continue;
        }
        let items = match std::fs::read_dir(&proj) {
            Ok(i) => i,
            Err(_) => continue,
        };
        for item in items.flatten() {
            let p = item.path();
            // Preserve every subdirectory (cloned repos, .worktrees, prompts, .claude).
            if !p.is_file() {
                continue;
            }
            let is_plan = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("json"))
                .unwrap_or(false);
            if is_plan && std::fs::remove_file(&p).is_ok() {
                removed += 1;
            }
        }
    }
    log::info!("clear_all_plan_files: removed {removed} plan files");
    Ok(removed)
}

/// Delete every plan section file (`.md` / `.json`) in a single project's hub
/// directory, leaving subdirectories (cloned repos, `.worktrees`, `prompts/`,
/// `.claude/`) intact. The section poll re-reads from disk, so this must run
/// before the store is cleared — otherwise the next poll repopulates the store.
/// Returns how many files were deleted. Best-effort: any unreadable file is skipped.
#[tauri::command]
fn clear_project_plan_files(project_key: String) -> Result<u32, String> {
    if sanitize_project_key(&project_key).is_empty() {
        return Err("clear_project_plan_files: empty project_key".to_string());
    }
    let proj = plan_dir_for(&project_key);
    if !proj.exists() {
        return Ok(0);
    }
    let entries = std::fs::read_dir(&proj).map_err(|e| format!("clear_project_plan_files: {e}"))?;
    let mut removed = 0u32;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() { continue; }
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if (ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("json"))
            && std::fs::remove_file(&p).is_ok()
        {
            removed += 1;
        }
    }
    // Drop generated UI artifacts too (#650): the .ui-skeleton/ dir feeds the render-preview
    // pipeline, so leaving it would re-show the old UI after a clear.
    let skeleton = proj.join(".ui-skeleton");
    if skeleton.is_dir() && std::fs::remove_dir_all(&skeleton).is_ok() {
        removed += 1;
    }
    log::info!("clear_project_plan_files({project_key}): removed {removed} files");
    Ok(removed)
}

/// Reject a relative path that would escape the project hub: absolute paths, a Windows
/// drive prefix, a root component, or any `..` segment. Shared by the pipeline file
/// primitives so a pipeline can never write/read outside its own project dir.
fn is_safe_relpath(rel: &std::path::Path) -> bool {
    !rel.is_absolute()
        && !rel.components().any(|c| matches!(
            c,
            std::path::Component::ParentDir
                | std::path::Component::Prefix(_)
                | std::path::Component::RootDir
        ))
}

/// Write one file into a project's hub — the shared persistence primitive pipelines call
/// (#…). Pipelines own *what*/*where*/*when* they save; this just performs the path-safe
/// write under `projects/<key>/`. `relpath` is resolved under the project dir; any attempt
/// to escape it (absolute, drive prefix, or `..`) is rejected.
#[tauri::command]
fn write_project_file(project_key: String, relpath: String, contents: String) -> Result<(), String> {
    if sanitize_project_key(&project_key).is_empty() {
        return Err("write_project_file: empty project_key".to_string());
    }
    if relpath.trim().is_empty() {
        return Err("write_project_file: empty relpath".to_string());
    }
    let rel = std::path::Path::new(&relpath);
    if !is_safe_relpath(rel) {
        return Err(format!("write_project_file: unsafe relpath '{relpath}'"));
    }
    let target = project_dir(&project_key).join(rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("write_project_file: {e}"))?;
    }
    std::fs::write(&target, contents).map_err(|e| format!("write_project_file: {e}"))?;
    log::info!("write_project_file({project_key}): wrote {relpath}");
    Ok(())
}

/// Write a BINARY file into a project's hub from base64 (#604) — the file-intake pipeline
/// stages dropped files (images, fonts, any binary) this way, since `write_project_file`
/// only handles text. Same path-safety rules. `b64` is standard base64 of the file bytes.
#[tauri::command]
fn write_project_file_bytes(project_key: String, relpath: String, b64: String) -> Result<(), String> {
    use base64::Engine;
    if sanitize_project_key(&project_key).is_empty() {
        return Err("write_project_file_bytes: empty project_key".to_string());
    }
    if relpath.trim().is_empty() {
        return Err("write_project_file_bytes: empty relpath".to_string());
    }
    let rel = std::path::Path::new(&relpath);
    if !is_safe_relpath(rel) {
        return Err(format!("write_project_file_bytes: unsafe relpath '{relpath}'"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("write_project_file_bytes: bad base64: {e}"))?;
    let target = project_dir(&project_key).join(rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("write_project_file_bytes: {e}"))?;
    }
    std::fs::write(&target, &bytes).map_err(|e| format!("write_project_file_bytes: {e}"))?;
    log::info!("write_project_file_bytes({project_key}): wrote {relpath} ({} bytes)", bytes.len());
    Ok(())
}

/// Result of running a dead-code scanner (#626). `ran` distinguishes "the tool ran"
/// (parse `stdout`) from "couldn't run it" (`error` set — not installed, bad dir, …).
#[derive(serde::Serialize)]
struct ScanResult {
    tool: String,
    ran: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    error: Option<String>,
}

/// Allowlisted dead-code / unused-dependency scanners → (program, args). Only these may
/// run — the `tool` arg never becomes an arbitrary command. (#626)
fn dead_code_cmd(tool: &str) -> Option<(&'static str, &'static [&'static str])> {
    match tool {
        "depcheck" => Some(("npx", &["--yes", "depcheck", "--json"])),
        "ts-prune" => Some(("npx", &["--yes", "ts-prune"])),
        "cargo-machete" => Some(("cargo", &["machete"])),
        _ => None,
    }
}

/// Run an allowlisted dead-code scanner in `repo_path` and return its raw output for the
/// frontend to parse. Never panics; a missing tool / bad dir comes back as `error`.
#[tauri::command]
fn scan_dead_code(repo_path: String, tool: String) -> ScanResult {
    let err = |e: String| ScanResult { tool: tool.clone(), ran: false, exit_code: None, stdout: String::new(), stderr: String::new(), error: Some(e) };
    let dir = std::path::Path::new(&repo_path);
    if !dir.is_dir() {
        return err(format!("not a directory: {repo_path}"));
    }
    let Some((prog, args)) = dead_code_cmd(&tool) else {
        return err(format!("unknown scanner '{tool}'"));
    };
    match std::process::Command::new(prog).args(args).current_dir(dir).output() {
        Ok(out) => ScanResult {
            tool,
            ran: true,
            exit_code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            error: None,
        },
        Err(e) => err(format!("couldn't run {prog}: {e}")),
    }
}

/// Recursively read every (text) file under `root` as `(relpath → contents)`, capped at
/// 512 KiB each, skipping unreadable/binary files. relpaths are forward-slashed and
/// relative to `root`. The generic complement to `read_skeleton_dir` (which filters by
/// extension) — pipelines persist arbitrary file types (`.vue`, `.svg`, `.html`, …).
fn read_files_dir(root: &std::path::Path) -> Vec<(String, String)> {
    fn walk(base: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                let small = std::fs::metadata(&p).map(|m| m.len() <= 512 * 1024).unwrap_or(false);
                if small {
                    if let (Ok(rel), Ok(content)) = (p.strip_prefix(base), std::fs::read_to_string(&p)) {
                        out.push((rel.to_string_lossy().replace('\\', "/"), content));
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Read every file under a project-hub subdir (relpath → contents) so a pipeline can
/// rehydrate its saved results (#…). Empty when the subdir is missing or `subdir` would
/// escape the project dir.
#[tauri::command]
fn read_project_files(project_key: String, subdir: String) -> Vec<(String, String)> {
    let rel = std::path::Path::new(&subdir);
    if !is_safe_relpath(rel) {
        return Vec::new();
    }
    read_files_dir(&project_dir(&project_key).join(rel))
}

/// Quote an arbitrary string as a single bash ANSI-C token (`$'...'`).
///
/// Used to bake a startup prompt into `claude <token>` safely: ANSI-C quoting
/// keeps the whole value on one physical line (newlines become `\n`) and `$`,
/// backticks, and double quotes are literal — so no shell expansion, no PS2
/// continuation, and any prompt content survives intact.
fn bash_ansi_c_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    out.push_str("$'");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// Build the shell command that launches `claude` with the baked startup prompt.
/// Triage sessions pass `continue_session = true` to resume the repo's most recent
/// conversation (`--continue`) instead of starting a fresh one.
pub(crate) fn claude_launch(prompt: &str, continue_session: bool) -> String {
    let flag = if continue_session { "--continue " } else { "" };
    format!("claude {}{}", flag, bash_ansi_c_quote(prompt))
}

/// Map a UI model id (`sonnet-4.5`, `opus-4.5`, `haiku-4.5`) to the alias Claude
/// Code's `--model` flag accepts. Returns `None` for anything unrecognized, so the
/// session falls back to Claude Code's own default and we never interpolate an
/// arbitrary caller string into the shell command (the match only ever yields a
/// fixed literal — no injection surface).
pub(crate) fn claude_model_flag(model: &str) -> Option<&'static str> {
    match model {
        "haiku-4.5" => Some("haiku"),
        "sonnet-4.5" => Some("sonnet"),
        "opus-4.5" => Some("opus"),
        _ => None,
    }
}

/// Claude Code's on-disk directory name for a launch cwd. Conversations live at
/// `~/.claude/projects/<dir>/<session>.jsonl`, where `<dir>` is the cwd with every
/// non-alphanumeric character replaced by `-`
/// (e.g. `C:\Users\Kevin\foo` → `C--Users-Kevin-foo`).
fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Whether Claude has a prior conversation for `cwd`. `--continue` aborts with
/// "No conversation found to continue" (and never delivers the baked startup
/// prompt) when there's no history, so we only pass the flag when this is true.
/// Fail-safe: any uncertainty (empty cwd, unreadable dir) returns `false`, which
/// launches a fresh session so the prompt is always delivered.
pub(crate) fn has_claude_history(cwd: &str) -> bool {
    if cwd.is_empty() {
        return false;
    }
    let dir = home_dir()
        .join(".claude")
        .join("projects")
        .join(claude_project_dir_name(cwd));
    let Ok(entries) = std::fs::read_dir(&dir) else { return false };
    entries
        .flatten()
        .any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl"))
}

// ── File picker ───────────────────────────────────────────────────────────────

#[tauri::command]
async fn pick_directory() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned())
}

// ── Claude API (knowledge store) ─────────────────────────────────────────────

#[tauri::command]
async fn kb_chat(
    messages: Vec<serde_json::Value>,
    system: String,
    tools: Vec<serde_json::Value>,
    api_key: String,
) -> Result<serde_json::Value, String> {
    if api_key.is_empty() {
        return Err("No API key configured. Add it in Settings → Integrations.".to_string());
    }
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": "claude-sonnet-4-6",
        "max_tokens": 4096,
        "system": system,
        "messages": messages,
        "tools": tools,
    });
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    if !status.is_success() {
        let err = json["error"]["message"]
            .as_str()
            .unwrap_or("Unknown error")
            .to_string();
        return Err(format!("API error ({}): {}", status, err));
    }
    Ok(json)
}

// ── Workspaces ───────────────────────────────────────────────────────────────
//
// Two roots under ~/.base-studio-code/:
//   documents/        — flat reusable markdown library; claude can Read/Write .md
//   projects/<key>/   — project hub + planner session CWD; references reusable
//                       blocks at ../../documents/{id}.md
//
// Each gets a .claude/settings.json (tool restrictions) and a CLAUDE.md
// (auto-loaded system prompt) written on every session start so the instructions
// stay in sync with the app without manual editing.

pub(crate) fn home_dir() -> std::path::PathBuf {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE")
            .unwrap_or_else(|_| std::env::var("HOME").unwrap_or_default())
    } else {
        std::env::var("HOME").unwrap_or_default()
    };
    std::path::PathBuf::from(home)
}

pub(crate) fn bsc_base_dir() -> std::path::PathBuf {
    home_dir().join(".base-studio-code")
}

/// Read the Agents audit log (#257): the newest `limit` TSV lines, newest first.
#[tauri::command]
fn read_audit_log(limit: usize) -> Vec<String> {
    let path = bsc_base_dir().join("audit.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    lines.reverse();
    lines.truncate(limit);
    lines
}

/// Read the skill usage log (#406): the newest `limit` TSV lines, newest first.
#[tauri::command]
fn read_skill_log(limit: usize) -> Vec<String> {
    let path = bsc_base_dir().join("skills.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    lines.reverse();
    lines.truncate(limit);
    lines
}

/// Collect a UI-skeleton directory as (relpath, contents) pairs — source files only,
/// size-capped, recursive. Pure over a path so it's unit-testable (#533).
fn read_skeleton_dir(root: &std::path::Path) -> Vec<(String, String)> {
    fn ok_ext(p: &std::path::Path) -> bool {
        matches!(p.extension().and_then(|s| s.to_str()), Some("jsx" | "tsx" | "js" | "ts" | "css" | "json"))
    }
    fn walk(base: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else if ok_ext(&p) {
                let small = std::fs::metadata(&p).map(|m| m.len() <= 512 * 1024).unwrap_or(false);
                if small {
                    if let (Ok(rel), Ok(content)) = (p.strip_prefix(base), std::fs::read_to_string(&p)) {
                        out.push((rel.to_string_lossy().replace('\\', "/"), content));
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Read a project's `.ui-skeleton/` folder (relpath → contents) for the render-preview
/// pipeline (#533): the lightweight, functionless UI the planner generates. Empty when
/// the folder doesn't exist yet.
#[tauri::command]
fn read_ui_skeleton(project_key: String) -> Vec<(String, String)> {
    read_skeleton_dir(&project_dir(&project_key).join(".ui-skeleton"))
}

/// Absolute path to a project's hub directory (#647) — the frontend reveals it so the
/// user can export/back up authored plan files before resetting the blueprint.
#[tauri::command]
fn project_dir_path(project_key: String) -> String {
    project_dir(&project_key).to_string_lossy().to_string()
}

/// Read the coordination log (#199): up to the newest `limit` TSV lines, in
/// chronological (oldest-first) order so the coordinator can replay them.
#[tauri::command]
fn read_coord_log(limit: usize) -> Vec<String> {
    let path = bsc_base_dir().join("coord.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    if lines.len() > limit {
        lines = lines.split_off(lines.len() - limit);
    }
    lines
}

/// Append a `woke` event to the coordination log (#199): records that a parked
/// session was relaunched, so the coordinator won't re-wake it (idempotent across
/// polls + restarts). Same TSV shape + ISO-8601 UTC timestamp as the shell emitters.
#[tauri::command]
fn append_coord_woke(session: String) -> Result<(), String> {
    use std::io::Write;
    let path = bsc_base_dir().join("coord.log");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let fmt = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second]Z"
    );
    let ts = time::OffsetDateTime::now_utc().format(&fmt).unwrap_or_default();
    let line = format!("{ts}	{session}	woke		
");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

pub(crate) const KB_CLAUDE_MD: &str = r#"# base-studio-code · Knowledge Base

You manage a library of markdown articles. Each article is a reusable piece of
context that gets injected into AI coding sessions based on the project's tech stack.

## Your role

Help the user create, edit, and organise articles. When asked to:
- **Create** an article — write a new `.md` file with a descriptive kebab-case filename.
- **Edit** an article — read the file first, then write the updated version.
- **List** what exists — use the Glob or Read tools to inspect the directory.

## Conventions

- One file per topic: `react-testing.md`, `rust-error-handling.md`, `postgres-migrations.md`
- No subdirectories — everything lives at the top level of this directory.
- Start each file with a `# Title` heading; the rest is freeform markdown.
- Write for a developer reading in a hurry: short, concrete, actionable.
- Keep articles focused — split broad topics into smaller targeted files.

## Constraints

Only `.md` files in this directory. No shell commands, no external URLs.
"#;

// ── Knowledge base workspace ──────────────────────────────────────────────────

/// Creates the flat reusable document library at `documents/`, writing CLAUDE.md
/// and .claude/settings.json. Safe to call on every mount — overwrites config
/// files but leaves articles alone. Returns the library path.
#[tauri::command]
async fn setup_kb_workspace() -> Result<String, String> {
    config::sanitize_claude_config();
    let kb_dir     = documents_dir();
    let claude_dir = kb_dir.join(".claude");
    std::fs::create_dir_all(&claude_dir).map_err(|e| e.to_string())?;
    std::fs::write(
        claude_dir.join("settings.json"),
        r#"{"permissions":{"allow":["Read","Write","Edit"],"deny":["Bash","WebFetch","WebSearch","MultiEdit"]}}"#,
    ).map_err(|e| e.to_string())?;
    std::fs::write(kb_dir.join("CLAUDE.md"), KB_CLAUDE_MD)
        .map_err(|e| e.to_string())?;
    Ok(kb_dir.to_string_lossy().into_owned())
}

/// Turns an arbitrary project key into a filesystem-safe directory name.
/// Canonicalize a project key into a filesystem-safe slug.
///
/// Must stay byte-for-byte identical to the frontend's paneId sanitization in
/// Planning.tsx (`replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 80)`) so the PTY id and
/// the planning directory always correspond. ASCII-only on purpose — Rust's
/// `char::is_alphanumeric` accepts Unicode letters, which the JS regex does not.
pub(crate) fn sanitize_project_key(key: &str) -> String {
    let s: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    // Truncate so paths stay manageable.
    s.chars().take(80).collect()
}

// ── Repository resolution ─────────────────────────────────────────────────────
//
// Repos live inside their project hub at `projects/<project>/<short-repo-name>`.
// clone_repo: clones there via HTTPS; idempotent if the dir already exists.

/// Suppress the console window Windows pops for each child process (#432).
///
/// A GUI-subsystem Tauri build has no console, so every `std::process::Command`
/// it spawns (git, the readiness-probe shell, …) would otherwise flash — or, on
/// Windows 10, *persist* — its own `cmd`/`conhost` window with no way to close it.
/// The `CREATE_NO_WINDOW` (0x0800_0000) creation flag spawns the child detached
/// from any console. No-op on non-Windows. Call it on the `Command` right before
/// `.status()`/`.output()`/`.spawn()`. (The PTY path is unaffected — it goes
/// through portable_pty's headless ConPTY, not `std::process`.)
fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Clones `full_name` (an `owner/name` GitHub slug) into the project hub at
/// `projects/<sanitize(project)>/<short-repo-name>` and returns the clone path.
/// Idempotent: if the destination is already a git clone it is returned as-is.
/// After cloning, `CLAUDE.local.md` is appended to the clone's
/// `.git/info/exclude` so the planner-generated per-repo context file stays out
/// of `git status`.
#[tauri::command]
async fn clone_repo(project: String, full_name: String) -> Result<String, String> {
    let _perf = PerfSpan::new("clone_repo");
    let dest = repo_dir(&project, &full_name);
    if dest.is_dir() && dest.join(".git").exists() {
        return Ok(dest.to_string_lossy().into_owned());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let url = format!("https://github.com/{}.git", full_name);
    let mut cmd = std::process::Command::new("git");
    cmd.args(["clone", &url, &dest.to_string_lossy()]);
    let status = no_window(&mut cmd).status().map_err(|e| e.to_string())?;
    if !status.success() {
        log::warn!("clone_repo: git clone failed for {full_name}");
        return Err(format!("git clone failed for {}", full_name));
    }
    // Keep app-managed files (per-repo CLAUDE.local.md, the .claude/ session
    // settings) out of the clone's `git status`.
    git_exclude(&dest, "CLAUDE.local.md");
    git_exclude(&dest, ".claude/");
    // The fleet assume-and-log journal (bsc-note / bsc-blocked) lives in the repo
    // root; keep it out of the clone's `git status`.
    git_exclude(&dest, "DECISIONS.md");
    log::info!("clone_repo: cloned {full_name} → {}", dest.display());
    Ok(dest.to_string_lossy().into_owned())
}

/// Branch/dir slug for a fleet agent — keeps only `[A-Za-z0-9._-]`, every other
/// char becomes `-`. Must match the frontend `worktreeSlug` so the computed
/// worktree cwd and the on-disk worktree path agree.
fn worktree_slug(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '-' })
        .collect()
}

/// Coordination protocol appended to every fleet worker's CLAUDE.local.md (#369) so the
/// defer-to-director / never-ask-the-user rules are authoritative context, not just a
/// first-message hint. A multi-line raw string (real newlines; literal backticks/quotes).
const FLEET_PROTOCOL_MD: &str = r#"
## Fleet coordination protocol (auto-added — do not edit)

You are one of several parallel sessions building this project. Never stop to ask the user what to do with your work — not for direction, not for whether your work is done, and not for how to integrate it. Under the default self-merge policy you integrate your own work to develop (full gate -> rebase onto develop -> re-gate -> push) and keep going through every owned issue; you do not open PRs and the director does not merge for you. Follow your push instruction.

When you genuinely need a decision you cannot make yourself, defer to the director, not the user:

- `echo "your one-line question" | bsc-ask` — parks you and routes the question to the director, which answers and resumes you automatically.
- `bsc-blocked --on <ref>` — park until another stream's dependency lands.
- `echo "what you decided" | bsc-note` — for small reversible choices, just pick the smallest sensible option and record it; do not ask.

If your push policy is self-merge, you integrate your own work to develop (full gate -> rebase onto develop -> re-gate -> push) and do NOT open PRs; if it is auto-pr, open a PR and the director merges it. Follow the push instruction in your kickoff. When you open a PR, stop -- CI runs and is watched for you; you will be told to continue (if it passed) or to fix the build and push (if it failed). Do not poll CI, reopen, or duplicate the PR.

Only the director escalates to the user.
"#;

/// Director protocol (#375) appended to the project hub's CLAUDE.local.md so the
/// async-integrator director always has its standing duties as authoritative context
/// (it runs at the hub, so it never gets the worker worktree protocol).
const DIRECTOR_PROTOCOL_MD: &str = r#"
## Director protocol (auto-added -- do not edit)

You are the async-integrator DIRECTOR for this fleet; you write no feature code. These are
standing rules you MUST act on, not merely acknowledge:

- KNOW YOUR FLEET. Run `bsc-fleet` from the project hub (your cwd) to list every session:
  its console id (PANE), stream, repo, branch, role, and current STATE -- blocked / waiting /
  ask / active / idle, with what it's blocked on or asking. The PANE id (e.g. t0p2) is the
  `<session>` argument for bsc-answer / bsc-assign, so this is how you know which worker to
  reach and who needs attention. Run it whenever you need the roster or a health snapshot.
- ANSWER WORKER QUESTIONS. When a worker asks you something (it arrives as a "[coordinator]
  <session> asks: ..." message), you MUST reply by running bsc-answer <session> with your
  one-line answer piped on stdin -- e.g. echo "release-eng owns #158; stay out of it" |
  bsc-answer t0p2. That command resumes the parked worker automatically. Answering only in
  chat does NOT reach the worker: if you do not run bsc-answer, the worker stays stuck
  forever. Decide it yourself; never punt a worker question to the user.
- WATCHDOG MODE (self-merge fleets — the default). Workers run the full gate and merge their
  own work to develop; you do NOT merge PRs (there are none). Watch develop's CI. When you get a
  "[coordinator] develop CI is RED ..." message, identify the breaking commit (git log
  origin/develop), revert it to restore develop to green, then ping the owning worker via
  bsc-answer <session> (match the commit's changed paths to a stream's owned globs in
  CLAUDE.local.md) with a one-line fix-forward instruction. You do not assign or direct work and you do not merge -- workers self-integrate; you only answer bsc-ask questions and flag develop breakage.
- INTEGRATOR MODE (pr-ci / manual fleets). Workers open PRs (pr-ci) or commit without pushing
  (manual). Review and merge each green PR into develop (e.g. gh pr merge <n> --squash
  --delete-branch), then keep the milestones/board current.
- ROUTE NEW ISSUES (#376). When the issuer captures new work it surfaces to you as a
  "[coordinator] new issue: ..." message. Choose the owning worker by matching the issue
  to a stream's `owns` globs / area in CLAUDE.local.md, then run bsc-assign <session> with
  the issue body piped on stdin -- e.g. echo "add a retry to the upload path" | bsc-assign
  t0p1 --title "Retry uploads" --issue 412. That resumes the chosen worker and injects the
  issue so it picks it up immediately (into the existing PR -> CI -> merge loop). Open a
  GitHub issue first if the work should be tracked. You route; the issuer never assigns.
- KEEP THE FLEET MOVING. Any worker that is blocked or waiting is yours to unblock.
"#;

/// Ensure the project hub's CLAUDE.local.md carries the director protocol (#375). Idempotent.
#[tauri::command]
fn ensure_director_protocol(project_key: String) -> Result<(), String> {
    let local = project_dir(&project_key).join("CLAUDE.local.md");
    if let Some(parent) = local.parent() { let _ = std::fs::create_dir_all(parent); }
    let cur = std::fs::read_to_string(&local).unwrap_or_default();
    if !cur.contains("## Director protocol") {
        std::fs::write(&local, format!("{cur}{DIRECTOR_PROTOCOL_MD}")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Create (idempotently) a git worktree for one fleet agent: an isolated checkout
/// of `repo` on a branch named after the agent, at
/// `projects/<key>/.worktrees/<repoShort>--<agentSlug>`. Each agent edits and
/// commits in its own worktree+branch, so co-located agents (several in one repo)
/// never share a working tree; the director merges the branches via PRs.
///
/// The repo's main clone must already exist (cloned during planning). A worktree or
/// branch left over from a prior run is reused. Returns the worktree's absolute path
/// (native form — mirrors `agentWorktreeCwd` so the launched pane's cwd matches).
#[tauri::command]
async fn ensure_worktree(project_key: String, repo: String, agent_id: String) -> Result<String, String> {
    let _perf = PerfSpan::new("ensure_worktree");
    let clone = repo_dir(&project_key, &repo);
    if !clone.join(".git").exists() {
        return Err(format!("ensure_worktree: repo not cloned: {}", clone.display()));
    }
    let slug  = worktree_slug(&agent_id);
    let short = repo.rsplit('/').next().unwrap_or(&repo);
    let wt    = project_dir(&project_key).join(".worktrees").join(format!("{short}--{slug}"));
    let wt_str = wt.to_string_lossy().into_owned();
    // A worktree's `.git` is a FILE pointing into the main repo; create it only if
    // it isn't there yet (reuse across re-runs).
    if !wt.join(".git").exists() {
        if let Some(parent) = wt.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let clone_str = clone.to_string_lossy().into_owned();
        // Reuse the branch if a prior run already created it; otherwise create it.
        let mut probe = std::process::Command::new("git");
        probe.args(["-C", &clone_str, "rev-parse", "--verify", "--quiet", &format!("refs/heads/{slug}")]);
        let branch_exists = no_window(&mut probe).status().map(|s| s.success()).unwrap_or(false);
        let mut args: Vec<String> = vec!["-C".into(), clone_str, "worktree".into(), "add".into()];
        if branch_exists {
            args.push(wt_str.clone());
            args.push(slug.clone());
        } else {
            args.push("-b".into());
            args.push(slug.clone());
            args.push(wt_str.clone());
        }
        let mut wt_cmd = std::process::Command::new("git");
        wt_cmd.args(&args);
        let status = no_window(&mut wt_cmd).status().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("ensure_worktree: git worktree add failed for {repo} / {agent_id}"));
        }
        log::info!("ensure_worktree: {repo} agent {agent_id} → {wt_str}");
    }
    // Carry the planner's app-managed per-repo context into the worktree. CLAUDE.local.md
    // is UNTRACKED in the main clone (git-excluded), so a fresh worktree wouldn't have it —
    // refresh it every launch. Copy CLAUDE.md only when the worktree lacks one, so a
    // tracked/checked-out CLAUDE.md isn't clobbered.
    let local = clone.join("CLAUDE.local.md");
    if local.is_file() {
        let _ = std::fs::copy(&local, wt.join("CLAUDE.local.md"));
    }
    let claude_md = clone.join("CLAUDE.md");
    if claude_md.is_file() && !wt.join("CLAUDE.md").exists() {
        let _ = std::fs::copy(&claude_md, wt.join("CLAUDE.md"));
    }
    // Carry the coordination protocol (#369) into the worktree so the worker always has
    // the defer-to-director / never-ask-the-user rules as authoritative context.
    let wt_local = wt.join("CLAUDE.local.md");
    let cur = std::fs::read_to_string(&wt_local).unwrap_or_default();
    if !cur.contains("## Fleet coordination protocol") {
        let _ = std::fs::write(&wt_local, format!("{cur}{FLEET_PROTOCOL_MD}"));
    }
    // Inline the blueprint's attached skills (#636) so each worker carries the same skill
    // context the planner had. skills.md lives at the hub (not in the worktree), so the
    // planner's "read skills.md" note doesn't help a worker — inline it instead.
    inject_skills(&project_dir(&project_key), &wt_local);
    Ok(wt_str)
}

/// Inline the hub's attached skills (`skills.md`, #636) into a worker's CLAUDE.local.md
/// so the worker auto-loads the same skill context the planner had. Idempotent; a no-op
/// when there are no attached skills (skills.md absent/empty).
fn inject_skills(hub: &std::path::Path, wt_local: &std::path::Path) {
    let skills = std::fs::read_to_string(hub.join("skills.md")).unwrap_or_default();
    let trimmed = skills.trim();
    if trimmed.is_empty() {
        return;
    }
    let cur = std::fs::read_to_string(wt_local).unwrap_or_default();
    if cur.contains("# Attached skills & knowledge") {
        return; // already injected
    }
    let _ = std::fs::write(wt_local, format!("{}\n\n{}\n", cur.trim_end(), trimmed));
}

/// Append `entry` to a clone's `.git/info/exclude` (idempotent) so app-managed
/// files stay out of `git status`. No-op when `repo_root` is not a git repo.
fn git_exclude(repo_root: &std::path::Path, entry: &str) {
    if !repo_root.join(".git").exists() { return; }
    let exclude = repo_root.join(".git").join("info").join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == entry) { return; }
    let next = if existing.trim().is_empty() {
        format!("{}\n", entry)
    } else {
        format!("{}\n{}\n", existing.trim_end(), entry)
    };
    let _ = std::fs::write(&exclude, next);
}

/// Shell commands every spawned repo/console session auto-approves regardless of
/// the user's allowlist — the app's GitHub workflow (triage, publish, repo ops)
/// depends on them. `gh` is required by triage; `git` by every repo session.
const MANDATORY_BASH: &[&str] = &["gh", "git"];

/// Dangerous command patterns denied in every spawned session by default.
///
/// The session allows the Bash tool broadly so ordinary work — including loops
/// and `&&` / `|` compound commands — runs without a prompt ("start and go").
/// These guard against the most catastrophic *direct* invocations; deny takes
/// precedence over allow in Claude Code. Best-effort: prefix matching can't catch
/// a dangerous command nested inside a loop or pipe, so this raises the bar
/// against accidents, not a true sandbox. Users extend it from the Knowledge Base
/// → Commands section (the per-session `denied_commands`).
const DEFAULT_DENY: &[&str] = &[
    "Bash(sudo *)",
    "Bash(rm -rf /*)",
    "Bash(rm -fr /*)",
    "Bash(rm -rf ~*)",
    "Bash(dd *)",
    "Bash(mkfs *)",
    "Bash(shutdown *)",
    "Bash(reboot *)",
    "Bash(git push --force*)",
    "Bash(git push -f *)",
    "Bash(curl *| sh)",
    "Bash(curl *| bash)",
    "Bash(wget *| sh)",
];

/// One MCP server an extension contributes to a session's `.mcp.json`. Field names
/// match the frontend `McpServerPayload`.
#[derive(serde::Deserialize, Clone)]
struct McpServerCfg {
    name: String,
    transport: String, // "stdio" | "http"
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    env: Vec<(String, String)>,
}

/// One lifecycle hook an extension contributes to a session's settings.json.
#[derive(serde::Deserialize, Clone)]
struct HookCfg {
    event: String,   // PreToolUse | PostToolUse | …
    #[serde(default)]
    matcher: String, // optional tool matcher; empty = all
    command: String,
}

/// One reusable Skill written into a session as a Claude Code Skill file
/// (`.claude/skills/<slug>/SKILL.md`). Field names match the frontend payload.
#[derive(serde::Deserialize, Clone)]
struct SkillCfg {
    name: String,
    description: String,
    prompt: String,
    #[serde(default)]
    tools: Vec<String>,
}

/// Ensure the claude session rooted at `cwd` can run shell commands without a
/// permission prompt while blocking dangerous ones, and apply the session's
/// extensions (MCP servers → `.mcp.json`, hooks → settings.json), by merging into
/// `<cwd>/.claude/settings.json` and `<cwd>/.mcp.json`.
/// Markers the GitHub-readiness probe echoes when each check passes (#297). Plain
/// `echo` tokens so parsing is a locale-independent substring match, not coupled to
/// gh/git output formatting.
const GH_PATH_MARK: &str = "BSC_GH_PATH_OK";
const GIT_PATH_MARK: &str = "BSC_GIT_PATH_OK";
const GH_AUTH_MARK: &str = "BSC_GH_AUTH_OK";

/// Prefix the diagnostics preflight (#446) emits, one tab-delimited line per CLI
/// tool: `BSC_PREREQ\t<name>\t<path>\t<version>` (path/version empty when the tool
/// is absent). A distinct prefix keeps parsing a locale-independent substring scan,
/// like the GitHub-readiness markers above.
const PREFLIGHT_MARK: &str = "BSC_PREREQ";

/// Parse the probe shell's stdout into `(gh_on_path, git_on_path, gh_authed)`. Pure.
fn parse_github_probe(stdout: &str) -> (bool, bool, bool) {
    (
        stdout.contains(GH_PATH_MARK),
        stdout.contains(GIT_PATH_MARK),
        stdout.contains(GH_AUTH_MARK),
    )
}

/// Probe whether a session shell can actually reach GitHub (#297): is `git`/`gh`
/// on PATH, and is `gh` authenticated. Fleet agents are told to push branches and
/// open PRs, but a spawned shell can silently lack the tools; this lets the pane
/// warn the user up front. Runs the checks through the SAME resolved shell and
/// caller env (e.g. `GH_TOKEN`) the agent's `bash -c` subshells inherit, via a
/// login shell (`-lc`) so login-profile PATH additions are reflected. Best-effort:
/// returns all-false on spawn failure rather than erroring, so the caller can still
/// surface an actionable warning. Field names match the frontend `GithubProbe`.
#[tauri::command]
async fn github_readiness(
    cwd: String,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let shell = crate::shell::resolve_shell();
    let script = format!(
        "command -v git >/dev/null 2>&1 && echo {GIT_PATH_MARK}; \
         command -v gh  >/dev/null 2>&1 && echo {GH_PATH_MARK}; \
         gh auth status >/dev/null 2>&1 && echo {GH_AUTH_MARK}",
    );
    let mut cmd = std::process::Command::new(&shell);
    cmd.arg("-lc").arg(&script);
    if !cwd.is_empty() {
        cmd.current_dir(&cwd);
    }
    let env_map = env.unwrap_or_default();
    for (k, v) in crate::pty::session_env(&env_map) {
        cmd.env(k, v);
    }
    let (gh, git, auth) = match no_window(&mut cmd).output() {
        Ok(out) => parse_github_probe(&String::from_utf8_lossy(&out.stdout)),
        Err(e) => {
            log::warn!("github_readiness probe failed to spawn ({shell}): {e}");
            (false, false, false)
        }
    };
    Ok(serde_json::json!({ "ghOnPath": gh, "gitOnPath": git, "ghAuthed": auth }))
}

/// One prerequisite's detected state, reported to the Diagnostics UI (#446). Field
/// names match the frontend `PrereqStatus`.
#[derive(serde::Serialize, PartialEq, Debug)]
struct PrereqStatus {
    /// Display name, e.g. "Git Bash", "claude", "git", "gh", "gh auth".
    name: String,
    /// Whether the tool was located (and, for "gh auth", authenticated).
    found: bool,
    /// First line of `<tool> --version`, when found.
    version: Option<String>,
    /// Resolved on-disk path, when found.
    path: Option<String>,
    /// Actionable install/fix hint — empty when `found`.
    hint: String,
}

/// Git Bash detection outcome handed to [`interpret_preflight`] so the pure
/// interpretation stays testable off-Windows. `NotApplicable` omits the entry
/// (non-Windows, where the session shell IS bash); `Missing`/`Found` map to the
/// Windows console-shell prerequisite.
// Each build constructs only its platform's variants — `NotApplicable` off Windows,
// `Found`/`Missing` on Windows (plus tests exercise all three), so per-platform
// dead-code analysis would flag the unused ones.
#[allow(dead_code)]
#[derive(Clone, PartialEq, Debug)]
enum GitBashProbe {
    NotApplicable,
    Missing,
    Found(String),
}

/// Static install/fix hint for a prerequisite that wasn't found. Empty for unknown
/// names so a present tool never carries a hint.
fn prereq_hint(tool: &str) -> &'static str {
    match tool {
        "claude" => "Install the Claude CLI — see https://docs.claude.com/claude-code",
        "git" => "Install Git — https://git-scm.com/downloads",
        "gh" => "Install the GitHub CLI — https://cli.github.com",
        "gh auth" => "Run `gh auth login` to authenticate the GitHub CLI",
        "Git Bash" => "Install Git for Windows (provides Git Bash) — https://git-scm.com/download/win",
        _ => "",
    }
}

/// Pure: turn the preflight probe's stdout (+ Git Bash detection) into the ordered
/// prerequisite list. No I/O, so it is fully unit-testable. `BSC_PREREQ` lines carry
/// each CLI tool's path/version; `BSC_GH_AUTH_OK` (reused from the GitHub probe)
/// signals `gh` is authenticated. `gh auth` is only reported authenticated when `gh`
/// itself is present, so a stale auth marker can't mask a missing CLI.
fn interpret_preflight(stdout: &str, git_bash: GitBashProbe) -> Vec<PrereqStatus> {
    // name -> (path, version), both trimmed; empty string means absent.
    let mut probed: HashMap<String, (String, String)> = HashMap::new();
    for line in stdout.lines() {
        let mut parts = line.splitn(4, '\t');
        if parts.next() != Some(PREFLIGHT_MARK) { continue; }
        if let Some(name) = parts.next() {
            let path = parts.next().unwrap_or("").trim().to_string();
            let version = parts.next().unwrap_or("").trim().to_string();
            probed.insert(name.to_string(), (path, version));
        }
    }

    let mut out: Vec<PrereqStatus> = Vec::new();

    // Git Bash — the Windows console shell; omitted where bash is the native shell.
    match git_bash {
        GitBashProbe::NotApplicable => {}
        GitBashProbe::Missing => out.push(PrereqStatus {
            name: "Git Bash".into(), found: false, version: None, path: None,
            hint: prereq_hint("Git Bash").into(),
        }),
        GitBashProbe::Found(p) => out.push(PrereqStatus {
            name: "Git Bash".into(), found: true, version: None, path: Some(p),
            hint: String::new(),
        }),
    }

    // CLI tools probed through the shell, in a fixed order (independent of stdout).
    for tool in ["claude", "git", "gh"] {
        let (path, version) = probed.get(tool).cloned().unwrap_or_default();
        let found = !path.is_empty();
        out.push(PrereqStatus {
            name: tool.into(),
            found,
            version: if version.is_empty() { None } else { Some(version) },
            path: if path.is_empty() { None } else { Some(path) },
            hint: if found { String::new() } else { prereq_hint(tool).into() },
        });
    }

    // gh authentication — meaningful only once `gh` itself is present.
    let gh_found = probed.get("gh").map(|(p, _)| !p.is_empty()).unwrap_or(false);
    let authed = gh_found && stdout.contains(GH_AUTH_MARK);
    out.push(PrereqStatus {
        name: "gh auth".into(),
        found: authed,
        version: None,
        path: None,
        hint: if authed { String::new() } else { prereq_hint("gh auth").into() },
    });

    out
}

/// Resolve the Git Bash prerequisite state for the diagnostics preflight: on
/// Windows, whether [`find_git_bash`] located a `bash.exe`; elsewhere bash is the
/// native shell, so Git Bash is not a prerequisite.
fn detect_git_bash() -> GitBashProbe {
    #[cfg(windows)]
    {
        match crate::shell::find_git_bash() {
            Some(p) => GitBashProbe::Found(p),
            None => GitBashProbe::Missing,
        }
    }
    #[cfg(not(windows))]
    {
        GitBashProbe::NotApplicable
    }
}

/// Diagnostics preflight (#446): in one call, report whether each external
/// prerequisite the app needs is present — the Windows console shell (Git Bash),
/// the `claude` CLI that runs agents, and `git`/`gh` (+ `gh` auth). Each result
/// carries presence, version, path, and an install hint so the UI can tell the user
/// exactly what to install. Runs through the SAME resolved shell + caller env as
/// agent subshells (login shell, so profile PATH additions count). Best-effort: a
/// spawn failure reports the CLI tools as missing rather than erroring.
#[tauri::command]
async fn preflight(
    cwd: String,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<Vec<PrereqStatus>, String> {
    let shell = crate::shell::resolve_shell();
    // One tab-delimited line per tool: BSC_PREREQ <name> <path> <version>. `tr` drops
    // CRs/tabs so a Windows version string can't break the field layout.
    let script = format!(
        "for t in claude git gh; do \
           p=\"$(command -v \"$t\" 2>/dev/null)\"; \
           v=\"$(\"$t\" --version 2>/dev/null | head -1 | tr -d '\\r\\t')\"; \
           printf '{PREFLIGHT_MARK}\\t%s\\t%s\\t%s\\n' \"$t\" \"$p\" \"$v\"; \
         done; \
         gh auth status >/dev/null 2>&1 && echo {GH_AUTH_MARK}",
    );
    let mut cmd = std::process::Command::new(&shell);
    cmd.arg("-lc").arg(&script);
    if !cwd.is_empty() {
        cmd.current_dir(&cwd);
    }
    let env_map = env.unwrap_or_default();
    for (k, v) in crate::pty::session_env(&env_map) {
        cmd.env(k, v);
    }
    let stdout = match no_window(&mut cmd).output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout).into_owned(),
        Err(e) => {
            log::warn!("preflight probe failed to spawn ({shell}): {e}");
            String::new()
        }
    };
    Ok(interpret_preflight(&stdout, detect_git_bash()))
}

/// Read the persisted console-shell preference (#447) for the Diagnostics selector.
/// Returns the lowercase kind string (`auto`/`bash`/`powershell`/`cmd`).
#[tauri::command]
fn get_preferred_shell() -> String {
    crate::shell::read_shell_pref().as_str().to_string()
}

/// Persist the console-shell preference (#447). Takes the frontend `ShellKind`
/// string; an unrecognized value is normalized to `auto` so the file always holds a
/// valid token. The next session launch reads it via `resolve_interactive_shell`.
#[tauri::command]
fn set_preferred_shell(kind: String) -> Result<(), String> {
    let pref = crate::shell::ShellPref::parse(&kind);
    let base = bsc_base_dir();
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    std::fs::write(crate::shell::shell_pref_path(), pref.as_str()).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn ensure_session_settings(
    cwd: String,
    allowed_commands: Vec<String>,
    denied_commands: Vec<String>,
    mcp_servers: Option<Vec<McpServerCfg>>,
    hooks: Option<Vec<HookCfg>>,
    allow_tool_rules: Option<Vec<String>>,
    deny_tool_rules: Option<Vec<String>>,
    ask_tool_rules: Option<Vec<String>>,
    skills: Option<Vec<SkillCfg>>,
) -> Result<(), String> {
    write_session_settings(
        &cwd, &allowed_commands, &denied_commands,
        &mcp_servers.unwrap_or_default(), &hooks.unwrap_or_default(),
        &allow_tool_rules.unwrap_or_default(), &deny_tool_rules.unwrap_or_default(),
        &ask_tool_rules.unwrap_or_default(),
        &skills.unwrap_or_default(),
    )
}

/// Synchronous core of [`ensure_session_settings`] (testable without a runtime).
///
/// Security model: the session ALLOWS the Bash tool broadly so normal commands
/// (loops, pipes, `&&` chains) run without a prompt. A curated default deny-list
/// ({@link DEFAULT_DENY}) plus any user/project `denied_commands` block the most
/// dangerous direct invocations (deny wins over allow). The configured
/// `allowed_commands` are still written as explicit prefix rules — harmless under
/// the broad allow, and meaningful if "Bash" is ever removed to go strict.
/// Merges into existing settings rather than clobbering; `.claude/` stays out of
/// the repo's `git status`.
#[allow(clippy::too_many_arguments)]
fn write_session_settings(
    cwd: &str,
    allowed_commands: &[String],
    denied_commands: &[String],
    mcp_servers: &[McpServerCfg],
    hooks: &[HookCfg],
    allow_tool_rules: &[String],
    deny_tool_rules: &[String],
    ask_tool_rules: &[String],
    skills: &[SkillCfg],
) -> Result<(), String> {
    if cwd.is_empty() { return Ok(()); }
    let root = std::path::PathBuf::from(cwd);
    let settings_path = root.join(".claude").join("settings.json");

    let mut config: serde_json::Value = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !config.is_object() { config = serde_json::json!({}); }

    // Allow: the Bash tool broadly (start-and-go) + mandatory gh/git + each
    // configured command as an explicit prefix rule (deduped).
    let mut allow_rules: Vec<String> = vec!["Bash".to_string()];
    for c in MANDATORY_BASH.iter().map(|s| (*s).to_string())
        .chain(allowed_commands.iter().map(|c| c.trim().to_string()))
    {
        if !c.is_empty() {
            let r = format!("Bash({} *)", c);
            if !allow_rules.contains(&r) { allow_rules.push(r); }
        }
    }

    // Deny: curated dangerous defaults + user/project denies (deny > allow).
    let mut deny_rules: Vec<String> = DEFAULT_DENY.iter().map(|s| (*s).to_string()).collect();
    for c in denied_commands {
        let c = c.trim();
        if !c.is_empty() {
            let r = format!("Bash({} *)", c);
            if !deny_rules.contains(&r) { deny_rules.push(r); }
        }
    }

    // Tool-permission rules (verbatim, NOT Bash-wrapped) — the role write-path guard
    // passes `Edit(<glob>)` / `Write` / … here to scope or deny the file-write tools.
    for r in allow_tool_rules {
        let r = r.trim().to_string();
        if !r.is_empty() && !allow_rules.contains(&r) { allow_rules.push(r); }
    }
    for r in deny_tool_rules {
        let r = r.trim().to_string();
        if !r.is_empty() && !deny_rules.contains(&r) { deny_rules.push(r); }
    }

    // Ask: rules that PROMPT the user before the command (Claude Code precedence
    // deny > ask > allow, so a specific ask overrides the broad Bash allow). The
    // flow's hard push-confirm gate (#297) passes `Bash(git push *)` / `Bash(gh pr
    // create *)` here so pushes/PRs require approval instead of auto-running.
    let mut ask_rules: Vec<String> = Vec::new();
    for r in ask_tool_rules {
        let r = r.trim().to_string();
        if !r.is_empty() && !ask_rules.contains(&r) { ask_rules.push(r); }
    }

    merge_permission_list(&mut config, "allow", &allow_rules);
    merge_permission_list(&mut config, "deny", &deny_rules);
    merge_permission_list(&mut config, "ask", &ask_rules);

    // Hooks → settings.json `hooks` (overwritten with the resolved set, so toggling
    // a hook extension off and relaunching drops it). MCP servers → `.mcp.json`,
    // auto-approved for autonomous sessions via `enabledMcpjsonServers` (exactly the
    // resolved set — servers not listed aren't trusted, which is how removal lands).
    write_session_hooks(&mut config, hooks);
    {
        let obj = config.as_object_mut().unwrap();
        if mcp_servers.is_empty() {
            obj.remove("enabledMcpjsonServers");
        } else {
            obj.insert(
                "enabledMcpjsonServers".into(),
                serde_json::Value::Array(
                    mcp_servers.iter().map(|m| serde_json::Value::String(m.name.clone())).collect(),
                ),
            );
        }
    }

    std::fs::create_dir_all(root.join(".claude")).map_err(|e| e.to_string())?;
    std::fs::write(
        &settings_path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    ).map_err(|e| e.to_string())?;
    write_mcp_json(&root, mcp_servers)?;
    write_session_skills(&root, skills)?;
    git_exclude(&root, ".claude/");
    git_exclude(&root, ".mcp.json");
    Ok(())
}

/// Overwrite `config.hooks` with the resolved hooks, grouped by event:
/// `{event: [{matcher?, hooks: [{type:"command", command}]}]}`. Empty → key removed.
fn write_session_hooks(config: &mut serde_json::Value, hooks: &[HookCfg]) {
    let obj = config.as_object_mut().unwrap();
    if hooks.is_empty() { obj.remove("hooks"); return; }
    let mut by_event = serde_json::Map::new();
    for h in hooks {
        let inner = serde_json::json!({ "type": "command", "command": h.command });
        let entry = if h.matcher.is_empty() {
            serde_json::json!({ "hooks": [inner] })
        } else {
            serde_json::json!({ "matcher": h.matcher, "hooks": [inner] })
        };
        by_event
            .entry(h.event.clone())
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut().unwrap()
            .push(entry);
    }
    obj.insert("hooks".into(), serde_json::Value::Object(by_event));
}

/// Merge the resolved MCP servers into `<cwd>/.mcp.json` by name (preserving any
/// repo-authored entries). Skips entirely when there are none and no file exists.
/// `enabledMcpjsonServers` in settings.json gates which are actually active.
fn write_mcp_json(root: &std::path::Path, mcp_servers: &[McpServerCfg]) -> Result<(), String> {
    let path = root.join(".mcp.json");
    if mcp_servers.is_empty() && !path.exists() { return Ok(()); }
    let mut doc: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !doc.is_object() { doc = serde_json::json!({}); }
    let servers = doc.as_object_mut().unwrap()
        .entry("mcpServers").or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() { *servers = serde_json::json!({}); }
    let smap = servers.as_object_mut().unwrap();
    for m in mcp_servers {
        smap.insert(m.name.clone(), mcp_server_value(m));
    }
    std::fs::write(&path, serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// One MCP server's `.mcp.json` value: stdio `{command,args,env?}` or http `{type,url}`.
fn mcp_server_value(m: &McpServerCfg) -> serde_json::Value {
    if m.transport == "http" {
        return serde_json::json!({ "type": "http", "url": m.url.clone().unwrap_or_default() });
    }
    let mut v = serde_json::Map::new();
    v.insert("command".into(), serde_json::Value::String(m.command.clone().unwrap_or_default()));
    v.insert("args".into(), serde_json::Value::Array(
        m.args.iter().map(|a| serde_json::Value::String(a.clone())).collect(),
    ));
    let env: serde_json::Map<String, serde_json::Value> = m.env.iter()
        .filter(|(k, _)| !k.is_empty())
        .map(|(k, val)| (k.clone(), serde_json::Value::String(val.clone())))
        .collect();
    if !env.is_empty() { v.insert("env".into(), serde_json::Value::Object(env)); }
    serde_json::Value::Object(v)
}

/// Write each resolved Skill as a Claude Code Skill file at
/// `<cwd_root>/.claude/skills/<slug>/SKILL.md` (slug derived from the name). The
/// file is YAML frontmatter (`name`, `description`, optional `allowed-tools`) then
/// the prompt body. Skills with an empty slug are skipped; an empty set is a no-op.
///
/// Additive only: this writer creates/updates skill files but never deletes them,
/// so toggling a skill off does not remove its file yet (follow-up).
fn write_session_skills(cwd_root: &std::path::Path, skills: &[SkillCfg]) -> Result<(), String> {
    if cwd_root.as_os_str().is_empty() || skills.is_empty() { return Ok(()); }
    let skills_root = cwd_root.join(".claude").join("skills");
    for s in skills {
        let slug = skill_slug(&s.name);
        if slug.is_empty() { continue; }
        let dir = skills_root.join(&slug);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut doc = String::from("---\n");
        doc.push_str(&format!("name: {}\n", yaml_quote(&s.name)));
        doc.push_str(&format!("description: {}\n", yaml_quote(&s.description)));
        if !s.tools.is_empty() {
            doc.push_str(&format!("allowed-tools: {}\n", yaml_quote(&s.tools.join(", "))));
        }
        doc.push_str("---\n\n");
        doc.push_str(&s.prompt);
        std::fs::write(dir.join("SKILL.md"), doc).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Render a string as a YAML double-quoted scalar so frontmatter values with
/// colons, `#`, leading specials, or newlines can't break the `SKILL.md` header.
fn yaml_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
    format!("\"{}\"", escaped)
}

/// Slug a skill name: lowercase, keep `[a-z0-9-]`, collapse any run of other
/// chars to a single `-`, and trim leading/trailing `-`. May return empty.
fn skill_slug(name: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || c == '-' {
            if pending_dash && !out.is_empty() { out.push('-'); }
            pending_dash = false;
            out.push(c);
        } else {
            pending_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Merge `rules` into `config.permissions.<key>` (an array), preserving existing
/// entries and order, deduped. Creates the objects/array as needed.
fn merge_permission_list(config: &mut serde_json::Value, key: &str, rules: &[String]) {
    let obj = config.as_object_mut().unwrap();
    let permissions = obj.entry("permissions").or_insert_with(|| serde_json::json!({}));
    if !permissions.is_object() { *permissions = serde_json::json!({}); }
    let perm_obj = permissions.as_object_mut().unwrap();
    let list = perm_obj.entry(key).or_insert_with(|| serde_json::json!([]));
    if !list.is_array() { *list = serde_json::json!([]); }
    let arr = list.as_array_mut().unwrap();
    let mut seen: std::collections::HashSet<String> =
        arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
    for r in rules {
        if seen.insert(r.clone()) { arr.push(serde_json::Value::String(r.clone())); }
    }
}

/// Reads plan section files from the project hub. They live FLAT in
/// `projects/<key>/<section>.{md|json}` (no `plans/` subdir).
/// Returns a map of section key → file content for every file that exists and
/// is non-empty. Callers poll this on a short interval to pick up sections that
/// Claude writes via its Write tool (more reliable than parsing PTY output).
#[tauri::command]
async fn read_plan_sections(project_key: String) -> Result<std::collections::HashMap<String, String>, String> {
    let _perf = PerfSpan::new("read_plan_sections");
    let safe_key  = sanitize_project_key(&project_key);
    if safe_key.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let plans_dir = plan_dir_for(&project_key);
    if !plans_dir.exists() {
        return Ok(std::collections::HashMap::new());
    }
    // Dynamic: every non-empty .md/.json section file the planner wrote, keyed by
    // file stem, excluding the workspace control files. Lets the planner document
    // any topic (guided-dynamic sections) with no fixed key list. `_skipped` (the
    // considered-but-skipped record) and `phases` (.json roadmap) ride along and
    // are handled specially by the UI.
    const CONTROL: &[&str] = &["CLAUDE.md", "kb_index.md", "automations.md", "extensions.md", "github_context.md"];
    let mut sections = std::collections::HashMap::new();
    if let Ok(entries) = std::fs::read_dir(&plans_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() { continue; }
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if CONTROL.contains(&name) { continue; }
            if !matches!(path.extension().and_then(|e| e.to_str()), Some("md") | Some("json")) { continue; }
            if let (Some(stem), Ok(content)) =
                (path.file_stem().and_then(|s| s.to_str()), std::fs::read_to_string(&path))
            {
                let content = content.trim().to_string();
                if !content.is_empty() {
                    sections.insert(stem.to_string(), content);
                }
            }
        }
    }
    Ok(sections)
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // rustls 0.23 can't auto-determine a CryptoProvider from features at runtime, so
    // the relay dial's TLS handshake (tokio-tungstenite) would panic the tunnel thread
    // ("could not automatically determine the process-level CryptoProvider"). Install
    // `ring` explicitly before any TLS; Err just means one is already installed.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                // Keep noisy dependencies (tauri/wry/reqwest) quiet — only warnings
                // and above — while showing our own app logs at info. A global Info
                // filter floods stdout+file from deps and can stall the UI.
                .level(log::LevelFilter::Warn)
                .level_for("base_studio_code_lib", log::LevelFilter::Info)
                .format(|out, message, record| {
                    let ts = time::OffsetDateTime::now_utc()
                        .format(&time::macros::format_description!("[hour]:[minute]:[second]"))
                        .unwrap_or_default();
                    out.finish(format_args!(
                        "\x1b[90m{ts}\x1b[0m {color}{level:<5}\x1b[0m \x1b[90m{target}\x1b[0m {message}",
                        color = level_color(record.level()),
                        level = record.level(),
                        target = record.target(),
                    ));
                })
                .targets([
                    // Visible in the `tauri dev` terminal…
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    // …and persisted to a rotating file in the app log dir.
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("base-studio-code".into()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .manage(crate::pty::PtyState::new())
        .manage(tunnel::TunnelState::new())
        .manage(perf::PerfState::new(bsc_base_dir().join("perf.db")))
        .setup(|app| {
            // Cap unbounded log files once at startup to reclaim disk space.
            perf::cap_logs(&bsc_base_dir());
            // Spawn the background performance sampler.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(perf::run_sampler(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            kb_chat,
            github::github_request,
            github::gist_create,
            github::github_cache_clear,
            github::github_graphql,
            github::github_post,
            github::github_put,
            oauth::github_client_id,
            oauth::github_device_start,
            oauth::github_device_poll,
            pty::pty_create,
            pty::pty_write,
            pty::pty_broadcast,
            pty::pty_resize,
            pty::pty_kill,
            pick_directory,
            planner::setup_workspaces,
            setup_kb_workspace,
            clone_repo,
            ensure_worktree,
            ensure_director_protocol,
            docstore::get_base_dir,
            config::read_claude_config,
            config::write_claude_config,
            ensure_session_settings,
            github_readiness,
            preflight,
            get_preferred_shell,
            set_preferred_shell,
            read_plan_sections,
            docstore::write_project_plan,
            delete_project_dir,
            clear_all_plan_files,
            clear_project_plan_files,
            write_project_file,
            write_project_file_bytes,
            scan_dead_code,
            read_project_files,
            planner::get_context_signature,
            planner::compute_context_signature,
            docstore::list_documents,
            docstore::read_document,
            docstore::write_document,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
            tunnel::tunnel_status,
            tunnel::tunnel_set_input_granted,
            tunnel::tunnel_unpair,
            tunnel::tunnel_set_panes,
            tunnel::tunnel_set_sessions,
            tunnel::tunnel_set_plan_state,
            tunnel::tunnel_ack_plan_push,
            read_audit_log,
            read_skill_log,
            tokens::read_token_usage,
            read_coord_log,
            read_ui_skeleton,
            project_dir_path,
            append_coord_woke,
            githooks::read_git_hooks,
            perf::perf_get_config,
            perf::perf_set_config,
            perf::perf_record_frontend_sample,
            perf::perf_clear_history,
            perf::perf_get_recent_samples,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Drain PtyState on app exit so the OS reclaims every shell + its
        // descendants (`claude`, `gh`, `git`, MCP children) before the process
        // dies. Without this, closing the app window left ~28 orphan
        // `bash`/`claude`/WebView children holding cwd locks on
        // `~/.base-studio-code` (#52).
        .run(|app_handle, event| {
            if matches!(event, RunEvent::Exit) {
                // Signal the tunnel transport (#242b) to close before tearing down PTYs.
                app_handle.state::<tunnel::TunnelState>().shutdown();
                crate::pty::kill_all_pty_sessions(app_handle.state::<crate::pty::PtyState>().inner());
            }
        });
}

/// Shared test helpers, reachable from every module's `#[cfg(test)] mod tests` via
/// `crate::testutil::*` (so module tests can be co-located, #758).
#[cfg(test)]
pub(crate) mod testutil {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex as StdMutex;

    /// Serializes the env-mutating tests (they all repoint HOME/USERPROFILE, which
    /// `home_dir()` reads) so they can't race each other.
    pub static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    /// Fresh unique temp dir with HOME/USERPROFILE pointed at it so `bsc_base_dir()`
    /// resolves inside it. Caller removes it when done.
    pub fn temp_home(tag: &str) -> PathBuf {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("bsc-test-{tag}-{pid}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("HOME", &dir);
        std::env::set_var("USERPROFILE", &dir);
        dir
    }

    pub fn write_file(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use crate::testutil::{ENV_LOCK, temp_home, write_file};

    #[test]
    fn pane_id_format_matches_frontend_convention() {
        // The frontend uses `t${tabIdx}p${paneIdx}` as the pane ID key.
        // Verify the format matches for several indices.
        assert_eq!(format!("t{}p{}", 0, 0), "t0p0");
        assert_eq!(format!("t{}p{}", 1, 3), "t1p3");
        assert_eq!(format!("t{}p{}", 2, 8), "t2p8");
    }

    #[test]
    fn osc7_path_strip_removes_scheme_and_host() {
        // Mirrors what TerminalView.tsx does in the browser:
        // data.replace(/^file:\/\/[^/]*/, "")
        let input = "file://localhost/c/Users/Kevin/project";
        let stripped = input.trim_start_matches("file://").split_once('/')
            .map(|(_, rest)| format!("/{}", rest))
            .unwrap_or_default();
        assert_eq!(stripped, "/c/Users/Kevin/project");
    }

    use super::{bash_ansi_c_quote, sanitize_project_key, claude_launch, claude_project_dir_name};

    #[test]
    fn read_skeleton_dir_collects_source_files_recursively() {
        use std::fs;
        let root = std::env::temp_dir().join(format!("bsc_skel_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("parts")).unwrap();
        fs::write(root.join("Login.jsx"), "export default () => null;").unwrap();
        fs::write(root.join("parts/Field.tsx"), "export const F = 1;").unwrap();
        fs::write(root.join("notes.md"), "ignore me").unwrap();        // wrong ext → skipped
        fs::write(root.join("data.json"), "{}").unwrap();

        let files = super::read_skeleton_dir(&root);
        let keys: Vec<&str> = files.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"Login.jsx"), "got {keys:?}");
        assert!(keys.contains(&"parts/Field.tsx"), "nested + forward-slash relpath");
        assert!(keys.contains(&"data.json"));
        assert!(!keys.iter().any(|k| k.ends_with(".md")), "non-source files skipped");

        // Missing folder → empty, never panics.
        assert!(super::read_skeleton_dir(&root.join("nope")).is_empty());
        let _ = fs::remove_dir_all(&root);
    }


    #[test]
    fn ansi_c_quote_wraps_plain_text() {
        assert_eq!(bash_ansi_c_quote("triage the issues"), "$'triage the issues'");
    }

    #[test]
    fn claude_launch_bakes_prompt_fresh() {
        assert_eq!(claude_launch("triage the issues", false), "claude $'triage the issues'");
    }

    #[test]
    fn claude_launch_adds_continue_flag() {
        // Triage resumes the repo's prior conversation instead of starting fresh.
        assert_eq!(claude_launch("triage the issues", true), "claude --continue $'triage the issues'");
    }

    #[test]
    fn worktree_slug_keeps_only_branch_safe_chars() {
        // The slug doubles as a git branch name + worktree dir, and must match the
        // frontend `worktreeSlug` (replace anything outside [A-Za-z0-9._-] with '-').
        assert_eq!(super::worktree_slug("auth-ui"), "auth-ui");
        assert_eq!(super::worktree_slug("a.b_c-d"), "a.b_c-d");
        assert_eq!(super::worktree_slug("API client/2"), "API-client-2");
    }

    #[test]
    fn claude_project_dir_name_replaces_non_alnum_with_dash() {
        // Matches the dir Claude Code creates under ~/.claude/projects.
        assert_eq!(
            claude_project_dir_name(r"C:\Users\Kevin\Projects\rust\base-studio-code"),
            "C--Users-Kevin-Projects-rust-base-studio-code"
        );
        // Consecutive specials (\ then .) each map to their own dash.
        assert_eq!(
            claude_project_dir_name(r"C:\Users\Kevin\.base-studio-code\documents"),
            "C--Users-Kevin--base-studio-code-documents"
        );
    }

    #[test]
    fn ansi_c_quote_escapes_newlines_quotes_and_backslashes() {
        // Newlines collapse to \n so the whole token stays on one physical line;
        // single quotes and backslashes are escaped. $ and backticks pass through
        // literally (ANSI-C quoting does not expand them).
        assert_eq!(
            bash_ansi_c_quote("line1\nit's $HOME `cmd` \\x"),
            "$'line1\\nit\\'s $HOME `cmd` \\\\x'"
        );
    }

    #[test]
    fn parse_github_probe_detects_each_marker_independently() {
        use super::{GH_AUTH_MARK, GH_PATH_MARK, GIT_PATH_MARK};
        // All three markers present -> (gh, git, auth) all true.
        let all = format!("{GIT_PATH_MARK}
{GH_PATH_MARK}
{GH_AUTH_MARK}
");
        assert_eq!(super::parse_github_probe(&all), (true, true, true));
        // Empty output (probe found nothing) -> all false.
        assert_eq!(super::parse_github_probe(""), (false, false, false));
        // git on PATH but gh missing -> gh false, git true, auth false.
        let git_only = format!("{GIT_PATH_MARK}
");
        assert_eq!(super::parse_github_probe(&git_only), (false, true, false));
        // gh present but unauthenticated -> gh true, git true, auth false.
        let no_auth = format!("{GIT_PATH_MARK}
{GH_PATH_MARK}
");
        assert_eq!(super::parse_github_probe(&no_auth), (true, true, false));
    }

    #[test]
    fn interpret_preflight_reports_each_prerequisite() {
        use super::{interpret_preflight, GitBashProbe, GH_AUTH_MARK, PREFLIGHT_MARK};
        // Everything present + authed, on Windows with Git Bash found.
        let stdout = format!(
            "{PREFLIGHT_MARK}\tclaude\t/usr/bin/claude\tclaude 1.2.3\n\
             {PREFLIGHT_MARK}\tgit\t/usr/bin/git\tgit version 2.43.0\n\
             {PREFLIGHT_MARK}\tgh\t/usr/bin/gh\tgh version 2.40.0\n\
             {GH_AUTH_MARK}\n"
        );
        let r = interpret_preflight(&stdout, GitBashProbe::Found("C:\\Git\\bin\\bash.exe".into()));
        // Git Bash first (the console shell), then claude, git, gh, gh auth.
        let names: Vec<&str> = r.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["Git Bash", "claude", "git", "gh", "gh auth"]);
        assert!(r.iter().all(|p| p.found), "all prerequisites should be found");
        assert!(r.iter().all(|p| p.hint.is_empty()), "found tools carry no hint");
        let git = r.iter().find(|p| p.name == "git").unwrap();
        assert_eq!(git.version.as_deref(), Some("git version 2.43.0"));
        assert_eq!(git.path.as_deref(), Some("/usr/bin/git"));
    }

    #[test]
    fn interpret_preflight_flags_missing_tools_with_hints() {
        use super::{interpret_preflight, GitBashProbe, PREFLIGHT_MARK};
        // claude + git present; gh missing (empty path), unauthenticated; Git Bash missing.
        let stdout = format!(
            "{PREFLIGHT_MARK}\tclaude\t/usr/bin/claude\tclaude 1.2.3\n\
             {PREFLIGHT_MARK}\tgit\t/usr/bin/git\tgit version 2.43.0\n\
             {PREFLIGHT_MARK}\tgh\t\t\n"
        );
        let r = interpret_preflight(&stdout, GitBashProbe::Missing);
        let gh = r.iter().find(|p| p.name == "gh").unwrap();
        assert!(!gh.found);
        assert!(gh.hint.contains("cli.github.com"));
        let gh_auth = r.iter().find(|p| p.name == "gh auth").unwrap();
        assert!(!gh_auth.found, "gh missing -> auth cannot be reported found");
        assert!(!gh_auth.hint.is_empty());
        let gitbash = r.iter().find(|p| p.name == "Git Bash").unwrap();
        assert!(!gitbash.found);
        assert!(gitbash.hint.contains("git-scm.com"));
        // Present tools still carry their version/path even when others are missing.
        assert!(r.iter().find(|p| p.name == "claude").unwrap().found);
    }

    #[test]
    fn interpret_preflight_omits_git_bash_off_windows() {
        use super::{interpret_preflight, GitBashProbe};
        let r = interpret_preflight("", GitBashProbe::NotApplicable);
        assert!(!r.iter().any(|p| p.name == "Git Bash"));
        // Empty probe -> every CLI tool reported missing with a hint.
        let names: Vec<&str> = r.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["claude", "git", "gh", "gh auth"]);
        assert!(r.iter().all(|p| !p.found));
        assert!(r.iter().all(|p| !p.hint.is_empty()));
    }

    #[test]
    fn interpret_preflight_gh_auth_requires_gh_present() {
        // A stale GH_AUTH_OK marker must NOT report auth when gh itself is absent.
        use super::{interpret_preflight, GitBashProbe, GH_AUTH_MARK, PREFLIGHT_MARK};
        let stdout = format!("{PREFLIGHT_MARK}\tgh\t\t\n{GH_AUTH_MARK}\n");
        let r = interpret_preflight(&stdout, GitBashProbe::NotApplicable);
        assert!(!r.iter().find(|p| p.name == "gh auth").unwrap().found);
    }

    #[test]
    fn ensure_session_settings_merges_mandatory_and_custom_commands() {
        use super::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-{}", std::process::id()));
        let settings = dir.join(".claude").join("settings.json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        // Seed an existing setting that must be preserved (not clobbered).
        std::fs::write(
            &settings,
            r#"{"model":"claude-sonnet-4-6","permissions":{"allow":["Read"],"deny":["WebSearch"]}}"#,
        ).unwrap();

        write_session_settings(
            &dir.to_string_lossy(),
            &["cargo".into(), "git".into()],
            &["scp".into()],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
        ).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let deny: Vec<String> = v["permissions"]["deny"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        // Pre-existing entries are preserved (merged, not clobbered).
        assert!(allow.contains(&"Read".to_string()));
        assert!(deny.contains(&"WebSearch".to_string()));
        assert_eq!(v["model"], "claude-sonnet-4-6");
        // Bash is allowed broadly (start-and-go) plus explicit gh/git/custom rules.
        assert!(allow.contains(&"Bash".to_string()));
        assert!(allow.contains(&"Bash(gh *)".to_string()));
        assert!(allow.contains(&"Bash(git *)".to_string()));
        assert!(allow.contains(&"Bash(cargo *)".to_string()));
        assert_eq!(allow.iter().filter(|r| *r == "Bash(git *)").count(), 1);
        // Curated dangerous defaults plus the user deny are present.
        assert!(deny.contains(&"Bash(sudo *)".to_string()));
        assert!(deny.contains(&"Bash(rm -rf /*)".to_string()));
        assert!(deny.contains(&"Bash(scp *)".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_writes_ask_tier_for_hard_push_gate() {
        use super::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-ask-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();

        // A hard push-confirm flow (#297) asks before push/PR: the rules land in
        // permissions.ask (deny > ask > allow), so they prompt under the broad Bash allow.
        write_session_settings(
            &dir.to_string_lossy(),
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &["Bash(git push *)".into(), "Bash(gh pr create *)".into()],
            &[],
        ).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let ask: Vec<String> = v["permissions"]["ask"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(ask.contains(&"Bash(git push *)".to_string()));
        assert!(ask.contains(&"Bash(gh pr create *)".to_string()));
        // Bash stays broadly allowed; ask only narrows the two push writes.
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(allow.contains(&"Bash".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_merges_verbatim_tool_rules() {
        use super::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-tool-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();

        // The role write-path guard: deny every write tool (planner/director/triage),
        // and auto-approve a worker's boundary glob.
        write_session_settings(
            &dir.to_string_lossy(),
            &[],
            &[],
            &[],
            &[],
            &["Edit(src/auth/**)".into(), "Write(src/auth/**)".into()],
            &["Edit".into(), "Write".into(), "MultiEdit".into(), "NotebookEdit".into()],
            &[],
            &[],
        ).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let deny: Vec<String> = v["permissions"]["deny"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        // Tool rules land verbatim — NOT wrapped in Bash(...).
        assert!(allow.contains(&"Edit(src/auth/**)".to_string()));
        assert!(allow.contains(&"Write(src/auth/**)".to_string()));
        assert!(!allow.iter().any(|r| r.contains("Bash(Edit")));
        assert!(deny.contains(&"Edit".to_string()));
        assert!(deny.contains(&"Write".to_string()));
        assert!(deny.contains(&"MultiEdit".to_string()));
        assert!(deny.contains(&"NotebookEdit".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_writes_mcp_servers_and_hooks() {
        let dir = std::env::temp_dir().join(format!("bsc-ext-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let mcp = vec![
            super::McpServerCfg {
                name: "filesystem".into(), transport: "stdio".into(),
                command: Some("npx".into()), args: vec!["-y".into(), "@mcp/fs".into()],
                url: None, env: vec![("ROOT".into(), "/tmp".into())],
            },
            super::McpServerCfg {
                name: "sentry".into(), transport: "http".into(),
                command: None, args: vec![], url: Some("https://mcp.sentry.dev/sse".into()), env: vec![],
            },
        ];
        let hooks = vec![super::HookCfg {
            event: "PostToolUse".into(), matcher: "Write|Edit".into(), command: "format.sh".into(),
        }];
        super::write_session_settings(&dir.to_string_lossy(), &[], &[], &mcp, &hooks, &[], &[], &[], &[]).unwrap();

        // .mcp.json carries both servers in the right transport shapes.
        let mcp_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(mcp_json["mcpServers"]["filesystem"]["command"], "npx");
        assert_eq!(mcp_json["mcpServers"]["filesystem"]["args"][1], "@mcp/fs");
        assert_eq!(mcp_json["mcpServers"]["filesystem"]["env"]["ROOT"], "/tmp");
        assert_eq!(mcp_json["mcpServers"]["sentry"]["type"], "http");
        assert_eq!(mcp_json["mcpServers"]["sentry"]["url"], "https://mcp.sentry.dev/sse");

        // settings.json gates the servers + carries the hook grouped by event.
        let settings: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let enabled: Vec<String> = settings["enabledMcpjsonServers"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(enabled.contains(&"filesystem".to_string()) && enabled.contains(&"sentry".to_string()));
        assert_eq!(settings["hooks"]["PostToolUse"][0]["matcher"], "Write|Edit");
        assert_eq!(settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"], "format.sh");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_skills_writes_skill_files() {
        let dir = std::env::temp_dir().join(format!("bsc-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let skills = vec![
            super::SkillCfg {
                name: "Open a clean PR".into(),
                description: "Open a tidy pull request".into(),
                prompt: "Do the PR steps.".into(),
                tools: vec!["create_pr".into(), "git_diff".into()],
            },
            super::SkillCfg {
                name: "Review Docs".into(),
                description: "Review the docs".into(),
                prompt: "Check the docs.".into(),
                tools: vec![],
            },
        ];
        super::write_session_skills(&dir, &skills).unwrap();

        // First skill: slugged dir, frontmatter with name/description/allowed-tools, body.
        let a = std::fs::read_to_string(
            dir.join(".claude").join("skills").join("open-a-clean-pr").join("SKILL.md"),
        ).unwrap();
        assert!(a.starts_with("---\n"));
        assert!(a.contains("name: \"Open a clean PR\"\n"));
        assert!(a.contains("description: \"Open a tidy pull request\"\n"));
        assert!(a.contains("allowed-tools: \"create_pr, git_diff\"\n"));
        assert!(a.contains("Do the PR steps."));

        // Second skill: no tools → no allowed-tools line, body still present.
        let b = std::fs::read_to_string(
            dir.join(".claude").join("skills").join("review-docs").join("SKILL.md"),
        ).unwrap();
        assert!(b.contains("name: \"Review Docs\"\n"));
        assert!(b.contains("description: \"Review the docs\"\n"));
        assert!(!b.contains("allowed-tools:"));
        assert!(b.contains("Check the docs."));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_preserves_ascii_alphanumerics_and_dash() {
        assert_eq!(sanitize_project_key("my-project-123"), "my-project-123");
    }

    #[test]
    fn sanitize_replaces_punctuation_and_whitespace_with_underscore() {
        // Slashes, spaces, colons, dots → '_'.
        assert_eq!(sanitize_project_key("acme/api"), "acme_api");
        assert_eq!(sanitize_project_key("title::pitch"), "title__pitch");
        assert_eq!(sanitize_project_key("Studio Code v2.0"), "Studio_Code_v2_0");
    }

    #[test]
    fn sanitize_preserves_github_project_node_id() {
        // Project v2 node ids (underscores stay underscores, dash stays) are ASCII-safe.
        assert_eq!(sanitize_project_key("PVT_kwHOA_-LFc4BYsJC"), "PVT_kwHOA_-LFc4BYsJC");
    }

    #[test]
    fn sanitize_drops_unicode_letters_to_match_js_regex() {
        // The frontend's /[^a-zA-Z0-9-]/ is ASCII-only; café → caf_ (not café),
        // so the PTY id and planning directory stay byte-for-byte identical.
        assert_eq!(sanitize_project_key("café"), "caf_");
    }

    #[test]
    fn sanitize_truncates_to_80_chars() {
        let long = "a".repeat(200);
        assert_eq!(sanitize_project_key(&long).len(), 80);
    }

    use super::plan_dir_for;

    #[test]
    fn plan_dir_for_places_sanitized_key_under_projects() {
        let dir = plan_dir_for("studio-code");
        let s = dir.to_string_lossy().replace('\\', "/");
        // Project hub — plan sections live directly in projects/<key> (no
        // documents/ prefix, no trailing /plans).
        assert!(s.ends_with("/projects/studio-code"), "got {s}");
        assert!(!s.contains("/documents/"), "got {s}");
    }

    #[test]
    fn plan_dir_for_sanitizes_the_key() {
        let dir = plan_dir_for("acme/api project");
        let s = dir.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("/projects/acme_api_project"), "got {s}");
    }

    use super::level_color;

    #[test]
    fn level_color_is_distinct_per_level() {
        let colors = [
            level_color(log::Level::Error),
            level_color(log::Level::Warn),
            level_color(log::Level::Info),
            level_color(log::Level::Debug),
            level_color(log::Level::Trace),
        ];
        // every code is a non-empty ANSI escape, and all five are distinct
        assert!(colors.iter().all(|c| c.starts_with("\x1b[")));
        let unique: std::collections::HashSet<_> = colors.iter().collect();
        assert_eq!(unique.len(), colors.len());
    }

    use super::has_claude_history;

    #[test]
    fn has_claude_history_detects_jsonl_in_project_dir() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = temp_home("history");
        let cwd = r"C:\Users\Kevin\Projects\demo";
        let proj = home.join(".claude").join("projects").join(claude_project_dir_name(cwd));

        // No project dir yet → fresh launch.
        assert!(!has_claude_history(cwd));

        // Dir exists but holds no conversation → still fresh.
        std::fs::create_dir_all(&proj).unwrap();
        write_file(&proj.join("config.json"), "{}");
        assert!(!has_claude_history(cwd));

        // A conversation transcript is present → resume is safe.
        write_file(&proj.join("abc-123.jsonl"), "{}\n");
        assert!(has_claude_history(cwd));

        // Empty cwd is never resumable.
        assert!(!has_claude_history(""));
    }

    #[test]
    fn clear_project_plan_files_removes_md_and_json_only() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("cpf");
        let key = "test-plan-clear".to_string();
        let proj = super::bsc_base_dir().join("projects").join(&key);
        let sub = proj.join("my-repo");
        std::fs::create_dir_all(&sub).unwrap();
        write_file(&proj.join("goal.md"), "goal");
        write_file(&proj.join("phases.json"), "[]");
        write_file(&sub.join("README.md"), "# repo"); // inside subdir -- preserved
        // a generated UI skeleton that must be wiped too (#650)
        let skel = proj.join(".ui-skeleton");
        std::fs::create_dir_all(&skel).unwrap();
        write_file(&skel.join("Home.jsx"), "export default () => null");

        let removed = super::clear_project_plan_files(key.clone()).unwrap();
        assert_eq!(removed, 3, "goal.md + phases.json + .ui-skeleton removed");
        assert!(!proj.join("goal.md").exists());
        assert!(!proj.join("phases.json").exists());
        assert!(!skel.exists(), ".ui-skeleton dir wiped");
        assert!(sub.join("README.md").exists(), "subdir entry preserved");

        // Missing project -> Ok(0), no panic.
        let n = super::clear_project_plan_files("no-such-bsc-cpf-key".to_string()).unwrap();
        assert_eq!(n, 0);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn project_file_write_then_read_roundtrips_and_blocks_escape() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("ppf");
        let key = "test-pipeline-files".to_string();

        // Write nested under a pipeline subdir, then read the subdir back.
        super::write_project_file(key.clone(), "pipelines/vue/button.vue".to_string(), "<template/>".to_string()).unwrap();
        super::write_project_file(key.clone(), "pipelines/vue/card.vue".to_string(), "<card/>".to_string()).unwrap();
        let proj = super::bsc_base_dir().join("projects").join(&key);
        assert!(proj.join("pipelines").join("vue").join("button.vue").exists());

        let mut files = super::read_project_files(key.clone(), "pipelines/vue".to_string());
        files.sort();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].0, "button.vue");
        assert_eq!(files[0].1, "<template/>");

        // Escapes are rejected on write and yield empty on read.
        assert!(super::write_project_file(key.clone(), "../escape.txt".to_string(), "x".to_string()).is_err());
        assert!(super::write_project_file(key.clone(), "/abs.txt".to_string(), "x".to_string()).is_err());
        assert!(super::write_project_file(key.clone(), "  ".to_string(), "x".to_string()).is_err());
        assert!(super::read_project_files(key.clone(), "../..".to_string()).is_empty());

        // Missing subdir -> empty, no panic.
        assert!(super::read_project_files(key.clone(), "pipelines/none".to_string()).is_empty());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn inject_skills_inlines_hub_skills_idempotently() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("injectskills");
        let hub = home.join("hub");
        std::fs::create_dir_all(&hub).unwrap();
        let wt_local = home.join("CLAUDE.local.md");
        std::fs::write(&wt_local, "# repo plan\n").unwrap();

        // No skills.md ⇒ no-op.
        super::inject_skills(&hub, &wt_local);
        assert_eq!(std::fs::read_to_string(&wt_local).unwrap(), "# repo plan\n");

        // With skills.md ⇒ inlined under its heading.
        std::fs::write(hub.join("skills.md"), "# Attached skills & knowledge\n\n### Auth\nUse OAuth.\n").unwrap();
        super::inject_skills(&hub, &wt_local);
        let after = std::fs::read_to_string(&wt_local).unwrap();
        assert!(after.contains("# repo plan"), "keeps the plan");
        assert!(after.contains("Use OAuth."), "inlines the skills");

        // Second call ⇒ idempotent (not appended twice).
        super::inject_skills(&hub, &wt_local);
        assert_eq!(after, std::fs::read_to_string(&wt_local).unwrap());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn dead_code_cmd_allowlists_known_scanners_only() {
        assert!(super::dead_code_cmd("depcheck").is_some());
        assert!(super::dead_code_cmd("ts-prune").is_some());
        assert!(super::dead_code_cmd("cargo-machete").is_some());
        // arbitrary commands are never runnable
        assert!(super::dead_code_cmd("rm").is_none());
        assert!(super::dead_code_cmd("cargo machete; rm -rf /").is_none());
        assert!(super::dead_code_cmd("").is_none());
    }

    #[test]
    fn scan_dead_code_handles_bad_dir_and_unknown_tool() {
        let bad = super::scan_dead_code("/no/such/dir/xyzzy".to_string(), "depcheck".to_string());
        assert!(!bad.ran && bad.error.is_some());
        let unknown = super::scan_dead_code(".".to_string(), "totally-unknown".to_string());
        assert!(!unknown.ran && unknown.error.as_deref().unwrap_or("").contains("unknown scanner"));
    }

    #[test]
    fn write_project_file_bytes_decodes_base64_and_blocks_escape() {
        use base64::Engine;
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("ppfb");
        let key = "test-intake".to_string();

        // Stage a "binary" file (raw bytes, incl. a NUL) from base64.
        let bytes: &[u8] = &[0x89, b'P', b'N', b'G', 0x00, 0xFF, 0x10];
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        super::write_project_file_bytes(key.clone(), ".intake/logo.png".to_string(), b64).unwrap();
        let path = super::bsc_base_dir().join("projects").join(&key).join(".intake").join("logo.png");
        assert!(path.exists());
        assert_eq!(std::fs::read(&path).unwrap(), bytes, "bytes round-trip exactly");

        // Bad base64 + path escapes are rejected.
        assert!(super::write_project_file_bytes(key.clone(), ".intake/x.png".to_string(), "not base64!!".to_string()).is_err());
        assert!(super::write_project_file_bytes(key.clone(), "../escape.png".to_string(), "AAAA".to_string()).is_err());
        assert!(super::write_project_file_bytes(key.clone(), "/abs.png".to_string(), "AAAA".to_string()).is_err());

        std::fs::remove_dir_all(&home).ok();
    }
}
