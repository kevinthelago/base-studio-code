// GitHub OAuth Device Flow (extracted from lib.rs, #758).
//
// Secret-less OAuth for a distributed desktop app: GitHub has no PKCE token
// exchange, so the auth-code flow would require shipping a client secret (unsafe)
// or running a callback server. Device Flow needs only the public Client ID — the
// user authorizes a short code in their browser and we poll for the token.
//
// The Client ID is a *public* identifier (it appears in the browser auth URL, and
// the `gh` CLI ships its own in source the same way) — not a secret — so it is
// baked into the binary and is the single source of truth for every build (dev,
// source, and release). Must be an **OAuth App** Client ID (`Ov…` prefix) with
// "Enable Device Flow" turned on — a GitHub App (`Iv…`) ignores OAuth scopes and
// would not work with this flow. A `GITHUB_CLIENT_ID` env var at build time can
// still override it locally; if it were ever blanked, the commands return a clear
// error and the UI falls back to the personal-access-token paste flow.
const GITHUB_CLIENT_ID: &str = match option_env!("GITHUB_CLIENT_ID") {
    Some(id) => id,
    None => "Ov23liTfjTACNhB38cMq",
};

/// The build-time GitHub OAuth Client ID, or "" when this build has none — the UI
/// uses an empty value to hide the "Connect with GitHub" button and offer the PAT
/// flow only.
#[tauri::command]
pub(crate) fn github_client_id() -> String {
    GITHUB_CLIENT_ID.to_string()
}

/// Reject the device flow when this build has no baked-in OAuth Client ID (see
/// [`GITHUB_CLIENT_ID`]): both `github_device_start` and `github_device_poll` short-circuit
/// with this one PAT-fallback error before touching the network.
fn require_client_id() -> Result<(), String> {
    if GITHUB_CLIENT_ID.is_empty() {
        return Err("This build has no GitHub OAuth Client ID; use a personal access token instead.".to_string());
    }
    Ok(())
}

/// The device/user codes returned by `POST /login/device/code`. `user_code` is
/// shown to the user, `verification_uri` is opened in their browser, `device_code`
/// is the opaque handle passed back to `github_device_poll`, and `interval` is the
/// minimum seconds GitHub allows between polls.
#[derive(serde::Serialize)]
pub(crate) struct DeviceStart {
    device_code: String,
    user_code: String,
    verification_uri: String,
    interval: u64,
    expires_in: u64,
}

/// Begin the OAuth Device Flow: request a device + user code for the given scope
/// (e.g. "repo read:org").
///
/// # Errors
/// Returns an error when no Client ID is baked in, the request fails, or GitHub
/// answers with an `error` field.
#[tauri::command]
pub(crate) async fn github_device_start(scope: String) -> Result<DeviceStart, String> {
    require_client_id()?;
    let (status, json) = crate::platform::http::send_json(
        crate::platform::http::client()
            .post("https://github.com/login/device/code")
            .header("Accept", "application/json")
            .header("User-Agent", super::USER_AGENT)
            .form(&[("client_id", GITHUB_CLIENT_ID), ("scope", scope.as_str())]),
        |e| format!("Request failed: {}", e),
        |e| format!("Failed to parse response: {}", e),
    )
    .await?;
    if let Some(err) = json["error"].as_str() {
        let desc = json["error_description"].as_str().unwrap_or(err);
        log::warn!("github_device_start error: {err}: {desc}");
        return Err(format!("GitHub: {}", desc));
    }
    if !status.is_success() {
        return Err(format!("GitHub returned HTTP {}", status));
    }
    Ok(DeviceStart {
        device_code: json["device_code"].as_str().unwrap_or_default().to_string(),
        user_code: json["user_code"].as_str().unwrap_or_default().to_string(),
        verification_uri: json["verification_uri"]
            .as_str()
            .unwrap_or("https://github.com/login/device")
            .to_string(),
        interval: json["interval"].as_u64().unwrap_or(5),
        expires_in: json["expires_in"].as_u64().unwrap_or(900),
    })
}

/// The outcome of one device-flow poll. Exactly one of `access_token` / `error` is
/// normally set: `access_token` once the user authorizes; otherwise `error` is a
/// GitHub status string the UI keys on — `authorization_pending` (keep waiting),
/// `slow_down` (back off — also bump the interval), `expired_token` /
/// `access_denied` (restart). Both `None` ⇒ an unexpected response.
#[derive(serde::Serialize)]
pub(crate) struct DevicePoll {
    access_token: Option<String>,
    error: Option<String>,
}

/// Poll once for the access token using the `device_code` from `github_device_start`.
/// The frontend drives the cadence (respecting `interval` / `slow_down`); this
/// command performs a single exchange.
///
/// # Errors
/// Returns an error only on transport/parse failure or a missing Client ID — a
/// pending/denied/expired authorization is reported via `DevicePoll.error`, not as
/// an `Err`, so the caller can distinguish "keep polling" from "request broke".
#[tauri::command]
pub(crate) async fn github_device_poll(device_code: String) -> Result<DevicePoll, String> {
    require_client_id()?;
    let (_status, json) = crate::platform::http::send_json(
        crate::platform::http::client()
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .header("User-Agent", super::USER_AGENT)
            .form(&[
                ("client_id", GITHUB_CLIENT_ID),
                ("device_code", device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ]),
        |e| format!("Request failed: {}", e),
        |e| format!("Failed to parse response: {}", e),
    )
    .await?;
    Ok(DevicePoll {
        access_token: json["access_token"].as_str().map(|s| s.to_string()),
        error: json["error"].as_str().map(|s| s.to_string()),
    })
}

#[cfg(test)]
mod tests {

    #[test]
    fn github_client_id_returns_the_baked_constant() {
        // github_client_id() must echo the build-time constant verbatim, so the UI
        // can decide whether to offer the device flow.
        assert_eq!(super::github_client_id(), super::GITHUB_CLIENT_ID);
    }

    #[test]
    fn github_device_flow_errors_without_a_client_id() {
        // With no GITHUB_CLIENT_ID baked in (the default test build), both device-flow
        // commands must short-circuit with a clear error and never touch the network —
        // this is what lets the UI fall back to the personal-access-token path.
        if super::GITHUB_CLIENT_ID.is_empty() {
            let start =
                tauri::async_runtime::block_on(super::github_device_start("repo".to_string()));
            let poll =
                tauri::async_runtime::block_on(super::github_device_poll("dc".to_string()));
            assert!(poll.is_err());
            match start {
                Err(e) => assert!(e.contains("personal access token"), "got: {e}"),
                Ok(_) => panic!("expected an error without a client id"),
            }
        }
    }
}

