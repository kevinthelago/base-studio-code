// Native per-project plan store (#plan-db). The canonical, granular store for a project's plan:
// the planner upserts ONE item at a time (via the `bsc-plan` helper) instead of rewriting whole
// files, and the execution files (issues.json, …) are RENDERED from here at launch — so everything
// downstream is unchanged and a file is still inspectable. One SQLite db per project hub:
// `projects/<key>/plan.db`. rusqlite (bundled), mirroring `perf/mod.rs`.
//
// Increment 1 (issues-first): the `issues` table + CRUD + a render to the `issues.json` shape the
// frontend `parseIssuesFile` expects. Value-list fields are stored as JSON text for now; the
// relational `dependsOn` can normalize into a join table later if graph queries want it.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The execution-status lifecycle (#plan-db). The DB is the coordination substrate: a worker moves
/// its issue open → in_progress → complete (pushed/PR'd, awaiting verification); the director then
/// checks the CI pipeline and moves complete → verified (green) or failed (red → rework). `blocked`
/// marks an issue waiting on an unmet dependency.
pub const STATUSES: &[&str] = &["open", "in_progress", "blocked", "complete", "verified", "failed"];

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

// ── schema + connection ─────────────────────────────────────────────────────────

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
         );",
    )?;
    // Additive migration for a plan.db created before `status` existed (errors if it already
    // has the column — ignored).
    let _ = conn.execute("ALTER TABLE issues ADD COLUMN status TEXT NOT NULL DEFAULT 'open'", []);
    Ok(())
}

fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = Connection::open(path)?;
    migrate(&conn)?;
    Ok(conn)
}

fn db_path(project_key: &str) -> PathBuf {
    crate::project_dir(project_key).join("plan.db")
}

// ── JSON (de)serialization for the value-list columns ───────────────────────────

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

// ── CRUD ────────────────────────────────────────────────────────────────────────

