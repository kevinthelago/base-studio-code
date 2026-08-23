//! End-to-end transport tests — the REAL request path, driven from a SYNCHRONOUS caller against a
//! loopback server (`extract-a-tauri-free-github-transport-crate`).
//!
//! The unit tests in `lib.rs` cover the pure helpers. These cover the thing the slice actually
//! promises and that no unit test can see: that a plain `fn main` with no Tauri and no runtime of
//! its own can issue an authenticated GitHub request, send the right headers, surface errors, and
//! use the response cache. "It compiles" is not evidence of that.
//!
//! An integration test gets a FRESH process, which matters here: `api_base()` is a `OnceLock` read
//! once per process, so a test binary that also exercised the real api.github.com default could
//! not then point the base at a local server.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// Serve `n` canned responses on loopback, recording each raw request. Returns the base URL and
/// the shared request log so a test can assert on what was actually sent.
fn serve(responses: Vec<(u16, &'static str)>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&log);
    std::thread::spawn(move || {
        let served = AtomicUsize::new(0);
        for conn in listener.incoming() {
            let Ok(mut stream) = conn else { break };
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            sink.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).to_string());
            let i = served.fetch_add(1, Ordering::SeqCst);
            let (code, body) = responses.get(i).copied().unwrap_or((200, "{}"));
            let reason = if code == 200 { "OK" } else { "ERR" };
            let resp = format!(
                "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
            if i + 1 >= responses.len() {
                break;
            }
        }
    });
    (format!("http://{addr}"), log)
}

/// Point the transport at a loopback server. Must run before the first `api_base()` read, which is
/// why every case in this file lives under ONE `#[test]`: the base is a per-process `OnceLock`, so
/// separate test fns would race to set it and all but one would fetch the wrong host. The same
/// reason `lib.rs` keeps its rate-limit gate cases in a single fn.
#[test]
fn the_transport_works_from_a_synchronous_caller_with_no_tauri() {
    let (base, log) = serve(vec![
        (201, r#"{"number":7,"node_id":"I_1","html_url":"http://x/7"}"#), // POST an issue
        (200, r#"{"login":"octocat"}"#),                                   // GET the viewer
        (404, r#"{"message":"Not Found"}"#),                               // GET a missing repo
    ]);
    std::env::set_var("BSC_GITHUB_API_BASE", &base);
    assert_eq!(bsc_github::api_base(), base, "the override must win before any request");

    // ── 1. A mutation, driven through the BLOCKING wrapper — the shape a CLI uses.
    let created = bsc_github::blocking::post(
        "ghp_test_token",
        "repos/o/r/issues",
        &serde_json::json!({ "title": "hello", "labels": ["bsc"] }),
    )
    .expect("a 201 is a success");
    assert_eq!(created["number"], 7);
    assert_eq!(created["node_id"], "I_1");

    // ── 2. A cached GET, same wrapper.
    let viewer = bsc_github::blocking::request("ghp_test_token", "user").expect("a 200 GET");
    assert_eq!(viewer["login"], "octocat");

    // ── 3. A non-2xx surfaces GitHub's `message` in the exact wording the app reports.
    let err = bsc_github::blocking::request("ghp_test_token", "repos/o/missing").unwrap_err();
    // reqwest renders the CANONICAL reason phrase for the code, not whatever the server wrote on
    // the status line — so this is "404 Not Found" even though the stub said "404 ERR".
    assert_eq!(err, "GitHub API error (404 Not Found): Not Found");

    // ── 4. The requests carried real GitHub auth + headers. This is the half that would still
    //       "pass" if the transport silently sent an unauthenticated request.
    let sent = log.lock().unwrap().clone();
    assert_eq!(sent.len(), 3, "one request per call, no retries");
    let first = &sent[0];
    assert!(first.starts_with("POST /repos/o/r/issues "), "path + verb: {first}");
    assert!(first.contains("authorization: Bearer ghp_test_token"), "auth header missing: {first}");
    assert!(first.contains("accept: application/vnd.github+json"), "accept header missing: {first}");
    assert!(first.contains("x-github-api-version: 2022-11-28"), "api version missing: {first}");
    assert!(
        first.to_lowercase().contains("user-agent:"),
        "a User-Agent is always sent: {first}"
    );
    assert!(sent[1].starts_with("GET /user "), "second call is the GET: {}", sent[1]);
}
