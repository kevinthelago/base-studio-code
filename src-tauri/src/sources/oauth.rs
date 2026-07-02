//! OAuth 2.0 authorization-code + PKCE flow for migration source connectors (#1197).
//!
//! Desktop loopback-redirect flow: `source_oauth_begin` returns the provider's authorize URL (the
//! frontend opens it in the system browser), and a background thread captures the `?code=` on a
//! `127.0.0.1` listener, exchanges it for an access token, stores the token in the OS keychain
//! (#1194 — never in the config or shared with the planner), and emits `source-oauth-complete`.
//!
//! Client ids/secrets are **per-deployment** OAuth apps, read from env (`BSC_OAUTH_<PROVIDER>_
//! CLIENT_ID` / `_SECRET`) — there are no baked credentials. The provider URLs/scopes are
//! best-effort defaults (like the connector presets) and may need per-tenant tuning. The
//! interactive browser round-trip is not exercised offline; the unit tests cover the pure parts
//! (PKCE S256, the authorize URL, provider lookup).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use base64::Engine;
use rand::Rng;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::Emitter;

/// An OAuth provider descriptor for a source connector. The descriptors are versioned, editable
/// **data** in `src-tauri/data/sources/oauth-providers.json` (#1614, mirroring `data/stages/*.json`)
/// — best-effort defaults (like the connector presets) that may need per-tenant tuning. Note
/// Dynamics 365's resource scope is org-specific (`{org}.crm.dynamics.com/.default`); set
/// `BSC_OAUTH_DYNAMICS_SCOPE` to override the packaged default per tenant.
#[derive(serde::Deserialize)]
struct OAuthProvider {
    id: String,
    authorize_url: String,
    token_url: String,
    scopes: String,
    client_id_env: String,
    client_secret_env: String,
}

/// The parsed provider table (lazily initialized; `'static` for the program's lifetime so lookups
/// can hand out `'static` references). Loaded at runtime via [`crate::platform::config::load_str`]
/// (#2027 P2) — the user's `sources/oauth-providers.json` under the config dir if present, else the
/// embedded seed. Panics on first use if the JSON is malformed, guarded by `providers_json_parses`.
fn providers() -> &'static [OAuthProvider] {
    static PROVIDERS: OnceLock<Vec<OAuthProvider>> = OnceLock::new();
    PROVIDERS
        .get_or_init(|| {
            serde_json::from_str(&crate::platform::config::load_str("sources/oauth-providers.json"))
                .expect("oauth-providers.json is valid JSON")
        })
        .as_slice()
}

fn provider(id: &str) -> Option<&'static OAuthProvider> {
    providers().iter().find(|p| p.id == id)
}

/// A fully resolved OAuth descriptor, source-agnostic: the begin flow works the same whether the
/// endpoints came from a packaged [`OAuthProvider`] (client id/secret from env) or from an
/// agent-authored [`RuntimeOAuth`](bsc_data::runtime::RuntimeOAuth) block carried by a runtime
/// preset (PKCE public — empty `client_secret`). (#1972)
struct ResolvedOAuth {
    authorize_url: String,
    token_url: String,
    scopes: String,
    client_id: String,
    client_secret: String,
}

/// Resolve a connector's OAuth endpoints + client credentials, source-agnostic (#1972).
///
/// Resolution order:
/// 1. A **packaged** provider (`oauth-providers.json`): `client_id` from `$<client_id_env>` (errors
///    if unset), `client_secret` from `$<client_secret_env>` (optional — empty ⇒ PKCE public),
///    URLs/scopes from the descriptor.
/// 2. Else an **agent-authored** runtime preset with `auth == "oauth"` and an `oauth` block: the
///    endpoints/scopes/client_id come straight from the manifest and `client_secret` is empty (PKCE
///    public — the manifest never carries a secret, #1194).
/// 3. Else an error — no OAuth provider for this id.
fn resolve_oauth(connector_id: &str) -> Result<ResolvedOAuth, String> {
    if let Some(p) = provider(connector_id) {
        let client_id = std::env::var(&p.client_id_env)
            .map_err(|_| format!("OAuth not configured: set {}", p.client_id_env))?;
        let client_secret = std::env::var(&p.client_secret_env).unwrap_or_default();
        return Ok(ResolvedOAuth {
            authorize_url: p.authorize_url.clone(),
            token_url: p.token_url.clone(),
            scopes: p.scopes.clone(),
            client_id,
            client_secret,
        });
    }

    let store = bsc_data::runtime::runtime_store_path();
    if let Ok(Some(preset)) = bsc_data::runtime::find_runtime_preset(&store, connector_id) {
        if preset.auth == "oauth" {
            if let Some(o) = preset.oauth {
                return Ok(ResolvedOAuth {
                    authorize_url: o.authorize_url,
                    token_url: o.token_url,
                    scopes: o.scopes,
                    client_id: o.client_id,
                    client_secret: String::new(), // PKCE public — no secret in the manifest
                });
            }
        }
    }

    Err(format!("no OAuth provider for `{connector_id}`"))
}

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// The PKCE S256 challenge for a verifier: base64url(sha256(verifier)).
fn s256_challenge(verifier: &str) -> String {
    B64.encode(Sha256::digest(verifier.as_bytes()))
}

