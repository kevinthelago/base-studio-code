//! Linked repos (#1012) — the repos linked to a project, durable in the hub's plan.db so a
//! zustand/app-state reset can't lose them (the store-only persistence proved fragile).

use crate::Store;
use rusqlite::params;

impl Store {
    /// Link a repo by `full_name` (idempotent — a re-link is a no-op, link order preserved).
    pub fn repo_add(&self, full_name: &str) -> rusqlite::Result<()> {
        let name = full_name.trim();
        if name.is_empty() {
            return Ok(());
        }
        let pos: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM repos", [], |r| r.get(0))?;
        self.conn.execute(
            "INSERT INTO repos (full_name, position, updated_at) VALUES (?1, ?2, strftime('%s','now'))
             ON CONFLICT(full_name) DO NOTHING",
            params![name, pos],
        )?;
        Ok(())
    }

    /// Every linked repo `full_name`, in link order.
    pub fn repo_list(&self) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT full_name FROM repos ORDER BY position, full_name")?;
        let out: rusqlite::Result<Vec<String>> = stmt.query_map([], |r| r.get(0))?.collect();
        out
    }

    /// Unlink a repo by `full_name` (no-op if absent).
    pub fn repo_remove(&self, full_name: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM repos WHERE full_name = ?1", params![full_name])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repos_add_list_remove_and_clear() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.repo_list().unwrap().is_empty());
        s.repo_add("acme/api").unwrap();
        s.repo_add("acme/web").unwrap();
        s.repo_add("acme/api").unwrap(); // idempotent re-link
        assert_eq!(s.repo_list().unwrap(), vec!["acme/api".to_string(), "acme/web".to_string()]);
        s.repo_remove("acme/api").unwrap();
        assert_eq!(s.repo_list().unwrap(), vec!["acme/web".to_string()]);
        // clear() unlinks repos too (the "clear plan" reset).
        s.clear().unwrap();
        assert!(s.repo_list().unwrap().is_empty());
    }
}
