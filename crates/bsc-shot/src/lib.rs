//! `bsc-shot` (#3261, epic #3260) — the file-based request/response channel `bsc shot` uses to ask the
//! RUNNING desktop app for a **webview snapshot**, so an external session (or an agent) can SEE the app
//! instead of inferring what it looks like.
//!
//! ## Why a file channel
//! `bsc` cannot call the running app: the bridge only runs app→`bsc` (the app invokes the CLI, never the
//! reverse). `bsc ui theme active` is the precedent for the read direction — it reads the persisted
//! `app-state.json` and never writes it. So the request rides a directory both sides can see, exactly the
//! shape `coord.log` already uses: the CLI drops `<id>.req.json`, the app's watcher answers with
//! `<id>.res.json` beside it.
//!
//! ## Why the WEBVIEW, not the DOM and not the screen
//! - **Not `html2canvas`** — it does not screenshot; it re-implements CSS rendering in JS, and it is worst
//!   at exactly what this design system is built from (`color-mix(in oklch, …)`, oklch palettes, `var()`
//!   token indirection, `transform` on `#root`). A design loop whose instrument lies about colour
//!   converges on a hallucination. (It also cannot reach the preview iframe at all — `sandbox="allow-scripts"`,
//!   opaque origin, #2824 — but fidelity is the deciding reason, not the sandbox.)
//! - **Not an OS window grab** — on Windows an occluded/minimized/locked-session capture returns black,
//!   and this exists to run overnight.
//!
//! The webview snapshot is the compositor's own output: pixel-identical to what the user sees, *including*
//! the sandboxed iframe, and a render rather than a screen grab — so occlusion, minimize and screen lock
//! cannot black it out. The sandbox is then kept for free.
//!
//! ## Contract
//! This module is PURE (paths + serde + a poll loop over the filesystem). The platform capture lives in
//! the desktop app; the crate stays Tauri-free so the tiny `bsc` binary can depend on it.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub mod cli;

/// A crop region in CSS pixels, relative to the webview's top-left. Absent ⇒ the whole webview.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// One capture ask, written by `bsc shot` as `<id>.req.json` for the app's watcher to pick up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShotRequest {
    /// Correlates the request with its response file. Unique per invocation.
    pub id: String,
    /// Crop region; `None` ⇒ the whole webview.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rect: Option<Rect>,
    /// Where the PNG should be written. `None` ⇒ the app picks `<shots>/<id>.png`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<String>,
    /// ms-epoch stamp — also what [`sweep_stale`] ages out.
    pub at: i64,
}

/// The app's answer, written as `<id>.res.json`. Carries EITHER `path` or `error`, never neither:
/// a capture that failed must say so rather than leave the CLI waiting out its timeout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShotResponse {
    pub id: String,
    /// The written PNG. `None` when `error` is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// A human-readable failure (unsupported platform, capture error, bad rect). `None` on success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Captured pixel dimensions (after any crop). `None` when `error` is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<u32>,
    pub at: i64,
}

impl ShotResponse {
    /// A success answer for `id`.
    pub fn ok(id: &str, path: &str, w: u32, h: u32, at: i64) -> Self {
        Self { id: id.to_string(), path: Some(path.to_string()), error: None, w: Some(w), h: Some(h), at }
    }

    /// A failure answer for `id`. The CLI surfaces `error` verbatim and exits non-zero.
    pub fn err(id: &str, error: &str, at: i64) -> Self {
        Self { id: id.to_string(), path: None, error: Some(error.to_string()), w: None, h: None, at }
    }
}

/// `~/.base-studio-code/shots/` — where requests, responses and (by default) the PNGs live.
/// Overridable via `BSC_SHOT_DIR` so a test (or a second install) can point elsewhere.
pub fn shots_dir() -> Result<PathBuf, String> {
    if let Ok(d) = std::env::var("BSC_SHOT_DIR") {
        if !d.trim().is_empty() {
            return Ok(PathBuf::from(d));
        }
    }
    let base = bsc_util::bsc_base_dir().ok_or_else(|| "cannot resolve the ~/.base-studio-code dir".to_string())?;
    Ok(base.join("shots"))
}

