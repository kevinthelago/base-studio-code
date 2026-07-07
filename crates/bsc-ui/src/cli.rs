//! The `bsc ui` subcommand — the ONE UI-design-surface command (#2469). Three verb families under a
//! single mount, so a restricted design session is expressible as one allow rule (`Bash(bsc ui *)`):
//!
//! - the **contract** verbs (#1852, owned here, over the embedded KitNode contract
//!   `crate::CONTRACT_JSON`): `schema` (print the contract — every kind, its fields + enums),
//!   `validate [file]` (check a KitNode spec, a file else stdin, against it), and `theme list|get`
//!   (the kit THEME registry).
//! - the **released-kit store** verb (#2465, owned here): `release list|get|add|remove|verify` —
//!   immutable id@version kit artifacts blueprints pin (distinct from the mutable working `kit`s
//!   below; a RELEASE is a frozen published snapshot).
//! - the **component-library** verbs (#2281, mounted verbatim from `bsc_component::cli` — formerly
//!   `bsc component`, which remains a deprecated alias for one release, #2469):
//!   `list|get|set|remove` (the components), `kit list|get|set|remove` (the kits), and
//!   `eslint-preset` + `usage …` (kit lint enforcement + the consumer index).
//!
//! Composition: the contract verbs dispatch FIRST (they win any name collision — `theme list` vs the
//! component `list` disambiguates positionally), every KNOWN component verb delegates into
//! `bsc_component::cli::run` under this prog, and the help/unknown-command surfaces are built from the
//! MERGED `CmdDoc` catalog so `bsc ui help` presents one coherent tree. Dispatched by the unified
//! `bsc` binary (#1877) via [`run`]. Per-command help (#1762): `bsc ui help`, `bsc ui <cmd> help`.

use bsc_cli_util::CmdDoc;
use std::io::Read;

const TAGLINE: &str =
    "the UI design surface — the KitNode contract + themes (#1852) and the component library (#2469)";

/// The contract verbs bsc-ui owns. The component-library verbs are appended from
/// [`bsc_component::cli::command_docs`] by [`merged_commands`].
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
        name: "release",
        summary: "the global released-kit store — immutable id@version artifacts blueprints pin (#2465)",
        usage: "\
USAGE:
  bsc ui release list [--pretty]                 # every stored kit release's manifest (+ the packaged default)
  bsc ui release get <id@version> [--artifact]   # one manifest (or null); --artifact prints the artifact
  bsc ui release add <id> <version> [--kind component-kit|design-files] [--source URL] [--sha256 HEX] [--file PATH]
  bsc ui release remove <id@version>             # delete a materialized entry (packaged stays embedded)
  bsc ui release verify <id@version>             # recompute the artifact hash against the manifest

