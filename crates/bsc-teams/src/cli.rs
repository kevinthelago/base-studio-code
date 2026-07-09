//! The `bsc teams` subcommand (#2193, renamed from `bsc org` in #2700 — `bsc org` remains a deprecated
//! alias) — the teams-specific shim over the shared verbatim-JSON-per-id store CLI
//! ([`bsc_json_store::cli`], #2158). The teams library (`~/.base-studio-code/orgs/<id>.json`) is
//! list/get/set/remove-able from a session's own shell — the same store the desktop Team designer
//! reads/writes and the planner can compose into (wire a fleet's positions + relationships).
//!
//! Dispatched by the unified `bsc` binary (#1877) via [`run`]; the shared per-command help (#1762):
//!   bsc teams help          # compact menu
//!   bsc teams get help      # detailed help for ONE command
//!
//! The store is located via `--dir <path>` or the `BSC_ORG_DIR` env var, defaulting to
//! `~/.base-studio-code/orgs/` — both KEPT unchanged (a rename would orphan existing saved data, #2700).

use bsc_cli_util::CmdDoc;
use bsc_json_store::cli::CliSpec;

const TAGLINE: &str = "the user teams store — list/get/set/remove ~/.base-studio-code/orgs (#2193/#2700)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every team's {id, name} (JSON)",
        usage: "\
USAGE:
  bsc teams list [--full] [--pretty]

Prints every team's { id, name } as JSON (compact; --pretty for indented). --full emits the COMPLETE
team objects (positions + relationships + …) as a plain array — the full-fidelity read the desktop
Team-designer hydration needs.",
    },
    CmdDoc {
        name: "get",
        summary: "print one team (JSON, verbatim) or null",
        usage: "\
USAGE:
  bsc teams get <id> [--pretty]

Prints the stored team JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from team JSON on stdin; prints id(s)",
        usage: "\
USAGE:
  bsc teams set [--pretty]   # team JSON (one object or an array) on stdin

Upserts each team by its (required, non-empty) \"id\" field, written verbatim. Prints the id(s)
written. Use this to author or update a team from a session (the planner composes a fleet this way).",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a team (no-op if absent)",
        usage: "\
USAGE:
  bsc teams remove <id> [--pretty]

Deletes the team keyed by <id>. A no-op (not an error) when it does not exist.",
    },
];

/// The teams store's concrete knobs over the shared CLI (#2158): its noun, env var, dir segment, help
/// catalog, and the `{id, name}` lean-`list` projection. NOTE (#2700): `noun`/`dir_env`/`dir_segment`
/// stay `org`/`BSC_ORG_DIR`/`orgs` — the on-disk store keeps its birth name so existing users' saved
/// data is not orphaned; only the crate + the `bsc teams` verb are renamed.
const SPEC: CliSpec = CliSpec {
    noun: "org",
    dir_env: "BSC_ORG_DIR",
    dir_segment: "orgs",
    tagline: TAGLINE,
    commands: COMMANDS,
    meta_fields: &["id", "name"],
};

/// The `teams` subcommand entrypoint: `args` is everything after `bsc teams` (or the deprecated
/// `bsc org`); `prog` is the display name for help/errors. Delegates to the shared dispatch with the
/// teams [`SPEC`].
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    bsc_json_store::cli::run(args, prog, &SPEC)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_keeps_the_orgs_on_disk_store() {
        // #2700: the crate + verb are "teams", but the store dir + env stay "orgs"/"BSC_ORG_DIR" so a
        // rename never orphans existing users' saved data.
        assert_eq!(SPEC.noun, "org");
        assert_eq!(SPEC.dir_env, "BSC_ORG_DIR");
        assert_eq!(SPEC.dir_segment, "orgs");
        assert_eq!(SPEC.meta_fields, &["id", "name"]);
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc teams", TAGLINE, COMMANDS);
        for c in ["list", "get", "set", "remove"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        let one = bsc_cli_util::help_for("bsc teams", TAGLINE, COMMANDS, "set");
        assert!(one.contains("bsc teams set"));
        assert!(one.contains("stdin"));
        assert!(bsc_cli_util::help_for("bsc teams", TAGLINE, COMMANDS, "nope").contains("COMMANDS:"));
    }
}
