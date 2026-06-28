//! Minimal MCP client over stdio JSON-RPC 2.0 (#1078 P3) — lets bsc-agent use MCP server tools
//! like Claude Code does. Servers come from `$BSC_AGENT_MCP` (a JSON array of [`McpServerCfg`]);
//! each is spawned, handshaked (`initialize` → `notifications/initialized`), its tools listed, and
//! every tool exposed to the agent loop as an `mcp__<server>__<tool>` [`Tool`] whose executor calls
//! `tools/call`. The request-building / response-parsing core is pure + unit-tested; the transport
//! is newline-delimited JSON on the child's stdin/stdout.

use crate::agent::Tool;
use llm::ToolDef;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

/// One MCP server entry (matches the `$BSC_AGENT_MCP` JSON the app passes).
#[derive(serde::Deserialize)]
pub struct McpServerCfg {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

/// How long to wait for an MCP server's `initialize` + `tools/list` handshake before giving up and
/// skipping it. Bounds the per-server startup so one wedged server can't hang the agent launch.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

pub struct McpClient {
    // Held to keep the child process alive — dropping it kills the server.
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

// ── pure JSON-RPC builders / parsers (unit-tested without a process) ─────────────

fn build_request(id: i64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

fn build_initialize(id: i64) -> Value {
    build_request(
        id,
        "initialize",
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "bsc-agent", "version": env!("CARGO_PKG_VERSION") }
        }),
    )
}

fn build_initialized() -> Value {
    // A notification — no `id`.
    json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
}

fn build_tools_list(id: i64) -> Value {
    build_request(id, "tools/list", json!({}))
}

fn build_tools_call(id: i64, name: &str, args: &Value) -> Value {
    build_request(id, "tools/call", json!({ "name": name, "arguments": args }))
}

/// `(tool_name, description, input_schema)` for each tool in a `tools/list` response.
fn parse_tools_list(resp: &Value) -> Result<Vec<(String, String, Value)>, String> {
    let tools = resp
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .ok_or("tools/list: no result.tools array")?;
    Ok(tools
        .iter()
        .map(|t| {
            let name = t.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string();
            let desc = t.get("description").and_then(|d| d.as_str()).unwrap_or_default().to_string();
            let schema = t.get("inputSchema").cloned().unwrap_or_else(|| json!({ "type": "object" }));
            (name, desc, schema)
        })
        .collect())
}

/// Concatenate the `type:"text"` parts of a `tools/call` result; `isError:true` ⇒ `Err(text)`.
fn parse_tool_result(resp: &Value) -> Result<String, String> {
    let result = resp.get("result").ok_or("tools/call: no result")?;
    let text = result
        .get("content")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    if result.get("isError").and_then(|e| e.as_bool()) == Some(true) {
        Err(text)
    } else {
        Ok(text)
    }
}

// ── transport ───────────────────────────────────────────────────────────────────

impl McpClient {
    fn next_id(&mut self) -> i64 {
        self.next_id += 1;
        self.next_id
    }

    async fn write_msg(&mut self, msg: &Value) -> Result<(), String> {
        let line = format!("{}\n", serde_json::to_string(msg).map_err(|e| e.to_string())?);
        self.stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        self.stdin.flush().await.map_err(|e| e.to_string())
    }

    /// Send a request and read newline-delimited responses until the one matching `id`
    /// (skipping notifications / other ids); a JSON-RPC `error` member surfaces as `Err`.
    async fn request(&mut self, msg: &Value, id: i64) -> Result<Value, String> {
        self.write_msg(msg).await?;
        loop {
            let mut buf = String::new();
            let n = self.stdout.read_line(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("mcp server closed stdout".into());
            }
            let v: Value = match serde_json::from_str(buf.trim()) {
                Ok(v) => v,
                Err(_) => continue, // ignore non-JSON / partial noise
            };
            if v.get("id").and_then(|i| i.as_i64()) == Some(id) {
                if let Some(err) = v.get("error") {
                    let m = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown");
                    return Err(format!("mcp error: {m}"));
                }
                return Ok(v);
            }
        }
    }

    async fn call_tool(&mut self, name: &str, args: &Value) -> Result<String, String> {
        let id = self.next_id();
        let resp = self.request(&build_tools_call(id, name, args), id).await?;
        parse_tool_result(&resp)
    }
}

