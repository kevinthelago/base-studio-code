//! Context manifest (#1019) — the DYNAMIC required-set + confirm state for the Context stage.
//! The prose for each topic is a `context/<topic>.md` FILE (planner-written, worker-read); only
//! the required-SET lives in the db. The table IS the required set — `require` inserts a topic,
//! `unrequire` deletes it. Context files gate on GENERATION (presence), not confirmation (#1028).

use crate::Store;
use rusqlite::params;

impl Store {
    /// Add (`required` = true) or drop (`required` = false) `topic` from the required set. The
    /// planner shapes the set as the project clarifies; a blueprint seeds it.
    pub fn discovery_require(&self, topic: &str, required: bool) -> rusqlite::Result<()> {
        let t = topic.trim();
        if t.is_empty() {
            return Ok(());
        }
        if required {
            let pos: i64 = self
                .conn
                .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM discovery", [], |r| r.get(0))?;
            self.conn.execute(
                "INSERT INTO discovery (topic, position, updated_at) VALUES (?1, ?2, strftime('%s','now'))
                 ON CONFLICT(topic) DO NOTHING",
                params![t, pos],
            )?;
        } else {
            self.conn.execute("DELETE FROM discovery WHERE topic = ?1", params![t])?;
        }
        Ok(())
    }

    /// The required topic set, in declaration order — the gate checks each has a `context/<topic>.md`.
    pub fn discovery_list(&self) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT topic FROM discovery ORDER BY position, topic")?;
        let out: rusqlite::Result<Vec<String>> = stmt.query_map([], |r| r.get(0))?.collect();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_required_set_add_remove_and_clear() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.discovery_list().unwrap().is_empty());
        // seed a baseline required set (declaration order preserved)
        for t in ["goal", "scope", "stack", "architecture", "users"] {
            s.discovery_require(t, true).unwrap();
        }
        assert_eq!(s.discovery_list().unwrap(), vec!["goal", "scope", "stack", "architecture", "users"]);
        s.discovery_require("goal", true).unwrap(); // idempotent re-require
        assert_eq!(s.discovery_list().unwrap().len(), 5);
        // unrequire drops the topic from the set (discovery gates on generation, not confirmation)
        s.discovery_require("users", false).unwrap();
        assert!(!s.discovery_list().unwrap().contains(&"users".to_string()));
        // clear() wipes the set
        s.clear().unwrap();
        assert!(s.discovery_list().unwrap().is_empty());
    }
}
