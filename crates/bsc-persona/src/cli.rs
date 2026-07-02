//! The `bsc persona` subcommand (#2094) — the agent-facing CLI over the USER persona store (an
//! instance of #1325). The persona library (`~/.base-studio-code/personas/<id>.json`) is
//! list/get/set/remove-able from a session's own shell — the same store the desktop Personas library
//! reads/writes and the planner can author into (mint a persona like it mints a skill).
//!
//! Dispatched by the unified `bsc` binary (#1877) via [`run`]; the shared per-command help (#1762):
//!   bsc persona help          # compact menu
//!   bsc persona get help      # detailed help for ONE command
//!
//! The store is located via `--dir <path>` or the `BSC_PERSONA_DIR` env var, defaulting to
//! `~/.base-studio-code/personas/`. Output is JSON to stdout (like `bsc plan` / `bsc skill` /
//! `bsc blueprint`): compact by default, indented with `--pretty`.

use crate::Store;
use bsc_cli_util::CmdDoc;
use bsc_sqlite_util::{print_json, read_stdin_json};
use serde_json::Value;

const TAGLINE: &str = "the user persona store — list/get/set/remove ~/.base-studio-code/personas (#2094)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every persona's {id, name, role} (JSON)",
        usage: "\
USAGE:
  bsc persona list [--full] [--pretty]

Prints every persona's { id, name, role } as JSON (compact; --pretty for indented). --full emits the
COMPLETE persona objects (role + startPrompt + skills + model + …) as a plain array — the
full-fidelity read the desktop library hydration needs.",
    },
    CmdDoc {
        name: "get",
        summary: "print one persona (JSON, verbatim) or null",
        usage: "\
USAGE:
  bsc persona get <id> [--pretty]

Prints the stored persona JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from persona JSON on stdin; prints id(s)",
        usage: "\
USAGE:
  bsc persona set [--pretty]   # persona JSON (one object or an array) on stdin

Upserts each persona by its (required, non-empty) \"id\" field, written verbatim. Prints the id(s)
written. Use this to author or update a persona from a session (the planner mints personas this way).",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a persona (no-op if absent)",
        usage: "\
USAGE:
  bsc persona remove <id> [--pretty]

Deletes the persona keyed by <id>. A no-op (not an error) when it does not exist.",
    },
];

/// Parsed global flags + leftover positional args.
struct Args {
    dir: Option<String>,
    pretty: bool,
    /// `list --full`: emit the COMPLETE persona objects as a plain array — the full-fidelity read the
    /// desktop library hydration needs. Ignored by other subcommands.
    full: bool,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { dir: None, pretty: false, full: false, positional: Vec::new() };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--dir" => a.dir = Some(it.next().ok_or("--dir needs a path")?),
            "--pretty" => a.pretty = true,
            "--full" => a.full = true,
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

/// The `persona` subcommand entrypoint: `args` is everything after `bsc persona`; `prog` is the
/// display name for help/errors. Handles help before any store read.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    let store = resolve_store(&args.dir)?;

    match cmd.as_str() {
        "list" => {
            if args.full {
                let full: Vec<Value> = store
                    .list()
                    .iter()
                    .filter_map(|j| serde_json::from_str::<Value>(j).ok())
                    .collect();
                print_json(&full, args.pretty);
            } else {
                let metas: Vec<Meta> = store.list().iter().map(|j| Meta::from_json(j)).collect();
                print_json(&metas, args.pretty);
            }
            Ok(())
        }
        "get" => {
            let id = args.positional.get(1).ok_or("usage: bsc persona get <id>")?;
            match store.get(id)? {
                Some(json) => println!("{}", json.trim_end()),
                None => println!("null"),
            }
            Ok(())
        }
        "set" => {
            let personas: Vec<Value> = read_stdin_json("persona")?;
            let mut ids = Vec::new();
            for p in &personas {
                let id = id_of(p)?;
                let json = serde_json::to_string(p).map_err(|e| format!("set: {e}"))?;
                store.set(&id, &json)?;
                ids.push(id);
            }
            print_json(&ids, args.pretty);
            Ok(())
        }
        "remove" => {
            let id = args.positional.get(1).ok_or("usage: bsc persona remove <id>")?;
            store.remove(id)?;
            print_json(&id, args.pretty);
            Ok(())
        }
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// Resolve the store: explicit `--dir` wins, then `BSC_PERSONA_DIR`, else the default user store at
/// `~/.base-studio-code/personas/`.
fn resolve_store(flag: &Option<String>) -> Result<Store, String> {
    let dir = bsc_cli_util::resolve_store_path(flag, "BSC_PERSONA_DIR", || {
        bsc_util::bsc_base_dir()
            .map(|b| b.join("personas"))
            .ok_or_else(|| "could not resolve a home directory; set HOME/USERPROFILE".to_string())
    })?;
    Ok(Store::new(dir))
}

/// The `id` of a persona Value — required, non-empty (it keys the on-disk file).
fn id_of(p: &Value) -> Result<String, String> {
    p.get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "each persona needs a non-empty \"id\"".to_string())
}

/// The id/name/role summary one persona contributes to `list` — robust to odd-shaped files (any
/// missing field is just an empty string).
#[derive(serde::Serialize)]
struct Meta {
    id: String,
    name: String,
    role: String,
}
impl Meta {
    fn from_json(json: &str) -> Meta {
        let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
        let pick = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        Meta { id: pick("id"), name: pick("name"), role: pick("role") }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_of_requires_a_non_empty_id() {
        assert_eq!(id_of(&serde_json::json!({"id": "p1"})).unwrap(), "p1");
        assert_eq!(id_of(&serde_json::json!({"id": "  p2 "})).unwrap(), "p2");
        assert!(id_of(&serde_json::json!({"id": ""})).is_err());
        assert!(id_of(&serde_json::json!({"name": "no id"})).is_err());
    }

    #[test]
    fn meta_extracts_id_name_role_and_tolerates_garbage() {
        let m = Meta::from_json(r#"{"id":"persona-worker","name":"Worker","role":"worker","extra":1}"#);
        assert_eq!((m.id.as_str(), m.name.as_str(), m.role.as_str()), ("persona-worker", "Worker", "worker"));
        let m = Meta::from_json("not json");
        assert_eq!((m.id.as_str(), m.name.as_str(), m.role.as_str()), ("", "", ""));
    }

    #[test]
    fn parse_args_reads_flags_and_positionals() {
        let a = parse_args(vec!["set".into(), "--dir".into(), "/tmp/p".into(), "--pretty".into()]).unwrap();
        assert_eq!(a.dir.as_deref(), Some("/tmp/p"));
        assert!(a.pretty);
        assert_eq!(a.positional, vec!["set".to_string()]);
        assert!(parse_args(vec!["--nope".into()]).is_err());
    }

    #[test]
    fn full_flag_parses_and_defaults_off() {
        assert!(!parse_args(vec!["list".into()]).unwrap().full, "default list is lean {{id,name,role}}");
        assert!(parse_args(vec!["list".into(), "--full".into()]).unwrap().full, "--full opts into full objects");
    }

    #[test]
    fn help_overview_lists_commands() {
        let ov = bsc_cli_util::help_overview("bsc persona", TAGLINE, COMMANDS);
        for c in ["list", "get", "set", "remove"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        let one = bsc_cli_util::help_for("bsc persona", TAGLINE, COMMANDS, "set");
        assert!(one.contains("bsc persona set"));
        assert!(one.contains("stdin"));
    }
}
