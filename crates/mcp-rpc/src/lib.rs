//! Shared stdio MCP server core (#1622) — JSON-RPC 2.0 over newline-delimited stdin/stdout, mirroring
//! the shape the app's MCP *client* speaks (`crates/bsc-agent/src/mcp.rs`): `initialize` →
//! `notifications/initialized` → `tools/list` → `tools/call`, protocol `2024-11-05`.
//!
//! The JSON-RPC plumbing — the request/response builders, the handshake + dispatch ([`handle`]), and
//! the stdin→stdout read-loop ([`run_stdio_server`]) — was ~120 LOC of near-identical code duplicated
//! across the bundled `bsc-research-mcp` and `bsc-compliance-mcp` servers. It lives here once,
//! parameterized by the [`ToolServer`] trait: each server crate supplies its own server name/version,
//! `tool_schemas`, `call_tool`, and crate-specific argument parsers, and the wire protocol is
//! preserved exactly. Only [`run_stdio_server`] touches the outside world; everything else is pure +
//! unit-tested.

use serde_json::{json, Value};
use std::io::{BufRead, Write};

/// The MCP protocol version this core speaks. Echoed back to the client in `initialize` (falling back
/// to the client's requested version), so it doubles as the default when the client omits one.
pub const PROTOCOL_VERSION: &str = "2024-11-05";

/// A native MCP server's tool surface. The shared core owns the JSON-RPC handshake, dispatch, and
/// run-loop; an implementor supplies only the server identity, its tool catalog, and the dispatcher.
///
/// `tool_schemas` is pure (no live state) so the handshake + `tools/list` work without an engine;
/// `call_tool` is where the live state (the engine/store) is consulted.
pub trait ToolServer {
    /// The advertised server name (e.g. `"research"`); returned in the `initialize` handshake.
    fn server_name(&self) -> &str;

    /// The server version — pass `env!("CARGO_PKG_VERSION")` from the owning crate so it tracks that
    /// crate's package version, not this one's.
    fn server_version(&self) -> &str;

    /// The tool schemas advertised via `initialize` + `tools/list` (a JSON array of
    /// `{ name, description, inputSchema }`). Pure; consulted with no live state.
    fn tool_schemas(&self) -> Value;

    /// Run one tool by name, returning its raw result `Value`. The core wraps `Ok` in a `tools/call`
    /// text payload and `Err` in an `isError` payload — both successful JSON-RPC responses. An unknown
    /// tool name should be returned as `Err`.
    fn call_tool(&self, name: &str, args: &Value) -> Result<Value, String>;
}

// ── pure JSON-RPC builders ───────────────────────────────────────────────────

/// A JSON-RPC 2.0 success response carrying `result`.
pub fn result(id: &Value, value: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": value })
}

/// A JSON-RPC 2.0 error response (`code` + `message`).
pub fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// A `tools/call` success payload (text content). Large/structured results are JSON-stringified.
pub fn tool_text(value: &Value) -> Value {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
    json!({ "content": [{ "type": "text", "text": text }] })
}

/// A `tools/call` error payload — still a successful JSON-RPC response, with `isError: true`.
pub fn tool_error(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

// ── shared argument parser ───────────────────────────────────────────────────

/// A required, non-empty string argument. (Crate-specific parsers — arrays, enums, domains — stay in
/// their own crate; this one is identical across servers.)
pub fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("missing required string argument '{key}'"))
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/// Handle one parsed JSON-RPC request. Returns `Some(response)` for requests and `None` for
/// notifications (no `id`, e.g. `notifications/initialized`). Routing + the handshake are independent
/// of live state; `tools/call` delegates to [`ToolServer::call_tool`].
pub fn handle(server: &dyn ToolServer, req: &Value) -> Option<Value> {
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or_default();

    // Notifications have no id and expect no response.
    let id = req.get("id").cloned()?;

    match method {
        "initialize" => {
            let client_proto = req
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(|v| v.as_str())
                .unwrap_or(PROTOCOL_VERSION);
            Some(result(
                &id,
                json!({
                    "protocolVersion": client_proto,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": server.server_name(), "version": server.server_version() }
                }),
            ))
        }
        "ping" => Some(result(&id, json!({}))),
        "tools/list" => Some(result(&id, json!({ "tools": server.tool_schemas() }))),
        "tools/call" => {
            let params = req.get("params").cloned().unwrap_or_else(|| json!({}));
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or_default();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            match server.call_tool(name, &args) {
                Ok(value) => Some(result(&id, tool_text(&value))),
                Err(e) => Some(result(&id, tool_error(&e))),
            }
        }
        other => Some(error(&id, -32601, &format!("method not found: {other}"))),
    }
}

