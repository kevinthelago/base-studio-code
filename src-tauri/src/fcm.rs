//! FCM push to the paired Mobile Studio Code (MSC) app (#846).
//!
//! When a pane raises a `user_request` (the agent is waiting on the user), the desktop
//! pushes a notification to the user's phone so they can return and respond — working
//! whether MSC is foregrounded, backgrounded, or quit. The phone may not have a live relay
//! connection at that moment (it drops when the app is backgrounded/quit), so the push
//! must go out-of-band via FCM, keyed on the registration token the phone sent during the
//! pairing handshake — NOT over the tunnel. The trigger + token store live in `tunnel.rs`;
//! this module owns credential loading, the OAuth2 token, and the HTTP v1 send.
//!
//! ## Message shape (fixed contract — the mobile app parses these exact fields)
//! A **combined** notification + data message via FCM HTTP v1, so iOS renders the banner
//! itself when MSC is backgrounded/quit (no on-device background handler needed) while the
//! `data` block rides along for tap-routing:
//! - `notification = { title: sessionName, body: <prompt summary> }`
//! - `data = { type: "user_request", paneId, prompt }` — all values are strings
//! - `apns.headers["apns-priority"] = "10"`; `apns.payload.aps = { sound, mutable-content: 1 }`
//!   (deliberately NO `content-available` — this is a visible alert push, not silent data).
//!
//! ## Credentials / config
//! A Firebase **service-account** JSON key, located via the `BSC_FCM_SERVICE_ACCOUNT` env
//! var or the default `~/.base-studio-code/fcm-service-account.json`. The Firebase project
//! is the key's own `project_id` (so it always matches the key — use a key from the same
//! project as the app's `GoogleService-Info.plist`). When the key is absent FCM is simply
//! disabled (push is a no-op); the tunnel still broadcasts `user_request` to any
//! foregrounded client.

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
/// Refresh the access token this long before its stated expiry, so an in-flight send never
/// races a hard expiry.
const TOKEN_REFRESH_MARGIN: Duration = Duration::from_secs(60);

/// The env var pointing at the service-account JSON key file.
pub const KEY_PATH_ENV: &str = "BSC_FCM_SERVICE_ACCOUNT";

/// The subset of a Firebase service-account JSON key we need. Field names match Google's
/// key file so it deserializes directly.
#[derive(Debug, Clone, Deserialize)]
pub struct ServiceAccount {
    pub project_id: String,
    pub client_email: String,
    /// PEM-encoded RSA private key (the key file embeds newlines as `\n`; serde_json
    /// unescapes them on parse, so this is a real multi-line PEM string).
    pub private_key: String,
    pub private_key_id: String,
    /// OAuth2 token endpoint (`https://oauth2.googleapis.com/token`).
    pub token_uri: String,
}

impl ServiceAccount {
    /// Resolve the key path: `$BSC_FCM_SERVICE_ACCOUNT`, else
    /// `~/.base-studio-code/fcm-service-account.json`.
    pub fn key_path() -> std::path::PathBuf {
        if let Some(p) = std::env::var_os(KEY_PATH_ENV) {
            return std::path::PathBuf::from(p);
        }
        crate::bsc_base_dir().join("fcm-service-account.json")
    }

    /// Load + parse the service-account key. `None` (FCM disabled) when the file is absent;
    /// `Err` only when it exists but is malformed (surfaced to the log so a broken key is
    /// diagnosable rather than silently ignored).
    pub fn load() -> Result<Option<ServiceAccount>, String> {
        let path = Self::key_path();
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("reading {}: {e}", path.display())),
        };
        let sa: ServiceAccount =
            serde_json::from_str(&raw).map_err(|e| format!("parsing {}: {e}", path.display()))?;
        Ok(Some(sa))
    }
}

