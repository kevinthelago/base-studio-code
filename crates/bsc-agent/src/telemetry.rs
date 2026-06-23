//! Native telemetry + transcript (epic #1078, P2d). `bsc-agent` emits the SAME
//! contracts the app already reads, so the existing audit view + cost accounting light
//! up unchanged (preserve the contract, swap the producer):
//!   - `audit.log`  TSV: `ts \t pane \t tool_name \t target`        (`$BSC_AUDIT_LOG`)
//!   - `tokens.log` TSV: `ts \t pane \t session_id \t transcript`   (`$BSC_TOKENS_LOG`)
//!   - a transcript JSONL whose assistant lines carry `message.model` + `message.usage`
//!     `{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`
//!     — exactly what `src-tauri/src/tokens.rs` parses.
//!
//! All emission is best-effort (a missing env var ⇒ no-op), like the `bsc-*` hooks.

use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;

#[derive(Default)]
pub struct Telemetry {
    audit_log: Option<String>,
    tokens_log: Option<String>,
    pane: String,
    session_id: String,
    transcript_path: Option<PathBuf>,
}

impl Telemetry {
    /// Disabled telemetry — writes nothing (used by tests / non-instrumented runs).
    #[cfg(test)]
    pub fn disabled() -> Self {
        Telemetry::default()
    }

    /// Test constructor: a token-accounting Telemetry with explicit paths (no env).
    #[cfg(test)]
    pub(crate) fn for_test(tokens_log: Option<String>, transcript_path: Option<PathBuf>) -> Self {
        Telemetry {
            tokens_log,
            transcript_path,
            pane: "t0p1".into(),
            session_id: "test".into(),
            audit_log: None,
        }
    }

    /// Build from the per-session env the app sets in `pty_create`. Audit + token
    /// accounting are independently gated by their log-path vars being present.
    pub fn from_env() -> Self {
        let audit_log = std::env::var("BSC_AUDIT_LOG").ok().filter(|s| !s.is_empty());
        let tokens_log = std::env::var("BSC_TOKENS_LOG").ok().filter(|s| !s.is_empty());
        let pane = std::env::var("BSC_AUDIT_PANE").unwrap_or_else(|_| "?".into());
        let session_id = gen_session_id();
        let transcript_path = tokens_log.as_ref().map(|_| transcript_path_for(&session_id));
        Telemetry { audit_log, tokens_log, pane, session_id, transcript_path }
    }

    /// Append one audit line for an executed tool: `ts \t pane \t tool \t target`.
    pub fn audit(&self, tool_name: &str, args: &Value) {
        let Some(log) = &self.audit_log else { return };
        let line = format!("{}\t{}\t{}\t{}\n", utc_now(), self.pane, tool_name, audit_target(args));
        append(log, &line);
    }

    /// Append one assistant message to the transcript (the schema `tokens.rs` parses).
    pub fn record_assistant(&self, model: &str, usage: &Value) {
        let Some(path) = &self.transcript_path else { return };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let line = serde_json::json!({ "type": "assistant", "message": { "model": model, "usage": usage } });
        append(&path.to_string_lossy(), &format!("{line}\n"));
    }

    /// Record this session in `tokens.log` so the reader finds its transcript. Once per run.
    pub fn finish(&self) {
        let (Some(log), Some(path)) = (&self.tokens_log, &self.transcript_path) else { return };
        let line = format!(
            "{}\t{}\t{}\t{}\n",
            utc_now(),
            self.pane,
            self.session_id,
            path.to_string_lossy()
        );
        append(log, &line);
    }
}

/// The audit target: the first relevant arg field, tabs/newlines stripped, ≤160 chars
/// (mirrors the `bsc-audit` hook; `content` is deliberately excluded).
fn audit_target(args: &Value) -> String {
    for k in ["command", "file_path", "path", "url", "pattern"] {
        if let Some(s) = args.get(k).and_then(|v| v.as_str()) {
            return s.chars().map(|c| if c == '\t' || c == '\n' { ' ' } else { c }).take(160).collect();
        }
    }
    String::new()
}

