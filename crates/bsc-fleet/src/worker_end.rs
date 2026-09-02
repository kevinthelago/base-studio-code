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
///
/// `Deserialize` as well as `Serialize` because this now crosses a PROCESS boundary: `bsc fleet
/// worker-end` writes it and the app's dispatcher reads it back. A type that only serializes is a
/// one-way contract, and the round trip is what the boundary actually needs.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

// ── Gathering the inputs, beside the decision they feed ──────────────────────────────────────

/// How much of `coord.log` the `landed` tiebreaker reads.
///
/// Mirrors the frontend's `readCoordState(5000)`, so moving this off the render loop cannot change
/// which refs read as landed. `coord.log` is one app-wide append-only file and the fold is re-derived
/// from this tail on every call, which is what makes the answer correct across a restart.
pub const COORD_TAIL_LINES: usize = 5000;

/// The resting-state verdict for each of `stream_ids`, index-aligned.
///
/// **This lives here, not in the app, so it can run in a process the app merely SPAWNS.** The app's
/// Rust half is a live process behind a webview: changing a decision that lives inside it means a new
/// binary, which means the window restarts under whoever is using it — with a fleet running in it.
/// `bsc` is a fresh process per call, so the same decision on this side goes live by staging a binary
/// (`a-resolved-request-goes-live-without-a-restart`, measured at 0.16s) with no app downtime.
///
/// `None` at a position means the project has NO PLAN STORE, and the caller must bail rather than end
/// the pane. Every other position carries a verdict, including for a stream that owns nothing — that
/// is `Some(needs-attention)`, because completion cannot be confirmed from an empty set. Collapsing
/// the two would either end a pane on the strength of a missing file, or leave an evidence-less worker
/// looking finished.
///
/// ONE READ FOR THE WHOLE BATCH. `stream_ids` is a list and both stores are read once, then
/// partitioned in memory. A per-stream call is the shape #3908 and #3954 were filed to undo: at ~39
/// panes it saturated the command pool and `pty_write` measured 3280ms.
pub fn worker_end_verdicts(
    plan_db: &std::path::Path,
    log_dir: &std::path::Path,
    stream_ids: &[String],
) -> Vec<Option<WorkerEndVerdict>> {
    let unknown = || vec![None; stream_ids.len()];

    // Probe existence first rather than letting `open_read_only` decide: the fleet launch asks about
    // every project, so this must never materialize an empty store as a side effect.
    if !plan_db.exists() {
        return unknown();
    }
    let Ok(store) = plandb::Store::open_read_only(plan_db) else { return unknown() };
    let Ok(all) = store.list_summary(None, None, None, None) else { return unknown() };

    let coord = coord_state(log_dir);
    stream_ids
        .iter()
        .map(|sid| {
            let issues: Vec<OwnedIssue> = all
                .iter()
                .filter(|i| i.stream.as_deref() == Some(sid.as_str()))
                .map(|i| OwnedIssue {
                    reference: i.r#ref.clone(),
                    status: i.status.clone(),
                    stream: i.stream.clone(),
                })
                .collect();
            Some(classify_worker_end(&issues, &coord))
        })
        .collect()
}

