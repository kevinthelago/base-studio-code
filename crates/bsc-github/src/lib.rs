//! The GitHub REST/GraphQL transport — Tauri-free.
//!
//! Extracted verbatim from `src-tauri/src/github/api.rs`
//! (`extract-a-tauri-free-github-transport-crate`). That file exposed the transport ONLY as Tauri
//! commands, so `bsc` — a separate binary — could not talk to GitHub at all, and publishing a plan
//! had no path that did not run through a React hook. The app's commands are now thin wrappers
//! over this crate, so the behaviour below is the one both callers get.
//!
//! What moved: the shared header/error helpers, the ETag-validated response cache (with its
//! on-disk persistence), the rate-limit gate, and the five verbs publish uses
//! (`graphql`/`request`/`post`/`put`/`patch`) plus `delete` and the two gist calls.
//!
//! What did NOT move: `PerfSpan` instrumentation, which is app-side and stays wrapped around these
//! calls in `src-tauri`.
//!
//! ## Async here, blocking wrappers below
//!
//! The app is a tokio application and calls the `async` functions directly. A CLI is synchronous,
//! so [`blocking`] wraps each one in a lazily-built current-thread runtime. Both go through the
//! same code — a second, blocking-`reqwest` implementation would be a fork of exactly the logic
//! this extraction exists to keep singular.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

// ── User agent ─────────────────────────────────────────────────────────────────

/// The default `User-Agent`, used when the host application has not named itself.
const DEFAULT_USER_AGENT: &str = concat!("bsc-github/", env!("CARGO_PKG_VERSION"));

fn user_agent_slot() -> &'static OnceLock<String> {
    static UA: OnceLock<String> = OnceLock::new();
    &UA
}

/// Name the calling application in the `User-Agent` sent on every GitHub request.
///
/// The desktop app calls this once at startup with `base-studio-code/<version>` so the header is
/// unchanged from before the extraction. First call wins; later calls are ignored (returning
/// `false`) rather than racing, since the value is read from many threads.
pub fn set_user_agent(ua: impl Into<String>) -> bool {
    user_agent_slot().set(ua.into()).is_ok()
}

/// The `User-Agent` in force — whatever [`set_user_agent`] was given, else [`DEFAULT_USER_AGENT`].
pub fn user_agent() -> &'static str {
    user_agent_slot().get().map(String::as_str).unwrap_or(DEFAULT_USER_AGENT)
}

// ── Shared request plumbing ────────────────────────────────────────────────────

/// The GitHub API root every request is built against.
///
/// Overridable via `BSC_GITHUB_API_BASE`, read ONCE. Two reasons it is not a hardcoded constant:
/// a GitHub Enterprise host is a different root, and — the reason it exists today — it lets the
/// tests drive the REAL transport (headers, status handling, the cache, the blocking wrappers)
/// against a loopback server instead of asserting only on the pure helpers. Before this, "the CLI
/// can reach GitHub" was verifiable by compilation alone, which is not verification.
///
/// Trailing slashes are trimmed so `{base}/{path}` never doubles them.
pub fn api_base() -> &'static str {
    static BASE: OnceLock<String> = OnceLock::new();
    BASE.get_or_init(|| {
        std::env::var("BSC_GITHUB_API_BASE")
            .ok()
            .map(|v| v.trim_end_matches('/').to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "https://api.github.com".to_string())
    })
}

/// The process-wide async client, so connections pool instead of paying TLS/DNS setup per request.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Reject an empty GitHub token before any network call. Every token-bearing entry point
/// short-circuits with this one error string when the caller passes no token.
fn require_token(token: &str) -> Result<(), String> {
    if token.is_empty() {
        return Err("No GitHub token provided.".to_string());
    }
    Ok(())
}

/// Apply the four standard GitHub REST headers — auth, `Accept`, API version, and `User-Agent` —
/// shared by every REST request. (GraphQL builds its own header set.)
fn gh_std_headers(req: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    req.header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", user_agent())
}

/// The human error string for a failed GitHub response: `json["message"]` when present, else
/// `fallback`. The one copy of the error extraction shared by the REST + gist error paths.
fn gh_error_message<'a>(json: &'a serde_json::Value, fallback: &'a str) -> &'a str {
    json["message"].as_str().unwrap_or(fallback)
}

/// The standard non-2xx GitHub error for a REST/GraphQL response: log `{log_ctx} HTTP {status}:
/// {msg}` and return the `GitHub API error ({status}): {msg}` string every caller reports.
fn gh_status_error(status: reqwest::StatusCode, json: &serde_json::Value, log_ctx: &str) -> String {
    let msg = gh_error_message(json, "Unknown error");
    log::warn!("{log_ctx} HTTP {status}: {msg}");
    format!("GitHub API error ({status}): {msg}")
}

