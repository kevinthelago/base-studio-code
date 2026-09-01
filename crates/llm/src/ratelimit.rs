//! The rate-limit headers every provider sends and this crate used to throw away.
//!
//! # Why this exists
//!
//! `post_json` called `response.json()`, which CONSUMES the response — the status survived, the
//! headers did not. So `anthropic-ratelimit-*` and `retry-after` were read by nothing, anywhere:
//! grepped across `crates/`, `src-tauri/src/` and the graph store where `bsc-agent` actually
//! compiles from, zero hits. The consequence is not a missing nicety. It means **"how close is this
//! fleet to its limit" has no answer**, and the only way left to find the limit is to hit it.
//!
//! The instrument already existed next door: `platform::http::send_json_full` was written for
//! exactly this ("callers that must inspect rate-limit headers before the body consumes the
//! response", #2448) and `bsc-github` uses it carefully. The client that talks to Anthropic did not.
//!
//! # Absent is not zero, and that is the whole safety property
//!
//! Every field is [`Option`]. A provider that sends no headers at all (Ollama, a local llama-server,
//! a mock) must read as UNKNOWN, never as "no headroom left" — a zero there would make a local model
//! look permanently rate-limited, and would poison any average it entered. This is the same rule the
//! build measurements follow: an absent measurement reads as ABSENT.
//!
//! # The two providers spell it differently, deliberately kept apart
//!
//! Anthropic sends `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}` with an RFC-3339
//! **timestamp** for the reset. OpenAI sends `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`
//! with a **duration string** (`"1s"`, `"6m0s"`). Both are recorded RAW alongside any value parsed
//! out of them, because a shape this crate fails to parse is exactly the thing a later reader needs
//! to see in order to fix the parser.

use std::collections::BTreeMap;

/// One provider's rate-limit position at the moment of one response.
///
/// Every field is optional and an absent header stays absent. `raw` keeps every rate-limit header
/// seen, verbatim, so a provider or a spelling this parser does not yet understand is still
/// recorded rather than silently dropped.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimits {
    /// Requests permitted in the current window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requests_limit: Option<u64>,
    /// Requests left. **`Some(0)` means exhausted; `None` means the provider did not say.**
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requests_remaining: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_remaining: Option<u64>,
    /// The reset instants, verbatim — an RFC-3339 timestamp from Anthropic, a duration from OpenAI.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requests_reset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_reset: Option<String>,
    /// `Retry-After`, in seconds. The server's own instruction on how long to wait.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_secs: Option<u64>,
    /// Every rate-limit header seen, lowercased, verbatim.
    #[serde(skip_serializing_if = "BTreeMap::is_empty", default)]
    pub raw: BTreeMap<String, String>,
}

impl RateLimits {
    /// True when nothing at all was reported — the provider sent no rate-limit headers.
    ///
    /// Distinct from "reported zero headroom", which is `requests_remaining == Some(0)`. Collapsing
    /// the two is the mistake this type exists to prevent.
    pub fn is_empty(&self) -> bool {
        self.raw.is_empty()
            && self.requests_limit.is_none()
            && self.requests_remaining.is_none()
            && self.tokens_limit.is_none()
            && self.tokens_remaining.is_none()
            && self.retry_after_secs.is_none()
    }

    /// The tightest headroom the provider reported, as a fraction of its limit — `None` when it
    /// reported no usable pair.
    ///
    /// Requests and tokens are separate budgets and either can be the binding one, so the MINIMUM is
    /// the honest summary. A limit of zero yields `None` rather than a division by zero.
    pub fn headroom_fraction(&self) -> Option<f64> {
        let frac = |rem: Option<u64>, lim: Option<u64>| match (rem, lim) {
            (Some(r), Some(l)) if l > 0 => Some(r as f64 / l as f64),
            _ => None,
        };
        let r = frac(self.requests_remaining, self.requests_limit);
        let t = frac(self.tokens_remaining, self.tokens_limit);
        match (r, t) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }
}

/// Every header name this parser recognises, lowercased. A header outside this set is not recorded
/// in `raw` — `raw` is the rate-limit picture, not a copy of the whole response.
const RATE_LIMIT_PREFIXES: &[&str] = &["anthropic-ratelimit-", "x-ratelimit-", "ratelimit-"];
const RETRY_AFTER: &str = "retry-after";

