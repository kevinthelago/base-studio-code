//! The stdio MCP server core (#1005) — JSON-RPC 2.0 over newline-delimited stdin/stdout, mirroring
//! the shape the app's MCP *client* speaks (`crates/bsc-agent/src/mcp.rs`) and the Research server:
//! `initialize` → `notifications/initialized` → `tools/list` → `tools/call`, protocol `2024-11-05`.
//! The request builders, the tool schemas, and the argument parsers are pure + unit-tested; only
//! [`run`] and the [`Engine`] calls touch the outside world. The server is the live source of truth
//! for compliance standards so the planner bakes the right requirements into every plan.

use crate::engine::Engine;
use crate::types::Domain;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "compliance";

/// The tools this server exposes, with JSON-Schema input shapes.
pub fn tool_schemas() -> Value {
    json!([
        {
            "name": "list_standards",
            "description": "List the compliance standards in force, optionally filtered to one domain (accessibility, privacy, security, user_protection). Returns each standard's id, name, version, jurisdictions, and summary — call `get_standard` for its full requirement list. These are the live, user-updatable standards; cite the ones you adopt in the plan.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "domain": { "type": "string", "enum": ["accessibility", "privacy", "security", "user_protection"], "description": "Restrict to one domain; omit for all." }
                }
            }
        },
        {
            "name": "get_standard",
            "description": "Fetch one standard's full record — including every requirement — by canonical id (e.g. 'wcag-2.2', 'gdpr', 'ccpa', 'soc2', 'user-protection').",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Canonical standard id, e.g. 'gdpr'." } },
                "required": ["id"]
            }
        },
        {
            "name": "requirements_for",
            "description": "The compliance obligations that apply to THIS project, scoped by target regions, the data types it handles, and (optionally) a domain. Returns the flattened, citable requirements (tagged with their standard) to bake into the plan + each worker's context — so generated code is built to them, not retrofitted.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "regions": { "type": "array", "items": { "type": "string" }, "description": "Target jurisdictions (e.g. ['eu','us-ca']); omit to include all standards regardless of region." },
                    "data_types": { "type": "array", "items": { "type": "string" }, "description": "Personal/sensitive data the app handles (e.g. ['pii','health','tracking']); narrows data-specific obligations." },
                    "domains": { "type": "array", "items": { "type": "string", "enum": ["accessibility", "privacy", "security", "user_protection"] }, "description": "Restrict to these domains; omit for all." }
                }
            }
        },
        {
            "name": "accessibility_checklist",
            "description": "The WCAG success criteria a UI screen or component must meet. Pass the screen/component name; returns the AA criteria checklist (id + requirement, tagged with the standard) to attach to the UI work.",
            "inputSchema": {
                "type": "object",
                "properties": { "target": { "type": "string", "description": "The screen or component, e.g. 'checkout form'." } },
                "required": ["target"]
            }
        },
        {
            "name": "privacy_requirements",
            "description": "The privacy / data-protection obligations (GDPR, CCPA, …) for the given data types and regions — collection, consent, retention, and rights. A focused `requirements_for` pinned to the privacy domain.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "data_types": { "type": "array", "items": { "type": "string" }, "description": "Personal/sensitive data the app handles (e.g. ['pii','health'])." },
                    "regions": { "type": "array", "items": { "type": "string" }, "description": "Target jurisdictions (e.g. ['eu','us-ca']); omit for all." }
                },
                "required": ["data_types"]
            }
        }
    ])
}

// ── pure JSON-RPC builders ───────────────────────────────────────────────────

fn result(id: &Value, value: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": value })
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// A `tools/call` success payload (text content). Structured results are JSON-stringified.
fn tool_text(value: &Value) -> Value {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
    json!({ "content": [{ "type": "text", "text": text }] })
}

/// A `tools/call` error payload — still a successful JSON-RPC response, with `isError: true`.
fn tool_error(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

// ── argument parsers (pure) ──────────────────────────────────────────────────

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("missing required string argument '{key}'"))
}

