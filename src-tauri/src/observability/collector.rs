//! Localhost fault-ingest collector (#2258/#2261) — the ingestion endpoint for the **local** case.
//!
//! A small synchronous HTTP receiver, bound to `127.0.0.1` only (never `0.0.0.0`), started with the
//! app on a background thread. A locally-running generated app POSTs a fault/heartbeat **envelope**
//! (an OTLP-log subset) to it; the collector validates the per-project ingest token, resolves the
//! project's [`error_db_path`], opens the [`errordb::Store`], and `record`s the fault (fingerprinting
//! happens in the store). Heartbeats update an in-memory per-project liveness timestamp (consumed by
//! the slice-4 Glance status, #2263).
//!
//! ## Transport shape
//! One route, `POST /ingest`, discriminated by the envelope's `type` field (`"fault"` — the default —
//! or `"heartbeat"`). Same machine, no NAT, no relay: cloud transport is parked behind this seam
//! (#2258), so the envelope + write path are deliberately transport-agnostic.
//!
//! ## Auth + attribution
//! The db **is** the attribution: one error.db per project. Every envelope carries its `project_key`
//! plus a per-project ingest token (minted on demand by [`CollectorState::ensure_token`] and baked
//! into the generated app at generation, slice 3). An unknown `project_key` → 404; an absent/bad
//! token → 401. Malformed / oversized bodies are rejected without crashing the receiver, and ingest is
//! rate-limited per project (drop-with-count) so a fault storm can't run the disk unbounded.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::{error_db_path, ingest_port_file, ingest_token_path};
use errordb::{FaultInput, Store};

/// Reject a body larger than this before parsing (bytes). A fault envelope with a stack is a few KB;
/// 64 KiB is generous headroom while still bounding a hostile/looping client's per-request cost.
const MAX_BODY: usize = 64 * 1024;
/// Per-project rate-limit window (ms) and the max envelopes accepted within it. Beyond the cap the
/// collector drops the envelope (counting the drop) rather than writing unbounded — a fault that fires
/// in a hot loop still collapses to one fingerprinted row, but this caps the write pressure too.
const RATE_WINDOW_MS: i64 = 10_000;
const RATE_CAP: u32 = 200;

/// Epoch-milliseconds, matching the `errordb`/perf convention so a collector-stamped `ts` sorts
/// alongside a `bsc errors add`-stamped one.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The wire envelope — an OTLP-log subset (#2258) so a mainstream app can point its existing
/// OpenTelemetry SDK at the endpoint instead of our shim. `type` selects fault vs heartbeat; the
/// fault-only fields are ignored for a heartbeat. Field names are the byte-exact contract shared with
/// the slice-3 shim (snake_case).
#[derive(Debug, Clone, Deserialize)]
struct Envelope {
    /// `"fault"` (default) or `"heartbeat"`.
    #[serde(rename = "type", default)]
    kind: String,
    project_key: String,
    token: String,
    #[serde(default)]
    release: Option<String>,
    /// Occurrence time (epoch ms). Defaults to receive-time when absent.
    #[serde(default)]
    ts: Option<i64>,
    // ── fault-only ──
    #[serde(default)]
    level: Option<String>,
    /// The fault title/summary — required for a fault.
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    stack: Option<String>,
    /// Free-form structured context; stringified into the errordb event row.
    #[serde(default)]
    context: Option<serde_json::Value>,
}

/// The disposition of one ingest attempt → an HTTP status. Pure result of parse/validate/attribute,
/// so the whole decision path is unit-testable without a socket.
#[derive(Debug, PartialEq)]
enum Outcome {
    /// A fault was recorded (200) — carries the resulting fingerprint (for tests/logging).
    Recorded(String),
    /// A heartbeat updated liveness (204).
    Heartbeat,
    /// Absent or wrong token (401).
    Unauthorized,
    /// No token has ever been minted for this `project_key` (404).
    UnknownProject,
    /// Malformed JSON, missing/empty required field, or an unknown `type` (400).
    BadRequest,
    /// Body exceeded [`MAX_BODY`] (413).
    TooLarge,
    /// Per-project rate cap exceeded (429).
    RateLimited,
    /// The error.db could not be opened/written (500).
    Internal,
}