/// Parse a rate-limit snapshot from `(name, value)` header pairs.
///
/// Pure and case-insensitive, taking pairs rather than a `HeaderMap` so it can be tested against
/// captured real-world header sets without constructing an HTTP response.
pub fn parse_rate_limits<'a, I>(headers: I) -> RateLimits
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut out = RateLimits::default();
    for (name, value) in headers {
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        let is_rl = RATE_LIMIT_PREFIXES.iter().any(|p| name.starts_with(p));
        if !is_rl && name != RETRY_AFTER {
            continue;
        }
        out.raw.insert(name.clone(), value.to_string());

        if name == RETRY_AFTER {
            // Seconds form only. `Retry-After` may also carry an HTTP-date; that is left unparsed
            // ON PURPOSE and kept in `raw` — guessing at a date format here would produce a wrong
            // wait rather than an honest absence.
            out.retry_after_secs = value.parse::<u64>().ok();
            continue;
        }

        // Anthropic: anthropic-ratelimit-<bucket>-<field>. OpenAI: x-ratelimit-<field>-<bucket>.
        // Normalising to (bucket, field) keeps one table for both spellings.
        let tail = name
            .strip_prefix("anthropic-ratelimit-")
            .or_else(|| name.strip_prefix("x-ratelimit-"))
            .or_else(|| name.strip_prefix("ratelimit-"))
            .unwrap_or("");
        let parts: Vec<&str> = tail.split('-').collect();
        let (bucket, field) = match parts.as_slice() {
            // anthropic-ratelimit-requests-remaining
            [b, f] if matches!(*b, "requests" | "tokens") => (*b, *f),
            // x-ratelimit-remaining-requests
            [f, b] if matches!(*b, "requests" | "tokens") => (*b, *f),
            // anthropic-ratelimit-input-tokens-remaining — an input/output sub-bucket. Recorded in
            // `raw` above and NOT folded into the totals: adding an input budget to an output one
            // would invent a number neither header reported.
            _ => continue,
        };
        let num = || value.parse::<u64>().ok();
        match (bucket, field) {
            ("requests", "limit") => out.requests_limit = num(),
            ("requests", "remaining") => out.requests_remaining = num(),
            ("requests", "reset") => out.requests_reset = Some(value.to_string()),
            ("tokens", "limit") => out.tokens_limit = num(),
            ("tokens", "remaining") => out.tokens_remaining = num(),
            ("tokens", "reset") => out.tokens_reset = Some(value.to_string()),
            _ => {}
        }
    }
    out
}

/// Read a snapshot straight off a `reqwest` response's headers.
pub(crate) fn from_header_map(map: &reqwest::header::HeaderMap) -> RateLimits {
    let pairs: Vec<(String, String)> = map
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|s| (k.as_str().to_string(), s.to_string())))
        .collect();
    parse_rate_limits(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())))
}

// ── The observer: how the ERROR path gets recorded without a trait-wide refactor ──────────────

/// A sink notified of every rate-limit snapshot this crate sees.
///
/// Carrying the snapshot out through `LlmProvider::turn`'s `Result<TurnResult, String>` would mean
/// making the trait return a metered result across four providers and every caller. That refactor is
/// worth doing and is not worth doing in the same change as the parser it depends on — so the
/// observer covers the error path now, and it is the shape telemetry wants regardless: the host
/// installs one sink and every provider reports through it, rather than each call site remembering.
pub trait RateLimitObserver: Send + Sync {
    /// Called once per response, SUCCESS OR ERROR, before the body is read.
    ///
    /// `status` is the HTTP status; `limits` may be [`RateLimits::is_empty`] when the provider sent
    /// nothing. Implementations must not block — this runs on the request path.
    fn observe(&self, url: &str, status: u16, limits: &RateLimits);
}

static OBSERVER: std::sync::RwLock<Option<std::sync::Arc<dyn RateLimitObserver>>> =
    std::sync::RwLock::new(None);