/// A fresh PKCE (verifier, S256 challenge) pair.
fn pkce() -> (String, String) {
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    let verifier = B64.encode(buf);
    let challenge = s256_challenge(&verifier);
    (verifier, challenge)
}

/// A random opaque token (CSRF `state`).
fn random_state() -> String {
    let mut buf = [0u8; 16];
    rand::rng().fill_bytes(&mut buf);
    B64.encode(buf)
}

/// Percent-encode a query-parameter value (RFC 3986 unreserved pass through).
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Percent-decode a query value (`+` → space, `%XX` → byte).
fn dec(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 2;
                } else {
                    out.push(b'%');
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// For Salesforce, swap the auth host to the sandbox domain when `env == "sandbox"`.
fn host_for_env(url: &str, connector_id: &str, env: Option<&str>) -> String {
    if connector_id == "salesforce" && env == Some("sandbox") {
        url.replace("login.salesforce.com", "test.salesforce.com")
    } else {
        url.to_string()
    }
}

/// Build the resolved provider's authorization URL with PKCE.
fn build_authorize_url(
    r: &ResolvedOAuth,
    connector_id: &str,
    redirect: &str,
    state: &str,
    challenge: &str,
    env: Option<&str>,
) -> String {
    let base = host_for_env(&r.authorize_url, connector_id, env);
    let scope = std::env::var("BSC_OAUTH_DYNAMICS_SCOPE")
        .ok()
        .filter(|_| connector_id == "dynamics365")
        .unwrap_or_else(|| r.scopes.clone());
    format!(
        "{base}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        enc(&r.client_id), enc(redirect), enc(&scope), enc(state), enc(challenge)
    )
}

/// What the begin command returns to the frontend (which opens the URL in the system browser).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthBegin {
    authorize_url: String,
}

/// The completion event payload (`source-oauth-complete`).
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OAuthDone {
    source_uid: String,
    ok: bool,
    /// Salesforce instance_url, if returned — the scan's base URL.
    instance: Option<String>,
    /// QuickBooks realmId, if present on the callback — the company scope.
    realm: Option<String>,
    error: Option<String>,
}

/// Begin an OAuth flow: returns the authorize URL and spawns the loopback capture in the
/// background, which stores the token and emits `source-oauth-complete` when done.
#[tauri::command]
pub fn source_oauth_begin(
    app: tauri::AppHandle,
    connector_id: String,
    project: String,
    source_uid: String,
    env: Option<String>,
) -> Result<OAuthBegin, String> {
    let resolved = resolve_oauth(&connector_id)?;
    let client_id = resolved.client_id.clone();
    let client_secret = resolved.client_secret.clone();

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let (verifier, challenge) = pkce();
    let state = random_state();
    let authorize_url =
        build_authorize_url(&resolved, &connector_id, &redirect, &state, &challenge, env.as_deref());

    let token_url = host_for_env(&resolved.token_url, &connector_id, env.as_deref());
    std::thread::spawn(move || {
        let done = match capture_and_exchange(&listener, &token_url, &client_id, &client_secret, &redirect, &verifier, &state) {
            Ok(tok) => {
                let mut ok = crate::sources::credentials::set_secret(&project, &source_uid, "accessToken", &tok.access).is_ok();
                if let Some(r) = tok.refresh {
                    ok &= crate::sources::credentials::set_secret(&project, &source_uid, "refreshToken", &r).is_ok();
                }
                OAuthDone { source_uid: source_uid.clone(), ok, instance: tok.instance, realm: tok.realm, error: None }
            }
            Err(e) => OAuthDone { source_uid: source_uid.clone(), ok: false, instance: None, realm: None, error: Some(e) },
        };
        let _ = app.emit("source-oauth-complete", done);
    });

    Ok(OAuthBegin { authorize_url })
}

