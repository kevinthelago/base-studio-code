//! GitHub REST/GraphQL proxy — the Tauri command surface.
//!
//! The transport itself (headers, error wording, the ETag-validated response cache and its
//! persistence, the rate-limit gate, and every verb) lives in the Tauri-free `bsc-github` crate
//! (`extract-a-tauri-free-github-transport-crate`). It used to live here, which meant `bsc` — a
//! separate binary — could not reach GitHub at all, and publishing a plan had no path that did not
//! run through a React hook.
//!
//! What remains here is ONLY what is app-specific: the `#[tauri::command]` shims, their
//! `PerfSpan` instrumentation, and the argument shapes the frontend already invokes with. Behaviour
//! is unchanged — these delegate, they do not reimplement, so the app and the CLI cannot drift.

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
    bsc_github::graphql(&token, &query, variables, max_age_secs, force.unwrap_or(false)).await
}

#[tauri::command]
pub(crate) async fn github_post(
    token: String,
    path: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("github_post");
    bsc_github::post(&token, &path, &body).await
}

#[tauri::command]
pub(crate) async fn github_put(
    token: String,
    path: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("github_put");
    bsc_github::put(&token, &path, &body).await
}

/// `PATCH https://api.github.com/{path}` with a JSON body. The REST verb GitHub uses to
/// *update* an existing resource — notably `PATCH /repos/{owner}/{repo}` to set a repo's
/// description/homepage at publish (#1114). Surfaces a non-2xx as an `Err` (the caller decides
/// whether that's fatal) rather than swallowing it.
#[tauri::command]
pub(crate) async fn github_patch(
    token: String,
    path: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("github_patch");
    bsc_github::patch(&token, &path, &body).await
}

#[tauri::command]
pub(crate) async fn github_delete(token: String, path: String) -> Result<(), String> {
    let _perf = PerfSpan::new("github_delete");
    bsc_github::delete(&token, &path).await
}

#[tauri::command]
pub(crate) async fn github_request(
    token: String,
    path: String,
    max_age_secs: Option<u64>,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("github_request");
    bsc_github::request(&token, &path, max_age_secs, force.unwrap_or(false)).await
}

/// Drop every cached GitHub response — in memory AND the persisted file. Called when the token
/// changes (connect / disconnect / re-auth) so a new account never sees the previous one's bodies.
#[tauri::command]
pub(crate) fn github_cache_clear() {
    bsc_github::cache_clear();
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
    bsc_github::gist_create(&token, files, &description, public).await
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
    bsc_github::gist_update(&token, &id, files, &description).await
}
