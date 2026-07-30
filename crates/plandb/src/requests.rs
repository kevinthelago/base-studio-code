//! Worker→director **change requests** (#4000) — the project-scoped ask lane.
//!
//! A worker that is blocked by something outside its own worktree — no integration branch to target,
//! a kickoff pointing at a path that does not exist, a glob it owns but cannot write — has no way to
//! act on it and no business acting on it. This is where it says so, to the one role that can: the
//! project's **director** (`git: write · github: write · code: none`).
//!
//! ## Project-scoped, deliberately
//! The app already has an improvement-request store (`crates/bsc-request`, #3295): the designer→debug
//! channel, drained by a full-capability session that edits base-studio-code **itself**. That store is
//! global (`~/.base-studio-code/requests.db`) and — because `bsc` sits in the permission model's
//! `mandatory` tier, always allowed — it is reachable from any session that can run bash. A project
//! worker filing there would be one command away from the host app's maintenance queue.
//!
//! So this lane lives in the project's own `plan.db`. The worker's `$BSC_PLAN_DB` already points at
//! exactly one project, which makes the isolation a BOUNDARY rather than a filter: if the role deny on
//! the global store were ever wrong, the worst case is a worker filing noise into its own project.
//! Escalation to the tooling queue is the director's move, not the worker's.
//!
//! ## Contractual, unlike a `bsc-ask`
//! `bsc-ask` is a transient question in `coord.log` — surfaced in the inbox, then gone. A request
//! stands alone with a lifecycle (`open` → `claimed` → `resolved`) so it can outlive the log, the
//! session, and an app restart. `cmd` is the GROUNDING: the exact command that failed, so the ask is
//! observed rather than narrated. That field is what makes a request actionable without a conversation.

use crate::Store;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

/// A worker→director change request — one `requests` row.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// Monotonic row id — the director resolves by it.
    #[serde(default)]
    pub id: i64,
    /// What is being asked for, in the requester's words.
    #[serde(default)]
    pub text: String,
    /// The GROUNDING: the exact command that failed. Optional only because some asks are structural
    /// ("this stream owns a glob no repo contains") rather than a command that returned non-zero.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cmd: String,
    /// Who filed it — the stream id / pane id, so the director can answer the right agent.
    #[serde(default)]
    pub from: String,
    /// `open` (the director has not taken it) → `claimed` (it is being worked) → `resolved`.
    #[serde(default)]
    pub status: String,
    /// What the director did, stamped on resolve. This is the answer the requester reads back.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub resolved_at: i64,
}

impl Request {
    /// Not yet taken by the director.
    pub fn is_open(&self) -> bool {
        self.status == STATUS_OPEN
    }
}

pub const STATUS_OPEN: &str = "open";
pub const STATUS_CLAIMED: &str = "claimed";
pub const STATUS_RESOLVED: &str = "resolved";

/// The `requests` table DDL — run by the crate's `migrate`.
pub(crate) const REQUESTS_DDL: &str = "CREATE TABLE IF NOT EXISTS requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    text         TEXT NOT NULL DEFAULT '',
    cmd          TEXT NOT NULL DEFAULT '',
    from_agent   TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'open',
    note         TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL DEFAULT 0,
    resolved_at  INTEGER NOT NULL DEFAULT 0
);";

const REQUEST_COLS: &str =
    "SELECT id, text, cmd, from_agent, status, note, created_at, resolved_at FROM requests";

fn row_to_request(r: &rusqlite::Row) -> rusqlite::Result<Request> {
    Ok(Request {
        id: r.get(0)?,
        text: r.get(1)?,
        cmd: r.get(2)?,
        from: r.get(3)?,
        status: r.get(4)?,
        note: r.get(5)?,
        created_at: r.get(6)?,
        resolved_at: r.get(7)?,
    })
}

