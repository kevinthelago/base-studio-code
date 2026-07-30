//! plan.db schema + migrations (#plan-db). The full table set (`ALL_TABLES`), the `CREATE TABLE`
//! DDL, and the additive/rename migrations — run by {@link crate::Store::open}. Split out of `lib.rs`
//! so the schema is one file (mirrors how `crates/data` keeps one file per concern).

use crate::{artifacts, lessons, requests, sessions};
use rusqlite::Connection;

/// Every plan-store table, in the order `clear()` truncates them — the single source of truth for the
/// store's table set so a new table is wired into the reset by adding one entry here.
pub(crate) const ALL_TABLES: &[&str] = &[
    "issues",
    "features",
    "repos",
    "fleet_streams",
    "fleet_meta",
    "deploy",
    "deps",
    "market",
    "classify",
    "mcp",
    "automations",
    "startup",
    "blueprint",
    "ui",
    "discovery",
    "integrations",
    "confirmed_stages",
    "skipped_stages",
    "triage_runs",
    "fleet_sessions",
    "transformations",
    "artifacts",
    "requests",
];

pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    // Pre-create rename (#1578: the Context stage became Discovery). Carry an existing project's
    // required-set forward by renaming the old `context` table in place. Must run BEFORE the
    // `CREATE TABLE IF NOT EXISTS discovery` below — otherwise the new empty table would block the
    // rename. Errors (no `context` table, or `discovery` already present) are expected and ignored.
    let _ = conn.execute("ALTER TABLE context RENAME TO discovery", []);
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS issues (
            ref         TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            phase       TEXT,
            repo        TEXT,
            stream      TEXT,
            parent      TEXT,
            body        TEXT,
            acceptance  TEXT NOT NULL DEFAULT '[]',
            owns        TEXT NOT NULL DEFAULT '[]',
            depends_on  TEXT NOT NULL DEFAULT '[]',
            labels      TEXT NOT NULL DEFAULT '[]',
            status      TEXT NOT NULL DEFAULT 'open',
            position    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS features (
            slug        TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            behavior    TEXT,
            phase       TEXT,
            approach    TEXT,
            data        TEXT,
            stream      TEXT,
            acceptance  TEXT NOT NULL DEFAULT '[]',
            tools       TEXT NOT NULL DEFAULT '[]',
            depends_on  TEXT NOT NULL DEFAULT '[]',
            position    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS repos (
            full_name   TEXT PRIMARY KEY,
            position    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS fleet_streams (
            id          TEXT PRIMARY KEY,
            data        TEXT NOT NULL DEFAULT '{}',
            position    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS fleet_meta (
            id          INTEGER PRIMARY KEY,
            data        TEXT NOT NULL DEFAULT '{}'
         );
         CREATE TABLE IF NOT EXISTS deploy (
            id          INTEGER PRIMARY KEY,
            data        TEXT NOT NULL DEFAULT '{}'
         );
         CREATE TABLE IF NOT EXISTS deps (
            id          INTEGER PRIMARY KEY,
            data        TEXT NOT NULL DEFAULT '{}'
         );
         CREATE TABLE IF NOT EXISTS market (
            id          INTEGER PRIMARY KEY,
            data        TEXT NOT NULL DEFAULT '{}'
         );
         CREATE TABLE IF NOT EXISTS classify (
            id          INTEGER PRIMARY KEY,
            data        TEXT NOT NULL DEFAULT '{}'
         );
         CREATE TABLE IF NOT EXISTS mcp (
            name        TEXT PRIMARY KEY,
            position    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS integrations (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL DEFAULT '',
            direction   TEXT NOT NULL DEFAULT 'runtime',
            docs        TEXT,
            base_url    TEXT,
            auth        TEXT,
            purpose     TEXT,
            position    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS automations (
            name        TEXT PRIMARY KEY,
            command     TEXT NOT NULL DEFAULT '',
            schedule    TEXT,
            description TEXT,
            position    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS startup (
            repo        TEXT NOT NULL,
            mode        TEXT NOT NULL,
            path        TEXT NOT NULL DEFAULT '',
            position    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (repo, mode)
         );
         CREATE TABLE IF NOT EXISTS blueprint (
            id          INTEGER PRIMARY KEY,
            data        TEXT NOT NULL DEFAULT '{}'
         );
         CREATE TABLE IF NOT EXISTS ui (
            id          INTEGER PRIMARY KEY,
            data        TEXT NOT NULL DEFAULT '{}'
         );
         CREATE TABLE IF NOT EXISTS discovery (
            topic       TEXT PRIMARY KEY,
            position    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS confirmed_stages (
            stage       TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL DEFAULT '',
            updated_at  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS skipped_stages (
            stage       TEXT PRIMARY KEY,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS triage_runs (
            repo        TEXT PRIMARY KEY,
            last_run    INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS transformations (
            id          TEXT PRIMARY KEY,
            data        TEXT NOT NULL DEFAULT '{}',
            position    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );",
    )?;
    // Self-correction lessons (#1362) own their schema in the `lessons` module.
    conn.execute_batch(lessons::LESSONS_DDL)?;
    // (The feature-scope `todos` table was removed in #3278 — the local-first consolidation onto the one
    // `bsc plan` surface. Existing `plan.db` files keep their orphaned `todos` table; nothing reads it,
    // and `Store::open` never drops a table, so leaving it is harmless.)
    // Fleet-session ledger (#2405) — the durable launched-agent record; owns its schema in `sessions`.
    conn.execute_batch(sessions::FLEET_SESSIONS_DDL)?;
    // Planner OUTPUT artifacts (#2997) — durable planner content by (kind, name); owns its schema in
    // `artifacts`. Additive + unwired for now (the substrate for hub-file → plan.db content moves).
    conn.execute_batch(artifacts::ARTIFACTS_DDL)?;
    conn.execute_batch(requests::REQUESTS_DDL)?;
    // Additive migrations for a plan.db created before a column existed (each errors if the column is
    // already present — ignored).
    let _ = conn.execute("ALTER TABLE issues ADD COLUMN status TEXT NOT NULL DEFAULT 'open'", []);
    let _ = conn.execute("ALTER TABLE features ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'", []);
    let _ = conn.execute("ALTER TABLE features ADD COLUMN phase TEXT", []);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_table_migrates_from_legacy_context_table() {
        // A pre-#1578 plan.db has the old `context` table; migrate() renames it in place so the
        // project's required-set carries forward (data preserved, no separate copy step).
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE context (topic TEXT PRIMARY KEY, position INTEGER NOT NULL DEFAULT 0, \
             updated_at INTEGER NOT NULL DEFAULT 0); \
             INSERT INTO context (topic, position) VALUES ('goal', 1), ('scope', 2);",
        )
        .unwrap();
        migrate(&conn).unwrap();
        let topics: Vec<String> = conn
            .prepare("SELECT topic FROM discovery ORDER BY position")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(topics, vec!["goal".to_string(), "scope".to_string()]);
        // Idempotent: re-running migrate on the already-migrated db is a no-op (no `context` table).
        migrate(&conn).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM discovery", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }
}
