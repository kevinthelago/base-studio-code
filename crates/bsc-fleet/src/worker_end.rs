//! The worker-end verdict — what a finished fleet worker's resting state is.
//!
//! When a worker's PTY exits, its state is decided from plan.db OWNED-ISSUE STATUS, the structured,
//! recovery-durable source of truth — NOT from the worker's free-text "I'm done". Both inputs are
//! already Rust's: [`plandb`] owns the statuses and [`logs`] owns the coordination state the landed
//! tiebreaker reads. Only the verdict ran in the renderer.
//!
//! # There were two definitions of done-ness, and nothing compared them
//!
//! `plandb::DONE_STATUSES` says of itself: *"the Rust half of the frontend's `TERMINAL_GOOD`.
//! Both must name the same set: `bsc project progress` counts done with this, the graph's progress bar
//! counts it with that, and a silent disagreement would put a bar and a 'finished' card on the same
//! node saying different things."* That agreement was prose on both sides.
//! `the_two_definitions_of_done_name_the_same_set` is the test that was missing — the same shape as the
//! `__bsc_deny_all__` sentinel, where a drift is silent and the symptom is two numbers about one piece
//! of work that quietly differ.
//!
//! This module does not restate the set: it reads [`plandb::is_done_status`].
//!
//! # The precedence, and why each rung refuses to guess
//!
//! 1. any blocked/failed ⇒ **blocked**;
//! 2. else any still-open ⇒ **needs-attention** — a worker that stopped early is the case this exists
//!    to catch, and it must NEVER read as done;
//! 3. else all complete/verified ⇒ **done**;
//! 4. an EMPTY owned-issue set ⇒ needs-attention, because completion cannot be CONFIRMED from the DB —
//!    an absence of evidence is not evidence of completion;
//! 5. an UNKNOWN status counts as still-running, so a typo can never inflate a completion.
//!
//! # `landed` is reported, never decisive
//!
//! The count of owned refs the coordination log marks satisfied goes in the SUMMARY and does not gate
//! the verdict. A worker's card closes on worker-finished; merged/verified is the director's separate
//! confirmation. Conflating them is exactly how "marked complete but the PR never merged" would stop
//! being visible.

use logs::coord::{is_satisfied, parse_ref, CoordState};
use plandb::is_done_status;

/// Statuses meaning the work has not finished and has not failed.
const STILL_RUNNING: &[&str] = &["open", "in_progress"];
/// Statuses meaning something needs attention before the work can finish.
const TERMINAL_BAD: &[&str] = &["blocked", "failed"];

/// One owned issue's ref and its plan.db lifecycle status.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct OwnedIssue {
    #[serde(rename = "ref")]
    pub reference: String,
    pub status: String,
    #[serde(default)]
    pub stream: Option<String>,
}

/// The verdict, and the sentence explaining it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct WorkerEndVerdict {
    pub state: String,
    pub summary: String,
}