/// Insert or replace an issue by `ref`. A new issue appends (next position); re-upserting an
/// existing one updates its fields in place and keeps its position (stable order across edits).
fn upsert_issue(conn: &Connection, issue: &PlanIssue) -> rusqlite::Result<()> {
    let pos: i64 = conn.query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM issues", [], |r| r.get(0))?;
    // New issues start at the given status (default 'open'); on a content edit we deliberately do
    // NOT touch `status` — that's execution state owned by workers/director, not the planner.
    let status = if issue.status.is_empty() { "open" } else { issue.status.as_str() };
    conn.execute(
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
fn set_status(conn: &Connection, r#ref: &str, status: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE issues SET status = ?2, updated_at = strftime('%s','now') WHERE ref = ?1",
        params![r#ref, status],
    )
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

const SELECT_COLS: &str =
    "SELECT ref, title, phase, repo, stream, parent, body, acceptance, owns, depends_on, labels, status FROM issues";

/// List issues, optionally filtered to one status (e.g. the director's `complete` queue).
fn list_issues(conn: &Connection, status_filter: Option<&str>) -> rusqlite::Result<Vec<PlanIssue>> {
    match status_filter {
        Some(s) => {
            let mut stmt = conn.prepare(&format!("{SELECT_COLS} WHERE status = ?1 ORDER BY position, ref"))?;
            let out: rusqlite::Result<Vec<PlanIssue>> = stmt.query_map(params![s], row_to_issue)?.collect();
            out
        }
        None => {
            let mut stmt = conn.prepare(&format!("{SELECT_COLS} ORDER BY position, ref"))?;
            let out: rusqlite::Result<Vec<PlanIssue>> = stmt.query_map([], row_to_issue)?.collect();
            out
        }
    }
}

fn remove_issue(conn: &Connection, r#ref: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM issues WHERE ref = ?1", params![r#ref])?;
    Ok(())
}

/// Render every issue to the `issues.json` shape the frontend + launch path read.
fn render_issues_json(conn: &Connection) -> rusqlite::Result<String> {
    let issues = list_issues(conn, None)?;
    Ok(serde_json::to_string_pretty(&issues).unwrap_or_else(|_| "[]".into()))
}

// ── Tauri commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn plan_upsert_issue(project_key: String, issue: PlanIssue) -> Result<(), String> {
    let conn = open(&db_path(&project_key)).map_err(|e| e.to_string())?;
    upsert_issue(&conn, &issue).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_list_issues(project_key: String, status: Option<String>) -> Result<Vec<PlanIssue>, String> {
    let conn = open(&db_path(&project_key)).map_err(|e| e.to_string())?;
    list_issues(&conn, status.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_remove_issue(project_key: String, issue_ref: String) -> Result<(), String> {
    let conn = open(&db_path(&project_key)).map_err(|e| e.to_string())?;
    remove_issue(&conn, &issue_ref).map_err(|e| e.to_string())
}

/// Set an issue's execution status (workers: in_progress/complete; director: verified/failed).
/// Validates against the known lifecycle so a typo can't wedge the board.
#[tauri::command]
pub fn plan_set_issue_status(project_key: String, issue_ref: String, status: String) -> Result<(), String> {
    if !STATUSES.contains(&status.as_str()) {
        return Err(format!("unknown status '{status}' (expected one of {STATUSES:?})"));
    }
    let conn = open(&db_path(&project_key)).map_err(|e| e.to_string())?;
    let n = set_status(&conn, &issue_ref, &status).map_err(|e| e.to_string())?;
    if n == 0 { Err(format!("no issue with ref '{issue_ref}'")) } else { Ok(()) }
}

/// Materialize `issues.json` in the project hub from the DB (the render-on-launch projection).
#[tauri::command]
pub fn plan_write_issues_json(project_key: String) -> Result<(), String> {
    let conn = open(&db_path(&project_key)).map_err(|e| e.to_string())?;
    let json = render_issues_json(&conn).map_err(|e| e.to_string())?;
    std::fs::write(crate::project_dir(&project_key).join("issues.json"), json).map_err(|e| e.to_string())
}

// ── tests ───────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c
    }
    fn mk(r: &str, t: &str) -> PlanIssue {
        PlanIssue { r#ref: r.into(), title: t.into(), ..Default::default() }
    }

    #[test]
    fn upsert_then_list_roundtrips_value_lists() {
        let c = test_conn();
        upsert_issue(&c, &PlanIssue {
            r#ref: "F1".into(), title: "Add login".into(),
            acceptance: vec!["returns 200".into()], owns: vec!["src/auth/".into()],
            depends_on: vec!["F0".into()], labels: vec!["scope:core".into()], ..Default::default()
        }).unwrap();
        upsert_issue(&c, &mk("F2", "Add logout")).unwrap();
        let issues = list_issues(&c, None).unwrap();
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].r#ref, "F1"); // position order preserved
        assert_eq!(issues[0].acceptance, vec!["returns 200"]);
        assert_eq!(issues[0].depends_on, vec!["F0"]);
        assert_eq!(issues[0].owns, vec!["src/auth/"]);
    }

    #[test]
    fn upsert_replaces_by_ref_without_duplicating() {
        let c = test_conn();
        upsert_issue(&c, &mk("F1", "old title")).unwrap();
        upsert_issue(&c, &mk("F1", "new title")).unwrap();
        let issues = list_issues(&c, None).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].title, "new title");
    }

    #[test]
    fn remove_drops_the_issue() {
        let c = test_conn();
        upsert_issue(&c, &mk("F1", "x")).unwrap();
        remove_issue(&c, "F1").unwrap();
        assert!(list_issues(&c, None).unwrap().is_empty());
    }

    #[test]
    fn render_matches_the_issues_json_shape() {
        let c = test_conn();
        upsert_issue(&c, &PlanIssue {
            r#ref: "F1".into(), title: "x".into(), phase: Some(serde_json::json!(1)),
            acceptance: vec!["a".into()], depends_on: vec!["F0".into()], ..Default::default()
        }).unwrap();
        let v: serde_json::Value = serde_json::from_str(&render_issues_json(&c).unwrap()).unwrap();
        let row = &v.as_array().unwrap()[0];
        assert_eq!(row["ref"], "F1");
        assert_eq!(row["phase"], 1); // number preserved (not "1")
        assert_eq!(row["dependsOn"], serde_json::json!(["F0"])); // camelCase, not depends_on
        assert_eq!(row["acceptance"], serde_json::json!(["a"]));
        assert!(row.get("repo").is_none()); // omitted when None
    }

    #[test]
    fn phase_can_be_a_string_name() {
        let c = test_conn();
        upsert_issue(&c, &PlanIssue { r#ref: "F1".into(), title: "x".into(), phase: Some(serde_json::json!("auth")), ..Default::default() }).unwrap();
        assert_eq!(list_issues(&c, None).unwrap()[0].phase, Some(serde_json::json!("auth")));
    }

    #[test]
    fn new_issue_defaults_to_open_and_set_status_moves_it() {
        let c = test_conn();
        upsert_issue(&c, &mk("F1", "x")).unwrap();
        assert_eq!(list_issues(&c, None).unwrap()[0].status, "open");
        set_status(&c, "F1", "complete").unwrap();
        assert_eq!(list_issues(&c, None).unwrap()[0].status, "complete");
    }

    #[test]
    fn content_upsert_does_not_reset_status() {
        let c = test_conn();
        upsert_issue(&c, &mk("F1", "original")).unwrap();
        set_status(&c, "F1", "complete").unwrap(); // worker marks done
        upsert_issue(&c, &mk("F1", "planner edits the title")).unwrap(); // a later plan edit
        let issue = &list_issues(&c, None).unwrap()[0];
        assert_eq!(issue.title, "planner edits the title");
        assert_eq!(issue.status, "complete", "a content edit must NOT clobber execution status");
    }

    #[test]
    fn list_filters_by_status_for_the_directors_queue() {
        let c = test_conn();
        upsert_issue(&c, &mk("F1", "done")).unwrap();
        upsert_issue(&c, &mk("F2", "wip")).unwrap();
        upsert_issue(&c, &mk("F3", "also done")).unwrap();
        set_status(&c, "F1", "complete").unwrap();
        set_status(&c, "F3", "complete").unwrap();
        set_status(&c, "F2", "in_progress").unwrap();
        let complete = list_issues(&c, Some("complete")).unwrap();
        assert_eq!(complete.iter().map(|i| i.r#ref.as_str()).collect::<Vec<_>>(), vec!["F1", "F3"]);
    }
}