/// Fold the coordination log's tail into the state the `landed` tiebreaker reads.
///
/// Tolerant by design: an absent or unreadable `coord.log` yields the default state, in which nothing
/// is satisfied. That degrades `landed` to `0/n` in the SUMMARY and cannot change the verdict, because
/// `landed` never gates it — so a missing log costs a detail, never a wrong resting state.
fn coord_state(log_dir: &std::path::Path) -> CoordState {
    let lines = logs::tail_raw(log_dir, "coord", COORD_TAIL_LINES, true);
    logs::coord::ingest_coord_log(&lines, CoordState::default()).state
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

#[cfg(test)]
mod gather_tests {
    use super::*;

    /// A scratch tree with a plans dir and a log dir.
    ///
    /// NOTE these take EXPLICIT paths rather than repointing `HOME`. The app-side versions of these
    /// tests had to take `ENV_LOCK` because `bsc_base_dir()` resolves through the environment, and
    /// process-global env mutation behaves differently under `cargo test` (one shared process) and
    /// `cargo nextest` (one process per test). Passing the paths in removes the hazard entirely.
    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("bsc-we-{tag}-{}", bsc_util::now_ms()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("plans")).unwrap();
        d
    }

    fn seed(dir: &std::path::Path, key: &str, rows: &[(&str, &str, &str)]) -> std::path::PathBuf {
        let p = dir.join("plans").join(format!("{key}.db"));
        let store = plandb::Store::open(&p).unwrap();
        for (r, status, stream) in rows {
            store
                .upsert(&plandb::PlanIssue {
                    r#ref: (*r).into(),
                    title: (*r).into(),
                    status: (*status).into(),
                    stream: Some((*stream).into()),
                    ..Default::default()
                })
                .unwrap();
        }
        p
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// A project with NO plan store yields `None` — the caller bails rather than ending a pane on the
    /// strength of a missing file.
    #[test]
    fn an_absent_plan_store_is_unknown_not_a_verdict() {
        let d = scratch("absent");
        let got = worker_end_verdicts(&d.join("plans").join("nope.db"), &d, &ids(&["api", "web"]));
        assert_eq!(got.len(), 2, "still index-aligned");
        assert!(got.iter().all(|v| v.is_none()), "no store ⇒ no verdict: {got:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A store that EXISTS but holds nothing for the stream is a verdict, and it is not `done`. This
    /// is the line the TypeScript drew (`null` bails, `[]` classifies) and it must survive the move.
    #[test]
    fn an_empty_stream_in_a_live_store_is_a_verdict_and_never_done() {
        let d = scratch("empty");
        let db = seed(&d, "proj", &[("#1", "complete", "other")]);
        let got = worker_end_verdicts(&db, &d, &ids(&["api"]));
        let v = got[0].as_ref().expect("a live store always yields a verdict");
        assert_eq!(v.state, "needs-attention", "an empty owned set cannot confirm completion");
        assert!(v.summary.contains("can't confirm"), "got {:?}", v.summary);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The batch is INDEX-ALIGNED and each stream is judged on its OWN issues — a short, long or
    /// misordered result would attribute one worker's state to another.
    #[test]
    fn each_stream_is_judged_on_its_own_issues_in_order() {
        let d = scratch("align");
        let db = seed(
            &d,
            "proj",
            &[("#1", "complete", "api"), ("#2", "verified", "api"), ("#3", "open", "web"), ("#4", "blocked", "db")],
        );
        let got = worker_end_verdicts(&db, &d, &ids(&["web", "api", "db"]));
        let states: Vec<&str> = got.iter().map(|v| v.as_ref().unwrap().state.as_str()).collect();
        assert_eq!(
            states,
            vec!["needs-attention", "done", "blocked"],
            "each verdict belongs to the stream at its own index"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A missing `coord.log` degrades `landed` to a detail, never to a wrong verdict.
    #[test]
    fn an_unreadable_coord_log_cannot_change_the_verdict() {
        let d = scratch("nocoord");
        let db = seed(&d, "proj", &[("#1", "complete", "api")]);
        assert!(!d.join("coord.log").exists(), "precondition: no coord log");
        let v = worker_end_verdicts(&db, &d, &ids(&["api"]))[0].clone().unwrap();
        assert_eq!(v.state, "done", "the verdict stands without a coord log");
        assert!(v.summary.contains("0/1 landed"), "landed degrades to zero, reported: {:?}", v.summary);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// THE PROCESS BOUNDARY. The answer is three-state, and a JSON round trip is exactly where three
    /// states collapse into two — `null` and `needs-attention` both look "not done" to a careless
    /// reader, but one means BAIL and the other means the store answered.
    #[test]
    fn the_three_state_answer_survives_a_json_round_trip() {
        let d = scratch("wire");
        let db = seed(&d, "proj", &[("#1", "complete", "api")]);
        let real = worker_end_verdicts(&db, &d, &ids(&["api"]));
        let absent = worker_end_verdicts(&d.join("plans").join("nope.db"), &d, &ids(&["api"]));

        let mixed: Vec<Option<WorkerEndVerdict>> = vec![absent[0].clone(), real[0].clone()];
        let wire = serde_json::to_string(&mixed).unwrap();
        assert!(wire.starts_with("[null,"), "an absent store must serialize as null, got {wire}");

        let back: Vec<Option<WorkerEndVerdict>> = serde_json::from_str(&wire).unwrap();
        assert_eq!(back, mixed, "the round trip is lossless");
        assert!(back[0].is_none(), "null stayed null — the caller still bails");
        assert_eq!(back[1].as_ref().unwrap().state, "done", "and the verdict survived intact");
        let _ = std::fs::remove_dir_all(&d);
    }
}
