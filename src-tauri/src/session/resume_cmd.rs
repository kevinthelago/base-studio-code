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


/// What the launch resolved, what it was handed, and whether the two agreed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitCmdReconciliation {
    /// The command the launch will actually run — the FRONTEND's, deliberately. See below.
    pub effective: String,
    /// What this module resolved from the same facts.
    pub derived: String,
    /// `Some` when the two differ, carrying nothing the caller cannot already see — it exists so the
    /// caller cannot report a disagreement without having been told there was one.
    pub disagreement: Option<InitCmdDisagreement>,
}

/// The two values, when they differ.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitCmdDisagreement {
    pub from_frontend: String,
    pub derived: String,
    /// Why this comparison is meaningful for this launch — the frontend takes a different branch for a
    /// non-Claude harness, so the two disagreeing there is expected and this names the narrower reason
    /// the disagreement was reported anyway.
    pub because: &'static str,
}

/// Reconcile the resolved init command against what the renderer sent.
///
/// # THE COMMAND IS NEVER UNIONED, AND THE FRONTEND WINS
///
/// Every other reconciliation in this cutover merges two lists. This one cannot: `init_cmd` is a
/// single string with three incompatible meanings — an override the caller chose, EMPTY (take the
/// baked-prompt path, or nothing at all), and a resume form. There is no union of those, and picking
/// the "safer" one is not defined either.
///
/// So the frontend's value is what runs, and a disagreement is REPORTED. That direction is chosen on
/// visibility: a wrong init command is immediately obvious to the person watching the pane — it runs
/// the wrong program, or nothing — while a silent divergence between two copies of this rule is
/// exactly what nobody notices. The observation phase ends when the log has been quiet; the cutover to
/// Rust's value is its own slice with its own revert.
///
/// # When a comparison means anything
///
/// The renderer only routes a CLAUDE pane through the rule this module ports; a non-Claude harness
/// takes a different branch entirely (its provider's own `buildLaunchCmd`), which
/// `session::launch_cmd` models and this one does not. Comparing there would produce a disagreement on
/// every aider launch and teach the reader to ignore the log.
///
/// One check survives that gate, because it needs no model of the other branch at all: a pane that is
/// RESUMING must not run the bare harness placeholder, whatever branch produced it. That is the
/// original bug — an agent pane stores the bare harness name as its `init_cmd`, and running it
/// verbatim on a resume opens a brand-new conversation beside the old one — and it is provable from
/// the received string alone.
pub fn reconcile_init_cmd(
    from_frontend: String,
    provider_is_claude: bool,
    inputs: &ResumeInputs,
) -> InitCmdReconciliation {
    let derived = resolve_init_cmd(inputs);
    let disagreement = if provider_is_claude && derived != from_frontend {
        Some(InitCmdDisagreement {
            from_frontend: from_frontend.clone(),
            derived: derived.clone(),
            because: "a Claude pane routes through exactly the rule this module ports, so the two \
                      should agree",
        })
    } else if resuming(inputs) && is_harness_placeholder(&from_frontend) {
        // Provider-independent, and the reason this arm exists. A resuming pane running the bare
        // placeholder starts a fresh conversation; the harness's own `--continue` is what rejoins it.
        Some(InitCmdDisagreement {
            from_frontend: from_frontend.clone(),
            derived: continue_or_fresh(&from_frontend),
            because: "this launch is a RESUME and the command is the bare harness placeholder, so the \
                      session will open a NEW conversation beside the one it meant to rejoin",
        })
    } else {
        None
    };
    InitCmdReconciliation { effective: from_frontend, derived, disagreement }
}

/// The five raw resume signals, GROUPED rather than passed as five positional bools.
///
/// Not a style preference. They are all `bool`, so a transposed pair COMPILES and then resumes the
/// wrong thing — and the failure that produces is a session starting by itself, which reads as
/// behaviour rather than as an error. Field names make a call site reviewable.
#[derive(Debug, Clone, Copy, Default)]
pub struct ResumeSignals {
    pub continue_session: bool,
    pub pane_was_claude: bool,
    pub auto_resume_claude: bool,
    pub was_unclean_shutdown: bool,
    pub restore_requested: bool,
}

