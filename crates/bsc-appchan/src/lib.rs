//! `bsc-appchan` (#3274, epic #3260) — the **one** channel for asking the RUNNING desktop app to do
//! something: capture a shot (#3261), navigate to a view (#3274), and whatever comes next.
//!
//! ## Why a file channel
//! `bsc` cannot call the app: the bridge only runs app→`bsc` (the app invokes the CLI, never the
//! reverse). `bsc ui theme active` is the precedent for the read direction — it reads the persisted
//! `app-state.json` and never writes it. So a request rides a directory both sides watch, exactly the
//! shape `coord.log` already uses.
//!
//! ## Why ONE channel
//! #3261 shipped this transport inside `bsc-shot`. Adding navigate could have meant a second dir + a
//! second watcher — the "superseded but never removed" duplication removed twice in one day (#3244
//! tunnel bindings, #3251 gesture-forward). So the transport lives here, generic over its payload, and
//! each verb crate owns only its own request/reply shapes. One dir, one watcher, routed by [`Envelope::kind`].
//!
//! ## Contract
//! - An [`Envelope`] carries `{ id, kind, at, payload }`; the payload is opaque to the transport.
//! - The app answers with a [`Reply`] carrying `{ id, error?, payload, at }` — **always**. A request that
//!   fails must SAY so; silence is indistinguishable from "the app isn't running", which sends the caller
//!   debugging the wrong thing.
//! - Requests and replies are written to a `.tmp` and renamed, so a watcher can never read a half-written
//!   file (rename is atomic within a directory on every platform we ship).

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One ask, written by a CLI for the app's watcher to pick up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    /// Correlates the request with its reply. Unique per invocation.
    pub id: String,
    /// Routes it to a handler — `"shot"`, `"navigate"`, …
    pub kind: String,
    /// ms-epoch stamp; also what [`sweep_stale`] ages out.
    pub at: i64,
    /// The verb's own request, opaque to the transport.
    pub payload: serde_json::Value,
}

/// The app's answer. Carries EITHER `error` or a `payload` — never neither.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reply {
    pub id: String,
    /// A human-readable failure. `None` on success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The verb's own result. `Null` when `error` is set.
    #[serde(default)]
    pub payload: serde_json::Value,
    pub at: i64,
}

impl Reply {
    pub fn ok<T: Serialize>(id: &str, payload: &T, at: i64) -> Self {
        Self {
            id: id.to_string(),
            error: None,
            payload: serde_json::to_value(payload).unwrap_or(serde_json::Value::Null),
            at,
        }
    }

    pub fn err(id: &str, error: &str, at: i64) -> Self {
        Self { id: id.to_string(), error: Some(error.to_string()), payload: serde_json::Value::Null, at }
    }
}

/// `~/.base-studio-code/appreq/` — the channel. Overridable via `BSC_APPCHAN_DIR` so a test (or a
/// second install) can point elsewhere.
///
/// Deliberately NOT the shots dir: that holds ARTIFACTS (PNGs the caller owns). Mixing transport files
/// with output would make "sweep the channel" and "delete my screenshots" the same operation.
pub fn chan_dir() -> Result<PathBuf, String> {
    if let Ok(d) = std::env::var("BSC_APPCHAN_DIR") {
        if !d.trim().is_empty() {
            return Ok(PathBuf::from(d));
        }
    }
    let base = bsc_util::bsc_base_dir().ok_or_else(|| "cannot resolve the ~/.base-studio-code dir".to_string())?;
    Ok(base.join("appreq"))
}

/// A per-invocation id: ms-epoch + pid. Unique enough for a directory channel without pulling in `rand`
/// — two CLI calls in the same millisecond come from different processes.
pub fn new_id(now_ms: i64) -> String {
    format!("{now_ms:x}-{:x}", std::process::id())
}

pub fn request_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.req.json"))
}

pub fn reply_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.res.json"))
}

