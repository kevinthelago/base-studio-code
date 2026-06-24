//! The stdio MCP server core (#1196) — JSON-RPC 2.0 over newline-delimited stdin/stdout, mirroring
//! the shape the app's MCP *client* speaks (`crates/bsc-agent/src/mcp.rs`): `initialize` →
//! `notifications/initialized` → `tools/list` → `tools/call`, protocol `2024-11-05`. The request
//! builders, the tool schemas, and the argument parsers are pure + unit-tested; only [`run`] and the
//! [`Engine`] calls touch the outside world. "Preserve the contract, swap the producer": this is the
//! native producer behind the same agent-facing tool surface.

use crate::engine::Engine;
use crate::types::{SearchQuery, Source};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "research";

/// The five tools this server exposes, with JSON-Schema input shapes.
pub fn tool_schemas() -> Value {
    json!([
        {
            "name": "search",
            "description": "Search across arXiv, Semantic Scholar, PubMed/PMC, Crossref, and Wikipedia. Returns normalized records (title, authors, year, abstract, ids, urls), deduped across sources. To SEED a skill, search `sources:[\"wikipedia\"]` for broad encyclopedic grounding, then refine with the scientific sources for depth + recency before grounding a plan or skill.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search terms, e.g. 'real-time path tracing denoising'." },
                    "sources": { "type": "array", "items": { "type": "string", "enum": ["arxiv", "semantic_scholar", "pubmed", "crossref", "wikipedia"] }, "description": "Which sources to query; omit for all. Use ['wikipedia'] to seed a skill, then the scientific sources to refine it." },
                    "limit": { "type": "integer", "description": "Max results per source (default 10)." },
                    "year_from": { "type": "integer", "description": "Only include papers published in/after this year." }
                },
                "required": ["query"]
            }
        },
        {
            "name": "get_paper",
            "description": "Fetch one paper's full metadata by canonical id (arxiv:<id>, doi:<doi>, pmid:<id>, or s2:<id>).",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Canonical id, e.g. 'arxiv:2401.01234' or 'doi:10.1145/3592433'." } },
                "required": ["id"]
            }
        },
        {
            "name": "get_fulltext",
            "description": "Get a record's full text: papers are downloaded + natively extracted from their PDF (arXiv/PMC-OA/publisher); Wikipedia articles (wikipedia:<Title>) return their full plain text directly. Returns the extracted text; fallbacks are the caller's (use the abstract from get_paper if a paper has no text layer).",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Canonical id: a paper with a known PDF, or a wikipedia:<Title> article." } },
                "required": ["id"]
            }
        },
        {
            "name": "get_references",
            "description": "Resolve a paper's reference list (citations), with DOIs/arXiv ids where they can be resolved via Crossref/Semantic Scholar.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Canonical id of the citing paper." } },
                "required": ["id"]
            }
        },
        {
            "name": "semantic_search",
            "description": "Citation-grounded passage retrieval over a set of papers. Fetches each paper's full text (or abstract), chunks it by section, and returns the passages most relevant to the query — each tagged with its paper id and section for citation. Use after `search` to pull the exact supporting passages for a topic.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "What to retrieve passages about." },
                    "ids": { "type": "array", "items": { "type": "string" }, "description": "Canonical ids of the papers to search within (e.g. from a prior `search`)." },
                    "top_k": { "type": "integer", "description": "How many passages to return (default 8)." }
                },
                "required": ["query", "ids"]
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

/// A `tools/call` success payload (text content). Large/structured results are JSON-stringified.
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

/// Parse the `search` tool arguments into a [`SearchQuery`].
pub fn parse_search_args(args: &Value) -> Result<SearchQuery, String> {
    let mut q = SearchQuery::new(arg_str(args, "query")?);
    if let Some(limit) = args.get("limit").and_then(|v| v.as_u64()) {
        q.limit = (limit as usize).clamp(1, 100);
    }
    if let Some(year) = args.get("year_from").and_then(|v| v.as_u64()) {
        q.year_from = Some(year as u32);
    }
    if let Some(arr) = args.get("sources").and_then(|v| v.as_array()) {
        let mut sources = Vec::new();
        for s in arr {
            if let Some(tok) = s.as_str() {
                match Source::parse(tok) {
                    Some(src) => sources.push(src),
                    None => return Err(format!("unknown source '{tok}'")),
                }
            }
        }
        q.sources = sources;
    }
    Ok(q)
}

