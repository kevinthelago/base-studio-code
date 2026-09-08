//! The graph's RECORD STORE, as a database (`epic-retire-json-ledgers-for-db-and-git-drivers`).
//!
//! Replaces the 27.5 MB committed JSON ledger, the 50 MB runtime blob, the packaged seed and the
//! propagation between them — "a record edit is four writes", and the copy the app reads was the one
//! nothing updated.
//!
//! # History is the SHAPE, not a hook
//!
//! There is no "current record" row. [`RECORD_REVS`] is append-only and holds every version ever
//! written; `records` is a VIEW selecting each id's highest rev. A write is an INSERT, so there is
//! nothing to overwrite and no way to lose a version by writing one.
//!
//! THE ALTERNATIVE WAS A TRIGGER, and it was rejected on evidence. A trigger that mirrors each write
//! into a history table is real enforcement right up until someone runs `DROP TRIGGER` — measured on
//! SQLite 3.46: after dropping it, writes continued, `current` advanced to rev 4, history stopped at
//! rev 3, and nothing anywhere raised. A store whose guarantee can be silently switched off by one
//! statement is not a store that can be used to self-heal. Here, dropping every trigger in the schema
//! changes nothing, because there are none to drop.
//!
//! What the primary key `(id, rev)` adds is that a version cannot be REWRITTEN either: replaying an
//! existing rev is a constraint violation, not a silent clobber.
//!
//! # Reverting is going FORWARD
//!
//! [`revert`] does not undo. It reads the content at an older rev and appends it as a NEW one, so the
//! act of reverting is itself a version and the history is never rewritten. That is what makes "move
//! back a version, then handle the error when we can" recoverable in both directions.
//!
//! # Why the projected columns exist
//!
//! `name`/`role`/`tech`/`folder`/`provides`/`src` are `GENERATED ALWAYS … STORED` from the record
//! body, so the queries the app makes never parse a body they are not going to show. They cannot
//! drift from the record, because SQLite computes them from it. MEASURED over the real store (1,403
//! records, 3,715 revisions): the whole-index read is 8.9 ms against 26.6 ms parsing bodies, and the
//! resolver's read 13.6 ms against 51.6 ms, for 1 MB more on disk.

use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::Path;

/// The append-only ledger. Every version of every record, including tombstones.
pub const RECORD_REVS: &str = "record_revs";

/// The schema, applied on every open. Idempotent.
///
/// `records` is a VIEW and is deliberately not a table: a table would be a second copy of the truth,
/// and keeping two copies in step is the entire class of bug this store exists to remove.
pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS record_revs (
  id       TEXT    NOT NULL,
  rev      INTEGER NOT NULL CHECK (rev > 0),
  -- The record body. NULL is a TOMBSTONE — the record was removed at this rev, which is itself a
  -- version you can come back from, rather than an absence you cannot distinguish from never-existed.
  json     TEXT,
  at       INTEGER NOT NULL,
  by       TEXT    NOT NULL DEFAULT '',
  note     TEXT,
  -- Projected from the body by SQLite, so they cannot drift from it and a listing never parses a body.
  name     TEXT GENERATED ALWAYS AS (json_extract(json, '$.name'))     STORED,
  role     TEXT GENERATED ALWAYS AS (json_extract(json, '$.role'))     STORED,
  tech     TEXT GENERATED ALWAYS AS (json_extract(json, '$.tech'))     STORED,
  folder   TEXT GENERATED ALWAYS AS (json_extract(json, '$.folder'))   STORED,
  src      TEXT GENERATED ALWAYS AS (json_extract(json, '$.src'))      STORED,
  provides TEXT GENERATED ALWAYS AS (json_extract(json, '$.provides')) STORED,
  PRIMARY KEY (id, rev)
);
CREATE INDEX IF NOT EXISTS record_revs_head     ON record_revs(id, rev DESC);
CREATE INDEX IF NOT EXISTS record_revs_provides ON record_revs(provides);
CREATE INDEX IF NOT EXISTS record_revs_folder   ON record_revs(folder);

CREATE VIEW IF NOT EXISTS records AS
  SELECT id, json, rev, at, by, name, role, tech, folder, src, provides
    FROM record_revs r
   WHERE rev = (SELECT MAX(rev) FROM record_revs WHERE id = r.id)
     AND json IS NOT NULL;
"#;

/// Open (creating if needed) the store at `path` and apply [`SCHEMA`].
pub fn open(path: &Path) -> Result<Connection, String> {
    let conn = bsc_sqlite_util::open_db_str(path, "graph store")?;
    conn.execute_batch(SCHEMA).map_err(|e| format!("graph store schema: {e}"))?;
    Ok(conn)
}

