//! The `bsc ui` subcommand — the ONE UI-design-surface command (#2469). Three verb families under a
//! single mount, so a restricted design session is expressible as one allow rule (`Bash(bsc ui *)`):
//!
//! - the **contract** verbs (#1852, owned here, over the embedded KitNode contract
//!   `crate::CONTRACT_JSON`): `schema` (print the contract — every kind, its fields + enums),
//!   `validate [file]` (check a KitNode spec, a file else stdin, against it), and
//!   `theme list|get|set|remove` (the kit THEME collection — a designer-writable verbatim-JSON store
//!   at `~/.base-studio-code/themes/` seeded by the desktop from the embedded registry, #2488; the
//!   reads MERGE the embedded built-ins in so a pre-seed session still sees every theme, and the
//!   mutations are ui-scope gated like the component `set`/`remove`, #2470).
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
        summary: "the kit THEME store — list/get themes, or author them via set/remove (#1852/#2488)",
        usage: "\
USAGE:
  bsc ui theme list [--full] [--pretty]      # every theme's { id, label, description }; --full = complete objects
  bsc ui theme get <id> [--pretty]           # one theme verbatim (id, label, description, vars), or null
  bsc ui theme set [--file PATH] [--pretty]  # theme JSON (object or array) on stdin or --file; upsert by id
  bsc ui theme remove <id> [--pretty]        # delete a stored theme (packaged built-ins stay embedded)

