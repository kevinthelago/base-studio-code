// Per-pane transcript-log parsing helpers (#416): the shared `tokens.log` readers still used by the
// `messages` (transcript→conversation) command and `console/shell_rc`. The per-pane token-usage READ
// itself moved to the `bsc logs cost --full` CLI over the `bsc` bridge (#2144).

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
