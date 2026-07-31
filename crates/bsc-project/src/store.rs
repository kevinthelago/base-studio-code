//! The durable projects store (#2995) — SQLite under `~/.base-studio-code/projects.db` (override with
//! `$BSC_PROJECT_DB`). This is the future **source of truth** for what projects/drafts exist, sitting
//! alongside the crate's existing disk-scan ([`crate::list_projects`]) rather than replacing it: the
//! disk walk reports the on-disk hub directories; this store records the intended project set (title,
//! pitch, seeding blueprint/category, lifecycle state) whether or not a hub has been scaffolded yet.
//!
//! Every store fn is **pure over a borrowed [`Connection`]** so tests run against an in-memory db
//! (`bsc_sqlite_util::open_in_memory_db` + [`ensure_schema`]). Timestamps are NOT stamped here — the
//! CLI layer ([`crate::cli`]) supplies `created_at` / `updated_at` (epoch millis) so the store stays
//! clock-free and deterministic. Mirrors the plandb/compliance house pattern: `Result<_, String>`
//! errors, schema-on-open, `bsc_sqlite_util` connection plumbing (#1863).

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// One row of the durable projects store — a project's identity + seeding config + lifecycle state.
///
/// `#[serde(rename_all = "camelCase")]` makes the JSON `createdAt`/`updatedAt` (Tauri does NOT
/// auto-rename return values, #789), matching the frontend contract the parallel fork codes against.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    /// The frozen project key (`projectSlug(name)`, #2409) — the PRIMARY KEY that names everything.
    pub key: String,
    /// The display title.
    pub title: String,
    /// The original pitch (empty when unknown).
    #[serde(default)]
    pub pitch: String,
    /// The blueprint id that seeds the plan, if any.
    pub blueprint: Option<String>,
    /// The blueprint lifecycle category (greenfield / transform / harden / maintain / …), if known.
    pub category: Option<String>,
    /// The lifecycle state (`drafted` by default; e.g. `published`, `archived`).
    pub state: String,
    /// When the project was TRIAGED (epoch millis), or `None` if it never was (#4088).
    ///
    /// This gates the whole Glance network (`filterTriaged`, #2541): an untriaged project is
    /// invisible there. It used to live ONLY in the desktop's `app-state.json`, so no `bsc` command
    /// could read or repair it, it died with an app-state reset, and diagnosing a missing node meant
    /// reading a raw zustand blob. The desktop keeps an in-memory cache; THIS is the source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triaged_at: Option<i64>,
    /// Creation time (epoch millis), stamped once at first insert and preserved across updates.
    pub created_at: i64,
    /// Last-update time (epoch millis).
    pub updated_at: i64,
}

/// The default store path: `$BSC_PROJECT_DB`, else `~/.base-studio-code/projects.db` — the shared
/// [`bsc_sqlite_util::default_store_path`] resolver (#1863). `None` when no home dir resolves and no
/// override is set.
pub fn default_path() -> Option<PathBuf> {
    bsc_sqlite_util::default_store_path("BSC_PROJECT_DB", &["projects.db"])
}

/// Open the default on-disk store (creating parent dirs + schema), the app↔CLI [`open`] entry point.
/// Enables WAL so the desktop app and a live session's `bsc project db` can read/write concurrently.
///
/// # Errors
/// No home dir resolves (and `$BSC_PROJECT_DB` unset), the file can't be opened, or the schema fails.
pub fn open() -> Result<Connection, String> {
    let path = default_path().ok_or("open projects.db: no home dir ($HOME / $USERPROFILE unset)")?;
    let conn = bsc_sqlite_util::open_db(&path).map_err(|e| format!("open projects.db: {e}"))?;
    // WAL for the shared app↔CLI store (moot in-memory; only meaningful on-disk).
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    ensure_schema(&conn)?;
    Ok(conn)
}

/// Create the `projects` table if it doesn't exist — the schema-on-open step every entry point runs.
///
/// # Errors
/// The `CREATE TABLE` fails.
pub fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS projects (
            key TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            pitch TEXT NOT NULL DEFAULT '',
            blueprint TEXT,
            category TEXT,
            state TEXT NOT NULL DEFAULT 'drafted',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )
    .map_err(|e| format!("projects schema: {e}"))?;
    add_column_if_missing(conn, "triaged_at", "INTEGER")
}

