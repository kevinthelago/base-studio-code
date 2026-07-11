//! The `bsc studio` subcommand (#2890) — SAVE + read the Studio store (a self-contained snapshot of
//! the app's library state) from a session's own shell. Unlike the plain per-id store shims
//! (`bsc blueprint`/`bsc persona`), `save` AGGREGATES across every sibling library collection, so this
//! is a small custom CLI over [`crate`] rather than a [`bsc_json_store::cli::CliSpec`] shim.
//!
//! Dispatched by the unified `bsc` binary (#1877) via [`run`]; the shared per-command help (#1762):
//!   bsc studio help          # compact menu
//!   bsc studio save help     # detailed help for ONE command
//!
//! `--dir <base>` (or the default `~/.base-studio-code/`) is the BASE dir: `save` reads its sibling
//! collections under it and writes the bundle to `<base>/studios/`; `list`/`get`/`remove` operate on
//! that studios store.

use bsc_cli_util::CmdDoc;
use serde_json::Value;
use std::io::Read;

const TAGLINE: &str =
    "the Studio store — save/list/get/remove ~/.base-studio-code/studios: shareable snapshots of the app's library state (#2890)";

/// The command catalog — drives dispatch validation + the shared help system.
const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "save",
        summary: "snapshot the app's library state into a shareable Studio",
        usage: "\
USAGE:
  bsc studio save <name> [--description <d>] [--dir <base>] [--pretty]

Assembles a Studio — a self-contained snapshot of the app's current LIBRARY state — by reading each
sibling library collection (teams · personas · components · variants · themes · blueprints) and keying
its records by system into an extensible map. Saved to <base>/studios/<id>.json where id is a slug of
<name> (a same-named re-save overwrites). Prints the saved bundle (compact; --pretty indents). --dir
overrides the base ~/.base-studio-code dir (the snapshot reads its siblings under it). Captures the
AUTHORITATIVE stores only — never a cache, never live session state.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert a full Studio bundle from JSON on stdin; prints its id",
        usage: "\
USAGE:
  bsc studio set [--dir <base>] [--pretty]   # a full Studio bundle (one JSON object) on stdin

Upserts a Studio by its (required, non-empty) \"id\" field — the write half of gist IMPORT (#2891).
The bundle must be a JSON object carrying a non-empty \"id\" AND \"name\"; the captured snapshot rides
through as given. A same-id bundle overwrites (upsert). Reads the bundle from stdin; prints the id
written. --dir overrides the base ~/.base-studio-code dir (writes to <base>/studios/).",
    },
    CmdDoc {
        name: "list",
        summary: "every saved Studio's {id, name} (JSON)",
        usage: "\
USAGE:
  bsc studio list [--dir <base>] [--pretty]

Prints every saved Studio's { id, name } as JSON (compact; --pretty for indented). The full bundle —
identity + the captured snapshot — is one `get <id>` away.",
    },
    CmdDoc {
        name: "get",
        summary: "print one Studio bundle (JSON) or null",
        usage: "\
USAGE:
  bsc studio get <id> [--dir <base>] [--pretty]

Prints the full stored Studio bundle for <id> (identity + snapshot) as JSON, or `null` if absent.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a Studio (no-op if absent)",
        usage: "\
USAGE:
  bsc studio remove <id> [--dir <base>] [--pretty]

Deletes the Studio keyed by <id>. A no-op (not an error) when it does not exist.",
    },
];

/// Parsed global flags + leftover positional args.
struct Args {
    dir: Option<String>,
    description: Option<String>,
    pretty: bool,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { dir: None, description: None, pretty: false, positional: Vec::new() };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--dir" => a.dir = Some(it.next().ok_or("--dir needs a path")?),
            "--description" => a.description = Some(it.next().ok_or("--description needs a value")?),
            "--pretty" => a.pretty = true,
            // `-h`/`--help` route to the help command (anywhere on the line).
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

/// Print a JSON value to stdout, compact by default (`pretty` indents).
fn print_value(v: &Value, pretty: bool) -> Result<(), String> {
    let s = if pretty { serde_json::to_string_pretty(v) } else { serde_json::to_string(v) };
    println!("{}", s.map_err(|e| e.to_string())?);
    Ok(())
}

/// The `studio` subcommand entrypoint: `args` is everything after `bsc studio`; `prog` is the display
/// name for help/errors. Handles help before resolving the base dir.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;