/// The store's default location, or `$BSC_GRAPH_DB`.
pub fn default_path() -> Option<std::path::PathBuf> {
    bsc_sqlite_util::default_store_path("BSC_GRAPH_DB", &["knowledge", "graph.db"])
}

/// The highest rev recorded for `id`, including a tombstone. `0` when the id has never existed.
pub fn head_rev(conn: &Connection, id: &str) -> Result<i64, String> {
    conn.query_row("SELECT COALESCE(MAX(rev), 0) FROM record_revs WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|e| format!("head rev for '{id}': {e}"))
}

/// One record's CURRENT body, or `None` when it does not exist or was removed.
pub fn get(conn: &Connection, id: &str) -> Result<Option<Value>, String> {
    let row: Option<String> = conn
        .query_row("SELECT json FROM records WHERE id = ?1", [id], |r| r.get(0))
        .ok();
    match row {
        None => Ok(None),
        Some(s) => serde_json::from_str(&s).map(Some).map_err(|e| format!("record '{id}' is not valid JSON: {e}")),
    }
}

/// Append a new version of `id`.
///
/// `expect_rev` is OPTIMISTIC CONCURRENCY, and it is the same guard `bsc graph impl set --if-version`
/// already offers: `Some(n)` refuses the write unless the current head is exactly `n`. `None` accepts
/// whatever is there. Either way the new rev is head + 1 and the old one is still on disk.
pub fn put(
    conn: &Connection,
    id: &str,
    body: &Value,
    by: &str,
    note: Option<&str>,
    expect_rev: Option<i64>,
) -> Result<i64, String> {
    let head = head_rev(conn, id)?;
    if let Some(want) = expect_rev {
        if head != want {
            return Err(format!(
                "'{id}' is at rev {head}, not {want} — someone else wrote it since you read it. Re-read \
                 and reapply; nothing was changed."
            ));
        }
    }
    let next = head + 1;
    let text = serde_json::to_string(body).map_err(|e| format!("cannot serialize '{id}': {e}"))?;
    conn.execute(
        "INSERT INTO record_revs (id, rev, json, at, by, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, next, text, now_ms(), by, note],
    )
    .map_err(|e| format!("cannot write '{id}' rev {next}: {e}"))?;
    Ok(next)
}

/// Remove `id` by appending a TOMBSTONE — a version with no body.
///
/// Not a DELETE: the record stops being current while every version of it stays readable, so a removal
/// is as recoverable as any other write. `bsc graph impl remove` losing a record permanently is the
/// behaviour this replaces.
pub fn remove(conn: &Connection, id: &str, by: &str, note: Option<&str>) -> Result<i64, String> {
    let head = head_rev(conn, id)?;
    if head == 0 {
        return Err(format!("no record '{id}' — nothing to remove"));
    }
    let next = head + 1;
    conn.execute(
        "INSERT INTO record_revs (id, rev, json, at, by, note) VALUES (?1, ?2, NULL, ?3, ?4, ?5)",
        params![id, next, now_ms(), by, note],
    )
    .map_err(|e| format!("cannot tombstone '{id}': {e}"))?;
    Ok(next)
}

/// Restore the content `id` had at `rev`, as a NEW version.
///
/// THE SELF-HEAL PATH. It goes forward, never back: history is never rewritten, so a revert can itself
/// be reverted, and the record of what went wrong survives the recovery from it.
pub fn revert(conn: &Connection, id: &str, rev: i64, by: &str) -> Result<i64, String> {
    let body: Option<String> = conn
        .query_row("SELECT json FROM record_revs WHERE id = ?1 AND rev = ?2", params![id, rev], |r| r.get(0))
        .map_err(|_| format!("'{id}' has no rev {rev} — reachable revs: {:?}", revs(conn, id).unwrap_or_default()))?;
    match body {
        None => remove(conn, id, by, Some(&format!("revert to rev {rev} (a tombstone)"))),
        Some(text) => {
            let v: Value = serde_json::from_str(&text).map_err(|e| format!("rev {rev} of '{id}' is not valid JSON: {e}"))?;
            put(conn, id, &v, by, Some(&format!("revert to rev {rev}")), None)
        }
    }
}

/// Every rev recorded for `id`, newest first.
pub fn revs(conn: &Connection, id: &str) -> Result<Vec<i64>, String> {
    let mut st = conn
        .prepare("SELECT rev FROM record_revs WHERE id = ?1 ORDER BY rev DESC")
        .map_err(|e| e.to_string())?;
    let rows = st.query_map([id], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Milliseconds since the epoch — the stamp every version carries.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