impl Outcome {
    /// (status code, short reason phrase) for the HTTP response.
    fn http(&self) -> (u16, &'static str) {
        match self {
            Outcome::Recorded(_) => (200, "recorded"),
            Outcome::Heartbeat => (204, "ok"),
            Outcome::Unauthorized => (401, "unauthorized"),
            Outcome::UnknownProject => (404, "unknown project"),
            Outcome::BadRequest => (400, "bad request"),
            Outcome::TooLarge => (413, "payload too large"),
            Outcome::RateLimited => (429, "rate limited"),
            Outcome::Internal => (500, "internal error"),
        }
    }
}

/// One project's fixed-window rate counter (drop-with-count).
#[derive(Default)]
struct RateWindow {
    window_start: i64,
    count: u32,
    /// Total envelopes dropped for this project since start — surfaced in logs, never resets.
    dropped: u64,
}

/// State shared between the Tauri-managed [`CollectorState`] and the background server thread. All
/// maps are keyed by `project_key`.
#[derive(Default)]
struct Shared {
    /// The bound loopback port (0 until the receiver starts).
    port: AtomicU16,
    /// project_key → ingest token. Minted on demand ([`CollectorState::ensure_token`]).
    tokens: Mutex<HashMap<String, String>>,
    /// project_key → last-heartbeat epoch-ms (slice-4 liveness; #2263).
    liveness: Mutex<HashMap<String, i64>>,
    /// project_key → rate window.
    rate: Mutex<HashMap<String, RateWindow>>,
}

impl Shared {
    /// Charge one envelope against the project's window; `false` = over the cap (dropped).
    fn allow(&self, project_key: &str) -> bool {
        let now = now_ms();
        let mut map = lock(&self.rate);
        let w = map.entry(project_key.to_string()).or_default();
        if now - w.window_start >= RATE_WINDOW_MS {
            w.window_start = now;
            w.count = 0;
        }
        if w.count < RATE_CAP {
            w.count += 1;
            true
        } else {
            w.dropped += 1;
            false
        }
    }
}

/// Recover a poisoned lock rather than propagating — collector state stays coherent across a panicked
/// holder (mirrors [`crate::observability::lock_recover`]; kept local so this module has no coupling to
/// the perf/log state).
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The Tauri-managed collector: owns the shared state and (once started) the background receiver.
pub struct CollectorState {
    shared: Arc<Shared>,
}

/// What the frontend/planner needs to bake the fault shim into a generated app (#2261 → slice 3):
/// where to POST and the project's token. Returned by [`collector_info`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorInfo {
    /// The loopback port the receiver is bound to (0 if it failed to start).
    pub ingest_port: u16,
    /// The project's ingest token (minted if this is the first ask).
    pub token: String,
}

impl Default for CollectorState {
    fn default() -> Self {
        Self::new()
    }
}

impl CollectorState {
    pub fn new() -> Self {
        Self { shared: Arc::new(Shared::default()) }
    }

    /// The bound loopback port, or 0 before the receiver has started.
    pub fn port(&self) -> u16 {
        self.shared.port.load(Ordering::SeqCst)
    }

    /// Get (minting + persisting on first ask) the project's ingest token — a random 32-hex-char secret
    /// the generated app bakes in once at generation. DURABLE (#2262): backed by [`ingest_token_path`]
    /// in the project hub (next to `error.db`), so a baked token keeps validating across desktop
    /// restarts (the previous in-memory-only mint did not). The `tokens` map is a per-process cache
    /// over that file.
    pub fn ensure_token(&self, project_key: &str) -> String {
        let mut map = lock(&self.shared.tokens);
        if let Some(tok) = map.get(project_key) {
            return tok.clone();
        }
        let token = read_or_mint_token(&ingest_token_path(project_key));
        map.insert(project_key.to_string(), token.clone());
        token
    }

    /// The last time a heartbeat arrived for `project_key` (epoch-ms), or `None`. For the slice-4
    /// Glance liveness/"app down" derivation (#2263).
    #[allow(dead_code)] // consumed by #2263
    pub fn last_heartbeat(&self, project_key: &str) -> Option<i64> {
        lock(&self.shared.liveness).get(project_key).copied()
    }

