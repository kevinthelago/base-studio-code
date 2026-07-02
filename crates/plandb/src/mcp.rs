//! MCP assignments (#1021) — the catalog server names scoped to a project; durable in plan.db
//! instead of `<mcp_assign>` text tags. The frontend resolves each name → the MCP-servers store.

use crate::Store;
use rusqlite::params;

impl Store {
    /// Assign an MCP server by catalog `name` (idempotent; assignment order preserved).
    pub fn mcp_add(&self, name: &str) -> rusqlite::Result<()> {
        let n = name.trim();
        if n.is_empty() {
            return Ok(());
        }
        let pos: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM mcp", [], |r| r.get(0))?;
        self.conn.execute(
            "INSERT INTO mcp (name, position, updated_at) VALUES (?1, ?2, strftime('%s','now'))
             ON CONFLICT(name) DO NOTHING",
            params![n, pos],
        )?;
        Ok(())
    }

    /// Every assigned MCP server name, in assignment order.
    pub fn mcp_list(&self) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT name FROM mcp ORDER BY position, name")?;
        let out: rusqlite::Result<Vec<String>> = stmt.query_map([], |r| r.get(0))?.collect();
        out
    }

    /// Unassign an MCP server by `name` (no-op if absent).
    pub fn mcp_remove(&self, name: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM mcp WHERE name = ?1", params![name])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_add_list_remove_and_clear() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.mcp_list().unwrap().is_empty());
        s.mcp_add("Postgres").unwrap();
        s.mcp_add("GitHub").unwrap();
        s.mcp_add("Postgres").unwrap(); // idempotent re-assign
        assert_eq!(s.mcp_list().unwrap(), vec!["Postgres".to_string(), "GitHub".to_string()]);
        s.mcp_remove("Postgres").unwrap();
        assert_eq!(s.mcp_list().unwrap(), vec!["GitHub".to_string()]);
        s.clear().unwrap();
        assert!(s.mcp_list().unwrap().is_empty());
    }
}
