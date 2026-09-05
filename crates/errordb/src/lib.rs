//! Per-project runtime-fault store (#2258/#2260) — the fingerprinted sink every runtime producer
//! writes to and `bsc errors` reads. One SQLite db per project hub (`projects/<key>/error.db`), scoped
//! at a live session by `$BSC_ERROR_DB` exactly as plan.db is by `$BSC_PLAN_DB`. The db *is* the
//! attribution: one store per project.
//!
//! Tauri-free on purpose (like `plandb`/`skilldb`): the desktop app (the slice-2 collector) and the
//! `bsc errors` agent CLI both depend on it, so the CLI stays a tiny binary.
//!
//! ## Model
//! A **fault** is one row per [`fingerprint`] (a stable, stage-aware signature) carrying the occurrence
//! `count` + first/last seen + a representative sample — the Sentry "issue" shape, so runtime volume
//! stays bounded no matter how often the same fault fires. Individual occurrences land in `events`,
//! capped per fingerprint. `stage` is `runtime` for every fault today; the column is the taxonomy seam
//! for later producers (see #2258) — this crate does not build the other stages.


use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

/// The severity levels a fault carries, low → high. A re-record keeps the highest level seen.
pub const LEVELS: [&str; 3] = ["warn", "error", "fatal"];
/// The lifecycle-stage taxonomy (#2258) — every stage a producer actually writes.
///
/// It is a CLOSED list because `is_valid_stage` gates the CLI's `add`, and it went stale the moment a
/// producer wrote around it: the supply-chain hook (#4008) records `stage: "supply"` straight through
/// [`Store::record`], which no validator sees. The result was a taxonomy the store's own contents did
/// not satisfy — `bsc errors list --stage supply` documented and working while `bsc errors add --stage
/// supply` was refused as invalid. A list that lies about what the store holds is worse than no list,
/// so a new producer belongs HERE, in the same change that starts writing its stage.
///
/// `launch` is the app-START stage (the-app-starts-and-never-mounts-and-nothing-says-so), deliberately
/// distinct from `runtime`: a fault at launch means the app never got far enough to HAVE a runtime, and
/// that difference is the whole reason an internal session cannot answer one.
pub const STAGES: [&str; 11] = [
    "install", "compile", "typecheck", "lint", "test", "build", "package", "deploy", "launch",
    "runtime", "supply",
];
pub const DEFAULT_STAGE: &str = "runtime";
pub const DEFAULT_LEVEL: &str = "error";
/// At most this many `events` rows are kept per fingerprint (older occurrences are pruned on insert),
/// so a fault that fires a million times costs one `faults` row + a bounded event sample.
const EVENTS_PER_FAULT_CAP: i64 = 20;

pub fn is_valid_level(l: &str) -> bool {
    LEVELS.contains(&l)
}
pub fn is_valid_stage(s: &str) -> bool {
    STAGES.contains(&s)
}

/// Severity rank for keeping the highest level when a fault re-records (`fatal` > `error` > `warn`).
fn level_rank(l: &str) -> i64 {
    match l {
        "fatal" => 3,
        "error" => 2,
        "warn" => 1,
        _ => 0,
    }
}

/// One fingerprinted fault — the aggregate row `bsc errors list`/`get` returns.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Fault {
    pub fingerprint: String,
    pub stage: String,
    pub level: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_stack: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release: Option<String>,
    pub count: i64,
    pub first_seen: i64,
    pub last_seen: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<i64>,
}

/// The write shape for recording one fault occurrence (the collector/producer builds this; the CLI
/// builds it from args). `stage`/`level` fall back to the defaults when empty.
#[derive(Debug, Clone, Default)]
pub struct FaultInput {
    pub stage: String,
    pub level: String,
    pub title: String,
    pub stack: Option<String>,
    pub source_hint: Option<String>,
    pub release: Option<String>,
    pub context: Option<String>,
    pub ts: i64,
}

