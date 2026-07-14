//! The `bsc sound` subcommand (#3080, epic #3071) — the sound-kit shim over the shared
//! verbatim-JSON-per-id store CLI ([`bsc_json_store::cli`], #2158). The sound library
//! (`~/.base-studio-code/sounds.db`) is list/get/set/remove-able from a session's own shell — the same
//! store the desktop Sounds library reads/writes and the (future) sound designer can author into.
//!
//! Dispatched by the unified `bsc` binary (#1877) via [`run`]; the shared per-command help (#1762):
//!   bsc sound help          # compact menu
//!   bsc sound get help      # detailed help for ONE command
//!
//! The store is located via `--dir <path>` or the `BSC_SOUND_DIR` env var, defaulting to
//! `~/.base-studio-code/sounds/` (the db at `~/.base-studio-code/sounds.db`).

use bsc_cli_util::CmdDoc;
use bsc_json_store::cli::CliSpec;

const TAGLINE: &str = "the user sound-kit store — list/get/set/remove ~/.base-studio-code/sounds (#3080)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every kit's {id, name} (JSON)",
        usage: "\
USAGE:
  bsc sound list [--full] [--pretty]

Prints every sound kit's { id, name } as JSON (compact; --pretty for indented). --full emits the
COMPLETE kit objects (primitives + voices + cues) as a plain array — the full-fidelity read the
desktop Sounds library hydration needs.",
    },
    CmdDoc {
        name: "get",
        summary: "print one kit (JSON, verbatim) or null",
        usage: "\
USAGE:
  bsc sound get <id> [--pretty]

Prints the stored sound-kit JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from kit JSON on stdin; prints id(s)",
        usage: "\
USAGE:
  bsc sound set [--pretty]   # kit JSON (one object or an array) on stdin

Upserts each sound kit by its (required, non-empty) \"id\" field, written verbatim. Prints the id(s)
written. Use this to author or update a kit from a session (the sound designer authors kits this way).",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a kit (no-op if absent)",
        usage: "\
USAGE:
  bsc sound remove <id> [--pretty]

Deletes the sound kit keyed by <id>. A no-op (not an error) when it does not exist.",
    },
];

/// The sound store's concrete knobs over the shared CLI (#2158): its noun, env var, dir segment, help
/// catalog, and the `{id, name}` lean-`list` projection.
const SPEC: CliSpec = CliSpec {
    noun: "sound",
    dir_env: "BSC_SOUND_DIR",
    dir_segment: "sounds",
    tagline: TAGLINE,
    commands: COMMANDS,
    meta_fields: &["id", "name"],
};

/// The `sound` subcommand entrypoint: `args` is everything after `bsc sound`; `prog` is the display
/// name for help/errors. Delegates to the shared dispatch with the sound [`SPEC`].
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    bsc_json_store::cli::run(args, prog, &SPEC)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_is_the_sound_store_with_the_lean_id_name_list() {
        assert_eq!(SPEC.noun, "sound");
        assert_eq!(SPEC.dir_env, "BSC_SOUND_DIR");
        assert_eq!(SPEC.dir_segment, "sounds");
        assert_eq!(SPEC.meta_fields, &["id", "name"]);
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc sound", TAGLINE, COMMANDS);
        for c in ["list", "get", "set", "remove"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        let one = bsc_cli_util::help_for("bsc sound", TAGLINE, COMMANDS, "set");
        assert!(one.contains("bsc sound set"));
        assert!(one.contains("stdin"));
        assert!(bsc_cli_util::help_for("bsc sound", TAGLINE, COMMANDS, "nope").contains("COMMANDS:"));
    }
}
