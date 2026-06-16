// Token + cost accounting (#416), extracted from lib.rs (#758).

use crate::bsc_base_dir;

//
// Claude Code hooks don't expose token usage, so the only per-session source is the
// session transcript (JSONL, one message per line, each assistant line carrying a
// per-message `usage` object). The `bsc-tokens` Stop hook records `pane → session_id →
// transcript_path` to `tokens.log`; `read_token_usage` takes the latest transcript per
// pane, sums its usage, prices it, and returns one record per pane. Pricing + parsing
// live here (testable) rather than in the bash helper.

/// Per-pane token + cost accounting, one record per pane (#416). Serialized to the
/// frontend so the Fleet tokens/spend panel renders real numbers instead of a
/// "not measured yet" note.
#[derive(serde::Serialize, Debug, PartialEq)]
pub(crate) struct TokenUsage {
    pane: String,
    session_id: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    cost_usd: f64,
}

/// Dollars-per-million-token prices for one model family.
struct Pricing {
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

/// Price table keyed by model-family substring (USD per million tokens). `cache_write`
/// is the 5-minute cache-write rate (1.25x base input), `cache_read` the cache-read rate
/// (0.1x base input). Unknown / empty models fall back to Sonnet — the app's default
/// model (`claude-sonnet-4-6`) — so an unrecognized id is priced conservatively rather
/// than as $0. These are list prices and may drift; they live in one place to update.
fn model_pricing(model: &str) -> Pricing {
    let m = model.to_ascii_lowercase();
    if m.contains("opus") {
        Pricing { input: 15.0, output: 75.0, cache_write: 18.75, cache_read: 1.50 }
    } else if m.contains("haiku") {
        Pricing { input: 1.0, output: 5.0, cache_write: 1.25, cache_read: 0.10 }
    } else {
        // sonnet + anything unrecognized
        Pricing { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.30 }
    }
}

/// Summed usage across a transcript, plus the last-seen model for pricing.
#[derive(Default, Debug, PartialEq)]
struct TranscriptTotals {
    model: String,
    input: u64,
    output: u64,
    cache_creation: u64,
    cache_read: u64,
}

impl TranscriptTotals {
    fn is_empty(&self) -> bool {
        self.input == 0 && self.output == 0 && self.cache_creation == 0 && self.cache_read == 0
    }
}

/// Sum the per-message `usage` across every assistant line of a Claude Code transcript
/// (JSONL). Usage is reported per-message (not cumulative), so the session total is the
/// sum. Captures the last non-empty model seen for pricing. Tolerant: malformed/non-JSON
/// lines and lines without a `usage` object are skipped, so a partially-written
/// transcript still yields a partial total.
fn parse_transcript_usage(jsonl: &str) -> TranscriptTotals {
    let mut t = TranscriptTotals::default();
    for line in jsonl.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let msg = &v["message"];
        let usage = &msg["usage"];
        if !usage.is_object() {
            continue;
        }
        t.input += usage["input_tokens"].as_u64().unwrap_or(0);
        t.output += usage["output_tokens"].as_u64().unwrap_or(0);
        t.cache_creation += usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
        t.cache_read += usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
        if let Some(model) = msg["model"].as_str() {
            if !model.is_empty() {
                t.model = model.to_string();
            }
        }
    }
    t
}

/// Total USD cost for a transcript's usage, priced by its model.
fn compute_cost(t: &TranscriptTotals) -> f64 {
    let p = model_pricing(&t.model);
    (t.input as f64 * p.input
        + t.output as f64 * p.output
        + t.cache_creation as f64 * p.cache_write
        + t.cache_read as f64 * p.cache_read)
        / 1_000_000.0
}

/// Decode a JSON-escaped path stored verbatim in `tokens.log` (`bsc-tokens` writes the
/// hook's `transcript_path` field without unescaping). Reverses the escapes a JSON string
/// can carry for a filesystem path — `\\` → `\` (Windows separators) and `\/` → `/`.
pub(crate) fn json_unescape_path(p: &str) -> String {
    p.replace("\\\\", "\\").replace("\\/", "/")
}

/// The latest `(pane, session_id, transcript_path)` per pane from a `tokens.log` body,
/// newest pane first. The log is append-only oldest-first, so a later line for a pane
/// supersedes earlier ones (a resumed `--continue` session keeps the same transcript,
/// which already accumulates all usage). Pure (no fs) so it's unit-testable.
fn latest_transcript_per_pane(log_text: &str) -> Vec<(String, String, String)> {
    use std::collections::HashMap;
    // pane -> (order, session_id, transcript_path)
    let mut latest: HashMap<String, (usize, String, String)> = HashMap::new();
    for (i, line) in log_text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 4 {
            continue;
        }
        let (pane, sid, tp) = (f[1].to_string(), f[2].to_string(), f[3].to_string());
        if pane.is_empty() || tp.is_empty() {
            continue;
        }
        latest.insert(pane, (i, sid, tp));
    }
    let mut rows: Vec<(usize, String, String, String)> =
        latest.into_iter().map(|(pane, (ord, sid, tp))| (ord, pane, sid, tp)).collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r.0)); // newest line first
    rows.into_iter().map(|(_, pane, sid, tp)| (pane, sid, tp)).collect()
}

