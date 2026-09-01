//! The boot worktree reconciliation — healing the fleet split-brain where it is caused.
//!
//! The boot GC ([`gc_worktrees_impl`]) reclaims a fleet worker's git worktree DIRECTORY, but the
//! persisted `<project> · build` tab and its pane records survive. So the next boot mounts the ghost
//! tab and relaunches workers into directories the app itself deleted — a burst of doomed PTYs that
//! jams the backend event loop and reads as the whole app freezing. The reconciliation marks such a
//! worker ENDED so its tab renders a resting card instead.
//!
//! # Why the decision belongs here
//!
//! Every input is already Rust's. Rust owns the worktrees, runs the GC, and `gc_worktrees_on_boot`
//! **already returns the exact set it reclaimed**, as `<key>/<name>`. The renderer nonetheless
//! re-derives the same fact by probing `dir_exists` once per pane and inferring a verdict from the
//! absence — a weaker signal, asked of a process that may not be alive to ask it.
//!
//! # The claim this module pins and does NOT fix
//!
//! [`reclaimed_worker_end`] reports `done` with the summary *"worktree reclaimed — work merged"*,
//! unconditionally. The GC's condition is:
//!
//! ```text
//! disposable = hub_gone || worktree_is_disposable(clone, wt)
//! ```
//!
//! Only the SECOND arm proves clean + merged. The first — an abandoned project whose hub is gone —
//! proves neither, and removes the worktree whatever state it is in. `gc_worktrees_impl` logs which
//! arm fired (`"orphan project"` vs `"merged+clean"`) and then drops it into a log string. So every
//! orphan-arm reclaim produces a green resting card asserting work landed that may never have been
//! written. `the_verdict_claims_merged_work_it_cannot_prove` names it; the fix is
//! `a-reclaimed-worktree-reports-why-it-was-reclaimed`, deliberately a separate item because carrying
//! the reason is a behaviour change and this one is a port.
//!
//! It also sits opposite [`crate::worker_end::classify_worker_end`], which refuses to say `done`
//! without plan.db evidence on the ground that absence of evidence is not evidence of completion. A
//! directory absence is strictly weaker than an empty owned-issue set, and it is currently enough to
//! produce the verdict the other one declines. Both write the same `EndedInfo.state`.
//!
//! Pinned against `worktreeReconcile.fixtures.json`, generated from the live TypeScript.

/// One persisted pane, as the store holds it.
///
/// Deliberately an ORDERED SLICE rather than a map: the live selector iterates the store's insertion
/// order and its output order is part of the contract. A `BTreeMap` port would have sorted
/// `web, api, db` into `api, db, web` — which the fixture's third case exists to catch.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneRecord {
    pub pane_id: String,
    /// The fleet stream this pane owns, if it is a fleet worker at all.
    #[serde(default)]
    pub stream: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub ended: bool,
    #[serde(default)]
    pub disabled: bool,
}

/// A worker pane whose worktree should be probed at boot.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCheck {
    pub pane_id: String,
    pub cwd: String,
    pub stream_id: String,
}

/// What a finished worker's card records. Mirrors the frontend `EndedInfo`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndedInfo {
    pub state: String,
    pub stream_id: String,
    pub summary: String,
    pub at: i64,
}

/// One pane marked ended by the reconciliation, with the whole record it was marked with.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct EndedMark {
    pub pane_id: String,
    pub info: EndedInfo,
}

/// Which persisted panes to worktree-check at boot.
///
/// Fleet-stream MEMBERSHIP is the worker filter, not the cwd map — pane roles are not persisted. A
/// pane is skipped when it owns no stream, has no cwd (an EMPTY cwd counts as none: there is nothing
/// to probe), or is already ended or disabled.
pub fn worktree_checks(panes: &[PaneRecord]) -> Vec<WorktreeCheck> {
    panes
        .iter()
        .filter(|p| !p.ended && !p.disabled)
        .filter_map(|p| {
            let stream = p.stream.as_deref().filter(|s| !s.is_empty())?;
            let cwd = p.cwd.as_deref().filter(|c| !c.is_empty())?;
            Some(WorktreeCheck {
                pane_id: p.pane_id.clone(),
                cwd: cwd.to_string(),
                stream_id: stream.to_string(),
            })
        })
        .collect()
}

