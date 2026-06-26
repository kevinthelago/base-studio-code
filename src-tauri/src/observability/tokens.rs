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

/// Dollars-per-million-token list prices for one model family: base `input`, `output`, the
/// 5-minute cache-write rate, and the cache-read (hit) rate.
struct Pricing {
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

/// Open-weight model families the app runs through the *local* provider (Ollama / any
/// OpenAI-compatible endpoint) — self-hosted, so $0. Matched as substrings of the model id.
const LOCAL_FAMILIES: [&str; 9] =
    ["llama", "qwen", "mistral", "mixtral", "gemma", "phi", "deepseek", "codestral", "ollama"];

/// Price table keyed by a model-name substring (USD per million tokens), spanning every
/// provider the app can drive (#1078): Anthropic, OpenAI, Gemini, and local/open-weight.
/// Matched against the lowercased model id recorded in the transcript, most-specific family
/// first. Local models are free ($0). An unrecognized *hosted* model falls back to Sonnet —
/// the app's default — so it's priced conservatively rather than as $0.
///
/// Only `input`/`output` affect a session's cost for OpenAI/Gemini/local: those providers'
/// usage normalizes the prompt-cache counts to 0 (see `crates/llm`), so their `cache_*` rates
/// are recorded for completeness but never billed; Anthropic's caching is what they price.
/// List prices as of 2026-06 — they drift, so they live in this one place to update.
fn model_pricing(model: &str) -> Pricing {
    let m = model.to_ascii_lowercase();

    // ── Anthropic (Claude) ── cache write = 1.25× input, cache read = 0.10× input.
    if m.contains("opus") {
        // Opus 4.8 list price (down from the 4.x-era $15/$75).
        return Pricing { input: 5.0, output: 25.0, cache_write: 6.25, cache_read: 0.50 };
    }
    if m.contains("haiku") {
        return Pricing { input: 1.0, output: 5.0, cache_write: 1.25, cache_read: 0.10 };
    }
    if m.contains("sonnet") {
        return Pricing { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.30 };
    }

    // ── OpenAI (GPT) ── no cache-write premium (cache_write = input); cache_read is the
    // "cached input" rate. Size suffixes (nano/mini/pro) take precedence over the family.
    if m.contains("gpt") {
        if m.contains("nano") {
            return Pricing { input: 0.20, output: 1.25, cache_write: 0.20, cache_read: 0.02 };
        }
        if m.contains("mini") {
            return Pricing { input: 0.75, output: 4.50, cache_write: 0.75, cache_read: 0.075 };
        }
        if m.contains("pro") {
            return Pricing { input: 30.0, output: 180.0, cache_write: 30.0, cache_read: 30.0 };
        }
        if m.contains("gpt-5.5") {
            return Pricing { input: 5.0, output: 30.0, cache_write: 5.0, cache_read: 0.50 };
        }
        // gpt-5.4 / gpt-5 base, and any unrecognized GPT.
        return Pricing { input: 2.50, output: 15.0, cache_write: 2.50, cache_read: 0.25 };
    }

    // ── Google (Gemini) ── cache_read is the context-cache rate; no cache-write premium.
    if m.contains("gemini") {
        if m.contains("flash-lite") {
            return Pricing { input: 0.10, output: 0.40, cache_write: 0.10, cache_read: 0.01 };
        }
        if m.contains("flash") {
            return Pricing { input: 0.30, output: 2.50, cache_write: 0.30, cache_read: 0.03 };
        }
        // gemini-2.5-pro (≤200k tier), and any unrecognized Gemini.
        return Pricing { input: 1.25, output: 10.0, cache_write: 1.25, cache_read: 0.125 };
    }

    // ── Local / open-weight ── self-hosted, free.
    if LOCAL_FAMILIES.iter().any(|f| m.contains(f)) {
        return Pricing { input: 0.0, output: 0.0, cache_write: 0.0, cache_read: 0.0 };
    }

    // Unknown hosted model → Sonnet (conservative; never $0 for a paid model).
    Pricing { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.30 }
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

/// Generic "latest row per key, newest-line-first" parser shared by the per-pane TSV readers
/// (`tokens.log` / `activity.log` / `done.log`). Walks `text` line-by-line, skipping blank
/// lines and any line with fewer than `min_cols` tab-separated fields, then hands the fields
/// to `parse_row` to extract `(key, payload)` — returning `None` drops the row. The logs are
/// append-only oldest-first, so the LAST row seen per key wins; the payloads come back
/// newest-line-first. Pure (no fs) so it's unit-testable through its callers.
fn latest_per_key<R>(
    text: &str,
    min_cols: usize,
    parse_row: impl Fn(&[&str]) -> Option<(String, R)>,
) -> Vec<R> {
    use std::collections::HashMap;
    // key -> (line order, payload)
    let mut latest: HashMap<String, (usize, R)> = HashMap::new();
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < min_cols {
            continue;
        }
        if let Some((key, payload)) = parse_row(&f) {
            latest.insert(key, (i, payload));
        }
    }
    let mut rows: Vec<(usize, R)> = latest.into_iter().map(|(_, (ord, r))| (ord, r)).collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r.0)); // newest line first
    rows.into_iter().map(|(_, r)| r).collect()
}

