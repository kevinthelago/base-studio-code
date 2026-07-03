//! Stage confirmations (#2256) — the DURABLE record of which planning stages the USER has confirmed,
//! with a content FINGERPRINT captured at confirm time. This closes the one gap in planner
//! persistence: section content lives on disk and every other artifact (issues/features/fleet/…)
//! lives in plan.db, but confirmations used to live ONLY in the app-state — so an app-state reset or
//! key drift re-opened every gate on revisit. The table IS the confirmed set: `confirm` upserts a
//! stage (recording its fingerprint), `unconfirm` deletes it.
//!
//! The fingerprint lets the app reset ONE stage when its content changes: the poll compares the live
//! content's fingerprint against the stored one and drops just that stage's confirmation on a mismatch.

use crate::Store;
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// One confirmed stage: its key + the content fingerprint captured when it was confirmed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfirmedStage {
    pub stage: String,
    #[serde(default)]
    pub fingerprint: String,
}

impl Store {
    /// Confirm `stage`, recording `fingerprint` (the content signature at confirm time). Idempotent —
    /// re-confirming updates the fingerprint (so a re-confirm after an edit re-baselines the reset).
    pub fn confirm_stage(&self, stage: &str, fingerprint: &str) -> rusqlite::Result<()> {
        let s = stage.trim();
        if s.is_empty() {
            return Ok(());
        }
        self.conn.execute(
            "INSERT INTO confirmed_stages (stage, fingerprint, updated_at)
             VALUES (?1, ?2, strftime('%s','now'))
             ON CONFLICT(stage) DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = excluded.updated_at",
            params![s, fingerprint],
        )?;
        Ok(())
    }

    /// Drop `stage` from the confirmed set (the per-stage reset). A missing stage is a no-op.
    pub fn unconfirm_stage(&self, stage: &str) -> rusqlite::Result<()> {
        self.conn
            .execute("DELETE FROM confirmed_stages WHERE stage = ?1", params![stage.trim()])?;
        Ok(())
    }

    /// The confirmed set with each stage's fingerprint, in confirm order (oldest first).
    pub fn confirmed_list(&self) -> rusqlite::Result<Vec<ConfirmedStage>> {
        let mut stmt = self
            .conn
            .prepare("SELECT stage, fingerprint FROM confirmed_stages ORDER BY updated_at, stage")?;
        let out: rusqlite::Result<Vec<ConfirmedStage>> = stmt
            .query_map([], |r| {
                Ok(ConfirmedStage { stage: r.get(0)?, fingerprint: r.get(1)? })
            })?
            .collect();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirm_unconfirm_and_fingerprint_roundtrip() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.confirmed_list().unwrap().is_empty());

        s.confirm_stage("goal", "fp-goal").unwrap();
        s.confirm_stage("scope", "fp-scope").unwrap();
        let list = s.confirmed_list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0], ConfirmedStage { stage: "goal".into(), fingerprint: "fp-goal".into() });

        // Re-confirm updates the fingerprint in place (re-baseline after an edit), not a duplicate row.
        s.confirm_stage("goal", "fp-goal-2").unwrap();
        let list = s.confirmed_list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(
            list.iter().find(|c| c.stage == "goal").unwrap().fingerprint,
            "fp-goal-2"
        );

        // Unconfirm drops just that stage (the per-stage reset).
        s.unconfirm_stage("goal").unwrap();
        let list = s.confirmed_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].stage, "scope");

        // Blank stage is a no-op; unknown unconfirm is a no-op.
        s.confirm_stage("   ", "x").unwrap();
        s.unconfirm_stage("nope").unwrap();
        assert_eq!(s.confirmed_list().unwrap().len(), 1);
    }

    #[test]
    fn clear_wipes_the_confirmed_set() {
        let s = Store::open_in_memory().unwrap();
        s.confirm_stage("goal", "fp").unwrap();
        s.clear().unwrap();
        assert!(s.confirmed_list().unwrap().is_empty());
    }
}
