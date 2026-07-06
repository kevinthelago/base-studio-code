//! Fleet-session ledger (#2405) — the durable, authoritative record of the agents this project has
//! LAUNCHED. Recovery used to INFER sessions from a flat `pty-ledger.json` (pid-only, wiped on a clean
//! quit) cross-referenced with worktrees + the fleet PLAN; that's fragile, and after a tidy shutdown
//! there was nothing to recover from. This table is the source of truth instead: one row per launched
//! agent, carrying its identity + last-known status, PERSISTED across a clean quit — so returning to a
//! project can offer to restart its fleet, and `discover_sessions` reads a fact rather than a guess.
//!
//! Own module (not piled into `fleet.rs`) to match how the crate keeps one file per concern. It owns
//! the `FleetSession` type, its schema (`FLEET_SESSIONS_DDL`, run by the crate's `migrate`), and the
//! `fleet_session_*` methods it hangs off `Store`. Per-project: it lives in each project's plan.db, so
//! a session's owning project is the db it's in.

use crate::Store;
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// A launched agent's ledger row. `paneId` is the identity pane id (`<project>:<stream>` for a
/// worker/director, `<project>:<repo>:triage` for triage) — the same key the console + recovery use, so
/// a row maps 1:1 to a live pane. Serializes camelCase for the frontend + the `bsc` bridge.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetSession {
    #[serde(default)]
    pub pane_id: String,
    /// The owning fleet stream id (director/triage rows may leave it blank).
    #[serde(default)]
    pub stream_id: String,
    /// `director` | `worker` | `triage` — the launched role (recovery reopens the right surface).
    #[serde(default)]
    pub role: String,
    /// Where to relaunch it — the worktree dir for a worker, the hub for the director.
    #[serde(default)]
    pub cwd: String,
    /// Last-known shell pid (0 = unknown). Recovery cross-checks it against the live OS for liveness.
    #[serde(default)]
    pub pid: i64,
    /// `running` (an open pane) · `dormant` (launched, no live pane) · `ended` (clean exit / killed).
    #[serde(default)]
    pub status: String,
    /// First-launch + last-heartbeat timestamps (epoch seconds). `launched_at` is preserved across a
    /// relaunch upsert; `last_seen` bumps on every heartbeat, so a stale one flags a dead session.
    #[serde(default)]
    pub launched_at: i64,
    #[serde(default)]
    pub last_seen: i64,
}

/// The `fleet_sessions` table DDL — run by the crate's `migrate`.
pub(crate) const FLEET_SESSIONS_DDL: &str = "CREATE TABLE IF NOT EXISTS fleet_sessions (
    pane_id     TEXT PRIMARY KEY,
    stream_id   TEXT NOT NULL DEFAULT '',
    role        TEXT NOT NULL DEFAULT '',
    cwd         TEXT NOT NULL DEFAULT '',
    pid         INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'running',
    launched_at INTEGER NOT NULL DEFAULT 0,
    last_seen   INTEGER NOT NULL DEFAULT 0
);";

const SESSION_COLS: &str =
    "SELECT pane_id, stream_id, role, cwd, pid, status, launched_at, last_seen FROM fleet_sessions";

fn row_to_session(r: &rusqlite::Row) -> rusqlite::Result<FleetSession> {
    Ok(FleetSession {
        pane_id: r.get(0)?,
        stream_id: r.get(1)?,
        role: r.get(2)?,
        cwd: r.get(3)?,
        pid: r.get(4)?,
        status: r.get(5)?,
        launched_at: r.get(6)?,
        last_seen: r.get(7)?,
    })
}

