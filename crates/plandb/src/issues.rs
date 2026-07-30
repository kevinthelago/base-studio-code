//! Issues (#plan-db) — the granular work items: the `PlanIssue` record, its lean `IssueSummary`
//! projection, the execution-status lifecycle, and the issue CRUD/render + list-query helpers.

use crate::{phase_from_db, phase_to_db, Store};
use bsc_sqlite_util::{arr_to_json, json_to_arr};
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// The execution-status lifecycle (#plan-db). The DB is the coordination substrate: a worker moves
/// its issue open → in_progress → complete (pushed/PR'd, awaiting verification); the director then
/// checks the CI pipeline and moves complete → verified (green) or failed (red → rework). `blocked`
/// marks an issue waiting on an unmet dependency.
pub const STATUSES: &[&str] = &["open", "in_progress", "blocked", "complete", "verified", "failed"];

/// True if `s` is one of the known {@link STATUSES} — guards against a typo wedging the board.
pub fn is_valid_status(s: &str) -> bool {
    STATUSES.contains(&s)
}

/// The statuses that mean THE WORKER DID ITS PART (#4052) — the Rust half of the frontend's
/// `TERMINAL_GOOD`. Both must name the same set: `bsc project progress` counts "done" with this, the
/// graph's progress bar counts it with that, and a silent disagreement would put a bar and a
/// "finished" card on the same node saying different things. One definition per language, no more.
pub const DONE_STATUSES: &[&str] = &["complete", "verified"];

/// True when `s` means the work is finished (see {@link DONE_STATUSES}). An UNKNOWN status is
/// deliberately not-done: a typo must never silently inflate a completion count.
pub fn is_done_status(s: &str) -> bool {
    DONE_STATUSES.contains(&s)
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

impl Store {
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
}

// ── JSON (de)serialization + list-query helpers ───────────────────────────────────
// `arr_to_json` / `json_to_arr` are shared with skilldb via `bsc_sqlite_util` (#1621); the
// phase-column codec lives in the crate root (shared with features).

pub(crate) const SELECT_COLS: &str =
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

pub(crate) fn row_to_issue(r: &rusqlite::Row) -> rusqlite::Result<PlanIssue> {
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
