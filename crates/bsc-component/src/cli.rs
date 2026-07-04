//! The `bsc component` subcommand (#2281) — the component-library shim over the shared verbatim-
//! JSON-per-id store CLI ([`bsc_json_store::cli`], #2158). TWO collections: the **components**
//! (`~/.base-studio-code/components/<id>.json`) and the **kits** (`~/.base-studio-code/kits/<id>.json`),
//! each list/get/set/remove-able from a session's own shell — the same store the desktop Component
//! Library pane reads/writes and an agent reaches to reuse a proven component instead of re-inventing it.
//!
//! `bsc component <cmd>` operates on components; `bsc component kit <cmd>` operates on kits. Dispatched
//! by the unified `bsc` binary (#1877) via [`run`]. Per-command help (#1762):
//!   bsc component help          # component commands
//!   bsc component kit help      # kit commands
//!   bsc component set help      # detailed help for ONE command
//!
//! Each collection resolves via `--dir <path>` or its env var, defaulting to `~/.base-studio-code/<seg>/`.

use bsc_cli_util::CmdDoc;
use bsc_json_store::cli::CliSpec;

const TAGLINE: &str = "the component library — proven components in technology-scoped kits (#2281)";
const KIT_TAGLINE: &str = "the component library's kits — technology-scoped component namespaces (#2281)";

const COMPONENT_COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every component's {id, name, kitId, role} (JSON)",
        usage: "\
USAGE:
  bsc component list [--full] [--pretty]

Prints every component's { id, name, kitId, role } as JSON (compact; --pretty for indented). --full
emits the COMPLETE component objects (variants + props + composes + guidance + source + …) as a plain
array — the full-fidelity read the desktop library hydration needs.",
    },
    CmdDoc {
        name: "get",
        summary: "print one component (JSON, verbatim) or null",
        usage: "\
USAGE:
  bsc component get <id> [--pretty]

Prints the stored component JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from component JSON on stdin; prints id(s)",
        usage: "\
USAGE:
  bsc component set [--pretty]   # component JSON (one object or an array) on stdin

Upserts each component by its (required, non-empty) \"id\" field, written verbatim. Prints the id(s)
written — how an agent (or the pane) authors/updates a component in the shared kit.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a component (no-op if absent)",
        usage: "\
USAGE:
  bsc component remove <id> [--pretty]

Deletes the component keyed by <id>. A no-op (not an error) when it does not exist.",
    },
    CmdDoc {
        name: "kit",
        summary: "operate on the KITS instead of the components",
        usage: "\
USAGE:
  bsc component kit list [--full] [--pretty]   # every kit's { id, name, stack }
  bsc component kit get <id> [--pretty]
  bsc component kit set [--pretty]             # kit JSON on stdin (upsert by id)
  bsc component kit remove <id> [--pretty]

A kit is a technology-scoped namespace of components ({ id, name, stack, dot }). `bsc component kit …`
is the same list/get/set/remove over the kit collection.",
    },
    CmdDoc {
        name: "eslint-preset",
        summary: "emit the kit's lint rules as an eslint config (bake into an app, #2279)",
        usage: "\
USAGE:
  bsc component eslint-preset [--kit K] [--pretty]

Emits `{ rules: { … } }` — the kit's auto-firing lint enforcement as a plain eslint config the
generated app EXTENDS, so an agent building on the kit can't quietly re-invent a component. Rules are
derived from each component's `wraps` hint (`no-restricted-syntax`: use <Button> not a raw <button>)
plus each component's authored `rules` (`no-restricted-imports`). --kit scopes to one kit (else every
component). Every message carries the escape hatch. The planner writes this into the app's eslint config
+ ensures CI and the worker gate run `lint`.",
    },
];

const KIT_COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every kit's {id, name, stack} (JSON)",
        usage: "\
USAGE:
  bsc component kit list [--full] [--pretty]