/// Send a request and decode a JSON body, returning status, headers and value. Callers branch on
/// the status themselves; the headers are needed before the body consumes the response so the
/// rate-limit gate can read `X-RateLimit-*` / `Retry-After`.
async fn send_json_full(
    req: reqwest::RequestBuilder,
    on_send: impl FnOnce(reqwest::Error) -> String,
    on_parse: impl FnOnce(reqwest::Error) -> String,
) -> Result<(reqwest::StatusCode, reqwest::header::HeaderMap, serde_json::Value), String> {
    let resp = req.send().await.map_err(on_send)?;
    let status = resp.status();
    let headers = resp.headers().clone();
    let json = resp.json::<serde_json::Value>().await.map_err(on_parse)?;
    Ok((status, headers, json))
}

/// Issue `method https://api.github.com/{path}` with a JSON body and the standard REST headers,
/// returning the parsed JSON on a 2xx. The shared body of [`post`] / [`put`] / [`patch`].
async fn gh_request(
    method: reqwest::Method,
    path: &str,
    token: &str,
    body: &serde_json::Value,
    log_ctx: &str,
) -> Result<serde_json::Value, String> {
    // Rate-limit gate: mutations short-circuit too — a gated POST would just 403.
    if let Some(err) = rate_limit_gate() {
        return Err(err);
    }
    let url = format!("{}/{}", api_base(), path);
    let (status, headers, json) = send_json_full(
        gh_std_headers(client().request(method, url), token).json(body),
        |e| format!("Request failed: {}", e),
        |e| format!("Failed to parse response: {}", e),
    )
    .await?;
    if !status.is_success() {
        if let Some(err) = note_rate_limit(status, &headers) {
            return Err(err);
        }
        return Err(gh_status_error(status, &json, log_ctx));
    }
    Ok(json)
}

/// Issue `method url` with a JSON body and the standard REST headers, returning the gist JSON on
/// a 2xx. Uses the `op`-prefixed error wording the gist callers report and, unlike [`gh_request`],
/// does not log.
async fn gist_request(
    method: reqwest::Method,
    url: String,
    op: &str,
    token: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (status, _headers, json) = send_json_full(
        gh_std_headers(client().request(method, url), token).json(body),
        |e| format!("{op} request failed: {e}"),
        |e| format!("{op}: failed to parse response: {e}"),
    )
    .await?;
    if !status.is_success() {
        let msg = gh_error_message(&json, "unknown error");
        return Err(format!("{op} HTTP {status}: {msg}"));
    }
    Ok(json)
}

// ── Response cache ─────────────────────────────────────────────────────────────
//
// A GET is cached by path with its ETag, so a repeat request revalidates via `If-None-Match` and
// a 304 costs no quota. GraphQL has no ETag, so those entries are time-windowed only and are
// never persisted — they can't be revalidated cheaply, only served blind.

struct CachedGet {
    etag: Option<String>,
    body: serde_json::Value,
    /// Seconds since the Unix epoch (not `Instant`, so entries survive persistence).
    fetched_at: u64,
}

impl CachedGet {
    /// Age of this entry (now − fetched_at; a backwards clock jump reads as zero).
    fn age(&self) -> Duration {
        Duration::from_secs(now_epoch().saturating_sub(self.fetched_at))
    }
}

/// Seconds since the Unix epoch (0 on a pre-1970 clock, which never happens in practice).
fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The shared on-disk cache file. Uses `bsc_util::bsc_base_dir` so the app and the CLI read and
/// write the SAME file — two caches would each re-fetch what the other had already validated.
pub fn cache_file() -> std::path::PathBuf {
    bsc_util::bsc_base_dir()
        .unwrap_or_else(|| std::path::PathBuf::from(".base-studio-code"))
        .join("github-http-cache.json")
}

fn github_cache() -> &'static Mutex<HashMap<String, CachedGet>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedGet>>> = OnceLock::new();
    // Lazily seed from the persisted REST entries: stale by TTL, but each carries an ETag, so the
    // first request per path revalidates with If-None-Match → a free 304 instead of a full
    // response. A missing/corrupt file just starts empty.
    CACHE.get_or_init(|| Mutex::new(load_persisted_cache(&cache_file())))
}

/// Drop every cached GitHub response — in memory AND the persisted file. Called when the token
/// changes (connect / disconnect / re-auth) so a new account never sees the previous one's bodies.
pub fn cache_clear() {
    github_cache().lock().unwrap().clear();
    let _ = std::fs::remove_file(cache_file());
}

