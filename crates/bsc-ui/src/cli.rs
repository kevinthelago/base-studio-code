//! The `bsc ui` subcommand (#1852 Phase 2) — the agent-facing face of the spec-first UI SDK. Two
//! read-only commands over the embedded KitNode contract (`crate::CONTRACT_JSON`):
//!   bsc ui schema              # print the contract (every kind, its fields + enums) — the agent's contract
//!   bsc ui validate [file]     # validate a KitNode spec (a file, else stdin) against the contract
//!
//! So an agent composing UI-as-data can learn the vocabulary (`schema`) and check its work (`validate`)
//! from its own shell, against the exact contract the desktop `KitRenderer` renders. Dispatched by the
//! unified `bsc` binary (#1877) via [`run`]. Per-command help (#1762): `bsc ui help`, `bsc ui <cmd> help`.

use bsc_cli_util::CmdDoc;
use std::io::Read;

const TAGLINE: &str = "the UI spec SDK — the KitNode contract an AI emits UI as data, plus a validator (#1852)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "schema",
        summary: "print the KitNode contract (every kind, its fields + enums)",
        usage: "\
USAGE:
  bsc ui schema [--pretty]

Prints the KitNode contract — every node `kind`, the fields it accepts, which are required, whether it
bears children, and the closed value sets for its enum fields. This is the contract an AI authors UI
against: emit a tree of these nodes and the desktop `KitRenderer` renders it through the shared kit.
Compact JSON by default; --pretty for indented.",
    },
    CmdDoc {
        name: "validate",
        summary: "validate a KitNode spec (file or stdin) against the contract",
        usage: "\
USAGE:
  bsc ui validate <file>     # a KitNode spec JSON file
  bsc ui validate            # ... or read the spec JSON from stdin

Structurally validates the spec against the contract (kind known · required present · no unknown fields
· enums honored · children shape) — the EXACT rules the frontend renderer enforces, so a spec that
passes here renders there. Prints `ok` (exit 0) when valid, else one error per line (exit 1). How an
agent checks a UI spec it authored before handing it off.",
    },
];

/// The `ui` subcommand entrypoint: `args` is everything after `bsc ui`; `prog` is the display name for
/// help/errors.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args) {
        return Ok(());
    }
    match args.first().map(String::as_str) {
        Some("schema") => cmd_schema(&args[1..]),
        Some("validate") => cmd_validate(&args[1..]),
        Some(other) => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
        None => {
            print!("{}", bsc_cli_util::help_overview(prog, TAGLINE, COMMANDS));
            Ok(())
        }
    }
}

fn cmd_schema(args: &[String]) -> Result<(), String> {
    let pretty = args.iter().any(|a| a == "--pretty");
    let contract = crate::contract();
    let out = if pretty {
        serde_json::to_string_pretty(&contract)
    } else {
        serde_json::to_string(&contract)
    };
    println!("{}", out.map_err(|e| e.to_string())?);
    Ok(())
}

fn cmd_validate(args: &[String]) -> Result<(), String> {
    let path = args.iter().find(|a| !a.starts_with("--"));
    let raw = match path {
        Some(p) => std::fs::read_to_string(p).map_err(|e| format!("cannot read {p}: {e}"))?,
        None => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s).map_err(|e| format!("cannot read stdin: {e}"))?;
            s
        }
    };
    let spec: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("spec is not valid JSON: {e}"))?;
    let errors = crate::validate_spec(&spec);
    if errors.is_empty() {
        println!("ok");
        Ok(())
    } else {
        // Non-zero exit + every error on its own line (cli_main prints the string to stderr).
        Err(errors.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_overview_lists_both_commands() {
        let ov = bsc_cli_util::help_overview("bsc ui", TAGLINE, COMMANDS);
        assert!(ov.contains("schema") && ov.contains("validate"));
    }

    #[test]
    fn validate_detail_explains_ok_and_exit() {
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMMANDS, "validate");
        assert!(d.contains("stdin") && d.contains("ok"));
    }

    #[test]
    fn run_help_is_ok_without_args() {
        assert!(run(vec!["help".into()], "bsc ui").is_ok());
        assert!(run(vec![], "bsc ui").is_ok());
    }

    #[test]
    fn run_unknown_command_errors() {
        assert!(run(vec!["frobnicate".into()], "bsc ui").is_err());
    }
}
