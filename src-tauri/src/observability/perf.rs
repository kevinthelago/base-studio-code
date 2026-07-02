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
/// Don't sample during the cold-start window (#1033). Agent metrics have no value before the app is
/// up (no agents are even running at a fresh launch), and the 2s disk writes + IPC just pile
/// contention onto the slowest moment of a launch.
pub const STARTUP_GRACE_SECS: u64 = 20;

struct PerfInner {
    config: PerfConfig,
    /// session_id → shell PID for each live agent pane.
    tracked: HashMap<String, u32>,
    /// In-memory ring buffer for the live UI.
    ring: Vec<PerfSample>,
    /// Where the metrics DB lives. The connection itself is opened lazily (#1047) — see
    /// `db_conn` — so the boot path only stores the path, never a `Connection::open`.
    db_path: PathBuf,
    /// Lazily-opened metrics DB. `None` until first use; `db_opened` tells `None` "not yet
    /// tried" apart from "tried and failed" so a bad path isn't re-opened every tick.
    db: Option<Connection>,
    db_opened: bool,
    /// Persistent `System` so CPU delta accumulates across ticks (first tick = 0 %).
    sys: System,
    ingest_count: u64,
}

impl PerfInner {
    /// Open the metrics DB on first use and cache it (#1047). Keeps `Connection::open` +
    /// `CREATE TABLE IF NOT EXISTS` off the synchronous boot path: the first sample only
    /// fires after the `STARTUP_GRACE_SECS` window, and command handlers open on demand.
    /// Opened at most once — a failed open is remembered (stays `None`) so we don't retry
    /// every tick.
    fn db_conn(&mut self) -> Option<&Connection> {
        if !self.db_opened {
            self.db_opened = true;
            self.db = open_db(&self.db_path)
                .map_err(|e| log::warn!("perf: cannot open DB {}: {e}", self.db_path.display()))
                .ok();
        }
        self.db.as_ref()
    }
}

// ── Public state ──────────────────────────────────────────────────────────────

// PerfInner is intentionally crate-private (opaque Tauri-managed state); the field is pub so
// command handlers can lock it. (#744 — silence private_interfaces, don't leak the type.)
#[allow(private_interfaces)]
pub struct PerfState(pub Mutex<PerfInner>);

impl PerfState {
    pub fn new(db_path: PathBuf) -> Self {
        // Measure the metrics DB at boot (#1033) — a growing perf.db is a suspect in the
        // cold-start-time variance (more for the OS file scanner to chew on every write).
        // Stat only: a metadata read, never an open (#1047 keeps the open off the boot path).
        if let Ok(meta) = std::fs::metadata(&db_path) {
            log::info!("[perf] perf.db {} KB at startup", meta.len() / 1024);
        }
        Self(Mutex::new(PerfInner {
            config: PerfConfig::default(),
            tracked: HashMap::new(),
            ring: Vec::with_capacity(RING_CAP),
            db_path,
            db: None,
            db_opened: false,
            sys: System::new(),
            ingest_count: 0,
        }))
    }