/// Install the process-wide observer, replacing any previous one. Returns the previous, so a test
/// can restore it and not leak a sink into its neighbours.
pub fn set_rate_limit_observer(
    observer: Option<std::sync::Arc<dyn RateLimitObserver>>,
) -> Option<std::sync::Arc<dyn RateLimitObserver>> {
    match OBSERVER.write() {
        Ok(mut slot) => std::mem::replace(&mut *slot, observer),
        // A poisoned lock means an observer panicked. Telemetry must never take the agent down with
        // it, so this reports nothing rather than propagating.
        Err(_) => None,
    }
}

/// Notify the installed observer, if any. Never panics and never propagates one.
pub(crate) fn observe(url: &str, status: u16, limits: &RateLimits) {
    let Ok(slot) = OBSERVER.read() else { return };
    let Some(observer) = slot.as_ref() else { return };
    observer.observe(url, status, limits);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real Anthropic response's rate-limit headers, in its own spelling.
    fn anthropic() -> Vec<(&'static str, &'static str)> {
        vec![
            ("anthropic-ratelimit-requests-limit", "1000"),
            ("anthropic-ratelimit-requests-remaining", "999"),
            ("anthropic-ratelimit-requests-reset", "2026-09-01T17:00:00Z"),
            ("anthropic-ratelimit-tokens-limit", "80000"),
            ("anthropic-ratelimit-tokens-remaining", "72000"),
            ("anthropic-ratelimit-tokens-reset", "2026-09-01T17:00:00Z"),
            ("content-type", "application/json"),
            ("request-id", "req_123"),
        ]
    }

    /// OpenAI spells the same facts with the bucket and field TRANSPOSED, and a duration reset.
    fn openai() -> Vec<(&'static str, &'static str)> {
        vec![
            ("x-ratelimit-limit-requests", "500"),
            ("x-ratelimit-remaining-requests", "499"),
            ("x-ratelimit-reset-requests", "6m0s"),
            ("x-ratelimit-limit-tokens", "30000"),
            ("x-ratelimit-remaining-tokens", "29000"),
            ("x-ratelimit-reset-tokens", "1s"),
        ]
    }

    #[test]
    fn the_anthropic_spelling_is_read() {
        let r = parse_rate_limits(anthropic());
        assert_eq!(r.requests_limit, Some(1000));
        assert_eq!(r.requests_remaining, Some(999));
        assert_eq!(r.tokens_limit, Some(80000));
        assert_eq!(r.tokens_remaining, Some(72000));
        assert_eq!(r.requests_reset.as_deref(), Some("2026-09-01T17:00:00Z"));
        assert_eq!(r.retry_after_secs, None, "no Retry-After on a 200");
        assert!(!r.is_empty());
        // `raw` is the rate-limit picture, not a copy of the response.
        assert!(!r.raw.contains_key("content-type"), "raw must not hoover up unrelated headers");
        assert!(!r.raw.contains_key("request-id"));
        assert_eq!(r.raw.len(), 6);
    }

    /// The transposed spelling must land in the SAME fields — otherwise one provider silently
    /// reports nothing and reads as unmeasured.
    #[test]
    fn the_openai_spelling_lands_in_the_same_fields() {
        let r = parse_rate_limits(openai());
        assert_eq!(r.requests_limit, Some(500));
        assert_eq!(r.requests_remaining, Some(499));
        assert_eq!(r.tokens_limit, Some(30000));
        assert_eq!(r.tokens_remaining, Some(29000));
        assert_eq!(r.tokens_reset.as_deref(), Some("1s"), "a duration is kept verbatim, not parsed");
    }

    #[test]
    fn header_names_are_case_insensitive() {
        let r = parse_rate_limits(vec![("Anthropic-RateLimit-Requests-Remaining", "7")]);
        assert_eq!(r.requests_remaining, Some(7));
    }

    /// THE SAFETY PROPERTY. A provider that reports nothing is UNKNOWN, never exhausted.
    #[test]
    fn an_absent_header_is_absent_and_never_zero() {
        let r = parse_rate_limits(vec![("content-type", "application/json")]);
        assert!(r.is_empty(), "nothing reported");
        assert_eq!(r.requests_remaining, None, "absent — NOT Some(0)");
        assert_eq!(r.headroom_fraction(), None, "and no headroom can be computed from nothing");

        // Which is a different state from a provider that reported genuine exhaustion.
        let spent = parse_rate_limits(vec![
            ("anthropic-ratelimit-requests-limit", "1000"),
            ("anthropic-ratelimit-requests-remaining", "0"),
        ]);
        assert!(!spent.is_empty(), "reporting zero IS reporting");
        assert_eq!(spent.requests_remaining, Some(0));
        assert_eq!(spent.headroom_fraction(), Some(0.0));
        assert_ne!(r.requests_remaining, spent.requests_remaining, "the two must not collapse");
    }

    #[test]
    fn retry_after_is_read_in_seconds_and_left_alone_otherwise() {
        let r = parse_rate_limits(vec![("retry-after", "42")]);
        assert_eq!(r.retry_after_secs, Some(42));

        // An HTTP-date form is kept RAW and parsed to nothing — an honest absence beats a guessed
        // wait derived from a date format this crate never verified.
        let d = parse_rate_limits(vec![("Retry-After", "Wed, 01 Sep 2026 17:00:00 GMT")]);
        assert_eq!(d.retry_after_secs, None);
        assert_eq!(d.raw.get("retry-after").map(String::as_str), Some("Wed, 01 Sep 2026 17:00:00 GMT"));
        assert!(!d.is_empty(), "it was reported, even though it was not parsed");
    }

    /// Requests and tokens are separate budgets and either can bind. The minimum is the honest one.
    #[test]
    fn headroom_reports_the_tighter_of_the_two_budgets() {
        let r = parse_rate_limits(vec![
            ("anthropic-ratelimit-requests-limit", "100"),
            ("anthropic-ratelimit-requests-remaining", "90"), // 0.90
            ("anthropic-ratelimit-tokens-limit", "1000"),
            ("anthropic-ratelimit-tokens-remaining", "100"), // 0.10  ← binding
        ]);
        assert_eq!(r.headroom_fraction(), Some(0.1));

        // One budget alone still answers.
        let only = parse_rate_limits(vec![
            ("anthropic-ratelimit-tokens-limit", "10"),
            ("anthropic-ratelimit-tokens-remaining", "5"),
        ]);
        assert_eq!(only.headroom_fraction(), Some(0.5));

        // A remaining with no limit cannot be a fraction of anything.
        let partial = parse_rate_limits(vec![("anthropic-ratelimit-tokens-remaining", "5")]);
        assert_eq!(partial.headroom_fraction(), None);

        // A zero limit is not a division.
        let zero = parse_rate_limits(vec![
            ("anthropic-ratelimit-tokens-limit", "0"),
            ("anthropic-ratelimit-tokens-remaining", "0"),
        ]);
        assert_eq!(zero.headroom_fraction(), None);
    }

    /// Anthropic also sends input/output sub-buckets. They are RECORDED but never folded into the
    /// totals — summing an input budget into an output one invents a number no header reported.
    #[test]
    fn input_and_output_sub_buckets_are_recorded_but_not_summed() {
        let r = parse_rate_limits(vec![
            ("anthropic-ratelimit-tokens-limit", "80000"),
            ("anthropic-ratelimit-tokens-remaining", "72000"),
            ("anthropic-ratelimit-input-tokens-limit", "40000"),
            ("anthropic-ratelimit-input-tokens-remaining", "36000"),
            ("anthropic-ratelimit-output-tokens-remaining", "8000"),
        ]);
        assert_eq!(r.tokens_limit, Some(80000), "the total is the total");
        assert_eq!(r.tokens_remaining, Some(72000));
        assert_eq!(r.raw.len(), 5, "but every sub-bucket is still recorded");
        assert!(r.raw.contains_key("anthropic-ratelimit-input-tokens-remaining"));
    }

    /// A value this parser cannot read must not become a wrong number.
    #[test]
    fn an_unparseable_value_is_absent_but_still_recorded() {
        let r = parse_rate_limits(vec![
            ("anthropic-ratelimit-requests-remaining", "lots"),
            ("retry-after", "soon"),
        ]);
        assert_eq!(r.requests_remaining, None, "not 0, and not a guess");
        assert_eq!(r.retry_after_secs, None);
        assert_eq!(r.raw.get("anthropic-ratelimit-requests-remaining").map(String::as_str), Some("lots"));
        assert!(!r.is_empty(), "it was reported — the parser simply could not read it");
    }

    #[test]
    fn the_snapshot_round_trips_as_json_without_inventing_fields() {
        let r = parse_rate_limits(anthropic());
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["requestsRemaining"], 999);
        assert!(j.get("retryAfterSecs").is_none(), "an absent field is OMITTED, never null or 0");
        let back: RateLimits = serde_json::from_value(j).unwrap();
        assert_eq!(back, r);

        // And an empty snapshot serializes to an empty object rather than a wall of zeroes.
        let empty = serde_json::to_value(RateLimits::default()).unwrap();
        assert_eq!(empty, serde_json::json!({}));
    }

    // ── the observer ────────────────────────────────────────────────────────

    #[derive(Default)]
    struct Recorder(std::sync::Mutex<Vec<(String, u16, RateLimits)>>);
    impl RateLimitObserver for Recorder {
        fn observe(&self, url: &str, status: u16, limits: &RateLimits) {
            self.0.lock().unwrap().push((url.into(), status, limits.clone()));
        }
    }

    #[test]
    fn the_observer_receives_what_it_is_given_and_can_be_uninstalled() {
        let rec = std::sync::Arc::new(Recorder::default());
        let prev = set_rate_limit_observer(Some(rec.clone()));
        observe("https://api.example/v1", 429, &parse_rate_limits(vec![("retry-after", "3")]));
        let restored = set_rate_limit_observer(prev);
        assert!(restored.is_some(), "the installed observer is handed back, not dropped");

        let seen = rec.0.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].1, 429, "the ERROR status reaches the sink");
        assert_eq!(seen[0].2.retry_after_secs, Some(3));

        // With none installed, observing is a no-op rather than a panic.
        observe("https://api.example/v1", 200, &RateLimits::default());
    }
}

