//! loops.db schema + migrations (#3262) — run by {@link crate::Store::open}. ONE global SQLite db
//! (`~/.base-studio-code/loops.db`), not per-project: a loop can pair an external session with a studio
//! persona that isn't tied to any project (`project` is an optional tag, not the store scope).
//!
//! Two tables: `loops` (one row per conversation — its participants, seed, termination signal, budget,
//! and lifecycle) and `turns` (the ordered turn log; the persistence that IS the loop). A turn may carry
//! a `shot_path` (a PNG from #3261) and its per-turn `tokens`/`cost` (the scientific payload — where a
//! signal-less loop degenerates is read from the running total).

use rusqlite::Connection;

/// Every table, child before parent so a reset is order-safe — the single source of truth for the set.
pub(crate) const ALL_TABLES: &[&str] = &["turns", "loops"];

pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS loops (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            a           TEXT NOT NULL,              -- participant A (speaks first)
            b           TEXT NOT NULL,              -- participant B
            seed        TEXT NOT NULL,              -- the opening topic/prompt
            until_sig   TEXT,                       -- the sentinel that ends it; NULL = --until false (never)
            max_turns   INTEGER,                    -- resource ceiling; NULL = unlimited
            budget      REAL,                       -- cost ceiling; NULL = unlimited
            project     TEXT,                       -- optional project tag (filter only)
            status      TEXT NOT NULL DEFAULT 'open',   -- open | closed
            ended_by    TEXT,                       -- why it closed: signal | max-turns | budget | stop
            created_at  INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS turns (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            loop_id     INTEGER NOT NULL,
            seq         INTEGER NOT NULL,           -- 1-based turn number within the loop
            participant TEXT NOT NULL,
            message     TEXT NOT NULL,
            shot_path   TEXT,                       -- optional PNG (#3261)
            tokens      INTEGER NOT NULL DEFAULT 0,
            cost        REAL NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_turns_loop   ON turns(loop_id, seq);
         CREATE INDEX IF NOT EXISTS idx_loops_status ON loops(status, id);",
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
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('loops','turns')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
    }
}
