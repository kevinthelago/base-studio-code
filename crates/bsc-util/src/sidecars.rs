//! The canonical registry of `bsc` subcommands (#1843 / #1877).
//!
//! The app ships ONE umbrella binary — `bsc` — that dispatches every state-store CLI as a
//! subcommand (`bsc plan …`, `bsc skill …`, `bsc mcp research`, …). The set of subcommands a live
//! session reaches — their names, project-store envs, and one-line purposes — was hand-maintained in
//! several places that drifted independently:
//!   - `console/pty/mod.rs` (`wire_bsc_env`) — staging the one `bsc` binary into `$BSC_BIN`,
//!   - `console/shell_rc.rs` — the single `bsc` shell helper that execs it,
//!   - `bsc-agent`'s prompt block — the "Project CLIs available this session" inventory,
//!   - `bsc-agent/data/agent-instructions.md` — the prose list.
//!
//! This is the ONE source of truth all of them read. Every subcommand invokes through the SAME
//! binary (`"$BSC_BIN" <name> …`) — no per-CLI env var, no PATH changes; the only env a session
//! needs is `$BSC_BIN` (the staged `bsc`) plus, for the cwd-derived stores, their `context_env`.

/// One `bsc` subcommand: a state-store CLI a live session reaches by invoking the unified `bsc`
/// binary (`"$BSC_BIN" <name> …`) — no PATH changes, no per-CLI binary.
pub struct Sidecar {
    /// The subcommand name (`plan`) — invoked as `bsc plan …`. Also the agent's advertised tool name.
    pub name: &'static str,
    /// A *project*-scoped store env that must ALSO be set for this subcommand to reach its data
    /// (`BSC_PLAN_DB`, `BSC_DATA_DB`). `None` for global stores (skill/compliance set their store env
    /// unconditionally) or none — so the agent prompt only flags "needs a project context" for the
    /// cwd-derived ones.
    pub context_env: Option<&'static str>,
    /// One-line purpose, shown to the agent in its CLI block.
    pub blurb: &'static str,
    /// Whether `bsc-agent` advertises this subcommand in its prompt block + registers it as a
    /// directly-callable tool. (Every subcommand the app wires is advertised; the field is kept so a
    /// future internal-only subcommand can opt out.)
    pub advertise: bool,
}

/// Every `bsc` subcommand the app wires into a session, in the order the agent's CLI block renders.
/// Staging is binary-level (`$BSC_BIN`), so this list no longer drives staging — it drives the agent
/// prompt block (the `advertise` subset) and the shell-helper drift guard.
pub const SIDECARS: &[Sidecar] = &[
    Sidecar {
        name: "plan", context_env: Some("BSC_PLAN_DB"),
        blurb: "this project's plan store: issues, features, fleet streams, phases, prose sections",
        advertise: true,
    },
    Sidecar {
        name: "data", context_env: Some("BSC_DATA_DB"),
        blurb: "the Data Model + Platform Behavior Summary + entity tables; REST connectors",
        advertise: true,
    },
    Sidecar {
        name: "skill", context_env: None,
        blurb: "the global skills library + task-groups",
        advertise: true,
    },
    Sidecar {
        name: "logs", context_env: None,
        blurb: "query this session's logs (tools/skills/mcp/hooks/cost/coord/activity) + perf (read-only)",
        advertise: true,
    },
    Sidecar {
        name: "compliance", context_env: None,
        blurb: "the compliance standards corpus (accessibility/privacy/security obligations)",
        advertise: true,
    },
    Sidecar {
        name: "blueprint", context_env: None,
        blurb: "the user blueprint library",
        advertise: true,
    },
    Sidecar {
        name: "persona", context_env: None,
        blurb: "the user persona library: agent identities (start prompt + skills + model over a role)",
        advertise: true,
    },
    Sidecar {
        name: "org", context_env: None,
        blurb: "the user org library: the persona-relationship graph (positions wired by relationships)",
        advertise: true,
    },
    Sidecar {
        name: "component", context_env: None,
        blurb: "the component library: proven components in technology-scoped kits (reuse, don't re-invent)",
        advertise: true,
    },
    Sidecar {
        name: "project", context_env: None,
        blurb: "list local projects + read/set the published marker",
        advertise: true,
    },
    Sidecar {
        name: "files", context_env: None,
        blurb: "the project's file tree with metrics + single-path stat",
        advertise: true,
    },
];