// ── Persisting a snapshot: the observer the agent runtime installs ────────────────────────────

/// The env var naming the headroom stream. Mirrors the `ratelimit` row in `bsc_util::LOG_STREAMS`.
pub const RATELIMIT_ENV: &str = "BSC_RATELIMIT_LOG";

/// One TSV cell for an optional number.
///
/// `∅` for absent, the digits for present — **including `0`**. That distinction is the entire point:
/// a provider that sends no headers must never be readable as exhausted, and a cell that rendered
/// both as blank would make the two indistinguishable the moment they hit disk.
fn num_cell(v: Option<u64>) -> String {
    v.map(|n| n.to_string()).unwrap_or_else(|| "∅".to_string())
}

/// Format one headroom line:
/// `ts · pane · host · status · reqRemaining · reqLimit · tokRemaining · tokLimit · retryAfter`.
///
/// Pure, and the shape is a contract — `logs::headroom` parses it back.
pub fn rate_limit_line(ts: &str, pane: &str, host: &str, status: u16, r: &RateLimits) -> String {
    format!(
        "{ts}\t{pane}\t{host}\t{status}\t{}\t{}\t{}\t{}\t{}\n",
        num_cell(r.requests_remaining),
        num_cell(r.requests_limit),
        num_cell(r.tokens_remaining),
        num_cell(r.tokens_limit),
        num_cell(r.retry_after_secs),
    )
}