Every kit's { id, name, stack } as JSON (compact; --pretty for indented). --full emits the complete
kit objects (incl. the dot color) as a plain array.",
    },
    CmdDoc {
        name: "get",
        summary: "print one kit (JSON, verbatim) or null",
        usage: "USAGE:\n  bsc component kit get <id> [--pretty]\n\nThe stored kit JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from kit JSON on stdin; prints id(s)",
        usage: "USAGE:\n  bsc component kit set [--pretty]   # kit JSON (object or array) on stdin\n\nUpserts each kit by its \"id\", written verbatim.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a kit (no-op if absent)",
        usage: "USAGE:\n  bsc component kit remove <id> [--pretty]\n\nDeletes the kit keyed by <id>; a no-op when absent.",
    },
];

/// The component collection's knobs over the shared CLI. Lean `list` projects id/name/kitId/role.
const COMPONENT_SPEC: CliSpec = CliSpec {
    noun: "component",
    dir_env: "BSC_COMPONENT_DIR",
    dir_segment: "components",
    tagline: TAGLINE,
    commands: COMPONENT_COMMANDS,
    meta_fields: &["id", "name", "kitId", "role"],
};

/// The kit collection's knobs. Lean `list` projects id/name/stack.
const KIT_SPEC: CliSpec = CliSpec {
    noun: "kit",
    dir_env: "BSC_COMPONENT_KIT_DIR",
    dir_segment: "kits",
    tagline: KIT_TAGLINE,
    commands: KIT_COMMANDS,
    meta_fields: &["id", "name", "stack"],
};

/// The `component` subcommand entrypoint: `args` is everything after `bsc component`; `prog` is the
/// display name for help/errors. `bsc component kit …` routes to the KIT collection; everything else to
/// the COMPONENT collection — each is the shared verbatim-JSON store CLI over its own dir.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("kit") => {
            let kit_prog = format!("{prog} kit");
            bsc_json_store::cli::run(args.into_iter().skip(1).collect(), &kit_prog, &KIT_SPEC)
        }
        // `eslint-preset` is a custom read (store → eslint config), not a CRUD verb, so it's handled
        // here before delegating to the shared store CLI.
        Some("eslint-preset") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "eslint-preset"));
                Ok(())
            } else {
                cmd_eslint_preset(&args[1..])
            }
        }
        _ => bsc_json_store::cli::run(args, prog, &COMPONENT_SPEC),
    }
}

/// The escape-hatch clause every rule message carries — MUST stay byte-identical to
/// `src/features/components/lib/rules.ts` `ESCAPE_HATCH` (the two generators are one contract).
const ESCAPE_HATCH: &str = "If truly required, add `// eslint-disable-next-line <rule> -- <reason>`.";

/// `eslint-preset [--kit K] [--pretty]` — read the component store + emit the kit's lint rules as an
/// eslint config. The deterministic, agent-reachable twin of the frontend `toEslintPreset` (rules.ts);
/// the planner runs it to bake enforcement into a generated app.
fn cmd_eslint_preset(args: &[String]) -> Result<(), String> {
    let (mut kit, mut dir, mut pretty) = (None::<String>, None::<String>, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--kit" => kit = it.next().cloned(),
            "--dir" => dir = it.next().cloned(),
            "--pretty" => pretty = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => {}
        }
    }
    let store = match dir {
        Some(d) => bsc_json_store::Store::new(d, "component"),
        None => bsc_json_store::Store::open_default("components", "component")?,
    };
    let comps: Vec<serde_json::Value> =
        store.list().iter().filter_map(|j| serde_json::from_str(j).ok()).collect();
    let scoped: Vec<&serde_json::Value> = comps
        .iter()
        .filter(|c| match kit.as_deref() {
            Some(k) => c.get("kitId").and_then(serde_json::Value::as_str) == Some(k),
            None => true,
        })
        .collect();
    let preset = eslint_preset(&scoped);
    let json = if pretty {
        serde_json::to_string_pretty(&preset)
    } else {
        serde_json::to_string(&preset)
    };
    println!("{}", json.map_err(|e| e.to_string())?);
    Ok(())
}

