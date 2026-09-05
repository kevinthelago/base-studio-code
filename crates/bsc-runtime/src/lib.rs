//! The **runtime-attestation** store — what ACTUALLY served each module while the app ran.
//!
//! ~930 of this app's frontend modules ship as RECORDS (epic #3604), and until now nothing could answer
//! the first question anyone asks about that: *is the record what is running?* The runtime already
//! decides it — `loadComponentFromSource` declines a record that will not compile, whose closure needs
//! a module that is neither registered nor a record, or that throws while evaluating, and serves the
//! bundled platform module instead — but the only trace was a `graph-loader:` warn line. A migrated
//! record could therefore be inert in production and look exactly like a working one.
//!
//! This crate is where that decision is written down. It is Tauri-free (like `plandb`/`errordb`/
//! `bsc-request`) so the app writes through it and the `bsc` binary — and `doctor` behind it — reads
//! through the same code rather than a second implementation of the same query.
//!
//! **Coalesced, not append-only.** See `schema.rs`: a page mount links hundreds of modules, so
//! per-load rows would be six figures a session to answer a question that only needs "did it serve, how
//! often, how slow". Every write folds into a row keyed by
//! `(specifier, record_id, src_hash, outcome, session)`.


pub use hash::src_hash;

/// Where `runtime.db` lives: `$BSC_RUNTIME_DB` → `~/.base-studio-code/runtime.db`.
///
/// ONE resolver, exported, because there are three readers — `bsc runtime`, `bsc ui doctor --runtime`
/// and `bsc graph doctor --runtime` — and the first honoured the env var while the other two hardcoded
/// the path. That is invisible until someone points a test or a second install at another store and the
/// doctors quietly answer from the real one instead.
pub fn default_db_path() -> Option<std::path::PathBuf> {
    bsc_sqlite_util::default_store_path("BSC_RUNTIME_DB", &["runtime.db"])
}

use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;

/// What happened when the runtime resolved a module.
///
/// Deliberately a plain string rather than an enum at the DB boundary: the frontend is the only writer,
/// a new outcome must be addable there without a schema migration, and an unrecognised value should
/// survive to be reported rather than being rejected at ingest. [`Outcome`] names the ones that exist.
pub struct Outcome;

impl Outcome {
    /// The record compiled, linked, evaluated and mounted. The record IS what ran.
    pub const SERVED: &'static str = "served";
    /// The record's source does not compile — the platform module served instead.
    pub const DECLINED_COMPILE: &'static str = "declined-compile";
    /// The record's closure needs a module that is neither registered nor a record.
    pub const DECLINED_CLOSURE: &'static str = "declined-closure";
    /// It compiled and linked but threw while evaluating (a build-time-only form, usually).
    pub const DECLINED_EVAL: &'static str = "declined-eval";
    /// The current version failed to render, so the last version that rendered was served instead.
    pub const FELL_BACK: &'static str = "fell-back";
    /// The record mounted and then threw during render — the boundary caught it.
    pub const RENDER_THREW: &'static str = "render-threw";
    /// The record was LINKED into a closure that served. This is what an algorithm implementation gets:
    /// it runs inside someone else's module, so linkage is the honest claim and execution counts are
    /// deliberately not asserted.
    pub const LINKED: &'static str = "linked";

    /// Every outcome meaning "the record did NOT serve" — the set `doctor` reports as DECLINED.
    pub const DECLINED: &'static [&'static str] =
        &[Self::DECLINED_COMPILE, Self::DECLINED_CLOSURE, Self::DECLINED_EVAL];
}

/// One attestation as it arrives from the app: a single coalesced observation to fold in.
#[derive(Debug, Clone, Default)]
pub struct NewAttestation {
    pub specifier: String,
    pub record_id: String,
    pub src_hash: String,
    pub outcome: String,
    pub session: String,
    /// How many times this exact fact was observed in the batch. `0` is treated as `1` — a caller that
    /// forgot to count still records that it happened, which is the fact that matters.
    pub n: i64,
    pub reason: Option<String>,
    /// Summed milliseconds across those `n` observations, and the slowest single one.
    pub ms_total: f64,
    pub ms_max: f64,
    pub at: i64,
}

