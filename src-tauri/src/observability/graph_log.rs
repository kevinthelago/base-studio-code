//! The runtime log-scope graph (#1389) — a custom dual-sink `log::Log` that replaces
//! `tauri-plugin-log`.
//!
//! Two sinks, split by POLICY (not just destination):
//!
//! 1. **File sink — the system of record.** EVERY record at or below the audit baseline (`Debug`) is
//!    appended to the rotating app log (`<app_log_dir>/base-studio-code.log`) — the same file the
//!    #1607 reader (`observability::logs` `read_log_tail`/`list_log_files`, stream `"app"`) consumes.
//!    It is **never** gated by the scope graph, so the audit/forensic trail is always complete. The
//!    file is written PLAIN (no ANSI) so the raw-line reader + the `cap_log` rotation stay clean.
//! 2. **Console sink — a view.** stdout (the `tauri dev` terminal / packaged stdout) is gated
//!    per scope at runtime by the [`ScopeRegistry`]. Flipping a subsystem off silences its console
//!    output with no recompile/restart — but the file sink still records it (the security property).
//!
//! Rotation reuses the existing [`observability::logs::cap_log`] on the app log path (the boot +
//! "enforce now" cap paths now include it, since the plugin no longer rotates it).
//!
//! The pure scope policy (config type, prefix-match + cascade, JSON persistence, the `bsc log` CLI)
//! lives Tauri-free in [`logs::scope`], shared with the CLI so both surfaces agree.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use logs::scope::{normalize_scope, ScopeConfig, ScopeLevel};
use serde::Serialize;
use tauri::State;

/// The audit baseline: every record at or below `Debug` is written to the FILE sink unconditionally
/// (`Trace` is dropped — a rich audit without the trace firehose; #1389 decision). `log::Level as u8`
/// gives Error=1 … Debug=4, so a record's `rank <= FILE_RANK` means "persist it".
const FILE_RANK: u8 = 4; // log::Level::Debug

/// The scope-config file path: `$BSC_LOG_SCOPES`, else `~/.base-studio-code/log-scopes.json`. Shared
/// with the `bsc log` CLI ([`logs::scope::scopes_path`]) so both read/write the same file.
pub fn scope_config_path() -> PathBuf {
    logs::scope::scopes_path()
}

