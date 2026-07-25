//! The mock channel MCP server (#3146) — the Marketer's first channel, recording every call instead
//! of sending so the outbound loop is testable with zero real deliveries. Behind the shared
//! [`mcp_rpc::ToolServer`] seam: this module supplies the tool catalog + dispatch; the JSON-RPC
//! handshake, `tools/call` wrapping, and stdio run-loop live in `mcp_rpc`.

use crate::Recorder;
use mcp_rpc::arg_str;
use serde_json::{json, Value};

/// The advertised server name (returned in the `initialize` handshake; the `bsc mcp channel-mock` id).
const SERVER_NAME: &str = "channel-mock";

/// The channel tool catalog — `{ name, description, inputSchema }` for the four channel actions. Pure;
/// consulted with no live state (the handshake + `tools/list` work before any send).
pub fn tool_schemas() -> Value {
    json!([
        {
            "name": "send_email",
            "description": "Record an email send (MOCK — no real delivery). Returns a receipt id.",
            "inputSchema": { "type": "object", "required": ["to", "subject", "body"], "properties": {
                "to": { "type": "string", "description": "recipient address" },
                "subject": { "type": "string" },
                "body": { "type": "string", "description": "the email body (HTML or text)" }
            } }
        },
        {
            "name": "post",
            "description": "Record a social post (MOCK — no real publish). Returns a receipt id.",
            "inputSchema": { "type": "object", "required": ["text"], "properties": {
                "text": { "type": "string" },
                "channel": { "type": "string", "description": "optional target channel handle" }
            } }
        },
        {
            "name": "schedule",
            "description": "Record a send/post scheduled for a future time (MOCK). Returns a receipt id.",
            "inputSchema": { "type": "object", "required": ["when", "payload"], "properties": {
                "when": { "type": "string", "description": "ISO-8601 time to send at" },
                "payload": { "type": "string", "description": "the content to send" },
                "channel": { "type": "string" }
            } }
        },
        {
            "name": "get_metrics",
            "description": "Read back recorded-call metrics: total sends + per-tool counts.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

/// Run one channel tool against the recorder. Required-argument validation reuses the shared
/// `arg_str`; an unknown tool is an `Err` (the core turns it into an `isError` payload).
pub fn call_tool(rec: &Recorder, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "send_email" => {
            arg_str(args, "to")?;
            arg_str(args, "subject")?;
            arg_str(args, "body")?;
            rec.record("send_email", args)
        }
        "post" => {
            arg_str(args, "text")?;
            rec.record("post", args)
        }
        "schedule" => {
            arg_str(args, "when")?;
            arg_str(args, "payload")?;
            rec.record("schedule", args)
        }
        "get_metrics" => rec.metrics(),
        other => Err(format!("unknown tool '{other}'")),
    }
}

/// The mock channel MCP server: a [`Recorder`] behind the shared [`mcp_rpc::ToolServer`] seam. Build
/// it with [`Server::from_env`], then drive the stdio loop via [`mcp_rpc::run_stdio_server`].
pub struct Server {
    rec: Recorder,
}

impl Server {
    /// Construct the server, reading the record-log path from the environment.
    pub fn from_env() -> Result<Self, String> {
        Ok(Self { rec: Recorder::from_env() })
    }
}

impl mcp_rpc::ToolServer for Server {
    fn server_name(&self) -> &str {
        SERVER_NAME
    }
    fn server_version(&self) -> &str {
        env!("CARGO_PKG_VERSION")
    }
    fn tool_schemas(&self) -> Value {
        tool_schemas()
    }
    fn call_tool(&self, name: &str, args: &Value) -> Result<Value, String> {
        call_tool(&self.rec, name, args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A recorder over a per-test temp log (deleted first so each run starts clean; the tag keeps
    /// parallel tests from sharing a file).
    fn temp_rec(tag: &str) -> Recorder {
        let p = std::env::temp_dir().join(format!("bsc-channel-test-{tag}.jsonl"));
        let _ = std::fs::remove_file(&p);
        Recorder::new(p)
    }

    #[test]
    fn tool_schemas_exposes_the_four_channel_tools() {
        let tools = tool_schemas();
        let tools = tools.as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["send_email", "post", "schedule", "get_metrics"]);
        assert!(tools.iter().all(|t| t["inputSchema"]["type"] == "object"));
    }

    #[test]
    fn send_email_records_a_call_and_returns_a_receipt() {
        let rec = temp_rec("send");
        let r = call_tool(&rec, "send_email", &json!({ "to": "a@b.co", "subject": "hi", "body": "<p>hi</p>" })).unwrap();
        assert_eq!(r["status"], "recorded");
        assert_eq!(r["channel"], "mock");
        assert_eq!(r["id"], "send_email-1");
        // A second send increments the per-tool id.
        let r2 = call_tool(&rec, "send_email", &json!({ "to": "c@d.co", "subject": "hi2", "body": "x" })).unwrap();
        assert_eq!(r2["id"], "send_email-2");
    }

    #[test]
    fn get_metrics_counts_recorded_calls_per_tool() {
        let rec = temp_rec("metrics");
        // Nothing sent yet → zeroes, no error (missing log is "nothing sent").
        assert_eq!(rec.metrics().unwrap(), json!({ "total": 0, "by_tool": {} }));
        call_tool(&rec, "send_email", &json!({ "to": "a@b.co", "subject": "s", "body": "b" })).unwrap();
        call_tool(&rec, "post", &json!({ "text": "gm" })).unwrap();
        call_tool(&rec, "post", &json!({ "text": "gm2" })).unwrap();
        let m = call_tool(&rec, "get_metrics", &json!({})).unwrap();
        assert_eq!(m["total"], 3);
        assert_eq!(m["by_tool"]["send_email"], 1);
        assert_eq!(m["by_tool"]["post"], 2);
    }

    #[test]
    fn missing_required_arg_and_unknown_tool_are_errors() {
        let rec = temp_rec("errs");
        assert!(call_tool(&rec, "send_email", &json!({ "to": "a@b.co" })).is_err()); // no subject/body
        assert!(call_tool(&rec, "post", &json!({})).is_err()); // no text
        assert!(call_tool(&rec, "bogus", &json!({})).is_err()); // unknown tool
        // A failed validation records nothing.
        assert_eq!(rec.metrics().unwrap()["total"], 0);
    }
}