impl Store {
    /// Record (or refresh) a launched agent. The FIRST insert stamps `launched_at`; a re-upsert (a
    /// relaunch or a reconnect) refreshes the live fields + `last_seen` but PRESERVES the original
    /// `launched_at`. An empty `pane_id` is rejected (nothing to key on); an empty `status` defaults to
    /// `running`.
    pub fn fleet_session_upsert(&self, s: &FleetSession) -> rusqlite::Result<()> {
        let pane = s.pane_id.trim();
        if pane.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName(
                "a fleet session needs a pane_id".into(),
            ));
        }
        let status = if s.status.trim().is_empty() { "running" } else { s.status.trim() };
        self.conn.execute(
            "INSERT INTO fleet_sessions (pane_id, stream_id, role, cwd, pid, status, launched_at, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%s','now'), strftime('%s','now'))
             ON CONFLICT(pane_id) DO UPDATE SET
                stream_id = excluded.stream_id,
                role      = excluded.role,
                cwd       = excluded.cwd,
                pid       = excluded.pid,
                status    = excluded.status,
                last_seen = strftime('%s','now')",
            params![pane, s.stream_id.trim(), s.role.trim(), s.cwd.trim(), s.pid, status],
        )?;
        Ok(())
    }

    /// Liveness heartbeat from an open pane: bump `last_seen` and mark it `running`. A no-op if the
    /// session isn't in the ledger (its upsert races the first heartbeat — the next one lands).
    pub fn fleet_session_heartbeat(&self, pane_id: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE fleet_sessions SET last_seen = strftime('%s','now'), status = 'running' WHERE pane_id = ?1",
            params![pane_id.trim()],
        )?;
        Ok(())
    }

    /// Set a session's status (`running` | `dormant` | `ended`) — e.g. on a clean exit or a kill.
    pub fn fleet_session_set_status(&self, pane_id: &str, status: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE fleet_sessions SET status = ?2, last_seen = strftime('%s','now') WHERE pane_id = ?1",
            params![pane_id.trim(), status.trim()],
        )?;
        Ok(())
    }

    /// Every recorded session for this project, newest-launched first.
    pub fn fleet_session_list(&self) -> rusqlite::Result<Vec<FleetSession>> {
        let mut stmt = self.conn.prepare(&format!("{SESSION_COLS} ORDER BY launched_at DESC, pane_id"))?;
        // Bind before `stmt` drops (the query_map iterator borrows it) — mirrors `lesson_list`.
        let out: rusqlite::Result<Vec<FleetSession>> = stmt.query_map([], row_to_session)?.collect();
        out
    }

    /// Forget a session (the user discarded it, or it was reaped).
    pub fn fleet_session_remove(&self, pane_id: &str) -> rusqlite::Result<()> {
        self.conn
            .execute("DELETE FROM fleet_sessions WHERE pane_id = ?1", params![pane_id.trim()])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::{FleetSession, Store};

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }
    fn sess(pane: &str, role: &str) -> FleetSession {
        FleetSession { pane_id: pane.into(), role: role.into(), status: "running".into(), pid: 42, ..Default::default() }
    }

    #[test]
    fn upsert_inserts_then_refreshes_preserving_launched_at() {
        let s = store();
        s.fleet_session_upsert(&sess("k:auth", "worker")).unwrap();
        let first = s.fleet_session_list().unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].pane_id, "k:auth");
        assert!(first[0].launched_at > 0);
        let launched = first[0].launched_at;

        // A relaunch upsert updates the live fields but keeps launched_at.
        let mut again = sess("k:auth", "worker");
        again.pid = 99;
        again.cwd = "/wt/auth".into();
        s.fleet_session_upsert(&again).unwrap();
        let rows = s.fleet_session_list().unwrap();
        assert_eq!(rows.len(), 1, "same pane_id upserts, never duplicates");
        assert_eq!(rows[0].pid, 99);
        assert_eq!(rows[0].cwd, "/wt/auth");
        assert_eq!(rows[0].launched_at, launched, "launched_at is preserved across a relaunch");
    }

    #[test]
    fn set_status_and_remove() {
        let s = store();
        s.fleet_session_upsert(&sess("k:api", "worker")).unwrap();
        s.fleet_session_set_status("k:api", "ended").unwrap();
        assert_eq!(s.fleet_session_list().unwrap()[0].status, "ended");
        s.fleet_session_remove("k:api").unwrap();
        assert!(s.fleet_session_list().unwrap().is_empty());
    }

    #[test]
    fn empty_pane_id_is_rejected() {
        assert!(store().fleet_session_upsert(&sess("", "worker")).is_err());
    }
}
