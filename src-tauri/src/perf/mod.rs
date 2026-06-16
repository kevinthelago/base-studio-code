/// Performance monitoring: per-agent process sampling, SQLite time-series persistence,
/// and log rotation.
///
/// Sampling is cheap — only the tracked shell PIDs (one per live agent) plus the app
/// process itself are refreshed per tick. No full system process walk at 20+ agents.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::Manager;

// ── Config ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfConfig {
    pub enabled: bool,
    /// Sampling cadence in seconds. 0 means collection is off.
    pub interval_secs: u32,
    /// Delete samples older than this many hours. 0 = keep forever.
    pub retention_hours: u32,
    /// Prune SQLite DB if it exceeds this many MB. 0 = no size cap.
    pub max_db_mb: u32,
    /// Track per-agent process metrics (RSS, CPU, threads).
    pub track_process: bool,
    /// Persist frontend metrics emitted by `perf.ts` (heap, jank, PTY).
    pub track_frontend: bool,
}

impl Default for PerfConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_secs: 2,
            retention_hours: 24,
            max_db_mb: 50,
            track_process: true,
            track_frontend: true,
        }
    }
}

// ── Sample ────────────────────────────────────────────────────────────────────

/// One performance observation row.
///
/// `session_id` encodes the source:
/// - pane_id (e.g. `"t0p1"`) — per-agent shell process
/// - `"app"` — the Tauri desktop process itself
/// - `"system"` — system-wide totals (RSS = used RAM, cpu_pct = global %)
/// - `"frontend"` — WebView metrics (RSS = heap bytes, cpu_pct = jank count,
///   threads = PTY event count)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfSample {
    pub ts: i64,
    pub session_id: String,
    pub pid: Option<u32>,
    pub rss_bytes: Option<u64>,
    pub cpu_pct: Option<f32>,
    pub threads: Option<u32>,
}

// ── Inner state ───────────────────────────────────────────────────────────────

/// In-memory ring buffer cap.
const RING_CAP: usize = 2000;
/// Apply retention pruning every N ingests (not every tick — a DELETE per tick is wasteful).
const RETENTION_EVERY: u64 = 100;
/// Text logs longer than this are truncated to their newest N lines.
pub const LOG_MAX_LINES: usize = 10_000;

struct PerfInner {
    config: PerfConfig,
    /// session_id → shell PID for each live agent pane.
    tracked: HashMap<String, u32>,
    /// In-memory ring buffer for the live UI.
    ring: Vec<PerfSample>,
    db: Option<Connection>,
    /// Persistent `System` so CPU delta accumulates across ticks (first tick = 0 %).
    sys: System,
    ingest_count: u64,
}

// ── Public state ──────────────────────────────────────────────────────────────

// PerfInner is intentionally crate-private (opaque Tauri-managed state); the field is pub so
// command handlers can lock it. (#744 — silence private_interfaces, don't leak the type.)
#[allow(private_interfaces)]
pub struct PerfState(pub Mutex<PerfInner>);

impl PerfState {
    pub fn new(db_path: PathBuf) -> Self {
        let db = open_db(&db_path)
            .map_err(|e| log::warn!("perf: cannot open DB {}: {e}", db_path.display()))
            .ok();
        Self(Mutex::new(PerfInner {
            config: PerfConfig::default(),
            tracked: HashMap::new(),
            ring: Vec::with_capacity(RING_CAP),
            db,
            sys: System::new(),
            ingest_count: 0,
        }))
    }

    /// Called by `pty_create` after spawning the shell.
    pub fn register(&self, session_id: &str, pid: u32) {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        g.tracked.insert(session_id.to_string(), pid);
    }

    /// Called by `pty_kill` when the pane is torn down.
    pub fn unregister(&self, session_id: &str) {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        g.tracked.remove(session_id);
    }
}

// ── SQLite ────────────────────────────────────────────────────────────────────

fn open_db(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS perf_samples (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            ts         INTEGER NOT NULL,
            session_id TEXT    NOT NULL,
            pid        INTEGER,
            rss_bytes  INTEGER,
            cpu_pct    REAL,
            threads    INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_perf_ts ON perf_samples(ts);",
    )?;
    Ok(conn)
}

// ── Sampler ───────────────────────────────────────────────────────────────────

