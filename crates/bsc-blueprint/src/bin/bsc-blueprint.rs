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
//! Commands:
//!   bsc-blueprint list                    # every user blueprint's {id, name}, JSON
//!   bsc-blueprint get <id>                # the blueprint JSON (verbatim), or null
//!   bsc-blueprint set                     # upsert from blueprint JSON (object or array) on stdin
//!   bsc-blueprint remove <id>             # delete a blueprint (no-op if absent)
//! Global flags: --dir <path>, --pretty

use bsc_blueprint::Store;
use bsc_sqlite_util::{print_json, read_stdin_json};
use std::process::ExitCode;
use serde_json::Value;

fn main() -> ExitCode {
    bsc_cli_util::cli_main("bsc-blueprint", run)
}

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
            "-h" | "--help" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

fn run() -> Result<(), String> {
    let args = parse_args(std::env::args().skip(1).collect())?;
    let cmd = args.positional.first().cloned().unwrap_or_default();
    if cmd.is_empty() {
        print!("{USAGE}");
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
        other => Err(format!("unknown command '{other}'\n\n{USAGE}")),
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

const USAGE: &str = "\
bsc-blueprint — the user blueprint store (#1719)

USAGE:
  bsc-blueprint <command> [args] [--dir <path>] [--pretty]

COMMANDS:
  list                 print every user blueprint's {id, name} (JSON)
  get <id>             print one blueprint (JSON, verbatim) or null
  set                  upsert from a blueprint object/array JSON on stdin; prints id(s)
  remove <id>          delete a blueprint (no-op if absent)

The store is found via --dir <path>, the BSC_BLUEPRINT_DIR env var, or the default user store at
~/.base-studio-code/blueprints/. Built-in blueprints are code-owned and not part of this store.
";

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
}