The versioned released-kit store at ~/.base-studio-code/kits/<id>/<version>/ (--dir/
BSC_UI_KIT_STORE_DIR override): one immutable copy per id@version — `{ id, version, sha256, kind,
source? }` manifest + the artifact — shared by every blueprint that pins it. (Distinct from the
mutable working kits of `bsc ui kit`, #2281/#2469: a RELEASE is a frozen published snapshot.) `add`
reads the artifact from stdin (or --file), verifies --sha256 BEFORE writing (mismatch ⇒ nothing
stored), and refuses to overwrite an existing version with different content (bump the version
instead). The packaged `bsc/react-ui` kit resolves as a built-in entry with zero setup.",
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

/// The merged command catalog (#2469): the contract verbs first, then the component-library verbs
/// verbatim. This one list drives the overview, per-command help, and the unknown-command error, so
/// every help surface shows the same coherent tree. (No names collide — schema/validate/theme/release
/// vs list/get/set/remove/kit/eslint-preset/usage; #2465's versioned store is deliberately named
/// `release`, NOT `kit`, so it cannot shadow the component-library `kit` verbs. If a collision ever
/// appeared, dispatch order makes the locally-owned verb win.)
fn merged_commands() -> Vec<CmdDoc> {
    let mut all = COMMANDS.to_vec();
    all.extend_from_slice(bsc_component::cli::command_docs());
    all
}

/// The `ui` subcommand entrypoint: `args` is everything after `bsc ui`; `prog` is the display name for
/// help/errors. Contract verbs (schema/validate/theme) dispatch here; the component-library verbs
/// delegate into [`bsc_component::cli::run`] under the same prog; anything else errors with the merged
/// overview.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    // Fold `-h`/`--help` to the `help` token so `bsc ui --help` (and `bsc ui <cmd> --help`) presents
    // the merged tree here rather than leaking into a delegate's partial catalog.
    let args: Vec<String> =
        args.into_iter().map(|a| if a == "-h" || a == "--help" { "help".into() } else { a }).collect();
    let merged = merged_commands();
    if bsc_cli_util::handle_help(prog, TAGLINE, &merged, &args) {
        return Ok(());
    }
    match args.first().map(String::as_str) {
        Some("schema") => cmd_schema(&args[1..]),
        Some("validate") => cmd_validate(&args[1..]),
        Some("release") => cmd_kit(&args[1..], prog),
        Some("theme") => cmd_theme(&args[1..]),
        // A KNOWN component-library verb (list/get/set/remove · kit · eslint-preset · usage) falls
        // through to the mounted store CLI, keeping this prog for its help/errors. Unknown verbs stay
        // ours so the error shows the MERGED overview, not the component-only one.
        Some(v) if bsc_component::cli::command_docs().iter().any(|c| c.name == v) => {
            bsc_component::cli::run(args, prog)
        }
        Some(other) => Err(bsc_cli_util::unknown_command(prog, TAGLINE, &merged, other)),
        None => {
            print!("{}", bsc_cli_util::help_overview(prog, TAGLINE, &merged));
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
        print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, "release"));
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
            let id = positional.get(1).ok_or("usage: bsc ui release add <id> <version> [--kind K] [--source URL] [--sha256 HEX] [--file PATH]")?;
            let version = positional.get(2).ok_or("usage: bsc ui release add <id> <version> …")?;
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
        other => Err(format!("unknown release command '{other}' — want: list | get | add | remove | verify")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_overview_lists_the_commands() {
        let ov = bsc_cli_util::help_overview("bsc ui", TAGLINE, COMMANDS);
        assert!(ov.contains("schema") && ov.contains("validate") && ov.contains("theme") && ov.contains("release"));
    }

    #[test]
    fn release_help_explains_the_store_contract() {
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMMANDS, "release");
        for needle in ["id@version", "immutable", "--sha256", "bsc/react-ui"] {
            assert!(d.contains(needle), "release help mentions {needle}");
        }
        // `bsc ui release help` routes to the same detail without touching the store.
        assert!(run(vec!["release".into(), "help".into()], "bsc ui").is_ok());
    }

    #[test]
    fn release_cli_round_trips_against_an_explicit_dir() {
        let dir = std::env::temp_dir().join(format!("bsc-ui-kit-cli-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let d = dir.to_string_lossy().to_string();
        let run_kit = |rest: &[&str]| {
            let mut args = vec!["release".to_string()];
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

    /// A fresh (created, empty) store dir so the component-verb tests never touch the user's real
    /// `~/.base-studio-code/{components,kits}` stores.
    fn tmp_store_dir(tag: &str) -> String {
        let d = std::env::temp_dir().join(format!("bsc-ui-cli-test-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    #[test]
    fn help_overview_lists_the_merged_tree() {
        // The one help surface presents BOTH families (#2469): the contract verbs + the mounted
        // component-library verbs.
        let ov = bsc_cli_util::help_overview("bsc ui", TAGLINE, &merged_commands());
        for c in [
            "schema", "validate", "theme", "list", "shapes", "get", "set", "remove", "kit",
            "eslint-preset", "usage",
        ] {
            assert!(ov.contains(c), "merged overview lists {c}");
        }
    }

    #[test]
    fn contract_verbs_dispatch_first() {
        // The bsc-ui-owned verbs are untouched by the mount: schema prints, theme round-trips.
        assert!(run(vec!["schema".into()], "bsc ui").is_ok());
        assert!(run(vec!["theme".into(), "list".into()], "bsc ui").is_ok());
        assert!(run(vec!["theme".into(), "get".into(), "default".into()], "bsc ui").is_ok());
        // `theme get` with no id is a usage error — `theme` wins over the component `get` (positional
        // disambiguation: the collision-prone words are one level down).
        assert!(run(vec!["theme".into(), "get".into()], "bsc ui").is_err());
    }

    #[test]
    fn component_store_verbs_dispatch_under_bsc_ui() {
        // The former `bsc component` root verbs work as `bsc ui …` (#2469), against a scratch --dir.
        let dir = tmp_store_dir("comp");
        assert!(run(vec!["list".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(run(vec!["list".into(), "--full".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(run(vec!["get".into(), "absent".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(run(vec!["remove".into(), "absent".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        // The kit collection routes one level down, and eslint-preset (the custom store read, #2279)
        // works over an empty store.
        assert!(run(vec!["kit".into(), "list".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(run(vec!["eslint-preset".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        // The #2475 shape picker mounts too: the `shapes` verb + the `list --shape` filter.
        assert!(run(vec!["shapes".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(
            run(vec!["list".into(), "--shape".into(), "graph".into(), "--dir".into(), dir], "bsc ui").is_ok()
        );
    }

    #[test]
    fn component_verb_help_resolves_through_the_merged_catalog() {
        // `bsc ui <component-verb> help` / `bsc ui help <verb>` are answered HERE (merged tree).
        assert!(run(vec!["set".into(), "help".into()], "bsc ui").is_ok());
        assert!(run(vec!["usage".into(), "help".into()], "bsc ui").is_ok());
        assert!(run(vec!["help".into(), "kit".into()], "bsc ui").is_ok());
        // ... and the component docs teach the canonical `bsc ui` form.
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, &merged_commands(), "set");
        assert!(d.contains("bsc ui set"));
    }

    #[test]
    fn validate_detail_explains_ok_and_exit() {
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMMANDS, "validate");
        assert!(d.contains("stdin") && d.contains("ok"));
    }

    #[test]
    fn run_help_is_ok_without_args_and_folds_help_flags() {
        assert!(run(vec!["help".into()], "bsc ui").is_ok());
        assert!(run(vec![], "bsc ui").is_ok());
        // `--help`/-h fold to the help token so the merged tree answers them.
        assert!(run(vec!["--help".into()], "bsc ui").is_ok());
        assert!(run(vec!["-h".into()], "bsc ui").is_ok());
    }

    #[test]
    fn run_unknown_command_errors_with_the_merged_overview() {
        // An unknown verb is OUR error (not the component CLI's), so the pointer shows the whole tree.
        let err = run(vec!["frobnicate".into()], "bsc ui").unwrap_err();
        assert!(err.contains("unknown command 'frobnicate'"));
        assert!(err.contains("schema") && err.contains("eslint-preset"), "merged overview in the error");
    }
}
