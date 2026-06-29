//! `bsc` — the unified base-studio-code CLI (#1877). One binary; `bsc <command>` dispatches to each
//! state store / tool that used to be its own `bsc-*` sidecar. The shared help scaffold lives in
//! `bsc-cli-util`; each subcommand's logic lives in its owning crate's `cli` module.
//!
//! `bsc help` / `bsc` prints the command overview; `bsc <command> help` drills into one command.

use std::process::ExitCode;

/// One row per top-level command for the `bsc help` overview. The detailed per-command help comes
/// from each crate's own `CmdDoc` catalog (via `bsc <command> help`).
const COMMANDS: &[(&str, &str)] = &[
    ("plan", "per-project plan store: issues, features, fleet, sections"),
    ("project", "cross-project hub: list local projects + the .published marker"),
    ("skill", "global skills + task-groups store"),
    ("compliance", "compliance standards corpus"),
    ("blueprint", "user blueprint store"),
    ("logs", "unified logs + perf + cost (read-only)"),
    ("files", "file-ops toolkit: read/write/edit/list/info"),
    ("data", "canonical data model (DuckDB): model · scan · tables · connector"),
    // Added as the migration lands (#1877): mcp
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
        "project" => bsc_project::cli::run(rest, "bsc project"),
        "skill" => skilldb::cli::run(rest, "bsc skill"),
        "compliance" => compliance::cli::run(rest, "bsc compliance"),
        "blueprint" => bsc_blueprint::cli::run(rest, "bsc blueprint"),
        "logs" => logs::cli::run(rest, "bsc logs"),
        "files" => bsc_files::cli::run(rest, "bsc files"),
        #[cfg(feature = "data")]
        "data" => bsc_data::cli::run(rest, "bsc data"),
        "" | "help" | "-h" | "--help" => {
            print!("{}", top_help());
            Ok(())
        }
        other => Err(format!("unknown command '{other}'\n\n{}", top_help())),
    }
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();
    let cmd = argv.get(1).map(String::as_str).unwrap_or("");
    let rest: Vec<String> = argv.iter().skip(2).cloned().collect();
    bsc_cli_util::cli_main("bsc", || dispatch(cmd, rest))
}