/// One resolved lint rule (derived-from-`wraps` or authored), before it's rendered to eslint config.
struct Rule {
    kind: String,
    target: String,
    use_: String,
    message: Option<String>,
}

/// Collect a scoped set of components into their deduped lint rules — derived (`wraps`) first, then
/// authored `rules` (which OVERRIDE a derived rule for the same kind+target). A `BTreeMap` keys by
/// `kind:target` so the output is deterministic (stable generation).
fn collect_rules(components: &[&serde_json::Value]) -> Vec<Rule> {
    use serde_json::Value;
    let mut by_key: std::collections::BTreeMap<String, Rule> = std::collections::BTreeMap::new();
    for c in components {
        if let Some(w) = c.get("wraps").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            let name = c.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
            by_key.insert(
                format!("forbid-element:{w}"),
                Rule { kind: "forbid-element".into(), target: w.into(), use_: name, message: None },
            );
        }
    }
    for c in components {
        if let Some(rules) = c.get("rules").and_then(Value::as_array) {
            for r in rules {
                let kind = r.get("kind").and_then(Value::as_str).unwrap_or_default();
                let target = r.get("target").and_then(Value::as_str).unwrap_or_default();
                if target.is_empty() || !matches!(kind, "forbid-element" | "forbid-import") {
                    continue;
                }
                by_key.insert(
                    format!("{kind}:{target}"),
                    Rule {
                        kind: kind.into(),
                        target: target.into(),
                        use_: r.get("use").and_then(Value::as_str).unwrap_or_default().into(),
                        message: r.get("message").and_then(Value::as_str).map(String::from),
                    },
                );
            }
        }
    }
    by_key.into_values().collect()
}

fn rule_message(r: &Rule) -> String {
    if let Some(m) = &r.message {
        return m.clone();
    }
    let base = if r.kind == "forbid-element" {
        format!("Use the kit's <{}> instead of a raw <{}>.", r.use_, r.target)
    } else {
        format!("Import {} from the kit instead of \"{}\".", r.use_, r.target)
    };
    format!("{base} {ESCAPE_HATCH}")
}

