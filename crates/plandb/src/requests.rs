//! Tier-upward **change requests** (#4000) — the project-scoped ask lane.
//!
//! Originally worker→director, and now one tier more general: a request names the TIER it is
//! addressed to. That generalization is the upward twin of what `brief` already got going down
//! (`funnel-generalize-brief-channel`), and it exists because the middle tier had no way to ask.
//! The director could receive a brief from the architect and could not answer it or ask for
//! anything — `brief` is explicitly information rather than a question, and `request` was worked BY
//! the director, so filing one addressed it to itself.
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

/// The tiers a request can be addressed to.
///
/// A CLOSED SET, for the same reason `Role::parse` is one: an unrecognised target would either be
/// silently dropped by whichever queue never asks for it, or re-routed to a tier that did not ask
/// for the work. Both look like it worked.
///
/// `director` is the default and is what every existing row means — a request filed before this
/// existed was, by construction, a worker asking its director.
pub const REQUEST_TARGETS: &[&str] = &["director", "architect"];

/// The default target, and the meaning of every row written before targets existed.
pub const TARGET_DIRECTOR: &str = "director";

/// A tier-upward change request — one `requests` row.
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
    /// The TIER this is addressed to — one of [`REQUEST_TARGETS`]. Defaults to
    /// [`TARGET_DIRECTOR`], which is what every row written before targets existed means.
    #[serde(default)]
    pub target: String,
    /// The plan item this request concerns, when it names one.
    ///
    /// This is what makes "the items the architect is responsible for" answerable: a request
    /// addressed to `architect` and citing a ref says which item is being handed up, and the
    /// open ones are the outstanding set. Same field, same purpose, as `brief --ref`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reference: String,
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
    resolved_at  INTEGER NOT NULL DEFAULT 0,
    target       TEXT NOT NULL DEFAULT 'director',
    ref_id       TEXT NOT NULL DEFAULT ''
);";

const REQUEST_COLS: &str = "SELECT id, text, cmd, from_agent, status, note, created_at, \
     resolved_at, target, ref_id FROM requests";

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
        target: r.get(8)?,
        reference: r.get(9)?,
    })
}

impl Store {
    /// File a request. Returns its id.
    ///
    /// Deliberately NOT de-duplicated (unlike `lesson_add`): two workers blocked by the same missing
    /// branch are two distinct asks from two distinct agents, and collapsing them would lose the
    /// second requester — so the director would resolve one and silently strand the other.
    /// File a request addressed to the DIRECTOR — the original lane, and the common case.
    ///
    /// Kept as its own three-argument verb rather than folded into [`Store::request_new_to`] with a
    /// default: a worker asking its director is what a request has always meant, and every call
    /// site that says so should keep saying it in three words.
    pub fn request_new(&self, text: &str, cmd: &str, from: &str) -> rusqlite::Result<i64> {
        self.request_new_to(text, cmd, from, TARGET_DIRECTOR, "")
    }

