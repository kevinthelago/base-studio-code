//! `bsc-research-mcp` (#1196) — the bundled native Research MCP server. Speaks JSON-RPC 2.0 over
//! stdio; the app auto-registers it in `.mcp.json` so the planner/director/workers get literature
//! grounding (arXiv · Semantic Scholar · PubMed/PMC · Crossref + native PDF extraction + citation-
//! grounded semantic search) with no download/build/Docker.

fn main() {
    if let Err(e) = research::mcp::run() {
        eprintln!("bsc-research-mcp: fatal: {e}");
        std::process::exit(1);
    }
}