/// Spawn + handshake an MCP server and return the shared client plus its tools (namespaced
/// `mcp__<server>__<tool>`). The caller must keep the returned client alive for the session.
pub async fn connect(cfg: &McpServerCfg) -> Result<(Arc<Mutex<McpClient>>, Vec<Tool>), String> {
    let mut cmd = Command::new(&cfg.command);
    cmd.args(&cfg.args);
    for (k, v) in &cfg.env {
        cmd.env(k, v);
    }
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("spawn {}: {e}", cfg.command))?;
    let stdin = child.stdin.take().ok_or("mcp: no stdin")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("mcp: no stdout")?);
    let mut client = McpClient { _child: child, stdin, stdout, next_id: 0 };

    // Handshake, then list tools — BOUNDED by a timeout. A server that spawns but never completes
    // the JSON-RPC handshake (wrong binary, wedged startup, waiting on stdin) would otherwise block
    // `connect().await` forever, hanging the whole bsc-agent launch before any model call. On timeout
    // we drop the client (killing the child) and return an error the caller logs + skips, exactly
    // like a spawn failure — a misbehaving server degrades to "not connected", never a hang.
    let handshake = async {
        let id = client.next_id();
        client.request(&build_initialize(id), id).await?;
        client.write_msg(&build_initialized()).await?;
        let id = client.next_id();
        let resp = client.request(&build_tools_list(id), id).await?;
        parse_tools_list(&resp)
    };
    let listed = match tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake).await {
        Ok(result) => result?,
        Err(_) => return Err(format!(
            "{} handshake timed out after {}s", cfg.command, HANDSHAKE_TIMEOUT.as_secs(),
        )),
    };

    let shared = Arc::new(Mutex::new(client));
    let tools = listed
        .into_iter()
        .map(|(name, description, schema)| {
            let client = shared.clone();
            let tool_name = name.clone();
            Tool {
                def: ToolDef { name: format!("mcp__{}__{}", cfg.name, name), description, schema },
                // The agent's ToolFn is sync but tools/call is async I/O — bridge on the ambient
                // multi-thread runtime via `block_on_tool` (see its "Runtime bridges" note; the
                // executor only runs from the agent loop on that runtime).
                run: Box::new(move |args: &Value| {
                    let args = args.clone();
                    crate::agent::block_on_tool(async {
                        client.lock().await.call_tool(&tool_name, &args).await
                    })
                }),
            }
        })
        .collect();
    Ok((shared, tools))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_initialize_has_jsonrpc_shape() {
        let v = build_initialize(1);
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 1);
        assert_eq!(v["method"], "initialize");
        assert_eq!(v["params"]["protocolVersion"], "2024-11-05");
        assert_eq!(v["params"]["clientInfo"]["name"], "bsc-agent");
    }

    #[test]
    fn build_initialized_is_a_notification() {
        let v = build_initialized();
        assert_eq!(v["method"], "notifications/initialized");
        assert!(v.get("id").is_none());
    }

    #[test]
    fn build_tools_call_carries_name_and_arguments() {
        let v = build_tools_call(7, "search", &json!({"q": "hi"}));
        assert_eq!(v["method"], "tools/call");
        assert_eq!(v["id"], 7);
        assert_eq!(v["params"]["name"], "search");
        assert_eq!(v["params"]["arguments"]["q"], "hi");
    }

    #[test]
    fn parse_tools_list_maps_entries() {
        let resp = json!({"result": {"tools": [
            {"name": "search", "description": "find things", "inputSchema": {"type": "object"}},
            {"name": "bare"}
        ]}});
        let got = parse_tools_list(&resp).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].0, "search");
        assert_eq!(got[0].1, "find things");
        // missing description/schema default cleanly
        assert_eq!(got[1].0, "bare");
        assert_eq!(got[1].1, "");
        assert_eq!(got[1].2, json!({"type": "object"}));
    }

    #[test]
    fn parse_tools_list_errors_without_tools_array() {
        assert!(parse_tools_list(&json!({"result": {}})).is_err());
    }

    #[test]
    fn parse_tool_result_concatenates_text_parts() {
        let resp = json!({"result": {"content": [
            {"type": "text", "text": "a"},
            {"type": "image", "data": "..."},
            {"type": "text", "text": "b"}
        ]}});
        assert_eq!(parse_tool_result(&resp).unwrap(), "a\nb");
    }

    #[test]
    fn parse_tool_result_is_error_returns_err() {
        let resp = json!({"result": {"isError": true, "content": [{"type": "text", "text": "boom"}]}});
        assert_eq!(parse_tool_result(&resp), Err("boom".to_string()));
    }

    #[test]
    fn cfg_deserializes_with_defaulted_args_and_env() {
        let c: McpServerCfg = serde_json::from_str(r#"{"name":"fs","command":"mcp-fs"}"#).unwrap();
        assert_eq!(c.name, "fs");
        assert_eq!(c.command, "mcp-fs");
        assert!(c.args.is_empty());
        assert!(c.env.is_empty());
    }
}
