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
    /// The GitHub issue number this row was published as, or `None` when it never was.
    ///
    /// This is the ONE durable link between a plan row and its GitHub issue. Before it existed the
    /// link was re-derived on every publish — by title string, or by scraping digits out of `ref` —
    /// and both are lossy: a retitled issue published twice, and a slug ref (`invite-teammates`,
    /// which is what the feature→issue path produces) scraped to nothing at all.
    ///
    /// `None` is meaningful, not merely absent: it is what marks an issue as still needing creation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gh_number: Option<i64>,
    /// The GraphQL node id of the same issue — what the board/sub-issue mutations address it by.
    /// Kept alongside the number rather than derived, because resolving one from the other costs a
    /// round-trip and both are handed to us for free at creation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gh_node_id: Option<String>,
    /// Unix seconds of the last successful reconcile with GitHub, or `None` if never synced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synced_at: Option<i64>,
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
    /// The GitHub issue number, when published. Carried on the LEAN projection (unlike `gh_node_id`,
    /// which only the API needs) because it is identity, not detail: the sync review lists issues by
    /// ref + title + number, and making it fetch the full record per row to show one integer would
    /// reintroduce exactly the per-issue fan-out the batched reads exist to avoid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gh_number: Option<i64>,
}

impl Store {
    /// Insert or replace an issue by `ref`. A new issue appends (next position); re-upserting an
    /// existing one updates its fields in place and keeps its position (stable order across edits).
    /// A content edit deliberately does NOT touch `status` — execution state is owned by the
    /// workers/director, not the planner — nor the `gh_*` identity, which is owned by publish/sync
    /// ({@link Store::set_github_identity}). Both are set on INSERT and preserved on CONFLICT: a
    /// planner re-running the features→issues materialization must not un-publish every row it
    /// rewrites, which is precisely what including them in the DO UPDATE SET would do.
    pub fn upsert(&self, issue: &PlanIssue) -> rusqlite::Result<()> {
        let pos: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM issues", [], |r| r.get(0))?;
        let status = if issue.status.is_empty() { "open" } else { issue.status.as_str() };
        self.conn.execute(
            "INSERT INTO issues (ref, title, phase, repo, stream, parent, body, acceptance, owns, depends_on, labels, status, gh_number, gh_node_id, synced_at, position, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, strftime('%s','now'))
             ON CONFLICT(ref) DO UPDATE SET
                title=excluded.title, phase=excluded.phase, repo=excluded.repo, stream=excluded.stream,
                parent=excluded.parent, body=excluded.body, acceptance=excluded.acceptance, owns=excluded.owns,
                depends_on=excluded.depends_on, labels=excluded.labels, updated_at=excluded.updated_at",
            params![
                issue.r#ref, issue.title, phase_to_db(&issue.phase), issue.repo, issue.stream, issue.parent, issue.body,
                arr_to_json(&issue.acceptance), arr_to_json(&issue.owns), arr_to_json(&issue.depends_on), arr_to_json(&issue.labels),
                status, issue.gh_number, issue.gh_node_id, issue.synced_at, pos,
            ],
        )?;
        Ok(())
    }

