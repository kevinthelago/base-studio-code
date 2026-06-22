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
}