    /// Bind the loopback receiver and spawn its accept loop on a background thread. Idempotent enough
    /// for the single boot call; a bind failure is logged and leaves `port() == 0` (ingest simply
    /// isn't available) rather than aborting startup.
    pub fn start(&self) {
        let shared = Arc::clone(&self.shared);
        // Bind to loopback with an OS-assigned port (":0") — no config, no port conflict, and never
        // reachable off-box.
        let server = match tiny_http::Server::http("127.0.0.1:0") {
            Ok(s) => s,
            Err(e) => {
                log::error!("[collector] could not bind loopback fault-ingest receiver: {e}");
                // Clear any stale port from a previous boot so the session wiring doesn't export a
                // dead $BSC_INGEST_PORT (#2262).
                let _ = std::fs::remove_file(ingest_port_file());
                return;
            }
        };
        let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
        shared.port.store(port, Ordering::SeqCst);
        // Surface the OS-assigned port so the session env wiring can export $BSC_INGEST_PORT without a
        // handle to this state (#2262). Refreshed each boot.
        let _ = std::fs::write(ingest_port_file(), port.to_string());
        log::info!("[collector] fault-ingest receiver on http://127.0.0.1:{port}/ingest");
        std::thread::Builder::new()
            .name("fault-collector".into())
            .spawn(move || serve(&shared, server))
            .map_err(|e| log::error!("[collector] could not spawn receiver thread: {e}"))
            .ok();
    }
}

/// A random 128-bit token as 32 lowercase hex chars (mirrors the tunnel's PSK minting).
fn mint_token() -> String {
    let bytes: [u8; 16] = rand::random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Read the durable ingest token at `path`, or mint + persist a fresh one there (creating the parent
/// dir). The file-backed core of [`CollectorState::ensure_token`] (#2262) — pure over an explicit path
/// so the durability is testable without touching the real project hub. A best-effort write failure
/// still returns a usable (in-memory) token for the session; only cross-restart stability is lost.
fn read_or_mint_token(path: &std::path::Path) -> String {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let existing = existing.trim();
        if !existing.is_empty() {
            return existing.to_string();
        }
    }
    let minted = mint_token();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, &minted);
    minted
}

/// The blocking accept loop (own thread). Reads each request body under the size cap, runs the pure
/// [`ingest`] decision, and replies with its status. Never panics out of the loop — a bad request is a
/// status code, not a crash.
fn serve(shared: &Shared, server: tiny_http::Server) {
    for mut req in server.incoming_requests() {
        let outcome = if req.method() != &tiny_http::Method::Post {
            Outcome::BadRequest
        } else {
            match read_body(&mut req) {
                Ok(body) => ingest(shared, &body, |k| Store::open(&error_db_path(k))),
                Err(o) => o,
            }
        };
        if let Outcome::Recorded(ref fp) = outcome {
            log::debug!("[collector] recorded fault {fp}");
        }
        let (code, reason) = outcome.http();
        let resp = tiny_http::Response::from_string(reason)
            .with_status_code(tiny_http::StatusCode(code));
        let _ = req.respond(resp);
    }
}

/// Read the request body, refusing anything over [`MAX_BODY`] without buffering it all — reads at most
/// `MAX_BODY + 1` bytes so an oversized/looping client can't exhaust memory. Returns [`Outcome::TooLarge`]
/// on overflow, [`Outcome::BadRequest`] on a read error.
fn read_body(req: &mut tiny_http::Request) -> Result<Vec<u8>, Outcome> {
    // Fast reject when the client declares an oversized length.
    if req.body_length().is_some_and(|n| n > MAX_BODY) {
        return Err(Outcome::TooLarge);
    }
    let mut body = Vec::new();
    req.as_reader()
        .take(MAX_BODY as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|_| Outcome::BadRequest)?;
    if body.len() > MAX_BODY {
        return Err(Outcome::TooLarge);
    }
    Ok(body)
}

