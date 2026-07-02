//! Per-session token + cost accounting (#1607), ported verbatim from
//! `src-tauri/src/observability/tokens.rs` so the `bsc-logs` CLI and the desktop app price
//! sessions identically. Claude Code hooks don't expose token usage, so the only per-session
//! source is the session transcript (JSONL): `bsc-tokens` records `pane → session → transcript`
//! to `tokens.log`; we take the latest transcript per pane, sum its per-message `usage`, and
//! price it. Pure (reads files; no Tauri).

use std::collections::HashMap;
use std::path::Path;

/// Per-session token + cost rollup.
#[derive(serde::Serialize, Debug, Clone, PartialEq, Default)]
pub struct Cost {
    pub session: String,
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_creation: u64,
    pub cache_read: u64,
    pub cost_usd: f64,
}

/// Dollars-per-million-token list prices for one model family.
struct Pricing {
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

/// Open-weight families the app runs through the *local* provider — self-hosted, so $0.
const LOCAL_FAMILIES: [&str; 9] =
    ["llama", "qwen", "mistral", "mixtral", "gemma", "phi", "deepseek", "codestral", "ollama"];

/// Price table keyed by a model-name substring (USD per million tokens). The ONE price table for
/// the whole app: the desktop token reader (`observability::tokens::cost::read_token_usage`)
/// delegates here via `all_costs` (#1686), so rates live in this single place. List prices as of
/// 2026-06. Matched against the lowercased model id, most-specific family first; local/open-weight
/// models are free ($0); an unrecognized *hosted* model falls back to Sonnet (never $0 for a paid
/// model).
fn model_pricing(model: &str) -> Pricing {
    let m = model.to_ascii_lowercase();
    // Anthropic (Claude) — cache write = 1.25× input, cache read = 0.10× input.
    if m.contains("opus") {
        return Pricing { input: 5.0, output: 25.0, cache_write: 6.25, cache_read: 0.50 };
    }
    if m.contains("haiku") {
        return Pricing { input: 1.0, output: 5.0, cache_write: 1.25, cache_read: 0.10 };
    }
    if m.contains("sonnet") {
        return Pricing { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.30 };
    }
    // OpenAI (GPT) — size suffixes take precedence over the family.
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
        return Pricing { input: 2.50, output: 15.0, cache_write: 2.50, cache_read: 0.25 };
    }
    // Google (Gemini).
    if m.contains("gemini") {
        if m.contains("flash-lite") {
            return Pricing { input: 0.10, output: 0.40, cache_write: 0.10, cache_read: 0.01 };
        }
        if m.contains("flash") {
            return Pricing { input: 0.30, output: 2.50, cache_write: 0.30, cache_read: 0.03 };
        }
        return Pricing { input: 1.25, output: 10.0, cache_write: 1.25, cache_read: 0.125 };
    }
    // Local / open-weight — self-hosted, free.
    if LOCAL_FAMILIES.iter().any(|f| m.contains(f)) {
        return Pricing { input: 0.0, output: 0.0, cache_write: 0.0, cache_read: 0.0 };
    }
    // Unknown hosted model → Sonnet (conservative; never $0 for a paid model).
    Pricing { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.30 }
}

#[derive(Default)]
struct Totals {
    model: String,
    input: u64,
    output: u64,
    cache_creation: u64,
    cache_read: u64,
}
impl Totals {
    fn is_empty(&self) -> bool {
        self.input == 0 && self.output == 0 && self.cache_creation == 0 && self.cache_read == 0
    }
}

/// Sum the per-message `usage` across every assistant line of a transcript (JSONL). Usage is
/// per-message (not cumulative). Tolerant: malformed lines / lines without `usage` are skipped.
fn parse_transcript_usage(jsonl: &str) -> Totals {
    let mut t = Totals::default();
    for line in jsonl.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let usage = &v["message"]["usage"];
        if !usage.is_object() {
            continue;
        }
        t.input += usage["input_tokens"].as_u64().unwrap_or(0);
        t.output += usage["output_tokens"].as_u64().unwrap_or(0);
        t.cache_creation += usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
        t.cache_read += usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
        if let Some(model) = v["message"]["model"].as_str() {
            if !model.is_empty() {
                t.model = model.to_string();
            }
        }
    }
    t
}

