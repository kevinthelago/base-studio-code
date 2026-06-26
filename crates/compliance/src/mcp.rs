//! The Compliance stdio MCP server (#1005). The JSON-RPC 2.0 plumbing — handshake, request builders,
//! dispatch, and the stdin→stdout run-loop — lives in the shared [`mcp_rpc`] core (#1622); this module
//! keeps only what is Compliance-specific: the tool catalog ([`tool_schemas`]), the argument parsers
//! (`parse_domain_arg`/`parse_domains_arg`/`arg_str_array`), and the [`Server`] that wires the
//! [`Engine`] into [`mcp_rpc::ToolServer`]. The schemas + parsers are pure + unit-tested; only
//! [`Server::from_env`] and the [`Engine`] calls touch the outside world. The server is the live source
//! of truth for compliance standards so the planner bakes the right requirements into every plan.

use crate::engine::Engine;
use crate::types::Domain;
use mcp_rpc::arg_str;
use serde_json::{json, Value};

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

// ── argument parsers (pure) ──────────────────────────────────────────────────

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

/// Run one tool, returning its result Value (the shared core wraps it in `tool_text`/`tool_error`).
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

/// The Compliance MCP server: an [`Engine`] behind the shared [`mcp_rpc::ToolServer`] seam. Build it
/// with [`Server::from_env`], then drive the stdio loop via [`mcp_rpc::run_stdio_server`].
pub struct Server {
    engine: Engine,
}

impl Server {
    /// Construct the server, opening the standards store from the environment (seeded on first open).
    pub fn from_env() -> Result<Self, String> {
        Ok(Self { engine: Engine::from_env()? })
    }

    /// Wrap an already-built engine (e.g. an in-memory store in tests).
    #[cfg(test)]
    pub fn with_engine(engine: Engine) -> Self {
        Self { engine }
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
        call_tool(&self.engine, name, args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use mcp_rpc::handle;

    fn server() -> Server {
        Server::with_engine(Engine::with_store(Store::in_memory().unwrap()))
    }

    #[test]
    fn tool_schemas_exposes_the_five_tools() {
        let tools = tool_schemas();
        let tools = tools.as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            vec!["list_standards", "get_standard", "requirements_for", "accessibility_checklist", "privacy_requirements"]
        );
        assert!(tools.iter().all(|t| t["inputSchema"]["type"] == "object"));
    }

    #[test]
    fn initialize_names_the_compliance_server() {
        let s = server();
        let req = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2024-11-05", "capabilities": {} } });
        let resp = handle(&s, &req).unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(resp["result"]["serverInfo"]["name"], "compliance");
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
        let s = server();
        let req = json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call",
            "params": { "name": "get_standard", "arguments": { "id": "gdpr" } } });
        let resp = handle(&s, &req).unwrap();
        assert!(resp.get("error").is_none());
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["id"], "gdpr");
        assert_eq!(parsed["domain"], "privacy");
        assert!(parsed["requirements"].as_array().unwrap().iter().any(|r| r["id"] == "transparency"));
    }

    #[test]
    fn tools_call_requirements_for_scopes_and_succeeds() {
        let s = server();
        let req = json!({ "jsonrpc": "2.0", "id": 10, "method": "tools/call",
            "params": { "name": "requirements_for", "arguments": { "regions": ["eu"], "data_types": ["pii"] } } });
        let resp = handle(&s, &req).unwrap();
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
        let s = server();
        let req = json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "privacy_requirements", "arguments": {} } });
        let resp = handle(&s, &req).unwrap();
        assert!(resp.get("error").is_none());
        assert_eq!(resp["result"]["isError"], true);
    }
}