/// The host a request went to, for grouping. Falls back to the whole URL rather than to a guess —
/// an unparseable URL is rare and a wrong label is worse than an ugly one.
fn host_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .filter(|h| !h.is_empty())
        .unwrap_or(url)
        .to_string()
}

/// An observer that appends every snapshot to a log file.
///
/// This is the piece that turns the capture into a RECORD. Without it the snapshots exist for the
/// duration of one call and then vanish, which is where this sat after the capture landed: parsed,
/// observable, and persisted nowhere.
pub struct RateLimitLog {
    path: std::path::PathBuf,
    pane: String,
}

impl RateLimitLog {
    pub fn new(path: impl Into<std::path::PathBuf>, pane: impl Into<String>) -> Self {
        Self { path: path.into(), pane: pane.into() }
    }
}

impl RateLimitObserver for RateLimitLog {
    fn observe(&self, url: &str, status: u16, limits: &RateLimits) {
        // A provider that reported nothing has nothing to record. Writing a row of `∅` per request
        // would bury the providers that DO report under a local model's traffic, and it would inflate
        // the request-rate reading with rows that carry no budget information.
        if limits.is_empty() {
            return;
        }
        let line = rate_limit_line(
            &bsc_util::epoch_ms_to_iso8601(bsc_util::now_ms()),
            &self.pane,
            &host_of(url),
            status,
            limits,
        );
        bsc_util::append_line(&self.path, &line);
    }
}