/// Compile a scoped component set into `{ rules: { … } }` — mirrors `toEslintPreset` in rules.ts.
fn eslint_preset(components: &[&serde_json::Value]) -> serde_json::Value {
    use serde_json::{json, Value};
    let mut syntax: Vec<Value> = vec![json!("error")];
    let mut import_paths: Vec<Value> = Vec::new();
    for r in &collect_rules(components) {
        if r.kind == "forbid-element" {
            syntax.push(json!({
                "selector": format!("JSXOpeningElement[name.name='{}']", r.target),
                "message": rule_message(r),
            }));
        } else {
            import_paths.push(json!({ "name": r.target, "message": rule_message(r) }));
        }
    }
    let mut rules = serde_json::Map::new();
    if syntax.len() > 1 {
        rules.insert("no-restricted-syntax".into(), Value::Array(syntax));
    }
    if !import_paths.is_empty() {
        rules.insert("no-restricted-imports".into(), json!(["error", { "paths": import_paths }]));
    }
    json!({ "rules": Value::Object(rules) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_are_the_two_collections_with_the_right_lean_fields() {
        assert_eq!(COMPONENT_SPEC.noun, "component");
        assert_eq!(COMPONENT_SPEC.dir_segment, "components");
        assert_eq!(COMPONENT_SPEC.meta_fields, &["id", "name", "kitId", "role"]);
        assert_eq!(KIT_SPEC.noun, "kit");
        assert_eq!(KIT_SPEC.dir_segment, "kits");
        assert_eq!(KIT_SPEC.meta_fields, &["id", "name", "stack"]);
        // The two collections live in DIFFERENT dirs (a component and a kit can share an id).
        assert_ne!(COMPONENT_SPEC.dir_segment, KIT_SPEC.dir_segment);
        assert_ne!(COMPONENT_SPEC.dir_env, KIT_SPEC.dir_env);
    }

    #[test]
    fn component_help_lists_commands_incl_the_kit_pointer() {
        let ov = bsc_cli_util::help_overview("bsc component", TAGLINE, COMPONENT_COMMANDS);
        for c in ["list", "get", "set", "remove", "kit"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        // The kit pointer's detail explains the sub-noun.
        let kit = bsc_cli_util::help_for("bsc component", TAGLINE, COMPONENT_COMMANDS, "kit");
        assert!(kit.contains("bsc component kit"));
    }

    #[test]
    fn kit_help_lists_the_kit_crud() {
        let ov = bsc_cli_util::help_overview("bsc component kit", KIT_TAGLINE, KIT_COMMANDS);
        for c in ["list", "get", "set", "remove"] {
            assert!(ov.contains(c), "kit overview lists {c}");
        }
    }

    #[test]
    fn component_help_lists_the_eslint_preset_command() {
        let ov = bsc_cli_util::help_overview("bsc component", TAGLINE, COMPONENT_COMMANDS);
        assert!(ov.contains("eslint-preset"));
        let d = bsc_cli_util::help_for("bsc component", TAGLINE, COMPONENT_COMMANDS, "eslint-preset");
        assert!(d.contains("--kit") && d.contains("eslint config"));
    }

    #[test]
    fn eslint_preset_derives_no_restricted_syntax_from_wraps() {
        let button = serde_json::json!({ "id": "button", "name": "Button", "kitId": "react-ui", "wraps": "button" });
        let preset = eslint_preset(&[&button]);
        let syntax = preset["rules"]["no-restricted-syntax"].as_array().unwrap();
        assert_eq!(syntax[0], "error");
        assert_eq!(syntax[1]["selector"], "JSXOpeningElement[name.name='button']");
        let msg = syntax[1]["message"].as_str().unwrap();
        assert!(msg.contains("<Button>") && msg.contains("<button>") && msg.contains(ESCAPE_HATCH));
    }

    #[test]
    fn eslint_preset_maps_authored_forbid_import_to_no_restricted_imports() {
        let c = serde_json::json!({
            "id": "x", "name": "X", "kitId": "react-ui",
            "rules": [{ "id": "r", "kind": "forbid-import", "target": "@mui/material", "use": "Button" }],
        });
        let preset = eslint_preset(&[&c]);
        let imp = &preset["rules"]["no-restricted-imports"];
        assert_eq!(imp[0], "error");
        assert_eq!(imp[1]["paths"][0]["name"], "@mui/material");
        assert!(imp[1]["paths"][0]["message"].as_str().unwrap().contains("Button"));
    }

    #[test]
    fn authored_rule_overrides_a_derived_one_for_the_same_target() {
        // Button wraps "button" (derived), and an authored rule for the same element points elsewhere.
        let button = serde_json::json!({
            "id": "button", "name": "Button", "kitId": "react-ui", "wraps": "button",
            "rules": [{ "id": "r", "kind": "forbid-element", "target": "button", "use": "MyButton", "message": "custom" }],
        });
        let preset = eslint_preset(&[&button]);
        let syntax = preset["rules"]["no-restricted-syntax"].as_array().unwrap();
        // Exactly one rule for the button element (no duplicate), and it's the authored one.
        assert_eq!(syntax.len(), 2, "error + one rule");
        assert_eq!(syntax[1]["message"], "custom");
    }

    #[test]
    fn empty_component_set_yields_an_empty_rules_object() {
        assert_eq!(eslint_preset(&[]), serde_json::json!({ "rules": {} }));
    }
}
