//! The Research stdio MCP server (#1196). The JSON-RPC 2.0 plumbing — handshake, request builders,
//! dispatch, and the stdin→stdout run-loop — lives in the shared [`mcp_rpc`] core (#1622); this module
//! keeps only what is Research-specific: the tool catalog ([`tool_schemas`]), the argument parsers, and
//! the [`Server`] that wires the [`Engine`] into [`mcp_rpc::ToolServer`]. The schemas and parsers are
//! pure and unit-tested; only [`Server::from_env`] and the [`Engine`] calls touch the outside world.
//! "Preserve the contract, swap the producer": this is the native producer behind the same
//! agent-facing tool surface.

use crate::engine::Engine;
use crate::types::{SearchQuery, Source};
use mcp_rpc::arg_str;
use serde_json::{json, Value};

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

// ── argument parsers (pure) ──────────────────────────────────────────────────

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

/// Run one tool, returning its result Value (the shared core wraps it in `tool_text`/`tool_error`).
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

/// The Research MCP server: an [`Engine`] behind the shared [`mcp_rpc::ToolServer`] seam. Build it with
/// [`Server::from_env`], then drive the stdio loop via [`mcp_rpc::run_stdio_server`].
pub struct Server {
    engine: Engine,
}

impl Server {
    /// Construct the server, building the engine from the environment (cache path, optional API keys).
    pub fn from_env() -> Result<Self, String> {
        Ok(Self { engine: Engine::from_env()? })
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

    #[test]
    fn tool_schemas_exposes_the_five_tools() {
        let tools = tool_schemas();
        let tools = tools.as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["search", "get_paper", "get_fulltext", "get_references", "semantic_search"]);
        // Each tool has an object input schema.
        assert!(tools.iter().all(|t| t["inputSchema"]["type"] == "object"));
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
}