/// Collect one round of metrics and persist them. Called from the background task.
pub fn tick(state: &PerfState) {
    let mut g = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if !g.config.enabled { return; }

    let now = now_ms();
    let own_pid = std::process::id();

    // Build the PID list without holding a reference into `g.tracked`.
    let tracked: Vec<(String, u32)> = g.tracked.iter().map(|(k, &v)| (k.clone(), v)).collect();
    let mut pids: Vec<Pid> = tracked.iter().map(|(_, p)| Pid::from(*p as usize)).collect();
    pids.push(Pid::from(own_pid as usize));

    // Refresh only the PIDs we care about — no full process walk.
    if g.config.track_process {
        g.sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true, // remove_dead_processes (sysinfo 0.33+): a since-exited PID drops out, so
                  // process() returns None for it rather than stale memory/CPU.
            ProcessRefreshKind::nothing().with_memory().with_cpu(),
        );
    }
    g.sys.refresh_memory();
    g.sys.refresh_cpu_usage();

    let mut samples: Vec<PerfSample> = Vec::new();

    if g.config.track_process {
        // Per-agent process samples.
        for (sid, pid) in &tracked {
            let proc = g.sys.process(Pid::from(*pid as usize));
            samples.push(PerfSample {
                ts: now,
                session_id: sid.clone(),
                pid: Some(*pid),
                rss_bytes: proc.map(|p| p.memory()),
                cpu_pct: proc.map(|p| p.cpu_usage()),
                threads: proc.and_then(|p| p.tasks()).map(|t| t.len() as u32),
            });
        }

        // App process (the Tauri desktop host itself).
        let proc = g.sys.process(Pid::from(own_pid as usize));
        samples.push(PerfSample {
            ts: now,
            session_id: "app".to_string(),
            pid: Some(own_pid),
            rss_bytes: proc.map(|p| p.memory()),
            cpu_pct: proc.map(|p| p.cpu_usage()),
            threads: proc.and_then(|p| p.tasks()).map(|t| t.len() as u32),
        });
    }

    // System-wide totals (always — cheap, no per-process work).
    samples.push(PerfSample {
        ts: now,
        session_id: "system".to_string(),
        pid: None,
        rss_bytes: Some(g.sys.used_memory()),
        cpu_pct: Some(g.sys.global_cpu_usage()),
        threads: None,
    });

    ingest(&mut g, samples);
}

fn ingest(g: &mut PerfInner, samples: Vec<PerfSample>) {
    // Push to ring, evicting the oldest entry when full.
    for s in &samples {
        if g.ring.len() >= RING_CAP {
            g.ring.remove(0);
        }
        g.ring.push(s.clone());
    }

    // Flush to SQLite.
    if let Some(conn) = &g.db {
        for s in &samples {
            let _ = conn.execute(
                "INSERT INTO perf_samples (ts, session_id, pid, rss_bytes, cpu_pct, threads) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    s.ts,
                    s.session_id,
                    s.pid.map(|p| p as i64),
                    s.rss_bytes.map(|b| b as i64),
                    s.cpu_pct,
                    s.threads.map(|t| t as i64),
                ],
            );
        }
    }

    g.ingest_count += 1;
    if g.ingest_count.is_multiple_of(RETENTION_EVERY) {
        apply_retention(g);
    }
}

