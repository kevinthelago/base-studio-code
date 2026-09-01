//! Live-socket mock-HTTP integration tests for the four providers (#1744).
//!
//! These drive each provider's real send path (`post_json` + status/error handling +
//! response parsing) against a localhost [`MockServer`] serving canned responses — no
//! external network, so they run in CI. They cover what the pure request-builder /
//! response-normalizer unit tests can't: that the actual HTTP round-trip yields the
//! right [`TurnResult`] on success, and — critically — that a real non-2xx response
//! produces the exact `"API error (<status>): …"` string `bsc-agent::is_transient_error`
//! matches on (a drift there silently breaks the agent's retry/backoff).

use super::{
    AnthropicProvider, GeminiProvider, LlmProvider, LocalProvider, Msg, OpenAiProvider, ToolDef,
    Turn,
};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Mirror of `bsc-agent`'s `is_transient_error` (the `llm` crate can't depend on
/// `bsc-agent`) — duplicated so these tests lock in that a real non-2xx response is
/// classified the same way the agent's retry policy will classify it. If this and the
/// real predicate drift, retries break and nothing else catches it.
fn is_transient_error(err: &str) -> bool {
    err.starts_with("Request failed:")
        || err.contains("API error (429")
        || err.contains("API error (5")
}

/// A localhost HTTP mock that returns a single canned `(status, body)` for every
/// request, on a real socket. The provider's reqwest client connects, sends its built
/// request, and reads this response back — exercising the genuine send path offline.
/// The background thread stops when the server is dropped.
struct MockServer {
    base: String,
    shutdown: Arc<AtomicBool>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
    }
}

/// Spin up a [`MockServer`] on an ephemeral port. `status` is the HTTP status line tail
/// (e.g. `"200 OK"`, `"429 Too Many Requests"`); `body` is the canned JSON response.
fn mock(status: &'static str, body: &'static str) -> MockServer {
    mock_with_headers(status, "", body)
}

/// [`mock`] plus `extra` raw header lines (each `"Name: value\r\n"`), so a test can serve the
/// rate-limit headers a real provider sends. Those headers are the thing `post_json` used to discard.
fn mock_with_headers(status: &'static str, extra: &'static str, body: &'static str) -> MockServer {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let shutdown = Arc::new(AtomicBool::new(false));
    let sd = shutdown.clone();
    std::thread::spawn(move || {
        while !sd.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut s, _)) => {
                    s.set_nonblocking(false).ok();
                    s.set_read_timeout(Some(Duration::from_millis(200))).ok();
                    // Drain the request (headers + any declared body) so the client's
                    // write completes before we respond and close — POST bodies can
                    // split across packets.
                    let mut data: Vec<u8> = Vec::new();
                    let mut chunk = [0u8; 4096];
                    loop {
                        match s.read(&mut chunk) {
                            Ok(0) => break,
                            Ok(k) => {
                                data.extend_from_slice(&chunk[..k]);
                                if let Some(p) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                                    let head = String::from_utf8_lossy(&data[..p]).to_lowercase();
                                    let need = head
                                        .split("content-length:")
                                        .nth(1)
                                        .and_then(|s| {
                                            s.trim_start()
                                                .split(|c: char| !c.is_ascii_digit())
                                                .next()
                                        })
                                        .and_then(|s| s.parse::<usize>().ok())
                                        .unwrap_or(0);
                                    if data.len() >= p + 4 + need {
                                        break;
                                    }
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    let _ = write!(
                        s,
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(4))
                }
                Err(_) => break,
            }
        }
    });
    MockServer { base: format!("http://{addr}"), shutdown }
}

/// A turn with one tool + one user message — enough to build a valid request for every
/// provider. The mock returns a canned response regardless of the request, so the same
/// turn drives both the success and the error cases.
fn sample_turn() -> Turn {
    Turn {
        system: "be terse".into(),
        model: "test-model".into(),
        max_tokens: 256,
        tools: vec![ToolDef {
            name: "read_file".into(),
            description: "read a file".into(),
            schema: serde_json::json!({"type":"object","properties":{"path":{"type":"string"}}}),
        }],
        messages: vec![Msg::User("read x".into())],
    }
}

