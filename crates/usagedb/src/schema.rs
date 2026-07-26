//! usage.db schema + migrations (#3812, epic #3809) — run by [`crate::Store::open`]. One SQLite db per
//! project hub: `projects/<key>/usage.db`. Two tables: `usage` (one row per event NAME, carrying the
//! occurrence count — the aggregate `bsc usage summary` returns) and `events` (individual occurrences
//! with their props payload, capped per event name so an event that fires a million times stays bounded).

use rusqlite::Connection;

/// Every table, in the order `clear()` truncates them — the raw log before the aggregate. The single
/// source of truth for the store's table set.
pub(crate) const ALL_TABLES: &[&str] = &["events", "usage"];

pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS usage (
            event      TEXT PRIMARY KEY,
            count      INTEGER NOT NULL DEFAULT 0,
            last_props TEXT,
            first_seen INTEGER NOT NULL DEFAULT 0,
            last_seen  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS events (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            event TEXT NOT NULL,
            props TEXT,
            ts    INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_events_ev   ON events(event, id);
         CREATE INDEX IF NOT EXISTS idx_usage_count ON usage(count);",
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
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('usage','events')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
    }
}
