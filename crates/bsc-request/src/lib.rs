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
    /// `open` (awaiting the debug session) or `resolved`.
    pub status: String,
    /// What the debug session changed, stamped on `resolve`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<i64>,
}

impl Request {
    pub fn is_open(&self) -> bool {
        self.status == "open"
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

    /// Mark a request resolved — stamps `note` + `resolved_at`. Returns whether an OPEN request matched, so
    /// resolving an unknown / already-resolved id is a reported no-op.
    pub fn resolve(&self, id: i64, note: Option<&str>, ts: i64) -> rusqlite::Result<bool> {
        let n = self.conn.execute(
            "UPDATE requests SET status = 'resolved', note = ?2, resolved_at = ?3 WHERE id = ?1 AND status = 'open'",
            params![id, note, ts],
        )?;
        Ok(n > 0)
    }
}

/// The column list `row_to_request` decodes, in one place so the SELECTs can't drift from the mapper.
const COLS: &str = "id, text, surface, cmd, shot_path, status, note, created_at, resolved_at";

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
