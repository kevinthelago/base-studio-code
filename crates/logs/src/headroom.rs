//! `bsc mem headroom` — how much provider budget this fleet has left.
//!
//! # Why the question had no answer
//!
//! `crates/llm`'s send path called `response.json()`, which CONSUMES the response, so every
//! `anthropic-ratelimit-*` and `retry-after` header was unreadable by construction. The capture
//! landed first; this is the record and the query. Until both existed, "how many workers can we run"
//! could only be answered by launching some and seeing what broke — which is the outcome the whole
//! line of work exists to avoid.
//!
//! # Three states, and two of them look identical if you are careless
//!
//! [`read_headroom`] returns `Option`. `None` means the stream file does not exist — **unknown**,
//! not "plenty". `Some` with rows is a reading. And within a reading, a reported `0` remaining is
//! exhaustion while an unreported budget is `None`: a provider that sends no rate-limit headers at
//! all (Ollama, a local llama-server) must never render as exhausted, and an absent value must never
//! enter an average.
//!
//! This deliberately does not reuse [`crate::read_stream`], whose `unwrap_or_default()` makes a
//! missing file and an empty one the same empty vector.
//!
//! # The rate is the number that usually binds
//!
//! Remaining counts answer "how much is left"; the limit that actually binds a fleet first is
//! requests-per-minute. Each row is one provider RESPONSE, so rows over the window's span is the
//! observed aggregate request rate across every concurrent session — the figure nothing in the
//! system could produce before. It is reported as `None` rather than as `0.0` when the window is too
//! short to divide by, because a rate computed from a single sample is not a rate.

use std::collections::BTreeMap;
use std::path::Path;

/// One provider host's headroom, rolled up over the window.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Headroom {
    /// The provider host, e.g. `api.anthropic.com`.
    pub host: String,
    /// How many responses were recorded.
    pub samples: usize,
    pub first_seen: String,
    pub last_seen: String,
    /// The MOST RECENT reading. `None` means that budget was never reported, not that it is zero.
    pub requests_remaining: Option<u64>,
    pub requests_limit: Option<u64>,
    pub tokens_remaining: Option<u64>,
    pub tokens_limit: Option<u64>,
    /// The tightest headroom in the latest reading, as a fraction of its limit — the honest summary
    /// when requests and tokens are separate budgets and either can bind.
    pub headroom_fraction: Option<f64>,
    /// The LOW-WATER mark across the window: the smallest remaining seen, per budget. A latest
    /// reading of "plenty" hides a fleet that repeatedly ran itself to the floor and recovered.
    pub min_requests_remaining: Option<u64>,
    pub min_tokens_remaining: Option<u64>,
    /// How many responses carried a `Retry-After` — i.e. how often the provider actually pushed back.
    pub throttled: usize,
    /// Observed responses per minute over the window. `None` when the window is too short to divide.
    pub requests_per_min: Option<f64>,
    /// The panes that talked to this host — the aggregate is across all of them.
    pub panes: Vec<String>,
}

fn cell(v: &str) -> Option<u64> {
    if v == "∅" || v.is_empty() {
        return None;
    }
    v.parse::<u64>().ok()
}

/// Keep the smaller of two optional readings, treating absent as "no information".
fn min_opt(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (x, y) => x.or(y),
    }
}

