//! The `bsc blueprint` subcommand (#1877) — the blueprint-specific shim over the shared
//! verbatim-JSON-per-id store CLI ([`bsc_json_store::cli`], #2158). The user blueprint library
//! (`~/.base-studio-code/blueprints/<id>.json`, #1719) is list/get/set/remove-able from a session's
//! own shell — the same store the desktop blueprint library reads/writes. Built-in blueprints are
//! code/JSON-owned and out of scope; this is the user store only.
//!
//! Dispatched by the unified `bsc` binary (#1877) via [`run`]; the per-command help (#1762):
//!   bsc blueprint help          # compact menu (the small "what commands exist" prompt)
//!   bsc blueprint get help      # detailed help for ONE command
//!
//! The store is located via `--dir <path>` or the `BSC_BLUEPRINT_DIR` env var (set per-session at
//! launch), defaulting to `~/.base-studio-code/blueprints/`.

use bsc_cli_util::CmdDoc;
use bsc_json_store::cli::CliSpec;

const TAGLINE: &str = "the user blueprint store — list/get/set/remove ~/.base-studio-code/blueprints (#1719)";

/// The command catalog — drives both dispatch and the shared help system. One detailed `usage` block
/// per command keeps the overview tiny and the detail one-fetch-away.
const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every user blueprint's {id, name} (JSON)",
        usage: "\
USAGE:
  bsc blueprint list [--full] [--pretty]

Prints every user blueprint's { id, name } as JSON (compact; --pretty for indented). The full
blueprint JSON is one `get <id>` away. --full emits the COMPLETE blueprint objects (sections +
origin/…) as a plain array — the full-fidelity read the desktop library hydration needs (#2143).",
    },
    CmdDoc {
        name: "get",
        summary: "print one blueprint (JSON, verbatim) or null",
        usage: "\
USAGE:
  bsc blueprint get <id> [--pretty]

Prints the stored blueprint JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from blueprint JSON on stdin; prints id(s)",
        usage: "\
USAGE:
  bsc blueprint set [--pretty]   # blueprint JSON (one object or an array) on stdin

Upserts each blueprint by its (required, non-empty) \"id\" field, written verbatim. Prints the
id(s) written.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a blueprint (no-op if absent)",
        usage: "\
USAGE:
  bsc blueprint remove <id> [--pretty]

Deletes the blueprint keyed by <id>. A no-op (not an error) when it does not exist.",
    },
];

/// The blueprint store's concrete knobs over the shared CLI (#2158): its noun, env var, dir segment,
/// help catalog, and the `{id, name}` lean-`list` projection.
const SPEC: CliSpec = CliSpec {
    noun: "blueprint",
    dir_env: "BSC_BLUEPRINT_DIR",
    dir_segment: "blueprints",
    tagline: TAGLINE,
    commands: COMMANDS,
    meta_fields: &["id", "name"],
};

/// The `blueprint` subcommand entrypoint: `args` is everything after `bsc blueprint`; `prog` is the
/// display name for help/errors. Delegates to the shared dispatch with the blueprint [`SPEC`].
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    bsc_json_store::cli::run(args, prog, &SPEC)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_is_the_blueprint_store() {
        assert_eq!(SPEC.noun, "blueprint");
        assert_eq!(SPEC.dir_env, "BSC_BLUEPRINT_DIR");
        assert_eq!(SPEC.dir_segment, "blueprints");
        assert_eq!(SPEC.meta_fields, &["id", "name"]);
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc blueprint", TAGLINE, COMMANDS);
        for c in ["list", "get", "set", "remove"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        let one = bsc_cli_util::help_for("bsc blueprint", TAGLINE, COMMANDS, "set");
        assert!(one.contains("bsc blueprint set"));
        assert!(one.contains("stdin"));
        // An unknown command falls back to the overview.
        assert!(bsc_cli_util::help_for("bsc blueprint", TAGLINE, COMMANDS, "nope").contains("COMMANDS:"));
    }
}
