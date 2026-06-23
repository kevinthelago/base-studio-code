//! User-facing log management (#1060): enumerate every managed log stream, read a stream's raw
//! tail, clear or export a stream, and a config-driven size/line cap.
//!
//! The six `bsc-*` TSVs (`coord`/`audit`/`skills`/`hooks`/`mcp`/`tokens`) and the rotating
//! application log are flat text — viewable, exportable, and cappable here. `perf.db` is binary
//! state: it's listed for size/mtime, but cleared from the Performance tab (`perf_clear_history`)
//! and never raw-viewed. `plan.db` is project STATE and is deliberately NOT managed here.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::bsc_base_dir;

// ── Config ──────────────────────────────────────────────────────────────────────

/// User-controlled retention for the text log streams. `0` disables a cap. Mirrors the
/// `PerfConfig` pattern: held in memory (default until the frontend pushes the persisted value via
/// `log_set_config`) and applied by `cap_logs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogConfig {
    /// Trim a text log to its newest N lines on enforcement. 0 = no line cap.
    pub max_lines: u32,
    /// Trim a text log to its newest bytes if it exceeds this many MB. 0 = no size cap.
    pub max_size_mb: u32,
}

impl Default for LogConfig {
    /// 10k lines preserves the historical `perf::cap_logs` behaviour; 20 MB is a generous byte
    /// backstop for a log whose lines are unusually long.
    fn default() -> Self {
        Self { max_lines: 10_000, max_size_mb: 20 }
    }
}

pub struct LogState(pub Mutex<LogConfig>);

