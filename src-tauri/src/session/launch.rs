use crate::prelude::*;

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
/// Claude Code's on-disk *directory name* for a launch cwd. Conversations live at
/// `~/.claude/projects/<dir>/<session>.jsonl`, where `<dir>` is the cwd with every
/// non-alphanumeric character replaced by `-`
/// (e.g. `C:\Users\Kevin\foo` → `C--Users-Kevin-foo`).
///
/// NOT to be confused with [`crate::session::claude_config::claude_project_key`] (`claude_config.rs`):
/// that produces the cwd's *key in the `projects` map of `~/.claude.json`* — a slash-normalised path
/// (`C:/Users/Kevin/foo`), a different transform for a different on-disk Claude Code contract. Both
/// names are frozen to match what Claude Code writes; do not "unify" them.
pub(crate) fn claude_project_dir_name(cwd: &str) -> String {
    // keep [A-Za-z0-9] → '-', no cap (delegates to map_slug; semantics frozen).
    crate::platform::fsx::map_slug(cwd, |c| c.is_ascii_alphanumeric(), '-', None)
}
/// Claude Code's on-disk *transcripts directory* for a launch cwd:
/// `~/.claude/projects/<claude_project_dir_name(cwd)>`, where each conversation is stored as a
/// `<session>.jsonl`. The one construction of this path, shared by [`has_claude_history`] and
/// [`crate::fleet::inspect::claude_transcript_path`]. Pure path assembly — callers keep their own
/// empty-cwd guard (both bail before reading when `cwd` is blank).
pub(crate) fn claude_project_transcripts_dir(cwd: &str) -> std::path::PathBuf {
    home_dir().join(".claude").join("projects").join(claude_project_dir_name(cwd))
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
    let dir = claude_project_transcripts_dir(cwd);
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

#[cfg(test)]
mod relocated_tests {
    #![allow(unused_imports)]
    use super::*;
    use crate::testutil::prelude::*;

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
    fn transcripts_dir_is_claude_projects_slug() {
        // The shared path both has_claude_history and claude_transcript_path build: the frozen
        // per-cwd slug as the final component, under ~/.claude/projects.
        let dir = claude_project_transcripts_dir(r"C:\Users\x\foo");
        assert_eq!(dir.file_name().and_then(|n| n.to_str()), Some("C--Users-x-foo"));
        assert!(dir.ends_with(
            std::path::Path::new(".claude").join("projects").join("C--Users-x-foo")
        ));
    }
    #[test]
    fn has_claude_history_detects_jsonl_in_project_dir() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("history");
        let cwd = r"C:\Users\Kevin\Projects\demo";
        let proj = claude_project_transcripts_dir(cwd);
        assert_eq!(proj, home.join(".claude").join("projects").join(claude_project_dir_name(cwd)));

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
    fn bsc_agent_session_path_keys_off_cwd() {
        // Deterministic per-cwd path under agent-sessions/, slugged like Claude's projects dir.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = temp_home("agentsess-path");
        let cwd = r"C:\Users\Kevin\Projects\demo";
        let p = bsc_agent_session_path(cwd).unwrap();
        assert!(p.ends_with("conversation.json"));
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.contains("/agent-sessions/"));
        assert!(s.contains(&claude_project_dir_name(cwd)));
        // Empty cwd ⇒ no path (no persistence).
        assert!(bsc_agent_session_path("").is_none());
    }
    #[test]
    fn has_bsc_agent_history_requires_nonempty_session_file() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = temp_home("agentsess-hist");
        let cwd = r"C:\Users\Kevin\Projects\demo";
        let path = bsc_agent_session_path(cwd).unwrap();

        // No file yet → fresh.
        assert!(!has_bsc_agent_history(cwd));

        // Empty file → still fresh (an aborted/empty run shouldn't trigger resume).
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        write_file(&path, "");
        assert!(!has_bsc_agent_history(cwd));

        // Non-empty conversation → resume is safe.
        write_file(&path, "[{\"User\":\"hi\"}]");
        assert!(has_bsc_agent_history(cwd));

        // Empty cwd is never resumable.
        assert!(!has_bsc_agent_history(""));
    }
}