/// The tokens (and provider scope hints) captured from an OAuth redirect + code exchange.
struct ExchangedTokens {
    access: String,
    refresh: Option<String>,
    /// Provider instance/base URL (e.g. Salesforce), when returned.
    instance: Option<String>,
    /// QuickBooks company id (`realmId`), when present on the callback.
    realm: Option<String>,
}

/// Wait for the browser redirect on the loopback listener, validate `state`, and exchange the
/// code for tokens.
fn capture_and_exchange(
    listener: &TcpListener,
    token_url: &str,
    client_id: &str,
    client_secret: &str,
    redirect: &str,
    verifier: &str,
    expected_state: &str,
) -> Result<ExchangedTokens, String> {
    let params = wait_for_redirect(listener, Duration::from_secs(300))?;
    if params.get("state").map(String::as_str) != Some(expected_state) {
        return Err("OAuth state mismatch (possible CSRF) — aborted".into());
    }
    if let Some(err) = params.get("error") {
        return Err(format!("authorization denied: {err}"));
    }
    let code = params.get("code").ok_or("no authorization code in the redirect")?;
    let realm = params.get("realmId").cloned(); // QuickBooks company id

    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect),
        ("client_id", client_id),
        ("code_verifier", verifier),
    ];
    if !client_secret.is_empty() {
        form.push(("client_secret", client_secret));
    }
    let resp: Value = crate::platform::http::blocking_send_json(
        crate::platform::http::blocking_client()
            .post(token_url)
            .form(&form)
            .header("Accept", "application/json"),
        |e| format!("token exchange failed: {e}"),
    )?;

    let access = resp["access_token"].as_str().ok_or("token response missing access_token")?.to_string();
    let refresh = resp["refresh_token"].as_str().map(str::to_string);
    let instance = resp["instance_url"].as_str().map(str::to_string);
    Ok(ExchangedTokens { access, refresh, instance, realm })
}

