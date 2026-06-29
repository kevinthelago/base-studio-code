//! `bsc-blueprint` — the session-facing CLI over the USER blueprint store (#1719, an instance of
//! #1325). Injected into EVERY console session so the user blueprint library
//! (`~/.base-studio-code/blueprints/<id>.json`) is list/get/set/remove-able from a session's own
//! shell — the same store the desktop blueprint library reads/writes. Built-in blueprints are
//! code/JSON-owned and out of scope; this is the user store only.
//!
//! The store is located via `--dir <path>` or the `BSC_BLUEPRINT_DIR` env var (set per-session at
//! launch), defaulting to `~/.base-studio-code/blueprints/`. Output is JSON to stdout (like
//! `bsc-plan` / `bsc-skill`): compact by default, indented with `--pretty`.
//!
//! Help is per-command so a model loads only what it needs (#1762):
//!   bsc-blueprint help          # compact menu (the small "what commands exist" prompt)
//!   bsc-blueprint get help      # detailed help for ONE command
//!   bsc-blueprint <cmd> help    # same, after any command

use bsc_blueprint::Store;
use bsc_cli_util::CmdDoc;
use bsc_sqlite_util::{print_json, read_stdin_json};
use std::process::ExitCode;
use serde_json::Value;

fn main() -> ExitCode {
    bsc_cli_util::cli_main("bsc-blueprint", run)
}

const TAGLINE: &str = "the user blueprint store — list/get/set/remove ~/.base-studio-code/blueprints (#1719)";

/// The command catalog — drives both dispatch and the shared help system. One detailed `usage` block
/// per command keeps the overview tiny and the detail one-fetch-away.
const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every user blueprint's {id, name} (JSON)",
        usage: "\
USAGE:
  bsc-blueprint list [--pretty]

Prints every user blueprint's { id, name } as JSON (compact; --pretty for indented). The full
blueprint JSON is one `get <id>` away.",
    },
    CmdDoc {
        name: "get",
        summary: "print one blueprint (JSON, verbatim) or null",
        usage: "\
USAGE:
  bsc-blueprint get <id> [--pretty]

Prints the stored blueprint JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from blueprint JSON on stdin; prints id(s)",
        usage: "\
USAGE:
  bsc-blueprint set [--pretty]   # blueprint JSON (one object or an array) on stdin

Upserts each blueprint by its (required, non-empty) \"id\" field, written verbatim. Prints the
id(s) written.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a blueprint (no-op if absent)",
        usage: "\
USAGE:
  bsc-blueprint remove <id> [--pretty]

Deletes the blueprint keyed by <id>. A no-op (not an error) when it does not exist.",
    },
];