/// Filters for [`Store::list`]. All-`None`/false lists every fault, newest-seen first.
#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub stage: Option<String>,
    pub unresolved: bool,
    /// Only faults whose `last_seen >= since` (the resume-delta read the slice-6 loop polls with).
    pub since: Option<i64>,
    pub limit: Option<i64>,
}

/// Deterministic, dependency-free fault fingerprint — the dedup key **shared** by the CLI and the
/// (slice-2) collector, so both compute the SAME id for the same fault (like the project-link id).
/// FNV-1a over a normalized signature `stage \n title \n first-stack-frame`, with volatile bits in the
/// frame (addresses, line/column numbers → runs of digits) masked, so the same fault at a shifted line
/// still collapses. Best-effort by design: a good-enough grouping, not a semantic stack analysis.
pub fn fingerprint(stage: &str, title: &str, stack: Option<&str>) -> String {
    let frame = stack
        .and_then(|s| s.lines().map(str::trim).find(|l| !l.is_empty()))
        .map(normalize_frame)
        .unwrap_or_default();
    let title_norm = title.split_whitespace().collect::<Vec<_>>().join(" ");
    fnv1a_hex(&format!("{stage}\n{title_norm}\n{frame}"))
}

/// Collapse every run of ASCII digits to a single `#` so line/column numbers and (most of) an address
/// don't fork the fingerprint of the same fault across runs.
fn normalize_frame(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut prev_digit = false;
    for c in line.chars() {
        if c.is_ascii_digit() {
            if !prev_digit {
                out.push('#');
            }
            prev_digit = true;
        } else {
            out.push(c);
            prev_digit = false;
        }
    }
    out
}