/// The non-2xx statuses every provider must surface as `"API error (<status>): …"`,
/// paired with whether `is_transient_error` should treat them as retryable.
/// 429 + 5xx ⇒ transient; 4xx (non-429) ⇒ permanent.
const ERROR_CASES: &[(&str, bool)] = &[
    ("429 Too Many Requests", true),
    ("503 Service Unavailable", true),
    ("500 Internal Server Error", true),
    ("401 Unauthorized", false),
    ("400 Bad Request", false),
];

/// The canned error body every provider reads `error.message` from.
const ERROR_BODY: &str = r#"{"error":{"message":"boom"}}"#;

/// Assert a non-2xx error string matches the load-bearing `"API error (<code> …): boom"`
/// contract and classifies transient/permanent as expected.
fn assert_error_contract(err: &str, status: &str, transient: bool) {
    let code = &status[..3];
    assert!(
        err.starts_with(&format!("API error ({code}")),
        "expected `API error ({code} …)`, got: {err}"
    );
    assert!(err.contains("boom"), "error message body lost: {err}");
    assert_eq!(
        is_transient_error(err),
        transient,
        "transient classification wrong for {status}: {err}"
    );
}

// ── Anthropic ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn anthropic_turn_round_trip_parses_tool_call_and_usage() {
    let srv = mock(
        "200 OK",
        r#"{"content":[{"type":"text","text":"sure"},
            {"type":"tool_use","id":"c9","name":"read_file","input":{"path":"y"}}],
            "usage":{"input_tokens":5,"output_tokens":7},"stop_reason":"tool_use"}"#,
    );
    let r = AnthropicProvider.turn_at(&srv.base, &sample_turn(), "k").await.unwrap();
    assert_eq!(r.text, "sure");
    assert_eq!(r.stop_reason, "tool_use");
    assert_eq!(r.usage["input_tokens"], 5);
    assert_eq!(r.usage["output_tokens"], 7);
    assert_eq!(r.tool_calls.len(), 1);
    assert_eq!(r.tool_calls[0].name, "read_file");
    assert_eq!(r.tool_calls[0].args["path"], "y");
}

#[tokio::test]
async fn anthropic_error_statuses_match_contract() {
    for &(status, transient) in ERROR_CASES {
        let srv = mock(status, ERROR_BODY);
        let err = AnthropicProvider.turn_at(&srv.base, &sample_turn(), "k").await.unwrap_err();
        assert_error_contract(&err, status, transient);
    }
}

// ── OpenAI ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn openai_turn_round_trip_parses_tool_call_and_usage() {
    let srv = mock(
        "200 OK",
        r#"{"choices":[{"message":{"role":"assistant","content":"sure",
            "tool_calls":[{"id":"call_9","type":"function",
            "function":{"name":"read_file","arguments":"{\"path\":\"y\"}"}}]},
            "finish_reason":"tool_calls"}],
            "usage":{"prompt_tokens":4,"completion_tokens":7,"total_tokens":11}}"#,
    );
    let r = OpenAiProvider.turn_at(&srv.base, &sample_turn(), "k").await.unwrap();
    assert_eq!(r.text, "sure");
    assert_eq!(r.stop_reason, "tool_calls");
    assert_eq!(r.usage["input_tokens"], 4);
    assert_eq!(r.usage["output_tokens"], 7);
    assert_eq!(r.tool_calls.len(), 1);
    assert_eq!(r.tool_calls[0].name, "read_file");
    assert_eq!(r.tool_calls[0].args["path"], "y"); // arguments JSON string parsed back
}

#[tokio::test]
async fn openai_error_statuses_match_contract() {
    for &(status, transient) in ERROR_CASES {
        let srv = mock(status, ERROR_BODY);
        let err = OpenAiProvider.turn_at(&srv.base, &sample_turn(), "k").await.unwrap_err();
        assert_error_contract(&err, status, transient);
    }
}

// ── Gemini ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn gemini_turn_round_trip_parses_function_call_and_usage() {
    let srv = mock(
        "200 OK",
        r#"{"candidates":[{"content":{"parts":[{"text":"sure"},
            {"functionCall":{"name":"read_file","args":{"path":"y"}}}]},
            "finishReason":"STOP"}],
            "usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}"#,
    );
    let r = GeminiProvider.turn_at(&srv.base, &sample_turn(), "k").await.unwrap();
    assert_eq!(r.text, "sure");
    assert_eq!(r.stop_reason, "STOP");
    assert_eq!(r.usage["input_tokens"], 3);
    assert_eq!(r.usage["output_tokens"], 2);
    assert_eq!(r.tool_calls.len(), 1);
    assert_eq!(r.tool_calls[0].name, "read_file");
    assert_eq!(r.tool_calls[0].id, "read_file"); // id synthesized from name
    assert_eq!(r.tool_calls[0].args["path"], "y");
}