/// Last-modified time of `path` in epoch-ms, or `0` when absent/unreadable (the external-write poll's
/// change signal).
fn mtime_ms(path: &std::path::Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Managed state: the live scope config + its persistence path. The logger holds an `Arc` clone and
/// reads the `RwLock` on the hot path (cheap — no IPC, preserving the #1033 deferral); the Tauri
/// commands + the external-write poll take the write lock only on a change.
pub struct ScopeRegistry {
    cfg: RwLock<ScopeConfig>,
    path: PathBuf,
    /// The mtime (epoch-ms) of `path` we last loaded, so the poll can detect an EXTERNAL write (a
    /// `bsc log set` from a console session) and reload live. Our own `save` updates it too, so our
    /// writes don't trigger a redundant reload.
    loaded_mtime: Mutex<i64>,
}

impl ScopeRegistry {
    /// Load the config from `path` (defaults on a missing/garbage file) and record its mtime.
    pub fn new(path: PathBuf) -> Arc<Self> {
        let cfg = ScopeConfig::load(&path);
        let m = mtime_ms(&path);
        Arc::new(Self { cfg: RwLock::new(cfg), path, loaded_mtime: Mutex::new(m) })
    }

    /// A clone of the current config (for the `log_get_scopes` command).
    pub fn snapshot(&self) -> ScopeConfig {
        self.cfg.read().map(|c| c.clone()).unwrap_or_default()
    }

    /// Whether a record at `level_rank` (`log::Level as u8`) with `target` prints to the console.
    /// The single hot-path read: a poisoned lock degrades to "show it" (fail-open for the VIEW; the
    /// file record is unaffected).
    pub fn permits(&self, target: &str, level_rank: u8) -> bool {
        match self.cfg.read() {
            Ok(cfg) => cfg.permits(target, level_rank),
            Err(_) => true,
        }
    }

    /// Set a scope's console policy and persist to disk. Persisting keeps the desktop + a console
    /// `bsc log` view consistent and survives a restart. Returns a persistence error string (the
    /// in-memory change already took effect regardless).
    pub fn set(&self, scope: &str, level: ScopeLevel) -> Result<(), String> {
        let cfg = {
            let mut guard = self.cfg.write().map_err(|_| "scope registry lock poisoned")?;
            guard.set(scope, level);
            guard.clone()
        };
        self.persist(&cfg)
    }

    /// Restore the built-in defaults and persist.
    pub fn reset(&self) -> Result<(), String> {
        let cfg = ScopeConfig::default();
        {
            let mut guard = self.cfg.write().map_err(|_| "scope registry lock poisoned")?;
            *guard = cfg.clone();
        }
        self.persist(&cfg)
    }

    /// Write `cfg` to disk and refresh the loaded-mtime so our own write doesn't look external.
    fn persist(&self, cfg: &ScopeConfig) -> Result<(), String> {
        cfg.save(&self.path)?;
        if let Ok(mut m) = self.loaded_mtime.lock() {
            *m = mtime_ms(&self.path);
        }
        Ok(())
    }

    /// Reload the config from disk IF the file changed underneath us (an external `bsc log set`).
    /// Cheap: an mtime stat, then a read only on a real change. Called by the background poll.
    pub fn reload_if_changed(&self) {
        let disk = mtime_ms(&self.path);
        let last = self.loaded_mtime.lock().map(|m| *m).unwrap_or(0);
        if disk == last || disk == 0 {
            return;
        }
        let fresh = ScopeConfig::load(&self.path);
        if let Ok(mut guard) = self.cfg.write() {
            *guard = fresh;
        }
        if let Ok(mut m) = self.loaded_mtime.lock() {
            *m = disk;
        }
    }
}

/// The dual-sink global logger. `file` is a lazily-opened append handle (opened on first record so a
/// missing log dir at install time is tolerated); `registry` gates the console sink.
pub struct GraphLogger {
    registry: Arc<ScopeRegistry>,
    file: Mutex<Option<std::fs::File>>,
    file_path: PathBuf,
}

/// Escape the C0 control bytes that would make the log file BINARY to `grep`, leaving everything else
/// byte-faithful.
///
/// A single NUL anywhere in the file makes `grep` classify it as binary and print NOTHING — not
/// "no match", literally no output and exit 1, with no note on stderr. For the system of record that is
/// uniquely bad, because it is indistinguishable from the content having rotated away; it cost real
/// minutes mid-P0 before anyone thought to add `-a`. MEASURED on a 1.6 MB app log: 15 NUL bytes made 331
/// matching lines invisible.
///
/// THE NULs ARE LEGITIMATE CONTENT, not corruption — which is why the fix belongs here rather than at
/// the caller. Rollup/Vite marks a VIRTUAL MODULE by prefixing its id with `\0`, so the graph loader's
/// "declined the graph override for `\0graph-entry`" is faithfully reporting the id it was given. Any
/// future sink of PTY or subprocess text can do the same, so the guard is at the one place every file
/// line passes.
///
/// `\t` is kept: it is legal in a text file and `grep` does not object. `\n` never reaches here inside a
/// line — it is the record separator.
fn escape_control_bytes(line: &str) -> std::borrow::Cow<'_, str> {
    if !line.bytes().any(|b| b < 0x20 && b != b'\t' && b != b'\n') {
        return std::borrow::Cow::Borrowed(line);
    }
    let mut out = String::with_capacity(line.len() + 8);
    for c in line.chars() {
        match c {
            '\t' | '\n' => out.push(c),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    std::borrow::Cow::Owned(out)
}

impl GraphLogger {
    fn plain_line(ts: &str, level: log::Level, target: &str, message: &str) -> String {
        format!("{ts} {level:<5} {target} {message}\n")
    }

    fn color_line(ts: &str, record: &log::Record) -> String {
        format!(
            "\x1b[90m{ts}\x1b[0m {color}{level:<5}\x1b[0m \x1b[90m{target}\x1b[0m {message}",
            color = crate::app::run::level_color(record.level()),
            level = record.level(),
            target = record.target(),
            message = record.args(),
        )
    }

    /// Append one plain line to the app log file (opening it lazily). Best-effort — a file error
    /// never breaks the process or blocks the console sink.
    fn write_file(&self, line: &str) {
        let Ok(mut slot) = self.file.lock() else { return };
        if slot.is_none() {
            if let Some(dir) = self.file_path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            *slot = std::fs::OpenOptions::new().create(true).append(true).open(&self.file_path).ok();
        }
        if let Some(f) = slot.as_mut() {
            use std::io::Write;
            // Escaped at the SINK so the file is always a text file, whatever a caller logs.
            let _ = f.write_all(escape_control_bytes(line).as_bytes());
        }
    }
}

impl log::Log for GraphLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        // The file baseline is Debug; we never emit Trace. `set_max_level(Debug)` already filters
        // Trace before this, but be explicit so a direct `log(record)` call is bounded too.
        (metadata.level() as u8) <= FILE_RANK
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let rank = record.level() as u8;
        let target = record.target();
        let ts = time::OffsetDateTime::now_utc()
            .format(&time::macros::format_description!("[hour]:[minute]:[second]"))
            .unwrap_or_default();

        // 1) FILE — always (system of record; ungated). Plain, one line, cheap.
        self.write_file(&Self::plain_line(&ts, record.level(), target, &record.args().to_string()));

        // 2) CONSOLE — gated by the runtime scope graph.
        if self.registry.permits(target, rank) {
            println!("{}", Self::color_line(&ts, record));
        }
    }

    fn flush(&self) {
        if let Ok(mut slot) = self.file.lock() {
            if let Some(f) = slot.as_mut() {
                use std::io::Write;
                let _ = f.flush();
            }
        }
    }
}