// ── Bundled MCP-server subcommands (#1848 / #1877) ───────────────────────────────────
//
// The two bundled native MCP servers are no longer separate binaries — they are subcommands of the
// unified `bsc` binary (`bsc mcp research` / `bsc mcp compliance`). The constants below are the
// `.mcp.json` command SENTINELS the frontend writes (it can't know where the app exe lives); the app
// rewrites each sentinel to `"$BSC_BIN" mcp <sub>` at write time (`extensions/mcp.rs`). They live
// here so each server's marker is defined ONCE.

/// The Research MCP server (#1196) — the `.mcp.json` command sentinel, rewritten to `bsc mcp research`.
pub const RESEARCH_MCP: &str = "bsc-research-mcp";
/// The Compliance MCP server (#1005) — the `.mcp.json` command sentinel, rewritten to `bsc mcp compliance`.
pub const COMPLIANCE_MCP: &str = "bsc-compliance-mcp";

/// Every app-shipped binary's stem — now just the unified `bsc` umbrella plus the model-agnostic
/// `bsc-agent` runtime (#1877). Every state CLI + the two MCP servers are subcommands of `bsc`, so
/// they are no longer separate binaries. This is the ONE inventory `sidecar_bin_path` resolves beside
/// the app exe + the `externalBin` set the bundler ships.
pub fn all_bundled_names() -> Vec<&'static str> {
    vec!["bsc", "bsc-agent"]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_internally_consistent() {
        // Names are the `bsc` subcommands — lowercase, hyphen/space-free, and unique.
        let mut names = std::collections::HashSet::new();
        for s in SIDECARS {
            assert!(
                s.name.chars().all(|c| c.is_ascii_lowercase()),
                "{} is not a bare lowercase subcommand", s.name,
            );
            assert!(names.insert(s.name), "duplicate name {}", s.name);
        }
    }

    #[test]
    fn only_cwd_derived_project_stores_carry_a_context_env() {
        // The agent prompt's "needs a project context" caveat must fire ONLY for the two cwd-derived
        // project stores; the global/none subcommands must not be flagged.
        for s in SIDECARS {
            let scoped = matches!(s.name, "plan" | "data");
            assert_eq!(s.context_env.is_some(), scoped, "{} context_env scoping wrong", s.name);
        }
        assert_eq!(SIDECARS.iter().find(|s| s.name == "plan").unwrap().context_env, Some("BSC_PLAN_DB"));
        assert_eq!(SIDECARS.iter().find(|s| s.name == "data").unwrap().context_env, Some("BSC_DATA_DB"));
    }

    #[test]
    fn advertised_set_is_the_known_subcommand_order() {
        let advertised: Vec<&str> = SIDECARS.iter().filter(|s| s.advertise).map(|s| s.name).collect();
        assert_eq!(
            advertised,
            ["plan", "data", "skill", "logs", "compliance", "blueprint", "persona", "org", "component", "project", "files"],
            "the advertised set + order is what the agent prompt block renders (as `bsc <sub>`)",
        );
    }

    #[test]
    fn bundled_binaries_are_just_bsc_and_the_agent_runtime() {
        // #1877: the app ships exactly two binaries — the `bsc` umbrella (every state CLI + the two
        // MCP servers are its subcommands) and the model-agnostic `bsc-agent` runtime. The MCP server
        // markers are `.mcp.json` command sentinels, NOT separate binaries.
        let all = all_bundled_names();
        assert_eq!(all, ["bsc", "bsc-agent"]);
        let unique: std::collections::HashSet<&str> = all.iter().copied().collect();
        assert_eq!(all.len(), unique.len(), "no bundled binary appears twice");
        // The MCP server markers stay registered as sentinels but are not bundled binaries any more.
        assert_eq!(RESEARCH_MCP, "bsc-research-mcp");
        assert_eq!(COMPLIANCE_MCP, "bsc-compliance-mcp");
        assert!(!all.contains(&RESEARCH_MCP) && !all.contains(&COMPLIANCE_MCP));
    }
}
