//! Read-only access to the performance-metrics DB (`perf.db`) for `bsc-logs perf` (#1716).
//!
//! Unlike the append-only TSV streams (`cost` parses transcripts, the rest are flat logs), the
//! perf sampler (`src-tauri/src/observability/perf.rs`) persists a binary SQLite time-series:
//! the `perf_samples` table — `ts` (epoch ms), `session_id`, `pid`, `rss_bytes`, `cpu_pct`,
//! `threads`. A live session can drill into its own (or any pane's) resource history from its own
//! shell. Strictly read-only: opened with `SQLITE_OPEN_READ_ONLY`, no schema creation, missing DB
//! ⇒ empty (so a fresh install before the first sample is a clean no-op, not an error).

use std::path::Path;

use rusqlite::{Connection, OpenFlags};

/// One persisted performance sample, mirroring the `perf_samples` row. `session_id` encodes the
/// source: a pane id (`"t0p1"`) for a per-agent shell, or the synthetic `"app"` / `"system"` /
/// `"frontend"` rows the sampler also writes.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PerfSample {
    /// Epoch milliseconds.
    pub ts: i64,
    pub session: String,
    pub pid: Option<i64>,
    pub rss_bytes: Option<i64>,
    pub cpu_pct: Option<f64>,
    pub threads: Option<i64>,
}

/// Read recent samples from `perf.db`, filtered by `session` (exact `session_id` match) and
/// `since_ms`, keeping the newest `limit` and returning them ascending by time (so the lean TSV
/// reads oldest→newest like the other verbs). A missing/unopenable DB yields an empty vec rather
/// than an error — read-only, best-effort, never mutating.
pub fn perf_samples(
    db_path: &Path,
    session: Option<&str>,
    since_ms: Option<i64>,
    limit: Option<usize>,
) -> Vec<PerfSample> {
    if !db_path.exists() {
        return vec![];
    }
    let conn = match Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    // Build the filter dynamically; bind every value so nothing is interpolated into the SQL text.
    let mut sql =
        String::from("SELECT ts, session_id, pid, rss_bytes, cpu_pct, threads FROM perf_samples WHERE 1=1");
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(s) = session {
        sql.push_str(" AND session_id = ?");
        params.push(Box::new(s.to_string()));
    }
    if let Some(since) = since_ms {
        sql.push_str(" AND ts >= ?");
        params.push(Box::new(since));
    }
    // Newest first so LIMIT keeps the most recent N; reversed below to ascending.
    sql.push_str(" ORDER BY ts DESC, id DESC");
    if let Some(n) = limit {
        sql.push_str(" LIMIT ?");
        params.push(Box::new(n as i64));
    }

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |r| {
        Ok(PerfSample {
            ts: r.get(0)?,
            session: r.get(1)?,
            pid: r.get(2)?,
            rss_bytes: r.get(3)?,
            cpu_pct: r.get(4)?,
            threads: r.get(5)?,
        })
    });
    let mut out: Vec<PerfSample> = match rows {
        Ok(it) => it.filter_map(Result::ok).collect(),
        Err(_) => return vec![],
    };
    out.reverse(); // DESC (newest-first) → ascending for display
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_db() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        std::env::temp_dir().join(format!(
            "bsc-logs-perf-{}-{}.db",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ))
    }

    /// Create the same schema the sampler writes and seed rows.
    fn seed(path: &Path, rows: &[(i64, &str, i64, f64)]) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS perf_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL, session_id TEXT NOT NULL,
                pid INTEGER, rss_bytes INTEGER, cpu_pct REAL, threads INTEGER);",
        )
        .unwrap();
        for (ts, sid, rss, cpu) in rows {
            conn.execute(
                "INSERT INTO perf_samples (ts, session_id, pid, rss_bytes, cpu_pct, threads) VALUES (?1,?2,?3,?4,?5,?6)",
                rusqlite::params![ts, sid, 1234_i64, rss, cpu, 8_i64],
            )
            .unwrap();
        }
    }

    #[test]
    fn missing_db_is_empty_not_an_error() {
        let p = tmp_db();
        let _ = std::fs::remove_file(&p);
        assert!(perf_samples(&p, None, None, None).is_empty());
    }

    #[test]
    fn reads_filters_by_session_since_limit_ascending() {
        let p = tmp_db();
        let _ = std::fs::remove_file(&p);
        seed(
            &p,
            &[
                (1000, "t0p1", 100, 1.0),
                (2000, "t0p2", 200, 2.0),
                (3000, "t0p1", 300, 3.0),
                (4000, "t0p1", 400, 4.0),
            ],
        );

        // No filter → every row, ascending by ts.
        let all = perf_samples(&p, None, None, None);
        assert_eq!(all.len(), 4);
        assert!(all.windows(2).all(|w| w[0].ts <= w[1].ts), "ascending by ts");

        // Session filter selects only that pane's rows.
        let p1 = perf_samples(&p, Some("t0p1"), None, None);
        assert_eq!(p1.len(), 3);
        assert!(p1.iter().all(|s| s.session == "t0p1"));
        assert_eq!(p1[0].rss_bytes, Some(100));

        // `since` drops anything older.
        let since = perf_samples(&p, Some("t0p1"), Some(2500), None);
        assert_eq!(since.iter().map(|s| s.ts).collect::<Vec<_>>(), vec![3000, 4000]);

        // `limit` keeps the NEWEST N, still ascending.
        let lim = perf_samples(&p, Some("t0p1"), None, Some(1));
        assert_eq!(lim.len(), 1);
        assert_eq!(lim[0].ts, 4000);
        assert!((lim[0].cpu_pct.unwrap() - 4.0).abs() < 1e-9);

        let _ = std::fs::remove_file(&p);
    }
}