/// Accept one loopback connection (until `timeout`), parse the callback query, and reply with a
/// small "you can close this tab" page.
fn wait_for_redirect(listener: &TcpListener, timeout: Duration) -> Result<HashMap<String, String>, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
                let req = String::from_utf8_lossy(&buf[..n]);
                let query = req
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1)) // the path
                    .and_then(|path| path.split_once('?').map(|(_, q)| q.to_string()))
                    .unwrap_or_default();
                let body = "<html><body style=\"font-family:sans-serif;padding:40px\">\
                    <h3>Connected.</h3><p>You can close this tab and return to base-studio-code.</p></body></html>";
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                return Ok(parse_query(&query));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("timed out waiting for the OAuth redirect".into());
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn parse_query(qs: &str) -> HashMap<String, String> {
    qs.split('&')
        .filter(|p| !p.is_empty())
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            Some((dec(k), dec(v)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_s256_matches_rfc7636_vector() {
        // RFC 7636 Appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(s256_challenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn pkce_pair_is_well_formed() {
        let (v, c) = pkce();
        assert!(v.len() >= 43, "verifier must be ≥43 chars");
        assert_eq!(c, s256_challenge(&v));
        assert!(!v.contains('=') && !v.contains('+') && !v.contains('/'), "url-safe, unpadded");
    }

    /// Build a `ResolvedOAuth` from a packaged provider with an explicit client id (test helper).
    fn resolved_from(id: &str, client_id: &str) -> ResolvedOAuth {
        let p = provider(id).unwrap();
        ResolvedOAuth {
            authorize_url: p.authorize_url.clone(),
            token_url: p.token_url.clone(),
            scopes: p.scopes.clone(),
            client_id: client_id.to_string(),
            client_secret: String::new(),
        }
    }

    #[test]
    fn authorize_url_carries_pkce_and_redirect() {
        let r = resolved_from("salesforce", "CID");
        let url = build_authorize_url(&r, "salesforce", "http://127.0.0.1:9/callback", "st8", "chal", None);
        assert!(url.starts_with("https://login.salesforce.com/services/oauth2/authorize?"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("client_id=CID"));
        assert!(url.contains("code_challenge=chal"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcallback"));
    }

    #[test]
    fn salesforce_sandbox_swaps_the_auth_host() {
        let r = resolved_from("salesforce", "C");
        let url = build_authorize_url(&r, "salesforce", "r", "s", "c", Some("sandbox"));
        assert!(url.contains("test.salesforce.com"));
        assert!(!url.contains("login.salesforce.com"));
    }

    /// #1972: a runtime preset's self-describing `oauth` block resolves (PKCE public — empty
    /// client_secret) and the built authorize URL carries the manifest's client_id + PKCE.
    #[test]
    fn resolve_oauth_reads_a_runtime_preset_oauth_block() {
        use bsc_data::runtime::{RuntimeOAuth, RuntimePreset, RuntimeResource};

        let store = std::env::temp_dir().join("bsc-oauth-resolve-1972.json");
        let _ = std::fs::remove_file(&store);
        let preset = RuntimePreset {
            id: "acme-oauth".to_string(),
            label: "Acme".to_string(),
            category: "crm".to_string(),
            base_url: Some("https://acme.example.com/api".to_string()),
            auth: "oauth".to_string(),
            oauth: Some(RuntimeOAuth {
                authorize_url: "https://acme.example.com/oauth/authorize".to_string(),
                token_url: "https://acme.example.com/oauth/token".to_string(),
                scopes: "read".to_string(),
                client_id: "acme-public-client-id".to_string(),
            }),
            resources: vec![RuntimeResource {
                name: "contacts".to_string(),
                path: "contacts".to_string(),
                array_key: Some("data".to_string()),
            }],
        };
        bsc_data::runtime::save_runtime_presets(&store, &[preset]).unwrap();

        // `BSC_CONNECTORS` is process-global; this test owns it for the duration.
        std::env::set_var("BSC_CONNECTORS", &store);
        let resolved = resolve_oauth("acme-oauth").expect("runtime oauth resolves");
        std::env::remove_var("BSC_CONNECTORS");
        let _ = std::fs::remove_file(&store);

        assert_eq!(resolved.authorize_url, "https://acme.example.com/oauth/authorize");
        assert_eq!(resolved.token_url, "https://acme.example.com/oauth/token");
        assert_eq!(resolved.client_id, "acme-public-client-id");
        assert!(resolved.client_secret.is_empty(), "PKCE public — no secret in the manifest");

        let url = build_authorize_url(&resolved, "acme-oauth", "http://127.0.0.1:9/callback", "st8", "chal", None);
        assert!(url.starts_with("https://acme.example.com/oauth/authorize?"));
        assert!(url.contains("client_id=acme-public-client-id"));
        assert!(url.contains("code_challenge=chal"));
        assert!(url.contains("code_challenge_method=S256"));
    }

    #[test]
    fn parse_query_decodes_pairs() {
        let q = parse_query("code=a%2Bb&state=xyz&realmId=12345");
        assert_eq!(q.get("code").unwrap(), "a+b");
        assert_eq!(q.get("state").unwrap(), "xyz");
        assert_eq!(q.get("realmId").unwrap(), "12345");
    }

    #[test]
    fn provider_lookup() {
        assert!(provider("salesforce").is_some());
        assert!(provider("quickbase").is_none()); // token connector, not OAuth
    }

    /// Guard the data extraction (#1614): the packaged `oauth-providers.json` parses, carries every
    /// known provider, and preserves their URLs/scopes/env-var names — so an edit to the JSON can't
    /// silently drop a provider or corrupt a descriptor.
    #[test]
    fn providers_json_parses() {
        let all = providers();
        assert_eq!(all.len(), 5, "five OAuth providers");

        let mut ids: Vec<&str> = all.iter().map(|p| p.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["dynamics365", "hubspot", "monday", "quickbooks", "salesforce"]);

        let sf = provider("salesforce").unwrap();
        assert_eq!(sf.authorize_url, "https://login.salesforce.com/services/oauth2/authorize");
        assert_eq!(sf.token_url, "https://login.salesforce.com/services/oauth2/token");
        assert_eq!(sf.scopes, "api refresh_token");
        assert_eq!(sf.client_id_env, "BSC_OAUTH_SALESFORCE_CLIENT_ID");
        assert_eq!(sf.client_secret_env, "BSC_OAUTH_SALESFORCE_CLIENT_SECRET");

        let dyn365 = provider("dynamics365").unwrap();
        assert_eq!(dyn365.scopes, "offline_access openid");
        assert_eq!(dyn365.client_id_env, "BSC_OAUTH_DYNAMICS_CLIENT_ID");
    }
}
