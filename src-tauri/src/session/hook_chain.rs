//! The session's PreToolUse hook chain — which gates are actually INSTALLED.
//!
//! # Rust supplies every hook and could not decide which ones run
//!
//! Each gate this epic has moved into Rust is enforced by one of these: `bsc-deny` reads
//! `$BSC_DENY_BASH`, `bsc-scope` reads `$BSC_SCOPE_GLOBS`, `bsc-confine` bounds the filesystem.
//! [`crate::console::shell_rc`] writes the shell functions that make them exist and `crates/bsc-hook`
//! is the binary they call. But the LIST was composed in the renderer and handed to
//! `ensure_session_settings` — so a hook can be perfectly implemented in Rust, handed a perfectly
//! derived environment by Rust, and simply never installed, with nothing in the backend able to tell.
//!
//! # That has happened twice, which is why the floor is asserted rather than assumed
//!
//! The turn-accounting pair is pure observability and has fallen out of a launch path twice: the
//! generic fleet/console path never registered `bsc-tokens`, so tokens.log was dead for about three
//! weeks and the cost subsystem read `$0` (#3452); and the planner launch passed no hooks at all, so
//! its planning cost was invisible (#3455). A shared constant makes that structural for paths that
//! SPREAD it and does nothing for a path that composes its own list — so
//! `the_turn_accounting_hooks_are_in_every_branch` pins it here instead.
//!
//! # Three gates, and an unconditional floor
//!
//! | branch | adds |
//! |---|---|
//! | floor (always) | `bsc-confine`, `bsc-deny`, the turn-accounting entries |
//! | has a capability OR a profile | `bsc-audit`, `bsc-mcp` (Pre+Post), `bsc-scope`, `bsc-taint`, `bsc-supply`, `bsc-fork` |
//! | role is `worker` | `bsc-superseded` |
//! | resolved any skills | `bsc-skill` (Pre+Post) |
//!
//! The floor being unconditional is the property most worth keeping: an ungated ad-hoc pane still gets
//! filesystem confinement and command denies. The gate is capability **or** profile — a pane carrying
//! only a profile is gated, and collapsing that to "has a role" would silently un-gate it.
//!
//! ORDER IS PART OF THE CONTRACT. The chain is written into `settings.json` in order, so a reordering
//! is a real diff in a security-relevant file even when the SET is identical.
//!
//! # Not here
//!
//! The sandboxed substitution (`sandboxed ? SANDBOXED_HOOKS : this`) belongs to the sandbox cluster,
//! which has items in flight; the caller substitutes. Persona-supplied hooks are passed IN rather than
//! resolved here, the same way the surface catalog and the studio registry already are.

// UNWIRED BY DESIGN, and the `allow` names the item that wires it.
#![allow(dead_code)] // wired by `the-launch-composes-its-own-hook-chain-instead-of-receiving-it`

/// One registered hook. `matcher` is a regex over tool names; empty means every tool.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionHook {
    pub event: String,
    pub matcher: String,
    pub command: String,
}

fn hook(event: &str, matcher: &str, command: &str) -> SessionHook {
    SessionHook { event: event.into(), matcher: matcher.into(), command: command.into() }
}

/// The file-editing tools, as one matcher. Used by both the scope gate and the worker's edit gate.
const EDIT_TOOLS: &str = "Edit|Write|MultiEdit|NotebookEdit";

/// Pure-observability hooks EVERY session registers (#3455). No behavioural effect — they append a log
/// line — and they are the entries that have twice gone missing.
pub fn turn_accounting_hooks() -> Vec<SessionHook> {
    vec![
        hook("UserPromptSubmit", "", "bsc-activity run"),
        hook("Notification", "", "bsc-activity attn"),
        hook("Stop", "", "bsc-activity idle"),
        hook("SubagentStop", "", "bsc-activity idle"),
        hook("Stop", "", "bsc-tokens"),
        hook("SubagentStop", "", "bsc-tokens"),
    ]
}

