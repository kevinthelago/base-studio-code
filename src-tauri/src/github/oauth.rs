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


// ── What one poll MEANS (#594) — ported from `src/shared/lib/github/githubDeviceFlow.ts` ─────────
//
// `github_device_poll` above performs the exchange and returns the raw `{ access_token, error }`
// pair. It did not say what that answer means — whether to keep polling, back off, or stop and why —
// and that decision lived in the renderer, which is the inversion
// `epic-frontend-logic-over-backend-resources-belongs-in-rust` closes. Proved against
// `src/shared/lib/github/githubDeviceFlow.fixtures.json`, generated from the TypeScript.
//
// The DRIVER (`runDeviceFlow`) is deliberately not ported: it exists to outlive a component's
// lifecycle, taking injected cancellation and callbacks, and moving it is an orchestration decision
// rather than a derivation.

// UNWIRED BY DESIGN, and the `allow` names the item that wires it. The ref is a REAL open item
// (checked with `bsc plan get`) — a dangling `wired by` is invisible to every gate.
/// GitHub's `slow_down` asks the client to add at least 5s to its poll interval.
#[allow(dead_code)] // wired by `the-device-flow-ui-reads-the-rust-decision`
pub const SLOW_DOWN_BUMP_SEC: i64 = 5;

/// What the polling loop should do next.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)] // wired by `the-device-flow-ui-reads-the-rust-decision`
pub enum DeviceFlowAction {
    /// Authorized — this is the token.
    Success { token: String },
    /// Not yet; poll again after `interval_sec`.
    Pending { interval_sec: i64 },
    /// Stop, and tell the user this.
    Error { message: String },
}

/// Interpret one poll result into the next action.
///
/// THREE RULES that a corpus of realistic results would not separate:
///
///   * the token is tested for TRUTHINESS, so an EMPTY `access_token` is not a success — it falls
///     through to the error branch, where an accompanying `authorization_pending` still means pending;
///   * an ABSENT error (`None` or empty) is its own case with its own message, distinct from an
///     UNKNOWN error string, which is echoed. Collapsing the two changes what the user is told when
///     GitHub returns nothing at all;
///   * `slow_down` is the ONLY branch that changes the interval, and it adds
///     [`SLOW_DOWN_BUMP_SEC`] rather than replacing it.
///
/// A token present ALONGSIDE an error wins: the check is ordered, not exclusive.
#[allow(dead_code)] // wired by `the-device-flow-ui-reads-the-rust-decision`
pub fn map_device_poll(access_token: Option<&str>, error: Option<&str>, interval_sec: i64) -> DeviceFlowAction {
    if let Some(token) = access_token.filter(|t| !t.is_empty()) {
        return DeviceFlowAction::Success { token: token.to_string() };
    }
    match error.unwrap_or("") {
        "authorization_pending" => DeviceFlowAction::Pending { interval_sec },
        "slow_down" => DeviceFlowAction::Pending { interval_sec: interval_sec + SLOW_DOWN_BUMP_SEC },
        "expired_token" => DeviceFlowAction::Error {
            message: "The code expired before you authorized. Please try again.".to_string(),
        },
        "access_denied" => DeviceFlowAction::Error { message: "Authorization was cancelled on GitHub.".to_string() },
        "" => DeviceFlowAction::Error { message: "Unexpected response from GitHub. Please try again.".to_string() },
        other => DeviceFlowAction::Error { message: format!("GitHub: {other}") },
    }
}

#[cfg(test)]
mod device_flow_tests {
    use super::*;
    use serde_json::Value;