/// The pure parse → validate → attribute → record decision. `open_store` resolves the project's
/// [`Store`] (production: `Store::open(&error_db_path(key))`; tests inject a temp/in-memory store), so
/// the whole path is testable without a socket, the real home dir, or Tauri.
fn ingest(
    shared: &Shared,
    body: &[u8],
    open_store: impl Fn(&str) -> rusqlite::Result<Store>,
) -> Outcome {
    if body.len() > MAX_BODY {
        return Outcome::TooLarge;
    }
    let env: Envelope = match serde_json::from_slice(body) {
        Ok(e) => e,
        Err(_) => return Outcome::BadRequest,
    };
    if env.project_key.trim().is_empty() {
        return Outcome::BadRequest;
    }
    // Attribution + auth: an unknown project has no minted token (404); a present project with an
    // absent/mismatched token is unauthorized (401). Constant-time-ish compare isn't warranted on
    // loopback, but the empty-token guard keeps a token-less envelope from ever matching.
    let expected = lock(&shared.tokens).get(&env.project_key).cloned();
    let Some(expected) = expected else {
        return Outcome::UnknownProject;
    };
    if env.token.is_empty() || env.token != expected {
        return Outcome::Unauthorized;
    }
    // Rate-limit AFTER auth so an unauthorized flood can't consume a project's budget.
    if !shared.allow(&env.project_key) {
        return Outcome::RateLimited;
    }
    let ts = env.ts.unwrap_or_else(now_ms);
    match env.kind.as_str() {
        "heartbeat" => {
            lock(&shared.liveness).insert(env.project_key.clone(), ts);
            Outcome::Heartbeat
        }
        // Empty `type` defaults to a fault (the common case).
        "" | "fault" => {
            let title = match env.message.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
                Some(m) => m.to_string(),
                None => return Outcome::BadRequest, // a fault must carry a message
            };
            let store = match open_store(&env.project_key) {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("[collector] cannot open error.db for {}: {e}", env.project_key);
                    return Outcome::Internal;
                }
            };
            let input = FaultInput {
                stage: String::new(), // → errordb default ("runtime")
                level: env.level.unwrap_or_default(), // → errordb default ("error")
                title,
                stack: env.stack,
                source_hint: None,
                release: env.release,
                context: env.context.map(stringify_context),
                ts,
            };
            match store.record(&input) {
                Ok(fault) => Outcome::Recorded(fault.fingerprint),
                Err(e) => {
                    log::warn!("[collector] cannot record fault for {}: {e}", env.project_key);
                    Outcome::Internal
                }
            }
        }
        _ => Outcome::BadRequest,
    }
}

