//! The provider launch command — DISPATCHED to the sidecar, not derived here.
//!
//! # Why this file derives nothing
//!
//! The derivation lives in `llm::launch_cmd`, reached by SPAWNING `bsc fleet launch-config`. The app's
//! Rust half is a live process behind a webview, so a derivation living inside it can only change by
//! producing a new binary — and a new binary restarts the window with a fleet running in it. On the
//! sidecar the same change goes live by staging a binary
//! (`a-resolved-request-goes-live-without-a-restart`, staging measured at 0.16s), with no app downtime.
//!
//! This module used to hold the derivation. It was moved rather than duplicated: there is one
//! `build_aider_command` and it is the sidecar's.
//!
//! # ONE call, not four
//!
//! [`launch_config`] asks for the WHOLE configuration. A launch has four derivations to make — the
//! provider command, the stop ledger, skills and MCP — and behind four calls that is ~39ms of spawn
//! each. `the-in-app-launch-resolutions-move-onto-the-one-call` folds the remaining two onto this same
//! round trip; the reply is an object with `#[serde(default)]` on both sides precisely so that can
//! happen without a lockstep deploy.
//!
//! # This one FAILS CLOSED, and that is the opposite of its sibling
//!
//! `fleet::worker_end`'s dispatcher degrades to "I do not know", because its caller's contract for
//! absence is BAIL — the safe direction there is to leave a pane alone. Here the safe direction is the
//! reverse: a launch that cannot obtain its configuration must REFUSE TO START. Starting a session on
//! a partial or stale answer would put an agent on a machine with half a gate, which is the one
//! outcome worse than not launching. So every failure — a missing sidecar, an unparseable reply, a
//! desynchronised one — returns `Err` and the caller does not launch.

// UNWIRED BY DESIGN, and the `allow` names the item that wires it. The DERIVATION has moved to the
// sidecar; what remains open is the CALL SITE — `pty_create` still receives a renderer-composed
// `init_cmd`, and replacing that is its own flip with its own gate and revert.
#![allow(dead_code)] // wired by `the-launch-builds-its-own-provider-command-instead-of-receiving-it`

use llm::launch_cmd::{LaunchConfig, ProviderLaunchConfig};

/// Ask the sidecar for a pane's whole launch configuration.
///
/// A dispatcher: it serializes the request, spawns `bsc`, and parses. It derives nothing — see the
/// module header for why that separation is the point, and why this one fails closed.
pub fn launch_config(
    project_key: Option<String>,
    provider: &str,
    cfg: Option<&ProviderLaunchConfig>,
) -> Result<LaunchConfig, String> {
    let body = serde_json::to_string(&cfg.cloned().unwrap_or_default())
        .map_err(|e| format!("launch-config: could not serialize the request: {e}"))?;
    let args = vec![
        "fleet".to_string(),
        "launch-config".to_string(),
        "--provider".to_string(),
        provider.to_string(),
        "--json".to_string(),
    ];
    let out = crate::console::bsc::bsc_blocking(project_key, args, Some(body))
        .map_err(|e| format!("launch-config: the sidecar call failed: {e}"))?;
    parse_launch_config(&out)
}

/// Parse the sidecar's reply, refusing anything unusable.
///
/// Pure, so the failure directions are testable without a spawn. Every one of them is an `Err`: see
/// the module header on why this fails closed where its sibling degrades.
fn parse_launch_config(out: &str) -> Result<LaunchConfig, String> {
    let trimmed = out.trim();
    if trimmed.is_empty() {
        return Err("launch-config: the sidecar returned nothing".into());
    }
    // REQUIRE AN OBJECT, and this is not belt-and-braces. serde will deserialize a struct from a JSON
    // SEQUENCE, taking fields positionally — so a bare `[]` parses into an all-default `LaunchConfig`
    // and reads as "this harness has no command". A desynchronised sidecar answering with some other
    // verb's array would therefore launch a session with no gate instead of refusing. Caught by
    // `every_unusable_reply_is_an_error_never_a_default_config`.
    let value: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("launch-config: could not parse the sidecar reply: {e}"))?;
    if !value.is_object() {
        return Err(format!("launch-config: expected a JSON object, got {}", kind_of(&value)));
    }
    serde_json::from_value::<LaunchConfig>(value)
        .map_err(|e| format!("launch-config: could not read the sidecar reply: {e}"))
}

/// Name a JSON value's shape for an error message — a reader chasing a bad reply wants to know it got
/// an array, not merely that something failed.
fn kind_of(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "a boolean",
        serde_json::Value::Number(_) => "a number",
        serde_json::Value::String(_) => "a string",
        serde_json::Value::Array(_) => "an array",
        serde_json::Value::Object(_) => "an object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The happy path, and the shape the caller will read.
    #[test]
    fn a_well_formed_reply_is_parsed() {
        let got = parse_launch_config(r#"{"providerCommand":"aider --no-auto-commits"}"#).unwrap();
        assert_eq!(got.provider_command.as_deref(), Some("aider --no-auto-commits"));
    }

    /// A harness that bakes its own prompt sends an empty object — that is a VALID answer meaning
    /// "no command", and it must parse rather than error.
    #[test]
    fn an_empty_object_is_a_valid_answer_not_a_failure() {
        let got = parse_launch_config("{}").expect("an empty object is a legitimate reply");
        assert_eq!(got.provider_command, None, "absence, not an empty command");
    }

    /// FAILS CLOSED. Every unusable reply is an `Err`, so the caller does not launch. This is the
    /// opposite of `fleet::worker_end`, whose absence means "bail and leave the pane alone"; here
    /// absence would mean starting a session with half a gate.
    #[test]
    fn every_unusable_reply_is_an_error_never_a_default_config() {
        for junk in ["", "   ", "not json", "null", "bsc: command not found", r#"{"providerCommand":5}"#] {
            let got = parse_launch_config(junk);
            assert!(got.is_err(), "{junk:?} must refuse, got {got:?}");
        }

        // THE ONE THAT NEARLY GOT THROUGH. serde reads a struct from a JSON SEQUENCE positionally, so
        // `[]` deserialized into an all-default LaunchConfig and read as "no command" — a
        // desynchronised sidecar answering with another verb's array would have launched a session
        // with no gate. Both array shapes must refuse.
        for arr in ["[]", r#"["aider --x"]"#, "[1,2,3]"] {
            let got = parse_launch_config(arr);
            assert!(got.is_err(), "{arr:?} is not a config, got {got:?}");
            assert!(got.unwrap_err().contains("an array"), "the error names the shape it got");
        }
    }

    /// A field added by a NEWER sidecar must not break an older app — that is what lets skills and
    /// MCP fold onto this reply without a lockstep deploy of two independently staged binaries.
    #[test]
    fn a_newer_sidecar_reply_is_still_readable() {
        let got = parse_launch_config(r#"{"providerCommand":"aider","skills":["a"],"mcp":{"x":1}}"#)
            .expect("unknown fields are tolerated");
        assert_eq!(got.provider_command.as_deref(), Some("aider"));
    }
}
