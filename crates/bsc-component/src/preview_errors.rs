//! Preview-error tail (#3165) — a durable, CLI-readable channel for the Design Studio's live preview
//! runtime errors. The preview iframe posts `{__preview:"error", message}` (componentBundle.ts's
//! `window.error`/`unhandledrejection` listeners + the #2926 render probe); `ComponentPreviewFrame`
//! shows it in-pane, but the status was TRANSIENT React/Zustand state (`componentBuildStatus`, explicitly
//! not persisted) — so a preview throw was invisible from a session's shell. This records each captured
//! error to a small JSONL log the frontend appends via `bsc ui preview-error` (over the same `bsc`
//! bridge it already uses) and `bsc ui preview-errors` tails — so an agent debugging a preview can read
//! the last stack trace straight from bash.
//!
//! Format: one JSON object per line — `{"at":"<iso8601>","id":"<component-id>","message":"<trace>"}` —
//! so a multi-line stack trace rides safely (JSON-escaped) on one line. Capped to the last [`CAP`]
//! records so the diagnostic log never grows unbounded.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Keep at most this many records — a rolling window of the most recent preview errors.
const CAP: usize = 200;

/// The log path — `$BSC_PREVIEW_ERROR_LOG` when set (tests / an explicit override), else
/// `~/.base-studio-code/preview-errors.log`.
fn log_path() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("BSC_PREVIEW_ERROR_LOG") {
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    bsc_util::bsc_base_dir()
        .map(|b| b.join("preview-errors.log"))
        .ok_or_else(|| "could not resolve ~/.base-studio-code (set HOME/USERPROFILE or BSC_PREVIEW_ERROR_LOG)".to_string())
}

/// Append a preview-error record for `(id, message)` to the log (capped to the last [`CAP`]).
pub fn record(id: &str, message: &str) -> Result<(), String> {
    record_to(&log_path()?, id, message)
}

/// The last `n` preview-error records (oldest → newest), each a parsed JSON object. Best-effort: an
/// unreachable/empty/absent log yields an empty vec; unparseable lines are skipped.
pub fn tail(n: usize) -> Vec<Value> {
    log_path().map(|p| tail_from(&p, n)).unwrap_or_default()
}

/// Core of [`record`] over an explicit path (unit-testable without touching the process env).
fn record_to(path: &Path, id: &str, message: &str) -> Result<(), String> {
    let rec = json!({ "at": bsc_util::epoch_ms_to_iso8601(bsc_util::now_ms()), "id": id, "message": message });
    let line = serde_json::to_string(&rec).map_err(|e| e.to_string())?;
    let mut lines = read_lines(path);
    lines.push(line);
    let start = lines.len().saturating_sub(CAP);
    write_file(path, &(lines[start..].join("\n") + "\n"))
}

/// Core of [`tail`] over an explicit path. Parses every line, then returns the last `n`.
fn tail_from(path: &Path, n: usize) -> Vec<Value> {
    let mut recs: Vec<Value> =
        read_lines(path).iter().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let start = recs.len().saturating_sub(n);
    recs.split_off(start)
}

/// Non-empty lines of `path` (absent/unreadable ⇒ empty).
fn read_lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect()
}

/// Overwrite `path` with `contents`, creating the parent dir if needed.
fn write_file(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique temp log path per test invocation (nanosecond-stamped) so tests never collide.
    fn temp_log() -> PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("bsc-preview-errors-{n}-{:?}.log", std::thread::current().id()))
    }

    #[test]
    fn record_then_tail_round_trips_newest_last() {
        let path = temp_log();
        record_to(&path, "chart", "TypeError: x is undefined").unwrap();
        record_to(&path, "graph", "NaN in <ChartFrame/>\n  at tick (d3-force)").unwrap();
        let got = tail_from(&path, 10);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["id"], "chart");
        assert_eq!(got[1]["id"], "graph");
        // A multi-line stack trace rides on one JSON line and round-trips verbatim.
        assert_eq!(got[1]["message"], "NaN in <ChartFrame/>\n  at tick (d3-force)");
        assert!(got[1]["at"].as_str().is_some_and(|s| !s.is_empty()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tail_returns_only_the_last_n() {
        let path = temp_log();
        for i in 0..5 {
            record_to(&path, &format!("c{i}"), "boom").unwrap();
        }
        let got = tail_from(&path, 2);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["id"], "c3");
        assert_eq!(got[1]["id"], "c4");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn record_caps_the_log_to_the_last_cap_records() {
        let path = temp_log();
        for i in 0..(CAP + 25) {
            record_to(&path, &format!("c{i}"), "boom").unwrap();
        }
        assert_eq!(read_lines(&path).len(), CAP);
        let got = tail_from(&path, CAP + 100);
        assert_eq!(got.len(), CAP);
        // The OLDEST retained is record #25 (the first 25 rolled off); the newest is the last written.
        assert_eq!(got[0]["id"], "c25");
        assert_eq!(got[CAP - 1]["id"], format!("c{}", CAP + 24));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tail_of_absent_log_is_empty() {
        assert!(tail_from(Path::new("/no/such/bsc-preview-errors-xyz.log"), 5).is_empty());
    }
}
