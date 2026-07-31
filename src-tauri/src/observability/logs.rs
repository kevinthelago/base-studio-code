//! User-facing log management (#1060): enumerate every managed log stream, read a stream's raw
//! tail, clear or export a stream, and a config-driven size/line cap.
//!
//! The six `bsc-*` TSVs (`coord`/`audit`/`skills`/`hooks`/`mcp`/`tokens`) and the rotating
//! application log are flat text — viewable, exportable, and cappable here. `perf.db` is binary
//! state: it's listed for size/mtime, but cleared from the Performance tab (`perf_clear_history`)
//! and never raw-viewed. `plan.db` is project STATE and is deliberately NOT managed here.

use crate::StrErr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use super::MutexConfig;
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

/// The text-log retention config, held in a poison-tolerant `Mutex`. Built on the shared
/// `MutexConfig<T>` (config-in-mutex + `get`/`set`); `perf`'s `PerfState` shares only the
/// underlying `lock_recover` idiom since it carries more than a config.
pub type LogState = MutexConfig<LogConfig>;

// ── Stream registry ─────────────────────────────────────────────────────────────

// The managed text-log streams are the SAME per-pane TSVs the pty env-writer stages and the unified
// `bsc logs` reader parses — `bsc_util::LOG_STREAMS`, the ONE source of truth for stream keys +
// filenames (#1847). This module no longer keeps its own `(key, file)` table, which had drifted out
// of sync (it was missing `activity`/`done`/`perm`, so those growing logs were neither listed, capped,
// clearable, nor viewable here). The engine that PARSES these streams lives in `crates/logs` and is
// reached from the frontend via `bsc logs …` over the `bsc` bridge (#2144); this module owns only the
// file-management face — inventory, size cap, clear, export, and the raw viewer (which also serves the
// Tauri-owned `app` log). Labels are a UI concern kept here, keyed by the registry's canonical key.

/// The human label for a managed stream, keyed by the `bsc_util::LOG_STREAMS` canonical key (plus the
/// two module-owned pseudo-streams `app` / `perf`). Unknown keys fall back to the key itself.
fn label_for(key: &str) -> &'static str {
    match key {
        "tool" => "Tool-attempt audit",
        "skill" => "Skill usage",
        "mcp" => "MCP calls",
        "hook" => "Hook fires",
        "activity" => "Turn activity",
        "done" => "Worker self-close",
        "coord" => "Coordination events",
        "perm" => "Permission denials",
        "tokens" => "Token & cost accounting",
        "ui" => "UI design activity",
        "app" => "Application log",
        "perf" => "Performance database",
        _ => "Log stream",
    }
}

/// Resolve a stream key to its on-disk path. The app log lives in Tauri's log dir; `perf.db` and
/// the TSVs live under `~/.base-studio-code/`. The TSV filenames come from the shared
/// `bsc_util::LOG_STREAMS` registry. Returns `None` for unknown/excluded keys.
fn stream_path(app: &tauri::AppHandle, stream: &str) -> Option<PathBuf> {
    match stream {
        "app" => app.path().app_log_dir().ok().map(|d| d.join("base-studio-code.log")),
        "perf" => Some(crate::perf_db()),
        other => bsc_util::LOG_STREAMS
            .iter()
            .find(|s| s.key == other)
            .map(|s| bsc_base_dir().join(s.filename)),
    }
}

/// Whether a stream is flat text (raw-viewable / cappable). `perf.db` is binary state.
fn is_text(stream: &str) -> bool {
    stream != "perf"
}

/// The rotating application log path (`<app_log_dir>/base-studio-code.log`) — the file the
/// [`GraphLogger`](crate::observability::graph_log) file sink appends to and the `"app"` reader
/// stream consumes. Exposed so the cap paths can rotate it now that no plugin does (#1389).
pub fn app_log_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    stream_path(app, "app")
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

