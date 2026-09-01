//! Whether a session's baked kickoff must be SUPPRESSED when it resumes a prior conversation.
//!
//! # Rust already owns the consequence
//!
//! [`crate::console::pty::launch`]'s `plan_launch` computes `suppress = fresh_only && has_history` and
//! decides whether a session is re-greeted or resumes quietly. It used not to be able to compute
//! `fresh_only`: that arrived as a `pty_create` argument from the renderer
//! (`startup_prompt_fresh_only`), defaulting to `false` when absent — so the backend acted on a flag
//! it was handed, on a rule whose entire purpose is to stop a resumed session being re-instructed.
//!
//! It computes it now. `pty_create` takes the two FACTS instead (`restore_requested`,
//! `startup_prompt_is_errand`) and calls [`fresh_only_for_launch`].
//!
//! # The rule, and why its two failure directions are not symmetric
//!
//! * A MANUAL console is never fresh-only (#1176) — it is not auto-recovered at all.
//! * Otherwise: fresh-only when the pane is being crash-RESTORED, or is a fixed app-owned studio
//!   session (which genuinely resumes across app restarts).
//!
//! OVER-suppressing is the dangerous direction. A suppressed kickoff on a session that resumes nothing
//! leaves it sitting at an empty prompt with nothing telling it what it exists for — which is exactly
//! what happened to the per-request debug sessions when the predicate keyed on the `debug-studio:`
//! PREFIX instead of the registry. It looked like the right predicate; it also caught
//! `debug-studio:req-<id>`, and those resume nothing. Compounded by `has_history` being per-DIRECTORY —
//! every debug session runs in this repo, where something has always run before — so the suppression
//! fired every single time and no debug session ever received its charter. The symptom read as "they
//! start but sit idle".
//!
//! UNDER-suppressing merely re-greets. So this must fail toward re-greeting, and an empty registry
//! does exactly that.
//!
//! # It is NOT gated on the harness, and that gate was the local-model bug
//!
//! The rule is about RESUMING, and `bsc-agent` resumes too — it takes `--continue` deliberately
//! mirroring claude's. Gating on "is this Claude" made every protection here Claude-only: a local pane
//! never suppressed its kickoff, so it was re-instructed on EVERY launch. There is deliberately no
//! provider parameter on this function, so that gate cannot be reintroduced by accident.
//!
//! # Why the registry is a parameter — and where it now comes from
//!
//! The studio-session ids are COMPUTED in the frontend (a designer and librarian id per technology,
//! plus four fixed studios). Taking the resolved list as a PARAMETER — the shape
//! [`super::role_gate::role_denied_commands`] already uses for the surface catalog — keeps the tech
//! lists from being restated in Rust, where they would be a second copy free to drift, and it is what
//! makes the empty-registry case above testable at all.
//!
//! The parameter is not the same question as where the launch GETS that list, and the answer to the
//! second one turned out to be "Rust already has it": see [`studio_pane_ids`]. The renderer no longer
//! supplies it.

use bsc_util::pane_id::is_manual_pane_id;

/// Is `pane_id` one of the fixed, app-owned studio sessions?
///
/// Membership, NOT a prefix test. `debug-studio:debugger` is in the registry; `debug-studio:req-4212`
/// shares its prefix and must not match — see the module docs for what that cost.
pub fn is_studio_session_pane_id(pane_id: &str, studio_pane_ids: &[String]) -> bool {
    studio_pane_ids.iter().any(|id| id == pane_id)
}

/// Whether this pane's baked startup prompt must be suppressed on a resume.
///
/// `studio_pane_ids` is the resolved app-owned studio registry. An EMPTY registry yields `false` for
/// every non-restored pane, which is the safe direction: a re-greeting, not a stranded session.
pub fn startup_prompt_fresh_only(
    pane_id: &str,
    restore_requested: bool,
    studio_pane_ids: &[String],
) -> bool {
    // Checked FIRST and unconditionally: a manual console is never auto-recovered, so it is never
    // fresh-only even when a restore is requested for it.
    if is_manual_pane_id(pane_id) {
        return false;
    }
    restore_requested || is_studio_session_pane_id(pane_id, studio_pane_ids)
}


