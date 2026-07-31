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
    graph_fields: &[],
    field_aliases: &[],
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
    fn teams_store_persists_to_sqlite_not_json_files() {
        // #2983 regression (epic #2982): the shared store backend moved JSON-files → SQLite. Prove the
        // teams store (segment `orgs`, per SPEC) now round-trips through a SQLite `orgs.db` and never
        // writes a legacy `orgs/<id>.json` file. Uses the public `bsc_json_store::Store` over the SAME
        // segment/noun the `bsc teams` CLI uses, rooted at a fresh temp base.
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let uniq = format!("{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed));
        let base = std::env::temp_dir().join(format!("bsc-teams-sqlite-test-{uniq}"));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        let store = bsc_json_store::Store::new(base.join(SPEC.dir_segment), SPEC.noun);

        // Round-trip a team through the public store API (write → read back).
        let team = r#"{"id":"squad","name":"Squad","positions":[],"relationships":[]}"#;
        store.set("squad", team).unwrap();
        assert_eq!(
            store.get("squad").unwrap().as_deref(),
            Some(team),
            "the written team reads back verbatim",
        );

        // SQLite, not files: `<base>/orgs.db` EXISTS after the write, and NO `<base>/orgs/<id>.json`
        // (nor even the legacy `orgs/` dir) was created.
        let db = base.join(format!("{}.db", SPEC.dir_segment));
        assert!(db.exists(), "the SQLite db {} exists after a write", db.display());
        let legacy_json = base.join(SPEC.dir_segment).join("squad.json");
        assert!(
            !legacy_json.exists(),
            "no legacy JSON file was written ({})",
            legacy_json.display(),
        );

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(base.join(SPEC.dir_segment));
        let _ = std::fs::remove_file(&db);
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