    // Top-level + per-command help, run BEFORE resolving the base (help works without a base dir).
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    let base = crate::resolve_base(&args.dir)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    match cmd.as_str() {
        "save" => {
            let name = args
                .positional
                .get(1)
                .ok_or_else(|| format!("usage: {prog} save <name> [--description <d>]"))?;
            let studio = crate::save(&base, name, args.description)?;
            let v = serde_json::to_value(&studio).map_err(|e| e.to_string())?;
            print_value(&v, args.pretty)
        }
        "set" => {
            // Read the full Studio bundle from stdin (the write half of gist import, #2891).
            let mut json = String::new();
            std::io::stdin()
                .read_to_string(&mut json)
                .map_err(|e| format!("reading stdin: {e}"))?;
            let id = crate::set(&base, &json)?;
            print_value(&Value::String(id), args.pretty)
        }
        "list" => print_value(&Value::Array(crate::list_meta(&base)), args.pretty),
        "get" => {
            let id = args.positional.get(1).ok_or_else(|| format!("usage: {prog} get <id>"))?;
            match crate::get(&base, id)? {
                Some(v) => print_value(&v, args.pretty),
                None => {
                    println!("null");
                    Ok(())
                }
            }
        }
        "remove" => {
            let id = args.positional.get(1).ok_or_else(|| format!("usage: {prog} remove <id>"))?;
            crate::remove(&base, id)?;
            print_value(&Value::String(id.clone()), args.pretty)
        }
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_reads_flags_and_positionals() {
        let a = parse_args(vec![
            "save".into(),
            "My Studio".into(),
            "--description".into(),
            "notes".into(),
            "--dir".into(),
            "/tmp/base".into(),
            "--pretty".into(),
        ])
        .unwrap();
        assert_eq!(a.positional, vec!["save".to_string(), "My Studio".to_string()]);
        assert_eq!(a.description.as_deref(), Some("notes"));
        assert_eq!(a.dir.as_deref(), Some("/tmp/base"));
        assert!(a.pretty);
        assert!(parse_args(vec!["--nope".into()]).is_err(), "unknown flag rejected");
        assert!(parse_args(vec!["--dir".into()]).is_err(), "--dir needs a value");
    }

    #[test]
    fn parse_args_routes_help_flag_to_the_help_command() {
        let a = parse_args(vec!["--help".into()]).unwrap();
        assert_eq!(a.positional.first().map(String::as_str), Some("help"));
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc studio", TAGLINE, COMMANDS);
        for c in ["save", "set", "list", "get", "remove"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        let one = bsc_cli_util::help_for("bsc studio", TAGLINE, COMMANDS, "save");
        assert!(one.contains("bsc studio save"));
        assert!(one.contains("snapshot"));
        // `set` (#2891) drills in with its stdin usage.
        let set_help = bsc_cli_util::help_for("bsc studio", TAGLINE, COMMANDS, "set");
        assert!(set_help.contains("bsc studio set"));
        assert!(set_help.contains("stdin"));
        // An unknown command falls back to the overview.
        assert!(bsc_cli_util::help_for("bsc studio", TAGLINE, COMMANDS, "nope").contains("COMMANDS:"));
    }

    #[test]
    fn run_help_paths_need_no_base_dir() {
        // help/no-command must work without resolving a base (BEFORE any store read).
        assert!(run(vec!["help".into()], "bsc studio").is_ok());
        assert!(run(vec![], "bsc studio").is_ok());
        assert!(run(vec!["save".into(), "help".into()], "bsc studio").is_ok());
        // `set help` must resolve as help (not fall through to the stdin-reading dispatch arm).
        assert!(run(vec!["set".into(), "help".into()], "bsc studio").is_ok());
    }

    #[test]
    fn run_save_then_get_and_list_over_a_temp_base() {
        // End-to-end through the CLI dispatch with an explicit --dir base (no user store touched).
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let base = std::env::temp_dir().join(format!(
            "bsc-studio-cli-run-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.to_string_lossy().into_owned();

        run(vec!["save".into(), "Demo Kit".into(), "--dir".into(), dir.clone()], "bsc studio").unwrap();
        // It landed under <base>/studios and reads back as the full bundle.
        let got = crate::get(&base, "demo-kit").unwrap().expect("saved");
        assert_eq!(got["name"], "Demo Kit");
        // The CLI dispatch paths for list/get/remove don't error.
        assert!(run(vec!["list".into(), "--dir".into(), dir.clone()], "bsc studio").is_ok());
        assert!(run(vec!["get".into(), "demo-kit".into(), "--dir".into(), dir.clone()], "bsc studio").is_ok());
        assert!(run(vec!["get".into(), "absent".into(), "--dir".into(), dir.clone()], "bsc studio").is_ok());
        assert!(run(vec!["remove".into(), "demo-kit".into(), "--dir".into(), dir.clone()], "bsc studio").is_ok());
        assert_eq!(crate::get(&base, "demo-kit").unwrap(), None, "remove landed");
        // A missing positional errors with a usage line.
        assert!(run(vec!["save".into(), "--dir".into(), dir.clone()], "bsc studio").is_err());
        assert!(run(vec!["get".into(), "--dir".into(), dir], "bsc studio").is_err());
    }
}
