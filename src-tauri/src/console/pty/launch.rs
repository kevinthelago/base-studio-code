// What a session auto-launches and the bash init line it starts with: the pure
// `LaunchPlan` decision (`plan_launch`) and the bash init-line builder
// (`build_bash_init_line`). Split out of `mod.rs` (#1864) so `pty_create` stays
// readable orchestration; behavior is unchanged.

use crate::to_bash_path;

/// What a session should auto-launch (#1240). Pure so the fresh-only intro suppression is testable
/// without a PTY or a harness.
#[derive(Debug, PartialEq)]
pub(crate) enum LaunchPlan {
    /// Bake the startup prompt as claude's initial message (`resume` ⇒ launch with `--continue`).
    Prompt { resume: bool },
    /// Run a literal init command (e.g. `claude --continue || claude`).
    Init(String),
    /// Nothing to auto-launch — a bare shell.
    None,
}

/// Decide what a session launches. A non-empty `startup_prompt` wins and is baked as claude's first
/// message — UNLESS it is `fresh_only` and a prior conversation exists, in which case a resumed
/// session must NOT be re-greeted (#1240): fall through to `init_cmd` (e.g. `claude --continue ||
/// claude`) so the user resumes quietly. `resume` (add `--continue`) holds only when the caller
/// opted in AND there's actually history to continue.
pub(crate) fn plan_launch(
    startup_prompt: Option<&str>,
    init_cmd: Option<&str>,
    has_history: bool,
    continue_session: bool,
    fresh_only: bool,
) -> LaunchPlan {
    let suppress = fresh_only && has_history;
    match startup_prompt.filter(|s| !s.is_empty() && !suppress) {
        Some(_) => LaunchPlan::Prompt { resume: continue_session && has_history },
        None => match init_cmd.filter(|s| !s.is_empty()) {
            Some(s) => LaunchPlan::Init(s.to_string()),
            None => LaunchPlan::None,
        },
    }
}

/// Build the bash init line written into a freshly opened Git-Bash PTY: `cd` into the session cwd
/// (a loud red warning + nearest-existing-ancestor fallback when it's `cwd_missing`, nothing when
/// `cwd` is empty), install the OSC-7 cwd + `__bsc_state` run/idle markers and the `claude()`
/// wrapper (`claude_fn`), source the bsc-* helpers from `rc_bash` into the interactive shell,
/// wire `PROMPT_COMMAND`, clear the screen AND its scrollback (`3J`, #3938 — `2J` alone pushes the erased
/// rows into scrollback, leaving a screenful of blank lines above the prompt), and append the optional
/// `launch` command — EXCEPT when
/// the cwd is missing (#2438): the launch is suppressed, since it would start the agent in the
/// fallback ancestor (for a fleet worktree that's the parent of EVERY worktree) with no role gate
/// (`ensure_session_settings` wrote into the missing configured path), and the agent's TUI would
/// clear the warning off screen. Pure (no fs/env) so the exact wire string is unit-testable;
/// `to_bash_path` is a no-op off Windows.
pub(super) fn build_bash_init_line(
    cwd: &str,
    cwd_missing: bool,
    effective_cwd: &str,
    launch: Option<&str>,
    claude_fn: &str,
    rc_bash: &str,
) -> String {
    // The suffix runs AFTER the final screen clear, so it's what the user actually sees: the launch
    // command normally, or — when the configured cwd is gone — the red warning as an inert shell's
    // banner (printing it any earlier gets wiped by the clear; launching anyway would start the agent
    // in the fallback ancestor, ungated).
    let init_suffix = if cwd_missing {
        format!(
            "; printf '\\033[1;31m[bsc] WARNING: configured directory %s does not exist; this session did NOT start in its project directory and the agent was NOT started. Relaunch the fleet to recreate the worktree, or remove this pane.\\033[0m\\n' \"{disp}\"",
            disp = to_bash_path(cwd),
        )
    } else {
        launch.map(|s| format!("; {}", s)).unwrap_or_default()
    };
    // Explicit cd after .bashrc runs so any `cd ~` in .bashrc doesn't win.
    // Uses a bash-compatible POSIX path so Git Bash on Windows handles it.
    let cd_prefix = if cwd.is_empty() {
        String::new()
    } else if cwd_missing {
        // Sit in the nearest existing ancestor (not $HOME); the warning prints post-clear (above).
        format!("cd \"{}\" 2>/dev/null; ", to_bash_path(effective_cwd))
    } else {
        format!("cd \"{}\" 2>/dev/null; ", to_bash_path(cwd))
    };
    // Source the checkpoint helper into the interactive shell too: BASH_ENV only
    // covers non-interactive subshells (the agent's Bash tool), so a human typing
    // `bsc-checkpoint` in the console pane would otherwise not have it.
    let helpers_src = format!("source \"{}\" 2>/dev/null; ", rc_bash);
    // #3937: an inert warning shell must NOT report its cwd. `__bsc_osc7` echoes `$(pwd)`, which the
    // frontend writes straight back into `paneCwds` — so a session sitting in the fallback ancestor
    // OVERWRITES the pane's configured cwd with that ancestor. For a fleet worker that ancestor is
    // `worktrees/<key>`, the parent of EVERY worktree: the stored cwd then both exists and is wrong, so
    // `cwd_missing` reads false on every later launch, the warning vanishes, and the agent really does
    // start in the app's own data directory with no repo and no role gate. Self-corrupting and
    // unrecoverable, since nothing re-derives the path afterwards. Withholding the report keeps the
    // configured cwd intact, so the pane fixes itself the moment its worktree is back.
    let osc7 = if cwd_missing { "" } else { "__bsc_osc7; " };
    format!(
        "{cd_prefix}__bsc_osc7() {{ printf $'\\033]7;file://localhost%s\\a' \"$(pwd)\"; }}; \
         __bsc_state() {{ printf $'\\033]100;%s\\a' \"$1\"; }}; \
         {claude_fn}\
         {helpers_src}\
         PROMPT_COMMAND=\"${{PROMPT_COMMAND:+$PROMPT_COMMAND; }}{osc7}__bsc_state idle\"; \
         {osc7}__bsc_state idle; printf '\\033[2J\\033[3J\\033[H'{init_suffix}\n"
    )
}

