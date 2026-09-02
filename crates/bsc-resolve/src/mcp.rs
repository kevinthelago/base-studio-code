//! Which MCP servers a session gets.
//!
//! # Rust owned the data, the writer and the reader — and not the choice
//!
//! * The BUILT-INS are backend-owned data: `src-tauri/data/mcp/builtin-servers.json`.
//! * `extensions::mcp::write_mcp_json` writes the session's `.mcp.json` from an already-resolved list.
//! * `crates/bsc-agent` parses `$BSC_AGENT_MCP` into the same [`crate::cfg::McpServerCfg`].
//!
//! So the backend held every piece except the decision.
//!
//! # Three rules, each a distinction somebody had to argue for
//!
//! * **AMBIENT** — an ENABLED built-in reaches every session. It is the app's own capability, not
//!   something anybody chose, the same way packaged personas are seeded rather than authored.
//! * **CARRIED** — anything a persona names is included REGARDLESS of its `enabled` toggle, because
//!   carrying is INTENT. That is what lets a DISABLED built-in go to one persona rather than the whole
//!   fleet, and it replaced a hand-carved special case for exactly that server.
//! * **HALF-CONFIGURED IS SKIPPED** — stdio needs a command, http needs a url — so a broken line never
//!   reaches a session's `.mcp.json`.
//!
//! # Order is load-bearing
//!
//! Built-ins are emitted FIRST so they keep a stable position in the generated `.mcp.json` and a diff
//! of that file stays readable across launches. A port that iterates the stored servers first produces
//! a churning diff on every launch, which is the kind of noise that trains people to stop reading it.
//!
//! # Two narrowings ride on top, and they are separate questions
//!
//! [`to_bsc_agent_mcp`] drops HTTP servers because that client is stdio-only; forwarding them hands the
//! runtime a config it will fail on. [`mcp_reachable_from`] drops the BUILT-INS under a namespace,
//! because their marker command resolves to a host path that does not exist inside the cage — measured,
//! a director declared two servers and both failed to spawn. Only the built-ins, and only under a
//! namespace: a repo-authored stdio server legitimately works in there.

use std::collections::BTreeMap;

use crate::cfg::McpServerCfg;

/// A configured MCP server, as the store and the packaged built-ins carry it.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    /// `"stdio"` | `"http"`.
    pub transport: String,
    #[serde(default)]
    pub command: Option<String>,
    /// Whitespace-separated, exactly as the user typed them.
    #[serde(default)]
    pub args: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    #[serde(default)]
    pub enabled: bool,
}

/// The `$BSC_AGENT_MCP` entry `bsc-agent` reads. `env` is a plain object there, not a pair list.
///
/// `Deserialize` as well as `Serialize`, because the launch READS the value the renderer already put
/// in the env and reconciles against it rather than taking the list a second time on the wire — the
/// same shape as the credential gate, which reads `GH_TOKEN` out of the env it was handed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BscAgentMcpCfg {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

/// The packaged built-in servers, read from the SAME overlay file the frontend sees rather than
/// restated here — the way `write_locks()` already reads `write-locks.json`.
///
/// An unreadable file yields NO built-ins, which loses the ambient servers and nothing else. That is
/// the safe direction: a session with fewer capabilities than intended is recoverable, and inventing
/// them from a hardcoded copy would be a second source of truth free to drift.
pub fn builtin_mcp_servers() -> Vec<McpServer> {
    builtin_mcp_servers_from(&builtin_servers_text())
}

/// The overlay text for `mcp/builtin-servers.json`: the on-disk config root wins, the packaged seed
/// is the fallback. Mirrors the app's `platform::config::load_str` rather than reimplementing a
/// second precedence — the two must agree or the app and a `bsc` call would resolve different
/// built-ins for the same session.
pub fn builtin_servers_text() -> String {
    const REL: &str = "mcp/builtin-servers.json";
    if let Ok(s) = std::fs::read_to_string(bsc_config::config_root().join(REL)) {
        return s;
    }
    bsc_config::packaged(REL).and_then(|b| String::from_utf8(b.to_vec()).ok()).unwrap_or_default()
}

/// Parse the built-ins from already-loaded text — the testable core, and the seam that keeps this
/// crate free of any opinion about WHERE the file lives.
pub fn builtin_mcp_servers_from(text: &str) -> Vec<McpServer> {
    match serde_json::from_str::<Vec<McpServer>>(text) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("mcp: builtin-servers.json unreadable ({e}) — no ambient servers this launch");
            Vec::new()
        }
    }
}

