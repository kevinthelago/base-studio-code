//! Native per-project plan store (#plan-db). The canonical, granular store for a project's plan: the
//! planner upserts ONE item at a time (via the `bsc-plan` CLI) instead of rewriting whole files, and
//! the execution files (issues.json, …) are RENDERED from here at launch — so everything downstream
//! is unchanged and a file is still inspectable. One SQLite db per project hub: `projects/<key>/plan.db`.
//!
//! This crate is Tauri-free on purpose: the desktop app (`src-tauri`) and the `bsc-plan` agent CLI
//! both depend on it, so the CLI stays a tiny binary instead of relinking the whole app.
//!
//! Increment 1 (issues-first): the `issues` table + CRUD + a render to the `issues.json` shape the
//! frontend `parseIssuesFile` expects. Value-list fields are stored as JSON text for now; the
//! relational `dependsOn` can normalize into a join table later if graph queries want it.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

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

/// A planned feature — a user-facing capability AND a fleet stream (#plan-db). The Features stage
/// works titles-first: the planner registers the whole roster (name only), then fills each in one
/// at a time. Mirrors the frontend `PlanFeature`; `serde` emits the camelCase JSON
/// `parseFeaturesFile` reads. A feature is "defined" once it has a name, behavior, and ≥1 acceptance.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanFeature {
    /// Stable slug / stream id (kebab-case). Derived from `name` when omitted. Optional on input so
    /// a detail-fill payload can carry just the slug (the merge keeps the stored name).
    #[serde(default)]
    pub slug: String,
    /// User-facing capability name ("Invite teammates"). Optional on input for the same reason.
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behavior: Option<String>,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approach: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// The fleet stream that owns it (defaults to the slug — a feature IS a stream).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<String>,
}

/// kebab-case slug from a name (mirrors the frontend `slugify`).
pub fn slugify(name: &str) -> String {
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
    /// Open (creating + migrating) the plan.db at `path`. Parent dirs are created.
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path)?;
        migrate(&conn)?;
        Ok(Store { conn })
    }

    /// An ephemeral in-memory store — for tests.
    pub fn open_in_memory() -> rusqlite::Result<Store> {
        let conn = Connection::open_in_memory()?;
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

    /// List issues, optionally filtered to one status (e.g. the director's `complete` queue) and/or
    /// one owning stream (e.g. a worker's `mine`). Always in stable plan order.
    pub fn list(&self, status: Option<&str>, stream: Option<&str>) -> rusqlite::Result<Vec<PlanIssue>> {
        let mut sql = String::from(SELECT_COLS);
        let mut clauses: Vec<&str> = Vec::new();
        if status.is_some() {
            clauses.push("status = :status");
        }
        if stream.is_some() {
            clauses.push("stream = :stream");
        }
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY position, ref");
        let mut stmt = self.conn.prepare(&sql)?;
        // Bind only the params the query actually references (rusqlite ignores unused named params,
        // but building the slice conditionally keeps it explicit).
        let out: rusqlite::Result<Vec<PlanIssue>> = match (status, stream) {
            (Some(st), Some(sr)) => stmt
                .query_map(rusqlite::named_params! { ":status": st, ":stream": sr }, row_to_issue)?
                .collect(),
            (Some(st), None) => stmt
                .query_map(rusqlite::named_params! { ":status": st }, row_to_issue)?
                .collect(),
            (None, Some(sr)) => stmt
                .query_map(rusqlite::named_params! { ":stream": sr }, row_to_issue)?
                .collect(),
            (None, None) => stmt.query_map([], row_to_issue)?.collect(),
        };
        out
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
            "INSERT INTO features (slug, name, behavior, approach, data, stream, acceptance, tools, position, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, strftime('%s','now'))
             ON CONFLICT(slug) DO UPDATE SET
                name       = CASE WHEN excluded.name != ''                          THEN excluded.name       ELSE features.name       END,
                behavior   = CASE WHEN COALESCE(excluded.behavior, '') != ''         THEN excluded.behavior   ELSE features.behavior   END,
                approach   = CASE WHEN COALESCE(excluded.approach, '') != ''         THEN excluded.approach   ELSE features.approach   END,
                data       = CASE WHEN COALESCE(excluded.data, '') != ''             THEN excluded.data       ELSE features.data       END,
                stream     = CASE WHEN COALESCE(excluded.stream, '') != ''           THEN excluded.stream     ELSE features.stream     END,
                acceptance = CASE WHEN excluded.acceptance != '[]'                   THEN excluded.acceptance ELSE features.acceptance END,
                tools      = CASE WHEN excluded.tools != '[]'                        THEN excluded.tools      ELSE features.tools      END,
                updated_at = excluded.updated_at",
            params![
                slug, feature.name, feature.behavior, feature.approach, feature.data,
                feature.stream, arr_to_json(&feature.acceptance), arr_to_json(&feature.tools), pos,
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
}

// ── schema ───────────────────────────────────────────────────────────────────────

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
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
            approach    TEXT,
            data        TEXT,
            stream      TEXT,
            acceptance  TEXT NOT NULL DEFAULT '[]',
            tools       TEXT NOT NULL DEFAULT '[]',
            position    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );",
    )?;
    // Additive migration for a plan.db created before `status` existed (errors if it already has the
    // column — ignored).
    let _ = conn.execute("ALTER TABLE issues ADD COLUMN status TEXT NOT NULL DEFAULT 'open'", []);
    Ok(())
}

// ── JSON (de)serialization for the value-list / phase columns ─────────────────────

fn arr_to_json(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}
fn json_to_arr(s: &str) -> Vec<String> {
    serde_json::from_str(s).unwrap_or_default()
}
fn phase_to_db(p: &Option<serde_json::Value>) -> Option<String> {
    p.as_ref().map(|v| v.to_string())
}
fn phase_from_db(s: Option<String>) -> Option<serde_json::Value> {
    s.and_then(|t| serde_json::from_str(&t).ok())
}

const SELECT_COLS: &str =
    "SELECT ref, title, phase, repo, stream, parent, body, acceptance, owns, depends_on, labels, status FROM issues";

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

const FEATURE_COLS: &str =
    "SELECT slug, name, behavior, approach, data, stream, acceptance, tools FROM features";

fn row_to_feature(r: &rusqlite::Row) -> rusqlite::Result<PlanFeature> {
    Ok(PlanFeature {
        slug: r.get(0)?,
        name: r.get(1)?,
        behavior: r.get(2)?,
        approach: r.get(3)?,
        data: r.get(4)?,
        stream: r.get(5)?,
        acceptance: json_to_arr(&r.get::<_, String>(6)?),
        tools: json_to_arr(&r.get::<_, String>(7)?),
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
}