/// Add `<name> <ty>` to `projects` when it is not already there (#4088) — the store's first schema
/// MIGRATION, so an existing projects.db upgrades IN PLACE instead of being recreated (which would
/// drop every row and, for the triaged marker, make every project vanish from Glance at once).
///
/// SQLite has no `ADD COLUMN IF NOT EXISTS`, so this probes `pragma_table_info` first. Idempotent:
/// safe on every open, which is when it runs.
fn add_column_if_missing(conn: &Connection, name: &str, ty: &str) -> Result<(), String> {
    let present: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('projects') WHERE name = ?1",
            [name],
            |r| r.get(0),
        )
        .map_err(|e| format!("projects schema probe: {e}"))?;
    if present > 0 {
        return Ok(());
    }
    conn.execute(&format!("ALTER TABLE projects ADD COLUMN {name} {ty}"), [])
        .map(|_| ())
        .map_err(|e| format!("projects schema add {name}: {e}"))
}

/// The column list every read selects, in `ProjectRow` field order.
const COLS: &str = "key, title, pitch, blueprint, category, state, created_at, updated_at, triaged_at";

/// Map a full-`COLS` row into a [`ProjectRow`].
fn row_to_project(r: &rusqlite::Row) -> rusqlite::Result<ProjectRow> {
    Ok(ProjectRow {
        key: r.get(0)?,
        title: r.get(1)?,
        pitch: r.get(2)?,
        blueprint: r.get(3)?,
        category: r.get(4)?,
        state: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        triaged_at: r.get(8)?,
    })
}

/// Insert or update a project by `key`. On a conflict the update touches every field EXCEPT
/// `created_at` and `triaged_at` — both are stamped once and owned elsewhere. `triaged_at` (#4088)
/// matters here in particular: the desktop upserts every project on boot to migrate drafts forward,
/// and letting that carry a `None` through would UNTRIAGE every project on every launch, emptying
/// the Glance network. It is written only by [`set_triaged`] / [`clear_triaged`].
///
/// The original creation time is preserved (only `updated_at` moves), so callers can
/// pass any `created_at` on an update without clobbering it. Idempotent per `key`.
///
/// # Errors
/// The write fails.
pub fn upsert(conn: &Connection, row: &ProjectRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO projects (key, title, pitch, blueprint, category, state, created_at, updated_at, triaged_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(key) DO UPDATE SET
            title = excluded.title,
            pitch = excluded.pitch,
            blueprint = excluded.blueprint,
            category = excluded.category,
            state = excluded.state,
            updated_at = excluded.updated_at",
        params![
            row.key,
            row.title,
            row.pitch,
            row.blueprint,
            row.category,
            row.state,
            row.created_at,
            row.updated_at,
            row.triaged_at,
        ],
    )
    .map_err(|e| format!("projects upsert: {e}"))?;
    Ok(())
}

/// Stamp `key` as TRIAGED at `now` (#4088) — the marker that admits a project to the Glance network.
///
/// IDEMPOTENT: an already-triaged project keeps its FIRST timestamp, so re-triaging never rewrites
/// history (mirrors the desktop's `markProjectTriaged`, which this replaces as the source of truth).
/// Returns whether a row was actually stamped — `false` means the key is absent or already triaged.
pub fn set_triaged(conn: &Connection, key: &str, now: i64) -> Result<bool, String> {
    let n = conn
        .execute(
            "UPDATE projects SET triaged_at = ?2, updated_at = ?2 WHERE key = ?1 AND triaged_at IS NULL",
            params![key, now],
        )
        .map_err(|e| format!("projects set_triaged: {e}"))?;
    Ok(n > 0)
}

/// Clear `key`'s triaged marker (#4088) — it leaves the Glance network again. Returns whether a row
/// changed (`false` when the key is absent or was not triaged).
pub fn clear_triaged(conn: &Connection, key: &str, now: i64) -> Result<bool, String> {
    let n = conn
        .execute(
            "UPDATE projects SET triaged_at = NULL, updated_at = ?2 WHERE key = ?1 AND triaged_at IS NOT NULL",
            params![key, now],
        )
        .map_err(|e| format!("projects clear_triaged: {e}"))?;
    Ok(n > 0)
}

/// Look up one project by `key`, or `None` on a miss.
pub fn get(conn: &Connection, key: &str) -> Option<ProjectRow> {
    conn.query_row(
        &format!("SELECT {COLS} FROM projects WHERE key = ?1"),
        [key],
        row_to_project,
    )
    .ok()
}

