//! Marketing channel MCP servers for the Marketer (#3146, epic #3145).
//!
//! A marketing **channel is an MCP server** — the epic's single architecture: its tools ARE the
//! channel actions (`send_email` / `post` / `schedule` / `get_metrics`), discovered + assigned to the
//! marketer stream by the normal MCP lifecycle. This crate hosts those servers; the first is the
//! **mock** ([`mock`]), which RECORDS every call to a JSONL log instead of sending — so the whole
//! plan → draft → approve → publish → metrics loop is testable end-to-end with **zero real sends**
//! (the epic's P1 safety cut). Real adapters (Resend email, Bluesky) land later behind the same tool
//! surface.
//!
//! Pure + Tauri-free: the [`Recorder`] takes an injected log path, so the record/metrics behaviour is
//! unit-testable with no env and nothing beyond a temp file.

use serde_json::{json, Value};
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

pub mod mock;

/// The record sink for a mock channel: every tool call is appended to a JSONL log instead of being
/// sent, and `get_metrics` reads it back. One line per call — `{ "tool": <name>, "args": <arguments> }`.
pub struct Recorder {
    log_path: PathBuf,
}

impl Recorder {
    /// A recorder writing to `log_path` (the injectable constructor the tests use).
    pub fn new(log_path: PathBuf) -> Self {
        Self { log_path }
    }

    /// The recorder configured from the environment: `$BSC_CHANNEL_LOG` when set, else
    /// `<temp>/bsc-channel-mock.jsonl`. When the mock is assigned to the marketer stream the app sets
    /// that env (via the server's MCP `env`) so the log lands where the loop can read it; run
    /// standalone it falls back to a temp file.
    pub fn from_env() -> Self {
        let log_path = std::env::var("BSC_CHANNEL_LOG")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("bsc-channel-mock.jsonl"));
        Self::new(log_path)
    }

    /// Append one recorded call and return its receipt —
    /// `{ id, status: "recorded", channel: "mock", tool }`. The id is `<tool>-<n>` where n is the
    /// call's 1-based position among that tool's records — a stable, inspectable handle with no clock
    /// dependency, so the loop and the tests read the same shape.
    pub fn record(&self, tool: &str, args: &Value) -> Result<Value, String> {
        if let Some(dir) = self.log_path.parent() {
            create_dir_all(dir).map_err(|e| format!("channel log dir: {e}"))?;
        }
        let line = json!({ "tool": tool, "args": args });
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
            .map_err(|e| format!("channel log open: {e}"))?;
        writeln!(f, "{line}").map_err(|e| format!("channel log write: {e}"))?;
        let n = self.entries()?.iter().filter(|e| e["tool"] == json!(tool)).count();
        Ok(json!({ "id": format!("{tool}-{n}"), "status": "recorded", "channel": "mock", "tool": tool }))
    }

    /// The recorded lines (each `{ tool, args }`), oldest first; empty when nothing has been sent (a
    /// missing log file is "nothing sent yet", not an error).
    fn entries(&self) -> Result<Vec<Value>, String> {
        match std::fs::read_to_string(&self.log_path) {
            Ok(text) => Ok(text
                .lines()
                .filter(|l| !l.trim().is_empty())
                .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                .collect()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(format!("channel log read: {e}")),
        }
    }

    /// Metrics over the record log — `{ total, by_tool: { <tool>: <count>, … } }`. This read-back is
    /// what the marketer's analytics step (P4) consumes, standing in for real channel metrics.
    pub fn metrics(&self) -> Result<Value, String> {
        let entries = self.entries()?;
        let mut by_tool = serde_json::Map::new();
        for e in &entries {
            if let Some(t) = e["tool"].as_str() {
                let cur = by_tool.get(t).and_then(Value::as_u64).unwrap_or(0);
                by_tool.insert(t.to_string(), json!(cur + 1));
            }
        }
        Ok(json!({ "total": entries.len(), "by_tool": by_tool }))
    }
}
