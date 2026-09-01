//! The worker auto-end decision, derived in Rust
//! (`epic-frontend-logic-over-backend-resources-belongs-in-rust`).
//!
//! ## Why it moved
//!
//! This is the same class as the idle reaper, and that precedent is the argument.
//! `the-idle-reaper-dies-with-the-webview-and-a-parked-agent-is-never-idle` moved the reaper out of a
//! React hook into `console::pty::reap` because a dead webview meant nothing bounded the session
//! count — measured at the time: the renderer was OOM-killed and the backend ran headless for fifteen
//! minutes with 17 sessions alive, fifteen of them agents that had never used a second of CPU.
//!
//! `decide_worker_auto_end` is the same shape: an idle-time decision that simply stops happening when
//! the renderer dies, silently, exactly when a fleet has been left running unattended.
//!
//! The decision is small and total, and being small is not an argument against moving it — it is what
//! makes the parity cheap to prove. Pinned against `workerAutoEnd.fixtures.json`, generated from the
//! live TypeScript.
//!
//! ## Scope
//!
//! `worker-end.ts`'s `classifyWorkerEnd` is deliberately NOT here: it depends on the coordination
//! state, which another lane owns. The verdict enters as a VALUE, so this needs the state and not the
//! classifier.
#![allow(dead_code)] // wired by its own slice — nothing calls this yet, by design

use serde::{Deserialize, Serialize};

/// What to do for an at-rest worker this tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutoEndAction {
    /// Still working, or not idle long enough.
    None,
    /// Idle, no question, work complete — nudge it to close itself.
    CloseNudge,
    /// Idle past the lost-question wait with an unanswered ask — resurface it.
    ResurfaceQuestion,
}

/// The worker's plan.db-derived end state. Produced by the classifier this module deliberately does
/// not own; it arrives as a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkerEndState {
    Done,
    NeedsAttention,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerEndVerdict {
    pub state: WorkerEndState,
    #[serde(default)]
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoEndSignals {
    /// The turn is still open — the worker is actively working. Never act.
    pub turn_open: bool,
    /// How long the worker has been at rest, in ms.
    pub idle_ms: u64,
    pub has_outstanding_question: bool,
    pub verdict: WorkerEndVerdict,
    /// A pane the user is looking at is never acted on behind their back.
    #[serde(default)]
    pub focused: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoEndThresholds {
    pub close_nudge_ms: u64,
    pub lost_question_ms: u64,
}

pub const DEFAULT_CLOSE_NUDGE_MS: u64 = 60_000;
pub const DEFAULT_LOST_QUESTION_MS: u64 = 300_000;

impl Default for AutoEndThresholds {
    fn default() -> Self {
        Self { close_nudge_ms: DEFAULT_CLOSE_NUDGE_MS, lost_question_ms: DEFAULT_LOST_QUESTION_MS }
    }
}

/// Decide what to do with an at-rest worker.
///
/// ORDER IS THE CONTRACT. `turn_open` and `focused` short-circuit before anything else, so a worker
/// that is working — or a pane the user is watching — is never acted on however idle the clock says
/// it is. An outstanding question then takes precedence over the close-nudge: a worker waiting on an
/// answer is not finished, whatever its issues say, so it waits for `lost_question_ms` and is
/// resurfaced rather than closed.
///
/// The comparisons are `>=`, not `>`: a threshold is the moment it fires, and both sides of each are
/// pinned by the fixture.
pub fn decide_worker_auto_end(s: &AutoEndSignals, t: &AutoEndThresholds) -> AutoEndAction {
    if s.turn_open || s.focused {
        return AutoEndAction::None;
    }
    if s.has_outstanding_question {
        return if s.idle_ms >= t.lost_question_ms {
            AutoEndAction::ResurfaceQuestion
        } else {
            AutoEndAction::None
        };
    }
    if s.idle_ms >= t.close_nudge_ms && s.verdict.state == WorkerEndState::Done {
        return AutoEndAction::CloseNudge;
    }
    AutoEndAction::None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE PORT IS PROVED EQUAL, NOT INSPECTED. `workerAutoEnd.fixtures.json` is GENERATED from the
    /// live TypeScript across every branch and BOTH sides of both thresholds.
    ///
    /// Resolved by FILENAME under `src/`, the same rule the tunnel contract uses — renaming the
    /// fixture means updating this in lockstep.
    #[test]
    fn rust_decides_the_same_action_as_the_typescript() {
        fn find(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    find(&p, out);
                } else if p.file_name().and_then(|n| n.to_str())
                    == Some("workerAutoEnd.fixtures.json")
                {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        find(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one workerAutoEnd.fixtures.json, got {found:?}");
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap();

        // The packaged thresholds must not drift from the TypeScript's.
        let d = &doc["defaults"];
        assert_eq!(d["closeNudgeMs"].as_u64().unwrap(), DEFAULT_CLOSE_NUDGE_MS);
        assert_eq!(d["lostQuestionMs"].as_u64().unwrap(), DEFAULT_LOST_QUESTION_MS);

        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 12, "the fixture must cover the branches: {}", cases.len());
        let mut seen = std::collections::HashSet::new();
        for c in cases {
            let name = c["name"].as_str().unwrap_or("?");
            let signals: AutoEndSignals = serde_json::from_value(c["signals"].clone())
                .unwrap_or_else(|e| panic!("signals for `{name}`: {e}"));
            let thresholds: AutoEndThresholds = serde_json::from_value(c["thresholds"].clone())
                .unwrap_or_else(|e| panic!("thresholds for `{name}`: {e}"));
            let want: AutoEndAction = serde_json::from_value(c["action"].clone())
                .unwrap_or_else(|e| panic!("action for `{name}`: {e}"));
            assert_eq!(
                decide_worker_auto_end(&signals, &thresholds),
                want,
                "action differs for `{name}`"
            );
            seen.insert(want);
        }
        assert_eq!(seen.len(), 3, "every action must be exercised, got {seen:?}");
    }

    /// A pane the user is looking at is never closed behind their back — even with a done verdict and
    /// an idle clock far past the nudge threshold.
    #[test]
    fn a_focused_pane_is_never_acted_on() {
        let s = AutoEndSignals {
            turn_open: false,
            idle_ms: u64::MAX,
            has_outstanding_question: true,
            verdict: WorkerEndVerdict { state: WorkerEndState::Done, summary: String::new() },
            focused: true,
        };
        assert_eq!(decide_worker_auto_end(&s, &AutoEndThresholds::default()), AutoEndAction::None);
    }
}