fn append(path: &str, line: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn base_dir() -> PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join(".base-studio-code")
}

fn transcript_path_for(id: &str) -> PathBuf {
    base_dir().join("agent-sessions").join(format!("{id}.jsonl"))
}

fn gen_session_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("bsc-{nanos}-{}", std::process::id())
}

fn utc_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    epoch_to_iso8601(secs)
}

/// Epoch seconds → `YYYY-MM-DDTHH:MM:SSZ` (UTC), no external crate. Uses Howard
/// Hinnant's civil-from-days algorithm so cost-log timestamps match the `bsc-*`
/// helpers' `date -u +%Y-%m-%dT%H:%M:%SZ` format.
fn epoch_to_iso8601(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_formats_known_epochs() {
        assert_eq!(epoch_to_iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(epoch_to_iso8601(1_700_000_000), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn audit_target_picks_first_field_and_caps() {
        assert_eq!(audit_target(&serde_json::json!({ "command": "ls -la" })), "ls -la");
        assert_eq!(audit_target(&serde_json::json!({ "path": "a\tb\nc" })), "a b c");
        assert_eq!(audit_target(&serde_json::json!({ "content": "secret" })), ""); // content excluded
        let long = "x".repeat(300);
        assert_eq!(audit_target(&serde_json::json!({ "path": long })).chars().count(), 160);
    }

    #[test]
    fn audit_writes_tsv_line() {
        let dir = std::env::temp_dir().join(format!("bsc_p2d_audit_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("audit.log").to_string_lossy().into_owned();
        let t = Telemetry { audit_log: Some(log.clone()), pane: "t0p1".into(), ..Default::default() };
        t.audit("bash", &serde_json::json!({ "command": "echo hi" }));
        let line = std::fs::read_to_string(&log).unwrap();
        let cols: Vec<&str> = line.trim_end().split('\t').collect();
        assert_eq!(cols.len(), 4);
        assert_eq!(cols[1], "t0p1");
        assert_eq!(cols[2], "bash");
        assert_eq!(cols[3], "echo hi");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn transcript_and_tokens_log_match_the_reader_schema() {
        let dir = std::env::temp_dir().join(format!("bsc_p2d_tx_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tx = dir.join("session.jsonl");
        let tokens = dir.join("tokens.log").to_string_lossy().into_owned();
        let t = Telemetry {
            tokens_log: Some(tokens.clone()),
            pane: "t0p1".into(),
            session_id: "sess-1".into(),
            transcript_path: Some(tx.clone()),
            ..Default::default()
        };
        let usage = serde_json::json!({
            "input_tokens": 10, "output_tokens": 4,
            "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0
        });
        t.record_assistant("claude-sonnet-4-6", &usage);
        t.finish();

        // Transcript line parses exactly like tokens.rs expects.
        let tl = std::fs::read_to_string(&tx).unwrap();
        let v: Value = serde_json::from_str(tl.trim()).unwrap();
        assert_eq!(v["message"]["model"], "claude-sonnet-4-6");
        assert_eq!(v["message"]["usage"]["input_tokens"], 10);
        assert_eq!(v["message"]["usage"]["output_tokens"], 4);
        assert!(v["message"]["usage"].get("cache_creation_input_tokens").is_some());
        assert!(v["message"]["usage"].get("cache_read_input_tokens").is_some());

        // tokens.log: ts \t pane \t session \t transcript_path
        let kl = std::fs::read_to_string(&tokens).unwrap();
        let cols: Vec<&str> = kl.trim_end().split('\t').collect();
        assert_eq!(cols.len(), 4);
        assert_eq!(cols[1], "t0p1");
        assert_eq!(cols[2], "sess-1");
        assert_eq!(cols[3], tx.to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disabled_telemetry_writes_nothing() {
        // No paths set ⇒ all ops are no-ops and must not panic.
        let t = Telemetry::disabled();
        t.audit("bash", &serde_json::json!({ "command": "x" }));
        t.record_assistant("m", &serde_json::json!({}));
        t.finish();
    }
}