/// What the caller should do with a registration token after a send attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendOutcome {
    /// Delivered to FCM successfully.
    Sent,
    /// The token is stale/invalid (UNREGISTERED / INVALID_ARGUMENT) — drop it from the store.
    DropToken,
    /// A transient or configuration error — keep the token, just log it.
    Error,
}

/// Truncate a prompt into a one-line notification body. Collapses whitespace and caps the
/// length so the banner stays readable; falls back to a generic line when empty.
pub fn notification_body(prompt: &str) -> String {
    let collapsed = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return "An agent is waiting for your input.".to_string();
    }
    const MAX: usize = 140;
    if collapsed.chars().count() > MAX {
        let truncated: String = collapsed.chars().take(MAX - 1).collect();
        format!("{truncated}…")
    } else {
        collapsed
    }
}

/// Build the FCM HTTP v1 `message` object (the value of the request body's `message` key).
/// Pure so the fixed wire contract is unit-tested without credentials or network. `data`
/// values are all strings (FCM requires it); the `apns` block makes iOS show the banner
/// itself when MSC is backgrounded/quit.
pub fn build_message(
    device_token: &str,
    pane_id: &str,
    prompt: &str,
    session_name: &str,
) -> serde_json::Value {
    let title = if session_name.trim().is_empty() { "Studio Code" } else { session_name };
    serde_json::json!({
        "token": device_token,
        "notification": { "title": title, "body": notification_body(prompt) },
        // Contract — mobile parses these exact keys; values MUST be strings.
        "data": {
            "type": "user_request",
            "paneId": pane_id,
            "prompt": prompt,
        },
        "apns": {
            "headers": { "apns-priority": "10" },
            "payload": { "aps": { "sound": "default", "mutable-content": 1 } }
        }
    })
}

/// Build an FCM push for an agent that entered a manual-wait or asking state (F4).
/// Lets the user know an agent is paused and what it's waiting for, so they can
/// respond from the mobile app even when the relay session is backgrounded.
pub fn build_coord_wait_message(
    device_token: &str,
    session: &str,
    reason: &str,
) -> serde_json::Value {
    let body = if reason.trim().is_empty() {
        "An agent paused and is waiting for you.".to_string()
    } else {
        notification_body(reason)
    };
    serde_json::json!({
        "token": device_token,
        "notification": { "title": "Studio Code — agent waiting", "body": body },
        "data": { "type": "coord_wait", "session": session, "reason": reason },
        "apns": {
            "headers": { "apns-priority": "10" },
            "payload": { "aps": { "sound": "default", "mutable-content": 1 } }
        }
    })
}

/// Build an FCM push for a non-transient automation failure (A4).
/// The automation name and error are sent so the user can triage from the mobile app.
pub fn build_autom_failed_message(
    device_token: &str,
    automation_name: &str,
    error: &str,
) -> serde_json::Value {
    let title = if automation_name.trim().is_empty() {
        "Studio Code — automation failed".to_string()
    } else {
        format!("Automation failed: {automation_name}")
    };
    serde_json::json!({
        "token": device_token,
        "notification": { "title": title, "body": notification_body(error) },
        "data": { "type": "autom_failed", "name": automation_name, "error": error },
        "apns": {
            "headers": { "apns-priority": "10" },
            "payload": { "aps": { "sound": "default", "mutable-content": 1 } }
        }
    })
}

#[derive(Serialize)]
struct JwtClaims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: u64,
    exp: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
}

struct CachedToken {
    token: String,
    /// When the cached token should be considered stale (already includes the refresh margin).
    refresh_at: Instant,
}

/// Sends FCM messages for one service account: mints + caches an OAuth2 access token and
/// POSTs to the FCM v1 endpoint. Cheap to keep around; the `reqwest::Client` pools
/// connections and the token is reused across sends until it nears expiry.
pub struct FcmSender {
    sa: ServiceAccount,
    http: reqwest::Client,
    cached: Mutex<Option<CachedToken>>,
}

