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


// The classify PREDICATES have no caller yet: the flip is a separate item
// (`the-classification-answers-its-own-questions-on-the-bsc-surface`) so the derivation and the
// behaviour change stay independently revertible. The `#[allow(dead_code)]` that marks this is the
// marker that the derivation is still orphaned, and removing it IS PART OF THAT ITEM — leaving it
// would hide the next orphan. It no longer sits on a `mod classify;` line here: classify is a
// record now, and the attribute rides with it as `moduleAttrs` on `plandb--classify.rs`, which
// build.rs re-emits onto the generated `mod classify {`. Read it with:
//     bsc graph impl get plandb--classify.rs

pub use artifacts::Artifact;
pub use decisions::Decision;
pub use changes::{
    default_issue_links, is_valid_change_status, render_change_markdown, Change, ChangeNote, CHANGE_STATUSES,
};
pub use assignments::{Automation, StartupScript};
pub use features::PlanFeature;
pub use integrations::{
    scan_declared_integrations, DeclaredIntegration, IntegrationScan, PlanIntegration,
    DEFAULT_DIRECTION, DIRECTIONS,
};
pub use issues::{
    is_done_status, is_valid_status, merge_patch, IssueSummary, PlanIssue, AMEND_OWNED_ELSEWHERE,
    DONE_STATUSES, STATUSES,
};
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
        Ok(Store { conn: bsc_sqlite_util::open_migrated(path, schema::migrate)? })
    }

    /// Open an EXISTING plan.db **read-only, without migrating it**.
    ///
    /// [`Store::open`] creates the file and runs `migrate`, which is right for the one store a session
    /// owns and wrong for a SCAN. `bsc fleet directors` reads every project's plan store to answer one
    /// question — does this project have a director — and if that read migrated each one, an
    /// architect's read-only listing would write to thirty stores it does not own, some of them open
    /// under a live fleet.
    ///
    /// Errors when the file does not exist (rather than creating it), which is the other half of the
    /// same guarantee: a scan cannot mint a plan store for a stray path.
    ///
    /// WHAT "READ-ONLY" DOES AND DOES NOT MEAN HERE — measured, because the obvious reading is wrong.
    /// The DATABASE is never modified: no migrate, no write, byte-identical size and mtime after a
    /// full read (pinned by `open_read_only_reads_without_writing_and_refuses_to_create`). But these
    /// stores are in WAL mode, and **a WAL reader needs the `-shm` shared-memory index, so the first
    /// QUERY on a read-only connection creates `<db>-wal` and `<db>-shm` if they are absent.** That is
    /// SQLite's design, not a leak in this wrapper: those are reader-coordination files, not data.
    /// Do not "fix" it by asserting their absence — `a_read_only_query_creates_the_wal_sidecars` pins
    /// the real behaviour so the next reader is not surprised into a wrong assertion.
    ///
    /// Note also that the open is LAZY: it touches no file, so an `Ok` here proves nothing about
    /// whether a read will succeed. The failure surfaces on the first query.
    ///
    /// The caller must treat a missing TABLE as absent data, not as failure — a store written before a
    /// table existed opens fine and errors on the query. The `*_or_empty` readers below do exactly
    /// that; a raw method called on this connection will surface the rusqlite error instead.
    pub fn open_read_only(path: &Path) -> rusqlite::Result<Store> {
        let conn = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )?;
        conn.busy_timeout(std::time::Duration::from_millis(
            bsc_sqlite_util::BUSY_TIMEOUT_MS as u64,
        ))?;
        Ok(Store { conn })
    }

    /// Open an existing plan.db for a SCAN: never creating it, never migrating it.
    ///
    /// Prefers a read-only connection ([`Store::open_read_only`]) and falls back to an ordinary one.
    /// The fallback is not a loophole — the guarantee that matters is "we never run `migrate`", and
    /// that holds on both paths.
    ///
    /// It exists because a WAL database read READ-ONLY needs its `-shm` index, and SQLite returns
    /// `SQLITE_CANTOPEN` when it cannot create one — which happens when the containing DIRECTORY is
    /// not writable (a read-only mount, a locked-down profile). Without the fallback the scan would
    /// silently skip those stores, which is the same class of omission the scan was written to remove.
    /// On an ordinary writable `plans/` the read-only path is the one taken, every time.
    ///
    /// A path that names nothing is an error on both paths: a scan must not mint a plan store.
    pub fn open_for_scan(path: &Path) -> rusqlite::Result<Store> {
        if !path.is_file() {
            return Err(rusqlite::Error::InvalidPath(path.to_path_buf()));
        }
        if let Ok(store) = Store::open_read_only(path) {
            return Ok(store);
        }
        let conn = bsc_sqlite_util::open_db(path)?;
        Ok(Store { conn })
    }

    /// [`Store::fleet_session_list`] tolerating a store whose `fleet_sessions` table predates the
    /// ledger (#2405). An older plan.db is not an error — it is a project with no ledger.
    pub fn fleet_session_list_or_empty(&self) -> Vec<sessions::FleetSession> {
        self.fleet_session_list().unwrap_or_default()
    }

    /// [`Store::fleet_get`] with the same tolerance — a store with no `fleet_streams`/`fleet_meta`
    /// reads as "no fleet planned" rather than failing the whole scan.
    pub fn fleet_get_or_none(&self) -> Option<serde_json::Value> {
        self.fleet_get().ok().flatten()
    }

    /// An ephemeral in-memory store — for tests. WAL is moot in-memory; the busy_timeout is still set.
    pub fn open_in_memory() -> rusqlite::Result<Store> {
        Ok(Store { conn: bsc_sqlite_util::open_in_memory_migrated(schema::migrate)? })
    }

    /// Empty the whole plan store — every issue and feature (#plan-db). Backs the "clear plan"
    /// reset: without it the cleared file/store state would be re-populated from the DB on the next
    /// poll. See [`bsc_sqlite_util::clear_tables`] for why it truncates — and note it truncates the
    /// TABLES, never the file, which this comment used to say.
    pub fn clear(&self) -> rusqlite::Result<()> {
        bsc_sqlite_util::clear_tables(&self.conn, schema::ALL_TABLES)
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

// This crate's modules are IN THE GRAPH, not in this directory.
// src/artifacts.rs, src/assignments.rs, src/blueprint.rs, src/changes.rs, src/classify.rs, src/cli.rs, src/cli/changes.rs, src/cli/fleet.rs, src/cli/hub.rs, src/cli/integrate.rs, src/cli/issues.rs, src/cli/nouns.rs, src/cli/render.rs, src/cli/snapshot.rs, src/confirmed.rs, src/coord.rs, src/decisions.rs, src/deploy.rs, src/discovery.rs, src/features.rs, src/fleet.rs, src/integrations.rs, src/issues.rs, src/known_red.rs, src/lessons.rs, src/market.rs, src/mcp.rs, src/repos.rs, src/requests.rs, src/requirement.rs, src/schema.rs, src/scope.rs, src/sessions.rs, src/skipped.rs, src/tests.rs, src/transformations.rs, src/triage.rs, src/ui.rs, src/validate.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get plandb--<module>.rs
//     bsc graph impl set --id plandb--<module>.rs --code-file <f>
//     bsc graph promote --id plandb--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `plandb--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));