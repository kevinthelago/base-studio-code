//! requests.db schema + migrations (#3295) — run by {@link crate::Store::open}. ONE global SQLite db
//! (`~/.base-studio-code/requests.db`): the designer→debug channel isn't tied to any project.
//!
//! One table: `requests` (one row per improvement ask). `cmd` is the GROUNDING — the exact command that
//! failed, so a request is observed, not narrated (#3260). `status` moves `open` → `claimed` (a session is
//! working it, #3535) → `resolved` (stamping `note` + `resolved_at`).

use rusqlite::Connection;

/// Every table (single source of truth for `clear`).
pub(crate) const ALL_TABLES: &[&str] = &["requests", "request_notes"];

pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        // `foreign_keys` is OFF by default in SQLite and is PER-CONNECTION, so it belongs here (which
        // every `Store::open` runs) rather than in the CREATE. Without it the notes table's
        // `ON DELETE CASCADE` is silently inert and `remove`/`prune` would strand a thread pointing at a
        // deleted request — the failure mode is invisible until someone reads orphaned rows.
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
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
    // PROVENANCE (#debug-request-carries-its-origin) — WHO filed it and a short name for it.
    //
    // `origin` is the filing session's pane id (`designer-studio:react`, `librarian-studio:typescript`,
    // `myproject:director`), stamped by `bsc request new` from $BSC_AUDIT_PANE rather than typed by the
    // session. Null for a request filed outside a session (a human at a shell), which is honest: the
    // alternative is a fabricated attribution, and the graph reads `origin` to decide which node a
    // request's debug session hangs off.
    //
    // `title` is the short form for a node label — `text` is the full narration and is routinely a
    // paragraph. Null on legacy rows; readers derive one from `text` (see `Request::display_title`), so
    // no backfill is needed and a row filed before this column still labels correctly.
    add_column_if_missing(conn, "origin", "TEXT")?;
    add_column_if_missing(conn, "title", "TEXT")?;
    // The REPLY thread (#bsc-request-gains-a-note-verb) — its own table, not the `note` column above.
    //
    // That column is the RESOLVE stamp: one TEXT, written when a request is closed. Threading replies
    // through it would make each reply destroy the last, which is the same lost-update class as the bug
    // that prompted this verb. A separate table makes notes APPEND-ONLY by construction — there is no
    // UPDATE path to them at all, matching what `bsc plan change note` already established.
    //
    // `ON DELETE CASCADE` + the `foreign_keys` pragma below so `remove`/`prune` take a request's thread
    // with it rather than stranding notes pointing at a row that is gone.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS request_notes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
            body       TEXT NOT NULL,               -- the reply
            author     TEXT,                        -- who wrote it (--from); null when unattributed
            at         INTEGER NOT NULL DEFAULT 0   -- epoch ms
         );
         CREATE INDEX IF NOT EXISTS idx_request_notes ON request_notes(request_id, id);",
    )?;
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

    /// #debug-request-carries-its-origin: the provenance columns land on a db that already carries the
    /// claim ones — the live requests.db upgrade path, one migration further along. The legacy row keeps
    /// its text and gets NULL provenance rather than an invented attribution.
    #[test]
    fn migrate_adds_provenance_columns_to_an_already_upgraded_db() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
                surface TEXT NOT NULL DEFAULT 'bsc ui', cmd TEXT, shot_path TEXT,
                status TEXT NOT NULL DEFAULT 'open', note TEXT,
                created_at INTEGER NOT NULL DEFAULT 0, resolved_at INTEGER,
                claimed_by TEXT, claimed_at INTEGER);
             INSERT INTO requests (text) VALUES ('filed before provenance existed');",
        )
        .unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap(); // idempotent over the second ALTER too
        let has_col = |c: &str| -> bool {
            conn.prepare("SELECT 1 FROM pragma_table_info('requests') WHERE name = ?1").unwrap().exists([c]).unwrap()
        };
        assert!(has_col("origin") && has_col("title"), "provenance columns added");
        let (text, origin, title): (String, Option<String>, Option<String>) = conn
            .query_row("SELECT text, origin, title FROM requests", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        assert_eq!(text, "filed before provenance existed", "the legacy row survived the ALTER");
        assert_eq!(origin, None, "an unattributed legacy row stays unattributed — never back-filled with a guess");
        assert_eq!(title, None, "no backfill; readers derive a title from `text`");
    }
}