/// Read the headroom stream and roll it up per host.
///
/// **`None` means the stream does not exist** — unknown, not clean and not empty. `since_ms` bounds
/// the window; `None` reads everything.
pub fn read_headroom(dir: &Path, since_ms: Option<i64>) -> Option<Vec<Headroom>> {
    let text = std::fs::read_to_string(dir.join("ratelimit.log")).ok()?;

    let mut acc: BTreeMap<String, Headroom> = BTreeMap::new();
    let mut span: BTreeMap<String, (i64, i64)> = BTreeMap::new();

    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 9 {
            continue; // not a headroom row
        }
        let Some(ms) = crate::to_ms(f[0]) else { continue };
        if let Some(floor) = since_ms {
            if ms < floor {
                continue;
            }
        }
        let (ts, pane, host) = (f[0], f[1], f[2]);
        let (rr, rl, tr, tl, ra) = (cell(f[4]), cell(f[5]), cell(f[6]), cell(f[7]), cell(f[8]));

        let e = acc.entry(host.to_string()).or_insert_with(|| Headroom {
            host: host.to_string(),
            samples: 0,
            first_seen: ts.to_string(),
            last_seen: ts.to_string(),
            requests_remaining: None,
            requests_limit: None,
            tokens_remaining: None,
            tokens_limit: None,
            headroom_fraction: None,
            min_requests_remaining: None,
            min_tokens_remaining: None,
            throttled: 0,
            requests_per_min: None,
            panes: Vec::new(),
        });
        e.samples += 1;
        if ra.is_some() {
            e.throttled += 1;
        }
        e.min_requests_remaining = min_opt(e.min_requests_remaining, rr);
        e.min_tokens_remaining = min_opt(e.min_tokens_remaining, tr);
        if !pane.is_empty() && pane != "?" && !e.panes.iter().any(|p| p == pane) {
            e.panes.push(pane.to_string());
        }

        let sp = span.entry(host.to_string()).or_insert((ms, ms));
        if ms < sp.0 {
            sp.0 = ms;
            e.first_seen = ts.to_string();
        }
        // The LATEST row supplies the current reading — and only when it is genuinely the latest, so
        // an out-of-order line cannot make a stale sample look current.
        if ms >= sp.1 {
            sp.1 = ms;
            e.last_seen = ts.to_string();
            e.requests_remaining = rr;
            e.requests_limit = rl;
            e.tokens_remaining = tr;
            e.tokens_limit = tl;
        }
    }

    let mut rows: Vec<Headroom> = acc.into_values().collect();
    for r in &mut rows {
        let frac = |rem: Option<u64>, lim: Option<u64>| match (rem, lim) {
            (Some(a), Some(b)) if b > 0 => Some(a as f64 / b as f64),
            _ => None,
        };
        let a = frac(r.requests_remaining, r.requests_limit);
        let b = frac(r.tokens_remaining, r.tokens_limit);
        r.headroom_fraction = match (a, b) {
            (Some(x), Some(y)) => Some(x.min(y)),
            (x, y) => x.or(y),
        };
        if let Some((lo, hi)) = span.get(&r.host) {
            let mins = (hi - lo) as f64 / 60_000.0;
            // A rate needs a window. One sample, or every sample in the same instant, is not one.
            r.requests_per_min = if mins > 0.0 { Some(r.samples as f64 / mins) } else { None };
        }
    }
    // Tightest headroom first — the host about to bind is the one worth seeing.
    rows.sort_by(|a, b| {
        a.headroom_fraction
            .unwrap_or(f64::INFINITY)
            .partial_cmp(&b.headroom_fraction.unwrap_or(f64::INFINITY))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.host.cmp(&b.host))
    });
    Some(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("bsc-headroom-{tag}-{}", bsc_util::now_ms()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn write(dir: &Path, body: &str) {
        std::fs::write(dir.join("ratelimit.log"), body).unwrap();
    }

    /// THE CRITERION, again: absence is not zero, and it is not "plenty" either.
    #[test]
    fn an_absent_stream_is_unknown_not_full_and_not_empty() {
        let d = tmp("absent");
        assert!(read_headroom(&d, None).is_none(), "no stream — UNKNOWN");
        write(&d, "");
        assert_eq!(read_headroom(&d, None).unwrap().len(), 0, "a live but silent stream is a reading");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A header-less provider must never read as exhausted — asserted end to end, from what the
    /// emitter writes to what the reader reports.
    #[test]
    fn a_header_less_provider_does_not_read_as_exhausted() {
        let d = tmp("headerless");
        // Only a retry-after: the token budget was never reported.
        write(&d, "2026-09-01T12:00:00Z\tp\tlocalhost:11434\t200\t∅\t∅\t∅\t∅\t∅\n");
        let r = &read_headroom(&d, None).unwrap()[0];
        assert_eq!(r.requests_remaining, None, "absent, NOT Some(0)");
        assert_eq!(r.tokens_remaining, None);
        assert_eq!(r.headroom_fraction, None, "and no fraction can be computed from nothing");

        // Which is a different state from a provider that reported genuine exhaustion.
        write(&d, "2026-09-01T12:00:00Z\tp\tapi.anthropic.com\t429\t0\t1000\t∅\t∅\t30\n");
        let e = &read_headroom(&d, None).unwrap()[0];
        assert_eq!(e.requests_remaining, Some(0));
        assert_eq!(e.headroom_fraction, Some(0.0));
        assert_ne!(r.requests_remaining, e.requests_remaining, "the two must not collapse");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_latest_row_supplies_the_reading_and_the_window_supplies_the_low_water_mark() {
        let d = tmp("rollup");
        write(
            &d,
            "2026-09-01T12:00:00Z\tp:a\tapi.anthropic.com\t200\t900\t1000\t70000\t80000\t∅\n\
             2026-09-01T12:01:00Z\tp:b\tapi.anthropic.com\t429\t3\t1000\t500\t80000\t12\n\
             2026-09-01T12:02:00Z\tp:a\tapi.anthropic.com\t200\t950\t1000\t75000\t80000\t∅\n",
        );
        let r = &read_headroom(&d, None).unwrap()[0];
        assert_eq!(r.samples, 3);
        assert_eq!(r.requests_remaining, Some(950), "the LATEST reading, not the first or the worst");
        assert_eq!(r.min_requests_remaining, Some(3), "but the low-water mark is kept");
        assert_eq!(r.min_tokens_remaining, Some(500));
        assert_eq!(r.throttled, 1, "one response carried a Retry-After");
        assert_eq!(r.panes, vec!["p:a", "p:b"]);
        assert_eq!(r.first_seen, "2026-09-01T12:00:00Z");
        assert_eq!(r.last_seen, "2026-09-01T12:02:00Z");
        // 3 samples over a 2-minute span.
        assert_eq!(r.requests_per_min, Some(1.5));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The reading comes from the LATEST TIMESTAMP, not the last line in the file.
    ///
    /// Found by a divergence that did not bite: dropping the `ms >= sp.1` guard passed everything,
    /// because every row in the corpus was already chronological, so "last line" and "latest" were
    /// the same row. They are not always: log files get concatenated, rotated and merged, and an
    /// out-of-order line would otherwise make a STALE sample the current reading — reporting budget
    /// the fleet has already spent.
    #[test]
    fn an_out_of_order_line_cannot_make_a_stale_sample_the_reading() {
        let d = tmp("outoforder");
        // The NEWEST row is written first; the stale one follows it.
        write(
            &d,
            "2026-09-01T18:00:00Z\tp\th\t200\t50\t1000\t∅\t∅\t∅\n\
             2026-09-01T09:00:00Z\tp\th\t200\t990\t1000\t∅\t∅\t∅\n",
        );
        let r = &read_headroom(&d, None).unwrap()[0];
        assert_eq!(r.requests_remaining, Some(50), "the 18:00 reading wins, not the last line");
        assert_eq!(r.last_seen, "2026-09-01T18:00:00Z");
        assert_eq!(r.first_seen, "2026-09-01T09:00:00Z");
        assert_eq!(r.min_requests_remaining, Some(50), "and the floor is still the floor");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A latest reading of "plenty" must not hide a fleet that ran itself to the floor and recovered.
    #[test]
    fn a_recovered_fleet_still_shows_its_floor() {
        let d = tmp("floor");
        write(
            &d,
            "2026-09-01T12:00:00Z\tp\th\t429\t0\t1000\t∅\t∅\t60\n\
             2026-09-01T12:05:00Z\tp\th\t200\t1000\t1000\t∅\t∅\t∅\n",
        );
        let r = &read_headroom(&d, None).unwrap()[0];
        assert_eq!(r.headroom_fraction, Some(1.0), "right now it looks fine");
        assert_eq!(r.min_requests_remaining, Some(0), "and it hit zero inside the window");
        assert_eq!(r.throttled, 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A rate needs a window. One sample is not a rate, and reporting 0.0 would be a fabrication.
    #[test]
    fn a_rate_is_absent_rather_than_zero_when_there_is_no_window() {
        let d = tmp("rate");
        write(&d, "2026-09-01T12:00:00Z\tp\th\t200\t5\t10\t∅\t∅\t∅\n");
        assert_eq!(read_headroom(&d, None).unwrap()[0].requests_per_min, None, "one sample is not a rate");

        // Two samples in the same instant are still not a window.
        write(&d, "2026-09-01T12:00:00Z\tp\th\t200\t5\t10\t∅\t∅\t∅\n2026-09-01T12:00:00Z\tp\th\t200\t4\t10\t∅\t∅\t∅\n");
        assert_eq!(read_headroom(&d, None).unwrap()[0].requests_per_min, None);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The aggregate rate is ACROSS panes — that is the number nothing in the system could produce.
    #[test]
    fn the_rate_aggregates_every_concurrent_pane() {
        let d = tmp("aggregate");
        let mut body = String::new();
        for i in 0..8 {
            body.push_str(&format!("2026-09-01T12:0{}:00Z\tp:{}\th\t200\t5\t10\t∅\t∅\t∅\n", i, i % 4));
        }
        write(&d, &body);
        let r = &read_headroom(&d, None).unwrap()[0];
        assert_eq!(r.samples, 8);
        assert_eq!(r.panes.len(), 4, "four concurrent sessions");
        assert_eq!(r.requests_per_min, Some(8.0 / 7.0), "8 responses over a 7-minute span");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn hosts_are_ordered_by_tightest_headroom_and_unknown_sorts_last() {
        let d = tmp("order");
        write(
            &d,
            "2026-09-01T12:00:00Z\tp\troomy\t200\t900\t1000\t∅\t∅\t∅\n\
             2026-09-01T12:00:00Z\tp\ttight\t200\t10\t1000\t∅\t∅\t∅\n\
             2026-09-01T12:00:00Z\tp\tunknown\t200\t∅\t∅\t∅\t∅\t∅\n",
        );
        let rows = read_headroom(&d, None).unwrap();
        assert_eq!(rows.iter().map(|r| r.host.as_str()).collect::<Vec<_>>(), vec!["tight", "roomy", "unknown"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_window_floor_excludes_older_rows() {
        let d = tmp("since");
        write(
            &d,
            "2026-09-01T12:00:00Z\tp\th\t200\t1\t10\t∅\t∅\t∅\n\
             2026-09-01T18:00:00Z\tp\th\t200\t9\t10\t∅\t∅\t∅\n",
        );
        let floor = crate::to_ms("2026-09-01T15:00:00Z").unwrap();
        let r = &read_headroom(&d, Some(floor)).unwrap()[0];
        assert_eq!(r.samples, 1);
        assert_eq!(r.min_requests_remaining, Some(9), "the older floor of 1 is outside the window");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// What the EMITTER writes is what this parses — a hand-written fixture only proves the parser
    /// agrees with whoever typed it.
    #[test]
    fn the_reader_parses_exactly_what_the_emitter_writes() {
        let d = tmp("roundtrip");
        let path = d.join("ratelimit.log");
        let obs = llm::ratelimit::RateLimitLog::new(&path, "p:api");
        {
            use llm::ratelimit::RateLimitObserver;
            obs.observe(
                "https://api.anthropic.com/v1/messages",
                429,
                &llm::ratelimit::parse_rate_limits(vec![
                    ("anthropic-ratelimit-requests-limit", "1000"),
                    ("anthropic-ratelimit-requests-remaining", "0"),
                    ("retry-after", "30"),
                ]),
            );
        }
        let r = &read_headroom(&d, None).unwrap()[0];
        assert_eq!(r.host, "api.anthropic.com");
        assert_eq!(r.requests_remaining, Some(0), "reported exhaustion survives the round trip");
        assert_eq!(r.tokens_remaining, None, "and an unreported budget stays absent");
        assert_eq!(r.throttled, 1);
        assert_eq!(r.panes, vec!["p:api"]);
        let _ = std::fs::remove_dir_all(&d);
    }
}