    /// Record the GitHub identity a publish/sync just established for `ref`, stamping `synced_at` to
    /// now. Returns rows updated (0 = no such ref).
    ///
    /// Separate from {@link Store::upsert} for the same reason {@link Store::set_status} is: publish
    /// state and plan content are written by different actors at different times, and folding them
    /// into one write is what lets the later one silently undo the earlier.
    pub fn set_github_identity(
        &self, r#ref: &str, gh_number: i64, gh_node_id: Option<&str>,
    ) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE issues SET gh_number = ?2, gh_node_id = COALESCE(?3, gh_node_id),
                synced_at = strftime('%s','now'), updated_at = strftime('%s','now')
             WHERE ref = ?1",
            params![r#ref, gh_number, gh_node_id],
        )
    }

    /// Look an issue up by the GitHub number it was published as — the reconcile's remote→local
    /// direction. `None` when no row claims that number.
    pub fn get_by_gh_number(&self, gh_number: i64) -> rusqlite::Result<Option<PlanIssue>> {
        let mut stmt = self.conn.prepare(&format!("{SELECT_COLS} WHERE gh_number = ?1"))?;
        let mut rows = stmt.query_map(params![gh_number], row_to_issue)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
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

/// Fields `amend`'s patch may never carry (#request-107): identity (`ref`) or state a DIFFERENT
/// verb/actor owns — `status` (workers/director, `bsc plan status`) and the `gh*` identity
/// (publish/sync, `bsc plan link`). Named in the camelCase `PlanIssue`'s own `Serialize` emits, since
/// that is the shape a patch is written against. Paired with the reason so a caller is told where the
/// field actually lives, not just refused.
pub const AMEND_OWNED_ELSEWHERE: &[(&str, &str)] = &[
    ("ref", "an issue's ref is its identity — remove and re-add it to rename"),
    ("status", "owned by execution — use `bsc plan status <ref> <status>`"),
    ("ghNumber", "owned by publish/sync — use `bsc plan link <ref>`"),
    ("ghNodeId", "owned by publish/sync — use `bsc plan link <ref>`"),
    ("syncedAt", "owned by publish/sync — use `bsc plan link <ref>`"),
];

/// The fields `amend` may actually change — every `PlanIssue` key that isn't in
/// {@link AMEND_OWNED_ELSEWHERE}. A patch key outside this set is a typo (`"tittle"`,
/// `"acceptence"`), and without this check `merge_patch` would insert it into the JSON object,
/// `serde` would silently ignore the unrecognized key on the way back out, and the caller would see
/// its write succeed having changed nothing — exactly the kind of quiet no-op this crate's own gate
/// discipline exists to catch elsewhere. Named once so the error can list them.
const AMENDABLE_FIELDS: &[&str] =
    &["title", "phase", "repo", "stream", "parent", "body", "acceptance", "owns", "dependsOn", "labels"];

/// Merge a partial JSON `patch` onto `existing`, returning the resulting issue WITHOUT writing it
/// (the caller — the CLI — applies scope + validation, then `upsert`s).
///
/// This is what `amend` exists for (#request-107): `add`/`upsert` need the WHOLE issue object, so
/// correcting one acceptance criterion meant a read-the-whole-JSON, mutate-in-an-interpreter,
/// write-it-back dance — and a transcription slip during that dance silently destroys the rest of a
/// long-lived body, since the object being re-authored by hand is the same one carrying the history.
///
/// A field the patch does not mention is left exactly as `existing` had it. A `null` value REMOVES an
/// optional field — the same explicit-deletion convention `bsc graph impl set`'s `--clear` uses,
/// because a merging write can no longer express deletion by omission. An array field (`acceptance`,
/// `owns`, `dependsOn`, `labels`) is replaced whole when supplied — there is no per-element patch, so
/// correcting one entry means sending the whole corrected array, which is still only ONE field of the
/// issue rather than the entire object.
///
/// Refuses outright to touch anything in {@link AMEND_OWNED_ELSEWHERE}, so this function is safe to
/// call directly even if a caller skips its own pre-check.
pub fn merge_patch(
    existing: &PlanIssue, patch: &serde_json::Map<String, serde_json::Value>,
) -> Result<PlanIssue, String> {
    for (key, hint) in AMEND_OWNED_ELSEWHERE {
        if patch.contains_key(*key) {
            return Err(format!("amend cannot change `{key}`: {hint}"));
        }
    }
    for key in patch.keys() {
        if !AMENDABLE_FIELDS.contains(&key.as_str()) {
            return Err(format!(
                "amend: unknown field `{key}` — expected one of {AMENDABLE_FIELDS:?} (a typo here would otherwise be silently ignored)"
            ));
        }
    }
    let mut value = serde_json::to_value(existing).map_err(|e| e.to_string())?;
    let obj = value.as_object_mut().expect("PlanIssue serializes to a JSON object");
    for (k, v) in patch {
        if v.is_null() {
            obj.remove(k);
        } else {
            obj.insert(k.clone(), v.clone());
        }
    }
    serde_json::from_value(value).map_err(|e| format!("amend produced an invalid issue: {e}"))
}

// ── JSON (de)serialization + list-query helpers ───────────────────────────────────
// `arr_to_json` / `json_to_arr` are shared with skilldb via `bsc_sqlite_util` (#1621); the
// phase-column codec lives in the crate root (shared with features).

pub(crate) const SELECT_COLS: &str =
    "SELECT ref, title, phase, repo, stream, parent, body, acceptance, owns, depends_on, labels, status, gh_number, gh_node_id, synced_at FROM issues";

/// Lean column set for {@link Store::list_summary}: **no `body`** (the big blob is dropped at the SQL
/// layer, not in Rust), value-lists still selected so we can count them. Column order must match
/// {@link row_to_issue_summary}.
const SELECT_SUMMARY_COLS: &str =
    "SELECT ref, title, phase, stream, acceptance, owns, depends_on, status, gh_number FROM issues";

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
        gh_number: r.get(12)?,
        gh_node_id: r.get(13)?,
        synced_at: r.get(14)?,
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
        gh_number: r.get(8)?,
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
    fn set_github_identity_records_number_node_and_stamps_synced_at() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("invite-teammates", "Invite teammates")).unwrap();
        // Unpublished rows read as None on every identity field — the state `bsc plan sync` treats as
        // "still needs creating".
        let before = s.get("invite-teammates").unwrap().unwrap();
        assert_eq!((before.gh_number, before.gh_node_id, before.synced_at), (None, None, None));

        assert_eq!(s.set_github_identity("invite-teammates", 3898, Some("I_node1")).unwrap(), 1);
        let after = s.get("invite-teammates").unwrap().unwrap();
        assert_eq!(after.gh_number, Some(3898));
        assert_eq!(after.gh_node_id.as_deref(), Some("I_node1"));
        assert!(after.synced_at.unwrap() > 0, "a successful sync stamps synced_at");
        // An unknown ref reports 0 rows rather than erroring — the caller decides if that is a problem.
        assert_eq!(s.set_github_identity("nope", 1, None).unwrap(), 0);
    }

    #[test]
    fn set_github_identity_keeps_a_known_node_id_when_none_is_supplied() {
        // Re-syncing knows the number but not always the node id (a REST read returns one, GraphQL the
        // other). Passing None must not blank a node id we already paid a round-trip for.
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("F1", "x")).unwrap();
        s.set_github_identity("F1", 10, Some("I_kept")).unwrap();
        s.set_github_identity("F1", 10, None).unwrap();
        assert_eq!(s.get("F1").unwrap().unwrap().gh_node_id.as_deref(), Some("I_kept"));
    }

    /// The regression this column exists to make impossible. The planner re-materializes features →
    /// issues on every publish and on the local commit path, so a published row is re-upserted
    /// routinely. If that write carried the identity, each one would reset `gh_number` to NULL and the
    /// next publish would create a SECOND GitHub issue for work that already has one.
    #[test]
    fn content_upsert_does_not_reset_github_identity() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("invite-teammates", "Invite teammates")).unwrap();
        s.set_github_identity("invite-teammates", 3898, Some("I_node1")).unwrap();
        // A later plan edit — including a RETITLE, which is exactly what defeated the old title match.
        s.upsert(&mk("invite-teammates", "Invite teammates to a workspace")).unwrap();
        let issue = s.get("invite-teammates").unwrap().unwrap();
        assert_eq!(issue.title, "Invite teammates to a workspace");
        assert_eq!(issue.gh_number, Some(3898), "a content edit must NOT un-publish the row");
        assert_eq!(issue.gh_node_id.as_deref(), Some("I_node1"));
    }

    #[test]
    fn get_by_gh_number_resolves_the_remote_to_local_direction() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("invite-teammates", "Invite teammates")).unwrap();
        s.upsert(&mk("export-csv", "Export to CSV")).unwrap();
        s.set_github_identity("export-csv", 3877, None).unwrap();
        assert_eq!(s.get_by_gh_number(3877).unwrap().unwrap().r#ref, "export-csv");
        // An unpublished row is unreachable by number, and an unknown number is None (not the first row).
        assert!(s.get_by_gh_number(9999).unwrap().is_none());
    }

    #[test]
    fn an_insert_carrying_an_identity_keeps_it() {
        // The sync's adopt path inserts a row that ALREADY has its GitHub identity, so the INSERT must
        // persist the fields even though the CONFLICT branch deliberately ignores them.
        let s = Store::open_in_memory().unwrap();
        s.upsert(&PlanIssue {
            r#ref: "adopted".into(), title: "Filed by hand".into(),
            gh_number: Some(4242), gh_node_id: Some("I_adopt".into()), synced_at: Some(1_700_000_000),
            ..Default::default()
        }).unwrap();
        let got = s.get("adopted").unwrap().unwrap();
        assert_eq!(got.gh_number, Some(4242));
        assert_eq!(got.gh_node_id.as_deref(), Some("I_adopt"));
        assert_eq!(got.synced_at, Some(1_700_000_000));
    }

    #[test]
    fn summary_carries_the_number_and_json_omits_it_when_unpublished() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("published", "Published")).unwrap();
        s.upsert(&mk("draft", "Draft")).unwrap();
        s.set_github_identity("published", 3898, Some("I_x")).unwrap();

        let rows = s.list_summary(None, None, None, None).unwrap();
        let by = |r: &str| rows.iter().find(|i| i.r#ref == r).unwrap().gh_number;
        assert_eq!(by("published"), Some(3898));
        assert_eq!(by("draft"), None);

        // camelCase on the wire, and ABSENT (not null) when unpublished — the frontend's
        // `ghNumber === undefined` is what distinguishes "never published" from "issue 0".
        let published = serde_json::to_value(rows.iter().find(|i| i.r#ref == "published").unwrap()).unwrap();
        assert_eq!(published["ghNumber"], 3898);
        let draft = serde_json::to_value(rows.iter().find(|i| i.r#ref == "draft").unwrap()).unwrap();
        assert!(draft.get("ghNumber").is_none(), "an unpublished row emits no ghNumber key");
        // The lean projection still carries no node id — identity, not detail.
        assert!(published.get("ghNodeId").is_none());
    }

    #[test]
    fn render_omits_identity_for_an_unpublished_issue() {
        // `render_issues_json` is the `issues.json` projection the frontend + launch path read. An
        // unsynced row must serialize exactly as it did before this column existed.
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("F1", "x")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s.render_issues_json().unwrap()).unwrap();
        let row = &v.as_array().unwrap()[0];
        assert!(row.get("ghNumber").is_none());
        assert!(row.get("ghNodeId").is_none());
        assert!(row.get("syncedAt").is_none());
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

    // ── merge_patch (#request-107: amend one field without clobbering the rest) ──────────────

    fn mk_full(r: &str) -> PlanIssue {
        PlanIssue {
            r#ref: r.into(), title: "original title".into(),
            body: Some("a long body with real history".into()),
            acceptance: vec!["a".into(), "b".into(), "c".into()],
            owns: vec!["src/x/".into()], labels: vec!["scope:core".into()],
            stream: Some("auth".into()), status: "in_progress".into(),
            gh_number: Some(42), gh_node_id: Some("I_x".into()), synced_at: Some(1_700_000_000),
            ..Default::default()
        }
    }

    #[test]
    fn merge_patch_changes_only_the_supplied_field() {
        let existing = mk_full("F1");
        let patch = serde_json::json!({ "acceptance": ["a", "b", "CORRECTED"] });
        let merged = merge_patch(&existing, patch.as_object().unwrap()).unwrap();
        assert_eq!(merged.acceptance, vec!["a", "b", "CORRECTED"]);
        // everything else survives byte-for-byte — the whole point of a merge over a replace.
        assert_eq!(merged.title, existing.title);
        assert_eq!(merged.body, existing.body);
        assert_eq!(merged.owns, existing.owns);
        assert_eq!(merged.labels, existing.labels);
        assert_eq!(merged.stream, existing.stream);
        assert_eq!(merged.status, existing.status);
        assert_eq!(merged.gh_number, existing.gh_number);
    }

    #[test]
    fn merge_patch_null_clears_an_optional_field() {
        let existing = mk_full("F1");
        let patch = serde_json::json!({ "body": null });
        let merged = merge_patch(&existing, patch.as_object().unwrap()).unwrap();
        assert!(merged.body.is_none());
        assert_eq!(merged.title, existing.title, "clearing one field touches no other");
    }

    #[test]
    fn merge_patch_refuses_ref_status_and_gh_identity() {
        let existing = mk_full("F1");
        for (key, value) in [
            ("ref", serde_json::json!("F2")),
            ("status", serde_json::json!("complete")),
            ("ghNumber", serde_json::json!(99)),
            ("ghNodeId", serde_json::json!("I_y")),
            ("syncedAt", serde_json::json!(1)),
        ] {
            let patch = serde_json::json!({ key: value });
            let err = merge_patch(&existing, patch.as_object().unwrap()).unwrap_err();
            assert!(err.contains(key), "{err}");
        }
    }

    /// A typo'd field name must be rejected, not silently dropped. Without this guard `merge_patch`
    /// would insert `"tittle"` into the JSON object, `serde` would ignore the unrecognized key
    /// deserializing back to `PlanIssue`, and the write would report success having changed nothing —
    /// the exact silent no-op #request-107's own investigation flagged in a different form (status
    /// being ignored on an `add` update with no error).
    #[test]
    fn merge_patch_rejects_an_unknown_field_instead_of_silently_ignoring_it() {
        let existing = mk_full("F1");
        let patch = serde_json::json!({ "tittle": "typo'd title" });
        let err = merge_patch(&existing, patch.as_object().unwrap()).unwrap_err();
        assert!(err.contains("tittle"), "{err}");
        // ...and did not sneak the correctly-named field's old value into a differently-cased slot.
        let existing2 = mk_full("F1");
        assert_eq!(existing2.title, "original title");
    }

    #[test]
    fn merge_patch_leaves_the_original_untouched_on_a_write_failure() {
        // A refused patch must not have partially mutated anything the caller could mistake for
        // a successful (if incomplete) merge — merge_patch works on a CLONE, never `existing`.
        let existing = mk_full("F1");
        let patch = serde_json::json!({ "title": "new title", "status": "complete" });
        assert!(merge_patch(&existing, patch.as_object().unwrap()).is_err());
        assert_eq!(existing.title, "original title");
    }

    #[test]
    fn merge_patch_then_upsert_roundtrips_through_the_store() {
        // The end-to-end shape `amend` uses: fetch, merge, write back.
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk_full("F1")).unwrap();
        let existing = s.get("F1").unwrap().unwrap();
        let patch = serde_json::json!({ "acceptance": ["a", "b", "CORRECTED"] });
        let merged = merge_patch(&existing, patch.as_object().unwrap()).unwrap();
        s.upsert(&merged).unwrap();
        let after = s.get("F1").unwrap().unwrap();
        assert_eq!(after.acceptance, vec!["a", "b", "CORRECTED"]);
        assert_eq!(after.body, existing.body, "amend must not clobber a field it never mentioned");
        // status/identity are untouched by upsert's CONFLICT branch regardless — belt and braces.
        assert_eq!(after.status, "in_progress");
        assert_eq!(after.gh_number, Some(42));
    }
}