/// Install the headroom log as the process-wide observer, if `$BSC_RATELIMIT_LOG` names one.
///
/// Called once at agent startup. A NO-OP when the env var is absent — a hand shell or a one-off CLI
/// invocation records nothing, and the reader reports an absent stream as UNKNOWN rather than as zero
/// headroom. Returns whether an observer was installed, so a caller can log which it got.
pub fn install_rate_limit_log() -> bool {
    let Some(p) = std::env::var_os(RATELIMIT_ENV).filter(|p| !p.is_empty()) else { return false };
    let pane = std::env::var("BSC_AUDIT_PANE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "?".into());
    set_rate_limit_observer(Some(std::sync::Arc::new(RateLimitLog::new(
        std::path::PathBuf::from(p),
        pane,
    ))));
    true
}

#[cfg(test)]
mod persist_tests {
    use super::*;

    fn snap(pairs: Vec<(&str, &str)>) -> RateLimits {
        parse_rate_limits(pairs)
    }

    /// THE SAFETY PROPERTY, all the way to disk. `Some(0)` and `None` must not render alike.
    #[test]
    fn zero_remaining_and_not_reported_are_different_on_disk() {
        let exhausted = snap(vec![
            ("anthropic-ratelimit-requests-limit", "1000"),
            ("anthropic-ratelimit-requests-remaining", "0"),
        ]);
        let line = rate_limit_line("T", "p", "api.anthropic.com", 429, &exhausted);
        let f: Vec<&str> = line.trim_end().split('\t').collect();
        assert_eq!(f[4], "0", "reported exhaustion is a zero");
        assert_eq!(f[6], "∅", "an unreported token budget is the marker, not a zero");
        assert_ne!(f[4], f[6], "the two must never render the same");
    }

    #[test]
    fn a_line_has_nine_columns_whatever_is_absent() {
        for r in [RateLimits::default(), snap(vec![("retry-after", "5")])] {
            let line = rate_limit_line("T", "p", "h", 200, &r);
            assert_eq!(line.trim_end().split('\t').count(), 9, "got {line:?}");
        }
    }

    #[test]
    fn the_host_is_extracted_for_grouping() {
        assert_eq!(host_of("https://api.anthropic.com/v1/messages"), "api.anthropic.com");
        assert_eq!(host_of("http://127.0.0.1:11434/api/chat"), "127.0.0.1:11434");
        // Unparseable falls back to the whole string rather than to a guessed label.
        assert_eq!(host_of("not-a-url"), "not-a-url");
    }

    /// A provider that reports nothing writes nothing — otherwise a local model's traffic buries
    /// every provider that does report, and inflates the request-rate reading with empty rows.
    #[test]
    fn a_provider_that_reports_nothing_writes_nothing() {
        let dir = std::env::temp_dir()
            .join(format!("bsc-rl-{}-{:?}", bsc_util::now_ms(), std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ratelimit.log");
        let obs = RateLimitLog::new(&path, "p:api");

        obs.observe("https://localhost/v1", 200, &RateLimits::default());
        assert!(!path.exists(), "an empty snapshot is not a record");

        obs.observe("https://api.anthropic.com/v1/messages", 200, &snap(vec![("anthropic-ratelimit-requests-remaining", "5")]));
        assert!(path.exists(), "a reporting provider does write — or the assertion above proves nothing");
        let body = std::fs::read_to_string(&path).unwrap();
        assert_eq!(body.lines().count(), 1);
        assert!(body.contains("api.anthropic.com") && body.contains("p:api"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