/// Write a request; the app answers BESIDE it and the caller polls.
pub fn write_request<T: Serialize>(dir: &Path, id: &str, kind: &str, at: i64, payload: &T) -> Result<Envelope, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let env = Envelope {
        id: id.to_string(),
        kind: kind.to_string(),
        at,
        payload: serde_json::to_value(payload).map_err(|e| e.to_string())?,
    };
    write_atomic(&request_path(dir, id), &serde_json::to_vec_pretty(&env).map_err(|e| e.to_string())?)?;
    Ok(env)
}

/// Write a reply (the app watcher's side).
pub fn write_reply(dir: &Path, reply: &Reply) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let path = reply_path(dir, &reply.id);
    write_atomic(&path, &serde_json::to_vec_pretty(reply).map_err(|e| e.to_string())?)?;
    Ok(path)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot rename into {}: {e}", path.display()))?;
    Ok(())
}

pub fn read_request(path: &Path) -> Result<Envelope, String> {
    let s = std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    serde_json::from_str(&s).map_err(|e| format!("malformed request {}: {e}", path.display()))
}

pub fn read_reply(dir: &Path, id: &str) -> Result<Option<Reply>, String> {
    let path = reply_path(dir, id);
    match std::fs::read_to_string(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
        Ok(s) => serde_json::from_str(&s).map(Some).map_err(|e| format!("malformed reply {}: {e}", path.display())),
    }
}

/// Every pending request (a `.req.json` with no reply beside it), oldest first — the watcher's read.
/// A malformed request is SKIPPED rather than failing the sweep, so one bad file cannot wedge the
/// watcher for every other caller.
pub fn pending(dir: &Path) -> Result<Vec<Envelope>, String> {
    let rd = match std::fs::read_dir(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("cannot list {}: {e}", dir.display())),
        Ok(rd) => rd,
    };
    let mut out: Vec<Envelope> = vec![];
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.to_string_lossy().ends_with(".req.json") {
            continue;
        }
        let Ok(env) = read_request(&path) else { continue };
        if reply_path(dir, &env.id).exists() {
            continue; // already answered
        }
        out.push(env);
    }
    out.sort_by_key(|e| e.at);
    Ok(out)
}

/// Block until the app replies to `id`, or `timeout_ms` elapses. `on_timeout` builds the error so each
/// verb can name its own likely cause.
pub fn poll_reply(
    dir: &Path,
    id: &str,
    timeout_ms: i64,
    interval_ms: u64,
    on_timeout: impl FnOnce() -> String,
) -> Result<Reply, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms.max(0) as u64);
    loop {
        if let Some(r) = read_reply(dir, id)? {
            return Ok(r);
        }
        if std::time::Instant::now() >= deadline {
            return Err(on_timeout());
        }
        std::thread::sleep(std::time::Duration::from_millis(interval_ms));
    }
}

/// Deserialize a reply's payload into the verb's own result type, surfacing `error` first.
pub fn take_payload<T: DeserializeOwned>(reply: Reply) -> Result<T, String> {
    if let Some(e) = reply.error {
        return Err(e);
    }
    serde_json::from_value(reply.payload).map_err(|e| format!("the app answered with an unreadable payload: {e}"))
}