fn info(app: &tauri::AppHandle, stream: &str) -> LogFileInfo {
    let label = label_for(stream);
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

/// Cap every managed text TSV stream (the shared `bsc_util::LOG_STREAMS` registry) under `base_dir`
/// per `cfg`. The rotating application log lives in Tauri's `app_log_dir` and is capped separately
/// via [`cap_log`] on [`app_log_file`] (the boot cap + "Enforce now" do so now that the custom
/// `GraphLogger` (#1389) owns it — no plugin rotates it); `perf.db` is binary state pruned by the
/// perf sampler, not here.
pub fn cap_logs(base_dir: &Path, cfg: &LogConfig) {
    for s in bsc_util::LOG_STREAMS {
        let p = base_dir.join(s.filename);
        if p.exists() {
            cap_log(&p, cfg);
        }
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────────

/// Every managed stream's path/size/mtime: the app log, every `bsc_util::LOG_STREAMS` per-pane TSV,
/// and `perf.db`.
#[tauri::command]
pub fn list_log_files(app: tauri::AppHandle) -> Vec<LogFileInfo> {
    let mut out = vec![info(&app, "app")];
    for s in bsc_util::LOG_STREAMS {
        out.push(info(&app, s.key));
    }
    out.push(info(&app, "perf"));
    out
}

/// The newest `limit` non-blank lines of a text log file. `newest_first` selects the order:
/// `true` returns them newest-first (the audit/skill/hook/mcp readers); `false` keeps the file's
/// chronological oldest-first order (the coord log + `read_log_tail`). A missing/unreadable file
/// yields an empty list. The one copy of the six near-identical tail readers' body.
pub(crate) fn tail_lines(path: &Path, limit: usize, newest_first: bool) -> Vec<String> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut lines: Vec<String> =
        text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    if newest_first {
        lines.reverse();
        lines.truncate(limit);
    } else if lines.len() > limit {
        lines = lines.split_off(lines.len() - limit);
    }
    lines
}

/// The newest `limit` raw lines of a text stream, in chronological order (oldest of the tail
/// first). Empty for `perf.db` (binary) or an unknown/missing stream.
#[tauri::command]
pub fn read_log_tail(stream: String, limit: usize, app: tauri::AppHandle) -> Vec<String> {
    if !is_text(&stream) {
        return Vec::new();
    }
    let Some(path) = stream_path(&app, &stream) else { return Vec::new() };
    tail_lines(&path, limit, false)
}

// The per-stream TSV log readers (`read_audit_log`/`read_skill_log`/`read_hook_log`/`read_mcp_log`/
// `read_coord_log`) moved to the `bsc logs tail <stream>` CLI over the `bsc` bridge (#2144). The
// underlying `tail_lines` reader stays — it still backs `read_log_tail` (the raw-viewer command,
// which also serves the Tauri-owned `app` log and so cannot move to `bsc logs`).

// ── In-process hot-poll readers (#3630) ──────────────────────────────────────────
//
// The always-on fleet/console pumps (`useCoordLog`, `useWorkerAutoEnd`, the pane-activity poll, the
// coordination pumps) read these unified streams every ~1s. Routing each poll through the `bsc`
// bridge SPAWNED a `bsc.exe` subprocess per read (`console::bsc`), and at 5–10 spawns/sec the Tauri
// invoke backlog grew without bound → the app progressively froze. These commands read the SAME
// streams IN-PROCESS via the already-linked `logs` crate — no spawn, no per-call DB/binary init — so
// the hot polls cost a file read instead of a process. They resolve the log dir with `logs::log_dir`,
// the exact resolver the `bsc logs` CLI uses (`$BSC_LOG_DIR`, else `~/.base-studio-code`), so they
// read byte-for-byte the same files the subprocess did. #4074 brought `cost` across too — it was
// filed here as "low-frequency" and is in fact polled every 4s, the app's biggest spawner. The
// remaining analytics one-shots stay on the bridge.

/// Newest `limit` raw lines of a unified `bsc logs` stream (`coord`/`audit`/`skill`/`hook`/`mcp`/`ui`/
/// `perm`), read in-process (#3630) — the drop-in for `bsc logs tail <stream> --json`. `oldest` keeps
/// chronological order (the coord log); otherwise newest-first. Unknown/missing stream ⇒ empty.
#[tauri::command]
pub fn logs_tail(stream: String, limit: usize, oldest: bool) -> Vec<String> {
    ::logs::tail_raw(&::logs::log_dir(), &stream, limit, oldest)
}

/// Per-pane token + cost rollup, newest pane first — the in-process drop-in for
/// `bsc logs cost --full --limit N --json` (#4074), calling the SAME `logs::cost::usage` the CLI's
/// `cost` verb does, so the rows are byte-identical.
///
/// #3630 moved the hot pollers in-process and left the cost read on the `bsc` bridge as
/// "low-frequency". It is not: `usePaneTokenUsage` polls it every 4s, and it was the single biggest
/// process spawner in the app — 415 calls in a 27-minute window, more than any other command. Each
/// spawn blocked Tauri's main thread, so the invoke queue backed up to 25s and every other command,
/// including trivial ones like `perf_record_frontend_sample`, waited behind it.
#[tauri::command]
pub fn logs_usage(limit: usize) -> Vec<::logs::Usage> {
    ::logs::usage(&::logs::log_dir(), limit)
}

/// The algorithms knowledge graph, read IN-PROCESS — the drop-in for `bsc graph dump` (#4078).
///
/// `useKnowledgeGraph` polls this every 5s while the Algorithms page is mounted, and through the
/// `bsc` bridge every tick was a process SPAWN — to read 84 KB, hash it, and throw the result away
/// because nothing had changed, which is the overwhelmingly common case. Same mistake #3630 fixed for
/// the log pollers and #4074 for the cost poll.
///
/// Calls `bsc_graph::load`, the CLI's own reader, so it resolves the same store (`BSC_GRAPH_STORE`,
/// else `~/.base-studio-code/knowledge/algorithms.json`) and applies the same seed reconcile (#3198).
/// A missing/unreadable store yields the packaged seed, exactly as the CLI does — so the page keeps
/// rendering rather than blanking.
#[tauri::command]
pub fn graph_dump() -> serde_json::Value {
    bsc_graph::load()
}

/// The latest turn-boundary state per pane (`run`/`idle`), newest pane first — the in-process drop-in
/// for `bsc logs pane-activity --json` (#3630).
#[tauri::command]
pub fn logs_pane_activity() -> Vec<::logs::PaneActivity> {
    ::logs::pane_activity(&::logs::log_dir())
}

/// The deduped set of panes that self-reported `done` (#1379), newest first — the in-process drop-in
/// for `bsc logs done-panes --json` (#3630).
#[tauri::command]
pub fn logs_done_panes() -> Vec<String> {
    ::logs::done_panes(&::logs::log_dir())
}

/// Append a `woke` event to the coordination log (#199): records that a parked
/// session was relaunched, so the coordinator won't re-wake it (idempotent across
/// polls + restarts). Same TSV shape + ISO-8601 UTC timestamp as the shell emitters.
#[tauri::command]
pub(crate) fn append_coord_woke(session: String) -> Result<(), String> {
    use std::io::Write;
    let path = bsc_base_dir().join("coord.log");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let fmt = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second]Z"
    );
    let ts = time::OffsetDateTime::now_utc().format(&fmt).unwrap_or_default();
    // TSV shape: ts \t session \t event \t ref \t detail \n — `woke` has no ref/detail.
    let line = format!("{ts}\t{session}\twoke\t\t\n");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .str_err()?;
    f.write_all(line.as_bytes()).str_err()
}

