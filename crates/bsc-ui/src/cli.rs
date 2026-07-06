//! The `bsc ui` subcommand (#1852 Phase 2) — the agent-facing face of the spec-first UI SDK:
//!   bsc ui schema              # print the contract (every kind, its fields + enums) — the agent's contract
//!   bsc ui validate [file]     # validate a KitNode spec (a file, else stdin) against the contract
//!   bsc ui theme …             # the kit THEME registry (#1852 Phase 3)
//!   bsc ui kit …               # the global UI-kit store: immutable id@version artifacts (#2465)
//!
//! So an agent composing UI-as-data can learn the vocabulary (`schema`) and check its work (`validate`)
//! from its own shell, against the exact contract the desktop `KitRenderer` renders — and any session
//! (or the desktop, over the #2114 bridge) can reach the shared kit store. Dispatched by the
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
    CmdDoc {
        name: "kit",
        summary: "the global UI-kit store — immutable id@version artifacts blueprints pin (#2465)",
        usage: "\
USAGE:
  bsc ui kit list [--pretty]                 # every stored kit's manifest (+ the packaged default)
  bsc ui kit get <id@version> [--artifact]   # one manifest (or null); --artifact prints the artifact
  bsc ui kit add <id> <version> [--kind component-kit|design-files] [--source URL] [--sha256 HEX] [--file PATH]
  bsc ui kit remove <id@version>             # delete a materialized entry (packaged stays embedded)
  bsc ui kit verify <id@version>             # recompute the artifact hash against the manifest

The versioned kit store at ~/.base-studio-code/kits/<id>/<version>/ (--dir/BSC_UI_KIT_STORE_DIR
override): one immutable copy per id@version — `{ id, version, sha256, kind, source? }` manifest +
the artifact — shared by every blueprint that pins it. `add` reads the artifact from stdin (or
--file), verifies --sha256 BEFORE writing (mismatch ⇒ nothing stored), and refuses to overwrite an
existing version with different content (bump the version instead). The packaged `bsc/react-ui`
kit resolves as a built-in entry with zero setup.",
    },
    CmdDoc {
        name: "theme",
        summary: "the kit THEME registry — list themes or get one (#1852 Phase 3)",
        usage: "\
USAGE:
  bsc ui theme list [--pretty]     # every theme's { id, label, description }
  bsc ui theme get <id> [--pretty] # one theme verbatim (id, label, description, vars), or null

A theme is a map of semantic component-token overrides (--card-*/--btn-*/--field-*/--chip-*) applied
globally (:root) or scoped to a subtree — restyling every card/button/field/chip without touching a
spec's structure. This is the SDK's THEME axis (style × theme × spec); the same registry the desktop
theme picker reads.",
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
        Some("kit") => cmd_kit(&args[1..], prog),
        Some("theme") => cmd_theme(&args[1..]),
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

fn cmd_theme(args: &[String]) -> Result<(), String> {
    let pretty = args.iter().any(|a| a == "--pretty");
    let positional: Vec<&str> = args.iter().filter(|a| !a.starts_with("--")).map(String::as_str).collect();
    let emit = |v: &serde_json::Value| -> Result<(), String> {
        let s = if pretty { serde_json::to_string_pretty(v) } else { serde_json::to_string(v) };
        println!("{}", s.map_err(|e| e.to_string())?);
        Ok(())
    };
    match positional.first().copied().unwrap_or("list") {
        "list" => {
            let list: Vec<serde_json::Value> = crate::themes()
                .iter()
                .map(|t| serde_json::json!({ "id": t.get("id"), "label": t.get("label"), "description": t.get("description") }))
                .collect();
            emit(&serde_json::Value::Array(list))
        }
        "get" => {
            let id = positional.get(1).ok_or("usage: bsc ui theme get <id>")?;
            emit(&crate::theme_by_id(id).unwrap_or(serde_json::Value::Null))
        }
        other => Err(format!("unknown theme command '{other}' — want: list | get <id>")),
    }
}

/// `bsc ui kit …` (#2465) — the versioned global kit store (see [`crate::kit`]). Resolves the store
/// dir from `--dir`, else `$BSC_UI_KIT_STORE_DIR`, else `~/.base-studio-code/kits/`.
fn cmd_kit(args: &[String], prog: &str) -> Result<(), String> {
    if args.first().map(String::as_str) == Some("help") || args.iter().any(|a| a == "--help") {
        print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, "kit"));
        return Ok(());
    }
    // Flag parsing: --flag <value> pairs + boolean flags; everything else is positional.
    let mut dir = None::<String>;
    let mut kind = "component-kit".to_string();
    let mut source = None::<String>;
    let mut sha = None::<String>;
    let mut file = None::<String>;
    let (mut pretty, mut want_artifact) = (false, false);
    let mut positional: Vec<String> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--kind" => kind = it.next().cloned().unwrap_or_default(),
            "--source" => source = it.next().cloned(),
            "--sha256" => sha = it.next().cloned(),
            "--file" => file = it.next().cloned(),
            "--pretty" => pretty = true,
            "--artifact" => want_artifact = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => positional.push(a.clone()),
        }
    }
    let store = match dir.or_else(|| std::env::var("BSC_UI_KIT_STORE_DIR").ok()) {
        Some(d) => crate::kit::KitStore::new(d),
        None => crate::kit::KitStore::open_default()?,
    };
    let emit = |v: &serde_json::Value| -> Result<(), String> {
        let s = if pretty { serde_json::to_string_pretty(v) } else { serde_json::to_string(v) };
        println!("{}", s.map_err(|e| e.to_string())?);
        Ok(())
    };
    let kit_ref = |n: usize| -> Result<(&str, &str), String> {
        crate::kit::split_ref(positional.get(n).map(String::as_str).ok_or("missing <id@version>")?)
    };
    match positional.first().map(String::as_str).unwrap_or("list") {
        "list" => emit(&serde_json::Value::Array(store.list())),
        "get" => {
            let (id, version) = kit_ref(1)?;
            if want_artifact {
                match store.artifact(id, version)? {
                    Some(text) => {
                        println!("{text}");
                        Ok(())
                    }
                    None => {
                        println!("null");
                        Ok(())
                    }
                }
            } else {
                emit(&store.get(id, version)?.unwrap_or(serde_json::Value::Null))
            }
        }
        "add" => {
            let id = positional.get(1).ok_or("usage: bsc ui kit add <id> <version> [--kind K] [--source URL] [--sha256 HEX] [--file PATH]")?;
            let version = positional.get(2).ok_or("usage: bsc ui kit add <id> <version> …")?;
            let content = match file {
                Some(p) => std::fs::read_to_string(&p).map_err(|e| format!("cannot read {p}: {e}"))?,
                None => {
                    let mut s = String::new();
                    std::io::stdin().read_to_string(&mut s).map_err(|e| format!("cannot read stdin: {e}"))?;
                    s
                }
            };
            emit(&store.add_verified(id, version, &kind, source.as_deref(), &content, sha.as_deref())?)
        }
        "remove" => {
            let (id, version) = kit_ref(1)?;
            store.remove(id, version)?;
            println!("removed {id}@{version}");
            Ok(())
        }
        "verify" => {
            let (id, version) = kit_ref(1)?;
            let hash = store.verify(id, version)?;
            println!("ok {hash}");
            Ok(())
        }
        other => Err(format!("unknown kit command '{other}' — want: list | get | add | remove | verify")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_overview_lists_the_commands() {
        let ov = bsc_cli_util::help_overview("bsc ui", TAGLINE, COMMANDS);
        assert!(ov.contains("schema") && ov.contains("validate") && ov.contains("theme") && ov.contains("kit"));
    }

    #[test]
    fn kit_help_explains_the_store_contract() {
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMMANDS, "kit");
        for needle in ["id@version", "immutable", "--sha256", "bsc/react-ui"] {
            assert!(d.contains(needle), "kit help mentions {needle}");
        }
        // `bsc ui kit help` routes to the same detail without touching the store.
        assert!(run(vec!["kit".into(), "help".into()], "bsc ui").is_ok());
    }

    #[test]
    fn kit_cli_round_trips_against_an_explicit_dir() {
        let dir = std::env::temp_dir().join(format!("bsc-ui-kit-cli-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let d = dir.to_string_lossy().to_string();
        let run_kit = |rest: &[&str]| {
            let mut args = vec!["kit".to_string()];
            args.extend(rest.iter().map(|s| s.to_string()));
            args.extend(["--dir".to_string(), d.clone()]);
            run(args, "bsc ui")
        };
        // add via --file (stdin isn't drivable in a unit test).
        let artifact = dir.join("artifact-src.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&artifact, "{\"kit\":true}").unwrap();
        run_kit(&["add", "acme/neon", "1.0.0", "--file", artifact.to_str().unwrap()]).unwrap();
        run_kit(&["list", "--pretty"]).unwrap();
        run_kit(&["get", "acme/neon@1.0.0"]).unwrap();
        run_kit(&["get", "acme/neon@1.0.0", "--artifact"]).unwrap();
        run_kit(&["verify", "acme/neon@1.0.0"]).unwrap();
        // A wrong --sha256 is a hard error (nothing stored).
        assert!(run_kit(&["add", "acme/other", "1.0.0", "--file", artifact.to_str().unwrap(), "--sha256", "beef"]).is_err());
        assert!(run_kit(&["get", "acme/other@1.0.0"]).is_ok(), "get of the never-stored entry still prints null");
        run_kit(&["remove", "acme/neon@1.0.0"]).unwrap();
        // Bad shapes error crisply.
        assert!(run_kit(&["get", "acme/neon"]).is_err(), "a ref without @version is rejected");
        assert!(run_kit(&["frobnicate"]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn theme_list_and_get_round_trip() {
        assert!(run(vec!["theme".into(), "list".into()], "bsc ui").is_ok());
        assert!(run(vec!["theme".into(), "get".into(), "default".into()], "bsc ui").is_ok());
        // `get` with no id is a usage error.
        assert!(run(vec!["theme".into(), "get".into()], "bsc ui").is_err());
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
