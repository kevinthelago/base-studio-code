//! The worker-end verdict, decided where the PTY exits (`the-worker-end-is-classified-where-the-pty-exits`).
//!
//! When a fleet worker's PTY exits, its resting state is decided from plan.db OWNED-ISSUE STATUS —
//! the structured, recovery-durable source of truth — not from the worker's free-text "I'm done".
//! Both inputs were already Rust's: [`plandb`] owns the statuses and [`logs`] owns the coordination
//! state the `landed` tiebreaker reads. Only the VERDICT ran in the renderer, which is the idle-reaper
//! failure with an enforcement action attached: a decision about a backend-owned resource that simply
//! stops happening when the webview dies.
//!
//! [`bsc_fleet::worker_end::classify_worker_end`] is the decision, parity-proved against 17 cases
//! generated from the live TypeScript. This module is only its CALLER: it gathers the two inputs and
//! hands them over. Nothing here restates the precedence.
//!
//! # Batched by construction, because the per-pane shape has already cost this repo twice
//!
//! [`worker_end_verdicts`] takes a LIST of stream ids and reads plan.db and `coord.log` ONCE for the
//! whole batch. The frontend's idle sweep evaluates every live worker on each of three log streams'
//! changes, and a per-pane command there is the exact shape `read_worktree_changes_batch` (#3908) and
//! then #3954 were filed to undo — at ~39 panes it saturated the command pool and everything queued
//! behind it, `pty_write` measured at 3280ms. The single-pane exit path calls this with a one-element
//! list rather than getting its own command, so there is one code path and not two.
//!
//! # `None` means "no plan.db", and it is not the same as an empty verdict
//!
//! A project with no plan store yields `None` for every stream, and the caller BAILS — it does not
//! end the pane. A project whose store exists but holds no issues for a stream yields
//! `Some(needs-attention)`, because completion cannot be confirmed from an empty set. Collapsing
//! those two would either end a pane on the strength of a missing file, or leave a genuinely
//! evidence-less worker looking finished. The TypeScript this replaces drew the same line — an absent
//! read returned `null` and bailed, while `[]` fell through to the classifier — and it is preserved
//! deliberately rather than by accident.

use crate::prelude::*;
use bsc_fleet::worker_end::{classify_worker_end, OwnedIssue, WorkerEndVerdict};

/// How much of `coord.log` the `landed` tiebreaker reads.
///
/// Mirrors the frontend's `readCoordState(5000)`, so the flip cannot change which refs read as
/// landed. `coord.log` is one app-wide append-only file; the fold is re-derived from this tail on
/// every call, which is what makes the answer correct across an app restart.
const COORD_TAIL_LINES: usize = 5000;

