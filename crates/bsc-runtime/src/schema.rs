//! `runtime.db` schema + migrations — run by [`crate::Store::open`].
//!
//! ONE global SQLite db (`~/.base-studio-code/runtime.db`), like `requests.db`: what served a module is
//! a property of the APP's run, not of any project.
//!
//! One table, `attestations`, and it is deliberately COALESCED rather than append-only. A per-load row
//! would be honest and useless: a page mount links a closure of hundreds of modules, so an ordinary
//! session would write six figures of rows to answer a question that only ever needs "did this serve,
//! how often, and how slow". The primary key is the coalescing key, and every write is an upsert that
//! folds counts and timings into the existing row.

use rusqlite::Connection;

/// Every table (single source of truth for `clear`).
pub(crate) const ALL_TABLES: &[&str] = &["attestations"];

pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS attestations (
            -- THE COALESCING KEY. `session` is part of it on purpose: folding across sessions would
            -- make 'this record has not served since it changed' unanswerable, because one ancient
            -- success would mask every subsequent decline.
            specifier   TEXT NOT NULL,            -- the module specifier the record claims (@/…)
            record_id   TEXT NOT NULL DEFAULT '', -- the record that served it ('' when a file did)
            src_hash    TEXT NOT NULL DEFAULT '', -- WHICH VERSION ran — the whole point (see hash.rs)
            outcome     TEXT NOT NULL,            -- served | declined-* | fell-back | render-threw | linked
            session     TEXT NOT NULL,            -- one app run
            n           INTEGER NOT NULL DEFAULT 0,   -- how many times this exact fact was observed
            reason      TEXT,                     -- the decline's cause, kept from the FIRST occurrence
            ms_total    REAL NOT NULL DEFAULT 0,  -- summed, so a mean is (ms_total / n) without a join
            ms_max      REAL NOT NULL DEFAULT 0,
            first_at    INTEGER NOT NULL DEFAULT 0,
            last_at     INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (specifier, record_id, src_hash, outcome, session)
         );
         -- The two reads doctor makes: 'everything about this record' and 'everything recent'.
         CREATE INDEX IF NOT EXISTS idx_attest_record ON attestations(record_id, last_at);
         CREATE INDEX IF NOT EXISTS idx_attest_recent ON attestations(last_at);",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='attestations'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    /// The composite primary key IS the coalescing rule, so it is asserted rather than assumed: if a
    /// column silently left it, every write would insert instead of folding and the table would grow
    /// per load — the exact thing the design exists to avoid, and it would still look correct.
    #[test]
    fn the_primary_key_is_the_full_coalescing_key() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('attestations') WHERE pk > 0 ORDER BY pk")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(cols, ["specifier", "record_id", "src_hash", "outcome", "session"]);
    }
}