fn compute_cost(t: &Totals) -> f64 {
    let p = model_pricing(&t.model);
    (t.input as f64 * p.input
        + t.output as f64 * p.output
        + t.cache_creation as f64 * p.cache_write
        + t.cache_read as f64 * p.cache_read)
        / 1_000_000.0
}

/// Reverse the escapes a JSON string can carry for a filesystem path (`tokens.log` stores the
/// hook's `transcript_path` verbatim): `\\` → `\` (Windows), `\/` → `/`.
fn json_unescape_path(p: &str) -> String {
    p.replace("\\\\", "\\").replace("\\/", "/")
}

/// The latest `(pane, transcript_path)` per pane from a `tokens.log` body (a later line for a
/// pane supersedes earlier ones — a resumed session keeps the same accumulating transcript).
fn latest_transcript_per_pane(log_text: &str) -> Vec<(usize, String, String)> {
    let mut latest: HashMap<String, (usize, String)> = HashMap::new();
    for (i, line) in log_text.lines().enumerate() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 4 {
            continue;
        }
        let (pane, tp) = (f[1].to_string(), f[3].to_string());
        if pane.is_empty() || tp.is_empty() {
            continue;
        }
        latest.insert(pane, (i, tp));
    }
    let mut rows: Vec<(usize, String, String)> =
        latest.into_iter().map(|(pane, (ord, tp))| (ord, pane, tp)).collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r.0)); // newest line first
    rows
}

/// Cost for every session with a transcript, newest pane first. Reads `tokens.log` under `dir`.
pub fn all_costs(dir: &Path) -> Vec<Cost> {
    let text = std::fs::read_to_string(dir.join("tokens.log")).unwrap_or_default();
    let mut out = Vec::new();
    for (_, pane, tp) in latest_transcript_per_pane(&text) {
        let jsonl = match std::fs::read_to_string(json_unescape_path(&tp)) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let t = parse_transcript_usage(&jsonl);
        if t.is_empty() {
            continue;
        }
        out.push(Cost {
            session: pane,
            cost_usd: compute_cost(&t),
            model: t.model,
            input: t.input,
            output: t.output,
            cache_creation: t.cache_creation,
            cache_read: t.cache_read,
        });
    }
    out
}

/// Cost for one session (pane), or `None` if it has no priced usage.
pub fn cost_for_session(dir: &Path, session: &str) -> Option<Cost> {
    all_costs(dir).into_iter().find(|c| c.session == session)
}

/// The latest `session_id` per pane from `tokens.log` (`ts·pane·session·transcript`). [`Cost`] keys a
/// session by its pane but doesn't carry the `session_id`, so this recovers the `pane → session_id`
/// map the desktop token-usage record ([`Usage`]) needs to stay complete. A later line for a pane
/// supersedes earlier ones (a resumed session keeps its accumulating transcript).
pub fn session_ids(dir: &Path) -> HashMap<String, String> {
    let text = std::fs::read_to_string(dir.join("tokens.log")).unwrap_or_default();
    let mut map = HashMap::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 4 {
            continue;
        }
        let (pane, sid, tp) = (f[1], f[2], f[3]);
        if pane.is_empty() || tp.is_empty() {
            continue;
        }
        map.insert(pane.to_string(), sid.to_string()); // last line wins
    }
    map
}

/// The desktop per-pane token + cost record (#416): the `bsc logs cost --full` shape the app's
/// `read_token_usage` command returned. Same numbers as [`Cost`], but keyed by `pane`, carrying the
/// `session_id` (recovered from `tokens.log`), and using the `*_tokens` field names the frontend
/// `PaneTokenUsage` type expects. The serde field names are a frontend contract — keep them exact.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Usage {
    pub pane: String,
    pub session_id: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub cost_usd: f64,
}

