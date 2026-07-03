//! Skipped stages (#2267) — the DURABLE record of the OPTIONAL stages the user deliberately skipped
//! (#921). Parallel to `confirmed` (#2256): a skip used to live ONLY in the app-state, so a reset or
//! key drift lost it on revisit and the flow re-stopped on an already-decided optional stage. The
//! table IS the skipped set — `skip` inserts a stage, `unskip` deletes it. Unlike a confirmation, a
//! skip is a plain DECISION (not tied to content), so there is no fingerprint / reset-on-change.

use crate::Store;
use rusqlite::params;

impl Store {
    /// Skip `stage` (idempotent). A blank stage is a no-op.
    pub fn skip_stage(&self, stage: &str) -> rusqlite::Result<()> {
        let s = stage.trim();
        if s.is_empty() {
            return Ok(());
        }
        self.conn.execute(
            "INSERT INTO skipped_stages (stage, updated_at) VALUES (?1, strftime('%s','now'))
             ON CONFLICT(stage) DO NOTHING",
            params![s],
        )?;
        Ok(())
    }

    /// Unskip `stage` — drop it from the skipped set. A missing stage is a no-op.
    pub fn unskip_stage(&self, stage: &str) -> rusqlite::Result<()> {
        self.conn
            .execute("DELETE FROM skipped_stages WHERE stage = ?1", params![stage.trim()])?;
        Ok(())
    }

    /// The skipped set, in skip order (oldest first).
    pub fn skipped_list(&self) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT stage FROM skipped_stages ORDER BY updated_at, stage")?;
        let out: rusqlite::Result<Vec<String>> = stmt.query_map([], |r| r.get(0))?.collect();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_unskip_roundtrip_and_clear() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.skipped_list().unwrap().is_empty());

        s.skip_stage("api").unwrap();
        s.skip_stage("security").unwrap();
        s.skip_stage("api").unwrap(); // idempotent
        assert_eq!(s.skipped_list().unwrap(), vec!["api", "security"]);

        s.unskip_stage("api").unwrap();
        assert_eq!(s.skipped_list().unwrap(), vec!["security"]);

        // Blank skip is a no-op; unknown unskip is a no-op.
        s.skip_stage("  ").unwrap();
        s.unskip_stage("nope").unwrap();
        assert_eq!(s.skipped_list().unwrap(), vec!["security"]);

        s.clear().unwrap();
        assert!(s.skipped_list().unwrap().is_empty());
    }
}
