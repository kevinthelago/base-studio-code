//! `bsc` — the unified base-studio-code CLI (#1877). One binary; `bsc <command>` dispatches to each
//! state store / tool that used to be its own `bsc-*` sidecar. The shared help scaffold lives in
//! `bsc-cli-util`; each subcommand's logic lives in its owning crate's `cli` module.
//!
//! `bsc help` / `bsc` prints the command overview; `bsc <command> help` drills into one command.

use std::process::ExitCode;

mod defer;
mod hook;

/// One row per top-level command for the `bsc help` overview. The detailed per-command help comes
/// from each crate's own `CmdDoc` catalog (via `bsc <command> help`).
const COMMANDS: &[(&str, &str)] = &[
    ("plan", "per-project plan store: issues, features, fleet, sections"),
    ("errors", "per-project runtime-fault store: fingerprinted errors + alerts"),
    ("usage", "per-project usage-events store: record + query what users do (epic #3809)"),
    ("project", "cross-project hub: list local projects + the .published marker"),
    ("skill", "global skills + task-groups store"),
    ("compliance", "compliance standards corpus"),
    ("blueprint", "user blueprint store"),
    ("persona", "user persona store: agent identities (prompt + skills + model over a role)"),
    ("sound", "user sound-kit store: synthesized cues (primitives + voices + cues)"),
    ("teams", "user teams store: persona-relationship graph (positions + relationships)"),
    ("studio", "Studio store: shareable snapshots of the app's library state (save · apply · list · get · remove)"),
    ("org", "DEPRECATED (#2700) → use `bsc teams` (the store, renamed org → teams)"),
    ("component", "DEPRECATED (#2469) → use `bsc ui` (the component verbs now live there)"),
    ("ui", "UI design surface: the primitive contract + themes (#1852) + the component library (#2469) + the released-kit store (release, #2465)"),
    ("logs", "unified logs + perf + cost (read-only) + `logs scope` runtime console-scope control"),
    ("files", "file-ops toolkit: read/write/edit/list/info"),
    ("shot", "capture the RUNNING app's real pixels — a webview snapshot (needs the app running)"),
    ("navigate", "steer the RUNNING app to a view — so a capture can target something"),
    ("metrics", "fleet-wide generation scoreboard — $ / tokens / cache-hit / wall-clock per project"),
    ("debug", "inspect the RUNNING app's live DOM + preview state (read-only)"),
    ("loop", "conversation loop store: two participants exchange turns until a signal ends it, or never (#3262)"),
    ("request", "improvement-request store: the designer→debug channel for bsc ui surface gaps (#3295)"),
    ("graph", "algorithms knowledge library: per-language implementations (impl list · dump · harvest · curate)"),
    ("cad", "mesh/SDF geometry kernel (mm): mesh an op-tree spec into a binary STL"),
    ("data", "canonical data model (DuckDB): model · scan · tables · connector"),
    ("cve", "vulnerability data (OSV.dev): scan a lockfile · check a package · advisory detail (supply-chain #2433)"),
    ("mcp", "bundled MCP servers (stdio JSON-RPC): research · compliance · cve"),
    ("hook", "internal PreToolUse deny hooks (run by Claude Code, not by hand)"),
];

fn top_help() -> String {
    let mut s = String::from(
        "bsc — the base-studio-code CLI (#1877)\n\n\
         USAGE:\n  \
         bsc <command> [args]\n  \
         bsc help              # this overview\n  \
         bsc <command> help    # detail for one command\n\n\
         COMMANDS:\n",
    );
    let w = COMMANDS.iter().map(|(n, _)| n.len()).max().unwrap_or(0);
    for (name, summary) in COMMANDS {
        s.push_str(&format!("  {name:<w$}  {summary}\n"));
    }
    s
}

