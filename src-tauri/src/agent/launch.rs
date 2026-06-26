use crate::*;

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
pub(crate) fn claude_project_dir_name(cwd: &str) -> String {
    // keep [A-Za-z0-9] → '-', no cap (delegates to map_slug; semantics frozen).
    crate::platform::fsx::map_slug(cwd, |c| c.is_ascii_alphanumeric(), '-', None)
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
/// Where `bsc-agent` persists (and resumes) the conversation for `cwd`:
/// `~/.base-studio-code/agent-sessions/<cwd-key>/conversation.json`. The app owns this keying
/// (mirroring Claude's per-cwd projects dir, via the same `claude_project_dir_name` slug) and hands
/// the path to the sidecar through `$BSC_AGENT_SESSION`; the sidecar just reads/writes it. The
/// adapter checks the same path for `detect_history`. Empty cwd ⇒ None (no persistence). (#1144)
pub(crate) fn bsc_agent_session_path(cwd: &str) -> Option<std::path::PathBuf> {
    if cwd.is_empty() {
        return None;
    }
    Some(
        bsc_base_dir()
            .join("agent-sessions")
            .join(claude_project_dir_name(cwd))
            .join("conversation.json"),
    )
}
/// Whether `bsc-agent` has a resumable conversation for `cwd` — a non-empty session file exists.
/// Fail-safe: any uncertainty returns `false`, launching a fresh session. (#1144)
pub(crate) fn has_bsc_agent_history(cwd: &str) -> bool {
    bsc_agent_session_path(cwd)
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len() > 0)
        .unwrap_or(false)
}
