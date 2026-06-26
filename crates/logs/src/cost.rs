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

/// Price table keyed by a model-name substring (USD per million tokens). Mirrors
/// `observability/tokens.rs::model_pricing` — keep the two in sync (a later slice folds the
/// desktop reader onto this engine, collapsing the duplication). List prices as of 2026-06.
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
}