impl Store {
    /// File a request. Returns its id.
    ///
    /// Deliberately NOT de-duplicated (unlike `lesson_add`): two workers blocked by the same missing
    /// branch are two distinct asks from two distinct agents, and collapsing them would lose the
    /// second requester — so the director would resolve one and silently strand the other.
    pub fn request_new(&self, text: &str, cmd: &str, from: &str) -> rusqlite::Result<i64> {
        let text = text.trim();
        if text.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName(
                "a request needs text saying what is being asked for".into(),
            ));
        }
        self.conn.execute(
            "INSERT INTO requests (text, cmd, from_agent, status, created_at)
             VALUES (?1, ?2, ?3, 'open', strftime('%s','now'))",
            params![text, cmd.trim(), from.trim()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Requests, oldest first — a queue, so the director works the longest-waiting ask first (the
    /// opposite of the newest-first review lists elsewhere in this store). `status` filters when
    /// non-empty.
    pub fn request_list(&self, status: &str) -> rusqlite::Result<Vec<Request>> {
        let st = status.trim();
        let (sql, args): (String, Vec<String>) = if st.is_empty() {
            (format!("{REQUEST_COLS} ORDER BY created_at ASC, id ASC"), vec![])
        } else {
            (format!("{REQUEST_COLS} WHERE status = ?1 ORDER BY created_at ASC, id ASC"), vec![st.to_string()])
        };
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), row_to_request)?;
        rows.collect()
    }

    /// One request by id, or `None`.
    pub fn request_get(&self, id: i64) -> rusqlite::Result<Option<Request>> {
        self.conn
            .query_row(&format!("{REQUEST_COLS} WHERE id = ?1"), params![id], row_to_request)
            .optional()
    }

    /// Mark a request as being worked. Only an `open` request may be claimed, so two directors (or a
    /// director and a retrying pump) cannot both take the same ask. Returns whether it moved.
    pub fn request_claim(&self, id: i64) -> rusqlite::Result<bool> {
        let n = self.conn.execute(
            "UPDATE requests SET status = 'claimed' WHERE id = ?1 AND status = 'open'",
            params![id],
        )?;
        Ok(n > 0)
    }

    /// Close a request with the note that says what was done.
    ///
    /// Accepts an `open` request as well as a `claimed` one — a director that just fixes the thing
    /// without claiming first is the common path, and rejecting it would only teach agents to claim
    /// reflexively. Re-resolving an already-resolved request is a no-op (returns false) so a replayed
    /// instruction cannot overwrite the original answer.
    pub fn request_resolve(&self, id: i64, note: &str) -> rusqlite::Result<bool> {
        let n = self.conn.execute(
            "UPDATE requests SET status = 'resolved', note = ?2, resolved_at = strftime('%s','now')
             WHERE id = ?1 AND status != 'resolved'",
            params![id, note.trim()],
        )?;
        Ok(n > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open_in_memory().expect("open")
    }

    #[test]
    fn a_filed_request_round_trips_with_its_grounding() {
        let s = store();
        // `cmd` is the whole point — an ask carrying the command that failed is actionable without a
        // conversation, which is what separates this from a `bsc-ask`.
        let id = s.request_new("no develop branch to target", "git push -u origin develop", "cli-platform").unwrap();
        let got = s.request_get(id).unwrap().expect("stored");
        assert_eq!(got.text, "no develop branch to target");
        assert_eq!(got.cmd, "git push -u origin develop");
        assert_eq!(got.from, "cli-platform");
        assert!(got.is_open(), "a new request is open");
        assert!(got.created_at > 0, "stamped");
    }

    #[test]
    fn a_request_needs_text() {
        let s = store();
        assert!(s.request_new("   ", "git status", "worker").is_err(), "empty text is rejected");
    }

    #[test]
    fn two_workers_blocked_by_the_same_thing_file_two_requests() {
        // NOT de-duplicated, unlike lessons: collapsing these would let the director resolve one and
        // silently strand the other requester.
        let s = store();
        s.request_new("no develop branch", "git push", "stream-a").unwrap();
        s.request_new("no develop branch", "git push", "stream-b").unwrap();
        assert_eq!(s.request_list(STATUS_OPEN).unwrap().len(), 2);
    }

    #[test]
    fn the_queue_is_oldest_first() {
        // A queue, not a feed — the longest-waiting ask is the one the director should see first.
        let s = store();
        let first = s.request_new("first", "", "a").unwrap();
        let second = s.request_new("second", "", "b").unwrap();
        let ids: Vec<i64> = s.request_list("").unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec![first, second]);
    }

    #[test]
    fn claiming_is_exclusive() {
        let s = store();
        let id = s.request_new("something", "", "w").unwrap();
        assert!(s.request_claim(id).unwrap(), "the open request is claimed");
        assert!(!s.request_claim(id).unwrap(), "a second claim must not succeed");
        assert_eq!(s.request_get(id).unwrap().unwrap().status, STATUS_CLAIMED);
    }

    #[test]
    fn resolving_stamps_the_answer_and_is_not_repeatable() {
        let s = store();
        let id = s.request_new("no develop branch", "git push", "w").unwrap();
        assert!(s.request_resolve(id, "created develop from main").unwrap());
        let got = s.request_get(id).unwrap().unwrap();
        assert_eq!(got.status, STATUS_RESOLVED);
        assert_eq!(got.note, "created develop from main");
        assert!(got.resolved_at > 0);
        // A replayed instruction must not overwrite the original answer.
        assert!(!s.request_resolve(id, "something else").unwrap());
        assert_eq!(s.request_get(id).unwrap().unwrap().note, "created develop from main");
    }

    #[test]
    fn an_unclaimed_request_can_be_resolved_directly() {
        // The common path: the director just does the thing. Requiring a claim first would only teach
        // agents to claim reflexively.
        let s = store();
        let id = s.request_new("x", "", "w").unwrap();
        assert!(s.request_resolve(id, "done").unwrap());
    }

    #[test]
    fn listing_filters_by_status() {
        let s = store();
        let a = s.request_new("a", "", "w").unwrap();
        s.request_new("b", "", "w").unwrap();
        s.request_resolve(a, "handled").unwrap();
        assert_eq!(s.request_list(STATUS_OPEN).unwrap().len(), 1);
        assert_eq!(s.request_list(STATUS_RESOLVED).unwrap().len(), 1);
        assert_eq!(s.request_list("").unwrap().len(), 2, "empty status returns all");
    }
}
