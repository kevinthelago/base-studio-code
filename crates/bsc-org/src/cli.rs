//! The `bsc org` subcommand (#2193) — the org-specific shim over the shared verbatim-JSON-per-id store
//! CLI ([`bsc_json_store::cli`], #2158). The org library (`~/.base-studio-code/orgs/<id>.json`) is
//! list/get/set/remove-able from a session's own shell — the same store the desktop Org designer
//! reads/writes and the planner can compose into (wire a fleet's positions + relationships).
//!
//! Dispatched by the unified `bsc` binary (#1877) via [`run`]; the shared per-command help (#1762):
//!   bsc org help          # compact menu
//!   bsc org get help      # detailed help for ONE command
//!
//! The store is located via `--dir <path>` or the `BSC_ORG_DIR` env var, defaulting to
//! `~/.base-studio-code/orgs/`.

use bsc_cli_util::CmdDoc;
use bsc_json_store::cli::CliSpec;

const TAGLINE: &str = "the user org store — list/get/set/remove ~/.base-studio-code/orgs (#2193)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every org's {id, name} (JSON)",
        usage: "\
USAGE:
  bsc org list [--full] [--pretty]

Prints every org's { id, name } as JSON (compact; --pretty for indented). --full emits the COMPLETE
org objects (positions + relationships + …) as a plain array — the full-fidelity read the desktop
Org-designer hydration needs.",
    },
    CmdDoc {
        name: "get",
        summary: "print one org (JSON, verbatim) or null",
        usage: "\
USAGE:
  bsc org get <id> [--pretty]

Prints the stored org JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from org JSON on stdin; prints id(s)",
        usage: "\
USAGE:
  bsc org set [--pretty]   # org JSON (one object or an array) on stdin

Upserts each org by its (required, non-empty) \"id\" field, written verbatim. Prints the id(s)
written. Use this to author or update an org from a session (the planner composes a fleet this way).",
    },
    CmdDoc {
        name: "remove",
        summary: "delete an org (no-op if absent)",
        usage: "\
USAGE:
  bsc org remove <id> [--pretty]

Deletes the org keyed by <id>. A no-op (not an error) when it does not exist.",
    },
];

/// The org store's concrete knobs over the shared CLI (#2158): its noun, env var, dir segment, help
/// catalog, and the `{id, name}` lean-`list` projection.
const SPEC: CliSpec = CliSpec {
    noun: "org",
    dir_env: "BSC_ORG_DIR",
    dir_segment: "orgs",
    tagline: TAGLINE,
    commands: COMMANDS,
    meta_fields: &["id", "name"],
};

/// The `org` subcommand entrypoint: `args` is everything after `bsc org`; `prog` is the display name
/// for help/errors. Delegates to the shared dispatch with the org [`SPEC`].
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    bsc_json_store::cli::run(args, prog, &SPEC)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_is_the_org_store() {
        assert_eq!(SPEC.noun, "org");
        assert_eq!(SPEC.dir_env, "BSC_ORG_DIR");
        assert_eq!(SPEC.dir_segment, "orgs");
        assert_eq!(SPEC.meta_fields, &["id", "name"]);
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc org", TAGLINE, COMMANDS);
        for c in ["list", "get", "set", "remove"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        let one = bsc_cli_util::help_for("bsc org", TAGLINE, COMMANDS, "set");
        assert!(one.contains("bsc org set"));
        assert!(one.contains("stdin"));
        assert!(bsc_cli_util::help_for("bsc org", TAGLINE, COMMANDS, "nope").contains("COMMANDS:"));
    }
}
