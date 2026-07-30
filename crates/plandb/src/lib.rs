//! Native per-project plan store (#plan-db). The canonical, granular store for a project's plan: the
//! planner upserts ONE item at a time (via the `bsc-plan` CLI) instead of rewriting whole files, and
//! the execution files (issues.json, …) are RENDERED from here at launch — so everything downstream
//! is unchanged and a file is still inspectable. One SQLite db per project, in the central store
//! `plans/<key>.db` (#2996 — relocated OUT of the hub so the plan persists folder-independently; the
//! app resolves the path via `plan_db_path` and passes it in `$BSC_PLAN_DB`).
//!
//! This crate is Tauri-free on purpose: the desktop app (`src-tauri`) and the `bsc-plan` agent CLI
//! both depend on it, so the CLI stays a tiny binary instead of relinking the whole app.
//!
//! ## The file-vs-plan.db boundary (#1191)
//! plan.db is the single store for every STRUCTURED planning artifact the planner produces — issues,
//! features, phases, the fleet, the deploy config, MCP assignments, the authored blueprint, the
//! Context required-SET, and the locked dependency manifest (`deps`, this issue — was a raw
//! `dependencies.json`). The ONLY planning artifacts that stay as flat files are CONTEXT documents
//! loaded as session context: the Context-stage section files (`goal.md`, `scope.md`, `stack.md`,
//! `architecture.md`, … — their required-set is in `context`, their PROSE in `context/<topic>.md`),
//! plus the planner/app-authored context surfaces (`kb_index.md`, `automations.md`,
//! `github_context.md`, the `prompts/*-kickoff.md` briefs, `.ui-skeleton/`). Those are prose context,
//! not interactive structured records — they belong on the file side of the line.
//!
//! Increment 1 (issues-first): the `issues` table + CRUD + a render to the `issues.json` shape the
//! frontend `parseIssuesFile` expects. Value-list fields are stored as JSON text for now; the
//! relational `dependsOn` can normalize into a join table later if graph queries want it.
//!
//! ## Module layout (#1864)
//! The `Store` type owns the SQLite connection here in the crate root, plus the shared plumbing —
//! `open`/`open_in_memory`/`clear`, the singleton-blob upsert/read helpers, and the phase-column
//! codec. Each cohesive cluster of `Store` methods (and its serde row types) lives in its own module
//! and hangs its methods off `Store` via a split inherent `impl` (Rust allows this within a crate):
//! `schema` (DDL + migrations), `issues`, `features`, `repos`, `fleet`, `deploy` (deploy + deps),
//! `market`, `transformations` (the modification list, #2509), `mcp`, `blueprint`, `ui` (the {kit, theme} pairing, #2489), `assignments` (automations + startup scripts), `discovery`, `triage`, and
//! `lessons` (self-correction lessons, #1362). Each type is re-exported here so the crate's public
//! API stays flat (`plandb::PlanIssue`, `plandb::Store`, …).

/// The `bsc plan` subcommand (#1877) — the agent-facing CLI extracted from the old `bsc-plan` binary,
/// dispatched to by the unified `bsc` umbrella and the legacy `bsc-plan` shim.
pub mod cli;

mod artifacts;
mod assignments;
mod blueprint;
mod confirmed;
mod classify;
mod deploy;
mod discovery;
mod features;
mod fleet;
mod issues;
mod lessons;
mod market;
mod mcp;
mod repos;
pub mod coord;
pub mod requests;
mod schema;
/// Per-stream access scoping (#3279): a worker session sees + touches only its own stream's issues.
/// `pub` so the app/bridge can reuse the same pure rules the `bsc plan` CLI enforces.
pub mod scope;
mod sessions;
mod skipped;
mod transformations;
mod triage;
mod ui;
/// Set-time validation for the structured JSON writes (#2395) — `pub` so the app/bridge can reuse
/// the same shape checks the `bsc plan` CLI enforces.
pub mod validate;

pub use artifacts::Artifact;
pub use assignments::{Automation, StartupScript};
pub use features::PlanFeature;
pub use issues::{is_valid_status, IssueSummary, PlanIssue, STATUSES};
pub use lessons::Lesson;
pub use requests::Request;
pub use sessions::FleetSession;

use rusqlite::{params, Connection};
use std::path::Path;