/// Classify a finished worker from its owned issues and the coordination state.
pub fn classify_worker_end(issues: &[OwnedIssue], coord: &CoordState) -> WorkerEndVerdict {
    if issues.is_empty() {
        return WorkerEndVerdict {
            state: "needs-attention".into(),
            summary: "no owned issues in plan.db — can't confirm completion".into(),
        };
    }

    let (mut good, mut running, mut bad) = (0usize, 0usize, 0usize);
    for i in issues {
        let s = i.status.as_str();
        if TERMINAL_BAD.contains(&s) {
            bad += 1;
        } else if STILL_RUNNING.contains(&s) {
            running += 1;
        } else if is_done_status(s) {
            good += 1;
        } else {
            // An UNKNOWN status is conservatively not-done.
            running += 1;
        }
    }

    let landed = issues
        .iter()
        .filter(|i| parse_ref(&i.reference).is_some_and(|r| is_satisfied(coord, &r)))
        .count();

    let n = issues.len();
    if bad > 0 {
        return WorkerEndVerdict {
            state: "blocked".into(),
            summary: format!("{bad}/{n} blocked or failed · {good}/{n} complete"),
        };
    }
    if running > 0 {
        return WorkerEndVerdict {
            state: "needs-attention".into(),
            summary: format!("stopped early — {running}/{n} still open · {good}/{n} complete"),
        };
    }
    WorkerEndVerdict {
        state: "done".into(),
        summary: format!("{n}/{n} complete · {landed}/{n} landed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use logs::coord::{LatchStatus, SatisfySource};

    fn fixture() -> serde_json::Value {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("workerEnd.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one workerEnd.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// THE TEST THAT WAS MISSING. Two definitions of done-ness, one per language, each with a comment
    /// saying they must agree — and nothing comparing them until now. A drift is silent, and the
    /// symptom is a progress bar and a "finished" card on the same node saying different things.
    #[test]
    fn the_two_definitions_of_done_name_the_same_set() {
        let doc = fixture();
        let ts: Vec<String> =
            doc["terminalGood"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        let mut rs: Vec<String> = plandb::DONE_STATUSES.iter().map(|s| (*s).to_string()).collect();
        rs.sort();
        assert_eq!(ts, rs, "TERMINAL_GOOD and DONE_STATUSES have drifted apart");

        // And the predicate agrees with the set it is derived from, in both directions.
        for s in &rs {
            assert!(is_done_status(s), "{s} is in DONE_STATUSES but is_done_status says otherwise");
        }
        for s in ["open", "in_progress", "blocked", "failed", "wat"] {
            assert!(!is_done_status(s), "{s} must not count as done");
        }
    }

    fn coord_with(landed: &[String]) -> CoordState {
        let mut s = CoordState::default();
        for r in landed {
            if let Some(parsed) = parse_ref(r) {
                s.latches.insert(
                    logs::coord::ref_key(&parsed),
                    LatchStatus::Satisfied { source: SatisfySource::Merged, at: 1 },
                );
            }
        }
        s
    }

    /// Reports every mismatch at once — a wrong precedence is wrong for a whole class of worker.
    #[test]
    fn the_worker_end_verdict_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 15, "fixture shrank to {} cases — regenerate it", cases.len());

        let mut seen = std::collections::BTreeSet::new();
        let mut mismatches = Vec::new();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let issues: Vec<OwnedIssue> = serde_json::from_value(case["issues"].clone())
                .unwrap_or_else(|e| panic!("{label}: issues did not deserialize: {e}"));
            let landed: Vec<String> =
                case["landed"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
            let want_state = case["verdict"]["state"].as_str().unwrap();
            let want_summary = case["verdict"]["summary"].as_str().unwrap();
            seen.insert(want_state.to_string());

            let got = classify_worker_end(&issues, &coord_with(&landed));
            if got.state != want_state || got.summary != want_summary {
                mismatches.push(format!(
                    "  {label}\n    ts   {want_state} · {want_summary:?}\n    rust {} · {:?}",
                    got.state, got.summary
                ));
            }
        }
        // All three verdicts must occur, or the precedence is untested at one of its rungs.
        assert_eq!(
            seen.into_iter().collect::<Vec<_>>(),
            vec!["blocked".to_string(), "done".into(), "needs-attention".into()],
            "the corpus does not reach every verdict"
        );
        assert!(
            mismatches.is_empty(),
            "the Rust classifier disagrees with the live TypeScript on {} of {} cases:\n{}",
            mismatches.len(),
            cases.len(),
            mismatches.join("\n")
        );
    }

    fn issue(reference: &str, status: &str) -> OwnedIssue {
        OwnedIssue { reference: reference.into(), status: status.into(), stream: None }
    }

    /// An absence of evidence is not evidence of completion.
    #[test]
    fn an_empty_owned_set_cannot_confirm_completion() {
        let v = classify_worker_end(&[], &CoordState::default());
        assert_eq!(v.state, "needs-attention");
        assert!(v.summary.contains("can't confirm"));
    }

    /// The rung this exists to catch: a worker that stopped early must NEVER read as done.
    #[test]
    fn a_still_open_issue_is_never_silently_done() {
        let v = classify_worker_end(
            &[issue("#1", "complete"), issue("#2", "open")],
            &CoordState::default(),
        );
        assert_eq!(v.state, "needs-attention");
        assert!(v.summary.starts_with("stopped early"));
    }

    /// Blocked outranks everything, including a set that is otherwise complete.
    #[test]
    fn blocked_outranks_open_and_complete_alike() {
        for bad in ["blocked", "failed"] {
            let v = classify_worker_end(
                &[issue("#1", bad), issue("#2", "complete")],
                &CoordState::default(),
            );
            assert_eq!(v.state, "blocked", "{bad} must win");
        }
    }

    /// The three constants must PARTITION plan.db's whole status vocabulary.
    ///
    /// Deleting the `STILL_RUNNING` branch outright does not fail any parity case — "open" falls
    /// through to the unknown arm and is counted as running anyway. So the branch is inert and the
    /// CONTENT of the constant is what carries meaning; this is the test that checks the content.
    /// It also catches the change that would actually hurt: a SEVENTH status added to `STATUSES`
    /// gets silently classified as still-running here, and a worker owning one would sit in
    /// needs-attention forever with nothing naming the cause.
    #[test]
    fn the_three_constants_partition_the_whole_status_vocabulary() {
        let mut covered: Vec<&str> = STILL_RUNNING
            .iter()
            .chain(TERMINAL_BAD.iter())
            .chain(plandb::DONE_STATUSES.iter())
            .copied()
            .collect();
        let n = covered.len();
        covered.sort_unstable();
        covered.dedup();
        assert_eq!(covered.len(), n, "the three sets overlap: {covered:?}");

        let mut all: Vec<&str> = plandb::STATUSES.to_vec();
        all.sort_unstable();
        assert_eq!(
            covered, all,
            "a plan.db status is unaccounted for here — classify it deliberately rather than \
             letting it fall into the unknown arm"
        );
    }

    /// A typo must never inflate a completion — and neither may a PLAUSIBLE synonym.
    ///
    /// "done"/"closed"/"merged" are the words a future restatement of the done-set would reach for,
    /// and plan.db rejects every one of them (`is_valid_status("done")` is false). Without them in
    /// this list, inlining `s == "complete" || s == "verified" || s == "done"` in place of
    /// `is_done_status` passes the entire parity corpus — which is precisely the drift this module
    /// exists to make impossible.
    #[test]
    fn an_unknown_status_counts_as_not_done() {
        for s in ["wat", "done", "closed", "merged", "landed", "finished", "COMPLETE", ""] {
            assert!(!plandb::is_valid_status(s), "{s:?} is a real status — pick another probe");
            let v = classify_worker_end(&[issue("#1", s)], &CoordState::default());
            assert_eq!(v.state, "needs-attention", "{s:?} must not read as done");
        }
    }

    /// `landed` is REPORTED, not decisive — that separation is what keeps "marked complete but the PR
    /// never merged" visible instead of collapsing it into the verdict.
    #[test]
    fn landed_is_reported_but_never_gates_the_verdict() {
        let issues = [issue("#1", "complete")];
        let none = classify_worker_end(&issues, &CoordState::default());
        let all = classify_worker_end(&issues, &coord_with(&["#1".to_string()]));
        assert_eq!(none.state, "done");
        assert_eq!(all.state, "done", "landing does not change the verdict");
        assert_ne!(none.summary, all.summary, "but it IS reported — 0/1 landed vs 1/1");

        // And it cannot rescue a blocked worker.
        let blocked = classify_worker_end(&[issue("#1", "blocked")], &coord_with(&["#1".to_string()]));
        assert_eq!(blocked.state, "blocked");
    }
}