A theme is a map of semantic component-token overrides (--card-*/--btn-*/--field-*/--chip-*) applied
globally (:root) or scoped to a subtree — restyling every card/button/field/chip without touching a
spec's structure. This is the SDK's THEME axis (style × theme × spec); the same collection the desktop
theme picker reads. Themes live in the designer-writable store at ~/.base-studio-code/themes/ (--dir/
BSC_UI_THEME_DIR override, #2488); the reads MERGE the packaged built-ins in, so every theme is always
visible and removing a built-in's stored copy falls back to the embedded one. `set`/`remove` are
ui-scope MUTATIONS (#2470): they refuse when the session's $BSC_SCOPES grants only `ui: read`.
`bsc ui theme get default` prints the shape to author against — palettes only: override the semantic
tokens, never a spec's structure.",
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
        Some("theme") => cmd_theme(&args[1..], prog),
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

/// The theme store's location knobs (#2488): `--dir` → `$BSC_UI_THEME_DIR` →
/// `~/.base-studio-code/themes/` — the same flag→env→default precedence as every store CLI.
const THEME_DIR_ENV: &str = "BSC_UI_THEME_DIR";
const THEME_DIR_SEGMENT: &str = "themes";

/// Resolve the designer-writable theme store (#2488) — a verbatim-JSON-per-id store like the
/// component/kit collections, in its own `themes/` dir so ids can never collide with a kit's.
fn theme_store(dir: &Option<String>) -> Result<bsc_json_store::Store, String> {
    let dir = bsc_cli_util::resolve_store_path(dir, THEME_DIR_ENV, || {
        bsc_util::bsc_base_dir()
            .map(|b| b.join(THEME_DIR_SEGMENT))
            .ok_or_else(|| "could not resolve a home directory; set HOME/USERPROFILE".to_string())
    })?;
    Ok(bsc_json_store::Store::new(dir, "theme"))
}

/// The embedded built-in themes as store-shaped records: `builtin: true` stamped in, so the desktop's
/// hash-based seed reconcile (#2483) recognizes a not-yet-materialized built-in as a PACKAGED copy
/// (refresh/seed it) rather than a user-authored theme (keep it forever).
fn embedded_themes() -> Vec<serde_json::Value> {
    crate::themes()
        .into_iter()
        .map(|mut t| {
            if let Some(o) = t.as_object_mut() {
                o.entry("builtin").or_insert(serde_json::Value::Bool(true));
            }
            t
        })
        .collect()
}

/// The `theme list` read set: the STORED themes (verbatim, in store order) plus every embedded
/// built-in the store doesn't hold yet (stamped `builtin: true`). A store copy wins by id — so a
/// designer-edited built-in shows the edit — and a fresh install lists exactly the packaged registry,
/// keeping the pre-store output shape (#2488). Pure → unit-testable.
fn merge_with_embedded(stored: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let have: Vec<String> = stored
        .iter()
        .filter_map(|t| t.get("id").and_then(serde_json::Value::as_str).map(String::from))
        .collect();
    let mut all = stored;
    for t in embedded_themes() {
        let id = t.get("id").and_then(serde_json::Value::as_str).unwrap_or_default();
        if !have.iter().any(|h| h.as_str() == id) {
            all.push(t);
        }
    }
    all
}

/// `bsc ui theme …` (#1852 Phase 3 + #2488) — the kit THEME collection. Reads (`list`/`get`) merge the
/// packaged built-ins under the store; the mutations (`set`/`remove`) persist to the theme store and
/// are gated by the session's runtime `ui` scope (#2470) BEFORE any store is touched — the same
/// defense-in-depth as the component `set`/`remove`, wired here because the theme verbs are bsc-ui's
/// own (not delegated to `bsc_component::cli`, whose gate can't see them). The trailing `help` form
/// (`theme set help`) is documentation, never a mutation — it must stay reachable read-scoped.
fn cmd_theme(args: &[String], prog: &str) -> Result<(), String> {
    let (mut dir, mut file) = (None::<String>, None::<String>);
    let (mut pretty, mut full) = (false, false);
    let mut positional: Vec<String> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--file" => file = it.next().cloned(),
            "--pretty" => pretty = true,
            "--full" => full = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => positional.push(a.clone()),
        }
    }
    let verb = positional.first().map(String::as_str).unwrap_or("list");
    // `theme <verb> help` (and a stray `theme help`, though run()'s handle_help catches that form)
    // resolves to the theme doc — reachable from ANY scope, before the mutation gate below.
    if verb == "help" || positional.get(1).map(String::as_str) == Some("help") {
        print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, "theme"));
        return Ok(());
    }
    let emit = |v: &serde_json::Value| -> Result<(), String> {
        let s = if pretty { serde_json::to_string_pretty(v) } else { serde_json::to_string(v) };
        println!("{}", s.map_err(|e| e.to_string())?);
        Ok(())
    };
    match verb {
        "list" => {
            let stored: Vec<serde_json::Value> =
                theme_store(&dir)?.list().iter().filter_map(|j| serde_json::from_str(j).ok()).collect();
            let all = merge_with_embedded(stored);
            if full {
                emit(&serde_json::Value::Array(all))
            } else {
                let lean: Vec<serde_json::Value> = all
                    .iter()
                    .map(|t| serde_json::json!({ "id": t.get("id"), "label": t.get("label"), "description": t.get("description") }))
                    .collect();
                emit(&serde_json::Value::Array(lean))
            }
        }
        "get" => {
            let id = positional.get(1).ok_or("usage: bsc ui theme get <id>")?;
            match theme_store(&dir)?.get(id)? {
                // A stored theme prints verbatim (the store owns the shape), re-indented under --pretty.
                Some(json) => match serde_json::from_str::<serde_json::Value>(&json) {
                    Ok(v) if pretty => emit(&v),
                    _ => {
                        println!("{}", json.trim_end());
                        Ok(())
                    }
                },
                // Not materialized → the embedded built-in (builtin-stamped), else null.
                None => emit(
                    &embedded_themes()
                        .into_iter()
                        .find(|t| t.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str()))
                        .unwrap_or(serde_json::Value::Null),
                ),
            }
        }
        "set" => {
            // ui-scope MUTATION gate (#2470) — refuse BEFORE reading input or resolving the store.
            bsc_cli_util::require_write_scope("ui")?;
            let raw = match file {
                Some(p) => std::fs::read_to_string(&p).map_err(|e| format!("cannot read {p}: {e}"))?,
                None => {
                    let mut s = String::new();
                    std::io::stdin().read_to_string(&mut s).map_err(|e| format!("cannot read stdin: {e}"))?;
                    s
                }
            };
            let v: serde_json::Value =
                serde_json::from_str(&raw).map_err(|e| format!("theme is not valid JSON: {e}"))?;
            let items = match v {
                serde_json::Value::Array(a) => a,
                other => vec![other],
            };
            let store = theme_store(&dir)?;
            let mut ids = Vec::new();
            for item in &items {
                let id = bsc_json_store::cli::id_of(item, "theme")?;
                let json = serde_json::to_string(item).map_err(|e| format!("set: {e}"))?;
                store.set(&id, &json)?;
                ids.push(id);
            }
            emit(&serde_json::json!(ids))
        }
        "remove" => {
            bsc_cli_util::require_write_scope("ui")?;
            let id = positional.get(1).ok_or("usage: bsc ui theme remove <id>")?;
            theme_store(&dir)?.remove(id)?;
            emit(&serde_json::json!(id))
        }
        other => Err(format!("unknown theme command '{other}' — want: list | get <id> | set | remove <id>")),
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

    /// Serializes every test that either SETS `$BSC_SCOPES` or drives a scope-GATED verb (`set` /
    /// `remove` on any collection): tests run in parallel threads sharing the process environment,
    /// so an unguarded scope test would make a concurrent mutation flakily refuse. Poisoning is
    /// ignored (an assert failure in one test must not cascade).
    static SCOPES_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
        // Drives gated verbs (`remove`) → hold the scopes lock so a concurrent scope test can't
        // flip $BSC_SCOPES mid-run.
        let _guard = SCOPES_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var(bsc_cli_util::BSC_SCOPES_ENV);
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

    // ── the designer-writable theme store (#2488) ────────────────────────────────────────────────

    #[test]
    fn theme_help_documents_the_store_verbs() {
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMMANDS, "theme");
        for needle in ["set", "remove", "--file", "BSC_UI_THEME_DIR", "$BSC_SCOPES", "--full"] {
            assert!(d.contains(needle), "theme help mentions {needle}");
        }
        // `bsc ui theme help` (top-level dispatch) and the trailing per-verb forms all resolve.
        assert!(run(vec!["theme".into(), "help".into()], "bsc ui").is_ok());
        assert!(run(vec!["theme".into(), "list".into(), "help".into()], "bsc ui").is_ok());
    }

    #[test]
    fn merge_with_embedded_serves_builtins_under_the_store() {
        // An empty store lists exactly the packaged registry (the pre-store output), builtin-stamped.
        let fresh = merge_with_embedded(Vec::new());
        assert_eq!(fresh.len(), crate::themes().len());
        assert!(fresh.iter().any(|t| t["id"] == "default"));
        for t in &fresh {
            assert_eq!(t["builtin"], serde_json::json!(true), "embedded fallbacks are builtin-stamped");
        }
        // A stored copy WINS by id (a designer-edited built-in shows the edit) and keeps store order
        // first; embedded built-ins the store lacks are appended.
        let edited = serde_json::json!({ "id": "soft", "label": "Softer", "description": "d", "vars": {} });
        let user = serde_json::json!({ "id": "neon", "label": "Neon", "description": "d", "vars": {} });
        let merged = merge_with_embedded(vec![edited.clone(), user.clone()]);
        assert_eq!(merged[0], edited, "store copy of a built-in wins");
        assert_eq!(merged[1], user, "user themes ride verbatim");
        assert_eq!(merged.iter().filter(|t| t["id"] == "soft").count(), 1, "no duplicate for an overridden built-in");
        assert!(merged.iter().any(|t| t["id"] == "default"), "missing built-ins appended");
    }

    #[test]
    fn theme_cli_round_trips_against_an_explicit_dir() {
        // Drives gated verbs (`theme set`/`remove`) → hold the scopes lock (see SCOPES_ENV_LOCK).
        let _guard = SCOPES_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var(bsc_cli_util::BSC_SCOPES_ENV);
        let dir = tmp_store_dir("theme");
        let run_theme = |rest: &[&str]| {
            let mut args = vec!["theme".to_string()];
            args.extend(rest.iter().map(|s| s.to_string()));
            args.extend(["--dir".to_string(), dir.clone()]);
            run(args, "bsc ui")
        };
        // Reads work over the empty store (embedded fallback keeps the pre-store semantics).
        run_theme(&["list"]).unwrap();
        run_theme(&["list", "--full", "--pretty"]).unwrap();
        run_theme(&["get", "default"]).unwrap();
        // set via --file (stdin isn't drivable in a unit test) — the source file lives OUTSIDE the
        // store dir so `list` can't pick it up as a record.
        let src = std::env::temp_dir().join(format!("bsc-ui-theme-src-{}.json", std::process::id()));
        std::fs::write(&src, r#"{"id":"neon","label":"Neon","description":"glow","vars":{"--card-bg":"black"}}"#).unwrap();
        run_theme(&["set", "--file", src.to_str().unwrap()]).unwrap();
        let store = bsc_json_store::Store::new(dir.clone(), "theme");
        assert_eq!(
            store.get("neon").unwrap().as_deref(),
            Some(r#"{"id":"neon","label":"Neon","description":"glow","vars":{"--card-bg":"black"}}"#),
            "stored verbatim"
        );
        run_theme(&["get", "neon"]).unwrap();
        run_theme(&["get", "neon", "--pretty"]).unwrap();
        // An array upserts every element by id.
        std::fs::write(&src, r#"[{"id":"a1","label":"A","description":"","vars":{}},{"id":"b2","label":"B","description":"","vars":{}}]"#).unwrap();
        run_theme(&["set", "--file", src.to_str().unwrap()]).unwrap();
        assert!(store.get("a1").unwrap().is_some() && store.get("b2").unwrap().is_some());
        // remove deletes the stored record; a removed built-in override falls back to embedded (get ok).
        run_theme(&["remove", "neon"]).unwrap();
        assert!(store.get("neon").unwrap().is_none());
        run_theme(&["get", "neon"]).unwrap(); // prints null, still Ok
        // A theme without an id is rejected; garbage JSON is rejected; unknown verbs error.
        std::fs::write(&src, r#"{"label":"NoId"}"#).unwrap();
        assert!(run_theme(&["set", "--file", src.to_str().unwrap()]).is_err());
        std::fs::write(&src, "not json").unwrap();
        assert!(run_theme(&["set", "--file", src.to_str().unwrap()]).is_err());
        assert!(run_theme(&["frobnicate"]).is_err());
        assert!(run_theme(&["get"]).is_err(), "get without an id is a usage error");
        assert!(run_theme(&["remove"]).is_err(), "remove without an id is a usage error");
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn theme_mutations_refuse_under_a_read_ui_scope_and_help_stays_reachable() {
        let _guard = SCOPES_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var(bsc_cli_util::BSC_SCOPES_ENV, r#"{"ui":"read"}"#);
        // The mutations refuse AT THE GATE — before stdin/--file is read or any store dir resolved
        // (no --dir/--file passed on purpose: reaching either would hang on stdin / touch the real
        // default store).
        let err = run(vec!["theme".into(), "set".into()], "bsc ui").unwrap_err();
        assert!(err.contains("'ui'"), "refusal names the scope: {err}");
        assert!(err.contains("BSC_SCOPES"), "refusal names the env doc: {err}");
        let err = run(vec!["theme".into(), "remove".into(), "x".into()], "bsc ui").unwrap_err();
        assert!(err.contains("read-only"), "remove refuses too: {err}");
        // Reads keep working under the read scope (the planner's `ui: read` can list/get themes) …
        let dir = tmp_store_dir("theme-read");
        assert!(run(vec!["theme".into(), "list".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(run(vec!["theme".into(), "get".into(), "default".into(), "--dir".into(), dir], "bsc ui").is_ok());
        // … and the trailing `help` forms are documentation, not mutations — reachable read-scoped.
        assert!(run(vec!["theme".into(), "set".into(), "help".into()], "bsc ui").is_ok());
        assert!(run(vec!["theme".into(), "remove".into(), "help".into()], "bsc ui").is_ok());
        std::env::remove_var(bsc_cli_util::BSC_SCOPES_ENV);
    }
}
