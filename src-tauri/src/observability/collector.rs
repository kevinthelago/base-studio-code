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

/// Liveness window (ms) — a project is `live` while its last heartbeat is within this window (#2263).
/// The app shim heartbeats on a short interval (~15s); a 45s window tolerates two briefly-missed beats
/// (the "small grace" the acceptance criteria call for) so a hiccup doesn't flap the node to "down".
/// A previously-live project silent past this window is deemed **down** (→ one synthesized "app down"
/// fault). The single named constant the derivation reads.
const LIVENESS_WINDOW_MS: i64 = 45_000;

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

/// One project's liveness record (#2263). Tracks the last heartbeat plus a one-shot latch so the
/// live→down transition synthesizes **exactly one** "app down" fault per silence.
#[derive(Default)]
struct LivenessRecord {
    /// Last-heartbeat epoch-ms. A project only appears in the map once it has heartbeated, so an entry
    /// means it WAS live — the precondition for an "app down" alert.
    last_hb: i64,
    /// True once the "app down" fault has been recorded for the CURRENT silence. Reset by the next
    /// heartbeat, so a project that recovers and later goes silent again alerts afresh — but a silent
    /// project never re-records on every sweep.
    down_alerted: bool,
}

/// The live/down disposition of one project at a point in time — the pure result of last-heartbeat vs
/// the window. `PartialEq` so it's directly assertable in tests.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Liveness {
    Live,
    Down,
}

/// Pure liveness derivation (#2263): `live` iff the last heartbeat is within `window_ms` of `now`. The
/// single source of truth the sweep + the Tauri surface both read — testable without any clock/socket.
fn liveness_of(last_hb: i64, now: i64, window_ms: i64) -> Liveness {
    if now.saturating_sub(last_hb) <= window_ms {
        Liveness::Live
    } else {
        Liveness::Down
    }
}

/// One project's liveness as the Glance status producer reads it (#2263). camelCase — Tauri does NOT
/// rename return values, only args (#tauri-return-value-casing).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLiveness {
    pub project_key: String,
    /// `true` = heartbeating within the window (Glance shows the pulsing `live` status).
    pub live: bool,
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
    /// project_key → liveness record (last-heartbeat + one-shot down-alert latch; #2263).
    liveness: Mutex<HashMap<String, LivenessRecord>>,
    /// project_key → rate window.
    rate: Mutex<HashMap<String, RateWindow>>,
}

impl Shared {
    /// Resolve the project's expected ingest token: the in-process cache first, else the durable
    /// on-disk token via `load` (warming the cache on a hit). This is the "cache over the token file"
    /// model [`CollectorState::ensure_token`] documents, applied on the **receive** path — so a token
    /// minted at generation (or on a prior boot) validates without a prior `ensure_token` call in THIS
    /// process (the in-memory map is empty after a restart). `load` is injected so the decision stays
    /// testable without the real project hub (production reads [`ingest_token_path`]; tests pass a
    /// closure). `None` ⇒ no token anywhere ⇒ an unknown project.
    fn token_for(&self, project_key: &str, load: impl Fn(&str) -> Option<String>) -> Option<String> {
        let mut map = lock(&self.tokens);
        if let Some(tok) = map.get(project_key) {
            return Some(tok.clone());
        }
        let tok = load(project_key)?;
        map.insert(project_key.to_string(), tok.clone());
        Some(tok)
    }

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

