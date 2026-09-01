//! Whether a session's baked kickoff must be SUPPRESSED when it resumes a prior conversation.
//!
//! # Rust already owns the consequence
//!
//! [`crate::console::pty::launch`]'s `plan_launch` computes `suppress = fresh_only && has_history` and
//! decides whether a session is re-greeted or resumes quietly. It cannot compute `fresh_only`: that
//! arrives as a `pty_create` argument from the renderer (`startup_prompt_fresh_only`), defaulting to
//! `false` when absent. So the backend acts on a flag it is handed, on a rule whose entire purpose is
//! to stop a resumed session being re-instructed.
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
//! # Why the registry is a parameter
//!
//! The studio-session ids are COMPUTED in the frontend (a designer and librarian id per technology,
//! plus four fixed studios). Passing the resolved list in — the shape
//! [`super::role_gate::role_denied_commands`] already uses for the surface catalog — keeps the tech
//! lists from being restated in Rust, where they would be a second copy free to drift.

// UNWIRED BY DESIGN, and the `allow` names the item that wires it.
#![allow(dead_code)] // wired by `the-launch-derives-its-own-fresh-only-instead-of-receiving-it`

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