/// Cap on persisted entries: newest-first by `fetched_at`, the oldest beyond this are evicted at
/// write time (the in-memory map itself is unbounded).
const PERSIST_CAP: usize = 50;

#[derive(serde::Deserialize)]
struct PersistedGet {
    etag: String,
    body: serde_json::Value,
    fetched_at: u64,
}

#[derive(serde::Serialize)]
struct PersistedGetRef<'a> {
    etag: &'a str,
    body: &'a serde_json::Value,
    fetched_at: u64,
}

fn persist_snapshot(cache: &HashMap<String, CachedGet>) -> Option<String> {
    let mut entries: Vec<(&str, PersistedGetRef)> = cache
        .iter()
        .filter_map(|(path, e)| {
            e.etag.as_deref().map(|etag| {
                (path.as_str(), PersistedGetRef { etag, body: &e.body, fetched_at: e.fetched_at })
            })
        })
        .collect();
    entries.sort_by_key(|e| std::cmp::Reverse(e.1.fetched_at));
    entries.truncate(PERSIST_CAP);
    let map: std::collections::BTreeMap<&str, PersistedGetRef> = entries.into_iter().collect();
    serde_json::to_string(&map).ok()
}

/// Load the persisted REST entries. Missing file ⇒ empty (first run); corrupt file ⇒ empty with a
/// warning — the cache is an optimization, never worth failing a request over.
fn load_persisted_cache(path: &std::path::Path) -> HashMap<String, CachedGet> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(map) = serde_json::from_str::<HashMap<String, PersistedGet>>(&text) else {
        log::warn!("github http cache at {} is corrupt; starting empty", path.display());
        return HashMap::new();
    };
    map.into_iter()
        .map(|(path, p)| (path, CachedGet { etag: Some(p.etag), body: p.body, fetched_at: p.fetched_at }))
        .collect()
}

/// Persist the cache's REST subset to disk. Snapshots under the lock, writes outside it.
/// Best-effort: an IO failure only logs — the in-memory cache stays authoritative.
fn save_github_cache() {
    let Some(text) = persist_snapshot(&github_cache().lock().unwrap()) else { return };
    let path = cache_file();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, text) {
        log::warn!("failed to persist github http cache to {}: {e}", path.display());
    }
}

/// Whether a cached entry of the given age can be served without even revalidating. `force` always
/// revalidates; with no `max_age_secs` we always revalidate (the revalidation is a cheap
/// conditional request, so the default is "revalidate-on-view").
fn cache_is_fresh(age: Duration, max_age_secs: Option<u64>, force: bool) -> bool {
    if force {
        return false;
    }
    match max_age_secs {
        Some(max) => age < Duration::from_secs(max),
        None => false,
    }
}

/// Fold a GET outcome into the cache and return the body to hand back. A 304 reuses the cached
/// entry (timestamp refreshed); otherwise the fresh `body` (with its `etag`) replaces the entry.
/// Returns `None` only on a 304 with no cached entry, or a non-304 with no body.
fn apply_github_response(
    cache: &mut HashMap<String, CachedGet>,
    path: &str,
    not_modified: bool,
    etag: Option<String>,
    body: Option<serde_json::Value>,
) -> Option<serde_json::Value> {
    if not_modified {
        let entry = cache.get_mut(path)?;
        entry.fetched_at = now_epoch();
        return Some(entry.body.clone());
    }
    let b = body?;
    cache.insert(path.to_string(), CachedGet { etag, body: b.clone(), fetched_at: now_epoch() });
    Some(b)
}

// ── Rate-limit awareness ───────────────────────────────────────────────────────
//
// GitHub signals its primary quota via `X-RateLimit-Remaining`/`X-RateLimit-Reset` and its
// secondary (abuse) limits via `Retry-After`. When a 403/429 says the quota is exhausted, an
// in-memory gate arms until the reset: further requests short-circuit with a TYPED error —
// `github rate-limited until <epoch secs>` — that the frontend distinguishes from real failures.

/// Epoch second the gate lifts; 0 = not rate-limited.
static RATE_LIMITED_UNTIL: AtomicU64 = AtomicU64::new(0);

/// The one typed error string; the frontend matches its prefix (`rateLimitedUntil` in github.ts).
fn rate_limited_error(until: u64) -> String {
    format!("github rate-limited until {until}")
}

/// If the gate is armed and unexpired, the typed error to short-circuit with; an expired gate
/// disarms and lets the request through.
fn rate_limit_gate() -> Option<String> {
    let until = RATE_LIMITED_UNTIL.load(Ordering::Relaxed);
    if until == 0 {
        return None;
    }
    if now_epoch() >= until {
        RATE_LIMITED_UNTIL.store(0, Ordering::Relaxed);
        return None;
    }
    Some(rate_limited_error(until))
}