/// Truncate a file to empty (the clear primitive). No-ops on a missing file.
fn clear_file(path: &Path) -> Result<(), String> {
    if path.exists() {
        std::fs::write(path, b"").str_err()?;
    }
    Ok(())
}

/// Copy `src` into `exports_dir` as `<stream>-<ms>.<ext>` and return the destination (the export
/// primitive). Errors if the source is empty/absent.
fn export_file(src: &Path, exports_dir: &Path, stream: &str, ms: u128) -> Result<PathBuf, String> {
    if !src.exists() {
        return Err("nothing to export — the log is empty".into());
    }
    std::fs::create_dir_all(exports_dir).str_err()?;
    let ext = if stream == "perf" { "db" } else { "log" };
    let dest = exports_dir.join(format!("{stream}-{ms}.{ext}"));
    std::fs::copy(src, &dest).str_err()?;
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
    state.set(LogConfig { max_lines, max_size_mb });
}

/// Apply the current cap to every TSV stream now (the "Enforce now" action) — plus the rotating
/// application log, which the custom `GraphLogger` (#1389) writes and no plugin rotates any more.
#[tauri::command]
pub fn enforce_log_caps(app: tauri::AppHandle, state: tauri::State<LogState>) {
    let cfg = state.get();
    cap_logs(&bsc_base_dir(), &cfg);
    if let Some(p) = app_log_file(&app) {
        cap_log(&p, &cfg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graph_dump_reads_the_cli_store_and_always_yields_a_graph() {
        // #4078 — the command must resolve the SAME store the `bsc graph` CLI does (`BSC_GRAPH_STORE`,
        // else the home path), or the page and the librarian would silently read different files. It
        // calls `bsc_graph::load` for exactly that reason; this pins the behaviour that matters to the
        // caller: a store pointed at nothing still yields the packaged seed rather than an error, so
        // the Algorithms page keeps rendering.
        let dir = std::env::temp_dir().join(format!("bsc-graphdump-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("nope.json");
        let prev = std::env::var("BSC_GRAPH_STORE").ok();

        std::env::set_var("BSC_GRAPH_STORE", &missing);
        let g = graph_dump();
        assert!(g.get("implementations").is_some_and(|v| v.is_array()), "must fall back to the seed: {g}");

        match prev {
            Some(v) => std::env::set_var("BSC_GRAPH_STORE", v),
            None => std::env::remove_var("BSC_GRAPH_STORE"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn tmp(name: &str) -> PathBuf {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        std::env::temp_dir().join(format!("log-{name}-{pid}-{nanos}.log"))
    }

    #[test]
    fn tail_lines_orders_and_limits_and_filters_blanks() {
        let path = tmp("tail");
        // A blank line between b and c must be filtered out by both orderings.
        std::fs::write(&path, b"a\nb\n\nc\nd\n").unwrap();

        // newest-first: the newest `limit`, reversed.
        assert_eq!(tail_lines(&path, 2, true), vec!["d".to_string(), "c".to_string()]);
        // oldest-first: the newest `limit`, in chronological order.
        assert_eq!(tail_lines(&path, 2, false), vec!["c".to_string(), "d".to_string()]);
        // limit beyond length returns everything (blank dropped), in each order.
        assert_eq!(tail_lines(&path, 10, false), vec!["a", "b", "c", "d"]);
        assert_eq!(tail_lines(&path, 10, true), vec!["d", "c", "b", "a"]);

        let _ = std::fs::remove_file(&path);
        // Missing file → empty, never a panic.
        assert!(tail_lines(&path, 5, true).is_empty());
        assert!(tail_lines(&path, 5, false).is_empty());
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
    fn managed_streams_derive_from_shared_registry_and_exclude_plan() {
        // The managed text streams ARE the shared `bsc_util::LOG_STREAMS` — one source of truth, no
        // drift. Every per-pane TSV (incl. activity/done/perm, which the old hand-kept table dropped)
        // is now inventoried, capped, clearable, and viewable.
        let keys: Vec<&str> = bsc_util::LOG_STREAMS.iter().map(|s| s.key).collect();
        for k in ["tool", "skill", "mcp", "hook", "activity", "done", "coord", "perm", "tokens"] {
            assert!(keys.contains(&k), "registry covers {k}");
        }
        // plan.db is project STATE, deliberately not a managed log stream.
        assert!(!keys.contains(&"plan"));
        assert!(is_text("tool") && is_text("app"), "text streams are viewable");
        assert!(!is_text("perf"), "perf.db is binary state");
    }

    #[test]
    fn label_for_covers_every_managed_key_and_falls_back() {
        // Every registry key + the two module-owned pseudo-streams resolve to a non-fallback label,
        // so the inventory never shows the placeholder for a real stream.
        for s in bsc_util::LOG_STREAMS {
            assert_ne!(label_for(s.key), "Log stream", "{} has a real label", s.key);
        }
        assert_eq!(label_for("app"), "Application log");
        assert_eq!(label_for("perf"), "Performance database");
        assert_eq!(label_for("nonexistent"), "Log stream", "unknown key falls back");
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
