// Transcript → conversation (#934).
//
// The live planning session is projected to a paired phone as structured `plan_state.messages`.
// The planner is a PTY running `claude`, so the structured conversation lives ONLY in Claude's
// transcript JSONL — the same per-pane transcript the token-usage reader (`bsc logs cost`) reads. We extract
// the user/assistant text turns from it (tool-use/tool-result blocks are dropped — the phone
// renders the conversation, not the tool plumbing).

use crate::bsc_base_dir;

use super::cost::{json_unescape_path, latest_transcript_per_pane};

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
fn parse_transcript_messages(jsonl: &str, limit: usize) -> Vec<crate::mobile::tunnel::PlanMessage> {
    let mut msgs: Vec<crate::mobile::tunnel::PlanMessage> = Vec::new();
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
        msgs.push(crate::mobile::tunnel::PlanMessage { role: role.to_string(), text, at });
    }
    let n = msgs.len();
    if n > limit { msgs.split_off(n - limit) } else { msgs }
}

/// The user/assistant conversation for `pane_id`, from its latest Claude transcript — the
/// newest `limit` turns, or empty when the pane has no transcript yet (#934).
#[tauri::command]
pub(crate) fn read_pane_messages(pane_id: String, limit: usize) -> Vec<crate::mobile::tunnel::PlanMessage> {
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
}