    /// Resolved BY FILENAME under `src/`, the rule every generated contract here uses.
    fn fixture() -> Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let mut found: Vec<std::path::PathBuf> = Vec::new();
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("githubDeviceFlow.fixtures.json") {
                    out.push(p);
                }
            }
        }
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected exactly one githubDeviceFlow.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// Reports every mismatch at once — a wrong port is wrong in a pattern.
    #[test]
    fn the_poll_decision_matches_the_typescript_case_for_case() {
        let doc = fixture();
        assert_eq!(
            doc["slowDownBumpSec"].as_i64(),
            Some(SLOW_DOWN_BUMP_SEC),
            "the bump is part of the contract and moved on one side only"
        );
        let mut bad: Vec<String> = Vec::new();

        for c in doc["cases"].as_array().expect("cases") {
            let label = c["label"].as_str().unwrap();
            let got = map_device_poll(
                c["res"]["access_token"].as_str(),
                c["res"]["error"].as_str(),
                c["intervalSec"].as_i64().unwrap(),
            );
            let a = &c["action"];
            // WHOLE ACTION — kind AND payload. A kind-only check lets a wrong message or a wrong
            // interval through, and the message is what the user reads.
            let want = match a["kind"].as_str().unwrap() {
                "success" => DeviceFlowAction::Success { token: a["token"].as_str().unwrap().to_string() },
                "pending" => DeviceFlowAction::Pending { interval_sec: a["intervalSec"].as_i64().unwrap() },
                "error" => DeviceFlowAction::Error { message: a["message"].as_str().unwrap().to_string() },
                k => panic!("unknown action kind {k:?}"),
            };
            if got != want {
                bad.push(format!("  {label:?}\n    ts   {want:?}\n    rust {got:?}"));
            }
        }

        assert!(bad.is_empty(), "the Rust poll decision disagrees with the live TypeScript:\n{}", bad.join("\n"));
    }

    /// THE SENTINEL. An empty token is falsy, so it is not a success — and an accompanying
    /// `authorization_pending` still means pending rather than an error.
    #[test]
    fn an_empty_token_is_not_a_success() {
        assert_eq!(
            map_device_poll(Some(""), Some("authorization_pending"), 5),
            DeviceFlowAction::Pending { interval_sec: 5 }
        );
        assert!(matches!(map_device_poll(Some(""), None, 5), DeviceFlowAction::Error { .. }));
        // …and a real token wins even alongside an error: the check is ordered, not exclusive.
        assert_eq!(
            map_device_poll(Some("gho_x"), Some("slow_down"), 5),
            DeviceFlowAction::Success { token: "gho_x".into() }
        );
    }

    /// An ABSENT error has its own message; an UNKNOWN one is echoed. Collapsing them changes what the
    /// user is told when GitHub returns nothing at all.
    #[test]
    fn an_absent_error_is_not_an_unknown_error() {
        let absent = map_device_poll(None, None, 5);
        let empty = map_device_poll(None, Some(""), 5);
        assert_eq!(absent, empty, "None and empty are the same case");
        // The MESSAGE, not just its distinctness. Without this the test survives deleting the empty
        // arm entirely: absent then falls through to the echo and becomes "GitHub: ", which is still
        // equal to empty and still unequal to an unknown error. Measured — that mutation bit only the
        // parity test until this line existed.
        assert_eq!(
            absent,
            DeviceFlowAction::Error { message: "Unexpected response from GitHub. Please try again.".into() },
            "an absent error has its OWN message, not an echo of nothing"
        );
        let unknown = map_device_poll(None, Some("weird_thing"), 5);
        assert_ne!(absent, unknown);
        assert_eq!(unknown, DeviceFlowAction::Error { message: "GitHub: weird_thing".into() });
    }

    /// Only `slow_down` moves the interval, and it ADDS rather than replaces.
    #[test]
    fn only_slow_down_changes_the_interval() {
        assert_eq!(map_device_poll(None, Some("authorization_pending"), 12), DeviceFlowAction::Pending { interval_sec: 12 });
        assert_eq!(map_device_poll(None, Some("slow_down"), 10), DeviceFlowAction::Pending { interval_sec: 15 });
        assert_eq!(map_device_poll(None, Some("slow_down"), 0), DeviceFlowAction::Pending { interval_sec: 5 });
    }
}
