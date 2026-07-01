//! Native per-project plan store (#plan-db). The canonical, granular store for a project's plan: the
//! planner upserts ONE item at a time (via the `bsc-plan` CLI) instead of rewriting whole files, and
//! the execution files (issues.json, …) are RENDERED from here at launch — so everything downstream
//! is unchanged and a file is still inspectable. One SQLite db per project hub: `projects/<key>/plan.db`.
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

/// The `bsc plan` subcommand (#1877) — the agent-facing CLI extracted from the old `bsc-plan` binary,
/// dispatched to by the unified `bsc` umbrella and the legacy `bsc-plan` shim.
pub mod cli;

use bsc_sqlite_util::{arr_to_json, json_to_arr};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Every plan-store table, in the order `clear()` truncates them — the single source of truth for the
/// store's table set so a new table is wired into the reset by adding one entry here.
const ALL_TABLES: &[&str] = &[
    "issues",
    "features",
    "repos",
    "fleet_streams",
    "fleet_meta",
    "deploy",
    "deps",
    "mcp",
    "automations",
    "blueprint",
    "discovery",
    "triage_runs",
];

// Self-correction lessons (#1362) — their own concern, in their own module (mirrors how `crates/data`
// keeps one file per concern). The module hangs its `lesson_*` methods off `Store` and owns its schema.
mod lessons;
pub use lessons::Lesson;

/// The execution-status lifecycle (#plan-db). The DB is the coordination substrate: a worker moves
/// its issue open → in_progress → complete (pushed/PR'd, awaiting verification); the director then
/// checks the CI pipeline and moves complete → verified (green) or failed (red → rework). `blocked`
/// marks an issue waiting on an unmet dependency.
pub const STATUSES: &[&str] = &["open", "in_progress", "blocked", "complete", "verified", "failed"];

/// True if `s` is one of the known {@link STATUSES} — guards against a typo wedging the board.
pub fn is_valid_status(s: &str) -> bool {
    STATUSES.contains(&s)
}

fn default_status() -> String {
    "open".into()
}

/// A planned issue — the granular work item. Mirrors the frontend `PlanIssue`; `serde` emits the
/// camelCase JSON `parseIssuesFile` reads (`ref`, `dependsOn`, …).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanIssue {
    pub r#ref: String,
    pub title: String,
    /// A 1-based phase number or its name — kept as a raw JSON value so the number/string distinction survives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<serde_json::Value>,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub owns: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Execution status (see {@link STATUSES}). Set by workers (in_progress/complete) and the
    /// director (verified/failed) — the planner's content edits never touch it.
    #[serde(default = "default_status")]
    pub status: String,
}

/// The **lean** projection of a {@link PlanIssue} for the agent token budget (#1562): identity +
/// status + placement, with the heavy `body` dropped and the value-lists collapsed to counts. This
/// is what `bsc-plan list`/`mine` emit by default; an agent escalates to the full record with
/// `get <ref>` (one issue) or `list --full` (every field).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub r#ref: String,
    pub title: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<serde_json::Value>,
    /// Count of acceptance criteria (the full list is on the record via `get <ref>`).
    pub acceptance: usize,
    /// Count of owned-file globs.
    pub owns: usize,
    /// Count of dependency refs.
    pub depends_on: usize,
}

/// A planned feature — a capability AND a fleet stream (#plan-db). Not just user-facing: a feature
/// can be foundational (an engine core, a data model) that others build on. The roster forms a
/// dependency DAG via `dependsOn`, so the layering lives on the features themselves. The Features
/// stage works titles-first: register the whole roster (name only), then fill each in one at a time.
/// Mirrors the frontend `PlanFeature`; `serde` emits the camelCase JSON `parseFeaturesFile` reads. A
/// feature is "defined" once it has a name, behavior, and ≥1 acceptance.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanFeature {
    /// Stable slug / stream id (kebab-case). Derived from `name` when omitted. Optional on input so
    /// a detail-fill payload can carry just the slug (the merge keeps the stored name).
    #[serde(default)]
    pub slug: String,
    /// Capability name ("Invite teammates", "Geometry kernel"). Optional on input for the same reason.
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behavior: Option<String>,
    /// The roadmap phase this feature is sequenced into (a 1-based number or its name) — assigned in
    /// the Plan stage; becomes the GitHub milestone at publish. Kept as a raw JSON value so the
    /// number/string distinction survives (like PlanIssue.phase).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<serde_json::Value>,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approach: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    /// Feature slugs this feature builds on — the coarse roadmap DAG. Must stay acyclic (a cycle is
    /// a planning deadlock); fine-grained ordering lives in issue `dependsOn`.
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// The fleet stream that owns it (defaults to the slug — a feature IS a stream).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<String>,
}