#[cfg(test)]
mod tests {
    use super::{build_bash_init_line, plan_launch, LaunchPlan};

    const INIT: &str = "claude --continue 2>/dev/null || claude";

    #[test]
    fn build_bash_init_line_cds_installs_markers_and_appends_launch() {
        let line = build_bash_init_line(
            "/home/u/projects/acme", false, "/home/u/projects/acme",
            Some("claude --continue"), "claude() { :; }; ", "/home/u/.base-studio-code/bsc-env.sh",
        );
        // cd's into the (bash-form) cwd before anything else, sources the helpers, and appends the
        // launch as a `; <launch>` suffix; the whole line is one trailing-newline-terminated command.
        assert!(line.starts_with("cd \"/home/u/projects/acme\" 2>/dev/null; "), "cd prefix first: {line}");
        assert!(line.contains("claude() { :; }; "), "claude() wrapper injected");
        assert!(line.contains("source \"/home/u/.base-studio-code/bsc-env.sh\" 2>/dev/null; "), "helpers sourced");
        assert!(line.contains("__bsc_osc7; __bsc_state idle"), "OSC7 + state markers wired");
        assert!(line.ends_with("printf '\\033[2J\\033[3J\\033[H'; claude --continue\n"), "clear then launch suffix: {line}");
    }

    #[test]
    fn build_bash_init_line_empty_cwd_has_no_cd_and_no_launch_suffix() {
        let line = build_bash_init_line("", false, "", None, "claude() { :; }; ", "/rc.sh");
        assert!(!line.contains("cd \""), "no cd when cwd is empty: {line}");
        // No launch ⇒ the line ends right after the screen clear, no `;` suffix.
        assert!(line.ends_with("printf '\\033[2J\\033[3J\\033[H'\n"), "no launch suffix: {line}");
    }

    #[test]
    fn build_bash_init_line_missing_cwd_warns_and_falls_to_ancestor() {
        // `launch` is Some on purpose: a missing cwd must suppress it anyway (#2438) — launching
        // would start the agent ungated in the fallback ancestor (for a fleet worktree, the parent
        // of EVERY worktree; the role gate was written into the missing configured path).
        let line = build_bash_init_line(
            "/home/u/projects/gone", true, "/home/u/projects",
            Some("claude --continue"), "claude() { :; }; ", "/rc.sh",
        );
        assert!(line.contains("WARNING: configured directory"), "loud warning printed: {line}");
        assert!(line.contains("cd \"/home/u/projects\" 2>/dev/null; "), "cd's into the nearest ancestor: {line}");
        assert!(line.contains("the agent was NOT started"), "warning states the launch suppression: {line}");
        assert!(!line.contains("claude --continue"), "launch suppressed when the cwd is missing: {line}");
        // The warning is the POST-clear suffix — printing it earlier gets wiped by the final
        // `printf '\033[2J\033[3J\033[H'` screen clear (#2438).
        let clear = line.find("printf '\\033[2J\\033[3J\\033[H'").expect("clears the screen");
        let warn = line.find("WARNING").expect("warns");
        assert!(warn > clear, "warning must print after the screen clear: {line}");
    }

