//! What a relaunching pane actually RUNS — the caller's own command, nothing, or a resume.
//!
//! [`crate::console::pty::launch`]'s `plan_launch` consumes this `init_cmd` and cannot compute it.
//! Every failure mode guarded here was a session that came up wrong and said nothing about it.
//!
//! # The four bugs encoded in this function
//!
//! * **A resumed worker opened a brand-new conversation** beside the old one. Every agent pane stores
//!   the bare harness name as its `initCmd` — a PLACEHOLDER meaning "this pane runs an agent", never a
//!   command anyone chose — and returning it verbatim on a resume starts a fresh session. The resume
//!   form is therefore DERIVED from the placeholder, which is also how a `bsc-agent` pane stopped
//!   resuming into CLAUDE (#173): the configured local model was never reached and nothing said so.
//! * **An empty startup prompt produced a bare shell.** The prompt is tested for NON-EMPTINESS, not
//!   for presence: an empty prompt is discarded downstream by `plan_launch`'s own filter too, so
//!   short-circuiting on it left the pane with neither a baked prompt nor an init command. Falling
//!   through lets the resume branch answer, which is what an empty prompt wants.
//! * **`continue_session` alone resumes.** It used to also require `pane_was_claude`, which
//!   DEADLOCKED: that flag is set only once claude has actually started, so a pane where claude had
//!   never started could never be resumed INTO claude — the gate blocked the launch, and the launch
//!   was what would have set the flag. MEASURED: 77 of 78 fleet panes had no `pane_was_claude`.
//! * **The resume question is asked ONCE**, before any branch, so every branch agrees on the answer.
//!   The explicit arm used to decide before it was ever asked.
//!
//! # The asymmetry between the three signals is deliberate
//!
//! `continue_session` is an explicit, user-initiated resume of a session we know existed, so it stands
//! alone. The two CRASH-RECOVERY signals are guesses after the fact and stay gated on
//! `pane_was_claude` — there is no point resuming a pane that was never an agent.
//!
//! A clean quit sets none of the three, so the app still starts nothing by itself. That is asserted
//! rather than assumed: this function is one edit away from launching sessions on its own.

// UNWIRED BY DESIGN, and the `allow` names the item that wires it.
#![allow(dead_code)] // wired by `the-launch-resolves-its-own-resume-command-instead-of-receiving-it`

/// The bare harness launches an agent pane stores as its `init_cmd`.
///
/// An EXACT-MATCH set on purpose: a real override carries flags or a different program
/// (`aider --message …`, a wrapper script) and must still win untouched, so a prefix test would
/// swallow `claude --model opus`.
const HARNESS_PLACEHOLDERS: &[&str] = &["claude", "bsc-agent"];

/// Is this the bare harness placeholder rather than a command the caller chose?
fn is_harness_placeholder(cmd: &str) -> bool {
    HARNESS_PLACEHOLDERS.contains(&cmd.trim())
}

/// `<harness> --continue`, degrading to a fresh session.
///
/// Derived from the harness rather than hardcoded to `claude`: `bsc-agent` accepts `--continue`
/// deliberately mirroring claude's, and resuming such a pane with claude's command launched CLAUDE.
/// The `|| <harness>` tail is what lets a pane with no prior conversation start fresh instead of
/// failing, so no caller has to check for history first.
pub fn continue_or_fresh(harness: &str) -> String {
    let h = harness.trim();
    let h = if h.is_empty() { "claude" } else { h };
    format!("{h} --continue 2>/dev/null || {h}")
}

/// The signals and inputs a launch decision reads.
#[derive(Debug, Clone, Default)]
pub struct ResumeInputs<'a> {
    /// The pane's own init command, if any. May be the bare harness placeholder.
    pub explicit: Option<&'a str>,
    pub startup_prompt: Option<&'a str>,
    /// An explicit fleet/triage resume — a user-initiated resume of a session we know existed.
    pub continue_session: bool,
    pub pane_was_claude: bool,
    pub auto_resume_claude: bool,
    pub was_unclean_shutdown: bool,
    pub restore_requested: bool,
}