impl FcmSender {
    pub fn new(sa: ServiceAccount) -> Self {
        FcmSender { sa, http: reqwest::Client::new(), cached: Mutex::new(None) }
    }

    fn now_unix() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    }

    /// A valid OAuth2 access token, minting a new one when the cache is empty or near expiry.
    async fn access_token(&self) -> Result<String, String> {
        if let Some(c) = self.cached.lock().unwrap().as_ref() {
            if Instant::now() < c.refresh_at {
                return Ok(c.token.clone());
            }
        }
        let iat = Self::now_unix();
        let exp = iat + 3600;
        let claims = JwtClaims {
            iss: &self.sa.client_email,
            scope: FCM_SCOPE,
            aud: &self.sa.token_uri,
            iat,
            exp,
        };
        let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
        header.kid = Some(self.sa.private_key_id.clone());
        let key = jsonwebtoken::EncodingKey::from_rsa_pem(self.sa.private_key.as_bytes())
            .map_err(|e| format!("service-account private key is not valid RSA PEM: {e}"))?;
        let assertion = jsonwebtoken::encode(&header, &claims, &key)
            .map_err(|e| format!("signing the OAuth2 assertion failed: {e}"))?;

        let resp = self
            .http
            .post(&self.sa.token_uri)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", &assertion),
            ])
            .send()
            .await
            .map_err(|e| format!("token request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("token endpoint returned {status}: {body}"));
        }
        let token: TokenResponse =
            resp.json().await.map_err(|e| format!("decoding token response: {e}"))?;

        let refresh_at = Instant::now()
            + Duration::from_secs(token.expires_in).saturating_sub(TOKEN_REFRESH_MARGIN);
        *self.cached.lock().unwrap() =
            Some(CachedToken { token: token.access_token.clone(), refresh_at });
        Ok(token.access_token)
    }

    fn send_url(&self) -> String {
        format!("https://fcm.googleapis.com/v1/projects/{}/messages:send", self.sa.project_id)
    }

    /// Send one combined notification+data push to `device_token`. Returns a `SendOutcome`
    /// telling the caller whether to drop the token (it was stale/invalid).
    // The sender landed ahead of its caller — the FCM trigger (user_request / coordination
    // pushes, #932/#936) wires it. Until then clippy's -D dead-code would fail CI, so allow it.
    #[allow(dead_code)]
    pub async fn send(
        &self,
        device_token: &str,
        pane_id: &str,
        prompt: &str,
        session_name: &str,
    ) -> SendOutcome {
        self.send_built(build_message(device_token, pane_id, prompt, session_name)).await
    }

    /// Send a pre-built FCM message object (the value of the `message` key in the FCM v1
    /// request body). Used by the push worker when it builds the message with one of the
    /// specialised `build_*` helpers before dispatching. Returns a `SendOutcome`.
    pub async fn send_built(&self, message: serde_json::Value) -> SendOutcome {
        let access = match self.access_token().await {
            Ok(t) => t,
            Err(e) => {
                log::warn!("fcm: could not obtain access token: {e}");
                return SendOutcome::Error;
            }
        };
        let body = serde_json::json!({ "message": message });
        let resp = match self
            .http
            .post(self.send_url())
            .bearer_auth(&access)
            .json(&body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                log::warn!("fcm: send request failed: {e}");
                return SendOutcome::Error;
            }
        };
        let status = resp.status();
        if status.is_success() {
            return SendOutcome::Sent;
        }
        let text = resp.text().await.unwrap_or_default();
        classify_error(status.as_u16(), &text)
    }
}

