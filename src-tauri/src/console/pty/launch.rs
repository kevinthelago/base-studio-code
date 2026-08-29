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

/// The shell rc a SANDBOXED session sources — the coordination emitters its protocol names.
///
/// The worker protocol tells an agent to run `bsc-ask`, `bsc-note`, `bsc-maintain` and friends.
/// Inside a namespace those do not exist: they are functions from `bsc-env.sh`, reached through
/// `BASH_ENV`, which is neither set nor bound. And because the protocol PIPES into them
/// (`echo "…" | bsc-ask`), their absence does not surface as "command not found" — it HANGS, with
/// the writer waiting on a reader that never exists.
///
/// This ships as a FILE the cage sources rather than inline shell in the init line, because that
/// line goes to a PTY in canonical mode and Linux truncates it past 4096 bytes.
///
/// The contract is `bsc_storefs::coord`'s: the FILENAME is the verb, the CONTENTS are the message.
/// `note` and `checkpoint` are deliberately NOT coordination verbs — they are local provenance, so
/// they append beside the outbox instead of being emitted and rejected as an unknown verb.
pub(super) fn sandbox_emitter_rc() -> String {
    let mut e = String::from(
        "# Coordination emitters for a sandboxed session (see console::pty::launch).\n\
         __bsc_emit() { local v=\"$1\"; shift; local m=\"$*\"; \
         if [ -z \"$m\" ]; then m=\"$(cat)\"; fi; \
         if ! mkdir -p /coord/out 2>/dev/null; then \
         echo \"bsc: no coordination outbox at /coord/out\" >&2; return 1; fi; \
         printf '%s' \"$m\" > \"/coord/out/$v.$$\"; }\n",
    );
    for v in [
        "ask", "answer", "assign", "brief", "closed", "commission", "deliver", "failed", "fork",
        "issue", "landed", "maintain", "merged", "request", "waiting", "woke",
    ] {
        e.push_str(&format!("bsc-{v}() {{ __bsc_emit {v} \"$@\"; }}\n"));
    }
    e.push_str(
        "bsc-note() { local m=\"$*\"; if [ -z \"$m\" ]; then m=\"$(cat)\"; fi; \
         mkdir -p /coord/out 2>/dev/null; printf '%s\\n' \"$m\" >> /coord/out/.notes; }\n\
         bsc-checkpoint() { bsc-note \"$@\"; }\n",
    );
    e
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
/// `sandboxed` means this session runs inside a mount namespace, so every path it can see is a
/// GUEST path — which is why it suppresses the cwd report. See the `osc7` binding below.
/// Strip what could escape a double-quoted bash word. The reasons are ours, not user input, but a
/// path is interpolated into one and a message that broke the init line would take the whole session
/// with it — a 4096-byte truncation already did exactly that once.
fn shell_safe(s: &str) -> String {
    // By CODE POINT, not char literals: a quote, a backslash and a backtick in one Rust expression
    // is exactly the shape that gets mangled passing through a shell — it did, twice, writing this.
    const UNSAFE: [char; 4] = [
        char::from_u32(34).unwrap(),
        char::from_u32(92).unwrap(),
        char::from_u32(36).unwrap(),
        char::from_u32(96).unwrap(),
    ];
    s.chars().filter(|c| !UNSAFE.contains(c)).collect()
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_bash_init_line(
    cwd: &str,
    cwd_missing: bool,
    effective_cwd: &str,
    launch: Option<&str>,
    claude_fn: &str,
    rc_bash: &str,
    sandboxed: bool,
    // Why a REQUESTED sandbox was refused, if it was. `None` covers both "it is sandboxed" and
    // "it was never going to be" — a pane with no role gets no notice, because there is nothing to say.
    sandbox_refused: Option<&str>,
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
        // A refused cage is a DOWNGRADE, not a failure: the session still launches, so this prints
        // alongside the agent rather than replacing it (unlike `cwd_missing`, which stops the agent
        // because starting one in the wrong directory is worse than not starting it).
        //
        // It prints in the pane because the log is not where anyone is looking. The refusal was an
        // app-log ERROR and nothing else, so a maintainer applied a Worker persona to two panes,
        // relaunched several times, and each launch silently produced an ordinary shell with no
        // explanation — three exchanges spent on a condition the app had already decided.
        let notice = sandbox_refused
            .map(|why| {
                format!(
                    "; printf '[1;33m[bsc] NOT sandboxed: %s[0m\\n' \"{}\"",
                    shell_safe(why)
                )
            })
            .unwrap_or_default();
        format!("{notice}{}", launch.map(|s| format!("; {}", s)).unwrap_or_default())
    };
    // Explicit cd after .bashrc runs so any `cd ~` in .bashrc doesn't win.
    // Uses a bash-compatible POSIX path so Git Bash on Windows handles it.
    let cd_prefix = if sandboxed {
        // NOTHING. bwrap's `--chdir` has already put the shell at `bsc_sandbox::REPO_GUEST_PATH`,
        // and `cwd` is a HOST path that exists nowhere inside the cage — so the cd could only fail,
        // silently, on every caged launch. It was harmless purely by accident: the shell was in the
        // right place because of `--chdir`, not because of this line. An always-failing step that
        // says nothing is what makes the NEXT cage bug hard to read, and it leaked the host's
        // directory layout into the guest for nothing.
        String::new()
    } else if cwd.is_empty() {
        String::new()
    } else if cwd_missing {
        // Sit in the nearest existing ancestor (not $HOME); the warning prints post-clear (above).
        format!("cd \"{}\" 2>/dev/null; ", to_bash_path(effective_cwd))
    } else {
        format!("cd \"{}\" 2>/dev/null; ", to_bash_path(cwd))
    };
    // The coordination emitters live in an rc bound into the cage, NOT inline here.
    //
    // The init line is written to a PTY in CANONICAL MODE, where Linux truncates a line past
    // 4096 bytes. Inlining these alongside a ~3 KB agent kickoff produced a 4332-byte line: cut
    // mid-string, unterminated quote, shell parked at its `>` continuation prompt, agent never
    // launched. A `source` costs twenty characters however large the helpers grow — which is
    // exactly why `bsc-env.sh` is a file for an unsandboxed session.
    let emitters = if sandboxed {
        format!("source \"{}\" 2>/dev/null; ", bsc_sandbox::RC_GUEST_PATH)
    } else {
        String::new()
    };
    // Source the checkpoint helper into the interactive shell too: BASH_ENV only
    // covers non-interactive subshells (the agent's Bash tool), so a human typing
    // `bsc-checkpoint` in the console pane would otherwise not have it.
    // ...and NOT for a namespaced session, where `rc_bash` is `~/.base-studio-code/bsc-env.sh` — a
    // second host-only path, invisible in the cage, failing exactly as silently as the cd did. The
    // caged session's helpers come from the guest rc bound at `RC_GUEST_PATH`, sourced above; there
    // is nothing here for it to add.
    let helpers_src = if sandboxed {
        String::new()
    } else {
        format!("source \"{}\" 2>/dev/null; ", rc_bash)
    };
    // #3937: an inert warning shell must NOT report its cwd. `__bsc_osc7` echoes `$(pwd)`, which the
    // frontend writes straight back into `paneCwds` — so a session sitting in the fallback ancestor
    // OVERWRITES the pane's configured cwd with that ancestor. For a fleet worker that ancestor is
    // `worktrees/<key>`, the parent of EVERY worktree: the stored cwd then both exists and is wrong, so
    // `cwd_missing` reads false on every later launch, the warning vanishes, and the agent really does
    // start in the app's own data directory with no repo and no role gate. Self-corrupting and
    // unrecoverable, since nothing re-derives the path afterwards. Withholding the report keeps the
    // configured cwd intact, so the pane fixes itself the moment its worktree is back.
    // ...and a SANDBOXED session must not report its cwd either, for the same reason with a
    // different cause. Inside a mount namespace the worktree is bound at `/repo`, so `$(pwd)` is a
    // GUEST path — meaningless on the host by construction, not merely unexpected. Reporting it
    // overwrote the pane's configured cwd with `/repo`, and the NEXT launch then tried to bind a
    // host path that does not exist and died on the spot: a first launch that works and every one
    // after it failing. Observed, not theorised — `paneCwds` really did end up `{"…": "/repo"}`.
    let osc7 = if cwd_missing || sandboxed { "" } else { "__bsc_osc7; " };
    format!(
        "{cd_prefix}__bsc_osc7() {{ printf $'\\033]7;file://localhost%s\\a' \"$(pwd)\"; }}; \
         __bsc_state() {{ printf $'\\033]100;%s\\a' \"$1\"; }}; \
         {claude_fn}\
         {emitters}\
         {helpers_src}\
         PROMPT_COMMAND=\"${{PROMPT_COMMAND:+$PROMPT_COMMAND; }}{osc7}__bsc_state idle\"; \
         {osc7}__bsc_state idle; printf '\\033[2J\\033[3J\\033[H'{init_suffix}\n"
    )
}

#[cfg(test)]
mod tests {
    // The init line goes to a PTY in CANONICAL MODE, where Linux truncates past 4096 bytes.
    // Inlining the emitters alongside a ~3 KB agent kickoff produced a 4332-byte line: cut
    // mid-string, unterminated quote, shell parked at `>`, agent never launched. Measured from a
    // real session's raw output. So the helpers travel as a FILE and the line just sources it.
    // ── a refused cage says so IN THE PANE (a-refused-cage-says-so-in-the-pane) ────────────────
    //
    // The refusal was an app-log ERROR and nothing else. A maintainer applied the Worker persona to
    // two panes, relaunched several times, and every launch produced an ordinary uncaged shell with
    // no /plan, no /ui and no explanation — three exchanges spent on a condition the app had already
    // decided. New panes default to $HOME, so this is the DEFAULT path, not a corner case.

    /// A caged session's init line must contain NO host-only path.
    ///
    /// Both leaks were silent by construction — `cd "<host cwd>" 2>/dev/null` and
    /// `source "<host bsc-env.sh>" 2>/dev/null` — so each failed on every caged launch and said
    /// nothing. The cd was harmless only by accident: bwrap's `--chdir` had already put the shell
    /// at /repo, so the shell was correct because of the launcher, not because of this line.
    ///
    /// Asserted as "the host paths are absent" rather than "the line looks like X": what makes
    /// this a bug is a path the guest cannot resolve, whatever else the line grows later.
    #[test]
    fn a_caged_init_line_carries_no_host_path() {
        let host_cwd = "/home/u/.base-studio-code/projects/demoproj";
        let host_rc = "/home/u/.base-studio-code/bsc-env.sh";
        let line = super::build_bash_init_line(
            host_cwd, false, host_cwd, Some("claude $'go'"), "claude() { :; }; ", host_rc, true, None,
        );

        assert!(!line.contains(host_cwd), "the cwd is a HOST path; bwrap --chdir already set it: {line}");
        assert!(!line.contains(host_rc), "the host rc does not exist in the cage: {line}");
        assert!(!line.contains("cd \""), "no cd at all for a caged session: {line}");

        // What must SURVIVE: the guest rc carries the coordination emitters, and it is sourced
        // exactly once — the acceptance criterion this item names.
        let guest = format!("source \"{}\"", bsc_sandbox::RC_GUEST_PATH);
        assert_eq!(line.matches(&guest).count(), 1, "the guest rc, exactly once: {line}");
        assert!(line.contains("claude $'go'"), "and the session still launches: {line}");
    }

    /// The UNCAGED line is untouched — it needs both, and dropping either there would be the real
    /// regression. Pinned beside the caged case so the two cannot drift apart.
    #[test]
    fn an_uncaged_init_line_still_cds_and_sources_the_host_rc() {
        let line = super::build_bash_init_line(
            "/home/u/wt", false, "/home/u/wt", Some("claude"), "", "/home/u/.base-studio-code/bsc-env.sh", false, None,
        );
        assert!(line.starts_with("cd \"/home/u/wt\" 2>/dev/null; "), "{line}");
        assert!(line.contains("source \"/home/u/.base-studio-code/bsc-env.sh\""), "{line}");
    }

    #[test]
    fn a_refused_sandbox_prints_why_where_the_user_is_looking() {
        let line = super::build_bash_init_line(
            "/home/u", false, "/home/u", Some("claude"), "", "/rc", false,
            Some("this pane's directory is your HOME (/home/u). Point it at a worktree."),
        );
        assert!(line.contains("NOT sandboxed"), "the downgrade must be visible: {line}");
        assert!(line.contains("/home/u"), "and must name the actual directory: {line}");
        // A refused cage is a DOWNGRADE, not a failure — the agent still starts, unlike `cwd_missing`.
        assert!(line.contains("claude"), "the session must still launch: {line}");
    }

    /// The init line is ONE line, and the refusal notice is the only thing that ever put a second
    /// one in it. `build_bash_init_line`'s output is written to a PTY in CANONICAL MODE, so a raw
    /// newline does not format anything — it ENDS the command. The refusal notice shipped with a
    /// literal newline inside its printf format string, which bash read as two commands: the first
    /// with an unterminated single quote, so the shell parked at its `>` continuation prompt and the
    /// agent never launched. Every existing test still passed, because `contains("NOT sandboxed")`
    /// is true of a broken line too and the escaping test read only `.split("\n").next()`.
    ///
    /// Asserted over the WHOLE line rather than the notice: any future addition to this string is
    /// covered by the same guard, which is the property that actually matters.
    #[test]
    fn the_init_line_is_a_single_line_even_when_a_refusal_is_printed() {
        let line = super::build_bash_init_line(
            "/home/u", false, "/home/u", Some("claude"), "", "/rc", false,
            Some("this pane's directory is your HOME (/home/u). Point it at a worktree."),
        );
        assert_eq!(
            line.matches('\n').count(),
            1,
            "the init line must contain exactly one newline — its terminator: {line:?}"
        );
        assert!(line.ends_with('\n'), "and that newline must be the LAST byte: {line:?}");
        // The notice must still actually print a newline — as the two-character escape printf reads,
        // not as a raw one. Losing it would run the launch output onto the notice's line.
        assert!(line.contains(r"[0m\n' "), "the notice ends in an ESCAPED newline: {line}");
    }

    #[test]
    fn a_session_that_was_never_going_to_be_caged_says_nothing() {
        // Silence is correct here: a pane with no role never asked for isolation, so a notice would
        // be noise. `None` covers both that and "it IS sandboxed".
        let line = super::build_bash_init_line(
            "/home/u/wt", false, "/home/u/wt", Some("claude"), "", "/rc", false, None,
        );
        assert!(!line.contains("NOT sandboxed"), "no notice without a refusal: {line}");
    }

    #[test]
    fn a_refusal_reason_cannot_break_out_of_the_init_line() {
        // The reason is ours, but a PATH is interpolated into it, and a broken init line takes the
        // whole session with it — a 4096-byte truncation already did exactly that once.
        let nasty = format!("home {}{} {} x", char::from_u32(34).unwrap(), char::from_u32(96).unwrap(), char::from_u32(36).unwrap());
        let line = super::build_bash_init_line(
            "/home/u", false, "/home/u", Some("claude"), "", "/rc", false, Some(&nasty),
        );
        // Check the INTERPOLATED REASON, not the whole notice: the notice legitimately contains the
        // double quotes that wrap the argument, so asserting over it forbids our own escaping.
        //
        // This read the first line only until the literal-newline bug was fixed — and that newline fell
        // BEFORE the reason, so the assertion never once examined the text it exists to check. It passed
        // for the entire life of the notice while checking nothing.
        let arg = line.split("\\n' \"").nth(1).unwrap_or("");
        let reason = arg.split(char::from_u32(34).unwrap()).next().unwrap_or("");
        assert!(reason.contains("home"), "the reason must actually be found, not silently missed: {line:?}");
        for bad in [
            char::from_u32(34).unwrap(),
            char::from_u32(92).unwrap(),
            char::from_u32(36).unwrap(),
            char::from_u32(96).unwrap(),
        ] {
            assert!(!reason.contains(bad), "unescaped {bad:?} in the reason: {reason:?}");
        }
    }

    #[test]
    fn the_sandboxed_init_line_stays_far_under_the_tty_line_limit() {
        let kickoff = "x".repeat(3000); // a realistic agent kickoff
        let line = super::build_bash_init_line(
            "/home/u/wt/repo", false, "/home/u/wt/repo", Some(&kickoff),
            "claude() { :; }; ", "/rc.sh", true, None);
        let longest = line.lines().map(str::len).max().unwrap_or(0);
        assert!(longest < 4096, "a canonical-mode line is truncated past 4096: {longest}");
        // And the emitters are reached by SOURCE, not by inlining them into that line.
        assert!(line.contains("source \"/bsc-rc\""), "the rc is sourced: {line}");
        assert!(!line.contains("__bsc_emit"), "and NOT inlined: {line}");
    }

    #[test]
    fn the_emitter_rc_defines_what_the_protocol_names() {
        let rc = super::sandbox_emitter_rc();
        for verb in ["ask", "maintain", "landed", "assign"] {
            assert!(rc.contains(&format!("bsc-{verb}()")), "bsc-{verb} must exist: {rc}");
        }
        // note/checkpoint are local provenance, not coordination verbs — emitting them would be
        // rejected as unknown, so they append beside the outbox.
        assert!(rc.contains("bsc-note()") && rc.contains("bsc-checkpoint()"));
        assert!(rc.contains("/coord/out/"), "the contract is filename-is-the-verb: {rc}");
    }

    // A SANDBOXED session must not report its cwd. Inside a mount namespace `$(pwd)` is a GUEST
    // path (`/repo`), and the frontend writes the reported cwd straight back into `paneCwds` — so
    // reporting it overwrote the pane's HOST cwd with `/repo`, and the next launch tried to bind a
    // host path that does not exist and died instantly. Observed: `paneCwds` really did become
    // `{"nsdemo:worker": "/repo"}`. Same failure #3937 fixed for the inert warning shell, reached
    // by a different route, so it needs its own guard.
    #[test]
    fn a_sandboxed_session_does_not_report_its_guest_cwd() {
        let sandboxed = super::build_bash_init_line(
            "/home/u/wt/repo", false, "/home/u/wt/repo", None, "", "/rc.sh", true, None);
        assert!(!sandboxed.contains("__bsc_osc7; "), "no cwd report inside a namespace: {sandboxed}");
        // The helper itself is still DEFINED — only the reporting call is withheld, so anything
        // else referencing it keeps working.
        assert!(sandboxed.contains("__bsc_osc7() {"));
        // ...and an ordinary session still reports, or the pane would never learn its cwd at all.
        let normal = super::build_bash_init_line(
            "/home/u/wt/repo", false, "/home/u/wt/repo", None, "", "/rc.sh", false, None);
        assert!(normal.contains("__bsc_osc7; "), "an unsandboxed session still reports: {normal}");
    }

    use super::{build_bash_init_line, plan_launch, LaunchPlan};

    const INIT: &str = "claude --continue 2>/dev/null || claude";

    #[test]
    fn build_bash_init_line_cds_installs_markers_and_appends_launch() {
        let line = build_bash_init_line(
            "/home/u/projects/acme", false, "/home/u/projects/acme",
            Some("claude --continue"), "claude() { :; }; ", "/home/u/.base-studio-code/bsc-env.sh",
            false, None);
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
        let line = build_bash_init_line("", false, "", None, "claude() { :; }; ", "/rc.sh", false, None);
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
            false, None);
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
            false, None);
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

    /// THE OBSERVED SHAPE (#a-session-with-history-always-resumes), pinned so the half of the rule
    /// that did NOT change cannot drift: the app starts nothing on its own.
    ///
    /// This is the literal line the live app logged three times while a worker sat on a bare
    /// `bash-5.2$` with five conversations in its cage:
    ///
    ///     launch decision · has_history=true · resumed=false
    ///     created · … · init=<none>
    ///
    /// (That line spells the field `launch=` now. It used to print `init_cmd`, which is empty
    /// whenever the launch is a baked startup prompt — so a resumed worker logged `init=<none>`
    /// while really running `claude --continue $'…'`, and the log denied that anything had been
    /// launched at all. Here the `<none>` was true; the point is that it could not be trusted.)
    ///
    /// It is CORRECT here and must stay correct — a mount with nothing to launch is a shell, per
    /// `only-the-user-resumes-a-session`. What was wrong lived upstream, in the frontend deciding
    /// there was nothing to launch: `resolveInitCmd` handed back "" for a pane that was being
    /// resumed, because the bare `claude` placeholder outranked the resume. Fixing it here instead —
    /// by resuming on `has_history` alone — would have made the app start sessions by itself, and
    /// would have resumed a STRANGER'S conversation for a per-request debug session, whose cwd is a
    /// shared repo and whose `paneContinue` is deliberately false (#3497).
    #[test]
    fn an_empty_launch_stays_a_bare_shell_even_with_history() {
        assert_eq!(plan_launch(None, Some(""), true, false, false), LaunchPlan::None);
        assert_eq!(plan_launch(None, None, true, true, false), LaunchPlan::None);
    }

    /// #3937: the fallback shell must NOT report its cwd. `__bsc_osc7` echoes `$(pwd)`, the frontend
    /// writes that straight back into `paneCwds`, and for a fleet worker the fallback ancestor is
    /// `worktrees/<key>` — the parent of every worktree. Reporting it overwrites the pane's real,
    /// merely-missing path with one that EXISTS and is wrong, after which `cwd_missing` reads false
    /// forever and the agent genuinely launches in the app's data dir with no repo and no role gate.
    #[test]
    fn a_missing_cwd_shell_never_reports_its_fallback_dir() {
        let line = build_bash_init_line("/c/gone/networkmonitor--auth", true, "/c/gone", Some(INIT), "", "/rc", false, None);
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
        let line = build_bash_init_line("/c/wt/networkmonitor--auth", false, "/c/wt/networkmonitor--auth", Some(INIT), "", "/rc", false, None);
        assert!(line.contains("}__bsc_osc7; __bsc_state idle\""), "PROMPT_COMMAND reports the cwd: {line}");
        assert!(line.contains("__bsc_osc7; __bsc_state idle; printf"), "and reports once up front: {line}");
    }

    /// #3938: `2J` alone pushes the erased rows into xterm.js's SCROLLBACK, so every session opened
    /// with a screenful of blank lines above the prompt and the first real line scrolled far up.
    /// `3J` drops the scrollback as well.
    #[test]
    fn the_screen_clear_also_clears_scrollback() {
        let line = build_bash_init_line("/c/wt/x", false, "/c/wt/x", Some(INIT), "", "/rc", false, None);
        assert!(line.contains("printf '\\033[2J\\033[3J\\033[H'"), "clears screen AND scrollback: {line}");
    }
}