/// One server's `.mcp.json` payload, or `None` when it is incomplete.
pub fn to_mcp_payload(e: &McpServer) -> Option<McpServerCfg> {
    if e.transport == "http" {
        let url = e.url.as_deref().filter(|u| !u.is_empty())?;
        return Some(McpServerCfg {
            name: e.name.clone(),
            transport: "http".to_string(),
            command: None,
            args: Vec::new(),
            url: Some(url.to_string()),
            env: e.env.clone(),
        });
    }
    let command = e.command.as_deref().filter(|c| !c.is_empty())?;
    Some(McpServerCfg {
        name: e.name.clone(),
        transport: "stdio".to_string(),
        command: Some(command.to_string()),
        args: e.args.split_whitespace().map(str::to_string).collect(),
        url: None,
        env: e.env.clone(),
    })
}

/// The servers this session gets: every ambient built-in, plus everything the persona carries.
///
/// `builtins` is passed in so the caller reads them once; use [`builtin_mcp_servers`] for the real set.
pub fn resolve_persona_mcp(
    all: &[McpServer],
    persona_mcp: &[String],
    builtins: &[McpServer],
) -> Vec<McpServer> {
    let carried: std::collections::HashSet<&str> = persona_mcp.iter().map(String::as_str).collect();
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    // BUILT-INS FIRST — see the module docs; this order is what a readable `.mcp.json` diff rests on.
    for e in builtins.iter().chain(all.iter()) {
        let ambient = e.enabled && builtins.iter().any(|b| b.id == e.id);
        if !ambient && !carried.contains(e.id.as_str()) {
            continue;
        }
        if !seen.insert(e.id.clone()) || to_mcp_payload(e).is_none() {
            continue;
        }
        out.push(e.clone());
    }
    out
}

/// Drop the servers a session in a mount namespace provably cannot spawn.
///
/// ONLY the built-ins, and ONLY under a namespace. Dropping every stdio server would remove the cases
/// that legitimately work — `node ./scripts/mcp.js` spawns fine in there — to fix a knowably broken
/// one. An absent capability an agent is never told about costs nothing; an advertised one that fails
/// is spent on retries and misdiagnosis.
pub fn mcp_reachable_from(servers: &[McpServer], sandboxed: bool, builtins: &[McpServer]) -> Vec<McpServer> {
    if !sandboxed {
        return servers.to_vec();
    }
    servers
        .iter()
        .filter(|e| !builtins.iter().any(|b| b.id == e.id))
        .cloned()
        .collect()
}

/// The `$BSC_AGENT_MCP` config. STDIO-ONLY: that client cannot speak http, so forwarding an http entry
/// hands it a config it will fail on.
pub fn to_bsc_agent_mcp(payloads: &[McpServerCfg]) -> Vec<BscAgentMcpCfg> {
    payloads
        .iter()
        // BELT AND BRACES, and knowing which is which matters. `to_mcp_payload` gives an http entry no
        // command, so the `?` below already drops it and removing this filter leaves the parity green.
        // It is kept because the SOURCE carries both conditions too (`transport === "stdio" && !!command`)
        // and because it states the rule — this client cannot speak http — where a reader looks for it.
        // The command check alone would be an accident of how payloads happen to be built.
        .filter(|p| p.transport == "stdio")
        .filter_map(|p| {
            let command = p.command.clone()?;
            Some(BscAgentMcpCfg {
                name: p.name.clone(),
                command,
                args: p.args.clone(),
                env: p.env.iter().cloned().collect(),
            })
        })
        .collect()
}


/// The resolved list, and what the two sides disagreed on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpReconciliation<T> {
    /// What to write — the SMALLER of the two, entry by entry.
    pub merged: Vec<T>,
    /// Names the frontend sent that the resolution did not produce. Dropped.
    pub dropped: Vec<String>,
    /// Names the resolution produced that the frontend omitted. NOT added — see below.
    pub not_added: Vec<String>,
}