fn apply_retention(g: &mut PerfInner) {
    if g.config.retention_hours == 0 { return; }
    let cutoff = now_ms() - g.config.retention_hours as i64 * 3_600_000;
    if let Some(conn) = &g.db {
        let _ = conn.execute("DELETE FROM perf_samples WHERE ts < ?1", params![cutoff]);
    }
    g.ring.retain(|s| s.ts >= cutoff);
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Log capping ───────────────────────────────────────────────────────────────

/// Truncate `path` to its most recent `LOG_MAX_LINES` lines, in-place.
/// Silently no-ops if the file doesn't exist or is already short enough.
pub fn cap_log(path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= LOG_MAX_LINES { return; }
    let tail = lines[lines.len() - LOG_MAX_LINES..].join("\n") + "\n";
    if std::fs::write(path, tail.as_bytes()).is_ok() {
        log::info!("perf: capped {} to {} lines", path.display(), LOG_MAX_LINES);
    }
}

/// Cap the four known unbounded log files under `base_dir`.
pub fn cap_logs(base_dir: &Path) {
    for name in ["audit.log", "coord.log", "skills.log", "tokens.log"] {
        let p = base_dir.join(name);
        if p.exists() { cap_log(&p); }
    }
}

// ── Background sampler task ───────────────────────────────────────────────────

/// Spawned as a Tokio task from `run()`. Ticks at 1-second granularity so it
/// can react to config changes promptly without restart logic; the actual sample
/// cadence is controlled by `interval_secs`.
pub async fn run_sampler(app: tauri::AppHandle) {
    let mut ticker = tokio::time::interval(tokio::time::Duration::from_secs(1));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last = std::time::Instant::now();
    loop {
        ticker.tick().await;
        let perf = app.state::<PerfState>();
        let (enabled, interval_secs) = {
            let g = perf.0.lock().unwrap_or_else(|e| e.into_inner());
            (g.config.enabled, g.config.interval_secs)
        };
        if !enabled || interval_secs == 0 { continue; }
        if last.elapsed().as_secs() < interval_secs as u64 { continue; }
        last = std::time::Instant::now();
        tick(&perf);
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn perf_get_config(state: tauri::State<PerfState>) -> PerfConfig {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).config.clone()
}

#[tauri::command]
pub fn perf_set_config(
    enabled: bool,
    interval_secs: u32,
    retention_hours: u32,
    max_db_mb: u32,
    track_process: bool,
    track_frontend: bool,
    state: tauri::State<PerfState>,
) {
    let mut g = state.0.lock().unwrap_or_else(|e| e.into_inner());
    g.config = PerfConfig { enabled, interval_secs, retention_hours, max_db_mb, track_process, track_frontend };
}

/// Record one flush of WebView-side metrics from `src/lib/perf.ts`.
///
/// Column mapping for the `"frontend"` row: `rss_bytes` = heap bytes,
/// `cpu_pct` = jank event count, `threads` = PTY event count.
#[tauri::command]
pub fn perf_record_frontend_sample(
    heap_used_mb: Option<u32>,
    jank_count: u32,
    jank_total_ms: f32,
    pty_events: u32,
    pty_bytes: u64,
    state: tauri::State<PerfState>,
) {
    let _ = jank_total_ms;
    let _ = pty_bytes;
    {
        let g = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if !g.config.enabled || !g.config.track_frontend { return; }
    }
    let s = PerfSample {
        ts: now_ms(),
        session_id: "frontend".to_string(),
        pid: None,
        rss_bytes: heap_used_mb.map(|mb| mb as u64 * 1_048_576),
        cpu_pct: Some(jank_count as f32),
        threads: Some(pty_events),
    };
    let mut g = state.0.lock().unwrap_or_else(|e| e.into_inner());
    ingest(&mut g, vec![s]);
}

#[tauri::command]
pub fn perf_clear_history(state: tauri::State<PerfState>) -> Result<(), String> {
    let mut g = state.0.lock().unwrap_or_else(|e| e.into_inner());
    g.ring.clear();
    if let Some(conn) = &g.db {
        conn.execute("DELETE FROM perf_samples", []).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn perf_get_recent_samples(limit: usize, state: tauri::State<PerfState>) -> Vec<PerfSample> {
    let g = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let n = g.ring.len().min(limit);
    g.ring[g.ring.len() - n..].to_vec()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db_path() -> PathBuf {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("perf-test-{pid}-{nanos}.db"))
    }

    fn sample(session_id: &str, ts: i64) -> PerfSample {
        PerfSample {
            ts,
            session_id: session_id.to_string(),
            pid: None,
            rss_bytes: Some(1_048_576),
            cpu_pct: Some(5.0),
            threads: None,
        }
    }

    #[test]
    fn ring_caps_at_max_and_evicts_oldest() {
        let state = PerfState::new(tmp_db_path());
        let mut g = state.0.lock().unwrap();
        // Disable time-based retention so fake timestamps (0, 1, 2…) don't get pruned.
        g.config.retention_hours = 0;
        // Fill past capacity.
        for i in 0..(RING_CAP + 50) {
            ingest(&mut g, vec![sample("s", i as i64)]);
        }
        assert_eq!(g.ring.len(), RING_CAP);
        // Oldest entry should be ts = 50, newest = RING_CAP + 49.
        assert_eq!(g.ring.first().unwrap().ts, 50_i64);
        assert_eq!(g.ring.last().unwrap().ts, (RING_CAP + 49) as i64);
    }

    #[test]
    fn retention_removes_old_samples_from_ring_and_db() {
        let db_path = tmp_db_path();
        let state = PerfState::new(db_path.clone());
        let mut g = state.0.lock().unwrap();
        g.config.retention_hours = 1;
        let now = now_ms();
        let old = now - 2 * 3_600_000; // 2 h ago
        ingest(&mut g, vec![sample("old", old)]);
        ingest(&mut g, vec![sample("new", now)]);
        apply_retention(&mut g);
        assert!(!g.ring.iter().any(|s| s.session_id == "old"), "old sample pruned from ring");
        assert!(g.ring.iter().any(|s| s.session_id == "new"), "new sample kept in ring");
        if let Some(conn) = &g.db {
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM perf_samples WHERE session_id = 'old'", [], |r| r.get(0))
                .unwrap_or(1);
            assert_eq!(count, 0, "old sample pruned from DB");
        }
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn log_cap_keeps_most_recent_lines() {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("cap-{pid}-{nanos}.log"));
        let total = LOG_MAX_LINES + 500;
        let content: String = (0..total).map(|i| format!("line {i}\n")).collect();
        std::fs::write(&path, &content).unwrap();
        cap_log(&path);
        let result = std::fs::read_to_string(&path).unwrap();
        let n = result.lines().count();
        assert_eq!(n, LOG_MAX_LINES);
        // Last line must be from the end of the original file.
        assert!(result.contains(&format!("line {}", total - 1)), "newest line retained");
        assert!(!result.contains("line 0\n"), "oldest line dropped");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn register_and_unregister_tracked_pids() {
        let state = PerfState::new(tmp_db_path());
        state.register("p1", 1111);
        state.register("p2", 2222);
        {
            let g = state.0.lock().unwrap();
            assert_eq!(g.tracked.get("p1"), Some(&1111));
            assert_eq!(g.tracked.get("p2"), Some(&2222));
        }
        state.unregister("p1");
        {
            let g = state.0.lock().unwrap();
            assert!(!g.tracked.contains_key("p1"));
            assert_eq!(g.tracked.get("p2"), Some(&2222));
        }
    }
}
