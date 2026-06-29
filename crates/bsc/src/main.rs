//! `bsc` — the unified base-studio-code CLI (#1877). One binary; `bsc <command>` dispatches to each
//! state store / tool that used to be its own `bsc-*` sidecar. The shared help scaffold lives in
//! `bsc-cli-util`; each subcommand's logic lives in its owning crate's `cli` module.
//!
//! `bsc help` / `bsc` prints the command overview; `bsc <command> help` drills into one command.

use std::process::ExitCode;

/// One row per top-level command for the `bsc help` overview. The detailed per-command help comes
/// from each crate's own `CmdDoc` catalog (via `bsc <command> help`).
const COMMANDS: &[(&str, &str)] = &[
    ("project", "cross-project hub: list local projects + the .published marker"),
    // Added as the migration lands (#1877):
    // ("plan", …) ("skill", …) ("compliance", …) ("blueprint", …) ("logs", …)
    // ("files", …) ("data", …) ("mcp", …)
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
        "project" => bsc_project::cli::run(rest, "bsc project"),
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
