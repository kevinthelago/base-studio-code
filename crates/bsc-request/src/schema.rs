//! requests.db schema + migrations (#3295) — run by {@link crate::Store::open}. ONE global SQLite db
//! (`~/.base-studio-code/requests.db`): the designer→debug channel isn't tied to any project.
//!
//! One table: `requests` (one row per improvement ask). `cmd` is the GROUNDING — the exact command that
//! failed, so a request is observed, not narrated (#3260). `status` is `open` until the debug session
//! `resolve`s it (stamping `note` + `resolved_at`).

use rusqlite::Connection;

/// Every table (single source of truth for `clear`).
pub(crate) const ALL_TABLES: &[&str] = &["requests"];

pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS requests (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            text         TEXT NOT NULL,               -- what the surface couldn't do
            surface      TEXT NOT NULL DEFAULT 'bsc ui', -- the tool surface the ask is about
            cmd          TEXT,                         -- the exact failing command (the grounding)
            shot_path    TEXT,                         -- optional PNG (#3261)
            status       TEXT NOT NULL DEFAULT 'open', -- open | resolved
            note         TEXT,                         -- what the debug session changed, on resolve
            created_at   INTEGER NOT NULL DEFAULT 0,
            resolved_at  INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status, id);",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap(); // re-running on an existing db is a no-op
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='requests'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }
}
