//! Shared HTTP plumbing (#2062): a lazily-built, connection-pooled reqwest client plus the
//! send → decode-JSON tail that every network call repeats. Callers still build their own
//! `RequestBuilder` (URL, method, headers, body, form, auth) — this module owns only the shared
//! client and the boilerplate that follows the builder: `.send()` + `.json()` (or
//! `.error_for_status()` for the blocking callers).
//!
//! The error wordings stay at each call site (passed as closures) because tests assert the exact
//! strings, and because they differ per caller (e.g. GitHub's `Request failed:` vs a gist's
//! `{op} request failed:`).
//!
//! `FcmSender` (`mobile/fcm.rs`) is the pre-existing exemplar of client reuse this mirrors; it keeps
//! its own owned client (it caches an OAuth token alongside it) and parses typed structs / reads
//! text error bodies, so it does not route through the `Value` helpers here.

use std::sync::OnceLock;

/// The process-wide async reqwest client. Reused across every async call so connections pool
/// instead of a fresh client (and TLS/DNS setup) per request.
pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// The process-wide blocking reqwest client (for the synchronous OAuth exchange + source scans).
pub fn blocking_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::blocking::Client::new)
}

/// Send `req` and decode a JSON body, returning the response status alongside the parsed value.
/// Callers branch on the status themselves (each surfaces its own error wording). `on_send` /
/// `on_parse` format the transport / decode failures.
///
/// Note the body is decoded regardless of status — callers that read a *non-JSON* error body
/// (e.g. an empty `204`, or a text error) keep their own bespoke flow instead of using this.
pub async fn send_json(
    req: reqwest::RequestBuilder,
    on_send: impl FnOnce(reqwest::Error) -> String,
    on_parse: impl FnOnce(reqwest::Error) -> String,
) -> Result<(reqwest::StatusCode, serde_json::Value), String> {
    send_json_full(req, on_send, on_parse).await.map(|(status, _, json)| (status, json))
}

/// [`send_json`] plus the response headers — for callers that must inspect rate-limit headers
/// (`X-RateLimit-*` / `Retry-After`, #2448) before the body consumes the response.
pub async fn send_json_full(
    req: reqwest::RequestBuilder,
    on_send: impl FnOnce(reqwest::Error) -> String,
    on_parse: impl FnOnce(reqwest::Error) -> String,
) -> Result<(reqwest::StatusCode, reqwest::header::HeaderMap, serde_json::Value), String> {
    let resp = req.send().await.map_err(on_send)?;
    let status = resp.status();
    let headers = resp.headers().clone();
    let json = resp.json::<serde_json::Value>().await.map_err(on_parse)?;
    Ok((status, headers, json))
}

/// Send a blocking `req`, require a 2xx (`error_for_status`), and decode the JSON body. `on_err`
/// maps any transport / status / decode failure to the caller's error type (generic so both the
/// `String`-erroring OAuth exchange and the `bsc_data::DataError`-erroring source scans reuse it).
pub fn blocking_send_json<E>(
    req: reqwest::blocking::RequestBuilder,
    on_err: impl FnOnce(reqwest::Error) -> E,
) -> Result<serde_json::Value, E> {
    req.send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
        .map_err(on_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Spin a one-shot loopback server that answers the first connection with `body` as a 200 JSON
    /// response, and return its `http://127.0.0.1:<port>` base URL.
    fn spawn_json_server(body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        format!("http://{addr}")
    }

    /// A loopback address with nothing listening (bind then drop), so a request is refused.
    fn dead_url() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        format!("http://{addr}/")
    }

    #[test]
    fn clients_are_reused_across_calls() {
        // The whole point of the shared client is one pooled instance, not a fresh one per call.
        assert!(std::ptr::eq(client(), client()));
        assert!(std::ptr::eq(blocking_client(), blocking_client()));
    }

    #[test]
    fn blocking_send_json_parses_a_2xx_body() {
        let url = spawn_json_server(r#"{"ok":true,"n":7}"#);
        let v: serde_json::Value =
            blocking_send_json(blocking_client().get(&url), |e| format!("boom: {e}")).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["n"], 7);
    }

    #[test]
    fn blocking_send_json_maps_transport_errors_through_the_closure() {
        let err: String =
            blocking_send_json(blocking_client().get(dead_url()), |e| format!("boom: {e}"))
                .unwrap_err();
        assert!(err.starts_with("boom: "), "got: {err}");
    }

    #[test]
    fn send_json_returns_status_and_parsed_body() {
        let url = spawn_json_server(r#"{"message":"hi"}"#);
        let (status, json) = tauri::async_runtime::block_on(send_json(
            client().get(&url),
            |e| format!("Request failed: {e}"),
            |e| format!("Failed to parse response: {e}"),
        ))
        .unwrap();
        assert!(status.is_success());
        assert_eq!(json["message"], "hi");
    }

    #[test]
    fn send_json_maps_the_send_error_through_on_send() {
        let err = tauri::async_runtime::block_on(send_json(
            client().get(dead_url()),
            |e| format!("Request failed: {e}"),
            |e| format!("Failed to parse response: {e}"),
        ))
        .unwrap_err();
        assert!(err.starts_with("Request failed: "), "got: {err}");
    }
}