/// A per-invocation id: ms-epoch + pid. Unique enough for a directory channel without pulling in `rand`
/// — two `bsc shot` calls in the same millisecond come from different processes.
pub fn new_id(now_ms: i64) -> String {
    format!("{now_ms:x}-{:x}", std::process::id())
}

pub fn request_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.req.json"))
}

pub fn response_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.res.json"))
}

/// Default PNG destination when a request carries no `out`.
pub fn default_png_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.png"))
}

/// Write a request. The response file is written by the app BESIDE it; the CLI then polls.
///
/// Written to a `.tmp` and renamed, so the watcher can never read a half-written request (rename is
/// atomic within a directory on every platform we ship).
pub fn write_request(dir: &Path, req: &ShotRequest) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let path = request_path(dir, &req.id);
    write_atomic(&path, &serde_json::to_vec_pretty(req).map_err(|e| e.to_string())?)?;
    Ok(path)
}

/// Write a response (the app watcher's side). Atomic for the same reason as [`write_request`].
pub fn write_response(dir: &Path, res: &ShotResponse) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let path = response_path(dir, &res.id);
    write_atomic(&path, &serde_json::to_vec_pretty(res).map_err(|e| e.to_string())?)?;
    Ok(path)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot rename into {}: {e}", path.display()))?;
    Ok(())
}

pub fn read_request(path: &Path) -> Result<ShotRequest, String> {
    let s = std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    serde_json::from_str(&s).map_err(|e| format!("malformed request {}: {e}", path.display()))
}

pub fn read_response(dir: &Path, id: &str) -> Result<Option<ShotResponse>, String> {
    let path = response_path(dir, id);
    match std::fs::read_to_string(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
        Ok(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|e| format!("malformed response {}: {e}", path.display())),
    }
}

/// Every pending request in `dir` (a `.req.json` with no `.res.json` beside it), oldest first — the
/// app watcher's read. A malformed request is SKIPPED rather than failing the sweep, so one bad file
/// cannot wedge the watcher for every other caller.
pub fn pending_requests(dir: &Path) -> Result<Vec<ShotRequest>, String> {
    let rd = match std::fs::read_dir(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("cannot list {}: {e}", dir.display())),
        Ok(rd) => rd,
    };
    let mut out: Vec<ShotRequest> = vec![];
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.to_string_lossy().ends_with(".req.json") {
            continue;
        }
        let Ok(req) = read_request(&path) else { continue };
        if response_path(dir, &req.id).exists() {
            continue; // already answered
        }
        out.push(req);
    }
    out.sort_by_key(|r| r.at);
    Ok(out)
}

/// Drop request/response pairs older than `max_age_ms`, so an abandoned CLI (Ctrl-C'd mid-poll) or a
/// request made while no app was running cannot accumulate — or wedge the watcher into re-answering a
/// request nobody is waiting for.
pub fn sweep_stale(dir: &Path, now_ms: i64, max_age_ms: i64) -> Result<usize, String> {
    let rd = match std::fs::read_dir(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("cannot list {}: {e}", dir.display())),
        Ok(rd) => rd,
    };
    let mut n = 0;
    for entry in rd.flatten() {
        let path = entry.path();
        let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        if !(name.ends_with(".req.json") || name.ends_with(".res.json") || name.ends_with(".tmp")) {
            continue; // never sweep the PNGs — the caller owns those
        }
        let stale = read_request(&path)
            .map(|r| now_ms - r.at > max_age_ms)
            // Not a request (a response / a stray .tmp): age it by mtime instead.
            .unwrap_or_else(|_| file_age_ms(&path, now_ms).map(|a| a > max_age_ms).unwrap_or(false));
        if stale && std::fs::remove_file(&path).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

fn file_age_ms(path: &Path, now_ms: i64) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let ms = modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
    Some(now_ms - ms)
}