/// Drop request/reply files older than `max_age_ms`, so an abandoned CLI (Ctrl-C'd mid-poll) or a
/// request made while no app was running cannot accumulate — or be served later to nobody.
/// Only channel files are swept; anything else in the dir is left alone.
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
            continue;
        }
        let stale = read_request(&path)
            .map(|e| now_ms - e.at > max_age_ms)
            // Not a request (a reply / a stray .tmp): age it by mtime instead.
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct Demo {
        a: u32,
    }

    #[test]
    fn round_trips_a_typed_payload_through_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        write_request(dir.path(), "x", "shot", 5, &Demo { a: 7 }).unwrap();
        let env = read_request(&request_path(dir.path(), "x")).unwrap();
        assert_eq!((env.kind.as_str(), env.at), ("shot", 5));
        assert_eq!(serde_json::from_value::<Demo>(env.payload).unwrap(), Demo { a: 7 });
    }

    #[test]
    fn a_request_lands_atomically_leaving_no_tmp_behind() {
        // The watcher must never observe a half-written request.
        let dir = tempfile::tempdir().unwrap();
        write_request(dir.path(), "a", "shot", 1, &Demo { a: 1 }).unwrap();
        let names: Vec<String> =
            std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec!["a.req.json"]);
    }

    #[test]
    fn pending_routes_by_kind_oldest_first_and_drops_answered_requests() {
        let dir = tempfile::tempdir().unwrap();
        write_request(dir.path(), "late", "navigate", 20, &Demo { a: 1 }).unwrap();
        write_request(dir.path(), "early", "shot", 10, &Demo { a: 2 }).unwrap();
        write_request(dir.path(), "done", "shot", 5, &Demo { a: 3 }).unwrap();
        write_reply(dir.path(), &Reply::ok("done", &Demo { a: 3 }, 6)).unwrap();

        let got: Vec<(String, String)> =
            pending(dir.path()).unwrap().into_iter().map(|e| (e.id, e.kind)).collect();
        assert_eq!(
            got,
            vec![("early".to_string(), "shot".to_string()), ("late".to_string(), "navigate".to_string())],
            "one dir carries both verbs; answered requests are not re-served"
        );
    }

    #[test]
    fn a_malformed_request_is_skipped_rather_than_wedging_the_watcher() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("junk.req.json"), b"{not json").unwrap();
        write_request(dir.path(), "good", "shot", 1, &Demo { a: 1 }).unwrap();
        let ids: Vec<String> = pending(dir.path()).unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec!["good"], "one bad file must not starve every other caller");
    }

    #[test]
    fn pending_on_a_missing_dir_is_empty_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(pending(&dir.path().join("nope")).unwrap().is_empty());
    }

    #[test]
    fn take_payload_surfaces_the_error_ahead_of_the_payload() {
        let r = Reply::err("a", "unsupported", 1);
        assert_eq!(take_payload::<Demo>(r).unwrap_err(), "unsupported");
        let r = Reply::ok("a", &Demo { a: 9 }, 1);
        assert_eq!(take_payload::<Demo>(r).unwrap(), Demo { a: 9 });
    }

    #[test]
    fn poll_returns_as_soon_as_the_reply_appears_and_errors_on_timeout() {
        let dir = tempfile::tempdir().unwrap();
        write_reply(dir.path(), &Reply::ok("a", &Demo { a: 1 }, 1)).unwrap();
        assert!(poll_reply(dir.path(), "a", 1_000, 5, || "nope".into()).is_ok());

        let err = poll_reply(dir.path(), "absent", 30, 5, || "MY REASON".into()).unwrap_err();
        assert_eq!(err, "MY REASON", "each verb names its own likely cause");
    }

    #[test]
    fn sweep_drops_aged_channel_files_but_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        write_request(dir.path(), "old", "shot", 0, &Demo { a: 1 }).unwrap();
        write_request(dir.path(), "fresh", "shot", 9_000, &Demo { a: 2 }).unwrap();
        std::fs::write(dir.path().join("keep.png"), b"pixels").unwrap();

        let n = sweep_stale(dir.path(), 10_000, 5_000).unwrap();
        assert_eq!(n, 1);
        assert!(!request_path(dir.path(), "old").exists());
        assert!(request_path(dir.path(), "fresh").exists());
        assert!(dir.path().join("keep.png").exists(), "a non-channel file is not the transport's to delete");
    }

    #[test]
    fn ids_are_unique_and_filename_safe() {
        let a = new_id(1_700_000_000_000);
        assert!(!a.contains(['/', '\\', ':', ' ']), "an id becomes a filename");
        assert_ne!(new_id(1), new_id(2));
    }
}