/// A string array argument → a deduped, non-empty, lowercased token list (empty when absent).
fn arg_str_array(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Parse a `domain` arg into an `Option<Domain>`; an unknown token is an error.
pub fn parse_domain_arg(args: &Value) -> Result<Option<Domain>, String> {
    match args.get("domain").and_then(|v| v.as_str()) {
        None => Ok(None),
        Some(tok) if tok.trim().is_empty() => Ok(None),
        Some(tok) => Domain::parse(tok).map(Some).ok_or_else(|| format!("unknown domain '{tok}'")),
    }
}

/// Parse a `domains` array arg into a `Vec<Domain>`; an unknown token is an error.
pub fn parse_domains_arg(args: &Value) -> Result<Vec<Domain>, String> {
    let mut out = Vec::new();
    if let Some(arr) = args.get("domains").and_then(|v| v.as_array()) {
        for v in arr {
            if let Some(tok) = v.as_str() {
                if tok.trim().is_empty() {
                    continue;
                }
                match Domain::parse(tok) {
                    Some(d) => out.push(d),
                    None => return Err(format!("unknown domain '{tok}'")),
                }
            }
        }
    }
    Ok(out)
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/// Run one tool, returning its result Value (caller wraps in `tool_text`/`tool_error`).
fn call_tool(engine: &Engine, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "list_standards" => {
            let domain = parse_domain_arg(args)?;
            Ok(json!({ "standards": engine.list_standards(domain), "meta": engine.meta() }))
        }
        "get_standard" => {
            let id = arg_str(args, "id")?;
            match engine.get_standard(&id) {
                Some(s) => Ok(serde_json::to_value(s).map_err(|e| e.to_string())?),
                None => Err(format!("standard not found: {id}")),
            }
        }
        "requirements_for" => {
            let regions = arg_str_array(args, "regions");
            let data_types = arg_str_array(args, "data_types");
            let domains = parse_domains_arg(args)?;
            Ok(serde_json::to_value(engine.requirements_for(&regions, &data_types, &domains))
                .map_err(|e| e.to_string())?)
        }
        "accessibility_checklist" => {
            let target = arg_str(args, "target")?;
            Ok(serde_json::to_value(engine.accessibility_checklist(&target)).map_err(|e| e.to_string())?)
        }
        "privacy_requirements" => {
            let data_types = arg_str_array(args, "data_types");
            if data_types.is_empty() {
                return Err("missing required array argument 'data_types'".into());
            }
            let regions = arg_str_array(args, "regions");
            Ok(serde_json::to_value(engine.privacy_requirements(&data_types, &regions))
                .map_err(|e| e.to_string())?)
        }
        other => Err(format!("unknown tool '{other}'")),
    }
}

/// Handle one parsed JSON-RPC request. Returns `Some(response)` for requests and `None` for
/// notifications (no `id`). `engine` is optional so the routing/handshake can be unit-tested
/// without a live engine; tool calls require it.
pub fn handle(engine: Option<&Engine>, req: &Value) -> Option<Value> {
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
                    "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") }
                }),
            ))
        }
        "ping" => Some(result(&id, json!({}))),
        "tools/list" => Some(result(&id, json!({ "tools": tool_schemas() }))),
        "tools/call" => {
            let params = req.get("params").cloned().unwrap_or_else(|| json!({}));
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or_default();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let Some(engine) = engine else {
                return Some(result(&id, tool_error("engine unavailable")));
            };
            match call_tool(engine, name, &args) {
                Ok(value) => Some(result(&id, tool_text(&value))),
                Err(e) => Some(result(&id, tool_error(&e))),
            }
        }
        other => Some(error(&id, -32601, &format!("method not found: {other}"))),
    }
}

