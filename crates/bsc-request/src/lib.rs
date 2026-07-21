//! The **improvement-request** store (#3295, epic #3260) — the designer→debug channel. A session confined
//! to `bsc ui` files a discrete request when the surface can't do what it needs; a full-capability debug
//! session reads the open queue, fixes the tooling, and resolves it. Requests are **contractual** — each
//! stands alone with a status, and no transcript is piped anywhere (unlike `bsc loop`, which is a running
//! conversation). The `cmd` field is the GROUNDING: the exact command that failed, so the ask is observed,
//! not narrated.
//!
//! Tauri-free on purpose (like `plandb`/`errordb`/`bsc-loop`): the umbrella `bsc` binary, the desktop app,
//! and any session all depend on it, so the CLI stays a tiny binary.

pub mod cli;
mod schema;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

/// The tool surface a request defaults to when none is given — today every request is a `bsc ui` gap; the
/// column lets the store grow to other surfaces without a migration.
pub const DEFAULT_SURFACE: &str = "bsc ui";

/// One improvement request — the `requests` row.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Request {
    pub id: i64,
    pub text: String,
    pub surface: String,
    /// The exact command that failed — the grounding (a request is observed, not narrated).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cmd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shot_path: Option<String>,
    /// `open` (claimable), `claimed` (a session is working it, #3535), or `resolved`.
    pub status: String,
    /// What the debug session changed, stamped on `resolve`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<i64>,
    /// WHICH session holds a claimed request — its pane id (#3535). Null unless `status = claimed`. Lets
    /// the pool tell a busy session (has a claim) from an idle one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_by: Option<String>,
    /// When the request was claimed (epoch ms). Null unless claimed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_at: Option<i64>,
}

impl Request {
    /// Claimable — not yet taken by a session, not resolved.
    pub fn is_open(&self) -> bool {
        self.status == "open"
    }
    /// Held by a session that is working it (#3535).
    pub fn is_claimed(&self) -> bool {
        self.status == "claimed"
    }
}

/// The write shape for a new request (`surface` empty falls back to {@link DEFAULT_SURFACE}).
#[derive(Debug, Clone, Default)]
pub struct NewRequest {
    pub text: String,
    pub surface: String,
    pub cmd: Option<String>,
    pub shot_path: Option<String>,
    pub ts: i64,
}

/// Filters for [`Store::list`]. All-default lists every request, newest first.
#[derive(Debug, Clone, Default)]
pub struct Filter {
    /// Only requests the debug session hasn't resolved yet (the work queue).
    pub open_only: bool,
    pub surface: Option<String>,
    pub limit: Option<i64>,
}

