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
    let url = format!("https://api.github.com/{}", path);
    let (status, json) = crate::platform::http::send_json(
        gh_std_headers(crate::platform::http::client().request(method, url), token).json(body),
        |e| format!("Request failed: {}", e),
        |e| format!("Failed to parse response: {}", e),
    )
    .await?;
    if !status.is_success() {
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
            if cache_is_fresh(entry.fetched_at.elapsed(), max_age_secs, false) {
                return Ok(entry.body.clone());
            }
        }
    }

    let mut body = serde_json::json!({ "query": query });
    if let Some(vars) = variables {
        body["variables"] = vars;
    }
    let (status, json) = crate::platform::http::send_json(
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
    github_cache().lock().unwrap().insert(
        cache_key,
        CachedGet { etag: None, body: data.clone(), fetched_at: std::time::Instant::now() },
    );
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

// ── GitHub response cache (ETag-validated, in-memory) ──────────────────────────
//
// REST GETs are cached by endpoint path. On the next request we send the stored
// ETag as `If-None-Match`; GitHub answers `304 Not Modified` (cheap — it doesn't
// count against the primary rate limit) when nothing changed, and we serve the
// cached body. This makes the frontend's refetch-on-view nearly free while staying
// current. (GraphQL has no ETags — a separate TTL/version-probe pass covers it.)

struct CachedGet {
    etag: Option<String>,
    body: serde_json::Value,
    fetched_at: std::time::Instant,
}

fn github_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, CachedGet>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, CachedGet>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Drop every cached GitHub response. Called when the token changes (connect /
/// disconnect / re-auth) so a new account never sees the previous one's bodies.
#[tauri::command]
pub(crate) fn github_cache_clear() {
    github_cache().lock().unwrap().clear();
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
        entry.fetched_at = std::time::Instant::now();
        return Some(entry.body.clone());
    }
    let b = body?;
    cache.insert(
        path.to_string(),
        CachedGet { etag, body: b.clone(), fetched_at: std::time::Instant::now() },
    );
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
            Some(entry) if cache_is_fresh(entry.fetched_at.elapsed(), max_age_secs, force) => {
                return Ok(entry.body.clone());
            }
            Some(entry) if !force => entry.etag.clone(),
            _ => None,
        }
    };

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

    // 304 Not Modified → the cached body is still current.
    if status == reqwest::StatusCode::NOT_MODIFIED {
        let mut cache = github_cache().lock().unwrap();
        return apply_github_response(&mut cache, &path, true, None, None)
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
    let mut cache = github_cache().lock().unwrap();
    apply_github_response(&mut cache, &path, false, etag, Some(json.clone()));
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
        cache_is_fresh, apply_github_response, gh_error_message, gh_status_error, require_token,
        CachedGet,
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
}

