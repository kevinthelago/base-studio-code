//! error.db schema + migrations (#2260) — run by {@link crate::Store::open}. One SQLite db per
//! project hub: `projects/<key>/error.db`. Two tables: `faults` (one row per fingerprint, Sentry-style,
//! carrying the occurrence count) and `events` (individual occurrences, capped per fingerprint).

use rusqlite::Connection;

/// Every table, in the order `clear()` truncates them — the child (`events`) before the parent so the
/// reset is order-safe, and the single source of truth for the store's table set.
pub(crate) const ALL_TABLES: &[&str] = &["events", "faults"];

pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS faults (
            fingerprint  TEXT PRIMARY KEY,
            stage        TEXT NOT NULL DEFAULT 'runtime',
            level        TEXT NOT NULL DEFAULT 'error',
            title        TEXT NOT NULL,
            sample_stack TEXT,
            source_hint  TEXT,
            release      TEXT,
            count        INTEGER NOT NULL DEFAULT 0,
            first_seen   INTEGER NOT NULL DEFAULT 0,
            last_seen    INTEGER NOT NULL DEFAULT 0,
            resolved_at  INTEGER
         );
         CREATE TABLE IF NOT EXISTS events (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            fingerprint  TEXT NOT NULL,
            ts           INTEGER NOT NULL DEFAULT 0,
            context      TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_events_fp   ON events(fingerprint, id);
         CREATE INDEX IF NOT EXISTS idx_faults_seen ON faults(last_seen);",
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
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('faults','events')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
    }
}