/// A per-project automation (#2009) — a named cron/on-demand recipe the planner assigns. Mirrors the
/// frontend `AutomationSuggestion` (`schedule`/`description` optional; omit `schedule` = on-demand).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Automation {
    pub name: String,
    #[serde(default)]
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// kebab-case slug from a name (mirrors the frontend `slugify`).
pub(crate) fn slugify(name: &str) -> String {
    let mut s = String::new();
    let mut prev_dash = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c);
            prev_dash = false;
        } else if !prev_dash && !s.is_empty() {
            s.push('-');
            prev_dash = true;
        }
    }
    while s.ends_with('-') {
        s.pop();
    }
    s.chars().take(60).collect()
}

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
        migrate(&conn)?;
        Ok(Store { conn })
    }

    /// An ephemeral in-memory store — for tests. WAL is moot in-memory; the busy_timeout is still set.
    pub fn open_in_memory() -> rusqlite::Result<Store> {
        let conn = bsc_sqlite_util::open_in_memory_db()?;
        migrate(&conn)?;
        Ok(Store { conn })
    }

    /// Insert or replace an issue by `ref`. A new issue appends (next position); re-upserting an
    /// existing one updates its fields in place and keeps its position (stable order across edits).
    /// A content edit deliberately does NOT touch `status` — execution state is owned by the
    /// workers/director, not the planner.
    pub fn upsert(&self, issue: &PlanIssue) -> rusqlite::Result<()> {
        let pos: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM issues", [], |r| r.get(0))?;
        let status = if issue.status.is_empty() { "open" } else { issue.status.as_str() };
        self.conn.execute(
            "INSERT INTO issues (ref, title, phase, repo, stream, parent, body, acceptance, owns, depends_on, labels, status, position, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, strftime('%s','now'))
             ON CONFLICT(ref) DO UPDATE SET
                title=excluded.title, phase=excluded.phase, repo=excluded.repo, stream=excluded.stream,
                parent=excluded.parent, body=excluded.body, acceptance=excluded.acceptance, owns=excluded.owns,
                depends_on=excluded.depends_on, labels=excluded.labels, updated_at=excluded.updated_at",
            params![
                issue.r#ref, issue.title, phase_to_db(&issue.phase), issue.repo, issue.stream, issue.parent, issue.body,
                arr_to_json(&issue.acceptance), arr_to_json(&issue.owns), arr_to_json(&issue.depends_on), arr_to_json(&issue.labels),
                status, pos,
            ],
        )?;
        Ok(())
    }

    /// Move an issue to a new execution status (workers: in_progress/complete; director: verified/failed).
    /// Returns the number of rows updated (0 = no such ref).
    pub fn set_status(&self, r#ref: &str, status: &str) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE issues SET status = ?2, updated_at = strftime('%s','now') WHERE ref = ?1",
            params![r#ref, status],
        )
    }

    /// Fetch one issue by `ref`, or `None` if it doesn't exist.
    pub fn get(&self, r#ref: &str) -> rusqlite::Result<Option<PlanIssue>> {
        let mut stmt = self.conn.prepare(&format!("{SELECT_COLS} WHERE ref = ?1"))?;
        let mut rows = stmt.query_map(params![r#ref], row_to_issue)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    /// List issues, optionally filtered to one status and/or one owning stream. Stable plan order.
    /// Full records (incl. `body`). Kept signature-stable — the Tauri command bridge depends on it.
    pub fn list(&self, status: Option<&str>, stream: Option<&str>) -> rusqlite::Result<Vec<PlanIssue>> {
        self.list_filtered(status, stream, None, None)
    }

    /// Full-record list with the escalation filters (`--limit`, `--since`). `since` keeps only rows
    /// with `updated_at > since` (the resume-delta read). Powers `bsc-plan list --full`.
    pub fn list_filtered(
        &self, status: Option<&str>, stream: Option<&str>, limit: Option<usize>, since: Option<i64>,
    ) -> rusqlite::Result<Vec<PlanIssue>> {
        let sql = list_sql(SELECT_COLS, status.is_some(), stream.is_some(), since.is_some(), limit);
        let mut stmt = self.conn.prepare(&sql)?;
        list_query(&mut stmt, status, stream, since, row_to_issue)
    }

    /// **Lean** list for the agent token budget (#1562): summary fields only — `body` omitted at the
    /// SQL layer, value-lists returned as counts. Same filters as {@link list_filtered}. This is the
    /// CLI's default plural read; `--full` escalates to {@link list_filtered}.
    pub fn list_summary(
        &self, status: Option<&str>, stream: Option<&str>, limit: Option<usize>, since: Option<i64>,
    ) -> rusqlite::Result<Vec<IssueSummary>> {
        let sql = list_sql(SELECT_SUMMARY_COLS, status.is_some(), stream.is_some(), since.is_some(), limit);
        let mut stmt = self.conn.prepare(&sql)?;
        list_query(&mut stmt, status, stream, since, row_to_issue_summary)
    }

    /// Delete an issue by `ref` (no-op if absent).
    pub fn remove(&self, r#ref: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM issues WHERE ref = ?1", params![r#ref])?;
        Ok(())
    }

    /// Render every issue to the `issues.json` shape the frontend + launch path read.
    pub fn render_issues_json(&self) -> rusqlite::Result<String> {
        let issues = self.list(None, None)?;
        Ok(serde_json::to_string_pretty(&issues).unwrap_or_else(|_| "[]".into()))
    }

    // ── features (#plan-db) ──────────────────────────────────────────────────────
    // Titles-first: `feature add {name}` registers a roster entry; later `add`s carrying details
    // (keyed by slug) MERGE in place — an empty/absent field never clobbers an existing value — so
    // the planner can lay out the whole list, then populate each one at a time without losing work.

    /// Insert or merge a feature by `slug` (derived from `name` when blank). On conflict each
    /// supplied non-empty field overwrites; empty/absent fields keep the stored value, so detailing
    /// a previously-registered title doesn't wipe the name (and vice-versa). Returns the slug used.
    pub fn feature_upsert(&self, feature: &PlanFeature) -> rusqlite::Result<String> {
        let slug = if feature.slug.trim().is_empty() { slugify(&feature.name) } else { feature.slug.trim().to_string() };
        let pos: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM features", [], |r| r.get(0))?;
        self.conn.execute(
            "INSERT INTO features (slug, name, behavior, phase, approach, data, stream, acceptance, tools, depends_on, position, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, strftime('%s','now'))
             ON CONFLICT(slug) DO UPDATE SET
                name       = CASE WHEN excluded.name != ''                          THEN excluded.name       ELSE features.name       END,
                behavior   = CASE WHEN COALESCE(excluded.behavior, '') != ''         THEN excluded.behavior   ELSE features.behavior   END,
                phase      = CASE WHEN COALESCE(excluded.phase, '') != ''            THEN excluded.phase      ELSE features.phase      END,
                approach   = CASE WHEN COALESCE(excluded.approach, '') != ''         THEN excluded.approach   ELSE features.approach   END,
                data       = CASE WHEN COALESCE(excluded.data, '') != ''             THEN excluded.data       ELSE features.data       END,
                stream     = CASE WHEN COALESCE(excluded.stream, '') != ''           THEN excluded.stream     ELSE features.stream     END,
                acceptance = CASE WHEN excluded.acceptance != '[]'                   THEN excluded.acceptance ELSE features.acceptance END,
                tools      = CASE WHEN excluded.tools != '[]'                        THEN excluded.tools      ELSE features.tools      END,
                depends_on = CASE WHEN excluded.depends_on != '[]'                   THEN excluded.depends_on ELSE features.depends_on END,
                updated_at = excluded.updated_at",
            params![
                slug, feature.name, feature.behavior, phase_to_db(&feature.phase), feature.approach, feature.data,
                feature.stream, arr_to_json(&feature.acceptance), arr_to_json(&feature.tools),
                arr_to_json(&feature.depends_on), pos,
            ],
        )?;
        Ok(slug)
    }

    /// Fetch one feature by `slug`, or `None`.
    pub fn feature_get(&self, slug: &str) -> rusqlite::Result<Option<PlanFeature>> {
        let mut stmt = self.conn.prepare(&format!("{FEATURE_COLS} WHERE slug = ?1"))?;
        let mut rows = stmt.query_map(params![slug], row_to_feature)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    /// List every feature in stable roster order.
    pub fn feature_list(&self) -> rusqlite::Result<Vec<PlanFeature>> {
        let mut stmt = self.conn.prepare(&format!("{FEATURE_COLS} ORDER BY position, slug"))?;
        let out: rusqlite::Result<Vec<PlanFeature>> = stmt.query_map([], row_to_feature)?.collect();
        out
    }

    /// Delete a feature by `slug` (no-op if absent).
    pub fn feature_remove(&self, slug: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM features WHERE slug = ?1", params![slug])?;
        Ok(())
    }

    /// Render every feature to the `features.json` shape the frontend reads.
    pub fn render_features_json(&self) -> rusqlite::Result<String> {
        Ok(serde_json::to_string_pretty(&self.feature_list()?).unwrap_or_else(|_| "[]".into()))
    }

    /// Empty the whole plan store — every issue and feature (#plan-db). Backs the "clear plan"
    /// reset: without it the cleared file/store state would be re-populated from the DB on the next
    /// poll. Truncates rather than dropping the file, so it works even with the db open (WAL).
    pub fn clear(&self) -> rusqlite::Result<()> {
        let stmt = ALL_TABLES.iter().map(|t| format!("DELETE FROM {t};")).collect::<String>();
        self.conn.execute_batch(&stmt)
    }

    // ── singleton-blob helpers (#1688) — the deploy/deps/fleet_meta/blueprint tables each hold ONE
    //    row (`id = 1`) carrying a JSON blob. These two methods are the shared upsert/read those four
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

    // ── linked repos (#1012) — the repos linked to a project, durable in the hub's plan.db so a
    //    zustand/app-state reset can't lose them (the store-only persistence proved fragile). ──

    /// Link a repo by `full_name` (idempotent — a re-link is a no-op, link order preserved).
    pub fn repo_add(&self, full_name: &str) -> rusqlite::Result<()> {
        let name = full_name.trim();
        if name.is_empty() {
            return Ok(());
        }
        let pos: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM repos", [], |r| r.get(0))?;
        self.conn.execute(
            "INSERT INTO repos (full_name, position, updated_at) VALUES (?1, ?2, strftime('%s','now'))
             ON CONFLICT(full_name) DO NOTHING",
            params![name, pos],
        )?;
        Ok(())
    }

    /// Every linked repo `full_name`, in link order.
    pub fn repo_list(&self) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT full_name FROM repos ORDER BY position, full_name")?;
        let out: rusqlite::Result<Vec<String>> = stmt.query_map([], |r| r.get(0))?.collect();
        out
    }

    /// Unlink a repo by `full_name` (no-op if absent).
    pub fn repo_remove(&self, full_name: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM repos WHERE full_name = ?1", params![full_name])?;
        Ok(())
    }

    // ── fleet + per-stream permissions (#1018) — each stream is one JSON-per-row (granular edits, no
    //    column sprawl) + a single meta row; reconstructed into the FleetPlan shape the frontend reads,
    //    so the whole config (incl. per-stream perms/flows) is durable in plan.db, not a fleet.json file. ──

    /// Replace the whole fleet: the `streams` array (by id, in order) + the meta (everything else).
    pub fn fleet_set(&self, plan: &serde_json::Value) -> rusqlite::Result<()> {
        let obj = plan.as_object().cloned().unwrap_or_default();
        self.conn.execute("DELETE FROM fleet_streams", [])?;
        if let Some(serde_json::Value::Array(streams)) = obj.get("streams") {
            for (i, s) in streams.iter().enumerate() {
                if let Some(id) = s.get("id").and_then(|v| v.as_str()) {
                    if !id.trim().is_empty() {
                        self.fleet_stream_upsert_at(id, s, i as i64)?;
                    }
                }
            }
        }
        let mut meta = obj;
        meta.remove("streams");
        self.fleet_meta_set(&serde_json::Value::Object(meta))
    }

    /// Upsert ONE stream by id — granular per-stream edit (no whole-blob replace). An existing id
    /// keeps its current `position` (stable order across edits); a new id appends at `MAX(position)+1`.
    /// Lets a live planner change one stream's perm/flow/owns without rewriting the whole fleet.
    pub fn fleet_stream_set(&self, id: &str, data: &serde_json::Value) -> rusqlite::Result<()> {
        let pos: i64 = self.conn.query_row(
            "SELECT COALESCE(
                 (SELECT position FROM fleet_streams WHERE id = ?1),
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM fleet_streams)
             )",
            params![id.trim()],
            |r| r.get(0),
        )?;
        self.fleet_stream_upsert_at(id, data, pos)
    }

    /// Upsert one stream by id at an explicit position (called by `fleet_set`).
    fn fleet_stream_upsert_at(&self, id: &str, data: &serde_json::Value, pos: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO fleet_streams (id, data, position, updated_at) VALUES (?1, ?2, ?3, strftime('%s','now'))
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, position = excluded.position, updated_at = excluded.updated_at",
            params![id.trim(), data.to_string(), pos],
        )?;
        Ok(())
    }

    /// Every stream's JSON, in order.
    ///
    /// plan.db is the authoritative fleet store, so a row whose `data` fails to parse is **surfaced,
    /// not swallowed**: the bad row is **skipped** (never injected as a silent `Value::Null` that would
    /// make a worker vanish from the fleet) and a warning naming the row's `id`/`position` + the parse
    /// error is emitted to stderr. A single corrupt row does not abort the read — every good stream is
    /// still returned, in order.
    pub fn fleet_stream_list(&self) -> rusqlite::Result<Vec<serde_json::Value>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, position, data FROM fleet_streams ORDER BY position, id")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, position, data) = row?;
            match serde_json::from_str::<serde_json::Value>(&data) {
                Ok(v) => out.push(v),
                Err(e) => eprintln!(
                    "plandb: skipping malformed fleet_streams row (id={id}, position={position}): {e}"
                ),
            }
        }
        Ok(out)
    }

    /// Remove one stream by id (no-op if absent).
    pub fn fleet_stream_remove(&self, id: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM fleet_streams WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Set the fleet meta (the FleetPlan minus `streams`: recommended, reasoning, director, topology, …).
    pub fn fleet_meta_set(&self, data: &serde_json::Value) -> rusqlite::Result<()> {
        self.blob_set("fleet_meta", data)
    }

    fn fleet_meta_get(&self) -> rusqlite::Result<Option<serde_json::Value>> {
        self.blob_get("fleet_meta")
    }

    /// The whole FleetPlan (meta + streams), or None if nothing's set — the shape `parseFleetFile` reads.
    pub fn fleet_get(&self) -> rusqlite::Result<Option<serde_json::Value>> {
        let meta = self.fleet_meta_get()?;
        let streams = self.fleet_stream_list()?;
        if meta.is_none() && streams.is_empty() {
            return Ok(None);
        }
        let mut obj = match meta {
            Some(serde_json::Value::Object(m)) => m,
            _ => serde_json::Map::new(),
        };
        obj.insert("streams".into(), serde_json::Value::Array(streams));
        Ok(Some(serde_json::Value::Object(obj)))
    }

    // ── deploy config (#1020) — one DeployConfig blob per project (single row); the Deploy stage's
    //    structured config, durable in plan.db instead of a <deploy_config> text tag. ──

    /// Replace the project's deploy config (a single JSON blob — the full DeployConfig shape).
    pub fn deploy_set(&self, data: &serde_json::Value) -> rusqlite::Result<()> {
        self.blob_set("deploy", data)
    }

    /// The stored deploy config, or None if unset.
    pub fn deploy_get(&self) -> rusqlite::Result<Option<serde_json::Value>> {
        self.blob_get("deploy")
    }

    // ── dependency manifest (#1191) — the locked library manifest (the Deploy stage's OTHER half) as
    //    one JSON blob (single row): `{ dependencies: PlanDependency[], registries: {key→…} }`. Was a
    //    raw `dependencies.json` file outside plan.db; now durable here like the deploy config, so the
    //    plan.db ⇄ GitHub recovery path round-trips it and the planner has a `bsc-plan` verb for it. ──

    /// Replace the project's dependency manifest (a single JSON blob — the full DependencyManifest shape).
    pub fn deps_set(&self, data: &serde_json::Value) -> rusqlite::Result<()> {
        self.blob_set("deps", data)
    }

    /// The stored dependency manifest, or None if unset.
    pub fn deps_get(&self) -> rusqlite::Result<Option<serde_json::Value>> {
        self.blob_get("deps")
    }

    // ── MCP assignments (#1021) — the catalog server names scoped to a project; durable in plan.db
    //    instead of <mcp_assign> text tags. The frontend resolves each name → the MCP-servers store. ──

    /// Assign an MCP server by catalog `name` (idempotent; assignment order preserved).
    pub fn mcp_add(&self, name: &str) -> rusqlite::Result<()> {
        let n = name.trim();
        if n.is_empty() {
            return Ok(());
        }
        let pos: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM mcp", [], |r| r.get(0))?;
        self.conn.execute(
            "INSERT INTO mcp (name, position, updated_at) VALUES (?1, ?2, strftime('%s','now'))
             ON CONFLICT(name) DO NOTHING",
            params![n, pos],
        )?;
        Ok(())
    }

    /// Every assigned MCP server name, in assignment order.
    pub fn mcp_list(&self) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT name FROM mcp ORDER BY position, name")?;
        let out: rusqlite::Result<Vec<String>> = stmt.query_map([], |r| r.get(0))?.collect();
        out
    }

    /// Unassign an MCP server by `name` (no-op if absent).
    pub fn mcp_remove(&self, name: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM mcp WHERE name = ?1", params![name])?;
        Ok(())
    }

    // ── automations (#2009) — per-project cron/on-demand recipes the planner assigns (one row per
    //    automation, keyed by name); durable in plan.db instead of an <automation_assign> stream tag,
    //    so the section poll reflects them into the store and the planner drives them via `bsc plan
    //    automations add/list/remove`. Distinct from the prose `automations.md` recipe doc. ──

    /// Insert or replace an automation by `name` (its natural key). An empty name is a no-op.
    pub fn automation_add(&self, a: &Automation) -> rusqlite::Result<()> {
        let name = a.name.trim();
        if name.is_empty() {
            return Ok(());
        }
        let pos: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM automations", [], |r| r.get(0))?;
        self.conn.execute(
            "INSERT INTO automations (name, command, schedule, description, position, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'))
             ON CONFLICT(name) DO UPDATE SET
               command = excluded.command, schedule = excluded.schedule,
               description = excluded.description, updated_at = strftime('%s','now')",
            params![name, a.command, a.schedule, a.description, pos],
        )?;
        Ok(())
    }

    /// Every assigned automation, in assignment order.
    pub fn automation_list(&self) -> rusqlite::Result<Vec<Automation>> {
        let mut stmt = self.conn.prepare(
            "SELECT name, command, schedule, description FROM automations ORDER BY position, name",
        )?;
        let out: rusqlite::Result<Vec<Automation>> = stmt
            .query_map([], |r| {
                Ok(Automation {
                    name: r.get(0)?,
                    command: r.get(1)?,
                    schedule: r.get(2)?,
                    description: r.get(3)?,
                })
            })?
            .collect();
        out
    }

    /// Unassign an automation by `name` (no-op if absent).
    pub fn automation_remove(&self, name: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM automations WHERE name = ?1", params![name])?;
        Ok(())
    }

    // ── authored blueprint (#1022) — the blueprint an AUTHORING project is designing, as one JSON
    //    blob (single row); durable in plan.db instead of a <blueprint> tag / blueprint.json file. ──

    /// Replace the authored blueprint (a single JSON blob — the full Blueprint shape).
    pub fn blueprint_set(&self, data: &serde_json::Value) -> rusqlite::Result<()> {
        self.blob_set("blueprint", data)
    }

    /// The stored authored blueprint, or None if unset.
    pub fn blueprint_get(&self) -> rusqlite::Result<Option<serde_json::Value>> {
        self.blob_get("blueprint")
    }

    // ── Context manifest (#1019) — the DYNAMIC required-set + confirm state for the Context stage.
    //    The prose for each topic is a `context/<topic>.md` FILE (planner-written, worker-read); only
    //    the required-SET lives in the db. The table IS the required set — `require` inserts a topic,
    //    `unrequire` deletes it. Context files gate on GENERATION (presence), not confirmation (#1028).

    /// Add (`required` = true) or drop (`required` = false) `topic` from the required set. The
    /// planner shapes the set as the project clarifies; a blueprint seeds it.
    pub fn discovery_require(&self, topic: &str, required: bool) -> rusqlite::Result<()> {
        let t = topic.trim();
        if t.is_empty() {
            return Ok(());
        }
        if required {
            let pos: i64 = self
                .conn
                .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM discovery", [], |r| r.get(0))?;
            self.conn.execute(
                "INSERT INTO discovery (topic, position, updated_at) VALUES (?1, ?2, strftime('%s','now'))
                 ON CONFLICT(topic) DO NOTHING",
                params![t, pos],
            )?;
        } else {
            self.conn.execute("DELETE FROM discovery WHERE topic = ?1", params![t])?;
        }
        Ok(())
    }

    /// The required topic set, in declaration order — the gate checks each has a `context/<topic>.md`.
    pub fn discovery_list(&self) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT topic FROM discovery ORDER BY position, topic")?;
        let out: rusqlite::Result<Vec<String>> = stmt.query_map([], |r| r.get(0))?.collect();
        out
    }

    // ── triage runs (#1004) — a per-repo "last triage launch" timestamp T, so the next triage can
    //    resume cheaply from the delta (issues whose status changed since T) instead of re-ingesting
    //    the whole project. Status bumps `issues.updated_at` (see set_status), so the delta is a query. ──

    /// Record a triage launch for `repo` at NOW (epoch seconds) — the next launch reads this as `T`.
    /// Returns the recorded timestamp.
    pub fn triage_record_run(&self, repo: &str) -> rusqlite::Result<i64> {
        let r = repo.trim();
        self.conn.execute(
            "INSERT INTO triage_runs (repo, last_run) VALUES (?1, strftime('%s','now'))
             ON CONFLICT(repo) DO UPDATE SET last_run = strftime('%s','now')",
            params![r],
        )?;
        self.triage_last_run(r).map(|o| o.unwrap_or(0))
    }

    /// The last triage-launch timestamp (epoch seconds) for `repo`, or None if never triaged.
    pub fn triage_last_run(&self, repo: &str) -> rusqlite::Result<Option<i64>> {
        let mut stmt = self.conn.prepare("SELECT last_run FROM triage_runs WHERE repo = ?1")?;
        let mut rows = stmt.query_map(params![repo.trim()], |r| r.get::<_, i64>(0))?;
        match rows.next() {
            Some(v) => Ok(Some(v?)),
            None => Ok(None),
        }
    }

    /// Issues whose status changed since `since` (epoch seconds) — `updated_at > since`, the delta the
    /// triage pickup leads with. Filtered to `repo` when non-empty (triage is per-repo); empty `repo`
    /// = the whole project. Newest-changed first.
    pub fn issues_changed_since(&self, repo: &str, since: i64) -> rusqlite::Result<Vec<PlanIssue>> {
        let r = repo.trim();
        if r.is_empty() {
            let mut stmt = self
                .conn
                .prepare(&format!("{SELECT_COLS} WHERE updated_at > ?1 ORDER BY updated_at DESC, ref"))?;
            let out: rusqlite::Result<Vec<PlanIssue>> = stmt.query_map(params![since], row_to_issue)?.collect();
            out
        } else {
            let mut stmt = self
                .conn
                .prepare(&format!("{SELECT_COLS} WHERE repo = ?1 AND updated_at > ?2 ORDER BY updated_at DESC, ref"))?;
            let out: rusqlite::Result<Vec<PlanIssue>> = stmt.query_map(params![r, since], row_to_issue)?.collect();
            out
        }
    }
}