/// WHY a worktree is gone — carried out of the GC at the moment it reclaimed, because it cannot be
/// recovered afterwards.
///
/// `worktree_is_disposable` answers by comparing the worktree's HEAD against its owning CLONE, and it
/// opens by requiring `clone/.git` to exist. On the orphan path the hub and the clone are ALREADY
/// DELETED, so no later probe can ask whether that work landed. The GC is the only moment the answer
/// exists, which is why the reason travels rather than being re-derived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReclaimReason {
    /// The GC proved the tree CLEAN and its HEAD an ancestor of the clone's. The work landed.
    MergedClean,
    /// The project hub was gone, so the GC removed the worktree whatever state it was in. This proves
    /// NOTHING about the work — it is the arm that used to render as `done`.
    OrphanProject,
    /// The worktree is missing and the GC did not record reclaiming it: removed by hand, by
    /// `worktrees:cap`, or reclaimed before this ledger existed. Also unproven, and DISTINCT from the
    /// orphan arm — "we removed it and could not check" is not "we do not know who removed it".
    Unrecorded,
}

impl ReclaimReason {
    /// Whether this reason is evidence the work actually landed. Only one arm is.
    pub fn proves_merged(self) -> bool {
        matches!(self, ReclaimReason::MergedClean)
    }
}

/// The record written for a worker whose worktree vanished, given WHY it vanished.
///
/// Only [`ReclaimReason::MergedClean`] earns `done`. The other two report `needs-attention` and say
/// what is actually known, because the alternative — the behaviour this replaces — was a green resting
/// card asserting work landed that may never have been written.
///
/// This is deliberately the same epistemics as [`crate::worker_end::classify_worker_end`], which
/// refuses `done` without plan.db evidence on the ground that absence of evidence is not evidence of
/// completion. Two producers write `EndedInfo.state`; they now agree about what absence means.
pub fn reclaimed_worker_end(stream_id: &str, at: i64, reason: ReclaimReason) -> EndedInfo {
    let (state, summary) = match reason {
        ReclaimReason::MergedClean => ("done", "worktree reclaimed — work merged; session closed"),
        ReclaimReason::OrphanProject => (
            "needs-attention",
            "worktree reclaimed — project hub was gone, so the work was never checked; it may not have landed",
        ),
        ReclaimReason::Unrecorded => (
            "needs-attention",
            "worktree missing — not reclaimed by the boot GC, so whether the work landed is unrecorded",
        ),
    };
    EndedInfo { state: state.into(), stream_id: stream_id.into(), summary: summary.into(), at }
}