#[tokio::test]
async fn gemini_error_statuses_match_contract() {
    for &(status, transient) in ERROR_CASES {
        let srv = mock(status, ERROR_BODY);
        let err = GeminiProvider.turn_at(&srv.base, &sample_turn(), "k").await.unwrap_err();
        assert_error_contract(&err, status, transient);
    }
}

// ── Local (OpenAI-compatible; already takes a base_url) ──────────────────────

#[tokio::test]
async fn local_turn_round_trip_parses_tool_call_and_usage() {
    let srv = mock(
        "200 OK",
        r#"{"choices":[{"message":{"role":"assistant","content":"sure",
            "tool_calls":[{"id":"call_9","type":"function",
            "function":{"name":"read_file","arguments":"{\"path\":\"y\"}"}}]},
            "finish_reason":"tool_calls"}],
            "usage":{"prompt_tokens":4,"completion_tokens":7}}"#,
    );
    let provider = LocalProvider { base_url: srv.base.clone() };
    let r = provider.turn(&sample_turn(), "").await.unwrap();
    assert_eq!(r.text, "sure");
    assert_eq!(r.tool_calls.len(), 1);
    assert_eq!(r.tool_calls[0].name, "read_file");
    assert_eq!(r.tool_calls[0].args["path"], "y");
    assert_eq!(r.usage["input_tokens"], 4);
}

#[tokio::test]
async fn local_error_statuses_match_contract() {
    for &(status, transient) in ERROR_CASES {
        let srv = mock(status, ERROR_BODY);
        let provider = LocalProvider { base_url: srv.base.clone() };
        let err = provider.turn(&sample_turn(), "").await.unwrap_err();
        assert_error_contract(&err, status, transient);
    }
}

// ── Transport failure ────────────────────────────────────────────────────────

#[tokio::test]
async fn connection_failure_yields_request_failed_and_is_transient() {
    // 127.0.0.1:1 has no listener → the connection is refused immediately (offline),
    // so `post_json`'s send fails with the `"Request failed: …"` shape, which the
    // retry predicate treats as transient.
    let provider = LocalProvider { base_url: "http://127.0.0.1:1".into() };
    let err = provider.turn(&sample_turn(), "").await.unwrap_err();
    assert!(err.starts_with("Request failed:"), "expected transport-failure shape, got: {err}");
    assert!(is_transient_error(&err));
}


// ── The rate-limit headers survive the body read ─────────────────────────────────────────────

/// Real Anthropic rate-limit headers, as raw response lines.
const RL_HEADERS: &str = "anthropic-ratelimit-requests-limit: 1000\r\n\
anthropic-ratelimit-requests-remaining: 942\r\n\
anthropic-ratelimit-requests-reset: 2026-09-01T17:00:00Z\r\n\
anthropic-ratelimit-tokens-limit: 80000\r\n\
anthropic-ratelimit-tokens-remaining: 8000\r\n";

/// Records every snapshot the crate reports, for the observer assertions below.
///
/// **The URL is kept because the observer is PROCESS-WIDE.** Under `cargo test` the whole crate's
/// tests share one process and run in parallel, so this sink also catches its neighbours' responses
/// — the first draft asserted on "the 429" and picked up `anthropic_error_statuses_match_contract`'s
/// 429, which sends no `Retry-After`, and failed. It passed under `cargo nextest`, which gives each
/// test its own process, so the gate would never have shown it. Filtering by URL makes the assertion
/// independent of whoever else is running.
#[derive(Default)]
struct Sink(std::sync::Mutex<Vec<(String, u16, crate::ratelimit::RateLimits)>>);
impl crate::ratelimit::RateLimitObserver for Sink {
    fn observe(&self, url: &str, status: u16, limits: &crate::ratelimit::RateLimits) {
        self.0.lock().unwrap().push((url.to_string(), status, limits.clone()));
    }
}

