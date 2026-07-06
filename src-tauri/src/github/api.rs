// GitHub REST/GraphQL proxy + ETag-validated response cache
// (extracted from lib.rs, #758).

use crate::PerfSpan;

// ── Shared request plumbing ────────────────────────────────────────────────────
//
// Every REST call (post/put/patch, the two gists, and the cached GET) sends the same four
// headers and extracts errors from `json["message"]` the same way. These helpers hold that one
// copy. GraphQL keeps its own header set (Content-Type, no Accept/version) + error/cache logic,
// and the cached GET keeps its ETag/304 machinery — they reuse the header + message helpers but
// not the full request wrappers.

/// Reject an empty GitHub token before any network call. Every token-bearing command
/// (`github_graphql`/`post`/`put`/`patch`/`delete`/`request` + `gist_create`/`gist_update`)
/// short-circuits with this one error string when the frontend passes no token.
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
        .header("User-Agent", super::USER_AGENT)
}

/// The human error string for a failed GitHub response: `json["message"]` when present, else
/// `fallback`. The one copy of the error extraction shared by the REST + gist error paths.
fn gh_error_message<'a>(json: &'a serde_json::Value, fallback: &'a str) -> &'a str {
    json["message"].as_str().unwrap_or(fallback)
}

/// The standard non-2xx GitHub error for a REST/GraphQL response: log `{log_ctx} HTTP {status}:
/// {msg}` (`msg` from `json["message"]`, else "Unknown error") and return the
/// `GitHub API error ({status}): {msg}` string every caller reports. The one copy shared by
/// `gh_request`, `github_graphql`, and `github_request`. (Gist requests keep their own
/// `{op}`-prefixed, non-logged wording in `gist_request`.)
fn gh_status_error(status: reqwest::StatusCode, json: &serde_json::Value, log_ctx: &str) -> String {
    let msg = gh_error_message(json, "Unknown error");
    log::warn!("{log_ctx} HTTP {status}: {msg}");
    format!("GitHub API error ({status}): {msg}")
}

