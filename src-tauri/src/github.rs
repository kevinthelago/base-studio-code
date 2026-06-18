// GitHub REST/GraphQL proxy + ETag-validated response cache
// (extracted from lib.rs, #758).

use crate::PerfSpan;


#[tauri::command]
pub(crate) async fn github_graphql(
    token: String,
    query: String,
    variables: Option<serde_json::Value>,
    max_age_secs: Option<u64>,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("github_graphql");
    if token.is_empty() {
        return Err("No GitHub token provided.".to_string());
    }
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

    let client = reqwest::Client::new();
    let mut body = serde_json::json!({ "query": query });
    if let Some(vars) = variables {
        body["variables"] = vars;
    }
    let response = client
        .post("https://api.github.com/graphql")
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .header("User-Agent", "base-studio-code/0.2.0")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    if !status.is_success() {
        let msg = json["message"].as_str().unwrap_or("Unknown error").to_string();
        log::warn!("github_graphql HTTP {status}: {msg}");
        return Err(format!("GitHub API error ({}): {}", status, msg));
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
    if token.is_empty() {
        return Err("No GitHub token provided.".to_string());
    }
    let client = reqwest::Client::new();
    let url = format!("https://api.github.com/{}", path);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "base-studio-code/0.2.0")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    if !status.is_success() {
        let msg = json["message"].as_str().unwrap_or("Unknown error").to_string();
        log::warn!("github_post {path} HTTP {status}: {msg}");
        return Err(format!("GitHub API error ({}): {}", status, msg));
    }
    Ok(json)
}

#[tauri::command]
pub(crate) async fn github_put(
    token: String,
    path: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("github_put");
    if token.is_empty() {
        return Err("No GitHub token provided.".to_string());
    }
    let client = reqwest::Client::new();
    let url = format!("https://api.github.com/{}", path);
    let response = client
        .put(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "base-studio-code/0.2.0")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    if !status.is_success() {
        let msg = json["message"].as_str().unwrap_or("Unknown error").to_string();
        log::warn!("github_put {path} HTTP {status}: {msg}");
        return Err(format!("GitHub API error ({}): {}", status, msg));
    }
    Ok(json)
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
    if token.is_empty() {
        return Err("No GitHub token provided.".to_string());
    }
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

    let client = reqwest::Client::new();
    let url = format!("https://api.github.com/{}", path);
    let mut req = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "base-studio-code/0.2.0");
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
        let msg = json["message"].as_str().unwrap_or("Unknown error").to_string();
        log::warn!("github_request {path} HTTP {status}: {msg}");
        return Err(format!("GitHub API error ({}): {}", status, msg));
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
    if token.is_empty() {
        return Err("No GitHub token provided.".to_string());
    }
    if files.is_empty() {
        return Err("gist_create: no files to publish".to_string());
    }
    // GitHub's gist API shape: files = { "<name>": { "content": "<text>" } }.
    let files_json: serde_json::Map<String, serde_json::Value> = files
        .into_iter()
        .map(|(name, content)| (name, serde_json::json!({ "content": content })))
        .collect();
    let body = serde_json::json!({ "description": description, "public": public, "files": files_json });

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.github.com/gists")
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "base-studio-code/0.2.0")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("gist_create request failed: {e}"))?;
    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("gist_create: failed to parse response: {e}"))?;
    if !status.is_success() {
        let msg = json["message"].as_str().unwrap_or("unknown error");
        return Err(format!("gist_create HTTP {status}: {msg}"));
    }
    Ok(json)
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
    if token.is_empty() {
        return Err("No GitHub token provided.".to_string());
    }
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

    let client = reqwest::Client::new();
    let response = client
        .patch(format!("https://api.github.com/gists/{id}"))
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "base-studio-code/0.2.0")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("gist_update request failed: {e}"))?;
    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("gist_update: failed to parse response: {e}"))?;
    if !status.is_success() {
        let msg = json["message"].as_str().unwrap_or("unknown error");
        return Err(format!("gist_update HTTP {status}: {msg}"));
    }
    Ok(json)
}

#[cfg(test)]
mod tests {
    use super::{cache_is_fresh, apply_github_response, CachedGet};
    use std::collections::HashMap;

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

