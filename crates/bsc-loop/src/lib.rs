//! The **loop** store (#3262, part of epic #3260) — a conversation primitive that ends on a signal, or
//! never. Two participants exchange turns; each turn sees the whole prior history; the exchange runs until
//! a *termination signal* fires — or forever, if the signal is `false`. This is what `bsc-ask`/`bsc-answer`
//! (one question, one answer, contract closed) structurally cannot express, and it generalizes the coord
//! channel (Phase B rewires ask/answer through this store; Phase A — this — is standalone).
//!
//! Tauri-free on purpose (like `plandb`/`errordb`/`skilldb`): the umbrella `bsc` binary, the desktop app,
//! and `bsc-agent` all depend on it, so the CLI stays a tiny binary.
//!
//! ## Model
//! A [`Loop`] is `{ participants a/b, a seed, a termination signal, a budget, an ordered turn log }`. Turns
//! **strictly alternate**, `a` first. The signal is evaluated after every turn:
//! - a `until` sentinel a participant emits closes the loop (`ended_by = signal`);
//! - `until = None` is **`--until false`: it never closes by signal** — a first-class mode.
//!
//! Independent of the signal, a resource ceiling halts it (`max-turns` / `budget`), and an out-of-band
//! [`Store::stop`] halts it — the halt the participants **cannot** reach (there is no sentinel to emit under
//! `--until false`, and `say` can only ever *close-by-signal*, never stop). Per-turn `tokens`/`cost` are the
//! scientific payload: a signal-less loop either converges or degenerates, and the running total is what
//! makes that a finding rather than a runaway.


use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

/// The reasons a loop closes — recorded in `ended_by`, reported by `show`.
pub const ENDED_SIGNAL: &str = "signal";
pub const ENDED_MAX_TURNS: &str = "max-turns";
pub const ENDED_BUDGET: &str = "budget";
pub const ENDED_STOP: &str = "stop";
/// #3961: the app died mid-loop (crash / kill / force-quit). Distinct from `stop` on purpose — a user
/// halting a loop and a crash killing one are different facts, and the record should say which. Every
/// other reason describes a loop that reached a DECISION (a sentinel fired, a ceiling was hit, someone
/// called stop); a crash reaches none of them, which is why the row used to just stay `open` forever.
pub const ENDED_INTERRUPTED: &str = "interrupted";

/// The default turn ceiling when `--max-turns` is omitted — a signal-less loop with no budget still halts,
/// so an accidental `--until false` is never an unbounded run. Explicitly disable with `--max-turns 0`.
pub const DEFAULT_MAX_TURNS: i64 = 24;

/// One conversation — the `loops` row plus its lifecycle.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Loop {
    pub id: i64,
    pub a: String,
    pub b: String,
    pub seed: String,
    /// The sentinel that ends the loop; `None` is `--until false` — it never closes by signal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    /// The turn ceiling; `None` is unlimited (only `stop`/`budget` can then halt it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<i64>,
    /// The cost ceiling; `None` is unlimited.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// `open` (accepting turns) or `closed`.
    pub status: String,
    /// Why it closed (`signal` | `max-turns` | `budget` | `stop`), or `None` while open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Loop {
    /// Whether the loop is still accepting turns.
    pub fn is_open(&self) -> bool {
        self.status == "open"
    }
    /// The participant whose turn it is next (`a` first, strict alternation), or `None` when closed.
    /// `last` is the most recent turn's participant (`None` when the loop has no turns yet).
    fn next_speaker(&self, last: Option<&str>) -> Option<String> {
        if !self.is_open() {
            return None;
        }
        // a speaks first; after a turn by a it's b's turn, otherwise a's.
        Some(if last == Some(self.a.as_str()) { self.b.clone() } else { self.a.clone() })
    }
}

/// One recorded turn — the persistence that IS the loop.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Turn {
    pub seq: i64,
    pub participant: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shot_path: Option<String>,
    pub tokens: i64,
    pub cost: f64,
    pub created_at: i64,
}

/// The write shape for a new loop. `until = None` means `--until false` (never by signal).
#[derive(Debug, Clone, Default)]
pub struct NewLoop {
    pub a: String,
    pub b: String,
    pub seed: String,
    pub until: Option<String>,
    pub max_turns: Option<i64>,
    pub budget: Option<f64>,
    pub project: Option<String>,
}