    /// Lock the inner state, recovering from poisoning — the shared `observability::lock_recover`
    /// idiom (one home for `lock().unwrap_or_else(|e| e.into_inner())`).
    #[allow(private_interfaces)]
    pub fn lock(&self) -> std::sync::MutexGuard<'_, PerfInner> {
        super::lock_recover(&self.0)
    }

    /// Called by `pty_create` after spawning the shell.
    pub fn register(&self, session_id: &str, pid: u32) {
        self.lock().tracked.insert(session_id.to_string(), pid);
    }

    /// Called by `pty_kill` when the pane is torn down.
    pub fn unregister(&self, session_id: &str) {
        self.lock().tracked.remove(session_id);
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
    let mut g = state.lock();
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

    // Flush to SQLite (opens the DB lazily on the first sample — #1047).
    if let Some(conn) = g.db_conn() {
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
    if g.config.retention_hours > 0 {
        let cutoff = now_ms() - g.config.retention_hours as i64 * 3_600_000;
        if let Some(conn) = g.db_conn() {
            let _ = conn.execute("DELETE FROM perf_samples WHERE ts < ?1", params![cutoff]);
        }
        g.ring.retain(|s| s.ts >= cutoff);
    }
    enforce_size_cap(g);
}

/// Size cap (#1033): time-based DELETE doesn't shrink the SQLite file (freed pages are reused, not
/// returned), so a busy fleet can leave perf.db large. When it exceeds `max_db_mb`, drop the oldest
/// quarter of rows and VACUUM to actually reclaim the disk — keeping the file the OS scanner touches
/// on every write small. Cheap: the size is read via PRAGMA (no filesystem stat) and only crosses the
/// cap rarely, so the VACUUM is infrequent.
fn enforce_size_cap(g: &mut PerfInner) {
    // Snapshot the cap before borrowing the connection: `db_conn` borrows all of `g`, so
    // `g.config` can't be read while `conn` is live.
    let max_db_mb = g.config.max_db_mb;
    if max_db_mb == 0 { return; }
    let Some(conn) = g.db_conn() else { return };
    let page_count: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap_or(0);
    let page_size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap_or(0);
    let bytes = page_count * page_size;
    if bytes <= max_db_mb as i64 * 1_048_576 { return; }
    let _ = conn.execute(
        "DELETE FROM perf_samples WHERE id IN \
         (SELECT id FROM perf_samples ORDER BY ts LIMIT (SELECT COUNT(*) / 4 FROM perf_samples))",
        [],
    );
    let _ = conn.execute("VACUUM", []);
    log::info!("[perf] perf.db exceeded {max_db_mb}MB cap — pruned oldest 25% + vacuumed");
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Background sampler task ───────────────────────────────────────────────────

/// Spawned as a Tokio task from `run()`. Ticks at 1-second granularity so it
/// can react to config changes promptly without restart logic; the actual sample
/// cadence is controlled by `interval_secs`.
pub async fn run_sampler(app: tauri::AppHandle) {
    // Hold off until the cold-start window has passed (#1033) — see STARTUP_GRACE_SECS.
    tokio::time::sleep(tokio::time::Duration::from_secs(STARTUP_GRACE_SECS)).await;
    log::info!("[perf] sampler active (after {STARTUP_GRACE_SECS}s startup grace)");
    let mut ticker = tokio::time::interval(tokio::time::Duration::from_secs(1));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last = std::time::Instant::now();
    loop {
        ticker.tick().await;
        let perf = app.state::<PerfState>();
        let (enabled, interval_secs) = {
            let g = perf.lock();
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
    state.lock().config.clone()
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
    let mut g = state.lock();
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
        let g = state.lock();
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
    let mut g = state.lock();
    ingest(&mut g, vec![s]);
}

#[tauri::command]
pub fn perf_clear_history(state: tauri::State<PerfState>) -> Result<(), String> {
    let mut g = state.lock();
    g.ring.clear();
    if let Some(conn) = g.db_conn() {
        conn.execute("DELETE FROM perf_samples", []).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn perf_get_recent_samples(limit: usize, state: tauri::State<PerfState>) -> Vec<PerfSample> {
    let g = state.lock();
    let n = g.ring.len().min(limit);
    g.ring[g.ring.len() - n..].to_vec()
}

/// RAII timer: logs how long a scope took when it drops, but only if the elapsed
/// time crosses `threshold_ms` — so it surfaces slow operations without noise.
/// Lives across `.await` points, so wrapping an async command times the whole call.
pub(crate) struct PerfSpan {
    label: &'static str,
    start: std::time::Instant,
    threshold_ms: u128,
}
impl PerfSpan {
    pub(crate) fn new(label: &'static str) -> Self {
        Self { label, start: std::time::Instant::now(), threshold_ms: 50 }
    }
}
impl Drop for PerfSpan {
    fn drop(&mut self) {
        let ms = self.start.elapsed().as_millis();
        if ms >= self.threshold_ms {
            log::info!("perf · {} took {}ms", self.label, ms);
        }
    }
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
        if let Some(conn) = g.db_conn() {
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM perf_samples WHERE session_id = 'old'", [], |r| r.get(0))
                .unwrap_or(1);
            assert_eq!(count, 0, "old sample pruned from DB");
        }
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn size_cap_prunes_oldest_when_over_limit() {
        let db_path = tmp_db_path();
        let state = PerfState::new(db_path.clone());
        let mut g = state.0.lock().unwrap();
        g.config.retention_hours = 0; // isolate the size cap from time-based retention
        g.config.max_db_mb = 1;       // tiny cap
        // Bulk-insert directly (one transaction) past 1 MB — far faster than driving the ring.
        {
            let conn = g.db_conn().unwrap();
            conn.execute_batch("BEGIN").unwrap();
            let mut stmt = conn
                .prepare("INSERT INTO perf_samples (ts, session_id, rss_bytes, cpu_pct) VALUES (?1, 's', 1048576, 5.0)")
                .unwrap();
            for i in 0..60_000i64 {
                stmt.execute(params![i]).unwrap();
            }
            drop(stmt);
            conn.execute_batch("COMMIT").unwrap();
        }
        enforce_size_cap(&mut g);
        let rows: i64 = g
            .db_conn()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM perf_samples", [], |r| r.get(0))
            .unwrap();
        assert!(rows < 60_000, "size cap pruned the oldest rows (kept {rows})");
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn db_open_is_deferred_off_the_boot_path() {
        // #1047: constructing PerfState must not open the DB — no Connection::open, no
        // CREATE TABLE, not even the file on disk. The open happens lazily on first use.
        let path = tmp_db_path();
        let _ = std::fs::remove_file(&path);
        let state = PerfState::new(path.clone());
        {
            let g = state.0.lock().unwrap();
            assert!(g.db.is_none(), "DB must not be opened at construction");
            assert!(!g.db_opened, "DB open must not even be attempted at construction");
        }
        assert!(!path.exists(), "perf.db must not be created on the boot path");

        // First sample opens it.
        {
            let mut g = state.0.lock().unwrap();
            g.config.retention_hours = 0;
            ingest(&mut g, vec![sample("s", 1)]);
            assert!(g.db_opened && g.db.is_some(), "DB opens lazily on the first ingest");
        }
        assert!(path.exists(), "perf.db is created on the first sample");
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