/// Map an FCM v1 error response to a `SendOutcome`. A 404 (UNREGISTERED) or a 400 carrying
/// INVALID_ARGUMENT means the registration token is stale/invalid → drop it; everything
/// else is transient/config and keeps the token. The body is logged by the caller so a
/// genuine request bug (which also surfaces as INVALID_ARGUMENT) stays diagnosable.
pub fn classify_error(status: u16, body: &str) -> SendOutcome {
    if status == 404 || body.contains("UNREGISTERED") || body.contains("INVALID_ARGUMENT") {
        log::info!("fcm: dropping stale/invalid token (status {status})");
        return SendOutcome::DropToken;
    }
    log::warn!("fcm: send returned {status}: {body}");
    SendOutcome::Error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_message_matches_the_mobile_contract() {
        let m = build_message("tok-123", "t3p1", "Approve the migration?", "Auth UI");
        // notification block — human-readable banner.
        assert_eq!(m["notification"]["title"], "Auth UI");
        assert_eq!(m["notification"]["body"], "Approve the migration?");
        // data block — the fixed contract the mobile parses; all values are strings.
        assert_eq!(m["data"]["type"], "user_request");
        assert_eq!(m["data"]["paneId"], "t3p1");
        assert_eq!(m["data"]["prompt"], "Approve the migration?");
        assert!(m["data"]["type"].is_string() && m["data"]["paneId"].is_string() && m["data"]["prompt"].is_string());
        // token + apns alert specifics.
        assert_eq!(m["token"], "tok-123");
        assert_eq!(m["apns"]["headers"]["apns-priority"], "10");
        assert_eq!(m["apns"]["payload"]["aps"]["sound"], "default");
        assert_eq!(m["apns"]["payload"]["aps"]["mutable-content"], 1);
        // Deliberately NOT a silent push.
        assert!(m["apns"]["payload"]["aps"].get("content-available").is_none());
    }

    #[test]
    fn build_message_keeps_an_empty_prompt_as_an_empty_string() {
        let m = build_message("tok", "p1", "", "Worker");
        assert_eq!(m["data"]["prompt"], ""); // optional but present, and a string
        assert!(m["data"]["prompt"].is_string());
        // The banner body falls back to a generic line rather than going blank.
        assert_eq!(m["notification"]["body"], "An agent is waiting for your input.");
    }

    #[test]
    fn notification_body_collapses_and_truncates() {
        assert_eq!(notification_body("  hello   world \n"), "hello world");
        let long = "x ".repeat(200);
        let body = notification_body(&long);
        assert!(body.chars().count() <= 140);
        assert!(body.ends_with('…'));
    }

    #[test]
    fn build_message_falls_back_to_a_title_when_session_name_is_blank() {
        let m = build_message("tok", "p1", "hi", "   ");
        assert_eq!(m["notification"]["title"], "Studio Code");
    }

    #[test]
    fn classify_error_drops_only_stale_token_errors() {
        assert_eq!(classify_error(404, r#"{"error":{"status":"NOT_FOUND"}}"#), SendOutcome::DropToken);
        assert_eq!(
            classify_error(400, r#"{"error":{"status":"INVALID_ARGUMENT"}}"#),
            SendOutcome::DropToken
        );
        // Transient / auth / server errors keep the token.
        assert_eq!(classify_error(401, "unauthorized"), SendOutcome::Error);
        assert_eq!(classify_error(429, "quota"), SendOutcome::Error);
        assert_eq!(classify_error(503, "unavailable"), SendOutcome::Error);
    }

    #[test]
    fn service_account_parses_a_google_key_shape() {
        let json = r#"{
            "type": "service_account",
            "project_id": "msc-demo",
            "private_key_id": "abc123",
            "private_key": "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
            "client_email": "fcm@msc-demo.iam.gserviceaccount.com",
            "token_uri": "https://oauth2.googleapis.com/token"
        }"#;
        let sa: ServiceAccount = serde_json::from_str(json).unwrap();
        assert_eq!(sa.project_id, "msc-demo");
        assert_eq!(sa.token_uri, "https://oauth2.googleapis.com/token");
        // The escaped \n in the JSON becomes a real newline in the PEM string.
        assert!(sa.private_key.contains("-----BEGIN PRIVATE KEY-----\n"));
    }
}