/// The write shape for one turn (the caller supplies `tokens`/`cost` — Phase A has no provider driving them).
#[derive(Debug, Clone, Default)]
pub struct SayInput {
    pub message: String,
    pub shot_path: Option<String>,
    pub tokens: i64,
    pub cost: f64,
    pub ts: i64,
}

/// The result of a [`Store::say`] — the new turn's `seq`, and `closed = Some(reason)` when this turn ended
/// the loop (a signal / budget / max-turns).
#[derive(Debug, Clone, PartialEq)]
pub struct SayOutcome {
    pub seq: i64,
    pub closed: Option<String>,
}

/// Why a [`Store::say`] was rejected — a validation error, distinct from a SQL error, so the CLI can report
/// precisely (and so `--until false` can be *asserted* to run past a sentinel).
#[derive(Debug)]
pub enum SayError {
    /// No loop with that id.
    NotFound,
    /// The loop is already closed (carries the `ended_by` reason).
    Closed(String),
    /// It is the other participant's turn (carries whose turn it is).
    NotYourTurn(String),
    /// The speaker is neither participant of the loop.
    UnknownParticipant,
    Db(rusqlite::Error),
}

impl std::fmt::Display for SayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SayError::NotFound => write!(f, "no such loop"),
            SayError::Closed(why) => write!(f, "loop is closed ({why})"),
            SayError::NotYourTurn(who) => write!(f, "not your turn — waiting on {who}"),
            SayError::UnknownParticipant => write!(f, "not a participant of this loop"),
            SayError::Db(e) => write!(f, "{e}"),
        }
    }
}
impl std::error::Error for SayError {}
impl From<rusqlite::Error> for SayError {
    fn from(e: rusqlite::Error) -> Self {
        SayError::Db(e)
    }
}

/// Filters for [`Store::list`].
#[derive(Debug, Clone, Default)]
pub struct Filter {
    /// Only loops still accepting turns.
    pub open_only: bool,
    /// Only loops tagged with this project.
    pub project: Option<String>,
    pub limit: Option<i64>,
    /// Only loops where it is THIS participant's turn to speak.
    ///
    /// The discovery half of `bsc session ask` (`a-running-session-never-learns-a-loop-is-waiting-for-it`).
    /// A session learns a loop id from its launch prompt, and a session that was ALREADY RUNNING when the
    /// ask arrived never gets one — so without a way to ask "which loops await me?" a live session cannot
    /// find the request at all, and it sits open until the caller's timeout. This is what makes it findable
    /// while keeping the callee the one that enters the read: it is a QUERY, never a push.
    pub awaiting: Option<String>,
}

