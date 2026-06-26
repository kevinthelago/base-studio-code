// Per-pane token usage + dollar cost from Claude Code transcripts (#416).

use crate::bsc_base_dir;

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
pub(super) fn latest_per_key<R>(
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
pub(super) fn latest_transcript_per_pane(log_text: &str) -> Vec<(String, String, String)> {
    latest_per_key(log_text, 4, |f| {
        let (pane, sid, tp) = (f[1].to_string(), f[2].to_string(), f[3].to_string());
        if pane.is_empty() || tp.is_empty() {
            return None;
        }
        Some((pane.clone(), (pane, sid, tp)))
    })
}

/// Read per-pane token + cost accounting (#416). Delegates the whole pricing engine — the price
/// table, the transcript-usage parser, and the cost math — to the canonical implementation in
/// `crates/logs` (`bsc_logs::cost::all_costs`, #1686), then maps each [`bsc_logs::cost::Cost`] to the
/// frontend [`TokenUsage`]. `all_costs` already takes the latest transcript per pane and skips
/// panes with a missing/unreadable transcript or no usage (newest pane first), so this is a thin
/// shape adapter bounded to `limit` records.
///
/// `bsc_logs::cost::Cost` keys a session by its pane but doesn't carry the `session_id`, so we recover
/// the `pane → session_id` map from the same `tokens.log` to keep the frontend record complete.
/// The serde field names below are a frontend contract — keep them byte-identical.
#[tauri::command]
pub(crate) fn read_token_usage(limit: usize) -> Vec<TokenUsage> {
    use std::collections::HashMap;
    let dir = bsc_base_dir();
    let log_text = std::fs::read_to_string(dir.join("tokens.log")).unwrap_or_default();
    let session_ids: HashMap<String, String> = latest_transcript_per_pane(&log_text)
        .into_iter()
        .map(|(pane, sid, _)| (pane, sid))
        .collect();
    bsc_logs::cost::all_costs(&dir)
        .into_iter()
        .take(limit)
        .map(|c| TokenUsage {
            session_id: session_ids.get(&c.session).cloned().unwrap_or_default(),
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
    // The price table + the transcript-usage parser + the cost math now live in `crates/logs`
    // (`logs::cost`) and are tested there (#1686). This module keeps only the desktop-specific
    // log-reader the other tokens submodules share (`latest_transcript_per_pane`, which carries
    // the `session_id` the logs engine doesn't).
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
