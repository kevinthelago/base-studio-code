//! The claims a fleet makes about itself that do not hold (`bsc fleet doctor`).
//!
//! ## Why this exists
//!
//! Four bugs in one day shared one signature: an answer that was **wrong in the safe-looking
//! direction** and left **no durable trace**.
//!
//!   - the idle probe reported `running` for panes at a bare prompt, because the cage's own argv
//!     named the agent — so `bsc fleet list` returned `idle: []` for an entirely parked fleet;
//!   - the PreToolUse floor resolved to `/bsc-hook` outside a cage, failed NON-BLOCKING, and the
//!     session ran with no write-scope and no dangerous-command gate;
//!   - a wake killed a pane the launch would refuse, and acked `woke: true`;
//!   - an over-window prompt was truncated to half by Ollama while the client reported the full size.
//!
//! In every one the failure was indistinguishable from success on every surface the app exposes, and
//! each was found by a person noticing something odd and then reading process trees and server logs by
//! hand. Fixing them one at a time does nothing to make the next one visible.
//!
//! ## The shape, which is not new
//!
//! `bsc graph doctor` and `bsc ui parity` already do this for their own domains, and both work the
//! same way: compare TWO INDEPENDENT SOURCES that must agree, and report where they do not. A check
//! that re-derives an answer from the same code that produced it is circular and proves nothing. So
//! every check here names its two sources.
//!
//! ## App-free on purpose
//!
//! These checks are filesystem facts about a worktree, so they answer with the app DOWN — which is
//! exactly when a director most needs them, and exactly when `bsc fleet list` (which asks the running
//! app) can say nothing at all.

use std::path::Path;

/// One claim that does not hold.
///
/// `consequence` is a required field rather than a nicety. "no settings.json" reads as tidiness; "a
/// wake of this pane will be refused, after it has already killed the session" is the same fact and
/// the reason anyone would act on it. Every one of the four bugs above was survivable for as long as
/// it was, partly because what it COST was never stated anywhere.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// The pane the claim is about.
    pub pane_id: String,
    /// Stable slug for the kind of divergence — the thing to grep for and to count over time.
    pub category: &'static str,
    /// What is actually true, in one line.
    pub detail: String,
    /// What it costs. Never omitted; see the type doc.
    pub consequence: &'static str,
    /// The move that resolves it.
    pub fix: &'static str,
}

/// What a worktree says about itself — the second source each check compares against.
///
/// Read once per pane so the checks stay pure over plain data and are testable without a fleet, a
/// filesystem, or a running app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorktreeFacts {
    /// The worktree directory exists at all.
    pub present: bool,
    /// `.claude/settings.json` is there — the role gate and shell allow-list this session runs under.
    pub gate_present: bool,
    /// Those settings invoke the in-cage hook binary, which resolves ONLY inside a mount namespace.
    pub guest_hooks: bool,
}

/// The guest path a namespace session's PreToolUse hooks are bound at.
///
/// Stated here as the string to LOOK FOR rather than imported from `bsc-sandbox`: this crate is the
/// app-free half and must not take a dependency on the sandbox to answer a question about a file. The
/// pairing is pinned by a test that asserts the two agree.
pub const GUEST_HOOK_PATH: &str = "/bsc-hook";

