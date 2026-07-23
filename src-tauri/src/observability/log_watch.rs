//! Log-stream change watcher (#3638) — the "flag" half of the event-driven log system (Phase 1).
//!
//! The frontend used to POLL each unified log stream (`useCoordLog`, the pane-activity poll,
//! `useWorkerAutoEnd`, `uiActivity`, …) every ~1s. Instead, this ONE cheap backend loop stats each
//! reader stream's mtime under `logs::log_dir()` and emits `logs://<stream>` when it advances; the
//! frontend re-reads in-process (#3630) only on that event, so an idle app makes zero log reads. Cost
//! is ~10 file stats per tick and no reads.
//!
//! It mirrors the scope-registry reload poller already in `run()` (a cheap stat-and-notify loop) and
//! adds no dependency. A true `notify` FS-watch could replace the stat-loop later with NO frontend
//! change — the contract is the `logs://<stream>` event, not how the change is detected.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter};

/// The Tauri event a stream's change is announced on. MUST stay in sync with the frontend
/// `logEventName` (`src/shared/lib/core/logsBridge.ts`). Keyed by the CANONICAL stream name
/// (`logs::canonical_stream`) — `coord`/`activity`/`done`/`ui`/`tool`/….
pub fn event_name(stream: &str) -> String {
    format!("logs://{stream}")
}

/// How often the watcher stats the stream files. 300ms → sub-second update latency (well under the
/// old ~1s poll) while keeping the stat rate trivial (~10 files × ~3/s).
const TICK: Duration = Duration::from_millis(300);

/// Whether a stream's mtime transition warrants an event: it ADVANCED or APPEARED — not an unchanged
/// mtime, and not a deletion (`now == None`, which just resets the baseline). Pure, so the emit rule is
/// unit-testable without touching the filesystem or the clock.
fn should_emit(prev: Option<SystemTime>, now: Option<SystemTime>) -> bool {
    now.is_some() && prev != now
}

/// Spawn the log-stream mtime watcher for the app's lifetime (call once from `run()`'s setup). Seeds a
/// baseline of the current mtimes so it only emits on changes AFTER boot — the frontend does its own
/// initial read on mount, so there's no boot burst.
pub fn spawn(app: AppHandle) {
    let dir = ::logs::log_dir();
    // (canonical stream key → its absolute file path) for every READER stream (the ones the UI reads).
    let files: Vec<(&'static str, PathBuf)> = ::bsc_util::log_streams::reader_streams()
        .into_iter()
        .map(|(key, file)| (key, dir.join(file)))
        .collect();

    tauri::async_runtime::spawn(async move {
        let mtime = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        // Seed the baseline with the boot-time mtimes so the first real change (not the pre-existing
        // file) is what triggers the first event.
        let mut last: HashMap<&'static str, Option<SystemTime>> =
            files.iter().map(|(k, p)| (*k, mtime(p))).collect();
        loop {
            tokio::time::sleep(TICK).await;
            for (key, path) in &files {
                let now = mtime(path);
                // `insert` returns the previous value (always `Some(..)` — the map is seeded with every
                // key); `.flatten()` unwraps to the last-seen mtime.
                let prev = last.insert(*key, now).flatten();
                if should_emit(prev, now) {
                    // Fire-and-forget; a webview that isn't ready yet simply misses it (the frontend's
                    // mount-time read + slow safety-net poll cover any gap).
                    let _ = app.emit(&event_name(key), ());
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_name_is_the_canonical_logs_scheme() {
        assert_eq!(event_name("coord"), "logs://coord");
        assert_eq!(event_name("activity"), "logs://activity");
        assert_eq!(event_name("tool"), "logs://tool");
    }

    #[test]
    fn should_emit_only_on_advance_or_appearance() {
        let t0 = SystemTime::UNIX_EPOCH;
        let t1 = t0 + Duration::from_secs(1);
        assert!(should_emit(None, Some(t0)), "a file appearing is a change");
        assert!(should_emit(Some(t0), Some(t1)), "an advanced mtime is a change");
        assert!(!should_emit(Some(t0), Some(t0)), "an unchanged mtime is NOT a change");
        assert!(!should_emit(Some(t0), None), "a deletion resets the baseline, no event");
        assert!(!should_emit(None, None), "still-missing is not a change");
    }

    #[test]
    fn every_reader_stream_maps_to_a_canonical_event() {
        // The watcher keys events off the reader-stream registry; each key must round-trip through the
        // same canonicalizer the frontend mirrors, so a subscribed reader always lines up with an emit.
        for (key, _file) in ::bsc_util::log_streams::reader_streams() {
            assert_eq!(::logs::canonical_stream(key), Some(key), "{key} is its own canonical name");
        }
    }
}