fn dispatch(cmd: &str, rest: Vec<String>) -> Result<(), String> {
    match cmd {
        "plan" => plandb::cli::run(rest, "bsc plan"),
        "errors" => errordb::cli::run(rest, "bsc errors"),
        "usage" => usagedb::cli::run(rest, "bsc usage"),
        "project" => bsc_project::cli::run(rest, "bsc project"),
        "skill" => skilldb::cli::run(rest, "bsc skill"),
        "compliance" => compliance::cli::run(rest, "bsc compliance"),
        "blueprint" => bsc_blueprint::cli::run(rest, "bsc blueprint"),
        "persona" => bsc_persona::cli::run(rest, "bsc persona"),
        "sound" => bsc_sound::cli::run(rest, "bsc sound"),
        "teams" => bsc_teams::cli::run(rest, "bsc teams"),
        "studio" => bsc_studio::cli::run(rest, "bsc studio"),
        // Deprecated alias (#2700, the #2469 `bsc component` → `bsc ui` pattern): `bsc org` still routes
        // to the SAME teams store handler — live agent sessions call it, so it must keep working. The
        // pointer goes to STDERR so stdout stays clean JSON for pipes.
        "org" => {
            eprintln!("`bsc org` is deprecated; use `bsc teams`");
            bsc_teams::cli::run(rest, "bsc org")
        }
        // Deprecated alias (#2469, the #1721 `bsc plan integration` pattern): the component verbs
        // moved under `bsc ui`. Same behavior via the same delegate; the pointer goes to STDERR so
        // stdout stays clean JSON for pipes.
        "component" => {
            eprintln!("`bsc component` is deprecated; use `bsc ui`");
            bsc_component::cli::run(rest, "bsc component")
        }
        "ui" => bsc_ui::cli::run(rest, "bsc ui"),
        "logs" => logs::cli::run(rest, "bsc logs"),
        "metrics" => logs::metrics::run(rest, "bsc metrics"),
        "files" => bsc_files::cli::run(rest, "bsc files"),
        "shot" => bsc_shot::cli::run(rest, "bsc shot"),
        "navigate" => bsc_navigate::cli::run(rest, "bsc navigate"),
        "debug" => bsc_debug::cli::run(rest, "bsc debug"),
        "loop" => bsc_loop::cli::run(rest, "bsc loop"),
        "request" => bsc_request::cli::run(rest, "bsc request"),
        "graph" => bsc_graph::cli::run(rest, "bsc graph"),
        "cad" => bsc_cad::cli::run(rest, "bsc cad"),
        #[cfg(feature = "data")]
        "data" => bsc_data::cli::run(rest, "bsc data"),
        "cve" => cve::cli::run(rest, "bsc cve"),
        "mcp" => run_mcp(rest),
        "hook" => hook::run(&rest),
        "" | "help" | "-h" | "--help" => {
            print!("{}", top_help());
            Ok(())
        }
        other => Err(format!("unknown command '{other}'\n\n{}", top_help())),
    }
}

/// `bsc mcp <server>` (#1877): the bundled native MCP servers — once standalone `bsc-research-mcp` /
/// `bsc-compliance-mcp` binaries — are now subcommands of the umbrella. Each builds its server from
/// the environment and runs the shared stdio JSON-RPC loop (`mcp_rpc::run_stdio_server`), so the app's
/// `.mcp.json` spawns `bsc mcp research` / `bsc mcp compliance` instead of a separate binary.
fn run_mcp(rest: Vec<String>) -> Result<(), String> {
    let server = rest.first().map(String::as_str).unwrap_or("");
    match server {
        "research" => mcp_rpc::run_stdio_server(&research::mcp::Server::from_env()?),
        "compliance" => mcp_rpc::run_stdio_server(&compliance::mcp::Server::from_env()?),
        "cve" => mcp_rpc::run_stdio_server(&cve::mcp::Server::from_env()?),
        "channel-mock" => mcp_rpc::run_stdio_server(&channel::mock::Server::from_env()?),
        "" | "help" | "-h" | "--help" => {
            print!("{}", mcp_help());
            Ok(())
        }
        other => Err(format!("unknown mcp server '{other}'\n\n{}", mcp_help())),
    }
}