/// Decide the rate-limit horizon from a response (pure, so it's directly testable). Returns the
/// epoch second the limit resets when `status` is 403/429 AND the headers say the quota is gone:
/// `Retry-After` (secondary limits) wins, else `X-RateLimit-Remaining: 0` (+ `X-RateLimit-Reset`,
/// defaulting to a 60s backoff when absent/garbled). A plain 403 (permissions) has remaining > 0
/// and stays `None`, so it keeps surfacing as the normal GitHub API error.
fn rate_limit_until_from(
    status: u16,
    remaining: Option<&str>,
    reset: Option<&str>,
    retry_after: Option<&str>,
    now: u64,
) -> Option<u64> {
    if status != 403 && status != 429 {
        return None;
    }
    if let Some(secs) = retry_after.and_then(|s| s.trim().parse::<u64>().ok()) {
        return Some(now + secs.max(1));
    }
    if remaining.and_then(|s| s.trim().parse::<u64>().ok()) == Some(0) {
        let until = reset.and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(now + 60);
        return Some(until.max(now + 1)); // a reset in the past still gates ≥ 1s
    }
    None
}

/// Inspect a response's rate-limit headers; on an exhausted 403/429, arm the gate and return the
/// typed error to report. `None` for every non-rate-limit response (including other failures).
fn note_rate_limit(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
) -> Option<String> {
    let h = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let until = rate_limit_until_from(
        status.as_u16(),
        h("x-ratelimit-remaining"),
        h("x-ratelimit-reset"),
        h("retry-after"),
        now_epoch(),
    )?;
    RATE_LIMITED_UNTIL.store(until, Ordering::Relaxed);
    log::warn!("github rate limit exhausted (HTTP {status}); gating requests until epoch {until}");
    Some(rate_limited_error(until))
}

// ── The verbs ──────────────────────────────────────────────────────────────────

/// `POST https://api.github.com/graphql`. Cached by query + variables on a pure TTL (GraphQL has
/// no ETag), so within `max_age_secs` the cached `data` is served with no network call.
pub async fn graphql(
    token: &str,
    query: &str,
    variables: Option<serde_json::Value>,
    max_age_secs: Option<u64>,
    force: bool,
) -> Result<serde_json::Value, String> {
    require_token(token)?;
    let cache_key = format!(
        "graphql:{}|{}",
        query,
        variables.as_ref().map(|v| v.to_string()).unwrap_or_default(),
    );
    if !force {
        let cache = github_cache().lock().unwrap();
        if let Some(entry) = cache.get(&cache_key) {
            if cache_is_fresh(entry.age(), max_age_secs, false) {
                return Ok(entry.body.clone());
            }
        }
    }

    if let Some(err) = rate_limit_gate() {
        return Err(err);
    }

    let mut body = serde_json::json!({ "query": query });
    if let Some(vars) = variables {
        body["variables"] = vars;
    }
    let (status, headers, json) = send_json_full(
        client()
            .post(format!("{}/graphql", api_base()))
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .header("User-Agent", user_agent())
            .json(&body),
        |e| format!("Request failed: {}", e),
        |e| format!("Failed to parse response: {}", e),
    )
    .await?;
    if !status.is_success() {
        if let Some(err) = note_rate_limit(status, &headers) {
            return Err(err);
        }
        return Err(gh_status_error(status, &json, "github_graphql"));
    }
    if let Some(errors) = json.get("errors") {
        if errors.is_array() && !errors.as_array().unwrap().is_empty() {
            let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error").to_string();
            log::warn!("github_graphql GraphQL error: {msg}");
            return Err(format!("GraphQL error: {}", msg));
        }
    }
    let data = json["data"].clone();
    github_cache()
        .lock()
        .unwrap()
        .insert(cache_key, CachedGet { etag: None, body: data.clone(), fetched_at: now_epoch() });
    Ok(data)
}