/// The app-owned studio registry, DERIVED from backend-owned data rather than passed in.
///
/// # Why the parameter above still exists, and why this is not it
///
/// [`startup_prompt_fresh_only`] takes the registry as an argument so the port could be proved equal
/// to the TypeScript over the exact list the renderer computes. That argument stays: it is what the
/// fixture drives, and it is what makes the empty-registry case testable. This function is the
/// PRODUCER the launch uses, and it reads a table Rust already owns.
///
/// # It did not need the tech lists, which is the part worth writing down
///
/// The obvious route was to restate `DESIGNER_TECHS` / `LIBRARIAN_TECHS` in Rust and rebuild the ids
/// from them — a second copy of a list whose own doc says it is declared rather than derived. That is
/// unnecessary: [`bsc_session::SYSTEM_SESSIONS`] already enumerates the RESOLVED per-technology pane
/// ids as a compile-time closed set, because `bsc session start|stop|ask` resolves against it — and
/// `systemSessionRegistry.test.ts` already fails when that table drifts from the TypeScript. So the
/// registry was backend-owned before this item; nothing about it was ever a frontend fact except the
/// one id below.
///
/// # The one addition, and why it cannot simply join the table
///
/// `SYSTEM_SESSIONS` is the CLI's ARGUMENT SPACE. The debug studio is toggled from Settings and is the
/// one class of app-owned session with a RUNTIME id (`debug-studio:req-<n>`), so it is discovered
/// rather than named — which is why the standing debugger is not in the table. It is still a fixed
/// app-owned pane that genuinely resumes, so it belongs in THIS list, by its exact id.
///
/// Using [`bsc_session::DEBUG_STUDIO_PREFIX`] here instead would recreate the original bug exactly:
/// it also matches every `debug-studio:req-<n>`, which resumes nothing.
pub fn studio_pane_ids() -> Vec<String> {
    bsc_session::SYSTEM_SESSIONS
        .iter()
        .map(|s| s.pane_id.to_string())
        .chain(std::iter::once(bsc_session::DEBUG_STUDIO_STANDING_PANE_ID.to_string()))
        .collect()
}

