//! requests.db schema + migrations (#3295) — run by {@link crate::Store::open}. ONE global SQLite db
//! (`~/.base-studio-code/requests.db`): the designer→debug channel isn't tied to any project.
//!
//! One table: `requests` (one row per improvement ask). `cmd` is the GROUNDING — the exact command that
//! failed, so a request is observed, not narrated (#3260). `status` moves `open` → `claimed` (a session is
//! working it, #3535) → `resolved` (stamping `note` + `resolved_at`).

use rusqlite::Connection;

/// Every table (single source of truth for `clear`).
pub(crate) const ALL_TABLES: &[&str] = &["requests", "request_notes", "request_settings"];

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
    // QUEUE-WIDE SETTINGS (`auto-spawn-has-no-off-switch`) — a key/value side table, not a column.
    //
    // `paused` is a property of the QUEUE, not of any request, so putting it on `requests` would mean
    // N copies of one fact and no place to store it while the queue is empty — which is exactly when
    // someone wants to pause it before a launch. It lives in the same db as the queue deliberately:
    // the app and the CLI already share this file with WAL + busy_timeout, so a pause set from a shell
    // is visible to the running app with no second store to keep in sync.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS request_settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );",
    )?;
    add_column_if_missing(conn, "origin", "TEXT")?;
    add_column_if_missing(conn, "title", "TEXT")?;
    // THE FILING CONTEXT (`a-request-records-where-it-actually-came-from`) — every column NULLABLE and
    // added by ALTER, the same in-place upgrade path the claim and provenance columns above took, so
    // the 39 requests already in the live db keep reading with these simply absent.
    //
    // `origin` above could not answer "who filed this", because `--from` and `$BSC_AUDIT_PANE` both
    // landed in it: it holds a resolvable PANE id on one row and arbitrary free text on the next, and
    // the only way to tell them apart was looking for a `:` — which calls `lane-c4` a pane. So the two
    // are SPLIT here. `origin` is left alone and still written exactly as before: 39 rows and every
    // reader of it are evidence, not something to rewrite.
    //
    //   `origin_pane`  the filing session's pane id, stamped from $BSC_AUDIT_PANE — resolvable to a
    //                  graph node, which is the only thing the Glance edge can be drawn from.
    //   `origin_actor` the free-text actor a `--from` names. A real identity; just not a node.
    //
    // A row may carry BOTH (a session that also passed --from) — that is strictly more information
    // than the single field could hold, and neither displaces the other.
    add_column_if_missing(conn, "origin_pane", "TEXT")?;
    add_column_if_missing(conn, "origin_actor", "TEXT")?;
    // WHERE it was filed. `repo` and `worktree` are separate because they differ in a linked worktree,
    // and that difference is the report: a `bsc ui` gap hit in `wt-131` and one hit at the repo root
    // are not the same observation. Absent for a filing outside any repository — never back-filled
    // with the process cwd, which would read as a measured repository.
    add_column_if_missing(conn, "cwd", "TEXT")?;
    add_column_if_missing(conn, "repo", "TEXT")?;
    add_column_if_missing(conn, "worktree", "TEXT")?;
    add_column_if_missing(conn, "branch", "TEXT")?;
    // WHICH BUILD was running. Half the live queue reports behaviour that has since changed and
    // nothing recorded what produced it, so "is this still true?" was unanswerable. `bsc_built_at` is
    // the executable's mtime in epoch ms — the same signal `bsc version` prints, so the two agree.
    add_column_if_missing(conn, "bsc_version", "TEXT")?;
    add_column_if_missing(conn, "bsc_built_at", "INTEGER")?;
    // WHO WAS DRIVING. A cost complaint from a 35B local operator and one from Claude are different
    // reports. Absent whenever the environment does not say — Claude Code publishes no model unless
    // pinned, and that absence is the correct record rather than a default model name.
    add_column_if_missing(conn, "harness", "TEXT")?;
    add_column_if_missing(conn, "model", "TEXT")?;
    add_column_if_missing(conn, "session_id", "TEXT")?;
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

    /// `a-request-records-where-it-actually-came-from`: the filing-context columns land on a db that
    /// already carries the claim AND provenance ones — one migration further along the live upgrade
    /// path. The pre-existing row keeps everything it had and gets NULL for every new field: nothing
    /// back-fills a cwd, a repo or an actor it never observed.
    #[test]
    fn migrate_adds_filing_context_columns_and_never_backfills_them() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
                surface TEXT NOT NULL DEFAULT 'bsc ui', cmd TEXT, shot_path TEXT,
                status TEXT NOT NULL DEFAULT 'open', note TEXT,
                created_at INTEGER NOT NULL DEFAULT 0, resolved_at INTEGER,
                claimed_by TEXT, claimed_at INTEGER, origin TEXT, title TEXT);
             INSERT INTO requests (text, origin) VALUES ('filed before the context existed', 'lane-c4');",
        )
        .unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap(); // idempotent over the third ALTER batch too
        let has_col = |c: &str| -> bool {
            conn.prepare("SELECT 1 FROM pragma_table_info('requests') WHERE name = ?1").unwrap().exists([c]).unwrap()
        };
        for c in [
            "origin_pane",
            "origin_actor",
            "cwd",
            "repo",
            "worktree",
            "branch",
            "bsc_version",
            "bsc_built_at",
            "harness",
            "model",
            "session_id",
        ] {
            assert!(has_col(c), "filing-context column {c} added");
        }
        let (origin, pane, actor, cwd, built): (String, Option<String>, Option<String>, Option<String>, Option<i64>) =
            conn.query_row("SELECT origin, origin_pane, origin_actor, cwd, bsc_built_at FROM requests", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap();
        assert_eq!(origin, "lane-c4", "the legacy origin is EVIDENCE — untouched, not reclassified");
        assert_eq!(pane, None, "and it is not promoted into the pane column on a guess about its shape");
        assert_eq!(actor, None, "nor into the actor column — nobody recorded which it was");
        assert_eq!(cwd, None);
        assert_eq!(built, None);
    }
}