/// The latest `(pane, session_id, transcript_path)` per pane from a `tokens.log` body,
/// newest pane first. The log is append-only oldest-first, so a later line for a pane
/// supersedes earlier ones (a resumed `--continue` session keeps the same transcript,
/// which already accumulates all usage). Pure (no fs) so it's unit-testable.
fn latest_transcript_per_pane(log_text: &str) -> Vec<(String, String, String)> {
    latest_per_key(log_text, 4, |f| {
        let (pane, sid, tp) = (f[1].to_string(), f[2].to_string(), f[3].to_string());
        if pane.is_empty() || tp.is_empty() {
            return None;
        }
        Some((pane.clone(), (pane, sid, tp)))
    })
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

// ── Turn activity (#1184) ────────────────────────────────────────────────────────
//
// The console status dot can't tell "done" from "working but silent" — its only per-turn
// signal is a 1.5s silence timer, which false-idles a worker that's thinking, running a long
// silent tool call, or backing off. The fix drives turn boundaries from authoritative Claude
// Code hooks: `bsc-activity run` on UserPromptSubmit (turn opens), `bsc-activity idle` on
// Stop/SubagentStop (turn closes), each appending `ts \t pane \t run|idle` to `activity.log`.
// `read_pane_activity` returns the latest state per pane; the frontend treats `run` as
// "turn open" and gates the silence timer so an open turn never false-idles.

/// One pane's latest turn-boundary state (#1184). `state` is `"run"` (a turn is open — the agent
/// is working) or `"idle"` (the turn closed at an authoritative Stop). Serialized to the frontend
/// poller, which gates the status dot's silence timer on it.
#[derive(serde::Serialize, Debug, PartialEq)]
pub(crate) struct PaneActivity {
    pane: String,
    state: String,
    /// Epoch-ms timestamp of the event (as the `bsc-activity` helper wrote it).
    at: u64,
}

/// The latest `(pane, state, at)` per pane from an `activity.log` body, newest pane first. The log
/// is append-only oldest-first, so a later line for a pane supersedes earlier ones. Only `run` /
/// `idle` states are kept; malformed/short lines and unknown states are dropped. Pure (no fs) so
/// it's unit-testable.
fn latest_activity_per_pane(log_text: &str) -> Vec<(String, String, u64)> {
    latest_per_key(log_text, 3, |f| {
        let (at, pane, state) = (f[0], f[1].to_string(), f[2].trim().to_string());
        if pane.is_empty() || (state != "run" && state != "idle") {
            return None;
        }
        let at: u64 = at.trim().parse().ok()?;
        Some((pane.clone(), (pane, state, at)))
    })
}

/// Read the latest turn-boundary state per pane (#1184). Reads `activity.log` and returns one
/// record per pane (newest pane first). Missing log ⇒ empty (no panes have taken a turn yet),
/// so the frontend cleanly falls back to its silence-timer behavior.
#[tauri::command]
pub(crate) fn read_pane_activity() -> Vec<PaneActivity> {
    let path = bsc_base_dir().join("activity.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    latest_activity_per_pane(&text)
        .into_iter()
        .map(|(pane, state, at)| PaneActivity { pane, state, at })
        .collect()
}

// ── Worker self-close (#1379) ──────────────────────────────────────────────────
//
// A finished worker calls `bsc-done`, appending `ts \t pane` to `done.log`. The frontend polls the
// set of self-reported panes and reaps each (classify the resting state from plan.db, `markPaneEnded`,
// `pty_kill`) — the worker says "I'm done"; the verdict + the resting card still come from plan.db.

/// The deduped set of panes that have self-reported `done` (via `bsc-done`), newest first. The log
/// is `ts \t pane` per line; blank/short lines and empty pane fields are dropped. Pure (no fs).
fn done_panes(log_text: &str) -> Vec<String> {
    latest_per_key(log_text, 2, |f| {
        let pane = f[1].trim().to_string();
        if pane.is_empty() {
            return None;
        }
        Some((pane.clone(), pane))
    })
}

/// The panes a finished worker self-reported via `bsc-done` (#1379). Missing log ⇒ empty (no worker
/// has asked to close yet), so the frontend simply reaps nothing.
#[tauri::command]
pub(crate) fn read_done_panes() -> Vec<String> {
    let path = bsc_base_dir().join("done.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    done_panes(&text)
}

// ── Transcript → conversation (#934) ─────────────────────────────────────────────
//
// The live planning session is projected to a paired phone as structured `plan_state.messages`.
// The planner is a PTY running `claude`, so the structured conversation lives ONLY in Claude's
// transcript JSONL — the same per-pane transcript `read_token_usage` already reads. We extract
// the user/assistant text turns from it (tool-use/tool-result blocks are dropped — the phone
// renders the conversation, not the tool plumbing).

/// The readable text of a transcript message's `content`: a bare string, or the concatenated
/// `text` blocks of a content array (skipping tool_use / tool_result / image blocks).
fn message_text(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    let Some(arr) = content.as_array() else { return String::new() };
    let mut out = String::new();
    for block in arr {
        if block["type"] == "text" {
            if let Some(t) = block["text"].as_str() {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
            }
        }
    }
    out
}

/// Parse an RFC3339 transcript `timestamp` to epoch ms; 0 when absent/unparseable.
fn parse_iso_ms(s: &str) -> u64 {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::parse(s, &Rfc3339)
        .map(|t| (t.unix_timestamp_nanos() / 1_000_000).max(0) as u64)
        .unwrap_or(0)
}

/// Parse a Claude transcript (JSONL) into its user/assistant text turns, keeping the newest
/// `limit`. Tolerant: malformed lines, non-message types, and empty-text turns are skipped.
fn parse_transcript_messages(jsonl: &str, limit: usize) -> Vec<crate::tunnel::PlanMessage> {
    let mut msgs: Vec<crate::tunnel::PlanMessage> = Vec::new();
    for line in jsonl.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let role = match v["type"].as_str() {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        let text = message_text(&v["message"]["content"]);
        if text.trim().is_empty() {
            continue;
        }
        let at = v["timestamp"].as_str().map(parse_iso_ms).unwrap_or(0);
        msgs.push(crate::tunnel::PlanMessage { role: role.to_string(), text, at });
    }
    let n = msgs.len();
    if n > limit { msgs.split_off(n - limit) } else { msgs }
}

/// The user/assistant conversation for `pane_id`, from its latest Claude transcript — the
/// newest `limit` turns, or empty when the pane has no transcript yet (#934).
#[tauri::command]
pub(crate) fn read_pane_messages(pane_id: String, limit: usize) -> Vec<crate::tunnel::PlanMessage> {
    let text = std::fs::read_to_string(bsc_base_dir().join("tokens.log")).unwrap_or_default();
    let Some((_, _, tp)) = latest_transcript_per_pane(&text).into_iter().find(|(p, _, _)| *p == pane_id) else {
        return Vec::new();
    };
    match std::fs::read_to_string(json_unescape_path(&tp)) {
        Ok(jsonl) => parse_transcript_messages(&jsonl, limit),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {

    /// The conversation extractor keeps user/assistant TEXT turns (dropping tool blocks),
    /// parses the timestamp, and bounds to the newest `limit` (#934).
    #[test]
    fn parse_transcript_messages_extracts_text_turns() {
        let jsonl = concat!(
            r#"{"type":"user","message":{"role":"user","content":"plan the app"},"timestamp":"2026-06-23T20:00:00.000Z"}"#, "\n",
            r#"not json — skipped"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Here's the goal."},{"type":"tool_use","name":"Write","input":{}}]},"timestamp":"2026-06-23T20:00:01.000Z"}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}"#, "\n", // no text → skipped
            r#"{"type":"summary","summary":"…"}"#, "\n", // non-message type → skipped
        );
        let msgs = super::parse_transcript_messages(jsonl, 10);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].text, "plan the app");
        assert!(msgs[0].at > 1_700_000_000_000); // a real epoch-ms, parsed from the RFC3339 ts
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].text, "Here's the goal."); // tool_use block dropped
        assert_eq!(msgs[1].at, msgs[0].at + 1000); // 1s apart, as in the transcript
    }

    /// `limit` keeps the NEWEST turns.
    #[test]
    fn parse_transcript_messages_bounds_to_newest() {
        let jsonl = concat!(
            r#"{"type":"user","message":{"content":"one"}}"#, "\n",
            r#"{"type":"user","message":{"content":"two"}}"#, "\n",
            r#"{"type":"user","message":{"content":"three"}}"#, "\n",
        );
        let msgs = super::parse_transcript_messages(jsonl, 2);
        assert_eq!(msgs.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), vec!["two", "three"]);
    }

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
        // Unknown / empty HOSTED model falls back to Sonnet pricing.
        assert!((super::compute_cost(&make("")) - 22.05).abs() < 1e-9);
        assert!((super::compute_cost(&make("some-future-hosted-model")) - 22.05).abs() < 1e-9);
        // Opus 4.8: 5 + 25 + 6.25 + 0.50 = 36.75
        assert!((super::compute_cost(&make("claude-opus-4-8")) - 36.75).abs() < 1e-9);
        // Haiku: 1 + 5 + 1.25 + 0.10 = 7.35
        assert!((super::compute_cost(&make("claude-haiku-4-5")) - 7.35).abs() < 1e-9);
        // OpenAI gpt-5.4 base: 2.50 + 15 + 2.50 + 0.25 = 20.25
        assert!((super::compute_cost(&make("gpt-5.4")) - 20.25).abs() < 1e-9);
        // gpt-5.4-mini: 0.75 + 4.50 + 0.75 + 0.075 = 6.075 (suffix beats the base family)
        assert!((super::compute_cost(&make("gpt-5.4-mini")) - 6.075).abs() < 1e-9);
        // gpt-5.4-nano: 0.20 + 1.25 + 0.20 + 0.02 = 1.67
        assert!((super::compute_cost(&make("gpt-5.4-nano")) - 1.67).abs() < 1e-9);
        // gpt-5.5: 5 + 30 + 5 + 0.50 = 40.50
        assert!((super::compute_cost(&make("gpt-5.5")) - 40.50).abs() < 1e-9);
        // Gemini 2.5 Pro: 1.25 + 10 + 1.25 + 0.125 = 12.625
        assert!((super::compute_cost(&make("gemini-2.5-pro")) - 12.625).abs() < 1e-9);
        // Gemini 2.5 Flash: 0.30 + 2.50 + 0.30 + 0.03 = 3.13
        assert!((super::compute_cost(&make("gemini-2.5-flash")) - 3.13).abs() < 1e-9);
        // Gemini 2.5 Flash-Lite: 0.10 + 0.40 + 0.10 + 0.01 = 0.61
        assert!((super::compute_cost(&make("gemini-2.5-flash-lite")) - 0.61).abs() < 1e-9);
        // Local / open-weight models are free.
        assert_eq!(super::compute_cost(&make("llama-3.3-70b")), 0.0);
        assert_eq!(super::compute_cost(&make("qwen2.5-coder")), 0.0);
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

    #[test]
    fn latest_activity_per_pane_keeps_newest_run_idle_state() {
        // activity.log is append-only oldest-first; a later line for a pane supersedes earlier
        // ones, and the result is newest-pane-first. `ts \t pane \t state` lines; only run/idle
        // states survive, and malformed/short/unknown-state lines are dropped (#1184).
        let log = concat!(
            "100\tp1\trun\n",          // p1 opens a turn
            "150\tp2\trun\n",          // p2 opens a turn
            "bad line with no tabs\n", // dropped: too few fields
            "200\tp1\tidle\n",         // p1's turn closes — supersedes its run
            "250\tp3\tbogus\n",        // dropped: unknown state
            "260\t\trun\n",            // dropped: empty pane
            "notanumber\tp4\trun\n",   // dropped: non-numeric ts
            "300\tp1\trun\n",          // p1 reopens — newest line for p1
        );
        let rows = super::latest_activity_per_pane(log);
        // p1 (latest, ts300, run) first; then p2. p3/p4 dropped.
        let states: Vec<(&str, &str, u64)> =
            rows.iter().map(|(p, s, at)| (p.as_str(), s.as_str(), *at)).collect();
        assert_eq!(states, vec![("p1", "run", 300), ("p2", "run", 150)], "newest line first; bad lines dropped");
    }

    /// The status-dot gating contract (#1184): a pane whose latest event is `run` has its turn
    /// OPEN, so the silence timer must NOT idle it. `idle`, or no activity at all, leaves the
    /// silence timer authoritative (no regression for non-bash / never-launched panes).
    #[test]
    fn read_pane_activity_serializes_run_as_turn_open() {
        // Round-trip the parser → struct mapping the command performs, so the frontend keys it right.
        let log = "100\tt0p1\trun\n200\tt0p2\tidle\n";
        let rows: Vec<super::PaneActivity> = super::latest_activity_per_pane(log)
            .into_iter()
            .map(|(pane, state, at)| super::PaneActivity { pane, state, at })
            .collect();
        let p1 = rows.iter().find(|r| r.pane == "t0p1").unwrap();
        assert_eq!(p1.state, "run", "an open turn reads as run (gates the silence timer)");
        let p2 = rows.iter().find(|r| r.pane == "t0p2").unwrap();
        assert_eq!(p2.state, "idle", "a closed turn reads as idle (silence timer stays authoritative)");
    }

    #[test]
    fn done_panes_dedupes_and_drops_malformed() {
        // done.log is `ts \t pane` per line; the result is the deduped pane set, newest line first.
        // Short/blank lines and empty pane fields are dropped (#1379).
        let log = concat!(
            "100\tproj:api\n",
            "150\tproj:web\n",
            "noTabHere\n",      // dropped: too few fields
            "200\tproj:api\n",  // p:api seen again — newer line wins for ordering
            "250\t\n",          // dropped: empty pane
        );
        let panes = super::done_panes(log);
        assert_eq!(panes, vec!["proj:api".to_string(), "proj:web".to_string()], "newest first; bad lines dropped");
        assert_eq!(super::done_panes(""), Vec::<String>::new(), "empty log ⇒ no panes");
    }
}

