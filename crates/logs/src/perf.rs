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

/// RSS growth for one session over a window: the first and last RSS-bearing sample, the delta, and
/// the implied rate. `None` when fewer than two such samples exist in the window — a single point
/// has no rate, and reporting a fabricated zero would read as "not growing" rather than "not enough
/// data yet" (#request-159: this replaces a hand-rolled `sleep`+`sqlite3` polling loop someone wrote
/// to answer exactly this while chasing a webview memory leak).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PerfGrowth {
    pub session: String,
    /// How many RSS-bearing samples the window held (more than 2 = a real trend line collapsed to
    /// its endpoints, not just two lonely points).
    pub n: usize,
    pub from_ts: i64,
    pub to_ts: i64,
    pub from_bytes: i64,
    pub to_bytes: i64,
    pub delta_bytes: i64,
    pub duration_secs: f64,
    pub bytes_per_sec: f64,
    pub mb_per_min: f64,
}

/// Compute [`PerfGrowth`] for `session` from the samples in `perf_samples(db_path, Some(session),
/// since_ms, None)`. Uses the first and last RSS-bearing sample rather than fitting a line through
/// every point — the endpoints are what "is it growing, and how fast" actually asks, and a two-point
/// rate is honest about being exactly that instead of dressing itself up as a regression.
pub fn perf_growth(db_path: &Path, session: &str, since_ms: Option<i64>) -> Option<PerfGrowth> {
    let samples = perf_samples(db_path, Some(session), since_ms, None);
    let with_rss: Vec<&PerfSample> = samples.iter().filter(|s| s.rss_bytes.is_some()).collect();
    if with_rss.len() < 2 {
        return None;
    }
    let first = with_rss[0];
    let last = with_rss[with_rss.len() - 1];
    let from_bytes = first.rss_bytes.expect("filtered to Some above");
    let to_bytes = last.rss_bytes.expect("filtered to Some above");
    let duration_secs = (last.ts - first.ts) as f64 / 1000.0;
    if duration_secs <= 0.0 {
        // Every sample landed at the same timestamp (or ts went backwards) — no time span to derive
        // a rate from, so this is the same "not enough data" case as fewer than two samples.
        return None;
    }
    let delta_bytes = to_bytes - from_bytes;
    let bytes_per_sec = delta_bytes as f64 / duration_secs;
    Some(PerfGrowth {
        session: session.to_string(),
        n: with_rss.len(),
        from_ts: first.ts,
        to_ts: last.ts,
        from_bytes,
        to_bytes,
        delta_bytes,
        duration_secs,
        bytes_per_sec,
        mb_per_min: bytes_per_sec * 60.0 / 1_048_576.0,
    })
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

    #[test]
    fn growth_reports_delta_and_rate_between_first_and_last_rss_sample() {
        let p = tmp_db();
        let _ = std::fs::remove_file(&p);
        // 3320MB -> 4580MB over 160s, the shape of the real webview leak this verb was written for.
        seed(
            &p,
            &[
                (0, "app:webview", 3320 * 1_048_576, 1.0),
                (80_000, "app:webview", 3950 * 1_048_576, 1.0),
                (160_000, "app:webview", 4580 * 1_048_576, 1.0),
            ],
        );
        let g = perf_growth(&p, "app:webview", None).unwrap();
        assert_eq!(g.n, 3);
        assert_eq!(g.from_ts, 0);
        assert_eq!(g.to_ts, 160_000);
        assert_eq!(g.delta_bytes, 1260 * 1_048_576);
        assert!((g.duration_secs - 160.0).abs() < 1e-9);
        // ~1260MB / (160s/60) minutes ≈ 472.5 MB/min.
        assert!((g.mb_per_min - 472.5).abs() < 0.1, "got {}", g.mb_per_min);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn growth_is_none_for_a_missing_or_single_sample_session() {
        let p = tmp_db();
        let _ = std::fs::remove_file(&p);
        seed(&p, &[(0, "app:webview", 1000, 1.0)]);
        assert!(perf_growth(&p, "app:webview", None).is_none(), "one sample has no rate");
        assert!(perf_growth(&p, "does-not-exist", None).is_none(), "no samples at all");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn growth_ignores_other_sessions_and_null_rss_samples() {
        let p = tmp_db();
        let _ = std::fs::remove_file(&p);
        seed(
            &p,
            &[
                (0, "app:webview", 1_048_576, 1.0),
                (1000, "t0p1", 999_999_999, 1.0), // a different session — must not leak in
                (60_000, "app:webview", 2 * 1_048_576, 1.0),
            ],
        );
        let g = perf_growth(&p, "app:webview", None).unwrap();
        assert_eq!(g.n, 2);
        assert_eq!(g.delta_bytes, 1_048_576);
        assert!((g.mb_per_min - 1.0).abs() < 1e-9);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn growth_honors_since_ms_to_scope_the_window() {
        let p = tmp_db();
        let _ = std::fs::remove_file(&p);
        seed(
            &p,
            &[
                (0, "app:webview", 100 * 1_048_576, 1.0),
                (60_000, "app:webview", 200 * 1_048_576, 1.0),
                (120_000, "app:webview", 400 * 1_048_576, 1.0),
            ],
        );
        // Scoped to the last two samples: 200 -> 400 over 60s.
        let g = perf_growth(&p, "app:webview", Some(60_000)).unwrap();
        assert_eq!(g.n, 2);
        assert_eq!(g.from_bytes, 200 * 1_048_576);
        assert_eq!(g.to_bytes, 400 * 1_048_576);
        let _ = std::fs::remove_file(&p);
    }
}