/// FNV-1a 64-bit → 16 lowercase hex chars. Deterministic across processes/platforms (unlike
/// `DefaultHasher`), which the shared fingerprint requires.
fn fnv1a_hex(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// The per-project fault store — a thin owner of the SQLite connection plus the fault upsert/read.
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open (creating + migrating) the error.db at `path`. Parent dirs are created. WAL + busy_timeout
    /// are set so the desktop app and the `bsc errors` CLI can share the db without a SQLITE_BUSY race.
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        Ok(Store { conn: bsc_sqlite_util::open_migrated(path, schema::migrate)? })
    }

    /// An ephemeral in-memory store — for tests.
    pub fn open_in_memory() -> rusqlite::Result<Store> {
        Ok(Store { conn: bsc_sqlite_util::open_in_memory_migrated(schema::migrate)? })
    }

    /// Empty the whole store (every fault + event) — see [`bsc_sqlite_util::clear_tables`] for why
    /// it truncates.
    pub fn clear(&self) -> rusqlite::Result<()> {
        bsc_sqlite_util::clear_tables(&self.conn, schema::ALL_TABLES)
    }

    /// Record one occurrence. The first sighting seeds the fault (`count = 1`, `first_seen`); a repeat
    /// bumps `count` + `last_seen`, keeps the highest `level`, refreshes the sample stack/source/release
    /// when the new occurrence supplies them, and **re-opens** a previously-resolved fault (it fired
    /// again — it isn't fixed). Also appends a capped `events` row. Returns the resulting fault.
    pub fn record(&self, input: &FaultInput) -> rusqlite::Result<Fault> {
        let stage = if input.stage.is_empty() { DEFAULT_STAGE } else { input.stage.as_str() };
        let level = if input.level.is_empty() { DEFAULT_LEVEL } else { input.level.as_str() };
        let fp = fingerprint(stage, &input.title, input.stack.as_deref());
        let ts = input.ts;
        self.conn.execute(
            "INSERT INTO faults
                (fingerprint, stage, level, title, sample_stack, source_hint, release, count, first_seen, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)
             ON CONFLICT(fingerprint) DO UPDATE SET
                count        = count + 1,
                last_seen    = excluded.last_seen,
                level        = CASE WHEN ?9 > (CASE level WHEN 'fatal' THEN 3 WHEN 'error' THEN 2 WHEN 'warn' THEN 1 ELSE 0 END)
                                    THEN excluded.level ELSE level END,
                sample_stack = COALESCE(excluded.sample_stack, sample_stack),
                source_hint  = COALESCE(excluded.source_hint, source_hint),
                release      = COALESCE(excluded.release, release),
                resolved_at  = NULL",
            params![fp, stage, level, input.title, input.stack, input.source_hint, input.release, ts, level_rank(level)],
        )?;
        self.conn.execute(
            "INSERT INTO events (fingerprint, ts, context) VALUES (?1, ?2, ?3)",
            params![fp, ts, input.context],
        )?;
        // Prune to the per-fingerprint cap (keep the most-recent by insertion id).
        self.conn.execute(
            "DELETE FROM events WHERE fingerprint = ?1 AND id NOT IN
                (SELECT id FROM events WHERE fingerprint = ?1 ORDER BY id DESC LIMIT ?2)",
            params![fp, EVENTS_PER_FAULT_CAP],
        )?;
        Ok(self.get(&fp)?.expect("fault exists after upsert"))
    }

    /// One fault by fingerprint, or None.
    pub fn get(&self, fingerprint: &str) -> rusqlite::Result<Option<Fault>> {
        self.conn
            .query_row(&format!("SELECT {COLS} FROM faults WHERE fingerprint = ?1"), params![fingerprint], row_to_fault)
            .optional()
    }

    /// The fault table under `filter`, newest-seen first.
    pub fn list(&self, filter: &Filter) -> rusqlite::Result<Vec<Fault>> {
        let mut sql = format!("SELECT {COLS} FROM faults");
        let mut clauses: Vec<String> = Vec::new();
        let mut vals: Vec<Value> = Vec::new();
        if let Some(s) = &filter.stage {
            vals.push(Value::Text(s.clone()));
            clauses.push(format!("stage = ?{}", vals.len()));
        }
        if filter.unresolved {
            clauses.push("resolved_at IS NULL".into());
        }
        if let Some(since) = filter.since {
            vals.push(Value::Integer(since));
            clauses.push(format!("last_seen >= ?{}", vals.len()));
        }
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY last_seen DESC, fingerprint");
        if let Some(n) = filter.limit {
            sql.push_str(&format!(" LIMIT {}", n.max(0)));
        }
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(vals), row_to_fault)?;
        rows.collect()
    }

    /// Mark a fault resolved (stamps `resolved_at`). Returns whether an *unresolved* fault matched, so
    /// resolving an unknown/already-resolved fingerprint is a reported no-op.
    pub fn resolve(&self, fingerprint: &str, ts: i64) -> rusqlite::Result<bool> {
        let n = self.conn.execute(
            "UPDATE faults SET resolved_at = ?2 WHERE fingerprint = ?1 AND resolved_at IS NULL",
            params![fingerprint, ts],
        )?;
        Ok(n > 0)
    }

    /// Resolve every unresolved fault at `stage` that `source` recorded, returning how many moved.
    ///
    /// This is what keeps a build-stage store from becoming a pile of already-fixed faults. A producer
    /// that only ever RECORDS leaves its first failure standing after the fix lands, and a reader then
    /// cannot tell a live break from a repaired one — which this repo has already shipped once, in
    /// `a-preview-that-renders-never-clears-the-error-it-once-had`, where the doctor kept reporting
    /// failures that were already fixed.
    ///
    /// Keyed on (stage, source) rather than fingerprint deliberately: the caller that clears is a
    /// command that just SUCCEEDED, and it cannot know which fingerprints its earlier failure produced
    /// — only that whatever it recorded is no longer true. `source_hint` is the producer's identity for
    /// exactly this reason, and it is NOT part of the fingerprint, so keying on it cannot affect dedup.
    ///
    /// A fault some other source recorded is untouched, so one producer clearing its own can never
    /// resolve another's.
    pub fn resolve_by_source(&self, stage: &str, source: &str, ts: i64) -> rusqlite::Result<usize> {
        let n = self.conn.execute(
            "UPDATE faults SET resolved_at = ?3
               WHERE stage = ?1 AND source_hint = ?2 AND resolved_at IS NULL",
            params![stage, source, ts],
        )?;
        Ok(n)
    }

    /// The recorded RUNS — what each wrapped command cost, newest first.
    ///
    /// The typed read `bsc mem build` is built on. It lives here rather than in that crate because this
    /// crate owns the schema: a reader elsewhere would be raw SQL against another crate's table, free to
    /// drift from it silently the next time a column moves.
    ///
    /// `ms` and `peak_rss_bytes` stay `Option` all the way out. A measurement that could not be taken
    /// must read as ABSENT at every layer — the moment one of these becomes a `0` on the way to a
    /// caller, it enters a median as a build that took no time and used no memory.
    pub fn runs(&self, filter: &RunFilter) -> rusqlite::Result<Vec<RunRow>> {
        let mut sql = String::from(
            "SELECT ts, stage, source, cmd, ok, exit_code, ms, peak_rss_bytes FROM runs WHERE 1=1",
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(stage) = &filter.stage {
            sql.push_str(&format!(" AND stage = ?{}", args.len() + 1));
            args.push(Box::new(stage.clone()));
        }
        if let Some(source) = &filter.source {
            sql.push_str(&format!(" AND source = ?{}", args.len() + 1));
            args.push(Box::new(source.clone()));
        }
        if let Some(since) = filter.since {
            sql.push_str(&format!(" AND ts >= ?{}", args.len() + 1));
            args.push(Box::new(since));
        }
        // Newest first, and `id` breaks a tie rather than leaving the order to the query planner — two
        // runs can share a millisecond, and an unstable order makes "the latest run" a coin flip.
        sql.push_str(" ORDER BY ts DESC, id DESC");
        if let Some(limit) = filter.limit {
            sql.push_str(&format!(" LIMIT {limit}"));
        }
        let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |r| {
            Ok(RunRow {
                ts: r.get(0)?,
                stage: r.get(1)?,
                source: r.get(2)?,
                cmd: r.get(3)?,
                ok: r.get::<_, i64>(4)? != 0,
                exit_code: r.get(5)?,
                ms: r.get(6)?,
                peak_rss_bytes: r.get(7)?,
            })
        })?;
        rows.collect()
    }
}

