//! Session-harness adapters (#1078 P0) — how an agent runtime is launched and resumed in a PTY.
//!
//! `ClaudeCodeAdapter` is the only implementation today; it reproduces the exact launch behavior
//! `pty_create` had inline, delegating to the `claude_*` free fns in lib.rs. This trait is the seam
//! `bsc-agent` plugs into as a second adapter (P2); only the LAUNCH path is extracted so far —
//! config/telemetry/usage methods co-evolve with that second implementation rather than being
//! speculatively designed against a single impl.

/// How to launch (and resume) an agent runtime for a session.
pub trait HarnessAdapter {
    /// Whether this harness has a resumable conversation for `cwd` (drives the resume flag).
    fn detect_history(&self, cwd: &str) -> bool;
    /// The shell command that launches the harness, baking the startup `prompt` and requesting
    /// `resume` when supported.
    fn launch_command(&self, prompt: &str, resume: bool) -> String;
    /// Map a UI model id to this harness's model selector (None ⇒ the harness's own default).
    fn model_flag(&self, model: &str) -> Option<String>;
    /// The shell wrapper function the session installs so both the auto-launch and user-typed runs
    /// emit state markers and pick up the default model. `model_flag` is the resolved alias.
    fn shell_fn(&self, model_flag: Option<&str>) -> String;
    /// Whether `launch` starts this harness's CLI — gates the degraded non-bash replay path.
    fn is_harness_launch(&self, launch: &str) -> bool;
    /// Harness-specific pre-launch host setup (no-op for harnesses without it): self-heal/prepare
    /// the harness's global config before a session can launch.
    fn prepare_config(&self);
    /// Harness-specific pre-launch host setup (no-op for harnesses without it): pre-accept any
    /// folder-trust gate the harness would otherwise block on for `cwd`.
    fn trust_dir(&self, cwd: &str);
}

/// Adapter for Claude Code (the `claude` CLI) — the default, full-parity harness.
pub struct ClaudeCodeAdapter;

impl HarnessAdapter for ClaudeCodeAdapter {
    fn detect_history(&self, cwd: &str) -> bool {
        crate::has_claude_history(cwd)
    }

    fn launch_command(&self, prompt: &str, resume: bool) -> String {
        crate::claude_launch(prompt, resume)
    }

    fn model_flag(&self, model: &str) -> Option<String> {
        crate::claude_model_flag(model).map(|s| s.to_string())
    }

    fn shell_fn(&self, model_flag: Option<&str>) -> String {
        // The `claude()` wrapper: emits the run/idle OSC markers AND injects the session's default
        // model, so both the auto-launch and anything the user types pick it up. The injection is
        // skipped when the call already carries `--model` (whole-word match, so prompt text
        // containing the string can't trip it).
        match model_flag {
            Some(m) => format!(
                "claude() {{ __bsc_state run; case \" $* \" in *\" --model \"*) command claude \"$@\";; *) command claude --model {m} \"$@\";; esac; }}; "
            ),
            None => "claude() { __bsc_state run; command claude \"$@\"; }; ".to_string(),
        }
    }

    fn is_harness_launch(&self, launch: &str) -> bool {
        launch.contains("claude")
    }

    fn prepare_config(&self) {
        crate::session::claude_config::sanitize_claude_config();
    }

    fn trust_dir(&self, cwd: &str) {
        crate::session::claude_config::trust_claude_dir(cwd);
    }
}

/// Adapter for `bsc-agent` (the model-agnostic agent runtime, #1078 P2/P3). Launched via the
/// `$BSC_AGENT_BIN` sidecar (mirroring `$BSC_PLAN_BIN`); provider/model/permissions come from
/// `BSC_AGENT_*` env, not CLI flags — so there's no `--model` injection and no global config or
/// folder-trust gate to prepare.
pub struct BscAgentAdapter;

impl HarnessAdapter for BscAgentAdapter {
    fn detect_history(&self, cwd: &str) -> bool {
        // A resumable conversation exists when the per-cwd session file is present + non-empty
        // (the app keys + persists it; see `bsc_agent_session_path`). (#1144)
        crate::has_bsc_agent_history(cwd)
    }

