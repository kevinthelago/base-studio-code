//! `bsc-research-mcp` (#1196) — the bundled native Research MCP server. Speaks JSON-RPC 2.0 over
//! stdio; the app auto-registers it in `.mcp.json` so the planner/director/workers get literature
//! grounding (arXiv · Semantic Scholar · PubMed/PMC · Crossref + native PDF extraction + citation-
//! grounded semantic search) with no download/build/Docker. The JSON-RPC loop lives in the shared
//! `mcp_rpc` core (#1622); this binary just builds the server and runs it.

fn main() {
    if let Err(e) = run() {
        eprintln!("bsc-research-mcp: fatal: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let server = research::mcp::Server::from_env()?;
    mcp_rpc::run_stdio_server(&server)
}