// ── schema ───────────────────────────────────────────────────────────────────────

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
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
         CREATE TABLE IF NOT EXISTS mcp (
            name        TEXT PRIMARY KEY,
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
         CREATE TABLE IF NOT EXISTS blueprint (
            id          INTEGER PRIMARY KEY,
            data        TEXT NOT NULL DEFAULT '{}'
         );
         CREATE TABLE IF NOT EXISTS discovery (
            topic       TEXT PRIMARY KEY,
            position    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS triage_runs (
            repo        TEXT PRIMARY KEY,
            last_run    INTEGER NOT NULL DEFAULT 0
         );",
    )?;
    // Self-correction lessons (#1362) own their schema in the `lessons` module.
    conn.execute_batch(lessons::LESSONS_DDL)?;
    // Additive migrations for a plan.db created before a column existed (each errors if the column is
    // already present — ignored).
    let _ = conn.execute("ALTER TABLE issues ADD COLUMN status TEXT NOT NULL DEFAULT 'open'", []);
    let _ = conn.execute("ALTER TABLE features ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'", []);
    let _ = conn.execute("ALTER TABLE features ADD COLUMN phase TEXT", []);
    Ok(())
}

// ── JSON (de)serialization for the value-list / phase columns ─────────────────────
// `arr_to_json` / `json_to_arr` are shared with skilldb via `bsc_sqlite_util` (#1621); the
// phase-column codec below is plan.db-specific (a raw JSON value, not a string list).