/// All projects, most-recently-updated first (`updated_at DESC, key ASC` for a stable tiebreak).
pub fn list(conn: &Connection) -> Vec<ProjectRow> {
    let sql = format!("SELECT {COLS} FROM projects ORDER BY updated_at DESC, key ASC");
    let Ok(mut stmt) = conn.prepare(&sql) else { return Vec::new() };
    let Ok(rows) = stmt.query_map([], row_to_project) else { return Vec::new() };
    rows.flatten().collect()
}

/// Delete a project by `key`; returns whether a row was removed.
///
/// # Errors
/// The delete fails.
pub fn remove(conn: &Connection, key: &str) -> Result<bool, String> {
    let n = conn
        .execute("DELETE FROM projects WHERE key = ?1", [key])
        .map_err(|e| format!("projects remove: {e}"))?;
    Ok(n > 0)
}

/// Set a project's `state` + `updated_at`. Returns the updated row, or `None` when `key` is absent
/// (no row is inserted — this is state transition on an existing project only).
///
/// # Errors
/// The update fails.
pub fn set_state(
    conn: &Connection,
    key: &str,
    state: &str,
    updated_at: i64,
) -> Result<Option<ProjectRow>, String> {
    let n = conn
        .execute(
            "UPDATE projects SET state = ?2, updated_at = ?3 WHERE key = ?1",
            params![key, state, updated_at],
        )
        .map_err(|e| format!("projects set_state: {e}"))?;
    if n == 0 {
        return Ok(None);
    }
    Ok(get(conn, key))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh in-memory store with the schema applied — the test open path.
    fn mem() -> Connection {
        let conn = bsc_sqlite_util::open_in_memory_db().unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    fn row(key: &str, title: &str, created: i64, updated: i64) -> ProjectRow {
        ProjectRow {
            key: key.into(),
            title: title.into(),
            pitch: "a pitch".into(),
            blueprint: Some("default".into()),
            category: Some("greenfield".into()),
            state: "drafted".into(),
            created_at: created,
            updated_at: updated,
            triaged_at: None,
        }
    }

    /// #4088 — the marker is stamped once and IDEMPOTENT: re-triaging must not rewrite history, since
    /// the desktop calls its equivalent on every triage/fleet launch.
    #[test]
    fn set_triaged_stamps_once_and_clear_reverses_it() {
        let conn = mem();
        upsert(&conn, &row("alpha", "Alpha", 100, 100)).unwrap();
        assert_eq!(get(&conn, "alpha").unwrap().triaged_at, None, "starts untriaged");

        assert!(set_triaged(&conn, "alpha", 500).unwrap(), "first stamp lands");
        assert_eq!(get(&conn, "alpha").unwrap().triaged_at, Some(500));

        // A second stamp is a NO-OP and keeps the first timestamp.
        assert!(!set_triaged(&conn, "alpha", 900).unwrap(), "second stamp is a no-op");
        assert_eq!(get(&conn, "alpha").unwrap().triaged_at, Some(500), "keeps the FIRST time");

        assert!(clear_triaged(&conn, "alpha", 1000).unwrap());
        assert_eq!(get(&conn, "alpha").unwrap().triaged_at, None);
        assert!(!clear_triaged(&conn, "alpha", 1100).unwrap(), "clearing twice is a no-op");
    }

    /// An UPSERT must not carry the marker away. The desktop upserts every project on boot to migrate
    /// drafts forward, so a `None` flowing through here would untriage everything on every launch and
    /// empty the Glance network — the exact failure this store move exists to make impossible.
    #[test]
    fn upsert_preserves_an_existing_triaged_marker() {
        let conn = mem();
        upsert(&conn, &row("alpha", "Alpha", 100, 100)).unwrap();
        set_triaged(&conn, "alpha", 500).unwrap();

        // A later upsert built WITHOUT the marker (triaged_at: None), as a boot migration would be.
        let mut later = row("alpha", "Alpha renamed", 100, 700);
        later.triaged_at = None;
        upsert(&conn, &later).unwrap();

        let stored = get(&conn, "alpha").unwrap();
        assert_eq!(stored.triaged_at, Some(500), "the marker must survive an upsert");
        assert_eq!(stored.title, "Alpha renamed", "…while the rest of the row still updates");
    }

    /// The store's first schema migration: an EXISTING projects.db (pre-#4088, no `triaged_at`) must
    /// gain the column in place, keeping its rows. Recreating the table would drop every project.
    #[test]
    fn ensure_schema_adds_the_column_to_a_pre_existing_table() {
        let conn = bsc_sqlite_util::open_in_memory_db().unwrap();
        // The OLD schema, verbatim, without triaged_at.
        conn.execute_batch(
            "CREATE TABLE projects (
                key TEXT PRIMARY KEY, title TEXT NOT NULL, pitch TEXT NOT NULL DEFAULT '',
                blueprint TEXT, category TEXT, state TEXT NOT NULL DEFAULT 'drafted',
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             INSERT INTO projects (key,title,pitch,state,created_at,updated_at)
                VALUES ('legacy','Legacy','',  'drafted', 1, 1);",
        )
        .unwrap();

        ensure_schema(&conn).unwrap();
        let stored = get(&conn, "legacy").expect("the pre-existing row must survive the migration");
        assert_eq!(stored.triaged_at, None);

        // Idempotent — ensure_schema runs on every open.
        ensure_schema(&conn).unwrap();
        assert!(get(&conn, "legacy").is_some());
        assert!(set_triaged(&conn, "legacy", 42).unwrap(), "the new column is usable");
    }

    #[test]
    fn upsert_insert_then_get_round_trips() {
        let conn = mem();
        let r = row("alpha", "Alpha", 100, 100);
        upsert(&conn, &r).unwrap();
        assert_eq!(get(&conn, "alpha"), Some(r));
    }

    #[test]
    fn upsert_update_changes_title_preserves_created_at_and_bumps_updated_at() {
        let conn = mem();
        upsert(&conn, &row("alpha", "Alpha", 100, 100)).unwrap();

        // Re-upsert the same key with a NEW title, a bumped updated_at, AND a different created_at —
        // the DO UPDATE clause must keep the ORIGINAL created_at (100) and only move updated_at.
        let mut changed = row("alpha", "Alpha v2", 999, 200);
        changed.state = "published".into();
        upsert(&conn, &changed).unwrap();

        let got = get(&conn, "alpha").unwrap();
        assert_eq!(got.title, "Alpha v2", "title updated");
        assert_eq!(got.state, "published", "state updated");
        assert_eq!(got.created_at, 100, "created_at preserved (not the new 999)");
        assert_eq!(got.updated_at, 200, "updated_at bumped");
    }

    #[test]
    fn get_miss_is_none() {
        let conn = mem();
        assert_eq!(get(&conn, "nope"), None);
    }

    #[test]
    fn list_orders_by_updated_at_desc_then_key_asc() {
        let conn = mem();
        upsert(&conn, &row("beta", "Beta", 1, 300)).unwrap(); // newest
        upsert(&conn, &row("alpha", "Alpha", 1, 100)).unwrap(); // oldest
        upsert(&conn, &row("gamma", "Gamma", 1, 200)).unwrap(); // middle, same updated_at as delta
        upsert(&conn, &row("delta", "Delta", 1, 200)).unwrap(); // middle — ties with gamma on updated_at

        let keys: Vec<String> = list(&conn).into_iter().map(|r| r.key).collect();
        // updated_at DESC → beta(300), then the 200 tie broken by key ASC (delta before gamma), then alpha(100).
        assert_eq!(keys, vec!["beta", "delta", "gamma", "alpha"]);
    }

    #[test]
    fn remove_reports_whether_a_row_was_deleted() {
        let conn = mem();
        upsert(&conn, &row("alpha", "Alpha", 1, 1)).unwrap();
        assert!(remove(&conn, "alpha").unwrap(), "existing key → true");
        assert!(get(&conn, "alpha").is_none());
        assert!(!remove(&conn, "alpha").unwrap(), "already-gone key → false");
    }

    #[test]
    fn set_state_hits_an_existing_row_and_misses_an_absent_one() {
        let conn = mem();
        upsert(&conn, &row("alpha", "Alpha", 100, 100)).unwrap();

        let updated = set_state(&conn, "alpha", "archived", 500).unwrap();
        let updated = updated.expect("existing key → Some(row)");
        assert_eq!(updated.state, "archived");
        assert_eq!(updated.updated_at, 500, "updated_at moved");
        assert_eq!(updated.created_at, 100, "created_at untouched");
        assert_eq!(updated.title, "Alpha", "only state + updated_at change");

        // An absent key is a no-op → None (never inserts).
        assert_eq!(set_state(&conn, "ghost", "archived", 500).unwrap(), None);
        assert!(get(&conn, "ghost").is_none());
    }
}