/// Every claim about `pane_id` that does not hold, given what its worktree says.
///
/// `facts` is `None` for a pane with no worktree to inspect — a stream that never launched, or a
/// director, whose home is the hub rather than a worktree. That is not a finding: an absent worktree
/// for an unlaunched stream is the expected state, and reporting it would bury the two that matter.
pub fn findings_for(pane_id: &str, facts: Option<WorktreeFacts>) -> Vec<Finding> {
    let Some(f) = facts else { return Vec::new() };
    if !f.present {
        return Vec::new();
    }
    let mut out = Vec::new();

    // ── no-gate ──────────────────────────────────────────────────────────────────────────────────
    // Sources: the pane's IDENTITY (a project pane must be gated) vs the FILESYSTEM (is the file
    // there). MEASURED: four network-monitor worktrees were in this state — complete in every other
    // respect, `CLAUDE.local.md` present, only `.claude/` missing. `pty_create` refuses rather than
    // starting a director or worker permission-less, which is right — and `bsc fleet wake` (#142) now
    // provisions a conservative placeholder gate itself before asking to launch, closing the deadlock
    // where the refusal fired before the one thing (a real launch) that would ever write the real one.
    if !f.gate_present {
        out.push(Finding {
            pane_id: pane_id.to_string(),
            category: "no-gate",
            detail: "the worktree has no .claude/settings.json, so this pane has no role gate and no shell allow-list".into(),
            consequence: "a launch or wake of this pane is REFUSED (#1819) until something provisions the gate",
            fix: "wake the pane — `bsc fleet wake` provisions a placeholder gate itself when one is missing (#142), which is enough to pass the refusal; the pane's own launch overwrites it with the real role+profile settings moments later",
        });
    }

    // ── caged-floor ──────────────────────────────────────────────────────────────────────────────
    // Sources: the settings FILE (which hook binary it names) vs where that binary can EXIST (only
    // inside a namespace). Durable state, so it outlives the launch that wrote it: a session spawned
    // uncaged and re-mounted later carries hooks it cannot reach. THREE hubs were in this state, and
    // the only evidence was one transient line in a session transcript.
    if f.guest_hooks {
        out.push(Finding {
            pane_id: pane_id.to_string(),
            category: "caged-floor",
            detail: format!(
                "its PreToolUse hooks invoke {GUEST_HOOK_PATH}, which exists only inside a mount namespace"
            ),
            consequence: "if this pane launches UNCAGED the gates cannot execute, and they fail non-blocking — the session runs with no write-scope and no dangerous-command floor",
            fix: "confirm the pane launches into a namespace, or relaunch it so the host hook list is written instead",
        });
    }

    out
}

/// Read a worktree's facts off disk. `None` when there is no path to inspect.
pub fn read_facts(worktree: Option<&Path>) -> Option<WorktreeFacts> {
    let dir = worktree?;
    let settings = dir.join(".claude").join("settings.json");
    let body = std::fs::read_to_string(&settings).unwrap_or_default();
    Some(WorktreeFacts {
        present: dir.is_dir(),
        gate_present: settings.is_file(),
        // Substring rather than a JSON walk on purpose: the hook list has several shapes across
        // versions, and the question is only "does this file invoke the in-cage binary".
        guest_hooks: body.contains(GUEST_HOOK_PATH),
    })
}