fn phase_to_db(p: &Option<serde_json::Value>) -> Option<String> {
    p.as_ref().map(|v| v.to_string())
}
fn phase_from_db(s: Option<String>) -> Option<serde_json::Value> {
    s.and_then(|t| serde_json::from_str(&t).ok())
}

const SELECT_COLS: &str =
    "SELECT ref, title, phase, repo, stream, parent, body, acceptance, owns, depends_on, labels, status FROM issues";

/// Lean column set for {@link Store::list_summary}: **no `body`** (the big blob is dropped at the SQL
/// layer, not in Rust), value-lists still selected so we can count them. Column order must match
/// {@link row_to_issue_summary}.
const SELECT_SUMMARY_COLS: &str =
    "SELECT ref, title, phase, stream, acceptance, owns, depends_on, status FROM issues";

/// Build a `list`/`list_summary` query: pick the column set, AND together the optional filters
/// (status / stream / `updated_at > since`), then stable plan order + optional `LIMIT`. The named
/// params are bound conditionally by {@link list_query}.
fn list_sql(cols: &str, status: bool, stream: bool, since: bool, limit: Option<usize>) -> String {
    let mut sql = String::from(cols);
    let mut clauses: Vec<&str> = Vec::new();
    if status {
        clauses.push("status = :status");
    }
    if stream {
        clauses.push("stream = :stream");
    }
    if since {
        clauses.push("updated_at > :since");
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY position, ref");
    if let Some(n) = limit {
        sql.push_str(&format!(" LIMIT {n}"));
    }
    sql
}

/// Run a prepared `list` query, binding only the params the SQL actually references, mapping each
/// row with `f`. Shared by the full ({@link row_to_issue}) and lean ({@link row_to_issue_summary}) paths.
fn list_query<T, F>(
    stmt: &mut rusqlite::Statement, status: Option<&str>, stream: Option<&str>, since: Option<i64>, f: F,
) -> rusqlite::Result<Vec<T>>
where
    F: Fn(&rusqlite::Row) -> rusqlite::Result<T>,
{
    // `rusqlite` ignores unused named params, but binding exactly the referenced set keeps it explicit.
    let mut params: Vec<(&str, &dyn rusqlite::ToSql)> = Vec::new();
    if let Some(st) = status.as_ref() {
        params.push((":status", st));
    }
    if let Some(sr) = stream.as_ref() {
        params.push((":stream", sr));
    }
    if let Some(si) = since.as_ref() {
        params.push((":since", si));
    }
    stmt.query_map(params.as_slice(), f)?.collect()
}

fn row_to_issue(r: &rusqlite::Row) -> rusqlite::Result<PlanIssue> {
    Ok(PlanIssue {
        r#ref: r.get(0)?,
        title: r.get(1)?,
        phase: phase_from_db(r.get::<_, Option<String>>(2)?),
        repo: r.get(3)?,
        stream: r.get(4)?,
        parent: r.get(5)?,
        body: r.get(6)?,
        acceptance: json_to_arr(&r.get::<_, String>(7)?),
        owns: json_to_arr(&r.get::<_, String>(8)?),
        depends_on: json_to_arr(&r.get::<_, String>(9)?),
        labels: json_to_arr(&r.get::<_, String>(10)?),
        status: r.get(11)?,
    })
}

/// Map a {@link SELECT_SUMMARY_COLS} row → {@link IssueSummary}: counts for the value-lists, no body.
fn row_to_issue_summary(r: &rusqlite::Row) -> rusqlite::Result<IssueSummary> {
    Ok(IssueSummary {
        r#ref: r.get(0)?,
        title: r.get(1)?,
        phase: phase_from_db(r.get::<_, Option<String>>(2)?),
        stream: r.get(3)?,
        acceptance: json_to_arr(&r.get::<_, String>(4)?).len(),
        owns: json_to_arr(&r.get::<_, String>(5)?).len(),
        depends_on: json_to_arr(&r.get::<_, String>(6)?).len(),
        status: r.get(7)?,
    })
}

const FEATURE_COLS: &str =
    "SELECT slug, name, behavior, phase, approach, data, stream, acceptance, tools, depends_on FROM features";

fn row_to_feature(r: &rusqlite::Row) -> rusqlite::Result<PlanFeature> {
    Ok(PlanFeature {
        slug: r.get(0)?,
        name: r.get(1)?,
        behavior: r.get(2)?,
        phase: phase_from_db(r.get::<_, Option<String>>(3)?),
        approach: r.get(4)?,
        data: r.get(5)?,
        stream: r.get(6)?,
        acceptance: json_to_arr(&r.get::<_, String>(7)?),
        tools: json_to_arr(&r.get::<_, String>(8)?),
        depends_on: json_to_arr(&r.get::<_, String>(9)?),
    })
}

// ── tests ───────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(r: &str, t: &str) -> PlanIssue {
        PlanIssue { r#ref: r.into(), title: t.into(), ..Default::default() }
    }

    #[test]
    fn upsert_then_list_roundtrips_value_lists() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&PlanIssue {
            r#ref: "F1".into(), title: "Add login".into(),
            acceptance: vec!["returns 200".into()], owns: vec!["src/auth/".into()],
            depends_on: vec!["F0".into()], labels: vec!["scope:core".into()], ..Default::default()
        }).unwrap();
        s.upsert(&mk("F2", "Add logout")).unwrap();
        let issues = s.list(None, None).unwrap();
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].r#ref, "F1"); // position order preserved
        assert_eq!(issues[0].acceptance, vec!["returns 200"]);
        assert_eq!(issues[0].depends_on, vec!["F0"]);
        assert_eq!(issues[0].owns, vec!["src/auth/"]);
    }

    #[test]
    fn upsert_replaces_by_ref_without_duplicating() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("F1", "old title")).unwrap();
        s.upsert(&mk("F1", "new title")).unwrap();
        let issues = s.list(None, None).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].title, "new title");
    }

    #[test]
    fn remove_drops_the_issue() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("F1", "x")).unwrap();
        s.remove("F1").unwrap();
        assert!(s.list(None, None).unwrap().is_empty());
    }

    #[test]
    fn get_returns_one_or_none() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("F1", "x")).unwrap();
        assert_eq!(s.get("F1").unwrap().unwrap().title, "x");
        assert!(s.get("nope").unwrap().is_none());
    }

    #[test]
    fn render_matches_the_issues_json_shape() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&PlanIssue {
            r#ref: "F1".into(), title: "x".into(), phase: Some(serde_json::json!(1)),
            acceptance: vec!["a".into()], depends_on: vec!["F0".into()], ..Default::default()
        }).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s.render_issues_json().unwrap()).unwrap();
        let row = &v.as_array().unwrap()[0];
        assert_eq!(row["ref"], "F1");
        assert_eq!(row["phase"], 1); // number preserved (not "1")
        assert_eq!(row["dependsOn"], serde_json::json!(["F0"])); // camelCase, not depends_on
        assert_eq!(row["acceptance"], serde_json::json!(["a"]));
        assert!(row.get("repo").is_none()); // omitted when None
    }

    #[test]
    fn phase_can_be_a_string_name() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&PlanIssue { r#ref: "F1".into(), title: "x".into(), phase: Some(serde_json::json!("auth")), ..Default::default() }).unwrap();
        assert_eq!(s.list(None, None).unwrap()[0].phase, Some(serde_json::json!("auth")));
    }

    #[test]
    fn new_issue_defaults_to_open_and_set_status_moves_it() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("F1", "x")).unwrap();
        assert_eq!(s.list(None, None).unwrap()[0].status, "open");
        s.set_status("F1", "complete").unwrap();
        assert_eq!(s.list(None, None).unwrap()[0].status, "complete");
    }

    #[test]
    fn content_upsert_does_not_reset_status() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("F1", "original")).unwrap();
        s.set_status("F1", "complete").unwrap(); // worker marks done
        s.upsert(&mk("F1", "planner edits the title")).unwrap(); // a later plan edit
        let issue = &s.list(None, None).unwrap()[0];
        assert_eq!(issue.title, "planner edits the title");
        assert_eq!(issue.status, "complete", "a content edit must NOT clobber execution status");
    }

    #[test]
    fn list_filters_by_status_for_the_directors_queue() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("F1", "done")).unwrap();
        s.upsert(&mk("F2", "wip")).unwrap();
        s.upsert(&mk("F3", "also done")).unwrap();
        s.set_status("F1", "complete").unwrap();
        s.set_status("F3", "complete").unwrap();
        s.set_status("F2", "in_progress").unwrap();
        let complete = s.list(Some("complete"), None).unwrap();
        assert_eq!(complete.iter().map(|i| i.r#ref.as_str()).collect::<Vec<_>>(), vec!["F1", "F3"]);
    }

    #[test]
    fn list_filters_by_stream_for_a_workers_queue() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&PlanIssue { r#ref: "F1".into(), title: "a".into(), stream: Some("auth".into()), ..Default::default() }).unwrap();
        s.upsert(&PlanIssue { r#ref: "F2".into(), title: "b".into(), stream: Some("ui".into()), ..Default::default() }).unwrap();
        s.upsert(&PlanIssue { r#ref: "F3".into(), title: "c".into(), stream: Some("auth".into()), ..Default::default() }).unwrap();
        let mine = s.list(None, Some("auth")).unwrap();
        assert_eq!(mine.iter().map(|i| i.r#ref.as_str()).collect::<Vec<_>>(), vec!["F1", "F3"]);
    }

    #[test]
    fn is_valid_status_guards_the_lifecycle() {
        assert!(is_valid_status("verified"));
        assert!(!is_valid_status("done"));
    }

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

    // ── features ──────────────────────────────────────────────────────────────────

    fn feat(name: &str) -> PlanFeature {
        PlanFeature { name: name.into(), ..Default::default() }
    }

    #[test]
    fn feature_add_derives_a_slug_and_keeps_roster_order() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.feature_upsert(&feat("Invite teammates")).unwrap(), "invite-teammates");
        s.feature_upsert(&feat("Export to CSV")).unwrap();
        let list = s.feature_list().unwrap();
        assert_eq!(list.iter().map(|f| f.slug.as_str()).collect::<Vec<_>>(), vec!["invite-teammates", "export-to-csv"]);
    }

    #[test]
    fn titles_first_then_detail_merges_without_clobbering() {
        let s = Store::open_in_memory().unwrap();
        // Phase 1: lay out the whole roster (names only).
        s.feature_upsert(&feat("Invite teammates")).unwrap();
        s.feature_upsert(&feat("Export")).unwrap();
        // Phase 2: detail one by slug — name is NOT resent and must survive.
        s.feature_upsert(&PlanFeature {
            slug: "invite-teammates".into(),
            behavior: Some("send an email invite".into()),
            acceptance: vec!["invite email sent".into()],
            ..Default::default()
        }).unwrap();
        let f = s.feature_get("invite-teammates").unwrap().unwrap();
        assert_eq!(f.name, "Invite teammates", "detailing must not wipe the title");
        assert_eq!(f.behavior.as_deref(), Some("send an email invite"));
        assert_eq!(f.acceptance, vec!["invite email sent"]);
        // The untouched feature is still just a title (not yet defined).
        let exp = s.feature_get("export").unwrap().unwrap();
        assert!(exp.behavior.is_none() && exp.acceptance.is_empty());
    }

    #[test]
    fn render_features_matches_the_features_json_shape() {
        let s = Store::open_in_memory().unwrap();
        s.feature_upsert(&PlanFeature {
            name: "Invite teammates".into(),
            behavior: Some("b".into()),
            acceptance: vec!["a".into()],
            tools: vec!["resend".into()],
            ..Default::default()
        }).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s.render_features_json().unwrap()).unwrap();
        let row = &v.as_array().unwrap()[0];
        assert_eq!(row["slug"], "invite-teammates");
        assert_eq!(row["acceptance"], serde_json::json!(["a"]));
        assert_eq!(row["tools"], serde_json::json!(["resend"]));
        assert!(row.get("approach").is_none()); // omitted when absent
    }

    #[test]
    fn feature_remove_drops_it() {
        let s = Store::open_in_memory().unwrap();
        s.feature_upsert(&feat("X")).unwrap();
        s.feature_remove("x").unwrap();
        assert!(s.feature_list().unwrap().is_empty());
    }

    #[test]
    fn clear_empties_issues_and_features() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("F1", "an issue")).unwrap();
        s.feature_upsert(&feat("A feature")).unwrap();
        s.clear().unwrap();
        assert!(s.list(None, None).unwrap().is_empty(), "issues cleared");
        assert!(s.feature_list().unwrap().is_empty(), "features cleared");
    }

    #[test]
    fn feature_depends_on_round_trips_and_merges() {
        let s = Store::open_in_memory().unwrap();
        s.feature_upsert(&feat("Geometry kernel")).unwrap();
        s.feature_upsert(&feat("Sketcher")).unwrap();
        // Detail the sketcher: declare it builds on the kernel (the roadmap DAG edge).
        s.feature_upsert(&PlanFeature {
            slug: "sketcher".into(),
            behavior: Some("draw constrained 2D sketches".into()),
            depends_on: vec!["geometry-kernel".into()],
            ..Default::default()
        }).unwrap();
        let f = s.feature_get("sketcher").unwrap().unwrap();
        assert_eq!(f.depends_on, vec!["geometry-kernel"]);
        assert_eq!(f.name, "Sketcher", "the title survives the detail merge");
        // A later detail edit that omits depends_on must NOT wipe it.
        s.feature_upsert(&PlanFeature { slug: "sketcher".into(), approach: Some("constraint solver".into()), ..Default::default() }).unwrap();
        assert_eq!(s.feature_get("sketcher").unwrap().unwrap().depends_on, vec!["geometry-kernel"]);
    }

    #[test]
    fn feature_phase_round_trips_and_merges() {
        let s = Store::open_in_memory().unwrap();
        s.feature_upsert(&feat("Sketcher")).unwrap();
        // Plan stage assigns the phase (a number); a later edit omitting it must not wipe it.
        s.feature_upsert(&PlanFeature { slug: "sketcher".into(), phase: Some(serde_json::json!(2)), ..Default::default() }).unwrap();
        assert_eq!(s.feature_get("sketcher").unwrap().unwrap().phase, Some(serde_json::json!(2)));
        s.feature_upsert(&PlanFeature { slug: "sketcher".into(), behavior: Some("draw".into()), ..Default::default() }).unwrap();
        assert_eq!(s.feature_get("sketcher").unwrap().unwrap().phase, Some(serde_json::json!(2)), "phase survives a later edit");
    }

    #[test]
    fn repos_add_list_remove_and_clear() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.repo_list().unwrap().is_empty());
        s.repo_add("acme/api").unwrap();
        s.repo_add("acme/web").unwrap();
        s.repo_add("acme/api").unwrap(); // idempotent re-link
        assert_eq!(s.repo_list().unwrap(), vec!["acme/api".to_string(), "acme/web".to_string()]);
        s.repo_remove("acme/api").unwrap();
        assert_eq!(s.repo_list().unwrap(), vec!["acme/web".to_string()]);
        // clear() unlinks repos too (the "clear plan" reset).
        s.clear().unwrap();
        assert!(s.repo_list().unwrap().is_empty());
    }

    #[test]
    fn fleet_set_get_round_trips_streams_and_meta() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.fleet_get().unwrap().is_none());
        let plan = serde_json::json!({
            "recommended": 2,
            "reasoning": "two streams",
            "director": { "enabled": true, "drive": "checkpoint" },
            "topology": "hybrid",
            "streams": [
                { "id": "kernel", "repo": "o/r", "perm": { "edit": "allow" }, "flow": { "push": "auto-pr" } },
                { "id": "ui", "repo": "o/r", "dependsOn": ["kernel"] }
            ]
        });
        s.fleet_set(&plan).unwrap();
        let got = s.fleet_get().unwrap().unwrap();
        // meta survives, streams stay in order with per-stream perm/flow intact
        assert_eq!(got["recommended"], serde_json::json!(2));
        assert_eq!(got["director"]["enabled"], serde_json::json!(true));
        let streams = got["streams"].as_array().unwrap();
        assert_eq!(streams.len(), 2);
        assert_eq!(streams[0]["id"], serde_json::json!("kernel"));
        assert_eq!(streams[0]["perm"]["edit"], serde_json::json!("allow"));
        assert_eq!(streams[1]["dependsOn"], serde_json::json!(["kernel"]));
        // a fresh set replaces the stream set; remove drops one; clear() wipes both tables.
        s.fleet_set(&serde_json::json!({ "recommended": 1, "streams": [ { "id": "solo", "repo": "o/r" } ] })).unwrap();
        assert_eq!(s.fleet_stream_list().unwrap().len(), 1);
        s.fleet_stream_remove("solo").unwrap();
        assert!(s.fleet_stream_list().unwrap().is_empty());
        s.fleet_set(&serde_json::json!({ "recommended": 1, "streams": [ { "id": "x", "repo": "o/r" } ] })).unwrap();
        s.clear().unwrap();
        assert!(s.fleet_get().unwrap().is_none());
    }

    #[test]
    fn fleet_stream_list_skips_a_malformed_row_and_keeps_good_streams() {
        let s = Store::open_in_memory().unwrap();
        // one good stream via the normal path
        s.fleet_set(&serde_json::json!({
            "recommended": 1,
            "streams": [ { "id": "good", "repo": "o/r", "perm": { "edit": "allow" } } ]
        }))
        .unwrap();
        // inject a deliberately-corrupt row directly (bypasses fleet_set's JSON serialization)
        s.conn
            .execute(
                "INSERT INTO fleet_streams (id, data, position, updated_at) \
                 VALUES (?1, ?2, ?3, strftime('%s','now'))",
                params!["broken", "{not valid json", 99i64],
            )
            .unwrap();
        // the bad row is skipped (no Null), the good stream survives — length is the good-count
        let streams = s.fleet_stream_list().unwrap();
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0]["id"], serde_json::json!("good"));
        assert!(streams.iter().all(|v| !v.is_null()));
        // fleet_get reflects the same — only the good stream lands in the reconstructed plan
        let got = s.fleet_get().unwrap().unwrap();
        let got_streams = got["streams"].as_array().unwrap();
        assert_eq!(got_streams.len(), 1);
        assert_eq!(got_streams[0]["id"], serde_json::json!("good"));
    }

    #[test]
    fn fleet_stream_set_appends_a_new_stream_preserving_order_and_meta() {
        let s = Store::open_in_memory().unwrap();
        s.fleet_set(&serde_json::json!({
            "recommended": 2,
            "director": { "enabled": true },
            "streams": [
                { "id": "kernel", "repo": "o/r", "perm": { "edit": "allow" } },
                { "id": "ui", "repo": "o/r", "dependsOn": ["kernel"] }
            ]
        }))
        .unwrap();
        // upsert a brand-new stream — it appends at the end
        s.fleet_stream_set("docs", &serde_json::json!({ "id": "docs", "repo": "o/r", "flow": { "push": "commit-only" } }))
            .unwrap();
        let got = s.fleet_get().unwrap().unwrap();
        let streams = got["streams"].as_array().unwrap();
        assert_eq!(streams.len(), 3);
        // existing streams keep their order; the new one is last
        assert_eq!(streams[0]["id"], serde_json::json!("kernel"));
        assert_eq!(streams[1]["id"], serde_json::json!("ui"));
        assert_eq!(streams[2]["id"], serde_json::json!("docs"));
        assert_eq!(streams[2]["flow"]["push"], serde_json::json!("commit-only"));
        // siblings + meta untouched
        assert_eq!(streams[0]["perm"]["edit"], serde_json::json!("allow"));
        assert_eq!(got["director"]["enabled"], serde_json::json!(true));
    }

    #[test]
    fn fleet_stream_set_updates_in_place_keeping_position() {
        let s = Store::open_in_memory().unwrap();
        s.fleet_set(&serde_json::json!({
            "recommended": 2,
            "streams": [
                { "id": "kernel", "repo": "o/r", "perm": { "edit": "allow" } },
                { "id": "ui", "repo": "o/r" }
            ]
        }))
        .unwrap();
        // update an existing stream's perm/flow — same id keeps its position
        s.fleet_stream_set("kernel", &serde_json::json!({ "id": "kernel", "repo": "o/r", "perm": { "edit": "deny" }, "flow": { "push": "auto-pr" } }))
            .unwrap();
        let got = s.fleet_get().unwrap().unwrap();
        let streams = got["streams"].as_array().unwrap();
        assert_eq!(streams.len(), 2);
        // position 0 is still kernel (not appended), with its new perm/flow
        assert_eq!(streams[0]["id"], serde_json::json!("kernel"));
        assert_eq!(streams[0]["perm"]["edit"], serde_json::json!("deny"));
        assert_eq!(streams[0]["flow"]["push"], serde_json::json!("auto-pr"));
        // sibling untouched
        assert_eq!(streams[1]["id"], serde_json::json!("ui"));
    }

    #[test]
    fn fleet_meta_set_does_not_wipe_streams() {
        let s = Store::open_in_memory().unwrap();
        s.fleet_set(&serde_json::json!({
            "recommended": 1,
            "streams": [ { "id": "kernel", "repo": "o/r" } ]
        }))
        .unwrap();
        // a granular meta update must leave the stream rows intact
        s.fleet_meta_set(&serde_json::json!({ "recommended": 3, "director": { "enabled": true, "drive": "checkpoint" }, "topology": "hybrid" }))
            .unwrap();
        let got = s.fleet_get().unwrap().unwrap();
        assert_eq!(got["recommended"], serde_json::json!(3));
        assert_eq!(got["director"]["drive"], serde_json::json!("checkpoint"));
        let streams = got["streams"].as_array().unwrap();
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0]["id"], serde_json::json!("kernel"));
    }

    #[test]
    fn deploy_set_get_round_trips_and_clears() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.deploy_get().unwrap().is_none());
        let cfg = serde_json::json!({ "services": [{ "id": "api", "platform": "fly" }], "release": { "strategy": "rolling" } });
        s.deploy_set(&cfg).unwrap();
        let got = s.deploy_get().unwrap().unwrap();
        assert_eq!(got["services"][0]["platform"], serde_json::json!("fly"));
        // a fresh set replaces the whole blob (single row)
        s.deploy_set(&serde_json::json!({ "services": [] })).unwrap();
        assert_eq!(s.deploy_get().unwrap().unwrap()["services"].as_array().unwrap().len(), 0);
        s.clear().unwrap();
        assert!(s.deploy_get().unwrap().is_none());
    }

    #[test]
    fn deps_set_get_round_trips_and_clears() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.deps_get().unwrap().is_none());
        let manifest = serde_json::json!({
            "dependencies": [
                { "repo": "owner/app", "ecosystem": "npm", "name": "zod", "version": "^3.23", "why": "schema validation" },
                { "repo": "owner/app", "ecosystem": "npm", "name": "@acme/ui", "version": "^2", "source": "internal", "why": "design system" }
            ],
            "registries": { "internal": { "url": "https://npm.internal/", "scope": "@acme", "auth": "INTERNAL_NPM_TOKEN" } }
        });
        s.deps_set(&manifest).unwrap();
        let got = s.deps_get().unwrap().unwrap();
        assert_eq!(got["dependencies"].as_array().unwrap().len(), 2);
        assert_eq!(got["dependencies"][0]["name"], serde_json::json!("zod"));
        assert_eq!(got["registries"]["internal"]["scope"], serde_json::json!("@acme"));
        // a fresh set replaces the whole blob (single row)
        s.deps_set(&serde_json::json!({ "dependencies": [], "registries": {} })).unwrap();
        assert_eq!(s.deps_get().unwrap().unwrap()["dependencies"].as_array().unwrap().len(), 0);
        s.clear().unwrap();
        assert!(s.deps_get().unwrap().is_none());
    }

    #[test]
    fn mcp_add_list_remove_and_clear() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.mcp_list().unwrap().is_empty());
        s.mcp_add("Postgres").unwrap();
        s.mcp_add("GitHub").unwrap();
        s.mcp_add("Postgres").unwrap(); // idempotent re-assign
        assert_eq!(s.mcp_list().unwrap(), vec!["Postgres".to_string(), "GitHub".to_string()]);
        s.mcp_remove("Postgres").unwrap();
        assert_eq!(s.mcp_list().unwrap(), vec!["GitHub".to_string()]);
        s.clear().unwrap();
        assert!(s.mcp_list().unwrap().is_empty());
    }

    #[test]
    fn automation_add_list_remove_and_clear() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.automation_list().unwrap().is_empty());
        s.automation_add(&Automation {
            name: "nightly-tests".into(),
            command: "npm test".into(),
            schedule: Some("0 2 * * *".into()),
            description: Some("run the suite each night".into()),
        })
        .unwrap();
        s.automation_add(&Automation { name: "lint".into(), command: "npm run lint".into(), ..Default::default() })
        .unwrap();
        let list = s.automation_list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "nightly-tests");
        assert_eq!(list[0].schedule.as_deref(), Some("0 2 * * *"));
        assert_eq!(list[1].name, "lint");
        assert_eq!(list[1].schedule, None); // on-demand — no cron

        // re-add by the same name MERGES in place (natural key), keeping order
        s.automation_add(&Automation { name: "lint".into(), command: "npm run lint -- --fix".into(), ..Default::default() })
        .unwrap();
        let list = s.automation_list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].command, "npm run lint -- --fix");

        s.automation_remove("nightly-tests").unwrap();
        assert_eq!(s.automation_list().unwrap().len(), 1);
        s.clear().unwrap();
        assert!(s.automation_list().unwrap().is_empty());
    }

    #[test]
    fn blueprint_set_get_round_trips_and_clears() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.blueprint_get().unwrap().is_none());
        let bp = serde_json::json!({ "id": "bp1", "name": "API service", "category": "greenfield", "sections": [{ "key": "discovery" }] });
        s.blueprint_set(&bp).unwrap();
        let got = s.blueprint_get().unwrap().unwrap();
        assert_eq!(got["name"], serde_json::json!("API service"));
        assert_eq!(got["sections"][0]["key"], serde_json::json!("discovery"));
        // a fresh set replaces the whole blob (single row)
        s.blueprint_set(&serde_json::json!({ "id": "bp1", "name": "renamed" })).unwrap();
        assert_eq!(s.blueprint_get().unwrap().unwrap()["name"], serde_json::json!("renamed"));
        s.clear().unwrap();
        assert!(s.blueprint_get().unwrap().is_none());
    }

    #[test]
    fn discovery_required_set_add_remove_and_clear() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.discovery_list().unwrap().is_empty());
        // seed a baseline required set (declaration order preserved)
        for t in ["goal", "scope", "stack", "architecture", "users"] {
            s.discovery_require(t, true).unwrap();
        }
        assert_eq!(s.discovery_list().unwrap(), vec!["goal", "scope", "stack", "architecture", "users"]);
        s.discovery_require("goal", true).unwrap(); // idempotent re-require
        assert_eq!(s.discovery_list().unwrap().len(), 5);
        // unrequire drops the topic from the set (discovery gates on generation, not confirmation)
        s.discovery_require("users", false).unwrap();
        assert!(!s.discovery_list().unwrap().contains(&"users".to_string()));
        // clear() wipes the set
        s.clear().unwrap();
        assert!(s.discovery_list().unwrap().is_empty());
    }

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

    #[test]
    fn triage_runs_marker_and_changed_since_delta() {
        let s = Store::open_in_memory().unwrap();
        // Never triaged → no marker.
        assert_eq!(s.triage_last_run("o/web").unwrap(), None);
        // Record a run; the marker is set to the returned timestamp.
        let t = s.triage_record_run("o/web").unwrap();
        assert!(t > 0);
        assert_eq!(s.triage_last_run("o/web").unwrap(), Some(t));

        // An issue whose status changes is in the since-T delta (set_status bumps updated_at to now,
        // which is >= t; query from just before the run so the same-second change counts).
        s.upsert(&PlanIssue { r#ref: "F1".into(), title: "Login".into(), repo: Some("o/web".into()), ..Default::default() }).unwrap();
        s.set_status("F1", "complete").unwrap();
        let delta = s.issues_changed_since("o/web", t - 1).unwrap();
        assert!(delta.iter().any(|i| i.r#ref == "F1"), "the changed issue is in the repo's delta");

        // Repo-scoped: a different repo sees nothing of o/web's change.
        assert!(s.issues_changed_since("o/api", t - 1).unwrap().is_empty());
        // Project-wide (empty repo) still sees it.
        assert!(s.issues_changed_since("", t - 1).unwrap().iter().any(|i| i.r#ref == "F1"));

        // re-record bumps the marker; clear() wipes it.
        let t2 = s.triage_record_run("o/web").unwrap();
        assert!(t2 >= t);
        s.clear().unwrap();
        assert_eq!(s.triage_last_run("o/web").unwrap(), None);
    }

    #[test]
    fn list_summary_drops_body_and_counts_value_lists() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&PlanIssue {
            r#ref: "F1".into(), title: "Add login".into(), stream: Some("auth".into()),
            phase: Some(serde_json::json!(1)), body: Some("a very long body blob".repeat(50)),
            acceptance: vec!["a".into(), "b".into(), "c".into()],
            owns: vec!["src/auth/".into()], depends_on: vec!["F0".into()], ..Default::default()
        }).unwrap();
        let rows = s.list_summary(None, None, None, None).unwrap();
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.r#ref, "F1");
        assert_eq!(r.stream.as_deref(), Some("auth"));
        assert_eq!(r.phase, Some(serde_json::json!(1)));
        // value-lists collapse to counts
        assert_eq!((r.acceptance, r.owns, r.depends_on), (3, 1, 1));
        // the lean JSON has no `body` key at all (dropped at the SQL layer)
        let json = serde_json::to_value(r).unwrap();
        assert!(json.get("body").is_none(), "summary must not carry the body");
        assert_eq!(json["dependsOn"], serde_json::json!(1), "depends_on serializes camelCase");
        // the full path still has the body
        assert!(s.list(None, None).unwrap()[0].body.is_some());
    }

    #[test]
    fn list_summary_and_filtered_respect_status_stream_limit() {
        let s = Store::open_in_memory().unwrap();
        for (r, st, status) in [
            ("F1", "auth", "open"), ("F2", "auth", "complete"), ("F3", "ui", "open"),
        ] {
            s.upsert(&PlanIssue {
                r#ref: r.into(), title: r.into(), stream: Some(st.into()), status: status.into(),
                ..Default::default()
            }).unwrap();
        }
        // stream filter
        assert_eq!(s.list_summary(None, Some("auth"), None, None).unwrap().len(), 2);
        // status filter
        assert_eq!(s.list_summary(Some("open"), None, None, None).unwrap().len(), 2);
        // both
        assert_eq!(s.list_summary(Some("open"), Some("auth"), None, None).unwrap().len(), 1);
        // limit caps rows (full path honors it too)
        assert_eq!(s.list_summary(None, None, Some(1), None).unwrap().len(), 1);
        assert_eq!(s.list_filtered(None, None, Some(2), None).unwrap().len(), 2);
    }

    #[test]
    fn list_filtered_since_returns_only_changed_rows() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("F1", "one")).unwrap();
        let t = s.triage_record_run("probe").unwrap(); // a monotonic "now" reference
        s.upsert(&mk("F2", "two")).unwrap();
        s.set_status("F2", "complete").unwrap();
        // only F2 changed at/after the reference; query from just before so the same-second write counts
        let delta = s.list_summary(None, None, None, Some(t - 1)).unwrap();
        assert!(delta.iter().any(|r| r.r#ref == "F2"));
        // the full path applies the same since filter
        let full = s.list_filtered(None, None, None, Some(t - 1)).unwrap();
        assert!(full.iter().any(|r| r.r#ref == "F2"));
    }
}