    fn launch_command(&self, prompt: &str, resume: bool) -> String {
        // The `bsc-agent` shell name resolves to the sidecar via `$BSC_AGENT_BIN` (see shell_fn).
        // `--continue` resumes the prior conversation (path via $BSC_AGENT_SESSION), mirroring
        // `claude --continue`; the flag must precede the baked prompt. (#1144)
        let flag = if resume { "--continue " } else { "" };
        format!("bsc-agent {flag}{}", crate::bash_ansi_c_quote(prompt))
    }

    fn model_flag(&self, _model: &str) -> Option<String> {
        None // the model is selected via $BSC_AGENT_MODEL, not a CLI flag
    }

    fn shell_fn(&self, _model_flag: Option<&str>) -> String {
        // Emit the run-state marker (so the pane's run/idle indicator works) and resolve the
        // sidecar via $BSC_AGENT_BIN. No `--model` injection — model comes from env.
        "bsc-agent() { __bsc_state run; \"${BSC_AGENT_BIN:-bsc-agent}\" \"$@\"; }; ".to_string()
    }

    fn is_harness_launch(&self, launch: &str) -> bool {
        launch.contains("bsc-agent")
    }

    fn prepare_config(&self) {} // no global config to self-heal

    fn trust_dir(&self, _cwd: &str) {} // no folder-trust prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_command_matches_free_fn() {
        let a = ClaudeCodeAdapter;
        assert_eq!(a.launch_command("hi", false), crate::claude_launch("hi", false));
        assert_eq!(a.launch_command("hi", true), crate::claude_launch("hi", true));
        // sanity: resume adds --continue, fresh does not.
        assert!(a.launch_command("hi", true).contains("--continue"));
        assert!(!a.launch_command("hi", false).contains("--continue"));
    }

    #[test]
    fn model_flag_maps_known_and_rejects_unknown() {
        let a = ClaudeCodeAdapter;
        assert_eq!(a.model_flag("haiku-4.5").as_deref(), Some("haiku"));
        assert_eq!(a.model_flag("sonnet-4.5").as_deref(), Some("sonnet"));
        assert_eq!(a.model_flag("opus-4.5").as_deref(), Some("opus"));
        assert_eq!(a.model_flag("gpt-5"), None);
    }

    #[test]
    fn shell_fn_injects_model_only_when_set() {
        let a = ClaudeCodeAdapter;
        let with = a.shell_fn(Some("sonnet"));
        assert!(with.contains("--model sonnet"));
        assert!(with.contains("__bsc_state run"));
        let without = a.shell_fn(None);
        assert!(!without.contains("--model"));
        assert!(without.contains("__bsc_state run"));
    }

    #[test]
    fn is_harness_launch_detects_claude() {
        let a = ClaudeCodeAdapter;
        assert!(a.is_harness_launch("claude --continue $'hi'"));
        assert!(!a.is_harness_launch("aider --foo"));
    }

    #[test]
    fn bsc_agent_launch_bakes_prompt_and_has_no_model_flag() {
        let a = BscAgentAdapter;
        let cmd = a.launch_command("do the thing", false);
        assert!(cmd.starts_with("bsc-agent "));
        assert_eq!(cmd, format!("bsc-agent {}", crate::bash_ansi_c_quote("do the thing")));
        assert!(!cmd.contains("--continue"));
        // Resume prepends --continue before the baked prompt.
        let resumed = a.launch_command("do the thing", true);
        assert_eq!(resumed, format!("bsc-agent --continue {}", crate::bash_ansi_c_quote("do the thing")));
        assert_eq!(a.model_flag("gpt-5"), None);
    }

    #[test]
    fn bsc_agent_shell_fn_resolves_sidecar_and_marks_run() {
        let s = BscAgentAdapter.shell_fn(None);
        assert!(s.contains("BSC_AGENT_BIN"));
        assert!(s.contains("__bsc_state run"));
        assert!(!s.contains("--model"));
    }

    #[test]
    fn bsc_agent_is_harness_launch() {
        let a = BscAgentAdapter;
        assert!(a.is_harness_launch("bsc-agent $'hi'"));
        assert!(!a.is_harness_launch("claude $'hi'"));
    }
}