/// The per-project plan store — a thin owner of the SQLite connection plus the issue CRUD/render.
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open (creating + migrating) the plan.db at `path`. Parent dirs are created. WAL mode + a
    /// busy_timeout are enabled so the desktop app and the `bsc-plan` CLI can share the db
    /// concurrently without a SQLITE_BUSY race (matches `skilldb`, #1621).
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        let conn = bsc_sqlite_util::open_db(path)?;
        schema::migrate(&conn)?;
        Ok(Store { conn })
    }

    /// An ephemeral in-memory store — for tests. WAL is moot in-memory; the busy_timeout is still set.
    pub fn open_in_memory() -> rusqlite::Result<Store> {
        let conn = bsc_sqlite_util::open_in_memory_db()?;
        schema::migrate(&conn)?;
        Ok(Store { conn })
    }

    /// Empty the whole plan store — every issue and feature (#plan-db). Backs the "clear plan"
    /// reset: without it the cleared file/store state would be re-populated from the DB on the next
    /// poll. Truncates rather than dropping the file, so it works even with the db open (WAL).
    pub fn clear(&self) -> rusqlite::Result<()> {
        let stmt = schema::ALL_TABLES.iter().map(|t| format!("DELETE FROM {t};")).collect::<String>();
        self.conn.execute_batch(&stmt)
    }

    // ── singleton-blob helpers (#1688) — the deploy/deps/fleet_meta/blueprint/ui tables each hold ONE
    //    row (`id = 1`) carrying a JSON blob. These two methods are the shared upsert/read those five
    //    set/get pairs delegate to, so the `ON CONFLICT … DO UPDATE` / `from_str().ok()` pattern lives
    //    in exactly one place. `table` is a hardcoded string literal at every call site (never user
    //    input), so formatting it into the SQL is safe — there is no injection surface. ──

    /// Upsert the single JSON blob for a singleton-blob `table` (the row keyed `id = 1`).
    fn blob_set(&self, table: &str, data: &serde_json::Value) -> rusqlite::Result<()> {
        self.conn.execute(
            &format!("INSERT INTO {table} (id, data) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET data = excluded.data"),
            params![data.to_string()],
        )?;
        Ok(())
    }

    /// Read the single JSON blob from a singleton-blob `table`, or None if unset (or malformed).
    fn blob_get(&self, table: &str) -> rusqlite::Result<Option<serde_json::Value>> {
        let mut stmt = self.conn.prepare(&format!("SELECT data FROM {table} WHERE id = 1"))?;
        let mut rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        match rows.next() {
            Some(s) => Ok(serde_json::from_str(&s?).ok()),
            None => Ok(None),
        }
    }
}

// ── phase-column codec (shared by `issues` + `features`) ──────────────────────────
// `arr_to_json` / `json_to_arr` are shared with skilldb via `bsc_sqlite_util` (#1621); the
// phase-column codec below is plan.db-specific (a raw JSON value, not a string list).

pub(crate) fn phase_to_db(p: &Option<serde_json::Value>) -> Option<String> {
    p.as_ref().map(|v| v.to_string())
}
pub(crate) fn phase_from_db(s: Option<String>) -> Option<serde_json::Value> {
    s.and_then(|t| serde_json::from_str(&t).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_sets_a_busy_timeout_for_the_app_cli_share() {
        // The app + the bsc-plan CLI share one plan.db, so open must set a busy_timeout (alongside
        // WAL) or a CLI write racing the app's poll can hit SQLITE_BUSY with no retry (#1621).
        let dir = std::env::temp_dir().join(format!("plandb-busy-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("plan.db");
        let _ = std::fs::remove_file(&path);
        let s = Store::open(&path).unwrap();
        let timeout: i64 = s.conn.query_row("PRAGMA busy_timeout", [], |r| r.get(0)).unwrap();
        assert_eq!(timeout, bsc_sqlite_util::BUSY_TIMEOUT_MS as i64);
        // WAL is on for an on-disk db.
        let mode: String = s.conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        drop(s);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_empties_issues_and_features() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&PlanIssue { r#ref: "F1".into(), title: "an issue".into(), ..Default::default() }).unwrap();
        s.feature_upsert(&PlanFeature { name: "A feature".into(), ..Default::default() }).unwrap();
        s.clear().unwrap();
        assert!(s.list(None, None).unwrap().is_empty(), "issues cleared");
        assert!(s.feature_list().unwrap().is_empty(), "features cleared");
    }
}