/// PNG magic — the first 8 bytes of every PNG. Used to prove a capture wrote a real image.
pub const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Is `bytes` a PNG? A capture that silently wrote something else (or nothing) must not read as success.
pub fn is_png(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes[..8] == PNG_MAGIC
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(id: &str, at: i64) -> ShotRequest {
        ShotRequest { id: id.to_string(), rect: None, out: None, at }
    }

    #[test]
    fn round_trips_a_request_through_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let r = ShotRequest {
            id: "abc".into(),
            rect: Some(Rect { x: 1, y: 2, w: 3, h: 4 }),
            out: Some("C:/x.png".into()),
            at: 1_000,
        };
        let path = write_request(dir.path(), &r).unwrap();
        assert_eq!(read_request(&path).unwrap(), r);
    }

    #[test]
    fn a_request_lands_atomically_leaving_no_tmp_behind() {
        // The watcher must never observe a half-written request; write_atomic renames into place.
        let dir = tempfile::tempdir().unwrap();
        write_request(dir.path(), &req("a", 1)).unwrap();
        let names: Vec<String> =
            std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec!["a.req.json"]);
    }

    #[test]
    fn read_response_is_none_until_the_app_answers() {
        let dir = tempfile::tempdir().unwrap();
        write_request(dir.path(), &req("a", 1)).unwrap();
        assert_eq!(read_response(dir.path(), "a").unwrap(), None);

        write_response(dir.path(), &ShotResponse::ok("a", "C:/a.png", 800, 600, 2)).unwrap();
        let got = read_response(dir.path(), "a").unwrap().unwrap();
        assert_eq!(got.path.as_deref(), Some("C:/a.png"));
        assert_eq!((got.w, got.h), (Some(800), Some(600)));
        assert!(got.error.is_none());
    }

    #[test]
    fn an_error_response_carries_the_reason_and_no_path() {
        // The unsupported-platform / capture-failed path: it must ANSWER, not leave the CLI to time out.
        let dir = tempfile::tempdir().unwrap();
        write_response(dir.path(), &ShotResponse::err("a", "unsupported on this platform yet", 2)).unwrap();
        let got = read_response(dir.path(), "a").unwrap().unwrap();
        assert_eq!(got.error.as_deref(), Some("unsupported on this platform yet"));
        assert!(got.path.is_none());
    }

    #[test]
    fn pending_lists_unanswered_requests_oldest_first_and_drops_answered_ones() {
        let dir = tempfile::tempdir().unwrap();
        write_request(dir.path(), &req("late", 20)).unwrap();
        write_request(dir.path(), &req("early", 10)).unwrap();
        write_request(dir.path(), &req("done", 5)).unwrap();
        write_response(dir.path(), &ShotResponse::ok("done", "p", 1, 1, 6)).unwrap();

        let ids: Vec<String> = pending_requests(dir.path()).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["early", "late"], "answered requests are not re-served; oldest first");
    }

    #[test]
    fn a_malformed_request_is_skipped_rather_than_wedging_the_watcher() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("junk.req.json"), b"{not json").unwrap();
        write_request(dir.path(), &req("good", 1)).unwrap();
        let ids: Vec<String> = pending_requests(dir.path()).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["good"], "one bad file must not starve every other caller");
    }

    #[test]
    fn pending_on_a_missing_dir_is_empty_not_an_error() {
        // The watcher starts before anyone has ever asked for a shot.
        let dir = tempfile::tempdir().unwrap();
        assert!(pending_requests(&dir.path().join("nope")).unwrap().is_empty());
    }

    #[test]
    fn sweep_drops_aged_requests_but_never_the_pngs() {
        let dir = tempfile::tempdir().unwrap();
        write_request(dir.path(), &req("old", 0)).unwrap();
        write_request(dir.path(), &req("fresh", 9_000)).unwrap();
        std::fs::write(default_png_path(dir.path(), "old"), b"pixels").unwrap();

        let n = sweep_stale(dir.path(), 10_000, 5_000).unwrap();
        assert_eq!(n, 1);
        assert!(!request_path(dir.path(), "old").exists());
        assert!(request_path(dir.path(), "fresh").exists());
        assert!(default_png_path(dir.path(), "old").exists(), "the caller owns the PNGs; sweep must not eat them");
    }

    #[test]
    fn ids_are_unique_per_millisecond_and_hex_safe_for_a_filename() {
        let a = new_id(1_700_000_000_000);
        assert!(!a.contains(['/', '\\', ':', ' ']), "an id becomes a filename");
        assert_ne!(new_id(1), new_id(2));
    }

    #[test]
    fn is_png_accepts_the_magic_and_rejects_a_black_hole() {
        assert!(is_png(&PNG_MAGIC));
        assert!(!is_png(b""), "a capture that wrote nothing must not read as a PNG");
        assert!(!is_png(b"not-an-image"));
    }
}
