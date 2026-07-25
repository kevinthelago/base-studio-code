//! The CVE stdio MCP server (#3797) — `bsc mcp cve`. The JSON-RPC 2.0 plumbing lives in the shared
//! [`mcp_rpc`] core; this module keeps only the CVE-specific tool catalog + the [`Server`] wiring the
//! [`Engine`] into [`mcp_rpc::ToolServer`]. Exposes the same three operations as the CLI so the planner
//! and agents can ask "is this package/lockfile vulnerable?" from any session that gets `.mcp.json`.
//! Generic over [`VulnSource`] so it's testable with a fake engine (no network).

use crate::engine::Engine;
use crate::osv::{Osv, VulnSource};
use crate::types::{Ecosystem, Package};
use mcp_rpc::arg_str;
use serde_json::{json, Value};

const SERVER_NAME: &str = "cve";

/// The tools this server exposes, with JSON-Schema input shapes.
pub fn tool_schemas() -> Value {
    json!([
        {
            "name": "scan_lockfile",
            "description": "Scan a lockfile/manifest for known-vulnerable dependencies via OSV.dev. Pass the path to a package-lock.json, Cargo.lock, or requirements.txt (or a directory containing one; default: the current directory). Returns the vulnerable packages with their advisories + a roll-up (scanned/vulnerable/max_severity). Run this before trusting a dependency set.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path to a lockfile or a directory containing one. Default: the current directory." }
                }
            }
        },
        {
            "name": "check_package",
            "description": "Advisories affecting ONE package/version via OSV.dev. Use before adding a dependency. Returns the package plus any advisories (an empty list means no known vulnerabilities).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ecosystem": { "type": "string", "enum": ["npm", "cargo", "pypi", "go", "maven", "nuget", "rubygems"], "description": "The package ecosystem." },
                    "name": { "type": "string", "description": "The package name." },
                    "version": { "type": "string", "description": "The exact version (recommended — OSV resolves which advisories affect this version). Omit to get every advisory ever filed against the package." }
                },
                "required": ["ecosystem", "name"]
            }
        },
        {
            "name": "get_advisory",
            "description": "One advisory's full record by OSV id (usually a GHSA-… or CVE-…). Returns id, summary, severity, aliases (CVE↔GHSA), and reference URLs.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "An OSV id, e.g. 'GHSA-jf85-cpcp-j695' or 'CVE-2020-8203'." } },
                "required": ["id"]
            }
        }
    ])
}

/// Run one tool over the engine (the shared core wraps the result in `tool_text`/`tool_error`).
fn call_tool<S: VulnSource>(engine: &Engine<S>, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "scan_lockfile" => {
            let path = args.get("path").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).unwrap_or(".");
            let packages = crate::lockfile::scan_path(std::path::Path::new(path))?;
            let report = engine.scan(&packages)?;
            serde_json::to_value(report).map_err(|e| e.to_string())
        }
        "check_package" => {
            let eco = arg_str(args, "ecosystem")?;
            let ecosystem = Ecosystem::parse(&eco).ok_or_else(|| format!("unknown ecosystem '{eco}'"))?;
            let name = arg_str(args, "name")?;
            let version = args.get("version").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).map(str::to_string);
            let report = engine.check(&Package::new(ecosystem, name, version))?;
            serde_json::to_value(report).map_err(|e| e.to_string())
        }
        "get_advisory" => {
            let id = arg_str(args, "id")?;
            match engine.get(&id)? {
                Some(a) => serde_json::to_value(a).map_err(|e| e.to_string()),
                None => Err(format!("advisory not found: {id}")),
            }
        }
        other => Err(format!("unknown tool '{other}'")),
    }
}

/// The CVE MCP server: an [`Engine`] behind the shared [`mcp_rpc::ToolServer`] seam.
pub struct Server<S: VulnSource> {
    engine: Engine<S>,
}

impl Server<Osv> {
    /// Construct the production server, opening the cache + OSV client from the environment.
    pub fn from_env() -> Result<Server<Osv>, String> {
        Ok(Server { engine: Engine::from_env()? })
    }
}

impl<S: VulnSource> Server<S> {
    /// Wrap an already-built engine (tests use an in-memory cache + a fake source).
    #[cfg(test)]
    pub fn with_engine(engine: Engine<S>) -> Server<S> {
        Server { engine }
    }
}

impl<S: VulnSource> mcp_rpc::ToolServer for Server<S> {
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
    use crate::cache::{Cache, DEFAULT_TTL_SECS};
    use crate::engine::fake::FakeSource;
    use crate::types::{Advisory, Severity};
    use mcp_rpc::handle;

    fn server() -> Server<FakeSource> {
        let src = FakeSource::new().with(
            "lodash",
            vec![Advisory { id: "GHSA-1".into(), summary: "proto pollution".into(), severity: Severity::High, aliases: vec!["CVE-2020-8203".into()], references: vec![] }],
        );
        Server::with_engine(Engine::new(Cache::in_memory().unwrap(), src, DEFAULT_TTL_SECS))
    }

    #[test]
    fn tool_schemas_exposes_the_three_tools() {
        let tools = tool_schemas();
        let names: Vec<&str> = tools.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["scan_lockfile", "check_package", "get_advisory"]);
        assert!(tools.as_array().unwrap().iter().all(|t| t["inputSchema"]["type"] == "object"));
    }

    #[test]
    fn initialize_names_the_cve_server() {
        let s = server();
        let req = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2024-11-05", "capabilities": {} } });
        let resp = handle(&s, &req).unwrap();
        assert_eq!(resp["result"]["serverInfo"]["name"], "cve");
    }

    #[test]
    fn check_package_returns_the_advisories_over_a_fake_engine() {
        let s = server();
        let req = json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call",
            "params": { "name": "check_package", "arguments": { "ecosystem": "npm", "name": "lodash", "version": "4.17.0" } } });
        let resp = handle(&s, &req).unwrap();
        assert!(resp.get("error").is_none());
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["package"]["name"], "lodash");
        assert_eq!(parsed["advisories"][0]["id"], "GHSA-1");
        assert_eq!(parsed["advisories"][0]["severity"], "high");
    }

    #[test]
    fn missing_required_arg_returns_iserror_not_rpc_error() {
        let s = server();
        let req = json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "check_package", "arguments": { "ecosystem": "npm" } } });
        let resp = handle(&s, &req).unwrap();
        assert!(resp.get("error").is_none());
        assert_eq!(resp["result"]["isError"], true);
    }
}