/// One recorded run — the cost half of `bsc errors run`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub ts: i64,
    pub stage: String,
    pub source: String,
    pub cmd: String,
    pub ok: bool,
    pub exit_code: i64,
    /// Wall clock. `None` when it could not be taken — never `0`.
    pub ms: Option<i64>,
    /// Peak of the summed RSS of the child's process tree. `None` when unobserved — never `0`.
    pub peak_rss_bytes: Option<i64>,
}

/// Which runs to read. Every field absent means every run.
#[derive(Debug, Clone, Default)]
pub struct RunFilter {
    pub stage: Option<String>,
    pub source: Option<String>,
    pub since: Option<i64>,
    pub limit: Option<i64>,
}

/// The column list `row_to_fault` decodes, kept in one place so the SELECTs can't drift from the mapper.
const COLS: &str =
    "fingerprint, stage, level, title, sample_stack, source_hint, release, count, first_seen, last_seen, resolved_at";

fn row_to_fault(r: &rusqlite::Row) -> rusqlite::Result<Fault> {
    Ok(Fault {
        fingerprint: r.get(0)?,
        stage: r.get(1)?,
        level: r.get(2)?,
        title: r.get(3)?,
        sample_stack: r.get(4)?,
        source_hint: r.get(5)?,
        release: r.get(6)?,
        count: r.get(7)?,
        first_seen: r.get(8)?,
        last_seen: r.get(9)?,
        resolved_at: r.get(10)?,
    })
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/detect.rs, src/run.rs, src/run_reader_tests.rs, src/schema.rs, src/tests.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get errordb--<module>.rs
//     bsc graph impl set --id errordb--<module>.rs --code-file <f>
//     bsc graph promote --id errordb--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `errordb--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));