/// Run the server: read newline-delimited JSON-RPC requests from stdin, write responses to stdout.
pub fn run() -> Result<(), String> {
    let engine = Engine::from_env()?;
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
                let resp = error(&Value::Null, -32700, &format!("parse error: {e}"));
                writeln!(out, "{resp}").map_err(|e| e.to_string())?;
                out.flush().map_err(|e| e.to_string())?;
                continue;
            }
        };
        if let Some(resp) = handle(Some(&engine), &req) {
            writeln!(out, "{resp}").map_err(|e| e.to_string())?;
            out.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;
    use crate::store::Store;

    fn engine() -> Engine {
        Engine::with_store(Store::in_memory().unwrap())
    }

    #[test]
    fn initialize_echoes_protocol_and_names_server() {
        let req = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2024-11-05", "capabilities": {} } });
        let resp = handle(None, &req).unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(resp["result"]["serverInfo"]["name"], "compliance");
        assert!(resp["result"]["capabilities"]["tools"].is_object());
    }

    #[test]
    fn notifications_get_no_response() {
        let req = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(handle(None, &req).is_none());
    }

    #[test]
    fn tools_list_exposes_the_five_tools() {
        let req = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
        let resp = handle(None, &req).unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            vec!["list_standards", "get_standard", "requirements_for", "accessibility_checklist", "privacy_requirements"]
        );
        assert!(tools.iter().all(|t| t["inputSchema"]["type"] == "object"));
    }

    #[test]
    fn unknown_method_is_a_jsonrpc_error() {
        let req = json!({ "jsonrpc": "2.0", "id": 3, "method": "frobnicate" });
        let resp = handle(None, &req).unwrap();
        assert_eq!(resp["error"]["code"], -32601);
    }

    #[test]
    fn parse_domain_args_validate_tokens() {
        assert_eq!(parse_domain_arg(&json!({})).unwrap(), None);
        assert_eq!(parse_domain_arg(&json!({ "domain": "privacy" })).unwrap(), Some(Domain::Privacy));
        assert!(parse_domain_arg(&json!({ "domain": "bogus" })).is_err());
        assert_eq!(parse_domains_arg(&json!({ "domains": ["security", "a11y"] })).unwrap(), vec![Domain::Security, Domain::Accessibility]);
        assert!(parse_domains_arg(&json!({ "domains": ["nope"] })).is_err());
    }

    #[test]
    fn tools_call_get_standard_returns_record_over_seeded_store() {
        let e = engine();
        let req = json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call",
            "params": { "name": "get_standard", "arguments": { "id": "gdpr" } } });
        let resp = handle(Some(&e), &req).unwrap();
        assert!(resp.get("error").is_none());
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["id"], "gdpr");
        assert_eq!(parsed["domain"], "privacy");
        assert!(parsed["requirements"].as_array().unwrap().iter().any(|r| r["id"] == "transparency"));
    }

    #[test]
    fn tools_call_requirements_for_scopes_and_succeeds() {
        let e = engine();
        let req = json!({ "jsonrpc": "2.0", "id": 10, "method": "tools/call",
            "params": { "name": "requirements_for", "arguments": { "regions": ["eu"], "data_types": ["pii"] } } });
        let resp = handle(Some(&e), &req).unwrap();
        assert_eq!(resp["result"].get("isError"), None);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        let ids: Vec<&str> = parsed["standards"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
        assert!(ids.contains(&"gdpr"));
        assert!(!ids.contains(&"ccpa")); // us-ca only
        assert!(parsed["meta"]["corpusVersion"].as_u64().unwrap() >= 1);
    }

    #[test]
    fn tools_call_with_bad_args_returns_iserror_not_rpc_error() {
        let e = engine();
        let req = json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "privacy_requirements", "arguments": {} } });
        let resp = handle(Some(&e), &req).unwrap();
        assert!(resp.get("error").is_none());
        assert_eq!(resp["result"]["isError"], true);
    }
}
