//! Per-app usage-events store (#3812, epic #3809) — the per-project sink a running/generated app records
//! usage events to and `bsc usage` reads. One SQLite db per project hub (`projects/<key>/usage.db`),
//! scoped at a live session by `$BSC_USAGE_DB` exactly as error.db is by `$BSC_ERROR_DB`. The db *is* the
//! attribution: one store per project. The dev-process analogue of [`errordb`](../errordb) — "a running
//! app writes to a per-project store, an agent reads it via `bsc`" — for usage instead of faults.
//!
//! Tauri-free on purpose (like `errordb`/`plandb`): the desktop app + the `bsc usage` agent CLI both
//! depend on it, so the CLI stays a tiny binary.
//!
//! ## Model
//! One aggregate row per event NAME (`count` + first/last seen + the last props payload) — so usage
//! volume stays bounded no matter how often an event fires — plus a capped raw log of occurrences.
//! `summary` returns the aggregates (the "what are users doing" read); `list` returns raw occurrences.


use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

/// At most this many `events` rows are kept per event name (older occurrences are pruned on insert), so
/// an event that fires a million times costs one `usage` row + a bounded occurrence sample.
const EVENTS_PER_NAME_CAP: i64 = 50;

/// One event's aggregate row — what `bsc usage summary` returns.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EventCount {
    pub event: String,
    pub count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_props: Option<String>,
    pub first_seen: i64,
    pub last_seen: i64,
}

/// One raw occurrence — what `bsc usage list` returns.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Occurrence {
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props: Option<String>,
    pub ts: i64,
}

/// The write shape for recording one usage event (a producer/agent/CLI builds this).
#[derive(Debug, Clone, Default)]
pub struct EventInput {
    pub event: String,
    /// A JSON props payload (the event's fields), or None. Stored verbatim.
    pub props: Option<String>,
    pub ts: i64,
}

/// Filters for [`Store::list`]. All-`None` lists every occurrence, newest first.
#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub event: Option<String>,
    /// Only occurrences with `ts >= since`.
    pub since: Option<i64>,
    pub limit: Option<i64>,
}

/// The per-project usage store — a thin owner of the SQLite connection plus the event upsert/read.
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open (creating + migrating) the usage.db at `path`. Parent dirs are created. WAL + busy_timeout
    /// are set so the app and the `bsc usage` CLI can share the db without a SQLITE_BUSY race.
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

    /// Record one occurrence. The first sighting seeds the aggregate (`count = 1`, `first_seen`); a
    /// repeat bumps `count` + `last_seen` and refreshes `last_props`. Also appends a capped `events` row.
    /// Returns the resulting aggregate. A blank event name is a no-op error (nothing to attribute to).
    pub fn record(&self, input: &EventInput) -> rusqlite::Result<EventCount> {
        let ev = input.event.trim();
        self.conn.execute(
            "INSERT INTO usage (event, count, last_props, first_seen, last_seen)
             VALUES (?1, 1, ?2, ?3, ?3)
             ON CONFLICT(event) DO UPDATE SET
                count      = count + 1,
                last_seen  = excluded.last_seen,
                last_props = COALESCE(excluded.last_props, last_props)",
            params![ev, input.props, input.ts],
        )?;
        self.conn
            .execute("INSERT INTO events (event, props, ts) VALUES (?1, ?2, ?3)", params![ev, input.props, input.ts])?;
        // Prune to the per-event cap (keep the most-recent by insertion id).
        self.conn.execute(
            "DELETE FROM events WHERE event = ?1 AND id NOT IN
                (SELECT id FROM events WHERE event = ?1 ORDER BY id DESC LIMIT ?2)",
            params![ev, EVENTS_PER_NAME_CAP],
        )?;
        Ok(self.get(ev)?.expect("event exists after upsert"))
    }

    /// One event's aggregate by name, or None.
    pub fn get(&self, event: &str) -> rusqlite::Result<Option<EventCount>> {
        self.conn
            .query_row(&format!("SELECT {COLS} FROM usage WHERE event = ?1"), params![event], row_to_count)
            .optional()
    }

    /// The per-event aggregates, most-fired first (the usage scoreboard). `limit` caps the rows.
    pub fn summary(&self, limit: Option<i64>) -> rusqlite::Result<Vec<EventCount>> {
        let mut sql = format!("SELECT {COLS} FROM usage ORDER BY count DESC, event");
        if let Some(n) = limit {
            sql.push_str(&format!(" LIMIT {}", n.max(0)));
        }
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], row_to_count)?;
        rows.collect()
    }

    /// Raw occurrences under `filter`, newest first.
    pub fn list(&self, filter: &Filter) -> rusqlite::Result<Vec<Occurrence>> {
        let mut sql = "SELECT event, props, ts FROM events".to_string();
        let mut clauses: Vec<String> = Vec::new();
        let mut vals: Vec<Value> = Vec::new();
        if let Some(e) = &filter.event {
            vals.push(Value::Text(e.clone()));
            clauses.push(format!("event = ?{}", vals.len()));
        }
        if let Some(since) = filter.since {
            vals.push(Value::Integer(since));
            clauses.push(format!("ts >= ?{}", vals.len()));
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
        let rows = stmt.query_map(rusqlite::params_from_iter(vals), |r| {
            Ok(Occurrence { event: r.get(0)?, props: r.get(1)?, ts: r.get(2)? })
        })?;
        rows.collect()
    }
}

/// The column list `row_to_count` decodes, kept in one place so the SELECTs can't drift from the mapper.
const COLS: &str = "event, count, last_props, first_seen, last_seen";

fn row_to_count(r: &rusqlite::Row) -> rusqlite::Result<EventCount> {
    Ok(EventCount {
        event: r.get(0)?,
        count: r.get(1)?,
        last_props: r.get(2)?,
        first_seen: r.get(3)?,
        last_seen: r.get(4)?,
    })
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/schema.rs, src/tests.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get usagedb--<module>.rs
//     bsc graph impl set --id usagedb--<module>.rs --code-file <f>
//     bsc graph promote --id usagedb--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `usagedb--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));