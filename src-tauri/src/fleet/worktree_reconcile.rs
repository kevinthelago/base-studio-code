//! The boot worktree reconciliation, run in Rust (`a-reclaimed-worktree-reports-why-it-was-reclaimed`).
//!
//! The decision lives in [`bsc_fleet::worktree_reconcile`], parity-proved against the TypeScript. This
//! is the bridge that WIRES it: the renderer hands over its persisted panes and applies the marks it
//! gets back, instead of probing `dir_exists` once per pane and inferring a verdict from the absence.
//!
//! # Why the reason cannot be re-derived here
//!
//! The GC's two arms prove different things — `hub_gone || worktree_is_disposable(clone, wt)` — and
//! only the second proves clean + merged. `worktree_is_disposable` answers by comparing the worktree's
//! HEAD against its owning CLONE, and requires `clone/.git` to exist; on the orphan path the hub and
//! the clone are already deleted. So the moment the GC reclaims is the ONLY moment the answer exists,
//! which is why [`crate::fleet::teardown`] writes it to a ledger and this reads it back rather than
//! probing for something that is no longer there.
//!
//! Rust cannot mark the panes itself — `markPaneEnded` is zustand state the backend does not own — so
//! this returns the marks and the renderer applies them. That split is the epic's rule: derive here,
//! render there.

use bsc_fleet::worktree_reconcile::{
    reconcile_missing_worktrees, worktree_checks, EndedMark, PaneRecord, ReclaimReason,
};

/// Reconcile the persisted panes against the worktrees actually on disk.
///
/// Returns ONLY the panes to mark ended, each with the whole record to mark it with. An empty result
/// is the normal case — most boots reclaim nothing.
#[tauri::command]
pub(crate) fn reconcile_worktrees(panes: Vec<PaneRecord>) -> Vec<EndedMark> {
    let base = crate::bsc_base_dir();
    let ledger = crate::fleet::teardown::read_reclaims(&crate::fleet::teardown::reclaim_ledger_path(&base));
    reconcile_worktrees_with(&panes, &ledger, bsc_util::now_ms())
}

/// The testable core: pure over the ledger and the clock, with the real filesystem as its only input.
pub(crate) fn reconcile_worktrees_with(
    panes: &[PaneRecord],
    ledger: &[crate::fleet::teardown::ReclaimedWorktree],
    now: i64,
) -> Vec<EndedMark> {
    let checks = worktree_checks(panes);
    reconcile_missing_worktrees(
        &checks,
        // A probe FAILURE must never end a live worker, so anything we cannot answer reads as present
        // — the same direction the TypeScript's `dir_exists` default took.
        &|cwd| std::path::Path::new(cwd).exists(),
        // Rust holds no ended set; the renderer filters what it already marked. Passing `false` here
        // would double-mark, so the caller-side skip stays the renderer's job and this reports all of
        // them. See the note in the frontend caller.
        &|_| false,
        &|cwd| {
            ledger
                .iter()
                .find(|r| r.path == cwd)
                .map(|r| r.reason)
                // NOT recorded is its own answer, distinct from the orphan arm: "we do not know who
                // removed this" is not "we removed it without checking".
                .unwrap_or(ReclaimReason::Unrecorded)
        },
        now,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet::teardown::ReclaimedWorktree;

    fn pane(id: &str, stream: &str, cwd: &str) -> PaneRecord {
        serde_json::from_value(serde_json::json!({
            "paneId": id, "stream": stream, "cwd": cwd, "ended": false, "disabled": false
        }))
        .unwrap()
    }

    fn rec(path: &str, reason: ReclaimReason) -> ReclaimedWorktree {
        ReclaimedWorktree { id: format!("k/{path}"), path: path.into(), reason }
    }

    /// THE WHOLE POINT: an orphan-arm reclaim must not produce a card claiming the work merged.
    #[test]
    fn an_orphan_reclaim_does_not_report_done() {
        let panes = vec![pane("p:api", "api", "/definitely/not/here/orphan")];
        let ledger = vec![rec("/definitely/not/here/orphan", ReclaimReason::OrphanProject)];
        let marks = reconcile_worktrees_with(&panes, &ledger, 7);
        assert_eq!(marks.len(), 1);
        assert_ne!(marks[0].info.state, "done", "{:?}", marks[0].info);
        assert!(!marks[0].info.summary.contains("work merged"), "{:?}", marks[0].info);
    }

    /// ...and a proved one still does, or the fix has just made every reclaim look broken.
    #[test]
    fn a_merged_clean_reclaim_still_reports_done() {
        let panes = vec![pane("p:api", "api", "/definitely/not/here/merged")];
        let ledger = vec![rec("/definitely/not/here/merged", ReclaimReason::MergedClean)];
        let marks = reconcile_worktrees_with(&panes, &ledger, 7);
        assert_eq!(marks[0].info.state, "done");
        assert!(marks[0].info.summary.contains("work merged"));
    }

    /// A worktree missing for NEITHER reason is distinguishable from both.
    #[test]
    fn a_worktree_the_gc_never_recorded_is_its_own_verdict() {
        let panes = vec![pane("p:api", "api", "/definitely/not/here/mystery")];
        let marks = reconcile_worktrees_with(&panes, &[], 7);
        assert_ne!(marks[0].info.state, "done");
        let orphan = reconcile_worktrees_with(
            &panes,
            &[rec("/definitely/not/here/mystery", ReclaimReason::OrphanProject)],
            7,
        );
        assert_ne!(
            marks[0].info.summary, orphan[0].info.summary,
            "an unrecorded disappearance must not be reported as an orphan reclaim"
        );
    }

    /// A worktree that EXISTS is never ended — the probe is real, against the real filesystem.
    #[test]
    fn an_existing_worktree_is_left_alone() {
        let dir = std::env::temp_dir();
        let panes = vec![pane("p:api", "api", &dir.to_string_lossy())];
        assert!(reconcile_worktrees_with(&panes, &[], 7).is_empty());
    }
}