/// THE TEST THAT WOULD HAVE CAUGHT IT.
///
/// `post_json` called `response.json()`, which CONSUMES the response — so every rate-limit header
/// was unreachable by construction, and no unit test on a parser could ever have seen it. This drives
/// a real socket and asserts the headers reach the caller with the body intact.
#[tokio::test]
async fn a_successful_response_reports_its_rate_limit_position() {
    let srv = mock_with_headers("200 OK", RL_HEADERS, r#"{"content":[],"usage":{}}"#);
    let (limits, result) =
        super::post_json_metered(&format!("{}/v1/messages", srv.base), &[], &serde_json::json!({}))
            .await;

    assert!(result.is_ok(), "the body still parses: {result:?}");
    assert_eq!(limits.requests_remaining, Some(942));
    assert_eq!(limits.tokens_remaining, Some(8000));
    assert_eq!(limits.requests_reset.as_deref(), Some("2026-09-01T17:00:00Z"));
    // tokens 8000/80000 = 0.10 binds over requests 942/1000 = 0.942.
    assert_eq!(limits.headroom_fraction(), Some(0.1));
}

/// The snapshot sits OUTSIDE the `Result`, so a 429 still reports — and this is the case where
/// `Retry-After` lives, which is the whole reason the signature is shaped that way.
#[tokio::test]
async fn a_429_still_reports_its_position_and_retry_after() {
    let srv = mock_with_headers(
        "429 Too Many Requests",
        "retry-after: 17\r\nanthropic-ratelimit-requests-remaining: 0\r\n",
        ERROR_BODY,
    );
    let (limits, result) =
        super::post_json_metered(&format!("{}/v1/messages", srv.base), &[], &serde_json::json!({}))
            .await;

    let err = result.unwrap_err();
    assert!(is_transient_error(&err), "still classified transient: {err}");
    assert_eq!(limits.retry_after_secs, Some(17), "the server's own instruction survives the error");
    assert_eq!(limits.requests_remaining, Some(0));
    assert!(!limits.is_empty());
}

/// A provider that sends no rate-limit headers must read as UNKNOWN, not as exhausted. Ollama and a
/// local llama-server send none, and a zero here would make every local model look rate-limited.
#[tokio::test]
async fn a_provider_that_sends_no_headers_reads_as_unknown_not_exhausted() {
    let srv = mock("200 OK", r#"{"choices":[]}"#);
    let (limits, result) =
        super::post_json_metered(&format!("{}/v1/chat", srv.base), &[], &serde_json::json!({})).await;
    assert!(result.is_ok());
    assert!(limits.is_empty(), "nothing reported");
    assert_eq!(limits.requests_remaining, None, "absent — NOT Some(0)");
}

/// A transport failure never reached a server, so there is no position to report.
#[tokio::test]
async fn a_transport_failure_reports_an_empty_snapshot_not_a_zeroed_one() {
    let (limits, result) =
        super::post_json_metered("http://127.0.0.1:1/v1", &[], &serde_json::json!({})).await;
    let err = result.unwrap_err();
    assert!(err.starts_with("Request failed:"));
    assert!(limits.is_empty(), "no server was reached, so nothing is known");
    assert_eq!(limits.requests_remaining, None);
}

/// The observer sees EVERY response — which is what covers the error path while
/// `LlmProvider::turn` still returns a plain `Result`.
#[tokio::test]
async fn the_observer_sees_both_the_success_and_the_error() {
    let sink = std::sync::Arc::new(Sink::default());
    let prev = crate::ratelimit::set_rate_limit_observer(Some(sink.clone()));

    let ok = mock_with_headers("200 OK", RL_HEADERS, r#"{"content":[]}"#);
    let _ = super::post_json_metered(&ok.base, &[], &serde_json::json!({})).await;
    let bad = mock_with_headers("429 Too Many Requests", "retry-after: 9\r\n", ERROR_BODY);
    let _ = super::post_json_metered(&bad.base, &[], &serde_json::json!({})).await;

    crate::ratelimit::set_rate_limit_observer(prev);

    let seen = sink.0.lock().unwrap();
    let mine = |base: &str, want: u16| {
        seen.iter().find(|(u, s, _)| u.starts_with(base) && *s == want)
    };
    let good = mine(&ok.base, 200).expect("the 200 from THIS test reached the sink");
    assert_eq!(good.2.requests_remaining, Some(942));
    let limited = mine(&bad.base, 429).expect("the 429 from THIS test reached the sink");
    assert_eq!(limited.2.retry_after_secs, Some(9), "the error path reports the server's wait");
}