/// Mark every candidate whose worktree is gone as ended, so it renders a resting card instead of
/// relaunching into a deleted directory.
///
/// `exists` is the existence probe and MUST default to true on failure — a probe that cannot answer
/// may never end a live worker. `is_ended` re-checks at the moment of marking, so a pane ended by
/// another path meanwhile is left alone.
pub fn reconcile_missing_worktrees(
    checks: &[WorktreeCheck],
    exists: &dyn Fn(&str) -> bool,
    is_ended: &dyn Fn(&str) -> bool,
    reason_of: &dyn Fn(&str) -> ReclaimReason,
    now: i64,
) -> Vec<EndedMark> {
    checks
        .iter()
        .filter(|c| !exists(&c.cwd))
        .filter(|c| !is_ended(&c.pane_id))
        .map(|c| EndedMark {
            pane_id: c.pane_id.clone(),
            info: reclaimed_worker_end(&c.stream_id, now, reason_of(&c.cwd)),
        })
        .collect()
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
                } else if p.file_name().and_then(|n| n.to_str())
                    == Some("worktreeReconcile.fixtures.json")
                {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one worktreeReconcile.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// Whole `WorktreeCheck` values, IN ORDER — a set comparison would call a reordered list equal,
    /// and the order is exactly what a map-based port gets wrong.
    #[test]
    fn the_selection_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["select"].as_array().expect("select");
        assert!(cases.len() >= 10, "the corpus shrank to {} cases — regenerate it", cases.len());

        let mut mismatches = Vec::new();
        let mut saw_empty_output = false;
        let mut saw_multi_output = false;
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let panes: Vec<PaneRecord> = serde_json::from_value(case["panes"].clone())
                .unwrap_or_else(|e| panic!("{label}: panes did not deserialize: {e}"));
            let want: Vec<WorktreeCheck> = serde_json::from_value(case["checks"].clone()).unwrap();
            let got = worktree_checks(&panes);
            if got.is_empty() {
                saw_empty_output = true;
            }
            if got.len() > 1 {
                saw_multi_output = true;
            }
            if got != want {
                mismatches.push(format!("  {label}\n    ts   {want:?}\n    rust {got:?}"));
            }
        }
        assert!(saw_empty_output, "no case selects nothing — the skips are untested");
        assert!(saw_multi_output, "no case selects more than one — the ORDER is untested");
        assert!(
            mismatches.is_empty(),
            "the Rust selector disagrees on {} of {} cases:\n{}",
            mismatches.len(),
            cases.len(),
            mismatches.join("\n")
        );
    }

    /// Whole `EndedInfo` values for every pane marked, in order.
    #[test]
    fn the_reconciliation_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let now = doc["now"].as_i64().expect("now");
        let cases = doc["reconcile"].as_array().expect("reconcile");
        assert!(cases.len() >= 7, "the corpus shrank to {} cases — regenerate it", cases.len());

        let mut mismatches = Vec::new();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let checks: Vec<WorktreeCheck> = serde_json::from_value(case["checks"].clone()).unwrap();
            let present: Vec<String> =
                serde_json::from_value(case["present"].clone()).unwrap();
            let already: Vec<String> =
                serde_json::from_value(case["alreadyEnded"].clone()).unwrap();

            // The reason map the GC ledger supplies, keyed by cwd. A case that names none falls
            // through to `Unrecorded`, which is the honest reading of "the GC did not record this".
            let reasons: std::collections::HashMap<String, ReclaimReason> =
                serde_json::from_value(case.get("reasons").cloned().unwrap_or(serde_json::json!({})))
                    .unwrap();
            let got = reconcile_missing_worktrees(
                &checks,
                &|cwd| present.iter().any(|p| p == cwd),
                &|pane| already.iter().any(|p| p == pane),
                &|cwd| reasons.get(cwd).copied().unwrap_or(ReclaimReason::Unrecorded),
                now,
            );

            // The pane ids the TypeScript returned, and the WHOLE records it marked.
            let want_ended: Vec<String> = serde_json::from_value(case["ended"].clone()).unwrap();
            let got_ended: Vec<String> = got.iter().map(|m| m.pane_id.clone()).collect();
            if got_ended != want_ended {
                mismatches.push(format!(
                    "  {label} (ended)\n    ts   {want_ended:?}\n    rust {got_ended:?}"
                ));
            }
            for (idx, mark) in case["marked"].as_array().unwrap().iter().enumerate() {
                let want_pane = mark["paneId"].as_str().unwrap();
                let want_info: EndedInfo = serde_json::from_value(mark["info"].clone()).unwrap();
                match got.get(idx) {
                    None => mismatches
                        .push(format!("  {label} (marked[{idx}])\n    rust marked nothing")),
                    Some(g) if g.pane_id != want_pane || g.info != want_info => mismatches.push(
                        format!(
                            "  {label} (marked[{idx}])\n    ts   {want_pane} {want_info:?}\n    rust {} {:?}",
                            g.pane_id, g.info
                        ),
                    ),
                    Some(_) => {}
                }
            }
            assert_eq!(
                got.len(),
                case["marked"].as_array().unwrap().len(),
                "{label}: marked a different NUMBER of panes"
            );
        }
        assert!(
            mismatches.is_empty(),
            "the Rust reconciliation disagrees on {} case(s):\n{}",
            mismatches.len(),
            mismatches.join("\n")
        );
    }

    #[test]
    fn the_verdict_matches_the_typescript_verbatim() {
        let doc = fixture();
        let now = doc["now"].as_i64().unwrap();
        for v in doc["verdicts"].as_array().unwrap() {
            let stream = v["streamId"].as_str().unwrap();
            let want: EndedInfo = serde_json::from_value(v["info"].clone()).unwrap();
            let reason: ReclaimReason = serde_json::from_value(v["reason"].clone()).unwrap();
            assert_eq!(reclaimed_worker_end(stream, now, reason), want, "stream {stream:?}");
        }
    }

    /// THE DEFECT IS FIXED, and this is what replaced the characterization that pinned it.
    ///
    /// `the_verdict_claims_merged_work_it_cannot_prove` asserted the old behaviour — `done` +
    /// "work merged" for BOTH GC arms — and was written to be deleted by this item rather than to
    /// endorse what it described. Only the arm that actually proved clean + merged earns `done` now.
    #[test]
    fn only_a_proved_reclaim_reports_done() {
        let merged = reclaimed_worker_end("api", 1, ReclaimReason::MergedClean);
        assert_eq!(merged.state, "done");
        assert!(merged.summary.contains("work merged"));

        // The orphan arm removes a worktree WHATEVER state it is in, so it proves nothing.
        let orphan = reclaimed_worker_end("api", 1, ReclaimReason::OrphanProject);
        assert_ne!(orphan.state, "done", "an unproved reclaim must not read as done");
        assert!(!orphan.summary.contains("work merged"), "and must not claim it: {}", orphan.summary);
        assert!(orphan.summary.contains("may not have landed"), "{}", orphan.summary);

        // ...and "we never recorded reclaiming this" is DISTINCT from "we reclaimed it unchecked".
        let unknown = reclaimed_worker_end("api", 1, ReclaimReason::Unrecorded);
        assert_ne!(unknown.state, "done");
        assert_ne!(
            unknown.summary, orphan.summary,
            "a worktree missing for neither GC reason must be distinguishable from the orphan arm"
        );
    }

    /// The two `EndedInfo.state` producers now AGREE about what absence means. They used to disagree:
    /// a directory absence yielded `done` where an empty owned-issue set yields `needs-attention`,
    /// which is strictly stronger evidence. Pinned so the epistemics cannot silently diverge again.
    #[test]
    fn an_unproved_reclaim_agrees_with_the_plan_db_classifier() {
        let from_dir = reclaimed_worker_end("api", 1, ReclaimReason::OrphanProject);
        let from_plan_db = crate::worker_end::classify_worker_end(&[], &Default::default());
        assert_eq!(from_plan_db.state, "needs-attention");
        assert_eq!(
            from_dir.state, from_plan_db.state,
            "absence of evidence must mean the same thing to both verdict producers",
        );
    }

    /// Only one reason is evidence of anything, and the predicate says so in one place.
    #[test]
    fn exactly_one_reason_proves_merged() {
        assert!(ReclaimReason::MergedClean.proves_merged());
        assert!(!ReclaimReason::OrphanProject.proves_merged());
        assert!(!ReclaimReason::Unrecorded.proves_merged());
    }

    fn pane(id: &str, stream: Option<&str>, cwd: Option<&str>) -> PaneRecord {
        PaneRecord {
            pane_id: id.into(),
            stream: stream.map(Into::into),
            cwd: cwd.map(Into::into),
            ended: false,
            disabled: false,
        }
    }

    /// Each skip on its own, so losing one cannot hide inside a case that skips for two reasons.
    #[test]
    fn each_skip_stands_alone() {
        assert!(worktree_checks(&[pane("p", None, Some("/wt"))]).is_empty(), "no stream");
        assert!(worktree_checks(&[pane("p", Some("s"), None)]).is_empty(), "no cwd");
        assert!(worktree_checks(&[pane("p", Some("s"), Some(""))]).is_empty(), "empty cwd");
        assert_eq!(worktree_checks(&[pane("p", Some("s"), Some("/wt"))]).len(), 1, "otherwise checked");

        let mut ended = pane("p", Some("s"), Some("/wt"));
        ended.ended = true;
        assert!(worktree_checks(&[ended]).is_empty(), "already ended");

        let mut disabled = pane("p", Some("s"), Some("/wt"));
        disabled.disabled = true;
        assert!(worktree_checks(&[disabled]).is_empty(), "disabled");
    }

    /// A probe that cannot answer must never end a live worker. The caller defaults `dir_exists` to
    /// TRUE on any bridge miss for exactly this reason; the invariant is that "exists" is the safe
    /// answer, so it is asserted here rather than left to the caller's comment.
    #[test]
    fn an_existing_worktree_is_never_ended() {
        let checks = vec![WorktreeCheck {
            pane_id: "p".into(),
            cwd: "/wt".into(),
            stream_id: "s".into(),
        }];
        assert!(
            reconcile_missing_worktrees(&checks, &|_| true, &|_| false, &|_| ReclaimReason::MergedClean, 1)
                .is_empty(),
            "a worktree that exists must never be ended"
        );
        assert_eq!(
            reconcile_missing_worktrees(&checks, &|_| false, &|_| false, &|_| ReclaimReason::MergedClean, 1)
                .len(),
            1,
            "and a missing one must be — or the test above proves nothing"
        );
    }

    /// The already-ended skip is per PANE, not global.
    #[test]
    fn a_pane_ended_meanwhile_is_left_alone_and_its_neighbours_are_not() {
        let checks = vec![
            WorktreeCheck { pane_id: "a".into(), cwd: "/x".into(), stream_id: "sa".into() },
            WorktreeCheck { pane_id: "b".into(), cwd: "/y".into(), stream_id: "sb".into() },
        ];
        let got =
            reconcile_missing_worktrees(&checks, &|_| false, &|p| p == "a", &|_| ReclaimReason::MergedClean, 1);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].pane_id, "b");
        assert_eq!(got[0].info.stream_id, "sb", "the mark carries the pane's OWN stream");
    }
}