/// Compose the chain.
///
/// `persona_hooks` are already resolved. `gated` is "this pane has a capability OR a profile" — the
/// caller answers it, because a capability and a profile are two different lookups and neither is this
/// function's to perform.
pub fn session_hooks(
    persona_hooks: &[SessionHook],
    gated: bool,
    is_worker: bool,
    has_skills: bool,
) -> Vec<SessionHook> {
    let mut out: Vec<SessionHook> = persona_hooks.to_vec();

    if gated {
        out.push(hook("PreToolUse", "", "bsc-audit"));
        out.push(hook("PreToolUse", "mcp__.*", "bsc-mcp"));
        out.push(hook("PostToolUse", "mcp__.*", "bsc-mcp"));
        out.push(hook("PreToolUse", EDIT_TOOLS, "bsc-scope"));
        out.push(hook("PreToolUse", "", "bsc-taint"));
        out.push(hook("PreToolUse", "Bash", "bsc-supply"));
        out.push(hook("PreToolUse", "Agent|Task", "bsc-fork"));
        if is_worker {
            // #4240: a worker must not edit a file its own landing superseded.
            out.push(hook("PreToolUse", EDIT_TOOLS, "bsc-superseded"));
        }
    }

    if has_skills {
        out.push(hook("PreToolUse", "Skill", "bsc-skill"));
        out.push(hook("PostToolUse", "Skill", "bsc-skill"));
    }

    // THE FLOOR, appended unconditionally. An ungated ad-hoc pane still gets filesystem confinement
    // and command denies — `bsc-deny` in particular is what holds under the bypass posture, where
    // `permissions.deny` is ignored entirely.
    out.push(hook("PreToolUse", "Edit|Write|MultiEdit|NotebookEdit|Read", "bsc-confine"));
    out.push(hook("PreToolUse", "Bash", "bsc-deny"));
    out.extend(turn_accounting_hooks());
    out
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
                } else if p.file_name().and_then(|n| n.to_str()) == Some("hookChain.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one hookChain.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// Reports every mismatch at once, and compares the WHOLE entry in ORDER — the chain is written
    /// into settings.json in order, so a reordering is a real diff in a security-relevant file even
    /// when the set is identical.
    #[test]
    fn the_hook_chain_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 10, "fixture shrank to {} cases — regenerate it", cases.len());

        let (mut gated_n, mut worker_n, mut skills_n, mut floor_n) = (0usize, 0usize, 0usize, 0usize);
        let mut mismatches = Vec::new();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let role = case["role"].as_str();
            let has_profile = case["hasProfile"].as_bool().unwrap();
            let has_skills = case["hasSkills"].as_bool().unwrap();
            // "gated" is capability OR profile; on these fixtures a role always yields a capability.
            let gated = role.is_some() || has_profile;
            if gated {
                gated_n += 1;
            } else {
                floor_n += 1;
            }
            if role == Some("worker") {
                worker_n += 1;
            }
            if has_skills {
                skills_n += 1;
            }

            let want: Vec<SessionHook> = serde_json::from_value(case["hooks"].clone())
                .unwrap_or_else(|e| panic!("{label}: hooks did not deserialize: {e}"));
            let got = session_hooks(&[], gated, role == Some("worker"), has_skills);
            if got != want {
                let wc: Vec<&str> = want.iter().map(|h| h.command.as_str()).collect();
                let gc: Vec<&str> = got.iter().map(|h| h.command.as_str()).collect();
                mismatches.push(format!("  {label}\n    ts   {wc:?}\n    rust {gc:?}"));
            }
        }
        assert!(gated_n >= 6 && floor_n >= 2, "the gate is one-sided: {gated_n} gated, {floor_n} ungated");
        assert!(worker_n >= 2, "only {worker_n} worker cases");
        assert!(skills_n >= 2, "only {skills_n} skills cases");
        assert!(
            mismatches.is_empty(),
            "the Rust chain disagrees with the live TypeScript on {} of {} cases:\n{}",
            mismatches.len(),
            cases.len(),
            mismatches.join("\n")
        );
    }

    /// THE FLOOR. An ungated ad-hoc pane — no capability, no profile, no skills — still gets
    /// filesystem confinement and command denies. `bsc-deny` in particular is what holds under the
    /// bypass posture, where `permissions.deny` is ignored entirely.
    #[test]
    fn the_floor_is_unconditional() {
        for (gated, worker, skills) in
            [(false, false, false), (true, false, false), (false, false, true), (true, true, true)]
        {
            let cmds: Vec<String> =
                session_hooks(&[], gated, worker, skills).into_iter().map(|h| h.command).collect();
            assert!(cmds.contains(&"bsc-confine".to_string()), "confinement dropped at {gated}/{worker}/{skills}");
            assert!(cmds.contains(&"bsc-deny".to_string()), "command denies dropped at {gated}/{worker}/{skills}");
        }
    }

    /// The entries that have twice silently gone missing from a launch path. #3452 killed tokens.log
    /// for about three weeks this way; #3455 made the planner's cost invisible.
    #[test]
    fn the_turn_accounting_hooks_are_in_every_branch() {
        for (gated, worker, skills) in
            [(false, false, false), (true, false, false), (true, true, false), (true, true, true), (false, false, true)]
        {
            let cmds: Vec<String> =
                session_hooks(&[], gated, worker, skills).into_iter().map(|h| h.command).collect();
            for prefix in ["bsc-activity", "bsc-tokens"] {
                assert!(
                    cmds.iter().any(|c| c.starts_with(prefix)),
                    "{prefix} missing at {gated}/{worker}/{skills} — this is exactly how #3452 happened"
                );
            }
        }
        assert_eq!(turn_accounting_hooks().len(), 6, "the accounting set changed size");
    }

    /// The gate is capability OR profile. Collapsing it to "has a role" silently un-gates a pane that
    /// carries only a profile — which is a real configuration, not a hypothetical one.
    #[test]
    fn a_profile_alone_is_enough_to_gate_a_pane() {
        let profile_only: Vec<String> =
            session_hooks(&[], true, false, false).into_iter().map(|h| h.command).collect();
        assert!(profile_only.contains(&"bsc-scope".to_string()), "a profile-only pane must be gated");
        assert!(profile_only.contains(&"bsc-audit".to_string()));

        let ungated: Vec<String> =
            session_hooks(&[], false, false, false).into_iter().map(|h| h.command).collect();
        assert!(!ungated.contains(&"bsc-scope".to_string()), "and an ungated one must not be");
    }

    /// The worker edit gate is worker-only, and rides INSIDE the gated block — an ungated pane whose
    /// role is somehow worker gets no gates at all, which is the shipped behaviour.
    #[test]
    fn the_superseded_gate_is_worker_only_and_requires_the_gate() {
        let has = |g: bool, w: bool| {
            session_hooks(&[], g, w, false).iter().any(|h| h.command == "bsc-superseded")
        };
        assert!(has(true, true), "a gated worker gets the edit gate");
        assert!(!has(true, false), "a gated non-worker does not");
        assert!(!has(false, true), "and it never appears outside the gated block");
    }

    /// Persona hooks lead the chain, so a persona cannot be pushed behind the gates it is meant to
    /// compose with — and they survive every branch.
    #[test]
    fn persona_hooks_lead_the_chain_and_are_never_dropped() {
        let persona = vec![hook("PreToolUse", "Bash", "my-own-gate")];
        for (gated, worker, skills) in [(false, false, false), (true, true, true)] {
            let out = session_hooks(&persona, gated, worker, skills);
            assert_eq!(out.first(), persona.first(), "persona hooks must lead at {gated}/{worker}/{skills}");
            assert_eq!(out.iter().filter(|h| h.command == "my-own-gate").count(), 1, "and appear once");
        }
    }
}