    /// Evaluate every tracked project's liveness at `now`, synthesize a **one-shot** "app down" fault for
    /// any project that has just crossed live→down, and return the current live/down snapshot for the
    /// Glance status producer (#2263). Poll-driven — the frontend `project_liveness` command drives this,
    /// so down-detection needs no background timer. `open_store` resolves each project's error.db (prod:
    /// `Store::open(&error_db_path(k))`; tests inject a temp/in-memory store), so the whole path is
    /// testable without a socket or the real home dir.
    pub fn sweep(
        &self,
        now: i64,
        open_store: impl Fn(&str) -> rusqlite::Result<Store>,
    ) -> Vec<ProjectLiveness> {
        let mut map = lock(&self.shared.liveness);
        let mut out = Vec::with_capacity(map.len());
        for (key, rec) in map.iter_mut() {
            let live = liveness_of(rec.last_hb, now, LIVENESS_WINDOW_MS) == Liveness::Live;
            if live {
                // Recovered — clear the latch so a FUTURE silence alerts again.
                rec.down_alerted = false;
            } else if !rec.down_alerted {
                // First sweep of this silence for a project that WAS live (an entry only exists after a
                // heartbeat): record exactly one "app down" fault, then latch it off.
                record_app_down(key, rec.last_hb, now, &open_store);
                rec.down_alerted = true;
            }
            out.push(ProjectLiveness { project_key: key.clone(), live });
        }
        out
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

/// Mint (or reuse) and persist the durable per-project ingest token, returning it. Called at
/// **generation** (`setup_workspaces`, #2262) so the token exists on disk *before* any session
/// launches: the session env wiring exports it as `$BSC_INGEST_TOKEN`, and the localhost collector
/// validates a running app's fault/heartbeat POST against this same durable file. Idempotent — an
/// existing token is reused, never rotated (a baked shim keeps validating). Thin wrapper over
/// [`read_or_mint_token`] at the canonical [`ingest_token_path`] so the generation seam needn't spell
/// the path or a `CollectorState` handle.
pub(crate) fn mint_ingest_token(project_key: &str) -> String {
    read_or_mint_token(&ingest_token_path(project_key))
}

/// Read the durable ingest token at `path` for the receiver's cache-miss fallback — the trimmed
/// contents when the file exists and is non-empty, else `None` (⇒ unknown project). Unlike
/// [`read_or_mint_token`] this NEVER mints/writes: an ingest for a project with no token file is an
/// *unknown project*, not a silent new registration. This is what makes the receiver honor the
/// "cache over the token file" model across a desktop restart (the in-memory map starts empty).
fn read_token_file(path: &std::path::Path) -> Option<String> {
    let s = std::fs::read_to_string(path).ok()?;
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
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

/// Synthesize the "app down" fault for a project that went silent (#2263) — the same shape as
/// `bsc errors add fatal "app down"`, landing in the project's own error.db so it surfaces alongside its
/// runtime faults. `last_hb` (when it was last seen) rides along as event context. Best-effort: a store
/// that can't be opened/written is logged, not fatal — the liveness snapshot still reports `down`.
fn record_app_down(
    project_key: &str,
    last_hb: i64,
    now: i64,
    open_store: &impl Fn(&str) -> rusqlite::Result<Store>,
) {
    let store = match open_store(project_key) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[collector] cannot open error.db for {project_key} to record 'app down': {e}");
            return;
        }
    };
    let input = FaultInput {
        stage: String::new(), // → errordb default ("runtime")
        level: "fatal".into(),
        title: "app down".into(),
        stack: None,
        source_hint: None,
        release: None,
        context: Some(format!("no heartbeat for {}ms (last seen {last_hb})", now.saturating_sub(last_hb))),
        ts: now,
    };
    match store.record(&input) {
        Ok(_) => log::info!("[collector] {project_key} went silent → recorded 'app down'"),
        Err(e) => log::warn!("[collector] cannot record 'app down' for {project_key}: {e}"),
    }
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
                Ok(body) => ingest(
                    shared,
                    &body,
                    |k| Store::open(&error_db_path(k)),
                    |k| read_token_file(&ingest_token_path(k)),
                ),
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
/// [`Store`] (production: `Store::open(&error_db_path(key))`; tests inject a temp/in-memory store) and
/// `load_token` resolves the project's durable ingest token on a cache miss (production:
/// `read_token_file(&ingest_token_path(key))`; tests inject/`|_| None`), so the whole path is testable
/// without a socket, the real home dir, or Tauri.
fn ingest(
    shared: &Shared,
    body: &[u8],
    open_store: impl Fn(&str) -> rusqlite::Result<Store>,
    load_token: impl Fn(&str) -> Option<String>,
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
    // absent/mismatched token is unauthorized (401). The token is resolved cache-over-file, so a
    // project minted at generation validates even on a fresh boot (empty in-memory map). Constant-
    // time-ish compare isn't warranted on loopback, but the empty-token guard keeps a token-less
    // envelope from ever matching.
    let Some(expected) = shared.token_for(&env.project_key, &load_token) else {
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
            let mut map = lock(&shared.liveness);
            let rec = map.entry(env.project_key.clone()).or_default();
            rec.last_hb = ts;
            rec.down_alerted = false; // a fresh beat clears any pending down-alert latch (app is back up)
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

/// The live/down snapshot for every heartbeating project, for the Glance `"live"` status producer
/// (#2263). Polling this ALSO drives down-detection: a project that has just gone silent past the
/// window records its one-shot "app down" fault as a side effect of the sweep. Return value is
/// camelCase (`projectKey`, `live`).
#[tauri::command]
pub fn project_liveness(state: tauri::State<CollectorState>) -> Vec<ProjectLiveness> {
    state.sweep(now_ms(), |k| Store::open(&error_db_path(k)))
}

/// Unresolved faults for MANY projects in ONE in-process read (#3912) — what the Glance fault badge
/// polls.
///
/// It used to `Promise.all` a `bsc errors list --unresolved --json` **subprocess per project**. At 28
/// projects on a 20s cadence that is ~21 concurrent `bsc` spawns three times a minute, each with a
/// ~400ms floor (#3871) — measured as the single largest consumer of the Tauri command queue
/// (15,806s of invoke time in a 72-minute window, p50 8.4s, max 96s). Since `src-tauri` already links
/// `errordb`, none of that subprocess cost was ever necessary: this opens each project's error.db
/// directly, the same way the collector already does.
///
/// Returns the raw unresolved rows keyed by project, NOT a precomputed summary — the count/worst-fault
/// derivation stays in the frontend's existing pure `unresolvedCount`/`worstFault`, so there is no
/// second implementation of the ranking to drift. A project with no error.db (never ran, or no fault
/// yet) is simply ABSENT from the map, exactly as the per-project read degraded to `[]` before.
#[tauri::command]
pub fn fault_rows_batch(project_keys: Vec<String>) -> std::collections::HashMap<String, Vec<errordb::Fault>> {
    let filter = errordb::Filter { unresolved: true, ..Default::default() };
    project_keys
        .into_iter()
        .filter(|k| !k.trim().is_empty())
        .filter_map(|key| {
            // A missing/locked db is not an error here — the badge just has nothing to show for it.
            let store = Store::open(&error_db_path(&key)).ok()?;
            let rows = store.list(&filter).ok()?;
            (!rows.is_empty()).then_some((key, rows))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn fault_rows_batch_skips_unknown_projects_instead_of_failing() {
        // #3912: the Glance badge polls the whole project set, most of which have no error.db (never
        // ran, or no fault yet). Those must be ABSENT from the map — the same "no badge" outcome the
        // old per-project subprocess produced by degrading to []. A missing db must never fail the
        // batch and blank every OTHER project's badge with it.
        let out = super::fault_rows_batch(vec![
            "definitely--not--a--project--3912".into(),
            String::new(),
            "   ".into(),
        ]);
        assert!(out.is_empty(), "unknown/blank keys contribute nothing, and do not error");
        assert!(super::fault_rows_batch(vec![]).is_empty(), "an empty project set is a no-op");
    }

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
        let outcome = ingest(&shared, &fault_body("proj", "tok", "kaboom"), move |_| Store::open(&db_for), |_| None);
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
        let bad = ingest(&shared, &fault_body("proj", "wrong", "x"), |_| Store::open_in_memory(), |_| None);
        assert_eq!(bad, Outcome::Unauthorized);
        let empty = ingest(&shared, &fault_body("proj", "", "x"), |_| Store::open_in_memory(), |_| None);
        assert_eq!(empty, Outcome::Unauthorized);
    }

    #[test]
    fn unknown_project_is_rejected() {
        let shared = shared_with("known", "tok");
        let out = ingest(&shared, &fault_body("stranger", "tok", "x"), |_| Store::open_in_memory(), |_| None);
        assert_eq!(out, Outcome::UnknownProject);
    }

    #[test]
    fn ingest_validates_a_generated_token_via_the_durable_file_on_a_cache_miss() {
        // #2262: a project's token is minted at GENERATION (to its hub file) but the in-memory tokens
        // map starts EMPTY every boot. The receiver must resolve the durable token from disk on a cache
        // miss and validate against it — else every app POST would 404 until a `collector_info` call
        // happened to warm the cache. `load_token` stands in for the on-disk read here.
        let shared = Shared::default(); // nothing warmed this "boot"
        let ok = ingest(
            &shared,
            &fault_body("proj", "tok", "kaboom"),
            |_| Store::open_in_memory(),
            |k| (k == "proj").then(|| "tok".to_string()),
        );
        assert!(matches!(ok, Outcome::Recorded(_)), "durable-token fault should record, got {ok:?}");
        // The hit warms the per-process cache so a later envelope skips the disk read.
        assert_eq!(lock(&shared.tokens).get("proj").map(String::as_str), Some("tok"), "cache warmed on hit");

        // A mismatched envelope token vs the durable file ⇒ unauthorized (not a silent accept).
        let shared2 = Shared::default();
        let bad = ingest(
            &shared2,
            &fault_body("proj", "wrong", "x"),
            |_| Store::open_in_memory(),
            |k| (k == "proj").then(|| "tok".to_string()),
        );
        assert_eq!(bad, Outcome::Unauthorized);

        // No durable token anywhere (never generated) ⇒ still an unknown project.
        let shared3 = Shared::default();
        let none = ingest(&shared3, &fault_body("ghost", "tok", "x"), |_| Store::open_in_memory(), |_| None);
        assert_eq!(none, Outcome::UnknownProject);
    }

    #[test]
    fn read_token_file_reads_nonempty_trimmed_else_none() {
        // The durable-file fallback: a present, non-empty token (trimmed) validates; an absent or
        // blank file is NOT a registration (⇒ None ⇒ unknown project), and it never mints/writes.
        let dir = std::env::temp_dir().join(format!("bsc-token-file-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ingest-token");
        assert_eq!(read_token_file(&path), None, "absent ⇒ None");
        std::fs::write(&path, "  deadbeefcafe  \n").unwrap();
        assert_eq!(read_token_file(&path).as_deref(), Some("deadbeefcafe"), "present ⇒ trimmed value");
        std::fs::write(&path, "   \n").unwrap();
        assert_eq!(read_token_file(&path), None, "blank ⇒ None (not a registration)");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn malformed_json_and_missing_message_are_bad_requests() {
        let shared = shared_with("proj", "tok");
        assert_eq!(ingest(&shared, b"not json", |_| Store::open_in_memory(), |_| None), Outcome::BadRequest);
        // Valid JSON, valid auth, but no message on a fault.
        let no_msg = serde_json::to_vec(&serde_json::json!({
            "type": "fault", "project_key": "proj", "token": "tok"
        }))
        .unwrap();
        assert_eq!(ingest(&shared, &no_msg, |_| Store::open_in_memory(), |_| None), Outcome::BadRequest);
        // Empty project_key.
        let no_proj = serde_json::to_vec(&serde_json::json!({
            "project_key": "", "token": "tok", "message": "x"
        }))
        .unwrap();
        assert_eq!(ingest(&shared, &no_proj, |_| Store::open_in_memory(), |_| None), Outcome::BadRequest);
    }

    #[test]
    fn oversized_body_is_rejected_without_parsing() {
        let shared = shared_with("proj", "tok");
        let big = vec![b'a'; MAX_BODY + 1];
        assert_eq!(ingest(&shared, &big, |_| Store::open_in_memory(), |_| None), Outcome::TooLarge);
    }

    #[test]
    fn heartbeat_updates_liveness_and_records_no_fault() {
        let shared = shared_with("proj", "tok");
        let hb = serde_json::to_vec(&serde_json::json!({
            "type": "heartbeat", "project_key": "proj", "token": "tok", "ts": 4242
        }))
        .unwrap();
        // A heartbeat must never open a store — a panicking opener proves the store path isn't taken.
        let out = ingest(&shared, &hb, |_| panic!("heartbeat must not open a store"), |_| None);
        assert_eq!(out, Outcome::Heartbeat);
        assert_eq!(lock(&shared.liveness).get("proj").map(|r| r.last_hb), Some(4242));
    }

    #[test]
    fn default_type_is_treated_as_a_fault() {
        let shared = shared_with("proj", "tok");
        let body = serde_json::to_vec(&serde_json::json!({
            "project_key": "proj", "token": "tok", "message": "no type field"
        }))
        .unwrap();
        let out = ingest(&shared, &body, |_| Store::open_in_memory(), |_| None);
        assert!(matches!(out, Outcome::Recorded(_)), "got {out:?}");
    }

    #[test]
    fn rate_limit_drops_with_count_after_the_cap() {
        let shared = shared_with("proj", "tok");
        // Fill the window to the cap — every one is accepted.
        for _ in 0..RATE_CAP {
            let out = ingest(&shared, &fault_body("proj", "tok", "flood"), |_| Store::open_in_memory(), |_| None);
            assert!(matches!(out, Outcome::Recorded(_)));
        }
        // The next one is dropped (429), and the drop is counted.
        let dropped = ingest(&shared, &fault_body("proj", "tok", "flood"), |_| Store::open_in_memory(), |_| None);
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

    // ── liveness / "app down" (#2263) ──────────────────────────────────────────

    #[test]
    fn liveness_of_is_within_window_inclusive() {
        // Fresh + on the boundary ⇒ live; one ms past the window ⇒ down.
        assert_eq!(liveness_of(1000, 1000, LIVENESS_WINDOW_MS), Liveness::Live);
        assert_eq!(liveness_of(1000, 1000 + LIVENESS_WINDOW_MS, LIVENESS_WINDOW_MS), Liveness::Live);
        assert_eq!(liveness_of(1000, 1000 + LIVENESS_WINDOW_MS + 1, LIVENESS_WINDOW_MS), Liveness::Down);
    }

    /// Seed a `CollectorState` with one heartbeated project at `last_hb`.
    fn state_beating(project: &str, last_hb: i64) -> CollectorState {
        let state = CollectorState::new();
        lock(&state.shared.liveness)
            .insert(project.into(), LivenessRecord { last_hb, down_alerted: false });
        state
    }

    #[test]
    fn sweep_reports_live_within_window_and_records_no_fault() {
        let state = state_beating("proj", 10_000);
        // now within the window ⇒ live; a panicking opener proves the fault path isn't taken.
        let snap = state.sweep(10_000 + LIVENESS_WINDOW_MS, |_| panic!("live must not open a store"));
        assert_eq!(snap, vec![ProjectLiveness { project_key: "proj".into(), live: true }]);
    }

    #[test]
    fn live_to_down_transition_records_exactly_one_app_down_fault() {
        // A temp-file db so re-opening in each sweep and again for the assertion see the same rows (an
        // in-memory Store can't be shared across handles — each open is a distinct empty db).
        let dir = std::env::temp_dir().join(format!("bsc-liveness-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("error.db");

        let state = state_beating("proj", 0);
        let now = LIVENESS_WINDOW_MS + 1; // just past the window ⇒ down

        // First sweep: crosses live→down ⇒ records the "app down" fault + reports down.
        let db1 = db.clone();
        let snap = state.sweep(now, move |_| Store::open(&db1));
        assert_eq!(snap, vec![ProjectLiveness { project_key: "proj".into(), live: false }]);

        // Second + third sweeps while still silent: still down, but NO additional fault (latched).
        let db2 = db.clone();
        let _ = state.sweep(now + 1, move |_| Store::open(&db2));
        let db3 = db.clone();
        let _ = state.sweep(now + 2, move |_| Store::open(&db3));

        let opened = Store::open(&db).unwrap();
        let faults = opened.list(&errordb::Filter::default()).unwrap();
        assert_eq!(faults.len(), 1, "exactly one 'app down' fault across repeated down sweeps");
        assert_eq!(faults[0].title, "app down");
        assert_eq!(faults[0].level, "fatal");
        assert_eq!(faults[0].count, 1, "recorded once — the latch prevents per-sweep re-recording");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_fresh_heartbeat_clears_the_latch_so_a_later_silence_alerts_again() {
        let dir = std::env::temp_dir().join(format!("bsc-liveness-recover-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("error.db");

        let shared = Arc::new(Shared::default());
        shared.tokens.lock().unwrap().insert("proj".into(), "tok".into());
        let state = CollectorState { shared: Arc::clone(&shared) };

        // Down once (latched).
        lock(&state.shared.liveness).insert("proj".into(), LivenessRecord { last_hb: 0, down_alerted: false });
        let db1 = db.clone();
        state.sweep(LIVENESS_WINDOW_MS + 1, move |_| Store::open(&db1));

        // A new heartbeat brings it back up and clears the latch.
        let hb = serde_json::to_vec(&serde_json::json!({
            "type": "heartbeat", "project_key": "proj", "token": "tok", "ts": 1_000_000
        }))
        .unwrap();
        assert_eq!(ingest(&shared, &hb, |_| panic!("heartbeat must not open a store"), |_| None), Outcome::Heartbeat);

        // Silent again, well past the window ⇒ a SECOND "app down" fault (count bumps to 2 on the same fp).
        let db2 = db.clone();
        state.sweep(1_000_000 + LIVENESS_WINDOW_MS + 1, move |_| Store::open(&db2));

        let opened = Store::open(&db).unwrap();
        let faults = opened.list(&errordb::Filter::default()).unwrap();
        assert_eq!(faults.len(), 1, "same fingerprint");
        assert_eq!(faults[0].count, 2, "two distinct live→down transitions each recorded once");
        std::fs::remove_dir_all(&dir).ok();
    }
}