/// Flatten the envelope's structured `context` to a string for the errordb event row — a bare string
/// stays as-is; anything else is compact JSON.
fn stringify_context(v: serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s,
        other => other.to_string(),
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

/// The ingest port + a project's token, for baking the fault shim into a generated app (#2261).
/// Mints the token on first ask. Return value is camelCase (`ingestPort`, `token`) — Tauri does NOT
/// rename return values, only args (#tauri-return-value-casing).
#[tauri::command]
pub fn collector_info(project_key: String, state: tauri::State<CollectorState>) -> CollectorInfo {
    CollectorInfo { ingest_port: state.port(), token: state.ensure_token(&project_key) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `Shared` with `project` pre-registered to `token`, so `ingest` sees a known project.
    fn shared_with(project: &str, token: &str) -> Shared {
        let s = Shared::default();
        s.tokens.lock().unwrap().insert(project.into(), token.into());
        s
    }

    fn fault_body(project: &str, token: &str, message: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "type": "fault",
            "project_key": project,
            "token": token,
            "level": "error",
            "message": message,
            "stack": "at boom (app.js:10:5)",
            "ts": 1000,
        }))
        .unwrap()
    }

    /// Attribution/record end-to-end against a real (temp-file) store we can re-open and assert on.
    #[test]
    fn recorded_fault_lands_in_the_projects_error_db() {
        let dir = std::env::temp_dir().join(format!("bsc-collector-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("error.db");
        let shared = shared_with("proj", "tok");

        let db_for = db.clone();
        let outcome = ingest(&shared, &fault_body("proj", "tok", "kaboom"), move |_| Store::open(&db_for));
        assert!(matches!(outcome, Outcome::Recorded(_)), "got {outcome:?}");

        // Re-open and confirm exactly one fingerprinted fault with the right title/level landed.
        let store = Store::open(&db).unwrap();
        let faults = store.list(&errordb::Filter::default()).unwrap();
        assert_eq!(faults.len(), 1);
        assert_eq!(faults[0].title, "kaboom");
        assert_eq!(faults[0].level, "error");
        assert_eq!(faults[0].stage, "runtime"); // errordb default applied
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn absent_or_wrong_token_is_unauthorized() {
        let shared = shared_with("proj", "right");
        let bad = ingest(&shared, &fault_body("proj", "wrong", "x"), |_| Store::open_in_memory());
        assert_eq!(bad, Outcome::Unauthorized);
        let empty = ingest(&shared, &fault_body("proj", "", "x"), |_| Store::open_in_memory());
        assert_eq!(empty, Outcome::Unauthorized);
    }

    #[test]
    fn unknown_project_is_rejected() {
        let shared = shared_with("known", "tok");
        let out = ingest(&shared, &fault_body("stranger", "tok", "x"), |_| Store::open_in_memory());
        assert_eq!(out, Outcome::UnknownProject);
    }

    #[test]
    fn malformed_json_and_missing_message_are_bad_requests() {
        let shared = shared_with("proj", "tok");
        assert_eq!(ingest(&shared, b"not json", |_| Store::open_in_memory()), Outcome::BadRequest);
        // Valid JSON, valid auth, but no message on a fault.
        let no_msg = serde_json::to_vec(&serde_json::json!({
            "type": "fault", "project_key": "proj", "token": "tok"
        }))
        .unwrap();
        assert_eq!(ingest(&shared, &no_msg, |_| Store::open_in_memory()), Outcome::BadRequest);
        // Empty project_key.
        let no_proj = serde_json::to_vec(&serde_json::json!({
            "project_key": "", "token": "tok", "message": "x"
        }))
        .unwrap();
        assert_eq!(ingest(&shared, &no_proj, |_| Store::open_in_memory()), Outcome::BadRequest);
    }

    #[test]
    fn oversized_body_is_rejected_without_parsing() {
        let shared = shared_with("proj", "tok");
        let big = vec![b'a'; MAX_BODY + 1];
        assert_eq!(ingest(&shared, &big, |_| Store::open_in_memory()), Outcome::TooLarge);
    }

    #[test]
    fn heartbeat_updates_liveness_and_records_no_fault() {
        let shared = shared_with("proj", "tok");
        let hb = serde_json::to_vec(&serde_json::json!({
            "type": "heartbeat", "project_key": "proj", "token": "tok", "ts": 4242
        }))
        .unwrap();
        // A heartbeat must never open a store — a panicking opener proves the store path isn't taken.
        let out = ingest(&shared, &hb, |_| panic!("heartbeat must not open a store"));
        assert_eq!(out, Outcome::Heartbeat);
        assert_eq!(lock(&shared.liveness).get("proj").copied(), Some(4242));
    }

    #[test]
    fn default_type_is_treated_as_a_fault() {
        let shared = shared_with("proj", "tok");
        let body = serde_json::to_vec(&serde_json::json!({
            "project_key": "proj", "token": "tok", "message": "no type field"
        }))
        .unwrap();
        let out = ingest(&shared, &body, |_| Store::open_in_memory());
        assert!(matches!(out, Outcome::Recorded(_)), "got {out:?}");
    }

    #[test]
    fn rate_limit_drops_with_count_after_the_cap() {
        let shared = shared_with("proj", "tok");
        // Fill the window to the cap — every one is accepted.
        for _ in 0..RATE_CAP {
            let out = ingest(&shared, &fault_body("proj", "tok", "flood"), |_| Store::open_in_memory());
            assert!(matches!(out, Outcome::Recorded(_)));
        }
        // The next one is dropped (429), and the drop is counted.
        let dropped = ingest(&shared, &fault_body("proj", "tok", "flood"), |_| Store::open_in_memory());
        assert_eq!(dropped, Outcome::RateLimited);
        assert_eq!(lock(&shared.rate).get("proj").map(|w| w.dropped), Some(1));
    }

    #[test]
    fn read_or_mint_token_mints_hex_and_is_durable() {
        // #2262: the ingest token is minted once (32 hex chars) and PERSISTS to its hub file, so a
        // token baked into a generated app keeps validating across desktop restarts (the previous
        // in-memory-only mint did not). Pure over an explicit path (tempdir) so it never touches the
        // real project hub — CollectorState::ensure_token is a thin per-process cache over this.
        let dir = std::env::temp_dir().join(format!("bsc-ingest-token-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("nested").join("ingest-token"); // nested ⇒ exercises the parent mkdir

        let first = read_or_mint_token(&path);
        assert_eq!(first.len(), 32, "32 hex chars");
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), first, "persisted to the file");

        // A second read returns the SAME token (durable across a simulated restart).
        assert_eq!(read_or_mint_token(&path), first, "stable — reads the persisted token");
        // A different path mints a DISTINCT token (distinct projects → distinct tokens).
        assert_ne!(read_or_mint_token(&dir.join("other-token")), first);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stringify_context_keeps_a_bare_string_and_json_encodes_the_rest() {
        assert_eq!(stringify_context(serde_json::json!("hello")), "hello");
        assert_eq!(stringify_context(serde_json::json!({"a": 1})), r#"{"a":1}"#);
    }
}
