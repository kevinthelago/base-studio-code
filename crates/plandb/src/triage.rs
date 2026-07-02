//! Triage runs (#1004) — a per-repo "last triage launch" timestamp T, so the next triage can
//! resume cheaply from the delta (issues whose status changed since T) instead of re-ingesting
//! the whole project. Status bumps `issues.updated_at` (see set_status), so the delta is a query.

use crate::issues::{row_to_issue, SELECT_COLS};
use crate::{PlanIssue, Store};
use rusqlite::params;

impl Store {
    /// Record a triage launch for `repo` at NOW (epoch seconds) — the next launch reads this as `T`.
    /// Returns the recorded timestamp.
    pub fn triage_record_run(&self, repo: &str) -> rusqlite::Result<i64> {
        let r = repo.trim();
        self.conn.execute(
            "INSERT INTO triage_runs (repo, last_run) VALUES (?1, strftime('%s','now'))
             ON CONFLICT(repo) DO UPDATE SET last_run = strftime('%s','now')",
            params![r],
        )?;
        self.triage_last_run(r).map(|o| o.unwrap_or(0))
    }

    /// The last triage-launch timestamp (epoch seconds) for `repo`, or None if never triaged.
    pub fn triage_last_run(&self, repo: &str) -> rusqlite::Result<Option<i64>> {
        let mut stmt = self.conn.prepare("SELECT last_run FROM triage_runs WHERE repo = ?1")?;
        let mut rows = stmt.query_map(params![repo.trim()], |r| r.get::<_, i64>(0))?;
        match rows.next() {
            Some(v) => Ok(Some(v?)),
            None => Ok(None),
        }
    }

    /// Issues whose status changed since `since` (epoch seconds) — `updated_at > since`, the delta the
    /// triage pickup leads with. Filtered to `repo` when non-empty (triage is per-repo); empty `repo`
    /// = the whole project. Newest-changed first.
    pub fn issues_changed_since(&self, repo: &str, since: i64) -> rusqlite::Result<Vec<PlanIssue>> {
        let r = repo.trim();
        if r.is_empty() {
            let mut stmt = self
                .conn
                .prepare(&format!("{SELECT_COLS} WHERE updated_at > ?1 ORDER BY updated_at DESC, ref"))?;
            let out: rusqlite::Result<Vec<PlanIssue>> = stmt.query_map(params![since], row_to_issue)?.collect();
            out
        } else {
            let mut stmt = self
                .conn
                .prepare(&format!("{SELECT_COLS} WHERE repo = ?1 AND updated_at > ?2 ORDER BY updated_at DESC, ref"))?;
            let out: rusqlite::Result<Vec<PlanIssue>> = stmt.query_map(params![r, since], row_to_issue)?.collect();
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triage_runs_marker_and_changed_since_delta() {
        let s = Store::open_in_memory().unwrap();
        // Never triaged → no marker.
        assert_eq!(s.triage_last_run("o/web").unwrap(), None);
        // Record a run; the marker is set to the returned timestamp.
        let t = s.triage_record_run("o/web").unwrap();
        assert!(t > 0);
        assert_eq!(s.triage_last_run("o/web").unwrap(), Some(t));

        // An issue whose status changes is in the since-T delta (set_status bumps updated_at to now,
        // which is >= t; query from just before the run so the same-second change counts).
        s.upsert(&PlanIssue { r#ref: "F1".into(), title: "Login".into(), repo: Some("o/web".into()), ..Default::default() }).unwrap();
        s.set_status("F1", "complete").unwrap();
        let delta = s.issues_changed_since("o/web", t - 1).unwrap();
        assert!(delta.iter().any(|i| i.r#ref == "F1"), "the changed issue is in the repo's delta");

        // Repo-scoped: a different repo sees nothing of o/web's change.
        assert!(s.issues_changed_since("o/api", t - 1).unwrap().is_empty());
        // Project-wide (empty repo) still sees it.
        assert!(s.issues_changed_since("", t - 1).unwrap().iter().any(|i| i.r#ref == "F1"));

        // re-record bumps the marker; clear() wipes it.
        let t2 = s.triage_record_run("o/web").unwrap();
        assert!(t2 >= t);
        s.clear().unwrap();
        assert_eq!(s.triage_last_run("o/web").unwrap(), None);
    }
}