/// Per-pane token usage for the desktop (#416 / #2144), newest pane first, bounded to `limit`.
/// Delegates the pricing to [`all_costs`] and enriches each row with its `session_id`.
pub fn usage(dir: &Path, limit: usize) -> Vec<Usage> {
    let sids = session_ids(dir);
    all_costs(dir)
        .into_iter()
        .take(limit)
        .map(|c| Usage {
            session_id: sids.get(&c.session).cloned().unwrap_or_default(),
            pane: c.session,
            model: c.model,
            input_tokens: c.input,
            output_tokens: c.output,
            cache_creation_tokens: c.cache_creation,
            cache_read_tokens: c.cache_read,
            cost_usd: c.cost_usd,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_by_model_family() {
        // 1M output tokens: sonnet $15, opus $25, a local model $0, unknown hosted → sonnet.
        let mk = |model: &str| Totals { model: model.into(), output: 1_000_000, ..Default::default() };
        assert!((compute_cost(&mk("claude-sonnet-4-6")) - 15.0).abs() < 1e-9);
        assert!((compute_cost(&mk("claude-opus-4-8")) - 25.0).abs() < 1e-9);
        assert!((compute_cost(&mk("llama-3.1-70b")) - 0.0).abs() < 1e-9);
        assert!((compute_cost(&mk("some-unknown-model")) - 15.0).abs() < 1e-9); // → sonnet
    }

    #[test]
    fn compute_cost_prices_each_model_family() {
        // Cost = sum(tokens * per-million-rate) / 1e6. Sonnet is the fallback for unknown/empty
        // models so they never price as $0. 1M tokens of EACH kind makes the result equal the sum
        // of that family's four rates directly. (Ported from the desktop reader, #1686.)
        let make = |model: &str| Totals {
            model: model.to_string(),
            input: 1_000_000,
            output: 1_000_000,
            cache_creation: 1_000_000,
            cache_read: 1_000_000,
        };
        // Sonnet: 3 + 15 + 3.75 + 0.30 = 22.05
        assert!((compute_cost(&make("claude-sonnet-4-6")) - 22.05).abs() < 1e-9);
        // Unknown / empty HOSTED model falls back to Sonnet pricing.
        assert!((compute_cost(&make("")) - 22.05).abs() < 1e-9);
        assert!((compute_cost(&make("some-future-hosted-model")) - 22.05).abs() < 1e-9);
        // Opus 4.8: 5 + 25 + 6.25 + 0.50 = 36.75
        assert!((compute_cost(&make("claude-opus-4-8")) - 36.75).abs() < 1e-9);
        // Haiku: 1 + 5 + 1.25 + 0.10 = 7.35
        assert!((compute_cost(&make("claude-haiku-4-5")) - 7.35).abs() < 1e-9);
        // OpenAI gpt-5.4 base: 2.50 + 15 + 2.50 + 0.25 = 20.25
        assert!((compute_cost(&make("gpt-5.4")) - 20.25).abs() < 1e-9);
        // gpt-5.4-mini: 0.75 + 4.50 + 0.75 + 0.075 = 6.075 (suffix beats the base family)
        assert!((compute_cost(&make("gpt-5.4-mini")) - 6.075).abs() < 1e-9);
        // gpt-5.4-nano: 0.20 + 1.25 + 0.20 + 0.02 = 1.67
        assert!((compute_cost(&make("gpt-5.4-nano")) - 1.67).abs() < 1e-9);
        // gpt-5.5: 5 + 30 + 5 + 0.50 = 40.50
        assert!((compute_cost(&make("gpt-5.5")) - 40.50).abs() < 1e-9);
        // Gemini 2.5 Pro: 1.25 + 10 + 1.25 + 0.125 = 12.625
        assert!((compute_cost(&make("gemini-2.5-pro")) - 12.625).abs() < 1e-9);
        // Gemini 2.5 Flash: 0.30 + 2.50 + 0.30 + 0.03 = 3.13
        assert!((compute_cost(&make("gemini-2.5-flash")) - 3.13).abs() < 1e-9);
        // Gemini 2.5 Flash-Lite: 0.10 + 0.40 + 0.10 + 0.01 = 0.61
        assert!((compute_cost(&make("gemini-2.5-flash-lite")) - 0.61).abs() < 1e-9);
        // Local / open-weight models are free.
        assert_eq!(compute_cost(&make("llama-3.3-70b")), 0.0);
        assert_eq!(compute_cost(&make("qwen2.5-coder")), 0.0);
        // A realistic small total prices to a small positive number.
        let small = Totals { model: "claude-sonnet-4-6".into(), input: 10, output: 20, cache_creation: 100, cache_read: 1000 };
        let c = compute_cost(&small);
        assert!(c > 0.0 && c < 0.01, "got {c}");
    }

    #[test]
    fn sums_usage_and_keeps_last_model() {
        let jsonl = concat!(
            r#"{"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":100}}}"#, "\n",
            "garbage not json\n",
            r#"{"message":{"model":"claude-opus-4-8","usage":{"input_tokens":5,"output_tokens":3,"cache_creation_input_tokens":50}}}"#, "\n",
        );
        let t = parse_transcript_usage(jsonl);
        assert_eq!((t.input, t.output, t.cache_creation, t.cache_read), (15, 5, 50, 100));
        assert_eq!(t.model, "claude-opus-4-8"); // last non-empty model wins
    }

    #[test]
    fn all_costs_reads_latest_transcript_per_pane() {
        let dir = std::env::temp_dir().join(format!("bsc-logs-cost-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tp = dir.join("t.jsonl");
        std::fs::write(&tp, r#"{"message":{"model":"claude-sonnet-4-6","usage":{"output_tokens":1000000}}}"#).unwrap();
        std::fs::write(
            dir.join("tokens.log"),
            format!("2026-06-26T10:00:00Z\tkey:ui\tsid\t{}\n", tp.to_string_lossy().replace('\\', "\\\\")),
        ).unwrap();
        let c = cost_for_session(&dir, "key:ui").unwrap();
        assert_eq!(c.session, "key:ui");
        assert!((c.cost_usd - 15.0).abs() < 1e-9);
        assert!(cost_for_session(&dir, "key:none").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn usage_enriches_cost_with_session_id_and_pane_shape() {
        // `bsc logs cost --full` (#2144): the desktop `read_token_usage` shape — keyed by pane,
        // carrying the session_id from tokens.log, with the `*_tokens` frontend field names.
        let dir = std::env::temp_dir().join(format!("bsc-logs-usage-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tp = dir.join("t.jsonl");
        std::fs::write(&tp, r#"{"message":{"model":"claude-sonnet-4-6","usage":{"output_tokens":1000000}}}"#).unwrap();
        std::fs::write(
            dir.join("tokens.log"),
            format!("2026-06-26T10:00:00Z\tkey:ui\tsid-42\t{}\n", tp.to_string_lossy().replace('\\', "\\\\")),
        ).unwrap();

        let sids = session_ids(&dir);
        assert_eq!(sids.get("key:ui").map(String::as_str), Some("sid-42"));

        let rows = usage(&dir, 64);
        assert_eq!(rows.len(), 1);
        let u = &rows[0];
        assert_eq!((u.pane.as_str(), u.session_id.as_str(), u.model.as_str()), ("key:ui", "sid-42", "claude-sonnet-4-6"));
        assert_eq!(u.output_tokens, 1_000_000);
        assert!((u.cost_usd - 15.0).abs() < 1e-9);
        // `limit` bounds the record count.
        assert!(usage(&dir, 0).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