/// The loop store — a thin owner of the SQLite connection plus the create / turn-append / read ops.
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open (creating + migrating) the loops.db at `path`. WAL + busy_timeout so the app and the CLI share
    /// the db without a SQLITE_BUSY race.
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        Ok(Store { conn: bsc_sqlite_util::open_migrated(path, schema::migrate)? })
    }

    /// An ephemeral in-memory store — for tests.
    pub fn open_in_memory() -> rusqlite::Result<Store> {
        Ok(Store { conn: bsc_sqlite_util::open_in_memory_migrated(schema::migrate)? })
    }

    /// Empty the whole store — see [`bsc_sqlite_util::clear_tables`] for why it truncates.
    pub fn clear(&self) -> rusqlite::Result<()> {
        bsc_sqlite_util::clear_tables(&self.conn, schema::ALL_TABLES)
    }

    /// Create a loop; returns it with its assigned id. `a` speaks first.
    pub fn create(&self, n: &NewLoop, now: i64) -> rusqlite::Result<Loop> {
        self.conn.execute(
            "INSERT INTO loops (a, b, seed, until_sig, max_turns, budget, project, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8, ?8)",
            params![n.a, n.b, n.seed, n.until, n.max_turns, n.budget, n.project, now],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(self.get(id)?.expect("loop exists after insert"))
    }

    /// One loop by id, or `None`.
    pub fn get(&self, id: i64) -> rusqlite::Result<Option<Loop>> {
        self.conn
            .query_row(&format!("SELECT {COLS} FROM loops WHERE id = ?1"), params![id], row_to_loop)
            .optional()
    }

    /// The full, ordered turn log for a loop (the whole prior history each turn sees).
    pub fn turns(&self, id: i64) -> rusqlite::Result<Vec<Turn>> {
        let mut stmt = self
            .conn
            .prepare("SELECT seq, participant, message, shot_path, tokens, cost, created_at FROM turns WHERE loop_id = ?1 ORDER BY seq")?;
        let rows = stmt.query_map(params![id], row_to_turn)?;
        rows.collect()
    }

    /// The participant whose turn it is next, or `None` if the loop is closed / absent.
    pub fn whose_turn(&self, id: i64) -> rusqlite::Result<Option<String>> {
        let Some(lp) = self.get(id)? else { return Ok(None) };
        self.next_participant(&lp)
    }

    /// Whose turn it is on a loop already in hand — the shared body behind [`Store::whose_turn`] and the
    /// `awaiting` filter, so the alternation rule has ONE implementation. Deriving it a second time in SQL
    /// would put the turn order in two places, and the copy is what goes stale.
    fn next_participant(&self, lp: &Loop) -> rusqlite::Result<Option<String>> {
        let last: Option<String> = self
            .conn
            .query_row("SELECT participant FROM turns WHERE loop_id = ?1 ORDER BY seq DESC LIMIT 1", params![lp.id], |r| r.get(0))
            .optional()?;
        Ok(lp.next_speaker(last.as_deref()))
    }

    /// The open loops waiting on `participant`, **oldest first**.
    ///
    /// Oldest first because this answers "what should I serve next": newest-first would starve the
    /// longest-waiting caller, and an ask that has already burned its timeout is the one most worth
    /// answering. (`list` stays newest-first — it is a table, not a queue.)
    pub fn awaiting(&self, participant: &str) -> rusqlite::Result<Vec<Loop>> {
        let mut v = self.list(&Filter {
            open_only: true,
            awaiting: Some(participant.to_string()),
            ..Default::default()
        })?;
        v.reverse();
        Ok(v)
    }

    /// The running cost total across a loop's turns.
    pub fn total_cost(&self, id: i64) -> rusqlite::Result<f64> {
        self.conn
            .query_row("SELECT COALESCE(SUM(cost), 0) FROM turns WHERE loop_id = ?1", params![id], |r| r.get(0))
    }

    /// Append `participant`'s turn — validating the loop is open, the speaker is a participant, and it is
    /// their turn (strict alternation, `a` first) — then evaluate the termination signal, the budget, and
    /// the turn ceiling. Closing precedence: an explicit **signal** first, then **budget**, then
    /// **max-turns**. Returns the new turn's `seq` and whether it closed the loop.
    pub fn say(&self, id: i64, participant: &str, input: &SayInput) -> Result<SayOutcome, SayError> {
        let lp = self.get(id).map_err(SayError::Db)?.ok_or(SayError::NotFound)?;
        if !lp.is_open() {
            return Err(SayError::Closed(lp.ended_by.unwrap_or_default()));
        }
        if participant != lp.a && participant != lp.b {
            return Err(SayError::UnknownParticipant);
        }
        let turn = self.whose_turn(id)?.expect("open loop has a next speaker");
        if participant != turn {
            return Err(SayError::NotYourTurn(turn));
        }

        let seq: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM turns WHERE loop_id = ?1", params![id], |r| r.get(0))?;
        self.conn.execute(
            "INSERT INTO turns (loop_id, seq, participant, message, shot_path, tokens, cost, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, seq, participant, input.message, input.shot_path, input.tokens, input.cost, input.ts],
        )?;

        // Evaluate closure — signal (semantic) wins, then the resource ceilings.
        let mut ended: Option<&str> = None;
        if let Some(sig) = &lp.until {
            if !sig.is_empty() && input.message.contains(sig.as_str()) {
                ended = Some(ENDED_SIGNAL);
            }
        }
        if ended.is_none() {
            if let Some(b) = lp.budget {
                if self.total_cost(id)? >= b {
                    ended = Some(ENDED_BUDGET);
                }
            }
        }
        if ended.is_none() {
            if let Some(mt) = lp.max_turns {
                if seq >= mt {
                    ended = Some(ENDED_MAX_TURNS);
                }
            }
        }
        if let Some(why) = ended {
            self.close(id, why, input.ts)?;
        } else {
            self.conn.execute("UPDATE loops SET updated_at = ?2 WHERE id = ?1", params![id, input.ts])?;
        }
        Ok(SayOutcome { seq, closed: ended.map(str::to_string) })
    }

    /// Out-of-band halt (#3262) — the halt the *participants* cannot reach (`say` only ever closes by a
    /// signal; there is none under `--until false`). Returns whether an open loop was closed.
    pub fn stop(&self, id: i64, now: i64) -> rusqlite::Result<bool> {
        let n = self.conn.execute(
            "UPDATE loops SET status = 'closed', ended_by = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'open'",
            params![id, ENDED_STOP, now],
        )?;
        Ok(n > 0)
    }

    /// Loops still `open` — the ones an unclean shutdown stranded (#3961).
    ///
    /// A crash leaves a loop `open` with no way to progress: its participants died with the app, and
    /// `watch` blocks until a turn that will never come. The CALLER decides these are stranded (it
    /// knows whether the last shutdown was unclean); this only answers "what was still running?", so
    /// the store never has to guess about process liveness.
    pub fn open_loops(&self) -> rusqlite::Result<Vec<Loop>> {
        self.list(&Filter { open_only: true, ..Default::default() })
    }

    /// Close `ids` as INTERRUPTED, returning how many actually changed (#3961).
    ///
    /// Guarded on `status = 'open'`, so an already-closed loop is never rewritten — a loop that ended
    /// properly must keep the reason it ended with, even if it appears in a stale caller's id list.
    pub fn mark_interrupted(&self, ids: &[i64], now: i64) -> rusqlite::Result<usize> {
        let mut n = 0;
        for id in ids {
            n += self.conn.execute(
                "UPDATE loops SET status = 'closed', ended_by = ?2, updated_at = ?3                  WHERE id = ?1 AND status = 'open'",
                params![id, ENDED_INTERRUPTED, now],
            )?;
        }
        Ok(n)
    }

    /// Internal: mark a loop closed with a reason.
    fn close(&self, id: i64, why: &str, now: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE loops SET status = 'closed', ended_by = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, why, now],
        )?;
        Ok(())
    }

    /// The loop table under `filter`, newest first.
    pub fn list(&self, filter: &Filter) -> rusqlite::Result<Vec<Loop>> {
        let mut sql = format!("SELECT {COLS} FROM loops");
        let mut clauses: Vec<String> = Vec::new();
        let mut vals: Vec<rusqlite::types::Value> = Vec::new();
        if filter.open_only {
            clauses.push("status = 'open'".into());
        }
        if let Some(p) = &filter.project {
            vals.push(rusqlite::types::Value::Text(p.clone()));
            clauses.push(format!("project = ?{}", vals.len()));
        }
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY id DESC");
        // The `awaiting` filter is evaluated in Rust (turn order lives in `next_speaker`, not in SQL), so a
        // SQL LIMIT would cut rows BEFORE it ran and silently under-report — `--limit 1` could return
        // nothing while a loop awaited you. Applied after the filter instead, below.
        if filter.awaiting.is_none() {
            if let Some(n) = filter.limit {
                sql.push_str(&format!(" LIMIT {}", n.max(0)));
            }
        }
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(vals), row_to_loop)?;
        let mut out: Vec<Loop> = rows.collect::<rusqlite::Result<Vec<Loop>>>()?;
        if let Some(who) = &filter.awaiting {
            let mut kept: Vec<Loop> = Vec::new();
            for lp in out {
                if self.next_participant(&lp)?.as_deref() == Some(who.as_str()) {
                    kept.push(lp);
                }
            }
            out = kept;
            if let Some(n) = filter.limit {
                out.truncate(n.max(0) as usize);
            }
        }
        Ok(out)
    }
}

/// The column list `row_to_loop` decodes, in one place so the SELECTs can't drift from the mapper.
const COLS: &str = "id, a, b, seed, until_sig, max_turns, budget, project, status, ended_by, created_at, updated_at";

fn row_to_loop(r: &rusqlite::Row) -> rusqlite::Result<Loop> {
    Ok(Loop {
        id: r.get(0)?,
        a: r.get(1)?,
        b: r.get(2)?,
        seed: r.get(3)?,
        until: r.get(4)?,
        max_turns: r.get(5)?,
        budget: r.get(6)?,
        project: r.get(7)?,
        status: r.get(8)?,
        ended_by: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
    })
}

fn row_to_turn(r: &rusqlite::Row) -> rusqlite::Result<Turn> {
    Ok(Turn {
        seq: r.get(0)?,
        participant: r.get(1)?,
        message: r.get(2)?,
        shot_path: r.get(3)?,
        tokens: r.get(4)?,
        cost: r.get(5)?,
        created_at: r.get(6)?,
    })
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/schema.rs, src/tests.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-loop--<module>.rs
//     bsc graph impl set --id bsc-loop--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-loop--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-loop--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));