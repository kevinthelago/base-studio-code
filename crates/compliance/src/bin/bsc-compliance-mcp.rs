//! `bsc-compliance-mcp` (#1005) — the bundled native Compliance MCP server. Speaks JSON-RPC 2.0 over
//! stdio; the app auto-registers it in `.mcp.json` so the planner/director/workers get the live,
//! user-updatable compliance standards (WCAG · GDPR · CCPA · SOC 2 · user-protection) with no
//! download/build/Docker — so every plan bakes in the right requirements and a stale release never
//! ships outdated rules. The JSON-RPC loop lives in the shared `mcp_rpc` core (#1622); this binary
//! just builds the server and runs it.

fn main() {
    if let Err(e) = run() {
        eprintln!("bsc-compliance-mcp: fatal: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let server = compliance::mcp::Server::from_env()?;
    mcp_rpc::run_stdio_server(&server)
}