/// One stored row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Attestation {
    pub specifier: String,
    pub record_id: String,
    pub src_hash: String,
    pub outcome: String,
    pub session: String,
    pub n: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub ms_total: f64,
    pub ms_max: f64,
    pub first_at: i64,
    pub last_at: i64,
}

impl Attestation {
    /// Mean milliseconds per observation, or `None` when nothing was timed. Derived rather than stored
    /// so it cannot disagree with the counters it comes from.
    pub fn ms_mean(&self) -> Option<f64> {
        (self.n > 0 && self.ms_total > 0.0).then(|| self.ms_total / self.n as f64)
    }
    /// Did the record serve, in any sense that means its code ran?
    pub fn is_serving(&self) -> bool {
        self.outcome == Outcome::SERVED || self.outcome == Outcome::LINKED
    }
    /// Was the record refused in favour of the bundled platform module?
    pub fn is_declined(&self) -> bool {
        Outcome::DECLINED.contains(&self.outcome.as_str())
    }
}

/// Filters for [`Store::list`]. All-default lists everything, most recent first.
#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub record_id: Option<String>,
    pub specifier: Option<String>,
    pub outcome: Option<String>,
    pub session: Option<String>,
    pub since_ms: Option<i64>,
    pub limit: Option<i64>,
}