/// Parsed global flags + leftover positional args.
struct Args {
    dir: Option<String>,
    pretty: bool,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { dir: None, pretty: false, positional: Vec::new() };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--dir" => a.dir = Some(it.next().ok_or("--dir needs a path")?),
            "--pretty" => a.pretty = true,
            // `-h`/`--help` route to the help command (anywhere on the line).
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

fn run() -> Result<(), String> {
    let args = parse_args(std::env::args().skip(1).collect())?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    // Top-level + per-command help (no command / `help` / `help <cmd>` / `<cmd> help`) — the shared
    // dispatch in bsc-cli-util, run BEFORE resolving the store (help works without a blueprint dir).
    if bsc_cli_util::handle_help("bsc-blueprint", TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    let store = resolve_store(&args.dir)?;

    match cmd.as_str() {
        // Every user blueprint as {id, name} — the library's id/label summary (the full JSON is one
        // `get` away). Each stored blueprint is parsed leniently so an odd-shaped file never aborts
        // the list; we emit whatever `id`/`name` strings are present.
        "list" => {
            let metas: Vec<Meta> = store.list().iter().map(|j| Meta::from_json(j)).collect();
            print_json(&metas, args.pretty);
            Ok(())
        }
        "get" => {
            let id = args.positional.get(1).ok_or("usage: bsc-blueprint get <id>")?;
            match store.get(id)? {
                // Print the stored JSON verbatim (it's already JSON), or `null` when absent.
                Some(json) => println!("{}", json.trim_end()),
                None => println!("null"),
            }
            Ok(())
        }
        // Upsert from a blueprint object — or an array of them — on stdin, written verbatim by id.
        "set" => {
            let blueprints: Vec<Value> = read_stdin_json("blueprint")?;
            let mut ids = Vec::new();
            for bp in &blueprints {
                let id = id_of(bp)?;
                let json = serde_json::to_string(bp).map_err(|e| format!("set: {e}"))?;
                store.set(&id, &json)?;
                ids.push(id);
            }
            print_json(&ids, args.pretty);
            Ok(())
        }
        "remove" => {
            let id = args.positional.get(1).ok_or("usage: bsc-blueprint remove <id>")?;
            store.remove(id)?;
            print_json(&id, args.pretty);
            Ok(())
        }
        other => Err(bsc_cli_util::unknown_command("bsc-blueprint", TAGLINE, COMMANDS, other)),
    }
}

/// Resolve the store: explicit `--dir` wins, then `BSC_BLUEPRINT_DIR`, else the default user store at
/// `~/.base-studio-code/blueprints/`. The flag→env→default precedence is the shared
/// [`bsc_cli_util::resolve_store_path`]; the resolved dir is wrapped in a [`Store`] (this CLI keys a
/// directory, not a single file). The default mirrors [`Store::open_default`].
fn resolve_store(flag: &Option<String>) -> Result<Store, String> {
    let dir = bsc_cli_util::resolve_store_path(flag, "BSC_BLUEPRINT_DIR", || {
        bsc_util::bsc_base_dir()
            .map(|b| b.join("blueprints"))
            .ok_or_else(|| "could not resolve a home directory; set HOME/USERPROFILE".to_string())
    })?;
    Ok(Store::new(dir))
}

/// The `id` of a blueprint Value — required, non-empty (it keys the on-disk file).
fn id_of(bp: &Value) -> Result<String, String> {
    bp.get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "each blueprint needs a non-empty \"id\"".to_string())
}

/// The id/label summary one blueprint contributes to `list` — robust to odd-shaped files (any
/// missing field is just an empty string).
#[derive(serde::Serialize)]
struct Meta {
    id: String,
    name: String,
}
impl Meta {
    fn from_json(json: &str) -> Meta {
        let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
        let pick = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        Meta { id: pick("id"), name: pick("name") }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_of_requires_a_non_empty_id() {
        assert_eq!(id_of(&serde_json::json!({"id": "bp1"})).unwrap(), "bp1");
        assert_eq!(id_of(&serde_json::json!({"id": "  bp2 "})).unwrap(), "bp2");
        assert!(id_of(&serde_json::json!({"id": ""})).is_err());
        assert!(id_of(&serde_json::json!({"name": "no id"})).is_err());
    }

    #[test]
    fn meta_extracts_id_and_name_and_tolerates_garbage() {
        let m = Meta::from_json(r#"{"id":"bp","name":"Mobile","extra":1}"#);
        assert_eq!((m.id.as_str(), m.name.as_str()), ("bp", "Mobile"));
        // A field-less / unparseable blob yields empty strings, never a panic.
        let m = Meta::from_json("not json");
        assert_eq!((m.id.as_str(), m.name.as_str()), ("", ""));
    }

    #[test]
    fn parse_args_reads_flags_and_positionals() {
        let a = parse_args(vec![
            "set".into(),
            "--dir".into(),
            "/tmp/bp".into(),
            "--pretty".into(),
        ])
        .unwrap();
        assert_eq!(a.dir.as_deref(), Some("/tmp/bp"));
        assert!(a.pretty);
        assert_eq!(a.positional, vec!["set".to_string()]);
        assert!(parse_args(vec!["--nope".into()]).is_err());
    }

    #[test]
    fn parse_args_routes_help_flag_to_the_help_command() {
        let a = parse_args(vec!["--help".into()]).unwrap();
        assert_eq!(a.positional.first().map(String::as_str), Some("help"));
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc-blueprint", TAGLINE, COMMANDS);
        for c in ["list", "get", "set", "remove"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        let one = bsc_cli_util::help_for("bsc-blueprint", TAGLINE, COMMANDS, "set");
        assert!(one.contains("bsc-blueprint set"));
        assert!(one.contains("stdin"));
        // An unknown command falls back to the overview.
        assert!(bsc_cli_util::help_for("bsc-blueprint", TAGLINE, COMMANDS, "nope").contains("COMMANDS:"));
    }
}