/// Parse the `semantic_search` arguments into `(query, ids, top_k)`.
pub fn parse_semantic_args(args: &Value) -> Result<(String, Vec<String>, usize), String> {
    let query = arg_str(args, "query")?;
    let ids: Vec<String> = args
        .get("ids")
        .and_then(|v| v.as_array())
        .ok_or("missing required array argument 'ids'")?
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .filter(|s| !s.trim().is_empty())
        .collect();
    if ids.is_empty() {
        return Err("'ids' must contain at least one paper id".into());
    }
    let top_k = args.get("top_k").and_then(|v| v.as_u64()).map(|n| (n as usize).clamp(1, 50)).unwrap_or(8);
    Ok((query, ids, top_k))
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/// Run one tool, returning its result Value (caller wraps in `tool_text`/`tool_error`).
fn call_tool(engine: &Engine, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "search" => {
            let q = parse_search_args(args)?;
            Ok(serde_json::to_value(engine.search(&q)).map_err(|e| e.to_string())?)
        }
        "get_paper" => {
            let id = arg_str(args, "id")?;
            Ok(serde_json::to_value(engine.get_paper(&id)?).map_err(|e| e.to_string())?)
        }
        "get_fulltext" => {
            let id = arg_str(args, "id")?;
            let text = engine.get_fulltext(&id)?;
            Ok(json!({ "id": id, "chars": text.chars().count(), "text": text }))
        }
        "get_references" => {
            let id = arg_str(args, "id")?;
            Ok(serde_json::to_value(engine.get_references(&id)?).map_err(|e| e.to_string())?)
        }
        "semantic_search" => {
            let (query, ids, top_k) = parse_semantic_args(args)?;
            Ok(serde_json::to_value(engine.semantic_search(&query, &ids, top_k)?).map_err(|e| e.to_string())?)
        }
        other => Err(format!("unknown tool '{other}'")),
    }
}

/// Handle one parsed JSON-RPC request. Returns `Some(response)` for requests and `None` for
/// notifications (no `id`, e.g. `notifications/initialized`). `engine` is optional so the routing /
/// handshake can be unit-tested without constructing a live engine; tool calls require it.
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
                // Parse error with null id, per JSON-RPC.
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

    #[test]
    fn initialize_echoes_protocol_and_names_server() {
        let req = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2024-11-05", "capabilities": {} } });
        let resp = handle(None, &req).unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(resp["result"]["serverInfo"]["name"], "research");
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
        assert_eq!(names, vec!["search", "get_paper", "get_fulltext", "get_references", "semantic_search"]);
        // Each tool has an object input schema.
        assert!(tools.iter().all(|t| t["inputSchema"]["type"] == "object"));
    }

    #[test]
    fn unknown_method_is_a_jsonrpc_error() {
        let req = json!({ "jsonrpc": "2.0", "id": 3, "method": "frobnicate" });
        let resp = handle(None, &req).unwrap();
        assert_eq!(resp["error"]["code"], -32601);
    }

    #[test]
    fn parse_search_args_reads_all_fields() {
        let args = json!({ "query": "ray tracing", "limit": 5, "year_from": 2022, "sources": ["arxiv", "s2"] });
        let q = parse_search_args(&args).unwrap();
        assert_eq!(q.query, "ray tracing");
        assert_eq!(q.limit, 5);
        assert_eq!(q.year_from, Some(2022));
        assert_eq!(q.sources, vec![Source::Arxiv, Source::SemanticScholar]);
        // Missing query is an error; unknown source is an error.
        assert!(parse_search_args(&json!({})).is_err());
        assert!(parse_search_args(&json!({ "query": "x", "sources": ["bogus"] })).is_err());
        // limit is clamped.
        assert_eq!(parse_search_args(&json!({ "query": "x", "limit": 9999 })).unwrap().limit, 100);
    }

    #[test]
    fn parse_semantic_args_requires_nonempty_ids() {
        let ok = parse_semantic_args(&json!({ "query": "q", "ids": ["arxiv:1", "doi:10.1/x"], "top_k": 3 })).unwrap();
        assert_eq!(ok.0, "q");
        assert_eq!(ok.1, vec!["arxiv:1", "doi:10.1/x"]);
        assert_eq!(ok.2, 3);
        assert!(parse_semantic_args(&json!({ "query": "q", "ids": [] })).is_err());
        assert!(parse_semantic_args(&json!({ "query": "q" })).is_err());
    }

    #[test]
    fn tools_call_with_bad_args_returns_iserror_not_rpc_error() {
        // No engine + a tool call: we short-circuit to a tool error payload, still a result.
        let req = json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "search", "arguments": {} } });
        let resp = handle(None, &req).unwrap();
        assert!(resp.get("error").is_none());
        assert_eq!(resp["result"]["isError"], true);
    }
}