/// Run the server: read newline-delimited JSON-RPC requests from stdin, write responses to stdout.
/// The caller constructs the (possibly fallible) [`ToolServer`] first, so engine/store setup errors
/// surface before the loop starts.
pub fn run_stdio_server(server: &dyn ToolServer) -> Result<(), String> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| format!("stdin read: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                // Parse error with null id, per JSON-RPC.
                let resp = error(&Value::Null, -32700, &format!("parse error: {e}"));
                writeln!(out, "{resp}").map_err(|e| e.to_string())?;
                out.flush().map_err(|e| e.to_string())?;
                continue;
            }
        };
        if let Some(resp) = handle(server, &req) {
            writeln!(out, "{resp}").map_err(|e| e.to_string())?;
            out.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal in-test server: a fixed two-tool catalog + an `echo`/`boom` dispatcher, so the
    /// handshake, routing, and the tool-text/tool-error wrapping can be exercised without an engine.
    struct MockServer;

    impl ToolServer for MockServer {
        fn server_name(&self) -> &str {
            "mock"
        }
        fn server_version(&self) -> &str {
            "9.9.9"
        }
        fn tool_schemas(&self) -> Value {
            json!([
                { "name": "echo", "description": "echo args", "inputSchema": { "type": "object" } },
                { "name": "boom", "description": "always errors", "inputSchema": { "type": "object" } }
            ])
        }
        fn call_tool(&self, name: &str, args: &Value) -> Result<Value, String> {
            match name {
                "echo" => Ok(args.clone()),
                "boom" => Err("kaboom".into()),
                other => Err(format!("unknown tool '{other}'")),
            }
        }
    }

    #[test]
    fn builders_emit_the_wire_shapes() {
        assert_eq!(result(&json!(1), json!({ "ok": true })), json!({ "jsonrpc": "2.0", "id": 1, "result": { "ok": true } }));
        assert_eq!(
            error(&Value::Null, -32700, "bad"),
            json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "bad" } })
        );
        let te = tool_error("nope");
        assert_eq!(te["isError"], true);
        assert_eq!(te["content"][0]["text"], "nope");
        // tool_text pretty-prints structured values into the single text block.
        let tt = tool_text(&json!({ "a": 1 }));
        assert_eq!(tt["content"][0]["type"], "text");
        let parsed: Value = serde_json::from_str(tt["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(parsed, json!({ "a": 1 }));
    }

    #[test]
    fn arg_str_requires_a_nonempty_string() {
        assert_eq!(arg_str(&json!({ "k": "v" }), "k").unwrap(), "v");
        assert!(arg_str(&json!({ "k": "  " }), "k").is_err());
        assert!(arg_str(&json!({}), "k").is_err());
        assert!(arg_str(&json!({ "k": 5 }), "k").is_err());
    }

    #[test]
    fn initialize_echoes_protocol_and_names_server() {
        let req = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2024-11-05", "capabilities": {} } });
        let resp = handle(&MockServer, &req).unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(resp["result"]["serverInfo"]["name"], "mock");
        assert_eq!(resp["result"]["serverInfo"]["version"], "9.9.9");
        assert!(resp["result"]["capabilities"]["tools"].is_object());
    }

    #[test]
    fn initialize_defaults_protocol_when_client_omits_it() {
        let req = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} });
        let resp = handle(&MockServer, &req).unwrap();
        assert_eq!(resp["result"]["protocolVersion"], PROTOCOL_VERSION);
    }

    #[test]
    fn notifications_get_no_response() {
        let req = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(handle(&MockServer, &req).is_none());
    }

    #[test]
    fn ping_returns_empty_result() {
        let req = json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" });
        let resp = handle(&MockServer, &req).unwrap();
        assert_eq!(resp["result"], json!({}));
    }

    #[test]
    fn tools_list_returns_the_server_schemas() {
        let req = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
        let resp = handle(&MockServer, &req).unwrap();
        let names: Vec<&str> = resp["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["echo", "boom"]);
    }

    #[test]
    fn unknown_method_is_a_jsonrpc_error() {
        let req = json!({ "jsonrpc": "2.0", "id": 3, "method": "frobnicate" });
        let resp = handle(&MockServer, &req).unwrap();
        assert_eq!(resp["error"]["code"], -32601);
    }

    #[test]
    fn tools_call_success_wraps_in_text_payload() {
        let req = json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "echo", "arguments": { "hi": 1 } } });
        let resp = handle(&MockServer, &req).unwrap();
        assert!(resp.get("error").is_none());
        assert!(resp["result"].get("isError").is_none());
        let parsed: Value = serde_json::from_str(resp["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(parsed, json!({ "hi": 1 }));
    }

    #[test]
    fn tools_call_error_is_iserror_not_rpc_error() {
        let req = json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": { "name": "boom", "arguments": {} } });
        let resp = handle(&MockServer, &req).unwrap();
        assert!(resp.get("error").is_none());
        assert_eq!(resp["result"]["isError"], true);
        assert_eq!(resp["result"]["content"][0]["text"], "kaboom");
    }
}