/// The attestation store — a thin owner of the SQLite connection plus fold/read.
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open (creating + migrating) the runtime.db at `path`. WAL + busy_timeout so the app's flush and
    /// a session's read never collide.
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        Ok(Store { conn: bsc_sqlite_util::open_migrated(path, schema::migrate)? })
    }

    /// An ephemeral in-memory store — for tests.
    pub fn open_in_memory() -> rusqlite::Result<Store> {
        Ok(Store { conn: bsc_sqlite_util::open_in_memory_migrated(schema::migrate)? })
    }

    /// Empty the store — see [`bsc_sqlite_util::clear_tables`] for why it truncates.
    pub fn clear(&self) -> rusqlite::Result<()> {
        bsc_sqlite_util::clear_tables(&self.conn, schema::ALL_TABLES)
    }

    /// Fold one observation into the store.
    ///
    /// `n` accumulates, `ms_total` accumulates, `ms_max` takes the larger, `first_at` keeps the earliest
    /// and `last_at` the latest. `reason` keeps the FIRST one recorded and never overwrites: the cause a
    /// decline was first seen with is the diagnostic, and letting a later identical decline replace it
    /// gains nothing while risking the useful message being swapped for a truncated one.
    pub fn fold(&self, a: &NewAttestation) -> rusqlite::Result<()> {
        let n = if a.n > 0 { a.n } else { 1 };
        self.conn.execute(
            "INSERT INTO attestations
               (specifier, record_id, src_hash, outcome, session, n, reason, ms_total, ms_max, first_at, last_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
             ON CONFLICT(specifier, record_id, src_hash, outcome, session) DO UPDATE SET
               n        = n + excluded.n,
               ms_total = ms_total + excluded.ms_total,
               ms_max   = MAX(ms_max, excluded.ms_max),
               reason   = COALESCE(reason, excluded.reason),
               first_at = MIN(first_at, excluded.first_at),
               last_at  = MAX(last_at, excluded.last_at)",
            params![
                a.specifier, a.record_id, a.src_hash, a.outcome, a.session,
                n, a.reason, a.ms_total, a.ms_max, a.at,
            ],
        )?;
        Ok(())
    }

    /// Fold a whole batch in ONE transaction — the shape the app's flush actually uses.
    ///
    /// Transactional because a flush is a batch: a partial apply would leave the store claiming a page
    /// linked eleven of its modules, which reads as a real finding rather than as a torn write.
    pub fn fold_batch(&mut self, batch: &[NewAttestation]) -> rusqlite::Result<usize> {
        let tx = self.conn.transaction()?;
        for a in batch {
            let n = if a.n > 0 { a.n } else { 1 };
            tx.execute(
                "INSERT INTO attestations
                   (specifier, record_id, src_hash, outcome, session, n, reason, ms_total, ms_max, first_at, last_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
                 ON CONFLICT(specifier, record_id, src_hash, outcome, session) DO UPDATE SET
                   n        = n + excluded.n,
                   ms_total = ms_total + excluded.ms_total,
                   ms_max   = MAX(ms_max, excluded.ms_max),
                   reason   = COALESCE(reason, excluded.reason),
                   first_at = MIN(first_at, excluded.first_at),
                   last_at  = MAX(last_at, excluded.last_at)",
                params![
                    a.specifier, a.record_id, a.src_hash, a.outcome, a.session,
                    n, a.reason, a.ms_total, a.ms_max, a.at,
                ],
            )?;
        }
        tx.commit()?;
        Ok(batch.len())
    }

    /// Rows matching `filter`, most recently seen first.
    pub fn list(&self, filter: &Filter) -> rusqlite::Result<Vec<Attestation>> {
        let mut sql = format!("SELECT {COLS} FROM attestations WHERE 1=1");
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        for (clause, value) in [
            (" AND record_id = ?", filter.record_id.clone()),
            (" AND specifier = ?", filter.specifier.clone()),
            (" AND outcome = ?", filter.outcome.clone()),
            (" AND session = ?", filter.session.clone()),
        ] {
            if let Some(v) = value {
                sql.push_str(clause);
                binds.push(Box::new(v));
            }
        }
        if let Some(since) = filter.since_ms {
            sql.push_str(" AND last_at >= ?");
            binds.push(Box::new(since));
        }
        sql.push_str(" ORDER BY last_at DESC");
        if let Some(limit) = filter.limit {
            sql.push_str(" LIMIT ?");
            binds.push(Box::new(limit));
        }
        let mut stmt = self.conn.prepare(&sql)?;
        let refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(std::convert::AsRef::as_ref).collect();
        let rows = stmt.query_map(refs.as_slice(), row_to_attestation)?;
        rows.collect()
    }

    /// Every attestation for one record, newest first — the read `doctor` and `--metrics` both make.
    pub fn for_record(&self, record_id: &str) -> rusqlite::Result<Vec<Attestation>> {
        self.list(&Filter { record_id: Some(record_id.to_string()), ..Default::default() })
    }

    /// How many DISTINCT app runs are represented. The denominator for "never ran": with zero sessions
    /// stored nothing was measured, which is a different statement from "nothing ran" — and reporting
    /// the second when the first is true would call a healthy graph entirely dead.
    pub fn session_count(&self) -> rusqlite::Result<i64> {
        self.conn.query_row("SELECT COUNT(DISTINCT session) FROM attestations", [], |r| r.get(0))
    }

    /// Every record id that has an attestation of any kind — the "was seen at all" set.
    pub fn seen_record_ids(&self) -> rusqlite::Result<Vec<String>> {
        let mut stmt =
            self.conn.prepare("SELECT DISTINCT record_id FROM attestations WHERE record_id <> '' ORDER BY record_id")?;
        let ids = stmt.query_map([], |r| r.get(0))?.collect();
        ids
    }

    /// Delete rows older than `before_ms`, returning how many went. The store is unbounded otherwise:
    /// one row per module per version per outcome per session accumulates slowly but forever.
    pub fn prune_before(&self, before_ms: i64) -> rusqlite::Result<usize> {
        self.conn.execute("DELETE FROM attestations WHERE last_at < ?1", params![before_ms])
    }
}

/// The column list `row_to_attestation` decodes, in one place so the SELECTs can't drift from the mapper.
const COLS: &str =
    "specifier, record_id, src_hash, outcome, session, n, reason, ms_total, ms_max, first_at, last_at";

fn row_to_attestation(r: &rusqlite::Row) -> rusqlite::Result<Attestation> {
    Ok(Attestation {
        specifier: r.get(0)?,
        record_id: r.get(1)?,
        src_hash: r.get(2)?,
        outcome: r.get(3)?,
        session: r.get(4)?,
        n: r.get(5)?,
        reason: r.get(6)?,
        ms_total: r.get(7)?,
        ms_max: r.get(8)?,
        first_at: r.get(9)?,
        last_at: r.get(10)?,
    })
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/doctor.rs, src/hash.rs, src/schema.rs, src/tests.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-runtime--<module>.rs
//     bsc graph impl set --id bsc-runtime--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-runtime--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-runtime--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));