fn mcp_help() -> String {
    String::from(
        "bsc mcp — bundled native MCP servers (stdio JSON-RPC 2.0)\n\n\
         USAGE:\n  \
         bsc mcp <server>\n\n\
         SERVERS:\n  \
         research      literature grounding (arXiv · Semantic Scholar · PubMed · Crossref)\n  \
         compliance    compliance standards corpus (WCAG · GDPR · CCPA · SOC 2)\n  \
         cve           vulnerability data (OSV.dev) — scan a lockfile · check a package · advisory detail\n  \
         channel-mock  the Marketer's mock marketing channel — records send_email/post/schedule (no real sends)\n\n\
         These are spawned by Claude Code from the project's .mcp.json; you rarely run them by hand.\n",
    )
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();
    let cmd = argv.get(1).map(String::as_str).unwrap_or("");
    let rest: Vec<String> = argv.iter().skip(2).cloned().collect();
    bsc_cli_util::cli_main("bsc", || dispatch(cmd, rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_help_lists_the_mock_marketing_channel() {
        let h = mcp_help();
        assert!(h.contains("channel-mock"), "the bundled mock marketing channel is listed (#3146)");
        assert!(h.contains("research") && h.contains("compliance"), "the existing servers stay listed");
    }

    #[test]
    fn top_help_marks_component_deprecated_and_points_at_ui() {
        let h = top_help();
        assert!(h.contains("DEPRECATED (#2469)"), "component row carries the deprecation pointer");
        assert!(h.contains("`bsc ui`"), "... aimed at the merged `bsc ui` surface");
        assert!(h.contains("UI design surface"), "the ui row describes the merged surface");
    }

    #[test]
    fn ui_and_the_component_alias_both_dispatch() {
        // Help paths — no store required. The alias still works (delegating + warning on stderr).
        assert!(dispatch("ui", vec!["help".into()]).is_ok());
        assert!(dispatch("component", vec!["help".into()]).is_ok());
    }

    #[test]
    fn top_help_marks_org_deprecated_and_points_at_teams() {
        let h = top_help();
        assert!(h.contains("DEPRECATED (#2700)"), "the org row carries the deprecation pointer");
        assert!(h.contains("`bsc teams`"), "... aimed at the renamed teams store");
        assert!(h.contains("user teams store"), "the teams row describes the store");
    }

    #[test]
    fn studio_dispatches_and_appears_in_the_overview() {
        // #2890: the Studio store is mounted + listed. Help path — no store required.
        assert!(dispatch("studio", vec!["help".into()]).is_ok());
        assert!(top_help().contains("Studio store"), "the studio row describes the store");
    }

    #[test]
    fn sound_dispatches_and_appears_in_the_overview() {
        // #3080: the sound-kit store is mounted + listed. Help path — no store required.
        assert!(dispatch("sound", vec!["help".into()]).is_ok());
        assert!(top_help().contains("user sound-kit store"), "the sound row describes the store");
    }

    #[test]
    fn loop_dispatches_and_appears_in_the_overview() {
        // #3262: the conversation loop store is mounted + listed. Help path — no store required.
        assert!(dispatch("loop", vec!["help".into()]).is_ok());
        assert!(top_help().contains("conversation loop store"), "the loop row describes the store");
    }

    #[test]
    fn request_dispatches_and_appears_in_the_overview() {
        // #3295: the improvement-request store is mounted + listed. Help path — no store required.
        assert!(dispatch("request", vec!["help".into()]).is_ok());
        assert!(top_help().contains("improvement-request store"), "the request row describes the store");
    }

    #[test]
    fn cad_dispatches_and_appears_in_the_overview() {
        // #3387: the geometry kernel (#2621) is mounted + listed, so a live session reaches it via
        // $BSC_BIN with no PATH changes. Help path — no spec file required.
        assert!(dispatch("cad", vec!["help".into()]).is_ok());
        assert!(top_help().contains("mesh/SDF geometry kernel"), "the cad row describes the kernel");
    }

    #[test]
    fn cve_dispatches_and_appears_in_the_overview() {
        // #3797: the OSV.dev vulnerability data layer is mounted + listed, and its MCP server is
        // reachable via `bsc mcp cve`. Help paths — no cache/network required.
        assert!(dispatch("cve", vec!["help".into()]).is_ok());
        assert!(top_help().contains("vulnerability data"), "the cve row describes the data layer");
        assert!(mcp_help().contains("cve"), "bsc mcp cve is listed as a bundled server");
    }

    #[test]
    fn usage_dispatches_and_appears_in_the_overview() {
        // #3812 (epic #3809): the per-project usage-events store is mounted + listed. Help path — no db.
        assert!(dispatch("usage", vec!["help".into()]).is_ok());
        assert!(top_help().contains("usage-events store"), "the usage row describes the store");
    }

    #[test]
    fn an_unmounted_command_is_still_refused() {
        // The counterpart to every "X dispatches" test: adding `cad` must not have widened the
        // fallthrough. An unknown command errors with the overview attached.
        let e = dispatch("cadd", vec![]).unwrap_err();
        assert!(e.contains("unknown command 'cadd'"));
        assert!(e.contains("COMMANDS:"), "the refusal carries the command overview");
    }

    #[test]
    fn teams_and_the_org_alias_both_dispatch() {
        // #2700: `bsc teams` is the primary verb; `bsc org` stays a deprecated alias onto the same
        // store handler (delegating + warning on stderr). Help paths — no store required.
        assert!(dispatch("teams", vec!["help".into()]).is_ok());
        assert!(dispatch("org", vec!["help".into()]).is_ok());
    }
}
