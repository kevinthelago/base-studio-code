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
use std::time::{Duration, Instant};

use base64::Engine;
use rand::Rng;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::Emitter;

/// An OAuth provider for a source connector.
struct OAuthProvider {
    id: &'static str,
    authorize_url: &'static str,
    token_url: &'static str,
    scopes: &'static str,
    client_id_env: &'static str,
    client_secret_env: &'static str,
}

const PROVIDERS: &[OAuthProvider] = &[
    OAuthProvider {
        id: "salesforce",
        authorize_url: "https://login.salesforce.com/services/oauth2/authorize",
        token_url: "https://login.salesforce.com/services/oauth2/token",
        scopes: "api refresh_token",
        client_id_env: "BSC_OAUTH_SALESFORCE_CLIENT_ID",
        client_secret_env: "BSC_OAUTH_SALESFORCE_CLIENT_SECRET",
    },
    OAuthProvider {
        id: "quickbooks",
        authorize_url: "https://appcenter.intuit.com/connect/oauth2",
        token_url: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        scopes: "com.intuit.quickbooks.accounting",
        client_id_env: "BSC_OAUTH_QUICKBOOKS_CLIENT_ID",
        client_secret_env: "BSC_OAUTH_QUICKBOOKS_CLIENT_SECRET",
    },
    OAuthProvider {
        id: "hubspot",
        authorize_url: "https://app.hubspot.com/oauth/authorize",
        token_url: "https://api.hubapi.com/oauth/v1/token",
        scopes: "crm.objects.contacts.read crm.objects.companies.read crm.objects.deals.read",
        client_id_env: "BSC_OAUTH_HUBSPOT_CLIENT_ID",
        client_secret_env: "BSC_OAUTH_HUBSPOT_CLIENT_SECRET",
    },
    OAuthProvider {
        id: "monday",
        authorize_url: "https://auth.monday.com/oauth2/authorize",
        token_url: "https://auth.monday.com/oauth2/token",
        scopes: "boards:read",
        client_id_env: "BSC_OAUTH_MONDAY_CLIENT_ID",
        client_secret_env: "BSC_OAUTH_MONDAY_CLIENT_SECRET",
    },
    OAuthProvider {
        // Dynamics 365's resource scope is org-specific ({org}.crm.dynamics.com/.default) — set
        // BSC_OAUTH_DYNAMICS_SCOPE to override the default below per tenant.
        id: "dynamics365",
        authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        scopes: "offline_access openid",
        client_id_env: "BSC_OAUTH_DYNAMICS_CLIENT_ID",
        client_secret_env: "BSC_OAUTH_DYNAMICS_CLIENT_SECRET",
    },
];

fn provider(id: &str) -> Option<&'static OAuthProvider> {
    PROVIDERS.iter().find(|p| p.id == id)
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

/// Build the provider's authorization URL with PKCE.
fn build_authorize_url(
    p: &OAuthProvider,
    connector_id: &str,
    client_id: &str,
    redirect: &str,
    state: &str,
    challenge: &str,
    env: Option<&str>,
) -> String {
    let base = host_for_env(p.authorize_url, connector_id, env);
    let scope = std::env::var("BSC_OAUTH_DYNAMICS_SCOPE")
        .ok()
        .filter(|_| connector_id == "dynamics365")
        .unwrap_or_else(|| p.scopes.to_string());
    format!(
        "{base}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        enc(client_id), enc(redirect), enc(&scope), enc(state), enc(challenge)
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
    let p = provider(&connector_id).ok_or_else(|| format!("no OAuth provider for `{connector_id}`"))?;
    let client_id = std::env::var(p.client_id_env)
        .map_err(|_| format!("OAuth not configured: set {}", p.client_id_env))?;
    let client_secret = std::env::var(p.client_secret_env).unwrap_or_default();

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let (verifier, challenge) = pkce();
    let state = random_state();
    let authorize_url =
        build_authorize_url(p, &connector_id, &client_id, &redirect, &state, &challenge, env.as_deref());

    let token_url = host_for_env(p.token_url, &connector_id, env.as_deref());
    std::thread::spawn(move || {
        let done = match capture_and_exchange(&listener, &token_url, &client_id, &client_secret, &redirect, &verifier, &state) {
            Ok(tok) => {
                let mut ok = crate::credentials::set_secret(&project, &source_uid, "accessToken", &tok.access).is_ok();
                if let Some(r) = tok.refresh {
                    ok &= crate::credentials::set_secret(&project, &source_uid, "refreshToken", &r).is_ok();
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
    let resp: Value = reqwest::blocking::Client::new()
        .post(token_url)
        .form(&form)
        .header("Accept", "application/json")
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
        .map_err(|e| format!("token exchange failed: {e}"))?;

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

    #[test]
    fn authorize_url_carries_pkce_and_redirect() {
        let p = provider("salesforce").unwrap();
        let url = build_authorize_url(p, "salesforce", "CID", "http://127.0.0.1:9/callback", "st8", "chal", None);
        assert!(url.starts_with("https://login.salesforce.com/services/oauth2/authorize?"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("client_id=CID"));
        assert!(url.contains("code_challenge=chal"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcallback"));
    }

    #[test]
    fn salesforce_sandbox_swaps_the_auth_host() {
        let p = provider("salesforce").unwrap();
        let url = build_authorize_url(p, "salesforce", "C", "r", "s", "c", Some("sandbox"));
        assert!(url.contains("test.salesforce.com"));
        assert!(!url.contains("login.salesforce.com"));
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
}