/// Is this launch a resume? Asked ONCE so every branch agrees.
fn resuming(i: &ResumeInputs) -> bool {
    i.continue_session
        || (i.pane_was_claude && (i.restore_requested || (i.auto_resume_claude && i.was_unclean_shutdown)))
}

/// Resolve the effective init command. An empty string means "no init command" — the baked-prompt path
/// or nothing at all.
pub fn resolve_init_cmd(i: &ResumeInputs) -> String {
    let is_resume = resuming(i);

    // An explicit override wins — the caller knows best — EXCEPT when the "override" is the bare
    // harness placeholder AND this is a resume. Returning it verbatim there is how a resumed worker
    // came back to an empty conversation.
    if let Some(explicit) = i.explicit.filter(|e| !e.is_empty()) {
        return if is_resume && is_harness_placeholder(explicit) {
            continue_or_fresh(explicit)
        } else {
            explicit.to_string()
        };
    }

    // A real startup prompt takes the baked-prompt path; layering an init command on top would spawn a
    // second agent before the first finished initialising. NON-EMPTY, not present: an empty prompt is
    // discarded downstream too, so short-circuiting on it left the pane a bare shell.
    if i.startup_prompt.is_some_and(|p| !p.is_empty()) {
        return String::new();
    }

    if is_resume {
        return continue_or_fresh("claude");
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("resumeCommand.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one resumeCommand.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// Reports every mismatch at once — a wrong port here is wrong in a pattern, and each pattern is a
    /// different way for a session to come up silently wrong.
    #[test]
    fn the_resume_command_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 18, "fixture shrank to {} cases — regenerate it", cases.len());

        let (mut resumed, mut empty, mut verbatim) = (0usize, 0usize, 0usize);
        let mut mismatches = Vec::new();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let a = &case["args"];
            let inputs = ResumeInputs {
                explicit: a["explicit"].as_str(),
                startup_prompt: a["startupPrompt"].as_str(),
                continue_session: a["continueSession"].as_bool().unwrap(),
                pane_was_claude: a["paneWasClaude"].as_bool().unwrap(),
                auto_resume_claude: a["autoResumeClaude"].as_bool().unwrap(),
                was_unclean_shutdown: a["wasUncleanShutdown"].as_bool().unwrap(),
                restore_requested: a["restoreRequested"].as_bool().unwrap(),
            };
            let want = case["cmd"].as_str().unwrap();
            if want.contains("--continue") {
                resumed += 1;
            } else if want.is_empty() {
                empty += 1;
            } else {
                verbatim += 1;
            }
            let got = resolve_init_cmd(&inputs);
            if got != want {
                mismatches.push(format!("  {label}\n    ts   {want:?}\n    rust {got:?}"));
            }
        }
        assert!(resumed >= 5, "only {resumed} resume cases");
        assert!(empty >= 5, "only {empty} no-command cases");
        assert!(verbatim >= 3, "only {verbatim} verbatim-override cases");
        assert!(
            mismatches.is_empty(),
            "the Rust resolution disagrees with the live TypeScript on {} of {} cases:\n{}",
            mismatches.len(),
            cases.len(),
            mismatches.join("\n")
        );
    }

    /// The resume form is byte-identical to the shipped one for BOTH harnesses. A Claude pane in
    /// particular must keep emitting the exact string it always has.
    #[test]
    fn the_resume_form_matches_the_shipped_strings() {
        let doc = fixture();
        assert_eq!(continue_or_fresh("claude"), doc["continueOrFresh"].as_str().unwrap());
        assert_eq!(continue_or_fresh("bsc-agent"), doc["continueOrFreshBscAgent"].as_str().unwrap());
        assert_eq!(
            continue_or_fresh(""),
            doc["continueOrFresh"].as_str().unwrap(),
            "an empty harness falls back to claude rather than emitting ` --continue`"
        );
    }

    /// A CLEAN QUIT RESUMES NOTHING. Asserted rather than assumed: this function is one edit away from
    /// starting sessions by itself.
    #[test]
    fn a_clean_quit_resumes_nothing() {
        assert_eq!(resolve_init_cmd(&ResumeInputs::default()), "");
        assert_eq!(
            resolve_init_cmd(&ResumeInputs { pane_was_claude: true, ..Default::default() }),
            "",
            "having BEEN an agent is not itself a resume signal"
        );
        assert_eq!(
            resolve_init_cmd(&ResumeInputs {
                pane_was_claude: true,
                auto_resume_claude: true,
                was_unclean_shutdown: false,
                ..Default::default()
            }),
            "",
            "auto-resume armed but the shutdown was clean"
        );
    }

    /// #173: a resuming `bsc-agent` pane resumes BSC-AGENT. Resuming it with claude's command launched
    /// claude, so the configured local model was never reached and nothing reported it.
    #[test]
    fn a_resuming_bsc_agent_pane_resumes_bsc_agent_and_never_claude() {
        let cmd = resolve_init_cmd(&ResumeInputs {
            explicit: Some("bsc-agent"),
            continue_session: true,
            ..Default::default()
        });
        assert_eq!(cmd, "bsc-agent --continue 2>/dev/null || bsc-agent");
        assert!(!cmd.starts_with("claude"), "resuming into claude silently ignores the local model");
    }

    /// A REAL override wins untouched even on a resume — the placeholder set is exact-match, so a
    /// command that merely CONTAINS the harness name is not one.
    #[test]
    fn a_real_override_is_never_rewritten() {
        for cmd in ["aider --message go", "./my-wrapper.sh", "claude --model opus"] {
            assert_eq!(
                resolve_init_cmd(&ResumeInputs {
                    explicit: Some(cmd),
                    continue_session: true,
                    ..Default::default()
                }),
                cmd,
                "{cmd:?} is a command the caller chose, not a placeholder"
            );
        }
    }

    /// An EMPTY startup prompt falls through; a real one wins. Short-circuiting on presence left the
    /// pane with neither a prompt nor a command — a bare shell.
    #[test]
    fn an_empty_startup_prompt_falls_through_to_the_resume() {
        let empty = resolve_init_cmd(&ResumeInputs {
            startup_prompt: Some(""),
            continue_session: true,
            ..Default::default()
        });
        assert!(empty.contains("--continue"), "an empty prompt is not a prompt: {empty:?}");

        let real = resolve_init_cmd(&ResumeInputs {
            startup_prompt: Some("do the thing"),
            continue_session: true,
            ..Default::default()
        });
        assert_eq!(real, "", "a real prompt takes the baked path and must not also get an init cmd");
    }

    /// The signal asymmetry: `continue_session` stands alone, the two crash-recovery guesses stay gated
    /// on `pane_was_claude`. Conflating them either re-deadlocks the fleet or resumes panes that were
    /// never agents.
    #[test]
    fn continue_session_stands_alone_while_the_crash_signals_stay_gated() {
        let resumed = |i: ResumeInputs| resolve_init_cmd(&i).contains("--continue");

        assert!(
            resumed(ResumeInputs { continue_session: true, pane_was_claude: false, ..Default::default() }),
            "77 of 78 fleet panes had no pane_was_claude — requiring it deadlocked Resume"
        );
        assert!(
            !resumed(ResumeInputs { restore_requested: true, pane_was_claude: false, ..Default::default() }),
            "a crash-restore guess on a pane that was never an agent resumes nothing"
        );
        assert!(
            !resumed(ResumeInputs {
                auto_resume_claude: true,
                was_unclean_shutdown: true,
                pane_was_claude: false,
                ..Default::default()
            }),
            "and neither does the silent auto-resume"
        );
        assert!(resumed(ResumeInputs { restore_requested: true, pane_was_claude: true, ..Default::default() }));
    }
}
