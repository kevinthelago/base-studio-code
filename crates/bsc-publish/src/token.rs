//! Where a headless publish gets its GitHub token.
//!
//! THIS IS THE REASON PUBLISH COULD NOT BE HEADLESS, and it is not obvious from the call sites.
//! The OAuth device flow (`src-tauri/src/github/oauth.rs`) hands the access token to the FRONTEND
//! and persists nothing Rust-side; `githubToken` is a persisted Zustand key. So the only copy of a
//! connected user's token lives in the app's frontend state file. There is no keychain entry for it
//! (src-tauri's `keyring` use covers data-SOURCE credentials, not GitHub) and nothing read an env
//! var.
//!
//! The chain below is ordered most-explicit-first, so an operator can always override what was
//! discovered:
//!
//! 1. an explicit `--token`
//! 2. `GITHUB_TOKEN` / `GH_TOKEN` — the conventional names, and what CI sets
//! 3. `gh auth token` — every session already probes `gh auth` for readiness, so a live agent
//!    session usually has one
//! 4. the app's persisted frontend state — the token the connected UI is holding right now
//!
//! Step 4 deliberately reaches into a frontend-owned file, which is a coupling worth naming rather
//! than hiding: it exists so publishing from a session works for an already-connected user without
//! making them re-authenticate somewhere else. If the token ever moves to a Rust-owned store, this
//! step is the one to delete.

use std::path::PathBuf;
use std::process::Command;

/// Where the token came from — reported so a failure names what was tried, and a success can say
/// which source won without ever printing the token itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSource {
    Explicit,
    Env(&'static str),
    GhCli,
    AppState,
}

impl TokenSource {
    pub fn describe(&self) -> String {
        match self {
            TokenSource::Explicit => "--token".to_string(),
            TokenSource::Env(name) => format!("${name}"),
            TokenSource::GhCli => "gh auth token".to_string(),
            TokenSource::AppState => "the app's saved GitHub connection".to_string(),
        }
    }
}

/// The app's persisted frontend state, holding `githubToken` for a connected user.
///
/// Tauri's store plugin writes under the OS app-data dir keyed by the bundle identifier. Only the
/// Linux/macOS/Windows conventional locations are consulted; a miss is simply "no token here".
fn app_state_files() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let id = "com.basestudio.code";
    if let Some(home) = bsc_home() {
        out.push(home.join(".local/share").join(id).join("app-state.json"));
        out.push(home.join("Library/Application Support").join(id).join("app-state.json"));
        out.push(home.join("AppData/Roaming").join(id).join("app-state.json"));
    }
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            out.push(PathBuf::from(xdg).join(id).join("app-state.json"));
        }
    }
    out
}

fn bsc_home() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// Pull `githubToken` out of the app-state JSON.
///
/// The file is `{"app-state": "<json string>"}` — the persisted blob is a STRING holding JSON, not
/// a nested object, so it needs a second parse. Written as a pure function over the file text so a
/// test can pin that double-encoding without an app installed.
pub fn token_from_app_state(text: &str) -> Option<String> {
    let outer: serde_json::Value = serde_json::from_str(text).ok()?;
    let inner_raw = outer.get("app-state")?;
    let inner: serde_json::Value = match inner_raw {
        serde_json::Value::String(s) => serde_json::from_str(s).ok()?,
        other => other.clone(),
    };
    // zustand/persist may or may not wrap in `{state, version}`.
    let state = inner.get("state").unwrap_or(&inner);
    let token = state.get("githubToken")?.as_str()?.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// Resolve a token through the chain, or explain what was tried.
pub fn resolve(explicit: Option<&str>) -> Result<(String, TokenSource), String> {
    if let Some(t) = explicit.map(str::trim).filter(|t| !t.is_empty()) {
        return Ok((t.to_string(), TokenSource::Explicit));
    }
    for name in ["GITHUB_TOKEN", "GH_TOKEN"] {
        if let Ok(v) = std::env::var(name) {
            let v = v.trim().to_string();
            if !v.is_empty() {
                return Ok((v, TokenSource::Env(if name == "GITHUB_TOKEN" { "GITHUB_TOKEN" } else { "GH_TOKEN" })));
            }
        }
    }
    if let Ok(out) = Command::new("gh").args(["auth", "token"]).output() {
        if out.status.success() {
            let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !t.is_empty() {
                return Ok((t, TokenSource::GhCli));
            }
        }
    }
    for path in app_state_files() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Some(t) = token_from_app_state(&text) {
                return Ok((t, TokenSource::AppState));
            }
        }
    }
    Err("No GitHub token. Pass --token, set GITHUB_TOKEN, run `gh auth login`, \
         or connect GitHub in the app (Settings → GitHub)."
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_state_token_survives_the_double_encoding() {
        // The real file shape: the persisted blob is a JSON STRING inside a JSON object. Reading it
        // with one parse yields a string, not a map — which is exactly the bug a naive
        // implementation ships, and it would look like "the user isn't connected".
        let inner = serde_json::json!({ "githubToken": "ghp_abc", "githubConnected": true }).to_string();
        let outer = serde_json::json!({ "app-state": inner }).to_string();
        assert_eq!(token_from_app_state(&outer).as_deref(), Some("ghp_abc"));

        // A `{state: …}` wrapper is tolerated too, since zustand/persist may add one.
        let wrapped = serde_json::json!({
            "app-state": serde_json::json!({ "state": { "githubToken": "ghp_xyz" } }).to_string()
        })
        .to_string();
        assert_eq!(token_from_app_state(&wrapped).as_deref(), Some("ghp_xyz"));
    }

    #[test]
    fn a_disconnected_app_yields_no_token_rather_than_an_empty_one() {
        // The observed real state on a machine that has never connected: the key EXISTS and is "".
        // Returning Some("") would send an unauthenticated request that fails much later, with a
        // GitHub error instead of "you aren't connected".
        let outer = serde_json::json!({
            "app-state": serde_json::json!({ "githubToken": "", "githubConnected": false }).to_string()
        })
        .to_string();
        assert_eq!(token_from_app_state(&outer), None);

        // Whitespace-only is the same case.
        let ws = serde_json::json!({
            "app-state": serde_json::json!({ "githubToken": "   " }).to_string()
        })
        .to_string();
        assert_eq!(token_from_app_state(&ws), None);

        // Absent key, and outright garbage, are misses — never panics.
        assert_eq!(token_from_app_state(r#"{"app-state":"{}"}"#), None);
        assert_eq!(token_from_app_state("not json"), None);
        assert_eq!(token_from_app_state("{}"), None);
    }

    #[test]
    fn an_explicit_token_wins_over_every_discovered_source() {
        // Explicit-first is what makes the chain safe to extend: an operator can always override
        // whatever was found in the environment or the app's saved connection.
        let (tok, src) = resolve(Some("ghp_explicit")).unwrap();
        assert_eq!(tok, "ghp_explicit");
        assert_eq!(src, TokenSource::Explicit);
        // Blank/whitespace explicit is NOT a token — it falls through to the rest of the chain.
        assert!(resolve(Some("   ")).map(|(_, s)| s) != Ok(TokenSource::Explicit));
    }

    #[test]
    fn a_source_describes_itself_without_ever_revealing_the_token() {
        for s in [
            TokenSource::Explicit,
            TokenSource::Env("GITHUB_TOKEN"),
            TokenSource::GhCli,
            TokenSource::AppState,
        ] {
            let d = s.describe();
            assert!(!d.is_empty());
            assert!(!d.contains("ghp_"), "a source description must never carry a token: {d}");
        }
    }
}