/// The request store — a thin owner of the SQLite connection plus the file/read/resolve ops.
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open (creating + migrating) the requests.db at `path`. WAL + busy_timeout so the app and the CLI
    /// share the db without a SQLITE_BUSY race.
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        let conn = bsc_sqlite_util::open_db(path)?;
        schema::migrate(&conn)?;
        Ok(Store { conn })
    }

    /// An ephemeral in-memory store — for tests.
    pub fn open_in_memory() -> rusqlite::Result<Store> {
        let conn = bsc_sqlite_util::open_in_memory_db()?;
        schema::migrate(&conn)?;
        Ok(Store { conn })
    }

    /// Empty the whole store. Truncates rather than dropping, so it works with the db open (WAL).
    pub fn clear(&self) -> rusqlite::Result<()> {
        let stmt = schema::ALL_TABLES.iter().map(|t| format!("DELETE FROM {t};")).collect::<String>();
        self.conn.execute_batch(&stmt)
    }

    /// File a request; returns it with its assigned id. A blank `surface` falls back to the default.
    pub fn create(&self, n: &NewRequest) -> rusqlite::Result<Request> {
        let surface = if n.surface.trim().is_empty() { DEFAULT_SURFACE } else { n.surface.as_str() };
        self.conn.execute(
            "INSERT INTO requests (text, surface, cmd, shot_path, status, created_at)
             VALUES (?1, ?2, ?3, ?4, 'open', ?5)",
            params![n.text, surface, n.cmd, n.shot_path, n.ts],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(self.get(id)?.expect("request exists after insert"))
    }

    /// One request by id, or `None`.
    pub fn get(&self, id: i64) -> rusqlite::Result<Option<Request>> {
        self.conn
            .query_row(&format!("SELECT {COLS} FROM requests WHERE id = ?1"), params![id], row_to_request)
            .optional()
    }

    /// The request queue under `filter`, newest first.
    pub fn list(&self, filter: &Filter) -> rusqlite::Result<Vec<Request>> {
        let mut sql = format!("SELECT {COLS} FROM requests");
        let mut clauses: Vec<String> = Vec::new();
        let mut vals: Vec<rusqlite::types::Value> = Vec::new();
        if filter.open_only {
            clauses.push("status = 'open'".into());
        }
        if let Some(s) = &filter.surface {
            vals.push(rusqlite::types::Value::Text(s.clone()));
            clauses.push(format!("surface = ?{}", vals.len()));
        }
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY id DESC");
        if let Some(n) = filter.limit {
            sql.push_str(&format!(" LIMIT {}", n.max(0)));
        }
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(vals), row_to_request)?;
        rows.collect()
    }

    /// Mark a request resolved — stamps `note` + `resolved_at`. Accepts an `open` OR a `claimed` request
    /// (#3535: a session resolves the one it claimed), so it is not a no-op for the normal path. Returns
    /// whether an unresolved request matched, so resolving an unknown / already-resolved id is reported.
    pub fn resolve(&self, id: i64, note: Option<&str>, ts: i64) -> rusqlite::Result<bool> {
        let n = self.conn.execute(
            "UPDATE requests SET status = 'resolved', note = ?2, resolved_at = ?3 \
             WHERE id = ?1 AND status IN ('open', 'claimed')",
            params![id, note, ts],
        )?;
        Ok(n > 0)
    }

    /// Atomically CLAIM the oldest open request (#3535): `open` → `claimed`, stamping `by` (the holder's
    /// pane id) + `ts`. Returns the claimed request, or `None` when nothing is claimable. Race-free across
    /// processes: the whole thing is ONE statement whose `WHERE` re-selects the oldest `open` row under
    /// SQLite's write lock, so two concurrent claimers (the standing session + an overflow one) can never
    /// take the same request — the second re-evaluates the subquery after the first commits and gets the
    /// next row (or none).
    pub fn claim(&self, by: Option<&str>, ts: i64) -> rusqlite::Result<Option<Request>> {
        self.conn
            .query_row(
                &format!(
                    "UPDATE requests SET status = 'claimed', claimed_by = ?1, claimed_at = ?2 \
                     WHERE id = (SELECT id FROM requests WHERE status = 'open' ORDER BY id ASC LIMIT 1) \
                     RETURNING {COLS}"
                ),
                params![by, ts],
                row_to_request,
            )
            .optional()
    }

    /// Return a CLAIMED request to the open queue (`claimed` → `open`, clearing who/when) — so a session
    /// that abandoned or crashed doesn't strand its request as permanently in-flight. Returns whether a
    /// claimed request matched.
    pub fn unclaim(&self, id: i64) -> rusqlite::Result<bool> {
        let n = self.conn.execute(
            "UPDATE requests SET status = 'open', claimed_by = NULL, claimed_at = NULL \
             WHERE id = ?1 AND status = 'claimed'",
            params![id],
        )?;
        Ok(n > 0)
    }

    /// Delete every RESOLVED request; returns how many rows were removed (#3522). The store only ever grew
    /// before this — `resolve` flips the status but the row stayed, so completed work accumulated forever.
    /// Keys off `status`, NOT a timestamp, because legacy rows resolved before #3295 stamped `resolved_at`
    /// carry a null one; an OPEN request (even a corrupted one) is never touched.
    pub fn prune_resolved(&self) -> rusqlite::Result<usize> {
        self.conn.execute("DELETE FROM requests WHERE status = 'resolved'", [])
    }

    /// Delete ONE request by id, regardless of status; returns whether a row matched (#3522). The escape
    /// hatch `prune_resolved` can't reach: a request that will never be legitimately resolved — e.g. one
    /// whose text was corrupted at filing time — is still `open`, so only an explicit removal clears it.
    pub fn remove(&self, id: i64) -> rusqlite::Result<bool> {
        let n = self.conn.execute("DELETE FROM requests WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }
}

/// The column list `row_to_request` decodes, in one place so the SELECTs can't drift from the mapper.
const COLS: &str =
    "id, text, surface, cmd, shot_path, status, note, created_at, resolved_at, claimed_by, claimed_at";

fn row_to_request(r: &rusqlite::Row) -> rusqlite::Result<Request> {
    Ok(Request {
        id: r.get(0)?,
        text: r.get(1)?,
        surface: r.get(2)?,
        cmd: r.get(3)?,
        shot_path: r.get(4)?,
        status: r.get(5)?,
        note: r.get(6)?,
        created_at: r.get(7)?,
        resolved_at: r.get(8)?,
        claimed_by: r.get(9)?,
        claimed_at: r.get(10)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(text: &str, cmd: Option<&str>, ts: i64) -> NewRequest {
        NewRequest { text: text.into(), cmd: cmd.map(Into::into), ts, ..Default::default() }
    }

    #[test]
    fn create_files_a_request_with_the_default_surface_and_open_status() {
        let s = Store::open_in_memory().unwrap();
        let r = s.create(&req("theme set-token can't reach the scrollbar", Some("bsc ui theme set-token default --scrollbar x"), 10)).unwrap();
        assert_eq!(r.id, 1);
        assert_eq!(r.surface, "bsc ui"); // default
        assert!(r.is_open());
        assert_eq!(r.cmd.as_deref(), Some("bsc ui theme set-token default --scrollbar x")); // the grounding
        assert_eq!(r.note, None);
        assert_eq!(r.resolved_at, None);
    }

    #[test]
    fn an_explicit_surface_is_kept() {
        let s = Store::open_in_memory().unwrap();
        let r = s.create(&NewRequest { text: "x".into(), surface: "bsc graph".into(), ts: 1, ..Default::default() }).unwrap();
        assert_eq!(r.surface, "bsc graph");
    }

    #[test]
    fn resolve_stamps_note_and_drops_from_the_open_queue() {
        let s = Store::open_in_memory().unwrap();
        let r = s.create(&req("gap", None, 1)).unwrap();
        assert_eq!(s.list(&Filter { open_only: true, ..Default::default() }).unwrap().len(), 1);
        assert!(s.resolve(r.id, Some("added --scrollbar to theme set-token"), 50).unwrap());
        assert!(!s.resolve(r.id, None, 60).unwrap(), "already resolved → no-op");
        assert!(!s.resolve(999, None, 60).unwrap(), "unknown → no-op");
        let got = s.get(r.id).unwrap().unwrap();
        assert_eq!(got.status, "resolved");
        assert_eq!(got.note.as_deref(), Some("added --scrollbar to theme set-token"));
        assert_eq!(got.resolved_at, Some(50));
        assert!(s.list(&Filter { open_only: true, ..Default::default() }).unwrap().is_empty(), "dropped from the open queue");
        assert_eq!(s.list(&Filter::default()).unwrap().len(), 1, "still listed unfiltered");
    }

    #[test]
    fn prune_resolved_removes_only_resolved_rows_and_reports_the_count() {
        let s = Store::open_in_memory().unwrap();
        let a = s.create(&req("open gap", None, 1)).unwrap();
        let b = s.create(&req("will resolve", None, 2)).unwrap();
        let c = s.create(&req("also resolve", None, 3)).unwrap();
        assert!(s.resolve(b.id, Some("fixed b"), 20).unwrap());
        assert!(s.resolve(c.id, None, 30).unwrap());

        assert_eq!(s.prune_resolved().unwrap(), 2, "both resolved rows removed");
        let left = s.list(&Filter::default()).unwrap();
        assert_eq!(left.len(), 1, "the open one survives");
        assert_eq!(left[0].id, a.id);

        assert_eq!(s.prune_resolved().unwrap(), 0, "idempotent — nothing left to prune");
    }

    #[test]
    fn prune_resolved_keys_off_status_not_a_timestamp_so_a_legacy_null_resolved_at_is_pruned() {
        // Legacy rows resolved before `resolve` stamped `resolved_at` carry a null one (seen live: #1-#3).
        // Simulate one by writing the resolved status directly with no timestamp, then prune.
        let s = Store::open_in_memory().unwrap();
        let r = s.create(&req("legacy", None, 1)).unwrap();
        s.conn
            .execute("UPDATE requests SET status = 'resolved', resolved_at = NULL WHERE id = ?1", params![r.id])
            .unwrap();
        assert_eq!(s.get(r.id).unwrap().unwrap().resolved_at, None, "no timestamp, like the legacy rows");
        assert_eq!(s.prune_resolved().unwrap(), 1, "pruned by status despite the null resolved_at");
    }

    #[test]
    fn remove_deletes_one_row_of_any_status_and_reports_whether_it_matched() {
        let s = Store::open_in_memory().unwrap();
        let a = s.create(&req("corrupted, still open", None, 1)).unwrap();
        let b = s.create(&req("keep me", None, 2)).unwrap();
        assert!(s.remove(a.id).unwrap(), "an OPEN row is removable (the escape hatch prune can't reach)");
        assert!(!s.remove(a.id).unwrap(), "gone → no-op");
        assert!(!s.remove(999).unwrap(), "unknown → no-op");
        let left = s.list(&Filter::default()).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, b.id);
    }

    #[test]
    fn claim_takes_the_oldest_open_request_stamps_the_holder_and_removes_it_from_the_open_queue() {
        let s = Store::open_in_memory().unwrap();
        s.create(&req("first", None, 1)).unwrap(); // id 1
        s.create(&req("second", None, 2)).unwrap(); // id 2

        let c = s.claim(Some("debug-studio:req-a"), 100).unwrap().expect("something to claim");
        assert_eq!(c.id, 1, "oldest first");
        assert!(c.is_claimed());
        assert_eq!(c.claimed_by.as_deref(), Some("debug-studio:req-a"));
        assert_eq!(c.claimed_at, Some(100));
        // A claimed request is no longer offered to `--open`.
        let open = s.list(&Filter { open_only: true, ..Default::default() }).unwrap();
        assert_eq!(open.iter().map(|r| r.id).collect::<Vec<_>>(), vec![2], "only the unclaimed one");

        // A second claim takes the NEXT open one — never the same row.
        let c2 = s.claim(Some("debug-studio:req-b"), 101).unwrap().expect("second claim");
        assert_eq!(c2.id, 2);
        // Nothing left to claim.
        assert!(s.claim(None, 102).unwrap().is_none(), "empty queue → None");
    }

    #[test]
    fn unclaim_returns_a_claimed_request_to_the_open_queue() {
        let s = Store::open_in_memory().unwrap();
        let r = s.create(&req("gap", None, 1)).unwrap();
        s.claim(Some("sess"), 10).unwrap().unwrap();
        assert!(s.unclaim(r.id).unwrap(), "a claimed request is unclaimable");
        let got = s.get(r.id).unwrap().unwrap();
        assert!(got.is_open(), "back to open");
        assert_eq!(got.claimed_by, None, "holder cleared");
        assert_eq!(got.claimed_at, None);
        assert!(!s.unclaim(r.id).unwrap(), "already open → no-op");
        assert!(!s.unclaim(999).unwrap(), "unknown → no-op");
    }

    #[test]
    fn resolve_accepts_a_claimed_request_the_normal_path() {
        let s = Store::open_in_memory().unwrap();
        let r = s.create(&req("gap", None, 1)).unwrap();
        s.claim(Some("sess"), 10).unwrap().unwrap();
        assert!(s.resolve(r.id, Some("fixed it"), 50).unwrap(), "a claimed request resolves");
        let got = s.get(r.id).unwrap().unwrap();
        assert_eq!(got.status, "resolved");
        assert_eq!(got.note.as_deref(), Some("fixed it"));
        // The holder attribution is kept on the resolved row (who fixed it), not scrubbed.
        assert_eq!(got.claimed_by.as_deref(), Some("sess"));
        assert!(!s.resolve(r.id, None, 60).unwrap(), "already resolved → no-op");
    }

    #[test]
    fn list_is_newest_first_and_filters_by_surface() {
        let s = Store::open_in_memory().unwrap();
        s.create(&req("first", None, 1)).unwrap();
        s.create(&NewRequest { text: "graph gap".into(), surface: "bsc graph".into(), ts: 2, ..Default::default() }).unwrap();
        let all = s.list(&Filter::default()).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].text, "graph gap", "newest first");
        assert_eq!(s.list(&Filter { surface: Some("bsc ui".into()), ..Default::default() }).unwrap().len(), 1);
        assert_eq!(s.list(&Filter { limit: Some(1), ..Default::default() }).unwrap().len(), 1);
    }

    #[test]
    fn a_request_survives_across_reopen() {
        let dir = std::env::temp_dir().join(format!("bsc-request-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("requests.db");
        let _ = std::fs::remove_file(&path);
        let id = {
            let s = Store::open(&path).unwrap();
            s.create(&req("persist me", Some("bsc ui foo"), 1)).unwrap().id
        };
        let s2 = Store::open(&path).unwrap(); // separate invocation
        let got = s2.get(id).unwrap().unwrap();
        assert_eq!(got.text, "persist me");
        assert_eq!(got.cmd.as_deref(), Some("bsc ui foo"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