/// The signals as the launch receives them, with the MANUAL-console rule applied.
///
/// A manual console is never auto-recovered (#1176), and in the TypeScript that is three separate
/// `manual ? false : …` ternaries at the call site rather than anything the ported rule can see. It is
/// a RULE, not a fact, so it belongs here: the renderer sends the raw per-pane signals and this
/// decides which of them a manual pane is allowed to act on.
///
/// `pane_was_claude` is deliberately NOT forced. It is an observation about what the pane ran, not a
/// permission to resume, and the three signals it gates are already false for a manual console.
pub fn launch_inputs<'a>(
    pane_id: &str,
    explicit: Option<&'a str>,
    startup_prompt: Option<&'a str>,
    s: ResumeSignals,
) -> ResumeInputs<'a> {
    let manual = bsc_util::pane_id::is_manual_pane_id(pane_id);
    ResumeInputs {
        explicit,
        startup_prompt,
        continue_session: !manual && s.continue_session,
        pane_was_claude: s.pane_was_claude,
        auto_resume_claude: !manual && s.auto_resume_claude,
        was_unclean_shutdown: s.was_unclean_shutdown,
        restore_requested: !manual && s.restore_requested,
    }
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


    /// THE FRONTEND WINS, and the disagreement is reported rather than acted on. Both halves matter:
    /// silently taking Rust's answer would change what a pane runs during an observation phase, and
    /// reporting nothing would make the phase pointless.
    #[test]
    fn a_disagreement_is_reported_and_the_frontend_value_is_what_runs() {
        // A Claude pane RESUMING, where the renderer sent the bare placeholder.
        let inputs = ResumeInputs {
            explicit: Some("claude"),
            continue_session: true,
            ..ResumeInputs::default()
        };
        let r = reconcile_init_cmd("claude".to_string(), true, &inputs);
        assert_eq!(r.effective, "claude", "the frontend's value is what runs, always");
        assert_eq!(r.derived, continue_or_fresh("claude"));
        let d = r.disagreement.expect("a divergence this large must be reported");
        assert_eq!(d.from_frontend, "claude");
        assert!(d.derived.contains("--continue"));
    }

    /// Agreement is silent. A report on every launch is a report nobody reads.
    #[test]
    fn agreement_reports_nothing() {
        let inputs = ResumeInputs { explicit: Some("claude --model opus"), ..ResumeInputs::default() };
        let r = reconcile_init_cmd("claude --model opus".to_string(), true, &inputs);
        assert_eq!(r.effective, "claude --model opus");
        assert!(r.disagreement.is_none());
    }

    /// A non-Claude harness takes a branch this module does not model, so a plain difference there is
    /// EXPECTED and must not be reported — otherwise every aider launch warns and the log stops being
    /// worth reading.
    #[test]
    fn a_branch_this_module_does_not_model_is_not_reported_as_a_disagreement() {
        let inputs = ResumeInputs { explicit: Some("aider --message go"), ..ResumeInputs::default() };
        let r = reconcile_init_cmd("aider --model x --message go".to_string(), false, &inputs);
        assert_eq!(r.effective, "aider --model x --message go");
        assert!(
            r.disagreement.is_none(),
            "the provider's own buildLaunchCmd is `session::launch_cmd`'s subject, not this one's"
        );
    }

    /// …EXCEPT the one check that needs no model of the other branch. A resuming pane running the bare
    /// harness placeholder opens a NEW conversation beside the one it meant to rejoin — provable from
    /// the received string alone, whatever produced it.
    #[test]
    fn a_resuming_pane_running_the_bare_placeholder_is_reported_on_any_harness() {
        let inputs = ResumeInputs {
            explicit: Some("bsc-agent"),
            continue_session: true,
            ..ResumeInputs::default()
        };
        let r = reconcile_init_cmd("bsc-agent".to_string(), false, &inputs);
        let d = r.disagreement.expect("a resumed local worker starting cold must not be silent");
        assert_eq!(d.derived, continue_or_fresh("bsc-agent"));
        assert!(d.derived.starts_with("bsc-agent"), "the resume form is DERIVED from the harness, never claude's");
        // And it does not fire when the pane is not resuming — a fresh launch of the placeholder is
        // exactly right.
        let fresh = ResumeInputs { explicit: Some("bsc-agent"), ..ResumeInputs::default() };
        assert!(reconcile_init_cmd("bsc-agent".to_string(), false, &fresh).disagreement.is_none());
    }

    /// THE PROPERTY THE WHOLE MODULE PROTECTS. A clean quit sets none of the three signals, so nothing
    /// resumes and the app starts nothing by itself. Asserted over the manual and non-manual paths
    /// both, because the failure is not an error — it is an app that launches agent sessions at boot.
    #[test]
    fn a_clean_quit_resumes_nothing_on_any_pane() {
        for pane in ["man:tab1:p0", "proj:stream", "design-studio:designer-react"] {
            let i = launch_inputs(
                pane,
                None,
                None,
                ResumeSignals { pane_was_claude: true, ..ResumeSignals::default() },
            );
            assert_eq!(
                resolve_init_cmd(&i),
                "",
                "{pane}: a clean quit must resume nothing — `restart-does-not-resume-sessions`"
            );
        }
    }

    /// The manual-console rule is a RULE, so it moved. In the TypeScript it is three `manual ? false`
    /// ternaries at the CALL SITE, invisible from the ported function — the same split that hid the
    /// errand carve-out one item over.
    #[test]
    fn a_manual_console_is_never_auto_recovered_and_the_rule_lives_here() {
        // Every recovery signal set at once, on a manual pane.
        let all = ResumeSignals {
            continue_session: true,
            pane_was_claude: true,
            auto_resume_claude: true,
            was_unclean_shutdown: true,
            restore_requested: true,
        };
        let manual = launch_inputs("man:tab1:p0", Some("claude"), None, all);
        assert!(!manual.continue_session && !manual.auto_resume_claude && !manual.restore_requested);
        assert_eq!(resolve_init_cmd(&manual), "claude", "the placeholder stays a fresh launch");

        // The same signals on a fleet pane DO resume — otherwise this test would pass on a function
        // that simply ignored them all.
        let fleet = launch_inputs("proj:stream", Some("claude"), None, all);
        assert!(fleet.continue_session && fleet.auto_resume_claude && fleet.restore_requested);
        assert_eq!(resolve_init_cmd(&fleet), continue_or_fresh("claude"));

        // `pane_was_claude` is an observation, not a permission, and is deliberately not forced.
        assert!(manual.pane_was_claude, "forcing it would hide what the pane actually ran");
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
