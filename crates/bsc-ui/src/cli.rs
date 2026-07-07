//! The `bsc ui` subcommand — the ONE UI-design-surface command (#2469). Two verb families under a
//! single mount, so a restricted design session is expressible as one allow rule (`Bash(bsc ui *)`):
//!
//! - the **contract** verbs (#1852, owned here, over the embedded KitNode contract
//!   `crate::CONTRACT_JSON`): `schema` (print the contract — every kind, its fields + enums),
//!   `validate [file]` (check a KitNode spec, a file else stdin, against it), and `theme list|get`
//!   (the kit THEME registry).
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
/// every help surface shows the same coherent tree. (No names collide today — schema/validate/theme
/// vs list/get/set/remove/kit/eslint-preset/usage — and if one ever did, dispatch order makes the
/// contract verb win.)
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

#[cfg(test)]
mod tests {
    use super::*;

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
        for c in
            ["schema", "validate", "theme", "list", "get", "set", "remove", "kit", "eslint-preset", "usage"]
        {
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
        assert!(run(vec!["eslint-preset".into(), "--dir".into(), dir], "bsc ui").is_ok());
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