/// `GET https://api.github.com/{path}`, ETag-validated against the shared cache.
pub async fn request(
    token: &str,
    path: &str,
    max_age_secs: Option<u64>,
    force: bool,
) -> Result<serde_json::Value, String> {
    require_token(token)?;

    // Within max_age: serve the cached body with no network call. Otherwise grab the stored ETag
    // so we can revalidate cheaply via If-None-Match.
    let cached_etag = {
        let cache = github_cache().lock().unwrap();
        match cache.get(path) {
            Some(entry) if cache_is_fresh(entry.age(), max_age_secs, force) => {
                return Ok(entry.body.clone());
            }
            Some(entry) if !force => entry.etag.clone(),
            _ => None,
        }
    };

    if let Some(err) = rate_limit_gate() {
        return Err(err);
    }

    let url = format!("{}/{}", api_base(), path);
    let mut req = gh_std_headers(client().get(&url), token);
    if let Some(etag) = &cached_etag {
        req = req.header("If-None-Match", etag.clone());
    }
    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            // Offline / transient: serve the last good body if we have one.
            if let Some(entry) = github_cache().lock().unwrap().get(path) {
                log::warn!("github_request {path} request failed ({e}); serving cached body");
                return Ok(entry.body.clone());
            }
            return Err(format!("Request failed: {}", e));
        }
    };
    let status = response.status();

    if let Some(err) = note_rate_limit(status, response.headers()) {
        return Err(err);
    }

    // 304 Not Modified → the cached body is still current.
    if status == reqwest::StatusCode::NOT_MODIFIED {
        let body = {
            let mut cache = github_cache().lock().unwrap();
            apply_github_response(&mut cache, path, true, None, None)
        };
        save_github_cache(); // the refreshed fetched_at drives TTL freshness + persist eviction
        return body.ok_or_else(|| "GitHub returned 304 but no cached body is available".to_string());
    }

    // Capture the ETag before the body consumes the response.
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    if !status.is_success() {
        return Err(gh_status_error(status, &json, &format!("github_request {path}")));
    }
    {
        let mut cache = github_cache().lock().unwrap();
        apply_github_response(&mut cache, path, false, etag, Some(json.clone()));
    }
    save_github_cache();
    Ok(json)
}

/// `POST https://api.github.com/{path}` with a JSON body.
pub async fn post(token: &str, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    require_token(token)?;
    gh_request(reqwest::Method::POST, path, token, body, &format!("github_post {path}")).await
}

/// `PUT https://api.github.com/{path}` with a JSON body.
pub async fn put(token: &str, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    require_token(token)?;
    gh_request(reqwest::Method::PUT, path, token, body, &format!("github_put {path}")).await
}

/// `PATCH https://api.github.com/{path}` with a JSON body — the verb GitHub uses to *update* an
/// existing resource, notably `PATCH /repos/{owner}/{repo}` to set a repo's description at publish.
pub async fn patch(token: &str, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    require_token(token)?;
    gh_request(reqwest::Method::PATCH, path, token, body, &format!("github_patch {path}")).await
}