/// Issue `method https://api.github.com/{path}` with a JSON body and the standard REST headers,
/// returning the parsed JSON on a 2xx. On a non-2xx it logs `{log_ctx} HTTP {status}: {msg}` and
/// returns `GitHub API error ({status}): {msg}` (`msg` from `json["message"]`, else "Unknown
/// error"). The shared body of `github_post` / `github_put` / `github_patch`.
async fn gh_request(
    method: reqwest::Method,
    path: &str,
    token: &str,
    body: &serde_json::Value,
    log_ctx: &str,
) -> Result<serde_json::Value, String> {
    // Rate-limit gate (#2448): mutations short-circuit too — a gated POST would just 403.
    if let Some(err) = rate_limit_gate() {
        return Err(err);
    }
    let url = format!("https://api.github.com/{}", path);
    let (status, headers, json) = crate::platform::http::send_json_full(
        gh_std_headers(crate::platform::http::client().request(method, url), token).json(body),
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
/// a 2xx. The shared body of `gist_create` / `gist_update`; uses the `op`-prefixed error wording
/// those commands report (e.g. `gist_create request failed: …`, `gist_create HTTP 422: …`) and,
/// unlike `gh_request`, does not log.
async fn gist_request(
    method: reqwest::Method,
    url: String,
    op: &str,
    token: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (status, json) = crate::platform::http::send_json(
        gh_std_headers(crate::platform::http::client().request(method, url), token).json(body),
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

#[tauri::command]
pub(crate) async fn github_graphql(
    token: String,
    query: String,
    variables: Option<serde_json::Value>,
    max_age_secs: Option<u64>,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("github_graphql");
    require_token(&token)?;
    let force = force.unwrap_or(false);
    // GraphQL has no ETag, so the cache is purely time-windowed (TTL): within
    // max_age serve the cached `data` with no network call; otherwise re-POST.
    // Keyed by query + variables. Reuses the REST cache map (etag stays None).
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

    // Rate-limit gate (#2448): don't spend a request while the quota is exhausted.
    if let Some(err) = rate_limit_gate() {
        return Err(err);
    }

    let mut body = serde_json::json!({ "query": query });
    if let Some(vars) = variables {
        body["variables"] = vars;
    }
    let (status, headers, json) = crate::platform::http::send_json_full(
        crate::platform::http::client()
            .post("https://api.github.com/graphql")
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .header("User-Agent", super::USER_AGENT)
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

#[tauri::command]
pub(crate) async fn github_post(
    token: String,
    path: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("github_post");
    require_token(&token)?;
    gh_request(reqwest::Method::POST, &path, &token, &body, &format!("github_post {path}")).await
}

#[tauri::command]
pub(crate) async fn github_put(
    token: String,
    path: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("github_put");
    require_token(&token)?;
    gh_request(reqwest::Method::PUT, &path, &token, &body, &format!("github_put {path}")).await
}

/// `PATCH https://api.github.com/{path}` with a JSON body. The REST verb GitHub uses to
/// *update* an existing resource — notably `PATCH /repos/{owner}/{repo}` to set a repo's
/// description/homepage at publish (#1114). Mirrors `github_put`: same headers, surfaces a
/// non-2xx as an `Err` (the caller decides whether that's fatal) rather than swallowing it.
#[tauri::command]
pub(crate) async fn github_patch(
    token: String,
    path: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("github_patch");
    require_token(&token)?;
    gh_request(reqwest::Method::PATCH, &path, &token, &body, &format!("github_patch {path}")).await
}

/// `DELETE https://api.github.com/{path}` — e.g. `repos/{owner}/{repo}` to permanently delete a
/// repository (needs the token's `delete_repo` scope). Unlike the other verbs this does NOT reuse
/// `gh_request`: repo-delete answers `204 No Content` with an EMPTY body, which `gh_request` would
/// choke on trying to parse as JSON. Returns `Ok(())` on any 2xx, else a `GitHub API error (...)`.
#[tauri::command]
pub(crate) async fn github_delete(token: String, path: String) -> Result<(), String> {
    let _perf = PerfSpan::new("github_delete");
    require_token(&token)?;
    let url = format!("https://api.github.com/{path}");
    let response = gh_std_headers(
        crate::platform::http::client().request(reqwest::Method::DELETE, url),
        &token,
    )
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    // The error body may be empty or JSON — extract `message` when present.
    let body = response.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|j| j.get("message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_else(|| if body.trim().is_empty() { "Unknown error".into() } else { body });
    log::warn!("github_delete {path} HTTP {status}: {msg}");
    Err(format!("GitHub API error ({status}): {msg}"))
}

// ── GitHub response cache (ETag-validated, persisted for REST) ────────────────
//
// REST GETs are cached by endpoint path. On the next request we send the stored
// ETag as `If-None-Match`; GitHub answers `304 Not Modified` (cheap — it doesn't
// count against the primary rate limit) when nothing changed, and we serve the
// cached body. This makes the frontend's refetch-on-view nearly free while staying
// current. (GraphQL has no ETags — the frontend's updatedAt version probe covers
// it, `shared/lib/github/githubProbe.ts`, #2448.)
//
// The REST subset (entries carrying an ETag) is PERSISTED to
// `~/.base-studio-code/github-http-cache.json` (#2448) so the free 304
// revalidation works cold across restarts: loaded lazily on first cache access,
// saved after each successful GET, capped at [`PERSIST_CAP`] newest entries.
// GraphQL entries are deliberately not persisted — with no ETag a cold entry
// can't be revalidated cheaply, only served blind.

struct CachedGet {
    etag: Option<String>,
    body: serde_json::Value,
    /// Seconds since the Unix epoch (not `Instant`, so entries survive persistence).
    fetched_at: u64,
}

impl CachedGet {
    /// Age of this entry (now − fetched_at; a backwards clock jump reads as zero).
    fn age(&self) -> std::time::Duration {
        std::time::Duration::from_secs(now_epoch().saturating_sub(self.fetched_at))
    }
}

/// Seconds since the Unix epoch (0 on a pre-1970 clock, which never happens in practice).
fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn github_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, CachedGet>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, CachedGet>>> =
        std::sync::OnceLock::new();
    // Lazily seed from the persisted REST entries (#2448): stale by TTL, but each carries an ETag,
    // so the first request per path revalidates with If-None-Match → a free 304 instead of a full
    // response. A missing/corrupt file just starts empty.
    CACHE.get_or_init(|| {
        std::sync::Mutex::new(load_persisted_cache(&crate::platform::paths::github_http_cache_file()))
    })
}

/// Drop every cached GitHub response — in memory AND the persisted file. Called when the token
/// changes (connect / disconnect / re-auth) so a new account never sees the previous one's bodies.
#[tauri::command]
pub(crate) fn github_cache_clear() {
    github_cache().lock().unwrap().clear();
    let _ = std::fs::remove_file(crate::platform::paths::github_http_cache_file());
}

/// Cap on persisted entries: newest-first by `fetched_at`, the oldest beyond this are evicted at
/// write time (the in-memory map itself is unbounded, as before).
const PERSIST_CAP: usize = 50;

/// One persisted REST cache entry — the on-disk twin of a `CachedGet` whose `etag` is present.
#[derive(serde::Deserialize)]
struct PersistedGet {
    etag: String,
    body: serde_json::Value,
    fetched_at: u64,
}

/// Borrowing serializer twin of [`PersistedGet`] so a snapshot never clones response bodies.
#[derive(serde::Serialize)]
struct PersistedGetRef<'a> {
    etag: &'a str,
    body: &'a serde_json::Value,
    fetched_at: u64,
}

/// Serialize the persistable subset of the cache: entries with an ETag (REST GETs) only, the
/// newest [`PERSIST_CAP`] kept. `None` only when serialization itself fails (never expected).
fn persist_snapshot(cache: &std::collections::HashMap<String, CachedGet>) -> Option<String> {
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

/// Load the persisted REST entries. Missing file ⇒ empty (first run); corrupt/poisoned file ⇒
/// empty with a warning — the cache is an optimization, never worth failing a request over.
fn load_persisted_cache(path: &std::path::Path) -> std::collections::HashMap<String, CachedGet> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return std::collections::HashMap::new();
    };
    let Ok(map) = serde_json::from_str::<std::collections::HashMap<String, PersistedGet>>(&text) else {
        log::warn!("github http cache at {} is corrupt; starting empty", path.display());
        return std::collections::HashMap::new();
    };
    map.into_iter()
        .map(|(path, p)| {
            (path, CachedGet { etag: Some(p.etag), body: p.body, fetched_at: p.fetched_at })
        })
        .collect()
}

/// Persist the cache's REST subset to disk (#2448). Snapshots (serializes) under the lock, writes
/// outside it. Best-effort: an IO failure only logs — the in-memory cache stays authoritative.
fn save_github_cache() {
    let Some(text) = persist_snapshot(&github_cache().lock().unwrap()) else { return };
    let path = crate::platform::paths::github_http_cache_file();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, text) {
        log::warn!("failed to persist github http cache to {}: {e}", path.display());
    }
}

// ── Rate-limit awareness (#2448) ───────────────────────────────────────────────
//
// GitHub signals its primary quota via `X-RateLimit-Remaining`/`X-RateLimit-Reset` and its
// secondary (abuse) limits via `Retry-After`. When a 403/429 says the quota is exhausted, an
// in-memory gate arms until the reset: further requests short-circuit with a TYPED error —
// `github rate-limited until <epoch secs>` — that the frontend distinguishes from real failures
// (a quiet "retrying after HH:MM" note instead of a red banner) while its persisted overlays
// (#2446) keep rendering the last-known data.

/// Epoch second the gate lifts; 0 = not rate-limited.
static RATE_LIMITED_UNTIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The one typed error string; the frontend matches its prefix (`rateLimitedUntil` in github.ts).
fn rate_limited_error(until: u64) -> String {
    format!("github rate-limited until {until}")
}

/// If the gate is armed and unexpired, the typed error to short-circuit with; an expired gate
/// disarms and lets the request through.
fn rate_limit_gate() -> Option<String> {
    use std::sync::atomic::Ordering;
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
    RATE_LIMITED_UNTIL.store(until, std::sync::atomic::Ordering::Relaxed);
    log::warn!("github rate limit exhausted (HTTP {status}); gating requests until epoch {until}");
    Some(rate_limited_error(until))
}

/// Whether a cached entry of the given age can be served without even revalidating.
/// `force` always revalidates; with no `max_age_secs` we always revalidate (the
/// revalidation is a cheap conditional request, so the default is "revalidate-on-view").
fn cache_is_fresh(age: std::time::Duration, max_age_secs: Option<u64>, force: bool) -> bool {
    if force {
        return false;
    }
    match max_age_secs {
        Some(max) => age < std::time::Duration::from_secs(max),
        None => false,
    }
}

/// Fold a GET outcome into the cache and return the body to hand back. A 304
/// reuses the cached entry (timestamp refreshed); otherwise the fresh `body`
/// (with its `etag`) replaces the entry. Returns `None` only on a 304 with no
/// cached entry (shouldn't happen) or a non-304 with no body.
fn apply_github_response(
    cache: &mut std::collections::HashMap<String, CachedGet>,
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

#[tauri::command]
pub(crate) async fn github_request(
    token: String,
    path: String,
    max_age_secs: Option<u64>,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("github_request");
    require_token(&token)?;
    let force = force.unwrap_or(false);

    // Within max_age: serve the cached body with no network call. Otherwise grab
    // the stored ETag so we can revalidate cheaply via If-None-Match.
    let cached_etag = {
        let cache = github_cache().lock().unwrap();
        match cache.get(&path) {
            Some(entry) if cache_is_fresh(entry.age(), max_age_secs, force) => {
                return Ok(entry.body.clone());
            }
            Some(entry) if !force => entry.etag.clone(),
            _ => None,
        }
    };

    // Rate-limit gate (#2448): while the quota is exhausted, don't spend the request — the
    // frontend distinguishes the typed error and keeps its cached/persisted view.
    if let Some(err) = rate_limit_gate() {
        return Err(err);
    }

    let url = format!("https://api.github.com/{}", path);
    let mut req = gh_std_headers(crate::platform::http::client().get(&url), &token);
    if let Some(etag) = &cached_etag {
        req = req.header("If-None-Match", etag.clone());
    }
    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            // Offline / transient: serve the last good body if we have one.
            if let Some(entry) = github_cache().lock().unwrap().get(&path) {
                log::warn!("github_request {path} request failed ({e}); serving cached body");
                return Ok(entry.body.clone());
            }
            return Err(format!("Request failed: {}", e));
        }
    };
    let status = response.status();

    // Exhausted rate limit (#2448): arm the gate and surface the typed error.
    if let Some(err) = note_rate_limit(status, response.headers()) {
        return Err(err);
    }

    // 304 Not Modified → the cached body is still current.
    if status == reqwest::StatusCode::NOT_MODIFIED {
        let body = {
            let mut cache = github_cache().lock().unwrap();
            apply_github_response(&mut cache, &path, true, None, None)
        };
        save_github_cache(); // the refreshed fetched_at drives TTL freshness + persist eviction
        return body
            .ok_or_else(|| "GitHub returned 304 but no cached body is available".to_string());
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
        apply_github_response(&mut cache, &path, false, etag, Some(json.clone()));
    }
    save_github_cache();
    Ok(json)
}

/// Create a GitHub gist (#598 M2) — publish an extension bundle (manifest + files) and
/// return the created gist JSON (`id`, `html_url`, `files[].raw_url`). Requires the
/// `gist` OAuth scope on the token. Reading a gist back uses `github_request("gists/<id>")`.
#[tauri::command]
pub(crate) async fn gist_create(
    token: String,
    files: std::collections::HashMap<String, String>,
    description: String,
    public: bool,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("gist_create");
    require_token(&token)?;
    if files.is_empty() {
        return Err("gist_create: no files to publish".to_string());
    }
    // GitHub's gist API shape: files = { "<name>": { "content": "<text>" } }.
    let files_json: serde_json::Map<String, serde_json::Value> = files
        .into_iter()
        .map(|(name, content)| (name, serde_json::json!({ "content": content })))
        .collect();
    let body = serde_json::json!({ "description": description, "public": public, "files": files_json });

    gist_request(
        reqwest::Method::POST,
        "https://api.github.com/gists".to_string(),
        "gist_create",
        &token,
        &body,
    )
    .await
}

/// Update an EXISTING gist (#970) — PATCH `gists/<id>` with new file content + description, so
/// re-publishing a blueprint updates its original gist instead of minting a duplicate. Requires the
/// `gist` scope and ownership of the gist. Returns the updated gist JSON (`id`, `html_url`, …).
#[tauri::command]
pub(crate) async fn gist_update(
    token: String,
    id: String,
    files: std::collections::HashMap<String, String>,
    description: String,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("gist_update");
    require_token(&token)?;
    if id.trim().is_empty() {
        return Err("gist_update: no gist id".to_string());
    }
    if files.is_empty() {
        return Err("gist_update: no files to publish".to_string());
    }
    let files_json: serde_json::Map<String, serde_json::Value> = files
        .into_iter()
        .map(|(name, content)| (name, serde_json::json!({ "content": content })))
        .collect();
    // `public` is omitted: a gist's visibility is fixed at creation and can't be changed via PATCH.
    let body = serde_json::json!({ "description": description, "files": files_json });

    gist_request(
        reqwest::Method::PATCH,
        format!("https://api.github.com/gists/{id}"),
        "gist_update",
        &token,
        &body,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        apply_github_response, cache_is_fresh, gh_error_message, gh_status_error,
        load_persisted_cache, now_epoch, persist_snapshot, rate_limit_gate, rate_limit_until_from,
        rate_limited_error, require_token, CachedGet, PERSIST_CAP, RATE_LIMITED_UNTIL,
    };
    use std::collections::HashMap;

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
        // pinned so the shared helper can't drift from the three sites it replaced.
        let json = serde_json::json!({ "message": "Not Found" });
        assert_eq!(
            gh_status_error(StatusCode::NOT_FOUND, &json, "github_request repos/x"),
            "GitHub API error (404 Not Found): Not Found",
        );
        // Absent `message` → the "Unknown error" fallback.
        let empty = serde_json::json!({ "documentation_url": "x" });
        assert_eq!(
            gh_status_error(StatusCode::UNPROCESSABLE_ENTITY, &empty, "github_graphql"),
            "GitHub API error (422 Unprocessable Entity): Unknown error",
        );
    }

    #[test]
    fn cache_is_fresh_only_within_max_age_and_never_when_forced() {
        use std::time::Duration;
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

    /// A `CachedGet` for the persistence tests: `etag: None` models a GraphQL entry.
    fn entry(etag: Option<&str>, n: u64, fetched_at: u64) -> CachedGet {
        CachedGet { etag: etag.map(str::to_string), body: serde_json::json!({ "n": n }), fetched_at }
    }

    #[test]
    fn persisted_cache_round_trips_rest_entries_and_skips_graphql() {
        let mut cache: HashMap<String, CachedGet> = HashMap::new();
        cache.insert("repos/a".into(), entry(Some("etag-a"), 1, 100));
        cache.insert("user/repos".into(), entry(Some("etag-b"), 2, 200));
        // GraphQL entries carry no ETag — they must NOT be persisted (cold, they can't be
        // revalidated cheaply; the frontend's updatedAt probe covers them).
        cache.insert("graphql:query{...}|".into(), entry(None, 3, 300));

        let text = persist_snapshot(&cache).expect("snapshot serializes");
        let path = crate::testutil::unique_dir("bsc-ghcache", "roundtrip").join("github-http-cache.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();

        let loaded = load_persisted_cache(&path);
        assert_eq!(loaded.len(), 2, "only the two REST entries persist");
        let a = loaded.get("repos/a").expect("repos/a survives the round trip");
        assert_eq!(a.etag.as_deref(), Some("etag-a"));
        assert_eq!(a.body, serde_json::json!({ "n": 1 }));
        assert_eq!(a.fetched_at, 100);
        assert!(!loaded.contains_key("graphql:query{...}|"));

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
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
        let dir = crate::testutil::unique_dir("bsc-ghcache", "corrupt");
        // Missing file (first run) → empty, no error.
        assert!(load_persisted_cache(&dir.join("nope.json")).is_empty());
        // Corrupt file → empty (start over), never a panic/failure.
        std::fs::create_dir_all(&dir).unwrap();
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
        use std::sync::atomic::Ordering;
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
}