    #[test]
    fn build_bash_init_line_reproduces_the_original_inline_string() {
        // Guards the byte-exact extraction (#2067) — one full render locked against the wire format.
        let line = build_bash_init_line(
            "/p", false, "/p", Some("claude"), "CLAUDE_FN;", "/rc",
        );
        assert_eq!(
            line,
            "cd \"/p\" 2>/dev/null; __bsc_osc7() { printf $'\\033]7;file://localhost%s\\a' \"$(pwd)\"; }; \
             __bsc_state() { printf $'\\033]100;%s\\a' \"$1\"; }; \
             CLAUDE_FN;\
             source \"/rc\" 2>/dev/null; \
             PROMPT_COMMAND=\"${PROMPT_COMMAND:+$PROMPT_COMMAND; }__bsc_osc7; __bsc_state idle\"; \
             __bsc_osc7; __bsc_state idle; printf '\\033[2J\\033[3J\\033[H'; claude\n"
        );
    }

    #[test]
    fn plan_launch_fresh_only_fires_the_prompt_when_there_is_no_history() {
        // #1240 planner intro: fresh session (no prior conversation) ⇒ bake the intro, no --continue.
        assert_eq!(
            plan_launch(Some("intro"), Some(INIT), false, false, true),
            LaunchPlan::Prompt { resume: false },
        );
    }

    #[test]
    fn plan_launch_fresh_only_is_suppressed_on_resume_and_falls_to_init() {
        // History exists ⇒ a returning user must NOT be re-greeted; fall to init_cmd (resume quietly).
        assert_eq!(
            plan_launch(Some("intro"), Some(INIT), true, false, true),
            LaunchPlan::Init(INIT.to_string()),
        );
    }

    #[test]
    fn plan_launch_non_fresh_only_prompt_always_fires() {
        // Triage/fleet (fresh_only = false): the prompt fires regardless of history, with --continue
        // when the caller opted into continuation and there's history to continue.
        assert_eq!(
            plan_launch(Some("triage"), Some(INIT), true, true, false),
            LaunchPlan::Prompt { resume: true },
        );
        assert_eq!(
            plan_launch(Some("triage"), Some(INIT), false, true, false),
            LaunchPlan::Prompt { resume: false },
        );
    }

    #[test]
    fn plan_launch_no_prompt_uses_init_then_bare_shell() {
        assert_eq!(plan_launch(None, Some(INIT), true, false, false), LaunchPlan::Init(INIT.to_string()));
        assert_eq!(plan_launch(Some(""), None, false, false, true), LaunchPlan::None);
    }

    /// #3937: the fallback shell must NOT report its cwd. `__bsc_osc7` echoes `$(pwd)`, the frontend
    /// writes that straight back into `paneCwds`, and for a fleet worker the fallback ancestor is
    /// `worktrees/<key>` — the parent of every worktree. Reporting it overwrites the pane's real,
    /// merely-missing path with one that EXISTS and is wrong, after which `cwd_missing` reads false
    /// forever and the agent genuinely launches in the app's data dir with no repo and no role gate.
    #[test]
    fn a_missing_cwd_shell_never_reports_its_fallback_dir() {
        let line = build_bash_init_line("/c/gone/networkmonitor--auth", true, "/c/gone", Some(INIT), "", "/rc");
        assert!(!line.contains("__bsc_osc7; __bsc_state idle"), "no osc7 report when the cwd is missing: {line}");
        assert!(line.contains("PROMPT_COMMAND=\"${PROMPT_COMMAND:+$PROMPT_COMMAND; }__bsc_state idle\""),
            "PROMPT_COMMAND keeps the state marker but drops the cwd report: {line}");
        // The helper is still DEFINED (harmless, and a human can call it) — only the automatic
        // reporting is withheld.
        assert!(line.contains("__bsc_osc7() {"), "the function is still defined: {line}");
    }

    /// The healthy path is unchanged: a real cwd still reports, or the app loses cwd tracking entirely.
    #[test]
    fn a_present_cwd_still_reports_over_osc7() {
        let line = build_bash_init_line("/c/wt/networkmonitor--auth", false, "/c/wt/networkmonitor--auth", Some(INIT), "", "/rc");
        assert!(line.contains("}__bsc_osc7; __bsc_state idle\""), "PROMPT_COMMAND reports the cwd: {line}");
        assert!(line.contains("__bsc_osc7; __bsc_state idle; printf"), "and reports once up front: {line}");
    }

    /// #3938: `2J` alone pushes the erased rows into xterm.js's SCROLLBACK, so every session opened
    /// with a screenful of blank lines above the prompt and the first real line scrolled far up.
    /// `3J` drops the scrollback as well.
    #[test]
    fn the_screen_clear_also_clears_scrollback() {
        let line = build_bash_init_line("/c/wt/x", false, "/c/wt/x", Some(INIT), "", "/rc");
        assert!(line.contains("printf '\\033[2J\\033[3J\\033[H'"), "clears screen AND scrollback: {line}");
    }
}
