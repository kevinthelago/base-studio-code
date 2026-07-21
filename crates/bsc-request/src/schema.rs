//! requests.db schema + migrations (#3295) — run by {@link crate::Store::open}. ONE global SQLite db
//! (`~/.base-studio-code/requests.db`): the designer→debug channel isn't tied to any project.
//!
//! One table: `requests` (one row per improvement ask). `cmd` is the GROUNDING — the exact command that
//! failed, so a request is observed, not narrated (#3260). `status` moves `open` → `claimed` (a session is
//! working it, #3535) → `resolved` (stamping `note` + `resolved_at`).

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
            status       TEXT NOT NULL DEFAULT 'open', -- open | claimed | resolved
            note         TEXT,                         -- what the debug session changed, on resolve
            created_at   INTEGER NOT NULL DEFAULT 0,
            resolved_at  INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status, id);",
    )?;
    // The claim lifecycle (#3535) — added by ALTER on an existing db so a live requests.db upgrades in
    // place. `claimed_by` records WHICH session holds the request (its pane id), so the app can tell a
    // busy session from an idle one; `claimed_at` is when. Both null until a `claim`.
    add_column_if_missing(conn, "claimed_by", "TEXT")?;
    add_column_if_missing(conn, "claimed_at", "INTEGER")?;
    Ok(())
}

/// Add `col` to `requests` only when it isn't already there — so `migrate` stays idempotent across the
/// original schema (no claim columns) and an already-upgraded db. `ALTER TABLE ADD COLUMN` has no
/// `IF NOT EXISTS`, so the existence check is explicit via `pragma_table_info`.
fn add_column_if_missing(conn: &Connection, col: &str, ty: &str) -> rusqlite::Result<()> {
    let exists: bool =
        conn.prepare("SELECT 1 FROM pragma_table_info('requests') WHERE name = ?1")?.exists([col])?;
    if !exists {
        conn.execute(&format!("ALTER TABLE requests ADD COLUMN {col} {ty}"), [])?;
    }
    Ok(())
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

    #[test]
    fn migrate_adds_claim_columns_and_upgrades_a_legacy_db_in_place() {
        // Simulate the ORIGINAL schema (no claim columns) with a row, then migrate: the columns are added
        // and the existing row survives (null claim fields). This is the live requests.db upgrade path.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
                surface TEXT NOT NULL DEFAULT 'bsc ui', cmd TEXT, shot_path TEXT,
                status TEXT NOT NULL DEFAULT 'open', note TEXT,
                created_at INTEGER NOT NULL DEFAULT 0, resolved_at INTEGER);
             INSERT INTO requests (text) VALUES ('legacy row');",
        )
        .unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap(); // idempotent even after the in-place upgrade
        let has_col = |c: &str| -> bool {
            conn.prepare("SELECT 1 FROM pragma_table_info('requests') WHERE name = ?1").unwrap().exists([c]).unwrap()
        };
        assert!(has_col("claimed_by") && has_col("claimed_at"), "claim columns added");
        let (n, cb): (i64, Option<String>) = conn
            .query_row("SELECT COUNT(*), MAX(claimed_by) FROM requests", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(n, 1, "the legacy row survived the ALTER");
        assert_eq!(cb, None, "its claim fields default to null");
    }
}