/// Reconcile a resolved server list against the one the renderer sent, keeping the SMALLER.
///
/// # This one narrows where the others union, and the asymmetry is the point
///
/// Everywhere else in this cutover a missing value is the defect and the union is the safe direction.
/// Here the dangerous state is ADVERTISED-BUT-BROKEN. A server declared in `.mcp.json` that cannot
/// spawn is spent on retries and misdiagnosis — the agent is told it has a capability, tries it, and
/// gets a failure it cannot interpret. A capability it is never told about costs nothing.
///
/// So the intersection is taken in BOTH directions, and both are reported: a name only the frontend
/// had is dropped, and a name only the resolution had is NOT added. Neither side can advertise
/// something the other did not vouch for.
///
/// # It is generic because the two consumers must NOT share a list
///
/// `.mcp.json` keeps http servers; `$BSC_AGENT_MCP` is stdio-only, because that client cannot speak
/// http and an http entry hands it a config it fails on. Resolving once and feeding both the same
/// list breaks one of them, so each consumer narrows first and reconciles its OWN shape — which is
/// what this function being generic over the entry type enforces rather than merely documents.
pub fn reconcile_mcp<T: Clone>(
    from_frontend: &[T],
    resolved: &[T],
    name_of: impl Fn(&T) -> String,
) -> McpReconciliation<T> {
    let front_names: Vec<String> = from_frontend.iter().map(&name_of).collect();
    let resolved_names: Vec<String> = resolved.iter().map(&name_of).collect();

    let merged: Vec<T> = from_frontend
        .iter()
        .filter(|e| resolved_names.contains(&name_of(e)))
        .cloned()
        .collect();
    let dropped: Vec<String> =
        front_names.iter().filter(|n| !resolved_names.contains(n)).cloned().collect();
    let not_added: Vec<String> =
        resolved_names.iter().filter(|n| !front_names.contains(n)).cloned().collect();
    McpReconciliation { merged, dropped, not_added }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE SMALLER LIST WINS, in BOTH directions — the opposite of the union every other flip uses.
    /// An advertised server that cannot spawn is spent on retries and misdiagnosis; one the agent is
    /// never told about costs nothing.
    #[test]
    fn the_smaller_list_wins_and_both_directions_are_reported() {
        let front = vec!["research".to_string(), "ghost".to_string()];
        let resolved = vec!["research".to_string(), "unseen".to_string()];
        let r = reconcile_mcp(&front, &resolved, |s: &String| s.clone());
        assert_eq!(r.merged, vec!["research".to_string()], "only what BOTH vouched for");
        assert_eq!(r.dropped, vec!["ghost".to_string()], "the frontend's extra is dropped");
        assert_eq!(r.not_added, vec!["unseen".to_string()], "and the resolution's is NOT added");
    }

    /// Agreement is silent and changes nothing — the property that makes the narrowing safe to land.
    #[test]
    fn agreement_narrows_nothing() {
        let both = vec!["research".to_string(), "compliance".to_string()];
        let r = reconcile_mcp(&both, &both, |s: &String| s.clone());
        assert_eq!(r.merged, both);
        assert!(r.dropped.is_empty() && r.not_added.is_empty());
    }

    /// THE TWO CONSUMERS MUST NOT SHARE A LIST, which is the item's central warning. `.mcp.json` keeps
    /// an http server; `$BSC_AGENT_MCP` drops it, because that client cannot speak http and an http
    /// entry hands it a config it fails on. Asserted from ONE resolution narrowed two ways, so a
    /// future change that collapses them fails here rather than in a session.
    #[test]
    fn the_two_consumers_narrow_the_same_resolution_differently() {
        let library = vec![
            srv("research", "stdio", true, Some("node"), None),
            srv("dashboard", "http", true, None, Some("https://x")),
        ];
        let ids = vec!["research".to_string(), "dashboard".to_string()];
        let resolved = resolve_persona_mcp(&library, &ids, &[]);

        let payloads: Vec<McpServerCfg> = resolved.iter().filter_map(to_mcp_payload).collect();
        // `.mcp.json` KEEPS the http server.
        assert!(
            payloads.iter().any(|p| p.name == "dashboard"),
            "the mcp.json consumer keeps http: {:?}",
            payloads.iter().map(|p| &p.name).collect::<Vec<_>>()
        );
        // `$BSC_AGENT_MCP` DROPS it.
        let stdio = to_bsc_agent_mcp(&payloads);
        assert!(stdio.iter().any(|e| e.name == "research"), "stdio survives");
        assert!(
            !stdio.iter().any(|e| e.name == "dashboard"),
            "an http entry must never reach the agent client: {:?}",
            stdio.iter().map(|e| &e.name).collect::<Vec<_>>()
        );
        assert_ne!(payloads.len(), stdio.len(), "the two lists are genuinely different");
    }

    fn fixture() -> serde_json::Value {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("mcpResolution.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one mcpResolution.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    fn servers(v: &serde_json::Value) -> Vec<McpServer> {
        serde_json::from_value(v.clone()).expect("servers")
    }
    fn ids(v: &serde_json::Value) -> Vec<String> {
        v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
    }

    /// Reports every mismatch at once, comparing ids IN ORDER — the order is what a readable
    /// `.mcp.json` diff rests on, so a set comparison would miss the thing most worth pinning.
    #[test]
    fn the_mcp_resolution_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let builtins = servers(&doc["builtins"]);
        let stored = servers(&doc["stored"]);
        assert!(builtins.len() >= 3, "only {} built-ins — the ambient/carried split needs both kinds", builtins.len());
        assert!(
            builtins.iter().any(|b| !b.enabled),
            "no DISABLED built-in in the corpus — the carried-beats-toggle rule would be untested"
        );

        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 10, "fixture shrank to {} cases — regenerate it", cases.len());

        let (mut sandboxed_n, mut http_dropped) = (0usize, 0usize);
        let mut mismatches = Vec::new();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let persona: Vec<String> = ids(&case["personaMcp"]);
            let sandboxed = case["sandboxed"].as_bool().unwrap();
            if sandboxed {
                sandboxed_n += 1;
            }

            let resolved = resolve_persona_mcp(&stored, &persona, &builtins);
            let got_resolved: Vec<String> = resolved.iter().map(|s| s.id.clone()).collect();
            if got_resolved != ids(&case["resolvedIds"]) {
                mismatches.push(format!(
                    "  {label} [resolved]\n    ts   {:?}\n    rust {got_resolved:?}",
                    ids(&case["resolvedIds"])
                ));
            }

            let reachable = mcp_reachable_from(&resolved, sandboxed, &builtins);
            let got_reachable: Vec<String> = reachable.iter().map(|s| s.id.clone()).collect();
            if got_reachable != ids(&case["reachableIds"]) {
                mismatches.push(format!(
                    "  {label} [reachable]\n    ts   {:?}\n    rust {got_reachable:?}",
                    ids(&case["reachableIds"])
                ));
            }

            let payloads: Vec<McpServerCfg> = reachable.iter().filter_map(to_mcp_payload).collect();
            let want_payloads = case["payloads"].as_array().unwrap();
            if payloads.len() != want_payloads.len() {
                mismatches.push(format!("  {label} [payloads] ts={} rust={}", want_payloads.len(), payloads.len()));
            } else {
                for (g, w) in payloads.iter().zip(want_payloads) {
                    if g.name != w["name"].as_str().unwrap()
                        || g.transport != w["transport"].as_str().unwrap()
                        || g.args != ids(&w["args"])
                    {
                        mismatches.push(format!("  {label} [payload {}] differs", g.name));
                    }
                }
            }

            let agent = to_bsc_agent_mcp(&payloads);
            let want_agent = case["bscAgent"].as_array().unwrap();
            if payloads.iter().any(|p| p.transport == "http") && agent.len() < payloads.len() {
                http_dropped += 1;
            }
            let got_names: Vec<&str> = agent.iter().map(|a| a.name.as_str()).collect();
            let want_names: Vec<&str> = want_agent.iter().map(|a| a["name"].as_str().unwrap()).collect();
            if got_names != want_names {
                mismatches.push(format!("  {label} [bscAgent]\n    ts   {want_names:?}\n    rust {got_names:?}"));
            }
        }
        assert!(sandboxed_n >= 2, "only {sandboxed_n} sandboxed cases");
        assert!(http_dropped >= 1, "no case exercised the stdio-only narrowing");
        assert!(
            mismatches.is_empty(),
            "the Rust resolution disagrees with the live TypeScript on {} point(s):\n{}",
            mismatches.len(),
            mismatches.join("\n")
        );
    }

    fn srv(id: &str, transport: &str, enabled: bool, command: Option<&str>, url: Option<&str>) -> McpServer {
        McpServer {
            id: id.into(),
            name: id.into(),
            transport: transport.into(),
            command: command.map(str::to_string),
            args: String::new(),
            url: url.map(str::to_string),
            env: Vec::new(),
            enabled,
        }
    }

    /// CARRYING IS INTENT. A disabled server is included when a persona names it — that is what sends
    /// one server to one persona instead of the whole fleet.
    #[test]
    fn a_carried_server_is_included_even_when_disabled() {
        let stored = vec![srv("off", "stdio", false, Some("/bin/x"), None)];
        assert!(resolve_persona_mcp(&stored, &[], &[]).is_empty(), "not ambient");
        assert_eq!(
            resolve_persona_mcp(&stored, &["off".to_string()], &[]).len(),
            1,
            "carried anyway — intent beats the toggle"
        );
    }

    /// An ENABLED built-in is ambient; a DISABLED one is not, and reaches only a persona that names it.
    #[test]
    fn an_enabled_builtin_is_ambient_and_a_disabled_one_is_not() {
        let builtins = vec![
            srv("b-on", "stdio", true, Some("/bin/b"), None),
            srv("b-off", "stdio", false, Some("/bin/b"), None),
        ];
        let ambient: Vec<String> =
            resolve_persona_mcp(&[], &[], &builtins).into_iter().map(|s| s.id).collect();
        assert_eq!(ambient, vec!["b-on"], "only the enabled built-in is ambient");

        let carried: Vec<String> = resolve_persona_mcp(&[], &["b-off".to_string()], &builtins)
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(carried, vec!["b-on", "b-off"], "and the disabled one reaches the persona that named it");
    }

    /// Built-ins lead, whatever the stored order is.
    #[test]
    fn builtins_are_emitted_first() {
        let builtins = vec![srv("b", "stdio", true, Some("/bin/b"), None)];
        let stored = vec![srv("s", "stdio", true, Some("/bin/s"), None)];
        let out: Vec<String> = resolve_persona_mcp(&stored, &["s".to_string()], &builtins)
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(out, vec!["b", "s"], "a churning .mcp.json diff is what the other order costs");
    }

    /// A half-configured entry never reaches a session, either way round.
    #[test]
    fn a_half_configured_entry_is_skipped() {
        let stored = vec![
            srv("stdio-nocmd", "stdio", true, None, None),
            srv("http-nourl", "http", true, None, None),
        ];
        assert!(to_mcp_payload(&stored[0]).is_none(), "stdio needs a command");
        assert!(to_mcp_payload(&stored[1]).is_none(), "http needs a url");
        assert!(
            resolve_persona_mcp(&stored, &["stdio-nocmd".into(), "http-nourl".into()], &[]).is_empty(),
            "a broken line must never reach a session .mcp.json"
        );
    }

    /// The two narrowings: bsc-agent is stdio-only, and a namespace cannot spawn the built-ins.
    #[test]
    fn the_two_narrowings_drop_exactly_what_they_claim() {
        let http = srv("h", "http", true, None, Some("https://example/mcp"));
        let stdio = srv("s", "stdio", true, Some("/bin/s"), None);
        let payloads: Vec<McpServerCfg> = [&http, &stdio].into_iter().filter_map(to_mcp_payload).collect();
        assert_eq!(payloads.len(), 2, "the .mcp.json keeps both");
        let agent = to_bsc_agent_mcp(&payloads);
        assert_eq!(agent.len(), 1, "the bsc-agent client is stdio-only");
        assert_eq!(agent[0].name, "s");

        let builtins = vec![srv("b", "stdio", true, Some("/bin/b"), None)];
        let resolved = resolve_persona_mcp(std::slice::from_ref(&stdio), &["s".to_string()], &builtins);
        assert_eq!(mcp_reachable_from(&resolved, false, &builtins).len(), 2, "unsandboxed keeps both");
        let caged: Vec<String> =
            mcp_reachable_from(&resolved, true, &builtins).into_iter().map(|s| s.id).collect();
        assert_eq!(caged, vec!["s"], "only the BUILT-IN is unreachable inside a namespace");
    }

    /// Args split on whitespace, and the payload shape IS the consumer's struct — so the field names
    /// cannot drift from what `write_mcp_json` and `bsc-agent` read.
    ///
    /// THIS TEST WAS SPLIT WHEN THE MODULE MOVED OUT OF THE APP. Its second half round-tripped the
    /// payload through `extensions::mcp::mcp_server_value`, which resolves a bundled binary through
    /// `pty::bsc_bin_path()` and therefore cannot leave the app. Deleting that half would have traded
    /// executed coverage for nothing, so it lives on as
    /// `the_resolved_payload_survives_the_writers_own_serialization` in
    /// `src-tauri/src/extensions/mcp.rs`, next to the function it is about.
    #[test]
    fn args_split_on_whitespace_and_the_payload_is_the_consumers_own_type() {
        let mut s = srv("a", "stdio", true, Some("/bin/a"), None);
        s.args = "  --flag   value  ".to_string();
        let p: McpServerCfg = to_mcp_payload(&s).expect("runnable");
        assert_eq!(p.args, vec!["--flag", "value"], "collapsed, not split into empties");
    }
}