/// Read per-pane token + cost accounting (#416). Reads `tokens.log`, takes the latest
/// transcript per pane, parses + prices its usage, and returns up to `limit` records
/// (newest pane first). Panes whose transcript is missing/unreadable or carries no usage
/// are skipped — honest empties, never fabricated numbers.
#[tauri::command]
pub(crate) fn read_token_usage(limit: usize) -> Vec<TokenUsage> {
    let path = bsc_base_dir().join("tokens.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut out: Vec<TokenUsage> = Vec::new();
    for (pane, session_id, tp) in latest_transcript_per_pane(&text) {
        if out.len() >= limit {
            break;
        }
        let jsonl = match std::fs::read_to_string(json_unescape_path(&tp)) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let totals = parse_transcript_usage(&jsonl);
        if totals.is_empty() {
            continue;
        }
        let cost = compute_cost(&totals);
        out.push(TokenUsage {
            pane,
            session_id,
            model: totals.model,
            input_tokens: totals.input,
            output_tokens: totals.output,
            cache_creation_tokens: totals.cache_creation,
            cache_read_tokens: totals.cache_read,
            cost_usd: cost,
        });
    }
    out
}

#[cfg(test)]
mod tests {

    #[test]
    fn parse_transcript_usage_sums_per_message_usage() {
        // Usage is per-message (not cumulative), so the session total is the sum across
        // assistant lines. The last non-empty model is captured for pricing; non-JSON
        // lines and lines without `usage` are skipped (partial transcripts still total).
        let jsonl = concat!(
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#, "\n",
            r#"{"type":"assistant","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}}}"#, "\n",
            "not json at all\n",
            r#"{"type":"assistant","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":5,"output_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":2000}}}"#, "\n",
        );
        let t = super::parse_transcript_usage(jsonl);
        assert_eq!(t.input, 15);
        assert_eq!(t.output, 27);
        assert_eq!(t.cache_creation, 100);
        assert_eq!(t.cache_read, 3000);
        assert_eq!(t.model, "claude-sonnet-4-6");
        assert!(!t.is_empty());
        // An empty / usage-free transcript yields a zero total flagged empty.
        assert!(super::parse_transcript_usage("").is_empty());
        assert!(super::parse_transcript_usage(r#"{"type":"user","message":{"role":"user"}}"#).is_empty());
    }

    #[test]
    fn compute_cost_prices_each_model_family() {
        // Cost = sum(tokens * per-million-rate) / 1e6. Sonnet is the fallback for
        // unknown/empty models so they never price as $0. Spot-check each family with
        // 1M tokens of each kind so the rate equals the table entry directly.
        let make = |model: &str| super::TranscriptTotals {
            model: model.to_string(),
            input: 1_000_000,
            output: 1_000_000,
            cache_creation: 1_000_000,
            cache_read: 1_000_000,
        };
        // Sonnet: 3 + 15 + 3.75 + 0.30 = 22.05
        assert!((super::compute_cost(&make("claude-sonnet-4-6")) - 22.05).abs() < 1e-9);
        // Unknown / empty model falls back to Sonnet pricing.
        assert!((super::compute_cost(&make("")) - 22.05).abs() < 1e-9);
        // Opus: 15 + 75 + 18.75 + 1.50 = 110.25
        assert!((super::compute_cost(&make("claude-opus-4-8")) - 110.25).abs() < 1e-9);
        // Haiku: 1 + 5 + 1.25 + 0.10 = 7.35
        assert!((super::compute_cost(&make("claude-haiku-4-5")) - 7.35).abs() < 1e-9);
        // A realistic small total prices to a small positive number.
        let small = super::TranscriptTotals { model: "claude-sonnet-4-6".into(), input: 10, output: 20, cache_creation: 100, cache_read: 1000 };
        let c = super::compute_cost(&small);
        assert!(c > 0.0 && c < 0.01, "got {c}");
    }

    #[test]
    fn latest_transcript_per_pane_dedupes_to_newest_line() {
        // tokens.log is append-only oldest-first; a later line for a pane supersedes
        // earlier ones, and the result is newest-pane-first. Malformed/short lines and
        // empty pane/path fields are dropped.
        let log = concat!(
            "ts1\tp1\tsidA\t/tA1.jsonl\n",
            "ts2\tp2\tsidB\t/tB.jsonl\n",
            "bad line with no tabs\n",
            "ts3\tp1\tsidA\t/tA2.jsonl\n",   // supersedes p1's first line
            "ts4\tp3\t\t/tC.jsonl\n",        // dropped: empty session id is OK, but...
            "ts5\tp4\tsidD\t\n",             // dropped: empty transcript path
        );
        let rows = super::latest_transcript_per_pane(log);
        // p1 (latest, ts3), p2, and p3 (empty session id is allowed) — p4 dropped.
        let panes: Vec<&str> = rows.iter().map(|(p, _, _)| p.as_str()).collect();
        assert_eq!(panes, vec!["p3", "p1", "p2"], "newest line first; p4 dropped");
        let p1 = rows.iter().find(|(p, _, _)| p == "p1").unwrap();
        assert_eq!(p1.2, "/tA2.jsonl", "p1 should resolve to its newest transcript");
    }
}