/// Install the `GraphLogger` as the process-global `log` logger, writing to `file_path` and gating
/// the console via `registry`. Idempotent-safe: a second `set_boxed_logger` just errors (ignored).
/// Sets the max level to `Debug` (the file baseline; Trace is dropped).
pub fn install(registry: Arc<ScopeRegistry>, file_path: PathBuf) {
    let logger = GraphLogger { registry, file: Mutex::new(None), file_path };
    if log::set_boxed_logger(Box::new(logger)).is_ok() {
        log::set_max_level(log::LevelFilter::Debug);
    }
}

// ── Tauri commands (#1389 surface 2) ─────────────────────────────────────────────────────────────

/// One scope node for the frontend graph UI: the tree key + its console policy label.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeNode {
    /// The tree key (`""` = the global root; `base_studio_code_lib::fleet` = the fleet subtree).
    pub scope: String,
    /// The console policy: `off`|`error`|`warn`|`info`|`debug`|`trace`.
    pub level: String,
}

/// The current scope graph — every configured key + its console level, sorted (stable `BTreeMap`
/// order). Backs the graph UI panel + `bsc log list`'s desktop equivalent.
#[tauri::command]
pub fn log_get_scopes(registry: State<Arc<ScopeRegistry>>) -> Vec<ScopeNode> {
    registry
        .snapshot()
        .scopes
        .into_iter()
        .map(|(scope, level)| ScopeNode { scope, level: level.label().to_string() })
        .collect()
}

/// Set a scope's console level (or `off`). `scope` accepts the app-subsystem shorthand (`fleet`,
/// `console::pty`) or `root`/`all`; `level` is `off|error|warn|info|debug|trace`. Persists live so a
/// concurrent `bsc log`/console session sees the same graph.
#[tauri::command]
pub fn log_set_scope(scope: String, level: String, registry: State<Arc<ScopeRegistry>>) -> Result<(), String> {
    let lvl = ScopeLevel::parse(&level)
        .ok_or_else(|| format!("unknown level '{level}' (off|error|warn|info|debug|trace)"))?;
    registry.set(&scope, lvl)
}