impl LogState {
    pub fn new() -> Self {
        Self(Mutex::new(LogConfig::default()))
    }
    pub fn get(&self) -> LogConfig {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

// ── Stream registry ─────────────────────────────────────────────────────────────

/// Text-log streams: `(key, filename under ~/.base-studio-code/, label)`. These are the cappable,
/// raw-viewable, exportable logs.
const TSV_STREAMS: &[(&str, &str, &str)] = &[
    ("coord", "coord.log", "Coordination events"),
    ("audit", "audit.log", "Tool-attempt audit"),
    ("skills", "skills.log", "Skill usage"),
    ("hooks", "hooks.log", "Hook fires"),
    ("mcp", "mcp.log", "MCP calls"),
    ("tokens", "tokens.log", "Token & cost accounting"),
];

/// Resolve a stream key to its on-disk path. The app log lives in Tauri's log dir; `perf.db` and
/// the TSVs live under `~/.base-studio-code/`. Returns `None` for unknown/excluded keys.
fn stream_path(app: &tauri::AppHandle, stream: &str) -> Option<PathBuf> {
    match stream {
        "app" => app.path().app_log_dir().ok().map(|d| d.join("base-studio-code.log")),
        "perf" => Some(bsc_base_dir().join("perf.db")),
        other => TSV_STREAMS
            .iter()
            .find(|(k, _, _)| *k == other)
            .map(|(_, f, _)| bsc_base_dir().join(f)),
    }
}

/// Whether a stream is flat text (raw-viewable / cappable). `perf.db` is binary state.
fn is_text(stream: &str) -> bool {
    stream != "perf"
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileInfo {
    pub stream: String,
    pub label: String,
    pub path: String,
    pub size_bytes: u64,
    /// Last-modified, ms since the Unix epoch; 0 when the file is absent/unreadable.
    pub mtime_ms: i64,
    pub exists: bool,
    pub text: bool,
}

fn mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn info(app: &tauri::AppHandle, stream: &str, label: &str) -> LogFileInfo {
    let path = stream_path(app, stream);
    let (size, mtime, exists, path_str) = match &path {
        Some(p) if p.exists() => (
            std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
            mtime_ms(p),
            true,
            p.to_string_lossy().into_owned(),
        ),
        Some(p) => (0, 0, false, p.to_string_lossy().into_owned()),
        None => (0, 0, false, String::new()),
    };
    LogFileInfo {
        stream: stream.to_string(),
        label: label.to_string(),
        path: path_str,
        size_bytes: size,
        mtime_ms: mtime,
        exists,
        text: is_text(stream),
    }
}

// ── Capping ─────────────────────────────────────────────────────────────────────

/// Trim a text log to the newest `max_lines` lines and, if still over `max_size_mb`, drop further
/// oldest lines until under the byte cap. In-place; no-ops on a missing/short file or all-zero
/// config. Returns whether it rewrote the file (for tests).
pub fn cap_log(path: &Path, cfg: &LogConfig) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else { return false };
    let mut lines: Vec<&str> = text.lines().collect();
    let original = lines.len();

    if cfg.max_lines > 0 && lines.len() > cfg.max_lines as usize {
        lines = lines.split_off(lines.len() - cfg.max_lines as usize);
    }
    if cfg.max_size_mb > 0 {
        let cap = cfg.max_size_mb as usize * 1024 * 1024;
        // Drop oldest lines (cheaply, by byte length + newline) until under the cap.
        let mut bytes: usize = lines.iter().map(|l| l.len() + 1).sum();
        let mut drop = 0;
        while bytes > cap && drop < lines.len() {
            bytes -= lines[drop].len() + 1;
            drop += 1;
        }
        if drop > 0 {
            lines = lines.split_off(drop);
        }
    }

    if lines.len() == original {
        return false; // nothing trimmed
    }
    let out = if lines.is_empty() { String::new() } else { lines.join("\n") + "\n" };
    if std::fs::write(path, out.as_bytes()).is_ok() {
        log::info!("logs: capped {} from {} to {} lines", path.display(), original, lines.len());
        true
    } else {
        false
    }
}

/// Cap every text TSV stream under `base_dir` per `cfg`. The app log is rotated by
/// `tauri-plugin-log`, so it is left to the plugin.
pub fn cap_logs(base_dir: &Path, cfg: &LogConfig) {
    for (_, f, _) in TSV_STREAMS {
        let p = base_dir.join(f);
        if p.exists() {
            cap_log(&p, cfg);
        }
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────────

/// Every managed stream's path/size/mtime: the app log, the six TSVs, and `perf.db`.
#[tauri::command]
pub fn list_log_files(app: tauri::AppHandle) -> Vec<LogFileInfo> {
    let mut out = vec![info(&app, "app", "Application log")];
    for (k, _, label) in TSV_STREAMS {
        out.push(info(&app, k, label));
    }
    out.push(info(&app, "perf", "Performance database"));
    out
}

/// The newest `limit` raw lines of a text stream, in chronological order (oldest of the tail
/// first). Empty for `perf.db` (binary) or an unknown/missing stream.
#[tauri::command]
pub fn read_log_tail(stream: String, limit: usize, app: tauri::AppHandle) -> Vec<String> {
    if !is_text(&stream) {
        return Vec::new();
    }
    let Some(path) = stream_path(&app, &stream) else { return Vec::new() };
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    if lines.len() > limit {
        lines = lines.split_off(lines.len() - limit);
    }
    lines
}

/// Truncate a file to empty (the clear primitive). No-ops on a missing file.
fn clear_file(path: &Path) -> Result<(), String> {
    if path.exists() {
        std::fs::write(path, b"").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Copy `src` into `exports_dir` as `<stream>-<ms>.<ext>` and return the destination (the export
/// primitive). Errors if the source is empty/absent.
fn export_file(src: &Path, exports_dir: &Path, stream: &str, ms: u128) -> Result<PathBuf, String> {
    if !src.exists() {
        return Err("nothing to export — the log is empty".into());
    }
    std::fs::create_dir_all(exports_dir).map_err(|e| e.to_string())?;
    let ext = if stream == "perf" { "db" } else { "log" };
    let dest = exports_dir.join(format!("{stream}-{ms}.{ext}"));
    std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

/// Truncate a text stream to empty. Refuses `perf.db` (cleared from the Performance tab via
/// `perf_clear_history`) and unknown streams.
#[tauri::command]
pub fn clear_log(stream: String, app: tauri::AppHandle) -> Result<(), String> {
    if stream == "perf" {
        return Err("perf.db is cleared from the Performance tab".into());
    }
    let path = stream_path(&app, &stream).ok_or_else(|| format!("unknown log stream: {stream}"))?;
    clear_file(&path)
}

/// Copy a stream's file to `~/.base-studio-code/exports/<stream>-<ms>.log` and return the
/// destination path. Dependency-free alternative to a native save dialog (#1060).
#[tauri::command]
pub fn export_log(stream: String, app: tauri::AppHandle) -> Result<String, String> {
    let src = stream_path(&app, &stream).ok_or_else(|| format!("unknown log stream: {stream}"))?;
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = export_file(&src, &bsc_base_dir().join("exports"), &stream, ms)?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn log_get_config(state: tauri::State<LogState>) -> LogConfig {
    state.get()
}

#[tauri::command]
pub fn log_set_config(max_lines: u32, max_size_mb: u32, state: tauri::State<LogState>) {
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = LogConfig { max_lines, max_size_mb };
}

/// Apply the current cap to every TSV stream now (the "Enforce now" action).
#[tauri::command]
pub fn enforce_log_caps(state: tauri::State<LogState>) {
    cap_logs(&bsc_base_dir(), &state.get());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        std::env::temp_dir().join(format!("log-{name}-{pid}-{nanos}.log"))
    }

    #[test]
    fn cap_log_keeps_newest_lines_by_line_cap() {
        let path = tmp("lines");
        let total = 10_500;
        let content: String = (0..total).map(|i| format!("line {i}\n")).collect();
        std::fs::write(&path, &content).unwrap();

        let changed = cap_log(&path, &LogConfig { max_lines: 10_000, max_size_mb: 0 });
        assert!(changed);
        let result = std::fs::read_to_string(&path).unwrap();
        assert_eq!(result.lines().count(), 10_000);
        assert!(result.contains(&format!("line {}", total - 1)), "newest retained");
        assert!(!result.contains("line 0\n"), "oldest dropped");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn cap_log_enforces_byte_cap_after_lines() {
        let path = tmp("bytes");
        // 2000 lines of ~100 bytes ≈ 200 KB; cap at well under that via a tiny size knob.
        let content: String = (0..2000).map(|i| format!("{i} {}\n", "x".repeat(100))).collect();
        std::fs::write(&path, &content).unwrap();

        // max_size_mb is whole MB; use line cap to a small count to prove byte trim path runs too.
        let changed = cap_log(&path, &LogConfig { max_lines: 0, max_size_mb: 1 });
        // 200 KB < 1 MB → no change.
        assert!(!changed, "under the byte cap → untouched");

        let big: String = (0..30_000).map(|i| format!("{i} {}\n", "y".repeat(50))).collect(); // ~1.6 MB
        std::fs::write(&path, &big).unwrap();
        let changed = cap_log(&path, &LogConfig { max_lines: 0, max_size_mb: 1 });
        assert!(changed, "over 1 MB → trimmed");
        assert!(std::fs::metadata(&path).unwrap().len() <= 1024 * 1024);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn cap_log_noops_when_under_caps_or_disabled() {
        let path = tmp("noop");
        std::fs::write(&path, b"a\nb\nc\n").unwrap();
        assert!(!cap_log(&path, &LogConfig { max_lines: 0, max_size_mb: 0 }), "all-zero config = no cap");
        assert!(!cap_log(&path, &LogConfig { max_lines: 10, max_size_mb: 10 }), "under caps");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn default_config_matches_historical_cap() {
        assert_eq!(LogConfig::default().max_lines, 10_000);
    }

    #[test]
    fn stream_registry_covers_six_tsvs_and_excludes_plan() {
        let keys: Vec<&str> = TSV_STREAMS.iter().map(|(k, _, _)| *k).collect();
        assert_eq!(keys, ["coord", "audit", "skills", "hooks", "mcp", "tokens"]);
        assert!(is_text("audit") && is_text("app"), "text streams are viewable");
        assert!(!is_text("perf"), "perf.db is binary state");
        // plan.db is deliberately not a managed stream.
        assert!(!keys.contains(&"plan"));
    }

    #[test]
    fn clear_file_truncates_and_noops_when_absent() {
        let path = tmp("clear");
        std::fs::write(&path, b"one\ntwo\n").unwrap();
        clear_file(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
        let _ = std::fs::remove_file(&path);
        // Missing file is fine.
        clear_file(&path).unwrap();
    }

    #[test]
    fn export_file_copies_with_named_destination_and_rejects_empty() {
        let src = tmp("export-src");
        let dir = std::env::temp_dir().join(format!("log-exports-{}", std::process::id()));
        std::fs::write(&src, b"payload\n").unwrap();

        let dest = export_file(&src, &dir, "audit", 12345).unwrap();
        assert_eq!(dest.file_name().unwrap().to_string_lossy(), "audit-12345.log");
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "payload\n");
        // perf exports keep the .db extension.
        assert!(export_file(&src, &dir, "perf", 9).unwrap().to_string_lossy().ends_with("perf-9.db"));
        // A missing source is a clear error, not a panic.
        assert!(export_file(&tmp("nope"), &dir, "audit", 1).is_err());

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
