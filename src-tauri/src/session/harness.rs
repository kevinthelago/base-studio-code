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
    /// Whether there is a resumable conversation in an EXPLICIT transcripts directory.
    ///
    /// A sandboxed session's history is not under the host's per-cwd path — the caged harness writes
    /// into its private HOME keyed by the GUEST cwd, and the launcher binds that to a per-pane host
    /// directory. The launcher resolves that path and asks here, rather than every harness having to
    /// know how the cage is wired.
    ///
    /// Defaults to `false`: a harness whose caged transcripts are not durable cannot resume, and
    /// saying so is better than resuming from something that is not there.
    fn detect_history_at(&self, _path: &std::path::Path) -> bool {
        false
    }
    /// WHERE this harness's caged conversation lives on the host, for a pane whose sandbox stores are
    /// rooted at `stores_root`.
    ///
    /// This is on the TRAIT because the layout is harness-specific and the launcher is not. It used to
    /// live in the launcher, hardcoded to Claude's shape (`<root>/home/projects/<slug(/repo)>`), and
    /// every harness was asked that one question. `bsc-agent` keeps a single JSON file under
    /// `<root>/home/bsc-agent/`, so the answer was a directory it never writes to — its
    /// `detect_history_at` then took the `false` default and a caged worker restarted from nothing
    /// with its conversation sitting right there.
    ///
    /// Defaults to `None`: a harness that has not said where its caged history lives cannot resume,
    /// and saying so beats guessing a path and resuming from whatever happens to be at it.
    fn caged_history_path(&self, _stores_root: &std::path::Path) -> Option<std::path::PathBuf> {
        None
    }
    /// The shell command that launches the harness, baking the startup `prompt`.
    ///
    /// WHETHER and WHICH are SEPARATE arguments, and that separation is the whole point. They used to
    /// be one `Option<&str>` — the session id, `None` meaning "do not resume" — which silently
    /// destroyed the resume for any harness that HAS no session ids. `bsc-agent` addresses its
    /// conversation by a PATH, so its id is always `None`, so it was never told to resume and
    /// `--continue` never reached the command line, while the log announced "falling back to
    /// --continue" in the same breath.
    ///
    /// `resume` says whether to continue at all; `resume_id` names which conversation when the
    /// harness has such a name. A harness with an id should prefer it and fall back to its
    /// no-id resume rather than launching fresh.
    fn launch_command(&self, prompt: &str, resume: bool, resume_id: Option<&str>) -> String;
    /// The id of the conversation this harness would resume in `cwd` — `None` when the harness does
    /// not NAME its conversations.
    ///
    /// On the trait because the answer is harness-specific and the launcher is not. It used to be a
    /// bare `claude_config::last_session_id(&cwd)` in `pty_create`, asked of every pane whatever it
    /// was about to run. A studio directory that Claude has ever run in therefore yielded a Claude
    /// UUID for a `bsc-agent` launch, and the `LaunchPlan::Init` arm rewrote `--continue` into
    /// `--resume <that uuid>` — a flag `bsc-agent` does not take, naming a conversation it does not
    /// have.
    ///
    /// Defaults to `None`: a harness that has not said its conversations have names does not get one
    /// invented for it.
    fn resume_id(&self, _cwd: &str) -> Option<String> {
        None
    }
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

    fn detect_history_at(&self, dir: &std::path::Path) -> bool {
        crate::session::launch::dir_holds_a_transcript(dir)
    }

    fn caged_history_path(&self, stores_root: &std::path::Path) -> Option<std::path::PathBuf> {
        Some(crate::session::launch::caged_claude_transcripts_dir(stores_root))
    }

    fn launch_command(&self, prompt: &str, resume: bool, resume_id: Option<&str>) -> String {
        crate::claude_launch(prompt, resume, resume_id)
    }

    fn resume_id(&self, cwd: &str) -> Option<String> {
        // Claude's own `lastSessionId` for this cwd, so a resume follows a `/clear` rather than
        // resurrecting cleared context.
        crate::session::claude_config::last_session_id(cwd)
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

    fn detect_history_at(&self, path: &std::path::Path) -> bool {
        // A FILE, not a directory of transcripts: this harness keeps one JSON conversation, so the
        // Claude rule (`dir_holds_a_transcript`) cannot answer it and the trait's `false` default was
        // what this adapter silently inherited.
        crate::session::launch::file_holds_a_conversation(path)
    }

    fn caged_history_path(&self, stores_root: &std::path::Path) -> Option<std::path::PathBuf> {
        // The same helper the launcher binds through, so the probe cannot ask a path the cage does
        // not actually back — which is exactly how this broke.
        Some(crate::session::launch::caged_agent_conversation_path(stores_root))
    }

    fn launch_command(&self, prompt: &str, resume: bool, _resume_id: Option<&str>) -> String {
        // The `bsc-agent` shell name resolves to the sidecar via `$BSC_AGENT_BIN` (see shell_fn).
        // `--continue` resumes the prior conversation (path via $BSC_AGENT_SESSION); the flag must
        // precede the baked prompt. (#1144)
        //
        // IT TAKES NO SESSION ID AND WANTS NONE: this conversation is addressed by a PATH, so there is
        // nothing to name — which is exactly why the id must not be what decides. When WHETHER and
        // WHICH were one `Option`, this harness's permanently-absent id read as "do not resume" and
        // the flag never reached the command line.
        //
        // THE PROMPT IS REFERENCED, NOT INLINED (`the-startup-prompt-outgrew-the-tty-line-limit`).
        // This string is typed into an interactive shell through a pty, which silently truncates any
        // single line past 4096 bytes — and an inlined `$'…'` prompt that gets cut leaves the quote
        // open, so bash waits at `>` and the agent never starts. `$BSC_STARTUP_PROMPT` is set by
        // `pty_create` from the same value, so the line stays a constant few dozen bytes whatever
        // the prompt's size. Double quotes, so newlines inside it survive as one argument.
        let flag = if resume { "--continue " } else { "" };
        let _ = prompt;
        format!("bsc-agent {flag}\"$BSC_STARTUP_PROMPT\"")
    }

    fn model_flag(&self, _model: &str) -> Option<String> {
        None // the model is selected via $BSC_AGENT_MODEL, not a CLI flag
    }

    fn shell_fn(&self, _model_flag: Option<&str>) -> String {
        // Emit the run-state marker (so the pane's run/idle indicator works) and resolve the
        // sidecar via $BSC_AGENT_BIN. No `--model` injection — model comes from env.
        // `command` IS LOAD-BEARING, and its absence cost every caged worker its life.
        //
        // Bash resolves a bare name to a FUNCTION before it looks at PATH. So when `$BSC_AGENT_BIN`
        // is unset the `:-bsc-agent` fallback names this very function, which calls itself, which
        // falls back again — for ever. Each level emits `__bsc_state run`, so the pane fills with
        // OSC markers until bash exhausts its stack and dies of SIGSEGV. MEASURED on
        // twitter-clone-test:api: ~3.3 s of CPU, ~34 MB, a 1.1 MB scrollback consisting of
        // `]100;run` repeated, and the app reporting `Killed by signal 11` on every single launch.
        //
        // It is invisible whenever the variable IS set — an absolute path is not a function name —
        // which is why every uncaged, app-launched session works and only the CAGE dies: the
        // namespace clears the environment, so a caged worker is the one session that always takes
        // the fallback.
        //
        // `command` bypasses function lookup entirely. The Claude adapter above has always used it;
        // this one simply never did.
        "bsc-agent() { __bsc_state run; command \"${BSC_AGENT_BIN:-bsc-agent}\" \"$@\"; }; ".to_string()
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

    /// THE WRAPPER MUST NOT RE-ENTER ITSELF — run in a real bash, because a string assertion could
    /// not have caught this (#the-bsc-agent-shell-wrapper-recurses-into-itself-and-segfaults-bash).
    ///
    /// The emitted function's fallback used to be its own NAME, and bash resolves a bare name to a
    /// function before the PATH. With `$BSC_AGENT_BIN` unset it called itself for ever, emitting one
    /// `__bsc_state run` marker per level until the stack was gone and bash died of SIGSEGV. On
    /// twitter-clone-test:api that was ~3.3 s of CPU and a 1.1 MB scrollback of `]100;run`, on every
    /// launch, reported as `Killed by signal 11`.
    ///
    /// The cage is where it bit: the namespace clears the environment, so a caged worker is the one
    /// session that always takes the fallback.
    #[cfg(unix)]
    #[test]
    fn the_agent_wrapper_does_not_recurse_when_no_binary_path_is_set() {
        let dir = crate::testutil::unique_dir("bsc-wrapfn", "norecurse");
        std::fs::create_dir_all(&dir).unwrap();
        // A stand-in on PATH, so the *intended* resolution has something real to reach.
        let stub = dir.join("bsc-agent");
        std::fs::write(&stub, "#!/bin/sh\necho REACHED-BINARY\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        let script = format!(
            // A small stack so a recursion dies in milliseconds rather than seconds, and a marker
            // that is countable.
            "ulimit -s 1024; __bsc_state() {{ printf 'M'; }}; {}bsc-agent go",
            BscAgentAdapter.shell_fn(None),
        );
        let out = std::process::Command::new("bash")
            .arg("-c")
            .arg(&script)
            .env("PATH", format!("{}:{}", dir.display(), std::env::var("PATH").unwrap_or_default()))
            .env_remove("BSC_AGENT_BIN") // the cage's condition exactly
            .output()
            .expect("bash runs");
        let _ = std::fs::remove_dir_all(&dir);

        let stdout = String::from_utf8_lossy(&out.stdout);
        // It TERMINATED, and normally — a recursion exits 139 (128 + SIGSEGV).
        assert_eq!(out.status.code(), Some(0), "the wrapper must not blow the stack: {out:?}");
        // It reached the real program rather than itself...
        assert!(stdout.contains("REACHED-BINARY"), "the binary must be reached: {stdout:?}");
        // ...and emitted the run marker EXACTLY ONCE. This is the assertion that fails on the bug:
        // the old wrapper emitted one per recursion level, thousands of them.
        assert_eq!(stdout.matches('M').count(), 1, "one run marker, not one per level: {stdout:?}");
    }

    /// ...and it still honours an explicit path, which is the ordinary app-launched case.
    #[cfg(unix)]
    #[test]
    fn the_agent_wrapper_execs_the_path_it_is_given() {
        let dir = crate::testutil::unique_dir("bsc-wrapfn", "givenpath");
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("staged-agent");
        std::fs::write(&real, "#!/bin/sh\necho STAGED \"$@\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o755)).unwrap();

        let script = format!(
            "__bsc_state() {{ :; }}; {}bsc-agent --continue",
            BscAgentAdapter.shell_fn(None),
        );
        let out = std::process::Command::new("bash")
            .arg("-c")
            .arg(&script)
            .env("BSC_AGENT_BIN", &real)
            .output()
            .expect("bash runs");
        let _ = std::fs::remove_dir_all(&dir);
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("STAGED --continue"), "the given path is execed with its args: {stdout:?}");
    }

    /// THE BUG: a harness with NO session ids lost its resume entirely.
    ///
    /// `bsc-agent` addresses its conversation by a PATH, so its id is permanently `None`. When
    /// WHETHER and WHICH were one `Option`, that read as "do not resume" and `--continue` never
    /// reached the command line — while the launch log announced "falling back to --continue" in the
    /// same breath. Measured: `launch=bsc-agent $'Build the REST API…'`, with `resumed=true` logged.
    #[test]
    fn bsc_agent_resumes_on_the_flag_even_though_it_has_no_session_id() {
        let a = BscAgentAdapter;
        let resumed = a.launch_command("go", true, None);
        assert!(resumed.starts_with("bsc-agent --continue "), "{resumed}");
        assert!(resumed.contains("$BSC_STARTUP_PROMPT"), "the prompt is still carried: {resumed}");

        // An id it can never have must not change the answer either way.
        assert_eq!(a.launch_command("go", true, Some("ignored")), resumed);
        // …and without a resume request there is no flag at all.
        assert!(!a.launch_command("go", false, None).contains("--continue"));
    }

    /// A HARNESS THAT DOES NOT NAME ITS CONVERSATIONS IS NOT HANDED A NAME.
    ///
    /// `resume_id` used to be a bare `claude_config::last_session_id(&cwd)` in `pty_create`, asked of
    /// every pane whatever it was about to run — and `LaunchPlan::Init` rewrites `--continue` into
    /// `--resume <id>` whenever that returns `Some`. A studio directory Claude has ever run in (every
    /// one of them: `~/.base-studio-code/networks/<slug>` is where the architect lives) therefore
    /// handed a Claude UUID to a `bsc-agent --continue`, producing a flag that harness does not take,
    /// naming a conversation it does not have.
    ///
    /// Both adapters are asked about the SAME cwd with a real `~/.claude.json` in place, so the test
    /// can only pass by the two answering differently — a shared `None` from an empty home would be
    /// vacuous.
    #[cfg(unix)]
    #[test]
    fn only_a_harness_that_names_its_conversations_yields_a_resume_id() {
        let _guard = crate::testutil::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = crate::testutil::temp_home("harness-resume-id");
        let cwd = home.join("networks").join("finance");
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd_s = cwd.to_string_lossy().into_owned();
        let id = "bf36a25c-b331-48b0-a78c-3bf4e6b51354";
        crate::testutil::write_file(
            &home.join(".claude.json"),
            &serde_json::json!({ "projects": { &cwd_s: { "lastSessionId": id } } }).to_string(),
        );

        assert_eq!(
            ClaudeCodeAdapter.resume_id(&cwd_s).as_deref(),
            Some(id),
            "claude names its conversations, so it must still find its own id",
        );
        assert_eq!(
            BscAgentAdapter.resume_id(&cwd_s),
            None,
            "bsc-agent addresses its conversation by PATH — a claude UUID is not its to take",
        );
    }

    /// Claude prefers the ID, and falls back to `--continue` rather than starting fresh.
    #[test]
    fn claude_prefers_the_id_but_still_resumes_without_one() {
        let c = ClaudeCodeAdapter;
        let named = c.launch_command("go", true, Some("abc-123"));
        assert!(named.contains("--resume "), "an id is used when known: {named}");
        assert!(!named.contains("--continue"), "and not both: {named}");

        // RESUMING WITHOUT AN ID still resumes. `--continue` takes the newest conversation for this
        // directory — a worse resume than naming one, and far better than silently starting over.
        let unnamed = c.launch_command("go", true, None);
        assert!(unnamed.contains("--continue "), "{unnamed}");

        assert!(!c.launch_command("go", false, None).contains("--continue"));
        assert!(!c.launch_command("go", false, None).contains("--resume"));
    }

    #[test]
    fn launch_command_matches_free_fn() {
        let a = ClaudeCodeAdapter;
        assert_eq!(a.launch_command("hi", false, None), crate::claude_launch("hi", false, None));
        let id = "bf36a25c-b331-48b0-a78c-3bf4e6b51354";
        assert_eq!(a.launch_command("hi", true, Some(id)), crate::claude_launch("hi", true, Some(id)));
        // sanity: a resume NAMES its session rather than guessing the newest one.
        assert!(a.launch_command("hi", true, Some(id)).contains("--resume"));
        assert!(a.launch_command("hi", true, Some(id)).contains(id));
        assert!(!a.launch_command("hi", false, None).contains("--resume"));
        assert!(!a.launch_command("hi", false, None).contains("--continue"));
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

    /// THE COMMAND LENGTH IS INDEPENDENT OF THE PROMPT — the property the truncation bug violated.
    ///
    /// A pty in canonical mode discards everything past 4096 bytes on one physical line, and this
    /// string is typed into an interactive shell. Inlining meant a long prompt was cut mid-token and
    /// the session silently never started. Asserting the LENGTH pins that, because it stays true no
    /// matter how the prompt happens to be escaped.
    #[test]
    fn the_launch_line_does_not_grow_with_the_prompt() {
        let a = BscAgentAdapter;
        let huge = "x".repeat(64 * 1024);
        let cmd = a.launch_command(&huge, false, None);
        assert!(cmd.len() < 120, "a {}-byte prompt produced a {}-byte line", huge.len(), cmd.len());
        assert_eq!(cmd, a.launch_command("tiny", false, None), "the line must not vary with the prompt");
    }

    #[test]
    fn bsc_agent_launch_references_the_prompt_and_has_no_model_flag() {
        let a = BscAgentAdapter;
        let cmd = a.launch_command("do the thing", false, None);
        // REFERENCED, not inlined: the pty truncates any line past 4096 bytes, and a cut `$'…'`
        // leaves the quote open so the agent never starts.
        assert_eq!(cmd, "bsc-agent \"$BSC_STARTUP_PROMPT\"");
        assert!(!cmd.contains("do the thing"), "the prompt must not be on the command line: {cmd}");
        assert!(!cmd.contains("--continue"));
        // Resume prepends --continue before the referenced prompt.
        let resumed = a.launch_command("do the thing", true, Some("bf36a25c-b331-48b0-a78c-3bf4e6b51354"));
        assert_eq!(resumed, "bsc-agent --continue \"$BSC_STARTUP_PROMPT\"");
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