/// Restore the built-in default graph (root=warn, app crate=info).
#[tauri::command]
pub fn log_reset_scopes(registry: State<Arc<ScopeRegistry>>) -> Result<(), String> {
    registry.reset()
}

/// The frontend log bridge (#1389 surface: frontend parity): every frontend record routes through the
/// SAME `GraphLogger`, so it is **always** audited to the file sink and its console (devtools/stdout)
/// output is gated by the same scope graph. `scope` is a frontend feature name (`planner`, `core`, …),
/// namespaced under `…::frontend::<scope>` so it joins the one tree; `level` is `error|warn|info|debug`.
#[tauri::command]
pub fn frontend_log(level: String, scope: String, message: String) {
    // PROOF OF LIFE for the renderer watchdog. The frontend already calls this every ~2s with its
    // perf line, so the heartbeat costs nothing extra — no new IPC, no frontend change.
    super::renderer_watch::alive();
    let lvl = match level.trim().to_ascii_lowercase().as_str() {
        "error" => log::Level::Error,
        "warn" | "warning" => log::Level::Warn,
        "debug" => log::Level::Debug,
        _ => log::Level::Info,
    };
    // Build the tree target: `base_studio_code_lib::frontend::<scope>` (bare `frontend` when empty).
    let leaf = scope.trim();
    let target = if leaf.is_empty() {
        normalize_scope("frontend")
    } else {
        normalize_scope(&format!("frontend::{leaf}"))
    };
    // Route through the global logger so the file sink + the console gate both apply. `target` must
    // be a real expression for the macro; give it a slot the logger reads verbatim.
    log::log!(target: target.as_str(), lvl, "{message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        std::env::temp_dir().join(format!(
            "graphlog-{name}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ))
    }


    /// THE FAILURE THIS PREVENTS, stated as the thing that actually happened: 15 NUL bytes in a 1.6 MB app
    /// log made `grep` treat the SYSTEM OF RECORD as binary, so a pattern present on 331 lines printed
    /// NOTHING and exited 1 — with no stderr note, indistinguishable from the content having rotated away.
    #[test]
    fn a_nul_byte_is_escaped_so_the_log_stays_a_text_file() {
        // The real line: Rollup marks a VIRTUAL MODULE by prefixing its id with NUL, so this is faithful
        // content rather than corruption.
        let line = "WARN declined the graph override for \"\0graph-entry\"\n";
        let out = escape_control_bytes(line);
        assert!(!out.contains('\0'), "no raw NUL may reach the file: {out:?}");
        assert!(out.contains("\\x00graph-entry"), "the id stays LEGIBLE, not dropped: {out}");
        // The rest of the line is untouched, so the escape costs nothing a reader needs.
        assert!(out.contains("declined the graph override"));
        assert!(out.ends_with('\n'), "the record separator survives");
    }

    /// An ordinary line is passed through BORROWED — no allocation, and byte-faithful.
    #[test]
    fn an_ordinary_line_is_untouched() {
        let line = "INFO something happened\twith a tab\n";
        let out = escape_control_bytes(line);
        assert!(matches!(out, std::borrow::Cow::Borrowed(_)), "no copy for a clean line");
        assert_eq!(out, line, "a TAB is legal in a text file and must survive");
    }

    /// Every other C0 byte goes too — an ANSI escape or a stray CR would not make the file binary, but a
    /// half-written control sequence in the middle of a record is noise a reader never needs.
    #[test]
    fn other_control_bytes_are_escaped_and_utf8_is_not() {
        let out = escape_control_bytes("a\u{1}b\u{1b}c\rd\n");
        assert_eq!(out, "a\\x01b\\x1bc\\x0dd\n");
        // Multi-byte UTF-8 is NOT a control byte and must pass through — the log is full of em dashes.
        let em = "declined — because it threw\n";
        assert_eq!(escape_control_bytes(em), em);
    }


    /// END TO END, through the real sink: a message carrying a NUL must leave the FILE free of one.
    ///
    /// The unit test above covers the escape; this covers the wiring, which is the half that was missing —
    /// the escape existing somewhere is not the same as every file line passing through it.
    #[test]
    fn the_file_never_receives_a_nul_even_when_the_message_carries_one() {
        let dir = tmp("nul");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("base-studio-code.log");
        let reg = ScopeRegistry::new(dir.join("log-scopes.json"));
        let logger = GraphLogger { registry: reg, file: Mutex::new(None), file_path: path.clone() };

        // The real message, verbatim: Rollup prefixes a VIRTUAL MODULE id with NUL.
        logger.write_file(&GraphLogger::plain_line(
            "00:00:00",
            log::Level::Warn,
            "base_studio_code_lib::frontend::graph-loader",
            "declined the graph override for \"\0graph-entry\"",
        ));

        let raw = std::fs::read(&path).unwrap();
        assert!(!raw.contains(&0), "a raw NUL reached the file — grep will call the whole log binary");
        let text = String::from_utf8(raw).expect("the log is valid UTF-8");
        assert!(text.contains("\\x00graph-entry"), "the id is escaped, not dropped: {text}");
        assert!(text.contains("declined the graph override"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_sink_records_even_when_console_scope_is_off() {
        // THE SECURITY TEST (#1389): a scope toggled OFF silences the console VIEW but the file sink
        // still contains the record. We exercise the file-write + gate decision directly (installing a
        // global logger twice across tests isn't possible).
        let dir = tmp("sec");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("base-studio-code.log");
        let reg = ScopeRegistry::new(dir.join("log-scopes.json"));
        reg.set("fleet", ScopeLevel::Off).unwrap();

        let logger = GraphLogger { registry: reg.clone(), file: Mutex::new(None), file_path: path.clone() };
        let target = "base_studio_code_lib::fleet::director";
        // The console gate says "hidden"…
        assert!(!logger.registry.permits(target, log::Level::Warn as u8), "console silenced");
        // …but the file sink writes it unconditionally.
        logger.write_file(&GraphLogger::plain_line("00:00:00", log::Level::Warn, target, "fleet churn"));
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("fleet churn"), "the audit record persists despite the off scope");
        assert!(contents.contains(target));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn registry_reloads_on_external_write() {
        // A `bsc log set` writes the shared file; the poll's `reload_if_changed` must pick it up.
        let dir = tmp("reload");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("log-scopes.json");
        let reg = ScopeRegistry::new(path.clone());
        assert!(reg.permits("base_studio_code_lib::github::api", log::Level::Info as u8), "info shows by default");

        // Simulate an external writer (the CLI) turning github off. The registry loaded a
        // non-existent file at construction (mtime 0), so any write yields a strictly newer mtime.
        let mut cfg = ScopeConfig::default();
        cfg.set("github", ScopeLevel::Off);
        cfg.save(&path).unwrap();

        reg.reload_if_changed();
        assert!(!reg.permits("base_studio_code_lib::github::api", log::Level::Info as u8), "reloaded: github now off");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_and_reset_persist_to_disk() {
        let dir = tmp("persist");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("log-scopes.json");
        let reg = ScopeRegistry::new(path.clone());
        reg.set("planner", ScopeLevel::Off).unwrap();
        // A fresh registry loading the same file sees the change (persistence round-trip).
        let reg2 = ScopeRegistry::new(path.clone());
        assert!(!reg2.permits("base_studio_code_lib::planner::prompts", log::Level::Info as u8));
        reg.reset().unwrap();
        let reg3 = ScopeRegistry::new(path.clone());
        assert!(reg3.permits("base_studio_code_lib::planner::prompts", log::Level::Info as u8), "reset restored info");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