    /// File a request addressed to a TIER. `target` empty ⇒ [`TARGET_DIRECTOR`].
    ///
    /// An unrecognised target is REFUSED rather than defaulted: defaulting would route a request
    /// meant for one tier to another, and the requester would read "filed" and wait forever.
    pub fn request_new_to(
        &self,
        text: &str,
        cmd: &str,
        from: &str,
        target: &str,
        reference: &str,
    ) -> rusqlite::Result<i64> {
        let text = text.trim();
        if text.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName(
                "a request needs text saying what is being asked for".into(),
            ));
        }
        let target = match target.trim() {
            "" => TARGET_DIRECTOR,
            t if REQUEST_TARGETS.contains(&t) => t,
            other => {
                return Err(rusqlite::Error::InvalidParameterName(format!(
                    "{other:?} is not a tier a request can be addressed to — one of: {}",
                    REQUEST_TARGETS.join(" "),
                )))
            }
        };
        self.conn.execute(
            "INSERT INTO requests (text, cmd, from_agent, status, created_at, target, ref_id)
             VALUES (?1, ?2, ?3, 'open', strftime('%s','now'), ?4, ?5)",
            params![text, cmd.trim(), from.trim(), target, reference.trim()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Requests, oldest first — a queue, so the director works the longest-waiting ask first (the
    /// opposite of the newest-first review lists elsewhere in this store). `status` filters when
    /// non-empty.
    /// The queue, oldest first. Empty `status`/`target` mean "any".
    ///
    /// `target` is what makes the lane usable from two tiers at once: a director asks for the rows
    /// addressed to IT, and reads what it has sent up by asking for `architect`. Without the filter
    /// both tiers would work one another's queues.
    pub fn request_list(&self, status: &str) -> rusqlite::Result<Vec<Request>> {
        self.request_list_for(status, "")
    }

    pub fn request_list_for(&self, status: &str, target: &str) -> rusqlite::Result<Vec<Request>> {
        let (st, tg) = (status.trim(), target.trim());
        let mut where_ = Vec::new();
        let mut args: Vec<String> = Vec::new();
        if !st.is_empty() {
            args.push(st.to_string());
            where_.push(format!("status = ?{}", args.len()));
        }
        if !tg.is_empty() {
            args.push(tg.to_string());
            where_.push(format!("target = ?{}", args.len()));
        }
        let clause = if where_.is_empty() { String::new() } else { format!(" WHERE {}", where_.join(" AND ")) };
        let sql = format!("{REQUEST_COLS}{clause} ORDER BY created_at ASC, id ASC");
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

// ── the lane goes UP a tier (the-director-cannot-reach-its-architect) ────────────────────────────
//
// The director could receive a brief from the architect and had no way to answer it or ask for
// anything: `brief` is explicitly information rather than a question, and `request` was worked BY
// the director, so filing one addressed it to itself. A request now names the tier it is for.

#[cfg(test)]
mod target_tests {
    use super::*;

    fn store() -> crate::Store {
        crate::Store::open_in_memory().expect("in-memory store")
    }

    /// The DEFAULT is what every row written before targets existed means. A migrated row and a
    /// freshly-filed one must be indistinguishable, or the director's own queue changes shape
    /// under it on upgrade.
    #[test]
    fn a_request_with_no_target_is_the_directors_as_it_always_was() {
        let s = store();
        let id = s.request_new("no integration branch", "git push", "stream-3").unwrap();
        let r = s.request_get(id).unwrap().expect("stored");
        assert_eq!(r.target, TARGET_DIRECTOR);
        assert_eq!(r.reference, "", "no ref unless one is cited");
    }

    /// THE new lane: a director asking the tier above it.
    #[test]
    fn a_director_can_address_the_architect_and_cite_the_item() {
        let s = store();
        let id = s
            .request_new_to(
                "this stream needs a requirement clause we do not have",
                "bsc plan requirement get",
                "network-monitor:director",
                "architect",
                "phase-0-commons",
            )
            .unwrap();
        let r = s.request_get(id).unwrap().expect("stored");
        assert_eq!(r.target, "architect");
        assert_eq!(r.reference, "phase-0-commons", "the item this hands up");
        assert_eq!(r.from, "network-monitor:director");
        assert!(r.is_open());
    }

    /// The filter is what makes one table serve two tiers. Without it each would work the other's
    /// queue — a director handed back the asks it just sent upward.
    #[test]
    fn each_tier_sees_only_what_is_addressed_to_it() {
        let s = store();
        s.request_new("a worker ask", "", "stream-1").unwrap();
        s.request_new_to("an upward ask", "", "proj:director", "architect", "").unwrap();

        let to_director = s.request_list_for("", TARGET_DIRECTOR).unwrap();
        let to_architect = s.request_list_for("", "architect").unwrap();
        assert_eq!(to_director.len(), 1, "{to_director:?}");
        assert_eq!(to_director[0].text, "a worker ask");
        assert_eq!(to_architect.len(), 1, "{to_architect:?}");
        assert_eq!(to_architect[0].text, "an upward ask");

        // ...and an unfiltered list is still the whole queue, so nothing that existed is hidden.
        assert_eq!(s.request_list("").unwrap().len(), 2);
    }

    /// "The items the architect is responsible for" is a QUERY, not a second ownership axis: the
    /// open requests addressed to it, each citing the item it concerns.
    #[test]
    fn what_the_architect_owes_is_its_open_requests() {
        let s = store();
        let a = s.request_new_to("refine the requirement", "", "d", "architect", "item-a").unwrap();
        s.request_new_to("re-scope phase 2", "", "d", "architect", "item-b").unwrap();
        s.request_resolve(a, "clause added").unwrap();

        let open = s.request_list_for("open", "architect").unwrap();
        assert_eq!(open.len(), 1, "a resolved one drops off the list: {open:?}");
        assert_eq!(open[0].reference, "item-b");
    }

    /// A store written BEFORE targets existed upgrades in place, and its rows still read as the
    /// director's. Driven through the real migration rather than asserted on the DDL default: the
    /// default is on the new column, and an ALTER on an existing table is the path a real machine
    /// takes.
    #[test]
    fn an_existing_store_upgrades_and_its_rows_stay_the_directors() {
        let dir = std::env::temp_dir().join(format!("bsc-reqmig-{}-{:?}", std::process::id(), std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("plan.db");

        // A store as it looked before: the old DDL, one row, no target column at all.
        {
            let c = rusqlite::Connection::open(&db).unwrap();
            c.execute_batch(
                "CREATE TABLE requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    text TEXT NOT NULL DEFAULT '',
                    cmd TEXT NOT NULL DEFAULT '',
                    from_agent TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'open',
                    note TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL DEFAULT 0,
                    resolved_at INTEGER NOT NULL DEFAULT 0
                );
                 INSERT INTO requests (text, from_agent, status) VALUES ('an old ask', 'stream-1', 'open');",
            )
            .unwrap();
        }

        let s = crate::Store::open(&db).expect("opens and migrates");
        let all = s.request_list("").unwrap();
        assert_eq!(all.len(), 1, "the existing row survives");
        assert_eq!(all[0].text, "an old ask");
        assert_eq!(all[0].target, TARGET_DIRECTOR, "and still means what it meant");
        assert_eq!(
            s.request_list_for("", TARGET_DIRECTOR).unwrap().len(),
            1,
            "so the director's queue is unchanged by the upgrade",
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// An unrecognised tier is REFUSED, not defaulted. Defaulting would route a request meant for
    /// one tier to another and the requester would read "filed" and wait forever.
    #[test]
    fn an_unknown_tier_is_refused_and_the_error_names_the_set() {
        let s = store();
        let err = s
            .request_new_to("x", "", "d", "worker", "")
            .expect_err("must be refused")
            .to_string();
        for t in REQUEST_TARGETS {
            assert!(err.contains(t), "the error must name {t}: {err}");
        }
        assert_eq!(s.request_list("").unwrap().len(), 0, "and nothing is stored");
    }
}