/// The whole rule as ONE decision, for the launch to call.
///
/// # What this folds in that the resolver alone does not
///
/// In the TypeScript the rule is split across two files, and the second half is invisible from the
/// first. `resolveStartupPromptFreshOnly` answers "is this pane the kind that resumes"; the CALL SITE
/// in `TerminalView` then overrides it to `false` whenever the startup prompt arrived as a PROP:
///
/// ```text
/// startupPromptFreshOnly: startupPromptProp !== undefined ? false : resolveStartupPromptFreshOnly(…)
/// ```
///
/// That override is not a detail. A prop-borne prompt is an ERRAND — the thing telling this particular
/// launch what it was woken to do — and a studio always has history (its pane id is stable, so it
/// resumes), which means `fresh_only && has_history` suppressed every errand that ever reached the
/// backend. A reader of the resolver cannot see that, because the carve-out is a ternary in another
/// file. Folding both halves into one function is most of what this inversion buys.
///
/// # Both facts come from the caller; only the RULE moves
///
/// `restore_requested` (this is the crash-recovery relaunch) and `prompt_is_errand` (this prompt was
/// handed down for this launch) are facts only the renderer holds. What moves to Rust is the rule
/// over them plus the registry — the same split as the role gate, where the capability is a fact and
/// the denies are the policy.
pub fn fresh_only_for_launch(pane_id: &str, restore_requested: bool, prompt_is_errand: bool) -> bool {
    // The errand carve-out is checked FIRST and wins outright, mirroring the ternary it replaces: an
    // errand is never suppressed, not even for a pane being crash-restored. Suppressing it strands the
    // session with nothing telling it what it exists for, and that is the failure this whole module
    // fails away from.
    if prompt_is_errand {
        return false;
    }
    startup_prompt_fresh_only(pane_id, restore_requested, &studio_pane_ids())
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
                } else if p.file_name().and_then(|n| n.to_str()) == Some("freshOnly.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one freshOnly.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    fn studio_ids(doc: &serde_json::Value) -> Vec<String> {
        doc["studioPaneIds"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect()
    }

    /// Reports every mismatch at once — a wrong port is usually wrong in a pattern.
    #[test]
    fn the_fresh_only_decision_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let ids = studio_ids(&doc);
        assert!(ids.len() >= 8, "only {} studio ids — the registry looks truncated", ids.len());

        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 20, "fixture shrank to {} cases — regenerate it", cases.len());

        let (mut yes, mut no) = (0usize, 0usize);
        let mut mismatches = Vec::new();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let pane_id = case["paneId"].as_str().unwrap();
            let restore = case["restoreRequested"].as_bool().unwrap();
            let want = case["freshOnly"].as_bool().unwrap();
            if want {
                yes += 1;
            } else {
                no += 1;
            }
            let got = startup_prompt_fresh_only(pane_id, restore, &ids);
            if got != want {
                mismatches.push(format!("  {label} [{pane_id}] restore={restore}: ts={want} rust={got}"));
            }
            // The provider must make no difference — pinned in the fixture, asserted here.
            assert_eq!(
                case["freshOnlyNonClaude"].as_bool().unwrap(),
                want,
                "{label}: the TypeScript itself differs by provider — the harness gate is back"
            );
        }
        assert!(yes >= 5 && no >= 5, "the corpus is one-sided: {yes} true, {no} false");
        assert!(
            mismatches.is_empty(),
            "the Rust decision disagrees with the live TypeScript on {} of {} cases:\n{}",
            mismatches.len(),
            cases.len(),
            mismatches.join("\n")
        );
    }


    /// THE DERIVATION, against the list the LIVE TypeScript computes. `studio_pane_ids` reads a Rust
    /// table; this is what says that table is the same registry the renderer used to send, rather than
    /// a plausible-looking one. Order included: a set comparison would pass while the two tables had
    /// silently reordered, and the drift test on the TS side asserts order too.
    #[test]
    fn the_derived_registry_is_exactly_what_the_frontend_computes() {
        let want = studio_ids(&fixture());
        assert_eq!(
            studio_pane_ids(),
            want,
            "the registry Rust derives from bsc_session::SYSTEM_SESSIONS + the standing debugger must \
             equal STUDIO_SESSION_PANE_IDS. If this fails, one side gained a studio and the other did \
             not — regenerate the fixture and check crates/bsc-session/src/lib.rs."
        );
    }

    /// The prefix is the tempting wrong answer at the DERIVATION site too, not only at the predicate.
    /// A registry built from `DEBUG_STUDIO_PREFIX` would contain no fixed id at all; one that appended
    /// the prefix as if it were an id would never match the standing debugger.
    #[test]
    fn the_registry_carries_the_standing_debugger_by_id_and_nothing_else_from_that_studio() {
        let ids = studio_pane_ids();
        assert!(ids.iter().any(|i| i == "debug-studio:debugger"), "the standing debugger is registered");
        assert_eq!(
            ids.iter().filter(|i| i.starts_with(bsc_session::DEBUG_STUDIO_PREFIX)).count(),
            1,
            "exactly ONE debug-studio id is fixed; the rest are per-request and resume nothing: {ids:?}"
        );
        assert!(
            !ids.iter().any(|i| i == bsc_session::DEBUG_STUDIO_PREFIX),
            "the PREFIX is not an id — appending it would register a pane that cannot exist"
        );
    }

    /// THE CARVE-OUT THE RESOLVER CANNOT SEE. In the TypeScript this lives as a ternary in
    /// `TerminalView`, so a reader of `resolveStartupPromptFreshOnly` cannot tell it exists. A studio
    /// always has history, so `fresh_only && has_history` suppressed every errand that reached the
    /// backend — the same shape as the per-request debug bug, one level up.
    #[test]
    fn an_errand_is_never_fresh_only_however_the_pane_would_otherwise_resolve() {
        // The three ways a pane WOULD be fresh-only, each overridden by the errand.
        assert!(fresh_only_for_launch("teams-studio:architect", false, false), "a studio, no errand");
        assert!(!fresh_only_for_launch("teams-studio:architect", false, true), "…and with one");
        assert!(fresh_only_for_launch("proj:stream", true, false), "a crash restore, no errand");
        assert!(
            !fresh_only_for_launch("proj:stream", true, true),
            "an errand outranks even a crash restore — it is the only thing telling this launch what \
             it was woken to do"
        );
        // And it does not invent fresh-only for a pane that never had it.
        assert!(!fresh_only_for_launch("proj:stream", false, false));
    }

    /// The composed decision must agree with the parity-proved predicate on every fixture case once
    /// the errand is out of the picture — otherwise the composition has quietly changed the rule the
    /// fixture governs.
    #[test]
    fn the_composed_decision_matches_the_predicate_on_every_fixture_case() {
        let doc = fixture();
        let ids = studio_pane_ids();
        for case in doc["cases"].as_array().unwrap() {
            let pane_id = case["paneId"].as_str().unwrap();
            let restore = case["restoreRequested"].as_bool().unwrap();
            assert_eq!(
                fresh_only_for_launch(pane_id, restore, false),
                startup_prompt_fresh_only(pane_id, restore, &ids),
                "{} [{pane_id}]: composing the errand carve-out changed the underlying rule",
                case["label"].as_str().unwrap(),
            );
        }
    }

    /// A manual console is never fresh-only — checked BEFORE the restore flag, so even a restore
    /// request cannot make it one.
    #[test]
    fn a_manual_console_is_never_fresh_only_even_when_restore_is_requested() {
        let ids = studio_ids(&fixture());
        assert!(!startup_prompt_fresh_only("man:tab1:p0", false, &ids));
        assert!(
            !startup_prompt_fresh_only("man:tab1:p0", true, &ids),
            "the manual guard must be checked before the restore flag, not after"
        );
    }

    /// THE DOCUMENTED BUG, asserted in both directions. Keying on the `debug-studio:` prefix instead of
    /// the registry is what stranded every per-request debug session at an empty prompt.
    #[test]
    fn membership_not_prefix_separates_the_standing_debug_session_from_a_per_request_one() {
        let ids = studio_ids(&fixture());
        assert!(
            ids.iter().any(|i| i == "debug-studio:debugger"),
            "the standing debugger must be in the registry"
        );
        assert!(startup_prompt_fresh_only("debug-studio:debugger", false, &ids), "it genuinely resumes");
        assert!(
            !startup_prompt_fresh_only("debug-studio:req-4212", false, &ids),
            "a per-request session resumes nothing — suppressing its charter strands it"
        );
        // And the reason the prefix is tempting: they really do share one.
        assert!("debug-studio:req-4212".starts_with("debug-studio:"));
    }

    /// The failure direction that matters. An empty or truncated registry must degrade to RE-GREETING,
    /// never to suppression — a session with no instructions is worse than one greeted twice.
    #[test]
    fn an_empty_registry_fails_toward_regreeting_not_suppression() {
        assert!(
            !startup_prompt_fresh_only("design-studio:designer-react", false, &[]),
            "with no registry a studio session is re-greeted, which is recoverable; suppressing it is not"
        );
        assert!(
            startup_prompt_fresh_only("design-studio:designer-react", true, &[]),
            "an explicit crash-restore still suppresses — that signal does not come from the registry"
        );
    }

    /// Every id in the shipped registry is fresh-only. If one is not, the registry and the predicate
    /// disagree about what a studio session is.
    #[test]
    fn every_registered_studio_session_is_fresh_only() {
        let ids = studio_ids(&fixture());
        for id in &ids {
            assert!(startup_prompt_fresh_only(id, false, &ids), "{id} is registered but not fresh-only");
        }
    }

    /// There is no provider parameter, and that is deliberate — the gate that made this Claude-only is
    /// what left a local pane re-instructed on every launch. This test exists so the absence is a
    /// stated decision rather than an omission a future signature change could quietly undo.
    #[test]
    fn the_decision_takes_no_provider_because_bsc_agent_resumes_too() {
        let ids = studio_ids(&fixture());
        // The same pane, asked the only way it can be asked. If a provider argument ever appears, this
        // call stops compiling and the reviewer is sent to the module docs.
        assert!(startup_prompt_fresh_only("teams-studio:architect", false, &ids));
    }
}
