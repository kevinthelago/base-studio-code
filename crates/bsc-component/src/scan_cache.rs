//! Component scan cache (#the-component-scan-remembers-what-it-already-built) — what the Design Studio's
//! preview sweep already concluded, per component, keyed by the SOURCE it concluded it about.
//!
//! WHY THIS EXISTS. `useComponentScan` esbuild-bundles every component in the active kit and runs each in
//! a hidden iframe to find preview errors. Its "already scanned" memory was `scannedSigs`, a React ref, so
//! it lived exactly as long as the mount — and `componentBuildStatus` is deliberately not persisted. Every
//! app start therefore re-bundled the whole kit on the first visit. Measured on a 459-component kit: 770
//! jank events, worst single block 261ms, **111.8 seconds** of total main-thread blocking (~25% of
//! wall-clock while the sweep ran), heap peaking at 2.25GB. That is the "initial loading time" the
//! maintainer reported.
//!
//! WHY NOT ZUSTAND PERSIST. #3610 already tried it and removed it with numbers: persist re-serializes the
//! WHOLE state on every store write, which cost "~57 MB of stringify+fsync on the main thread for a scan
//! that touches `componentBuildStatus`" (`persist.ts`). A cache whose write path costs more than the work
//! it saves is not a cache. This is a `bsc` store instead — one file, written once per batched flush —
//! which is also the standing rule that app state lives in `bsc` and the persist layer is only a cache.
//!
//! THE SIGNATURE IS PART OF THE KEY, not a field beside it. The question this store answers is not "has
//! this component been scanned" but "has THIS SOURCE been scanned" — so an edited component re-scans while
//! an untouched one never does. An entry whose `sig` no longer matches is simply not a hit.
//!
//! Shape: `{"<component-id>": {"sig": "...", "status": {...}, "stateBlanks": [...]}}` — `status` and
//! `stateBlanks` are stored VERBATIM as the frontend's own JSON, because this store is a courier for them
//! and inventing a Rust mirror of `ComponentBuildStatus` would be a second definition free to drift from
//! the one that matters (`componentScan.ts`).

use serde_json::{Map, Value};
use std::path::PathBuf;

/// The cache path — `$BSC_SCAN_CACHE` when set (tests / an explicit override), else
/// `~/.base-studio-code/component-scan.json`.
fn cache_path() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("BSC_SCAN_CACHE") {
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    bsc_util::bsc_base_dir()
        .map(|b| b.join("component-scan.json"))
        .ok_or_else(|| "could not resolve ~/.base-studio-code (set HOME/USERPROFILE or BSC_SCAN_CACHE)".to_string())
}

/// Every cached entry, keyed by component id. Best-effort by design: a missing, unreadable or malformed
/// cache yields an EMPTY map, which makes the caller scan everything — exactly the behaviour before this
/// store existed.
///
/// That asymmetry is the whole safety argument. This cache may only ever save work; it must never be able
/// to withhold a scan that should have run, because a withheld scan shows a stale badge (or none) on a
/// component that is actually broken.
pub fn load() -> Map<String, Value> {
    cache_path().map(|p| load_from(&p)).unwrap_or_default()
}

fn load_from(path: &std::path::Path) -> Map<String, Value> {
    let Ok(text) = std::fs::read_to_string(path) else { return Map::new() };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(o)) => o,
        _ => Map::new(),
    }
}

/// Merge `entries` into the cache and write it back. Existing ids not mentioned are PRESERVED — the sweep
/// flushes in batches (#4132) and each flush carries only the components it just finished, so a
/// replace-wholesale write would discard everything scanned earlier in the same visit.
pub fn put(entries: Map<String, Value>) -> Result<(), String> {
    let path = cache_path()?;
    put_to(&path, entries)
}

fn put_to(path: &std::path::Path, entries: Map<String, Value>) -> Result<(), String> {
    let mut all = load_from(path);
    for (id, entry) in entries {
        all.insert(id, entry);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("scan cache: {e}"))?;
    }
    let json = serde_json::to_string(&Value::Object(all)).map_err(|e| format!("scan cache: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("scan cache: {e}"))
}

/// Drop the whole cache — the escape hatch for a caller that wants the next visit to rebuild everything
/// (a suspected stale badge, a toolchain change the signature cannot see). Absent file ⇒ Ok.
pub fn clear() -> Result<(), String> {
    let path = cache_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("scan cache: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("bsc-scan-cache-{}-{}.json", std::process::id(), tag));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn entry(sig: &str) -> Value {
        json!({ "sig": sig, "status": { "state": "ok" }, "stateBlanks": [] })
    }

    #[test]
    fn round_trips_entries_by_id() {
        let p = scratch("round");
        let mut m = Map::new();
        m.insert("button".into(), entry("abc"));
        put_to(&p, m).unwrap();

        let back = load_from(&p);
        assert_eq!(back.len(), 1);
        assert_eq!(back["button"]["sig"], "abc");
        // The status rides VERBATIM — this store is a courier for the frontend's own shape.
        assert_eq!(back["button"]["status"]["state"], "ok");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn a_flush_merges_rather_than_replacing_what_earlier_flushes_wrote() {
        // The sweep flushes in batches, so each write carries only the components it just finished.
        // Replacing wholesale would discard everything scanned earlier in the same visit — turning a
        // cache into a record of the last 150ms.
        let p = scratch("merge");
        let mut first = Map::new();
        first.insert("a".into(), entry("1"));
        put_to(&p, first).unwrap();

        let mut second = Map::new();
        second.insert("b".into(), entry("2"));
        put_to(&p, second).unwrap();

        let all = load_from(&p);
        assert_eq!(all.len(), 2, "the earlier flush survives the later one");
        assert_eq!(all["a"]["sig"], "1");
        assert_eq!(all["b"]["sig"], "2");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn a_re_scan_of_the_same_id_overwrites_its_entry() {
        // An edited component scans again and its NEW signature must replace the old one, or the stale
        // entry would keep answering for source that no longer exists.
        let p = scratch("overwrite");
        let mut first = Map::new();
        first.insert("a".into(), entry("old"));
        put_to(&p, first).unwrap();
        let mut second = Map::new();
        second.insert("a".into(), entry("new"));
        put_to(&p, second).unwrap();

        let all = load_from(&p);
        assert_eq!(all.len(), 1);
        assert_eq!(all["a"]["sig"], "new");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn every_unreadable_shape_degrades_to_an_empty_cache_not_an_error() {
        // The load-bearing asymmetry: a broken cache must make the caller scan EVERYTHING, never make it
        // skip a scan. Each of these is a state a half-written or hand-edited file can genuinely be in.
        let p = scratch("garbage");
        assert!(load_from(&p).is_empty(), "absent file");
        for text in ["", "not json", "[1,2,3]", "\"a string\"", "null", "{"] {
            std::fs::write(&p, text).unwrap();
            assert!(load_from(&p).is_empty(), "malformed: {text:?}");
        }
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn clear_removes_the_cache_and_is_a_no_op_when_absent() {
        let p = scratch("clear");
        let mut m = Map::new();
        m.insert("a".into(), entry("1"));
        put_to(&p, m).unwrap();
        assert!(p.is_file());
        std::fs::remove_file(&p).unwrap();
        assert!(load_from(&p).is_empty());
    }
}