/// `DELETE https://api.github.com/{path}`. Returns `()` — the error body may be empty OR JSON, so
/// unlike the other verbs it reads text and extracts `message` only when the body parses.
pub async fn delete(token: &str, path: &str) -> Result<(), String> {
    require_token(token)?;
    let url = format!("{}/{path}", api_base());
    let response = gh_std_headers(client().request(reqwest::Method::DELETE, url), token)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = response.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|j| j.get("message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_else(|| if body.trim().is_empty() { "Unknown error".into() } else { body });
    log::warn!("github_delete {path} HTTP {status}: {msg}");
    Err(format!("GitHub API error ({status}): {msg}"))
}

/// Create a gist. Requires the `gist` OAuth scope; read one back with [`request`] on `gists/<id>`.
pub async fn gist_create(
    token: &str,
    files: HashMap<String, String>,
    description: &str,
    public: bool,
) -> Result<serde_json::Value, String> {
    require_token(token)?;
    if files.is_empty() {
        return Err("gist_create: no files to publish".to_string());
    }
    // GitHub's gist API shape: files = { "<name>": { "content": "<text>" } }.
    let files_obj: serde_json::Map<String, serde_json::Value> = files
        .into_iter()
        .map(|(name, content)| (name, serde_json::json!({ "content": content })))
        .collect();
    let body = serde_json::json!({ "description": description, "public": public, "files": files_obj });
    gist_request(
        reqwest::Method::POST,
        format!("{}/gists", api_base()),
        "gist_create",
        token,
        &body,
    )
    .await
}

/// Update an existing gist's files.
pub async fn gist_update(
    token: &str,
    id: &str,
    files: HashMap<String, String>,
    description: &str,
) -> Result<serde_json::Value, String> {
    require_token(token)?;
    if id.trim().is_empty() {
        return Err("gist_update: no gist id".to_string());
    }
    if files.is_empty() {
        return Err("gist_update: no files to publish".to_string());
    }
    let files_obj: serde_json::Map<String, serde_json::Value> = files
        .into_iter()
        .map(|(name, content)| (name, serde_json::json!({ "content": content })))
        .collect();
    // `public` is omitted: a gist's visibility is fixed at creation and can't be changed via PATCH.
    let body = serde_json::json!({ "description": description, "files": files_obj });
    gist_request(
        reqwest::Method::PATCH,
        format!("{}/gists/{id}", api_base()),
        "gist_update",
        token,
        &body,
    )
    .await
}

// ── Blocking wrappers ──────────────────────────────────────────────────────────

/// Synchronous wrappers for callers with no runtime of their own (`bsc`).
///
/// Each drives the SAME async function above on a lazily-built current-thread runtime. Do not call
/// these from inside an async context — `block_on` panics there; the app calls the async fns.
pub mod blocking {
    use super::*;

    fn rt() -> &'static tokio::runtime::Runtime {
        static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
        RT.get_or_init(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to build the bsc-github runtime")
        })
    }

    /// Blocking [`super::graphql`].
    pub fn graphql(
        token: &str,
        query: &str,
        variables: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        rt().block_on(super::graphql(token, query, variables, None, false))
    }

    /// Blocking [`super::request`].
    pub fn request(token: &str, path: &str) -> Result<serde_json::Value, String> {
        rt().block_on(super::request(token, path, None, false))
    }

    /// Blocking [`super::post`].
    pub fn post(token: &str, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
        rt().block_on(super::post(token, path, body))
    }

    /// Blocking [`super::put`].
    pub fn put(token: &str, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
        rt().block_on(super::put(token, path, body))
    }

    /// Blocking [`super::patch`].
    pub fn patch(token: &str, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
        rt().block_on(super::patch(token, path, body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique scratch dir for a test that touches the filesystem. Replaces the app's
    /// `crate::testutil::unique_dir`, which does not exist outside `src-tauri`.
    fn unique_dir(tag: &str) -> std::path::PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("bsc-github-{tag}-{n}-{:?}", std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn require_token_rejects_only_empty() {
        // Empty token → the one centralized error string; any non-empty token passes.
        assert_eq!(require_token(""), Err("No GitHub token provided.".to_string()));
        assert_eq!(require_token("ghp_x"), Ok(()));
    }

    #[test]
    fn gh_error_message_prefers_message_then_fallback() {
        // Present `message` is returned verbatim (the GitHub error surfaced to the user).
        let with = serde_json::json!({ "message": "Bad credentials" });
        assert_eq!(gh_error_message(&with, "Unknown error"), "Bad credentials");
        // Absent → the caller's fallback. The REST path uses "Unknown error"; the gist path
        // uses lowercase "unknown error" — both wordings are preserved through this helper.
        let without = serde_json::json!({ "documentation_url": "x" });
        assert_eq!(gh_error_message(&without, "Unknown error"), "Unknown error");
        assert_eq!(gh_error_message(&without, "unknown error"), "unknown error");
    }

    #[test]
    fn gh_status_error_formats_status_and_message() {
        use reqwest::StatusCode;
        // The exact `GitHub API error (status): msg` wording every REST/GraphQL caller returns —
        // pinned so the shared helper can't drift from the sites it replaced.
        let json = serde_json::json!({ "message": "Not Found" });
        assert_eq!(
            gh_status_error(StatusCode::NOT_FOUND, &json, "github_request repos/x"),
            "GitHub API error (404 Not Found): Not Found",
        );
        let empty = serde_json::json!({ "documentation_url": "x" });
        assert_eq!(
            gh_status_error(StatusCode::UNPROCESSABLE_ENTITY, &empty, "github_graphql"),
            "GitHub API error (422 Unprocessable Entity): Unknown error",
        );
    }

    #[test]
    fn cache_is_fresh_only_within_max_age_and_never_when_forced() {
        // No max_age → always revalidate (cheap conditional request).
        assert!(!cache_is_fresh(Duration::from_secs(0), None, false));
        // Within / beyond the max_age window.
        assert!(cache_is_fresh(Duration::from_secs(10), Some(60), false));
        assert!(!cache_is_fresh(Duration::from_secs(120), Some(60), false));
        // force always revalidates, even when otherwise fresh.
        assert!(!cache_is_fresh(Duration::from_secs(1), Some(60), true));
    }

    #[test]
    fn apply_github_response_stores_on_200_and_reuses_on_304() {
        let mut cache: HashMap<String, CachedGet> = HashMap::new();

        // 200: stores the body + etag and returns it.
        let body = serde_json::json!({ "n": 1 });
        let out = apply_github_response(&mut cache, "repos/x", false, Some("etag-1".into()), Some(body.clone()));
        assert_eq!(out.as_ref(), Some(&body));
        assert_eq!(cache.get("repos/x").unwrap().etag.as_deref(), Some("etag-1"));

        // 304: returns the cached body without a new body.
        let reused = apply_github_response(&mut cache, "repos/x", true, None, None);
        assert_eq!(reused.as_ref(), Some(&body));

        // 304 with no cached entry → None (caller errors).
        assert_eq!(apply_github_response(&mut cache, "repos/missing", true, None, None), None);
    }

    fn entry(etag: Option<&str>, n: u64, fetched_at: u64) -> CachedGet {
        CachedGet { etag: etag.map(str::to_string), body: serde_json::json!({ "n": n }), fetched_at }
    }

    #[test]
    fn persisted_cache_round_trips_rest_entries_and_skips_graphql() {
        let mut cache: HashMap<String, CachedGet> = HashMap::new();
        cache.insert("repos/a".into(), entry(Some("etag-a"), 1, 100));
        cache.insert("user/repos".into(), entry(Some("etag-b"), 2, 200));
        // GraphQL entries carry no ETag — they must NOT be persisted (cold, they can't be
        // revalidated cheaply).
        cache.insert("graphql:query{...}|".into(), entry(None, 3, 300));

        let text = persist_snapshot(&cache).expect("snapshot serializes");
        let dir = unique_dir("roundtrip");
        let path = dir.join("github-http-cache.json");
        std::fs::write(&path, text).unwrap();

        let loaded = load_persisted_cache(&path);
        assert_eq!(loaded.len(), 2, "only the two REST entries persist");
        let a = loaded.get("repos/a").expect("repos/a survives the round trip");
        assert_eq!(a.etag.as_deref(), Some("etag-a"));
        assert_eq!(a.body, serde_json::json!({ "n": 1 }));
        assert_eq!(a.fetched_at, 100);
        assert!(!loaded.contains_key("graphql:query{...}|"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn persisted_cache_caps_entries_evicting_the_oldest() {
        let mut cache: HashMap<String, CachedGet> = HashMap::new();
        for i in 0..(PERSIST_CAP as u64 + 10) {
            cache.insert(format!("repos/p{i}"), entry(Some("e"), i, i));
        }
        let text = persist_snapshot(&cache).unwrap();
        let map: HashMap<String, serde_json::Value> = serde_json::from_str(&text).unwrap();
        assert_eq!(map.len(), PERSIST_CAP, "capped at PERSIST_CAP");
        // Newest kept, oldest evicted (fetched_at ordering).
        assert!(map.contains_key(&format!("repos/p{}", PERSIST_CAP + 9)));
        assert!(!map.contains_key("repos/p0"));
        assert!(!map.contains_key("repos/p9"));
        assert!(map.contains_key("repos/p10"));
    }

    #[test]
    fn load_persisted_cache_tolerates_missing_and_corrupt_files() {
        let dir = unique_dir("corrupt");
        // Missing file (first run) → empty, no error.
        assert!(load_persisted_cache(&dir.join("nope.json")).is_empty());
        // Corrupt file → empty (start over), never a panic/failure.
        let path = dir.join("github-http-cache.json");
        std::fs::write(&path, "not json {{{").unwrap();
        assert!(load_persisted_cache(&path).is_empty());
        // Valid JSON of the wrong shape → also empty.
        std::fs::write(&path, r#"{"repos/a": {"unexpected": true}}"#).unwrap();
        assert!(load_persisted_cache(&path).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rate_limit_until_from_detects_only_exhausted_quotas() {
        let now = 1_700_000_000;
        // Primary limit: 403 + remaining 0 → the reset epoch.
        assert_eq!(
            rate_limit_until_from(403, Some("0"), Some("1700000123"), None, now),
            Some(1_700_000_123),
        );
        // A reset in the past still gates for ≥ 1s (never a 0-length gate loop).
        assert_eq!(rate_limit_until_from(403, Some("0"), Some("100"), None, now), Some(now + 1));
        // Missing/garbled reset → the 60s fallback backoff.
        assert_eq!(rate_limit_until_from(403, Some("0"), None, None, now), Some(now + 60));
        assert_eq!(rate_limit_until_from(403, Some("0"), Some("soon"), None, now), Some(now + 60));
        // Secondary limit: Retry-After wins over the primary headers.
        assert_eq!(rate_limit_until_from(429, None, None, Some("30"), now), Some(now + 30));
        assert_eq!(
            rate_limit_until_from(403, Some("0"), Some("1700009999"), Some("15"), now),
            Some(now + 15),
        );
        // A plain permissions 403 (remaining > 0, no Retry-After) is NOT a rate limit.
        assert_eq!(rate_limit_until_from(403, Some("4999"), Some("1700000123"), None, now), None);
        assert_eq!(rate_limit_until_from(403, None, None, None, now), None);
        // Non-403/429 statuses never arm the gate, whatever the headers say.
        assert_eq!(rate_limit_until_from(500, Some("0"), Some("1700000123"), None, now), None);
        assert_eq!(rate_limit_until_from(200, Some("0"), None, Some("30"), now), None);
    }

    #[test]
    fn rate_limit_gate_blocks_until_reset_then_disarms() {
        // One test fn for all gate states — the static is shared, so interleaving cases across
        // parallel test fns would race.
        RATE_LIMITED_UNTIL.store(0, Ordering::Relaxed);
        assert_eq!(rate_limit_gate(), None, "unarmed gate lets requests through");

        let until = now_epoch() + 120;
        RATE_LIMITED_UNTIL.store(until, Ordering::Relaxed);
        assert_eq!(
            rate_limit_gate(),
            Some(format!("github rate-limited until {until}")),
            "armed + unexpired → the typed error (the exact string the frontend parses)",
        );

        RATE_LIMITED_UNTIL.store(now_epoch().saturating_sub(5), Ordering::Relaxed);
        assert_eq!(rate_limit_gate(), None, "expired gate lets the request through…");
        assert_eq!(RATE_LIMITED_UNTIL.load(Ordering::Relaxed), 0, "…and disarms");
    }

    #[test]
    fn rate_limited_error_is_the_typed_prefix_the_frontend_parses() {
        // Pinned: `rateLimitedUntil` in shared/lib/github/github.ts matches this exact wording.
        assert_eq!(rate_limited_error(1_700_000_123), "github rate-limited until 1700000123");
    }

    // ── New seams the extraction introduced ────────────────────────────────────

    #[test]
    fn user_agent_defaults_then_takes_the_hosts_name_once() {
        // Before any host names itself, the crate's own UA is used — never an empty header.
        // (`set_user_agent` may already have run in another test in this binary, so assert the
        // INVARIANT rather than a specific value: it is always non-empty and never bare.)
        assert!(!user_agent().is_empty());
        assert!(user_agent().contains('/'), "a UA carries a name/version: {}", user_agent());

        // First call wins; a second is refused rather than racing readers to a new value.
        let first = set_user_agent("base-studio-code/9.9.9");
        let second = set_user_agent("something-else/0.0.1");
        assert!(!(first && second), "at most ONE set_user_agent call may win");
        assert!(!user_agent().is_empty());
    }

    #[test]
    fn cache_file_sits_in_the_shared_base_dir_under_its_historical_name() {
        // The app and the CLI must resolve the SAME file: two caches would each re-fetch what the
        // other had already validated, and a token change would clear only one of them. The name
        // is the one `src-tauri/src/platform/paths.rs` used before the extraction.
        let p = cache_file();
        assert_eq!(p.file_name().unwrap(), "github-http-cache.json");
        let base = bsc_util::bsc_base_dir().unwrap_or_else(|| std::path::PathBuf::from(".base-studio-code"));
        assert_eq!(p.parent().unwrap(), base.as_path());
    }

    #[test]
    fn every_verb_rejects_an_empty_token_before_any_network_call() {
        // The guard is what makes these safe to call from a CLI that may have no token yet: an
        // empty token must fail fast and identically, not attempt an unauthenticated request.
        let want = Err("No GitHub token provided.".to_string());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let body = serde_json::json!({});
        assert_eq!(rt.block_on(post("", "repos/x/issues", &body)), want);
        assert_eq!(rt.block_on(put("", "repos/x/topics", &body)), want);
        assert_eq!(rt.block_on(patch("", "repos/x", &body)), want);
        assert_eq!(rt.block_on(request("", "repos/x", None, false)), want);
        assert_eq!(rt.block_on(graphql("", "{viewer{login}}", None, None, false)), want);
        assert_eq!(rt.block_on(gist_create("", HashMap::new(), "d", false)), want);
        assert_eq!(rt.block_on(gist_update("", "id", HashMap::new(), "d")), want);
        assert_eq!(rt.block_on(delete("", "repos/x")), Err("No GitHub token provided.".to_string()));
    }

    #[test]
    fn gist_verbs_refuse_empty_input_before_any_network_call() {
        // Ported guards: an empty file set would POST an empty gist, and an empty id would PATCH
        // `gists/` — both are caller bugs worth naming rather than round-tripping to GitHub.
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert_eq!(
            rt.block_on(gist_create("ghp_x", HashMap::new(), "d", false)),
            Err("gist_create: no files to publish".to_string()),
        );
        let one = || HashMap::from([("a.txt".to_string(), "x".to_string())]);
        assert_eq!(
            rt.block_on(gist_update("ghp_x", "   ", one(), "d")),
            Err("gist_update: no gist id".to_string()),
        );
        assert_eq!(
            rt.block_on(gist_update("ghp_x", "abc", HashMap::new(), "d")),
            Err("gist_update: no files to publish".to_string()),
        );
    }
}