/// Find a stream's worktree under `<base>/worktrees/<key>/`, matched by the `--<stream>` suffix.
///
/// Matched by SUFFIX rather than rebuilt from `<repo>--<stream>`, deliberately. Re-deriving the name
/// would put a second copy of the app's worktree-naming rule here, and a second copy that drifts is
/// precisely the failure class this whole module exists to surface. Reading the directory that is
/// actually there cannot drift.
pub fn find_worktree(base: &Path, project_key: &str, stream: &str) -> Option<std::path::PathBuf> {
    if stream.is_empty() {
        return None;
    }
    let suffix = format!("--{stream}");
    std::fs::read_dir(base.join("worktrees").join(project_key))
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.ends_with(&suffix))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(gate_present: bool, guest_hooks: bool) -> Option<WorktreeFacts> {
        Some(WorktreeFacts { present: true, gate_present, guest_hooks })
    }

    #[test]
    fn a_healthy_worktree_reports_nothing() {
        // A clean fleet must print NOTHING, not a reassuring summary. A doctor whose normal output is
        // a wall of "ok" is one nobody reads, and then the one real line scrolls past.
        assert_eq!(findings_for("nm:api", facts(true, false)), Vec::new());
    }

    #[test]
    fn a_worktree_with_no_gate_file_is_reported_with_what_it_costs() {
        // The state four network-monitor worktrees were in.
        let f = findings_for("nm:omada-controller-adapter", facts(false, false));
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].category, "no-gate");
        assert_eq!(f[0].pane_id, "nm:omada-controller-adapter");
        assert!(f[0].detail.contains(".claude/settings.json"), "names the missing file: {:?}", f[0]);
        // The consequence is the half that makes anyone act — "no settings.json" alone reads as
        // tidiness, and this sat unnoticed through four worktrees for exactly that reason.
        assert!(f[0].consequence.contains("REFUSED"));
        // The fix names the ACTUAL move now available (#142) — a wake self-heals this, rather than the
        // stale "relaunch the pane from its project" advice, which named no single-stream command.
        assert!(f[0].fix.contains("bsc fleet wake"), "names the self-healing move: {:?}", f[0]);
        assert!(!f[0].fix.is_empty(), "a finding with no move is a complaint");
    }

    #[test]
    fn hooks_that_only_resolve_in_a_cage_are_reported() {
        let f = findings_for("nm:director", facts(true, true));
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].category, "caged-floor");
        assert!(f[0].detail.contains(GUEST_HOOK_PATH));
        // Non-blocking is the sharp edge: the call PROCEEDS, so the session looks fine while ungated.
        assert!(f[0].consequence.contains("non-blocking"));
        assert!(f[0].consequence.contains("no write-scope"));
    }

    #[test]
    fn both_can_hold_at_once_and_both_are_reported() {
        // They are independent conditions, so one must not mask the other.
        let f = findings_for("nm:api", facts(false, true));
        let cats: Vec<&str> = f.iter().map(|x| x.category).collect();
        assert_eq!(cats, vec!["no-gate", "caged-floor"]);
    }

    #[test]
    fn a_pane_with_no_worktree_is_not_a_finding() {
        // An unlaunched stream has no worktree, and a director lives in the hub. Reporting those
        // would bury the two conditions that matter under rows that are simply the normal state.
        assert_eq!(findings_for("nm:never-ran", None), Vec::new());
        assert_eq!(
            findings_for("nm:never-ran", Some(WorktreeFacts { present: false, gate_present: false, guest_hooks: false })),
            Vec::new(),
        );
    }

    #[test]
    fn facts_are_read_off_a_real_directory() {
        let dir = std::env::temp_dir().join(format!("bsc-fleet-doctor-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // A worktree with no `.claude` at all — the observed shape.
        let f = read_facts(Some(&dir)).unwrap();
        assert!(f.present && !f.gate_present && !f.guest_hooks);
        assert_eq!(findings_for("nm:api", Some(f)).len(), 1);

        // ...and once gated with host hooks, clean.
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(dir.join(".claude").join("settings.json"), r#"{"hooks":{"PreToolUse":[{"hooks":[{"command":"bsc-deny"}]}]}}"#).unwrap();
        let f = read_facts(Some(&dir)).unwrap();
        assert!(f.gate_present && !f.guest_hooks);
        assert_eq!(findings_for("nm:api", Some(f)), Vec::new());

        // ...and with the in-cage binary named, flagged.
        std::fs::write(dir.join(".claude").join("settings.json"), r#"{"hooks":{"PreToolUse":[{"hooks":[{"command":"/bsc-hook scope"}]}]}}"#).unwrap();
        assert!(read_facts(Some(&dir)).unwrap().guest_hooks);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_worktree_is_found_by_suffix_not_by_rebuilding_its_name() {
        // The naming rule is `<repo>--<stream>`, and this deliberately does not know that: a second
        // copy of the rule is the drift this module exists to surface. Reading the real directory
        // works whatever the repo half happens to be.
        let base = std::env::temp_dir().join(format!("bsc-fleet-wt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let wts = base.join("worktrees").join("network-monitor");
        std::fs::create_dir_all(wts.join("networkmonitor--omada-controller-adapter")).unwrap();
        std::fs::create_dir_all(wts.join("networkmonitor--omada")).unwrap();

        let hit = find_worktree(&base, "network-monitor", "omada-controller-adapter").unwrap();
        assert!(hit.ends_with("networkmonitor--omada-controller-adapter"));
        // A stream whose id is a PREFIX of another's must not match the longer directory.
        assert!(find_worktree(&base, "network-monitor", "omada").unwrap().ends_with("networkmonitor--omada"));
        assert_eq!(find_worktree(&base, "network-monitor", "nope"), None);
        // The director owns no stream, so it has nothing to look up.
        assert_eq!(find_worktree(&base, "network-monitor", ""), None);

        let _ = std::fs::remove_dir_all(&base);
    }
}