/// The resting-state verdict for each of `stream_ids`, index-aligned.
///
/// `None` at a position means the project has no plan store to read — see the module header; the
/// caller must bail rather than end the pane. Every other position carries a verdict, including for a
/// stream that owns nothing.
#[tauri::command]
pub(crate) fn worker_end_verdicts(
    project_key: String,
    stream_ids: Vec<String>,
) -> Vec<Option<WorkerEndVerdict>> {
    let unknown = || vec![None; stream_ids.len()];

    let path = plan_db_path(&project_key);
    // Probing existence first rather than letting `open_read_only` decide: the fleet launch asks
    // about every project, so this must never materialize an empty store as a side effect — the same
    // rule `plan_db::fleet_for` follows.
    if !path.exists() {
        return unknown();
    }
    let Ok(store) = plandb::Store::open_read_only(&path) else { return unknown() };
    // ONE read for the whole project, partitioned in memory (#3944). `IssueSummary` carries `stream`,
    // so a per-stream query would buy nothing a filter cannot do and would cost a round trip each.
    let Ok(all) = store.list_summary(None, None, None, None) else { return unknown() };

    let coord = coord_state();

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
fn coord_state() -> logs::coord::CoordState {
    let lines = logs::tail_raw(&logs::log_dir(), "coord", COORD_TAIL_LINES, true);
    logs::coord::ingest_coord_log(&lines, logs::coord::CoordState::default()).state
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{temp_home, ENV_LOCK};

    /// Point the base dir and the log dir at a scratch tree.
    ///
    /// `bsc_base_dir()` resolves through HOME/USERPROFILE, so `temp_home` is what actually moves
    /// `plan_db_path`; `BSC_LOG_DIR` moves the coord log separately. The guard is RETURNED so the env
    /// stays repointed for the whole test body — `cargo test` shares one process across parallel
    /// tests, and every one of these repoints the same globals.
    fn scratch(tag: &str) -> (std::path::PathBuf, std::sync::MutexGuard<'static, ()>) {
        let g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_home(&format!("worker-end-{tag}"));
        let base = dir.join(".base-studio-code");
        std::fs::create_dir_all(base.join("plans")).unwrap();
        std::env::set_var("BSC_LOG_DIR", &base);
        (dir, g)
    }

    fn seed(home: &std::path::Path, key: &str, rows: &[(&str, &str, &str)]) {
        let dir = home.join(".base-studio-code");
        let store = plandb::Store::open(&dir.join("plans").join(format!("{key}.db"))).unwrap();
        for (r, status, stream) in rows {
            let issue = plandb::PlanIssue {
                r#ref: (*r).into(),
                title: (*r).into(),
                status: (*status).into(),
                stream: Some((*stream).into()),
                ..Default::default()
            };
            store.upsert(&issue).unwrap();
        }
    }

    /// A project with NO plan store yields `None` — the caller bails rather than ending the pane on
    /// the strength of a missing file.
    #[test]
    fn an_absent_plan_store_is_unknown_not_a_verdict() {
        let (dir, _g) = scratch("absent");
        let got = worker_end_verdicts("no-such-project".into(), vec!["api".into(), "web".into()]);
        assert_eq!(got.len(), 2, "still index-aligned");
        assert!(got.iter().all(|v| v.is_none()), "no store ⇒ no verdict: {got:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A store that EXISTS but holds nothing for the stream is a verdict, and it is not `done`.
    /// This is the line the TypeScript drew (`null` bails, `[]` classifies) and it must survive.
    #[test]
    fn an_empty_stream_in_a_live_store_is_a_verdict_and_never_done() {
        let (dir, _g) = scratch("empty");
        seed(&dir, "proj", &[("#1", "complete", "other")]);
        let got = worker_end_verdicts("proj".into(), vec!["api".into()]);
        let v = got[0].as_ref().expect("a live store always yields a verdict");
        assert_eq!(v.state, "needs-attention", "an empty owned set cannot confirm completion");
        assert!(v.summary.contains("can't confirm"), "got {:?}", v.summary);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The batch is INDEX-ALIGNED and each stream is judged on its OWN issues — a short, long or
    /// misordered result would attribute one worker's state to another.
    #[test]
    fn each_stream_is_judged_on_its_own_issues_in_order() {
        let (dir, _g) = scratch("align");
        seed(
            &dir,
            "proj",
            &[
                ("#1", "complete", "api"),
                ("#2", "verified", "api"),
                ("#3", "open", "web"),
                ("#4", "blocked", "db"),
            ],
        );
        let got = worker_end_verdicts("proj".into(), vec!["web".into(), "api".into(), "db".into()]);
        let states: Vec<&str> = got.iter().map(|v| v.as_ref().unwrap().state.as_str()).collect();
        assert_eq!(
            states,
            vec!["needs-attention", "done", "blocked"],
            "each verdict belongs to the stream at its own index"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A missing `coord.log` degrades `landed` to a detail, never to a wrong verdict.
    #[test]
    fn an_unreadable_coord_log_cannot_change_the_verdict() {
        let (dir, _g) = scratch("nocoord");
        seed(&dir, "proj", &[("#1", "complete", "api")]);
        assert!(!dir.join(".base-studio-code").join("coord.log").exists(), "precondition: no coord log");
        let v = worker_end_verdicts("proj".into(), vec!["api".into()])[0].clone().unwrap();
        assert_eq!(v.state, "done", "the verdict stands without a coord log");
        assert!(v.summary.contains("0/1 landed"), "landed degrades to zero, reported: {:?}", v.summary);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
