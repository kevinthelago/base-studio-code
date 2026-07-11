//! The component-library CLI (#2281) — the shim over the shared verbatim-JSON-per-id store CLI
//! ([`bsc_json_store::cli`], #2158). TWO collections: the **components**
//! (`~/.base-studio-code/components/<id>.json`) and the **kits** (`~/.base-studio-code/kits/<id>.json`),
//! each list/get/set/remove-able from a session's own shell — the same store the desktop Component
//! Library pane reads/writes and an agent reaches to reuse a proven component instead of re-inventing it.
//!
//! **Mounted under `bsc ui` (#2469)** — the one UI-design-surface command: `bsc ui <cmd>` operates on
//! components; `bsc ui kit <cmd>` operates on kits (`bsc_ui::cli` delegates the store verbs here via
//! [`run`], composing [`command_docs`] into its merged help tree). `bsc component …` remains a thin
//! DEPRECATED alias for one release (the umbrella `bsc` prints a stderr pointer, then delegates here
//! unchanged — the #1721 `bsc plan integration` → `bsc data connector` pattern). Per-command help
//! (#1762):
//!   bsc ui help          # the merged UI-surface commands
//!   bsc ui kit help      # kit commands
//!   bsc ui set help      # detailed help for ONE command
//!
//! Each collection resolves via `--dir <path>` or its env var, defaulting to `~/.base-studio-code/<seg>/`.

use bsc_cli_util::CmdDoc;
use bsc_json_store::cli::CliSpec;

const TAGLINE: &str = "the component library — proven components in technology-scoped kits (#2281)";
const KIT_TAGLINE: &str = "the component library's kits — technology-scoped component namespaces (#2281)";

/// The data-shape vocabulary (#2475) — the six canonical shapes a feature's data can take, each with
/// the one-line description `bsc ui shapes` prints. A component's optional `shapes` JSON field stamps
/// the shapes it is an IDEAL rendering for; the CLI computes the index from those fields verbatim
/// (no Rust schema — the store stays verbatim JSON). Mirrors `DataShape` in
/// `src/features/components/lib/model.ts`.
const DATA_SHAPES: &[(&str, &str)] = &[
    ("list", "a flat, ordered collection of homogeneous items"),
    ("linked-list", "a sequence whose items chain by explicit next/prev links"),
    ("tree", "a hierarchy — every item nests under a single parent"),
    ("graph", "nodes joined by arbitrary edges (many-to-many)"),
    ("table", "homogeneous records with fixed, aligned columns"),
    ("key-value", "one record's named fields — a label → value map"),
];

const COMPONENT_COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every component's {id, name, kitId, role, shapes} (JSON)",
        usage: "\
USAGE:
  bsc ui list [--shape <shape>] [--full] [--pretty]

Prints every component's { id, name, kitId, role, shapes } as JSON (compact; --pretty for indented).
--shape filters to the components whose `shapes` field stamps <shape> — the kit's IDEAL renderings
for that data shape (#2475; one of list · linked-list · tree · graph · table · key-value — see
`bsc ui shapes`). --full emits the COMPLETE component objects (variants + props + composes + guidance
+ source + …) as a plain array — the full-fidelity read the desktop library hydration needs.",
    },
    CmdDoc {
        name: "shapes",
        summary: "the data-shape vocabulary → each shape's ideal components (#2475)",
        usage: "\
USAGE:
  bsc ui shapes [<shape>] [--pretty]

Prints the six-shape data vocabulary — list · linked-list · tree · graph · table · key-value — as a
JSON array of { shape, desc, components }, where components are the stored components whose `shapes`
field stamps that shape (the kit's IDEAL renderings for it, as lean {id, name, kitId, role, shapes}
rows). With <shape>, prints just that shape's entry. An EMPTY components array means the kit has no
ideal layout for that shape yet — a genuine gap to record, not a fit to force. Read-only: how the
planner picks a layout — derive the data's shape, then `bsc ui shapes <shape>` (or the equivalent
filter, `bsc ui list --shape <shape>`).",
    },
    CmdDoc {
        name: "get",
        summary: "print one component (JSON, verbatim) or null",
        usage: "\
USAGE:
  bsc ui get <id> [--pretty]

Prints the stored component JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from component JSON on stdin; prints id(s)",
        usage: "\
USAGE:
  bsc ui set [--pretty]   # component JSON (one object or an array) on stdin

Upserts each component by its (required, non-empty) \"id\" field, written verbatim. Prints the id(s)
written — how an agent (or the pane) authors/updates a component in the shared kit.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a component (no-op if absent)",
        usage: "\
USAGE:
  bsc ui remove <id> [--pretty]

Deletes the component keyed by <id>. A no-op (not an error) when it does not exist.",
    },
    CmdDoc {
        name: "kit",
        summary: "operate on the KITS instead of the components",
        usage: "\
USAGE:
  bsc ui kit list [--full] [--pretty]   # every kit's { id, name, stack }
  bsc ui kit get <id> [--pretty]
  bsc ui kit set [--pretty]             # kit JSON on stdin (upsert by id)
  bsc ui kit remove <id> [--pretty]

A kit is a technology-scoped namespace of components ({ id, name, stack, dot }). `bsc ui kit …`
is the same list/get/set/remove over the kit collection.",
    },
    CmdDoc {
        name: "eslint-preset",
        summary: "emit the kit's lint rules as an eslint config (bake into an app, #2279)",
        usage: "\
USAGE:
  bsc ui eslint-preset [--kit K] [--pretty]

Emits `{ rules: { … } }` — the kit's auto-firing lint enforcement as a plain eslint config the
generated app EXTENDS, so an agent building on the kit can't quietly re-invent a component. Rules are
derived from each component's `wraps` hint (`no-restricted-syntax`: use <Button> not a raw <button>)
plus each component's authored `rules` (`no-restricted-imports`). --kit scopes to one kit (else every
component). Every message carries the escape hatch. The planner writes this into the app's eslint config
+ ensures CI and the worker gate run `lint`.",
    },
    CmdDoc {
        name: "usage",
        summary: "the consumer index — which projects use which kit (#2277)",
        usage: "\
USAGE:
  bsc ui usage list [--json]              # every (projectKey, kitId) consumer edge
  bsc ui usage add <projectKey> <kitId>   # record that a project uses a kit (idempotent; prints the id)
  bsc ui usage remove <id>                # remove an edge by id (id is \"<projectKey>><kitId>\")

The consumer index a kit CHANGE fans out over (#2277): who to notify when a component in the kit
changes. A flat edge store at ~/.base-studio-code/kit-usage.json (like `bsc project link`). Recorded at
planning (a project seeded from a kit-bearing blueprint uses that kit).",
    },
    CmdDoc {
        name: "doctor",
        summary: "graph-health report — orphans, dead branches, duplicates, cycles, unbuildable components (#2678)",
        usage: "\
USAGE:
  bsc ui doctor [--kit K] [--json] [--pretty]     # the health report (read-only)
  bsc ui doctor --fix [--kit K] [--yes]           # prune the safe dead roots (dry-run unless --yes)

Traverses each kit's composition graph (nodes = components, edges = `composes`) and reports the
dead/duplicated design a growing kit accumulates: CYCLE (a composes loop), DANGLING-BRANCH (an unused
root that still pulls in dependencies), DUPLICATE (two components wrapping the same intrinsic, or
byte-identical source), NO-IMPLEMENTATION (a component the Design Studio preview can't build — a spec,
not code; a built-in whose real source lives in the packaged artifact is NOT flagged), and ORPHAN (an
isolated, never-referenced primitive/composite). \"Unused\" = no composer AND used = 0; a page/layout
with used > 0 is a legit entry point, never flagged. Ranked most-severe-first; --kit scopes to one
kit; --json emits the findings array (LLM-consumable).

--fix prunes ONLY the safe set — the ROOT of each orphan/dangling-branch finding (never a used > 0
node, never a duplicate, cycle, or no-implementation). It is a DRY RUN by default (prints what WOULD be
removed); pass --yes to apply. Branch descendants are left for the next pass (one might be shared) —
re-run to clean them. #2678/#2679/#2839.",
    },
];

const KIT_COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every kit's {id, name, stack} (JSON)",
        usage: "\
USAGE:
  bsc ui kit list [--full] [--pretty]

Every kit's { id, name, stack } as JSON (compact; --pretty for indented). --full emits the complete
kit objects (incl. the dot color) as a plain array.",
    },
    CmdDoc {
        name: "get",
        summary: "print one kit (JSON, verbatim) or null",
        usage: "USAGE:\n  bsc ui kit get <id> [--pretty]\n\nThe stored kit JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from kit JSON on stdin; prints id(s)",
        usage: "USAGE:\n  bsc ui kit set [--pretty]   # kit JSON (object or array) on stdin\n\nUpserts each kit by its \"id\", written verbatim.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a kit (no-op if absent)",
        usage: "USAGE:\n  bsc ui kit remove <id> [--pretty]\n\nDeletes the kit keyed by <id>; a no-op when absent.",
    },
];

/// The component collection's knobs over the shared CLI. Lean `list` projects id/name/kitId/role +
/// the data-shape axis (`shapes` rides the projection verbatim, #2475).
const COMPONENT_SPEC: CliSpec = CliSpec {
    noun: "component",
    dir_env: "BSC_COMPONENT_DIR",
    dir_segment: "components",
    tagline: TAGLINE,
    commands: COMPONENT_COMMANDS,
    meta_fields: &["id", "name", "kitId", "role", "shapes"],
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

/// The component-surface command catalog, exposed so `bsc ui` (#2469) can compose it verbatim into its
/// merged help tree AND gate which verbs it delegates here (unknown verbs stay `bsc ui`'s, so its
/// error shows the MERGED overview rather than this partial one).
pub fn command_docs() -> &'static [CmdDoc] {
    COMPONENT_COMMANDS
}

/// Whether `args` is one of the store's MUTATING verb invocations — `set` / `remove` on either
/// collection (`… set|remove` or `… kit set|remove`) — gated by the session's runtime `ui` scope
/// (#2470). The trailing `help` form (`set help`, `kit set help`) is NOT a mutation: help must stay
/// reachable from a read-scoped session. Read verbs (`list`/`get`/`eslint-preset`/`usage`/`kit
/// list|get`) never gate.
fn is_scoped_mutation(args: &[String]) -> bool {
    let (verb, next) = if args.first().map(String::as_str) == Some("kit") {
        (args.get(1), args.get(2))
    } else {
        (args.first(), args.get(1))
    };
    matches!(verb.map(String::as_str), Some("set") | Some("remove"))
        && next.map(String::as_str) != Some("help")
}

/// The component-verb entrypoint: `args` is everything after the mount point (`bsc ui`, or the
/// deprecated `bsc component` alias — `prog` is that display name for help/errors). `<prog> kit …`
/// routes to the KIT collection; everything else to the COMPONENT collection — each is the shared
/// verbatim-JSON store CLI over its own dir.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    // Runtime `ui` scope check (#2470, defense-in-depth): refuse the mutating verbs when the
    // session's `$BSC_SCOPES` doc scopes `ui` to read/none — BEFORE any store is touched. Guarding
    // here (the verb dispatch this crate owns) holds under BOTH mounts of the store CLI (`bsc ui`
    // and the deprecated `bsc component` alias, #2469). Absent env ⇒ unrestricted (hand shells);
    // NOT a security boundary — the launch-time deny rules are (see `bsc_cli_util`).
    if is_scoped_mutation(&args) {
        bsc_cli_util::require_write_scope("ui")?;
    }
    match args.first().map(String::as_str) {
        Some("kit") => {
            let kit_prog = format!("{prog} kit");
            // Emit a `ui-touch` for the Design Studio's live-focus (#2525) after each kit set/remove
            // write lands — WITH the "kit" collection context (bsc-json-store has none). A no-op for
            // read verbs (the hook only fires inside set/remove) and for non-designer sessions.
            bsc_json_store::cli::run_hooked(
                args.into_iter().skip(1).collect(),
                &kit_prog,
                &KIT_SPEC,
                Some(&|id: &str| bsc_util::emit_ui_activity("kit", id)),
            )
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
        // `usage` is the consumer index (kit_usage) — a flat edge store, not a per-record CRUD (#2277).
        Some("usage") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "usage"));
                Ok(())
            } else {
                cmd_usage(&args[1..], prog)
            }
        }
        // `shapes` is the data-shape picker (#2475): the vocabulary + each shape's ideal components,
        // computed from the stored `shapes` fields — a custom read, so it's handled here.
        Some("shapes") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "shapes"));
                Ok(())
            } else {
                cmd_shapes(&args[1..])
            }
        }
        // `doctor` (#2678) is a custom read — the graph-health analyzer over the component store.
        Some("doctor") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "doctor"));
                Ok(())
            } else {
                cmd_doctor(&args[1..])
            }
        }
        // `list --shape <shape>` (#2475) filters to one shape's ideal components — intercepted here
        // (the shared store CLI rejects unknown flags); a plain `list` still delegates unchanged.
        Some("list") if args.iter().any(|a| a == "--shape") => cmd_list_shape(&args[1..]),
        // The COMPONENT collection's list/get/set/remove. Fire the live-focus `ui-touch` (#2525) after
        // a component set/remove write lands, with the "component" collection context.
        _ => bsc_json_store::cli::run_hooked(
            args,
            prog,
            &COMPONENT_SPEC,
            Some(&|id: &str| bsc_util::emit_ui_activity("component", id)),
        ),
    }
}

/// Resolve the COMPONENT store with the same flag → env (`BSC_COMPONENT_DIR`) → default
/// (`~/.base-studio-code/components/`) precedence as the shared store CLI, for the custom reads.
fn open_component_store(dir: &Option<String>) -> Result<bsc_json_store::Store, String> {
    let dir = bsc_cli_util::resolve_store_path(dir, COMPONENT_SPEC.dir_env, || {
        bsc_util::bsc_base_dir()
            .map(|b| b.join(COMPONENT_SPEC.dir_segment))
            .ok_or_else(|| "could not resolve a home directory; set HOME/USERPROFILE".to_string())
    })?;
    Ok(bsc_json_store::Store::new(dir, "component"))
}

/// Validate a shape token against the six-shape vocabulary (#2475); the error teaches the whole set.
fn require_shape(shape: &str) -> Result<(), String> {
    if DATA_SHAPES.iter().any(|(s, _)| *s == shape) {
        return Ok(());
    }
    let all: Vec<&str> = DATA_SHAPES.iter().map(|(s, _)| *s).collect();
    Err(format!("unknown shape '{shape}' — the data-shape vocabulary is: {}", all.join(" | ")))
}

/// Whether a stored component's raw JSON stamps `shape` in its `shapes` array. Lenient: unparseable
/// records or a missing/odd-typed `shapes` field simply don't match (matching the lean-list posture).
fn json_has_shape(json: &str, shape: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("shapes").cloned())
        .and_then(|s| s.as_array().cloned())
        .is_some_and(|arr| arr.iter().any(|x| x.as_str() == Some(shape)))
}

/// The `shapes` index (#2475): each vocabulary entry (or just `only`) with its description and the
/// stored components that stamp it, as lean rows — `[{ shape, desc, components: [...] }]`.
fn shape_index(raw: &[String], only: Option<&str>) -> serde_json::Value {
    let entries: Vec<serde_json::Value> = DATA_SHAPES
        .iter()
        .filter(|(s, _)| only.is_none_or(|o| o == *s))
        .map(|(s, d)| {
            let comps: Vec<serde_json::Value> = raw
                .iter()
                .filter(|j| json_has_shape(j, s))
                .map(|j| bsc_json_store::cli::lean_meta(j, COMPONENT_SPEC.meta_fields))
                .collect();
            serde_json::json!({ "shape": s, "desc": d, "components": comps })
        })
        .collect();
    serde_json::Value::Array(entries)
}

/// `shapes [<shape>] [--dir D] [--pretty]` — print the data-shape vocabulary with each shape's ideal
/// components (#2475). A read verb: never scope-gated.
fn cmd_shapes(args: &[String]) -> Result<(), String> {
    let (mut dir, mut pretty, mut shape) = (None::<String>, false, None::<String>);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--pretty" => pretty = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            positional => shape = Some(positional.to_string()),
        }
    }
    if let Some(s) = &shape {
        require_shape(s)?;
    }
    let store = open_component_store(&dir)?;
    let index = shape_index(&store.list(), shape.as_deref());
    let json = if pretty { serde_json::to_string_pretty(&index) } else { serde_json::to_string(&index) };
    println!("{}", json.map_err(|e| e.to_string())?);
    Ok(())
}

/// `list --shape <shape> [--full] [--dir D] [--pretty]` — the filtered twin of the store `list`
/// (#2475): only the components whose `shapes` field stamps <shape>, in the SAME lean projection
/// (or --full objects). Validates the shape BEFORE any store is touched.
fn cmd_list_shape(args: &[String]) -> Result<(), String> {
    let (mut dir, mut pretty, mut full, mut shape) = (None::<String>, false, false, None::<String>);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--shape" => shape = it.next().cloned(),
            "--dir" => dir = it.next().cloned(),
            "--pretty" => pretty = true,
            "--full" => full = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => {}
        }
    }
    let shape = shape.ok_or("--shape needs a value (see `bsc ui shapes`)")?;
    require_shape(&shape)?;
    let store = open_component_store(&dir)?;
    let raw = store.list();
    let selected: Vec<&String> = raw.iter().filter(|j| json_has_shape(j, &shape)).collect();
    let out: Vec<serde_json::Value> = if full {
        selected.iter().filter_map(|j| serde_json::from_str(j).ok()).collect()
    } else {
        selected.iter().map(|j| bsc_json_store::cli::lean_meta(j, COMPONENT_SPEC.meta_fields)).collect()
    };
    let json = if pretty { serde_json::to_string_pretty(&out) } else { serde_json::to_string(&out) };
    println!("{}", json.map_err(|e| e.to_string())?);
    Ok(())
}

/// `doctor [--kit K] [--json] [--pretty]` (#2678) — the graph-health report. Reads the component
/// store, runs the pure analyzer ([`crate::graph_health::analyze`]), and prints the ranked findings
/// as JSON (`--json`, LLM-consumable) or a human summary. `--kit` scopes the OUTPUT to one kit (the
/// analyzer always groups by kit, so edges never cross kits regardless).
fn cmd_doctor(args: &[String]) -> Result<(), String> {
    let (mut dir, mut kit, mut json, mut pretty) = (None::<String>, None::<String>, false, false);
    let (mut fix, mut yes) = (false, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--kit" => kit = it.next().cloned(),
            "--json" => json = true,
            "--pretty" => pretty = true,
            "--fix" => fix = true,
            "--yes" => yes = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => return Err(format!("unexpected argument '{other}'")),
        }
    }
    // The write path (`--fix --yes`) removes records, so honor the runtime `ui` write-scope (#2470) —
    // a read-scoped session may run the report but not prune. A dry run stays read-only.
    if fix && yes {
        bsc_cli_util::require_write_scope("ui")?;
    }
    let store = open_component_store(&dir)?;
    let comps: Vec<serde_json::Value> = store
        .list()
        .iter()
        .filter_map(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .filter(|v| match &kit {
            Some(k) => v.get("kitId").and_then(serde_json::Value::as_str) == Some(k.as_str()),
            None => true,
        })
        .collect();

    if fix {
        return doctor_fix(&store, &comps, yes);
    }

    let findings = crate::graph_health::analyze(&comps);

    if json {
        let arr: Vec<serde_json::Value> = findings.iter().map(crate::graph_health::Finding::to_value).collect();
        let out = if pretty {
            serde_json::to_string_pretty(&arr)
        } else {
            serde_json::to_string(&arr)
        };
        println!("{}", out.map_err(|e| e.to_string())?);
        return Ok(());
    }

    // Human summary — one line per finding, most-severe first.
    if findings.is_empty() {
        let scope = kit.as_deref().map(|k| format!(" for kit '{k}'")).unwrap_or_default();
        println!("✓ design graph is healthy{scope} — no orphans, dead branches, duplicates, cycles, or unbuildable components.");
        return Ok(());
    }
    println!("{} finding(s), most-severe first:", findings.len());
    for f in &findings {
        println!("  [{}] {} — {}", f.category, f.kit, f.why);
        println!("        → {}", f.suggested_action);
    }
    Ok(())
}

/// The `doctor --fix` action (#2679) — prune the safe dead roots. Dry run unless `apply`. Confirm-
/// gated by construction: the removal set is `graph_health::prunable` (orphan/dead-root only, never a
/// `used > 0` node, never a duplicate/cycle). Duplicates present in the graph are surfaced as a
/// manual note so `--fix` never hides that there's more to reconcile by hand.
fn doctor_fix(store: &bsc_json_store::Store, comps: &[serde_json::Value], apply: bool) -> Result<(), String> {
    let prunable = crate::graph_health::prunable(comps);
    let dup_kinds = crate::graph_health::analyze(comps)
        .iter()
        .filter(|f| f.category == "duplicate" || f.category == "cycle")
        .count();

    if prunable.is_empty() {
        println!("✓ nothing safe to prune — no orphans or dead branch roots.");
        if dup_kinds > 0 {
            println!("  ({dup_kinds} duplicate/cycle finding(s) remain — reconcile by hand; see `bsc ui doctor`).");
        }
        return Ok(());
    }

    if !apply {
        println!("DRY RUN — {} node(s) WOULD be removed (pass --yes to apply):", prunable.len());
        for p in &prunable {
            println!("  - {} ({}) — {}", p.name, p.id, p.reason);
        }
        if dup_kinds > 0 {
            println!("  ({dup_kinds} duplicate/cycle finding(s) are NOT auto-pruned — reconcile by hand).");
        }
        return Ok(());
    }

    let mut removed = 0usize;
    for p in &prunable {
        store.remove(&p.id)?;
        println!("removed {} ({})", p.name, p.id);
        removed += 1;
    }
    println!("pruned {removed} node(s). Re-run `bsc ui doctor` — removing a root can newly orphan its children.");
    Ok(())
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

/// `usage list|add|remove` — the kit-usage consumer index (#2277). Defaults to `list`. A flat edge
/// store (crate::usage), not a per-record CRUD, so it's handled here rather than via the shared store CLI.
fn cmd_usage(args: &[String], prog: &str) -> Result<(), String> {
    let json = args.iter().any(|a| a == "--json");
    let positional: Vec<&str> = args.iter().filter(|a| !a.starts_with("--")).map(String::as_str).collect();
    match positional.first().copied().unwrap_or("list") {
        "list" => {
            let edges = crate::usage::load();
            if json {
                let arr: Vec<serde_json::Value> = edges
                    .iter()
                    .map(|u| serde_json::json!({ "id": u.id, "projectKey": u.project_key, "kitId": u.kit_id }))
                    .collect();
                println!("{}", serde_json::to_string(&arr).unwrap_or_else(|_| "[]".into()));
            } else if edges.is_empty() {
                println!("(no kit usage)");
            } else {
                for u in &edges {
                    println!("{}\t{} uses {}", u.id, u.project_key, u.kit_id);
                }
            }
            Ok(())
        }
        "add" => {
            let usage_err = || format!("usage: {prog} usage add <projectKey> <kitId>");
            let project_key = positional.get(1).ok_or_else(usage_err)?;
            let kit_id = positional.get(2).ok_or_else(usage_err)?;
            println!("{}", crate::usage::add(project_key, kit_id)?);
            Ok(())
        }
        "remove" => {
            let id = positional.get(1).ok_or_else(|| format!("usage: {prog} usage remove <id>"))?;
            crate::usage::remove(id)?;
            if !json {
                println!("removed {id}");
            }
            Ok(())
        }
        other => Err(format!(
            "unknown usage command '{other}'\n\n{}",
            bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "usage")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes the tests that mutate the process-wide `$BSC_SCOPES` / `$BSC_UI_ACTIVITY_LOG` env
    /// (the scope-gate test and the #2525 emit test): parallel threads share the process env, so an
    /// unguarded scope flip would make a concurrent gated mutation flakily refuse or misroute a
    /// `ui-touch`. Poisoning is ignored (one test's assert failure must not cascade).
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A fresh (created, empty) scratch store dir so the shape-verb tests never touch the user's
    /// real `~/.base-studio-code/components` store.
    fn tmp_store_dir(tag: &str) -> String {
        let d = std::env::temp_dir().join(format!("bsc-component-cli-test-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    #[test]
    fn specs_are_the_two_collections_with_the_right_lean_fields() {
        assert_eq!(COMPONENT_SPEC.noun, "component");
        assert_eq!(COMPONENT_SPEC.dir_segment, "components");
        // `shapes` rides the lean list projection (#2475) so `list`/`list --shape` expose the axis.
        assert_eq!(COMPONENT_SPEC.meta_fields, &["id", "name", "kitId", "role", "shapes"]);
        assert_eq!(KIT_SPEC.noun, "kit");
        assert_eq!(KIT_SPEC.dir_segment, "kits");
        assert_eq!(KIT_SPEC.meta_fields, &["id", "name", "stack"]);
        // The two collections live in DIFFERENT dirs (a component and a kit can share an id).
        assert_ne!(COMPONENT_SPEC.dir_segment, KIT_SPEC.dir_segment);
        assert_ne!(COMPONENT_SPEC.dir_env, KIT_SPEC.dir_env);
    }

    #[test]
    fn component_help_lists_commands_incl_the_kit_pointer() {
        let ov = bsc_cli_util::help_overview("bsc ui", TAGLINE, COMPONENT_COMMANDS);
        for c in ["list", "get", "set", "remove", "kit"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        // The kit pointer's detail explains the sub-noun.
        let kit = bsc_cli_util::help_for("bsc ui", TAGLINE, COMPONENT_COMMANDS, "kit");
        assert!(kit.contains("bsc ui kit"));
    }

    #[test]
    fn kit_help_lists_the_kit_crud() {
        let ov = bsc_cli_util::help_overview("bsc ui kit", KIT_TAGLINE, KIT_COMMANDS);
        for c in ["list", "get", "set", "remove"] {
            assert!(ov.contains(c), "kit overview lists {c}");
        }
    }

    #[test]
    fn component_help_lists_the_eslint_preset_command() {
        let ov = bsc_cli_util::help_overview("bsc ui", TAGLINE, COMPONENT_COMMANDS);
        assert!(ov.contains("eslint-preset"));
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMPONENT_COMMANDS, "eslint-preset");
        assert!(d.contains("--kit") && d.contains("eslint config"));
    }

    #[test]
    fn command_docs_expose_the_component_surface_for_the_ui_mount() {
        // `bsc ui` composes this catalog (#2469): every store verb is present, and the usage text
        // teaches the CANONICAL `bsc ui …` form (the `bsc component` alias is deprecated).
        let names: Vec<&str> = command_docs().iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["list", "shapes", "get", "set", "remove", "kit", "eslint-preset", "usage", "doctor"]);
        for c in command_docs() {
            assert!(!c.usage.contains("bsc component"), "{}'s usage teaches `bsc ui`, not the alias", c.name);
        }
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

    #[test]
    fn is_scoped_mutation_classifies_exactly_the_mutating_verbs() {
        let a = |args: &[&str]| args.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // The four mutating shapes (#2470) — gated on both collections.
        assert!(is_scoped_mutation(&a(&["set"])));
        assert!(is_scoped_mutation(&a(&["remove", "button"])));
        assert!(is_scoped_mutation(&a(&["kit", "set"])));
        assert!(is_scoped_mutation(&a(&["kit", "remove", "react-ui"])));
        // Read verbs never gate — incl. the #2475 shape picker (`shapes` + `list --shape`).
        for read in [
            &["list"][..], &["get", "button"], &["kit", "list"], &["kit", "get", "react-ui"],
            &["eslint-preset"], &["usage", "list"], &["shapes"], &["shapes", "graph"],
            &["list", "--shape", "table"], &["help"], &[],
        ] {
            assert!(!is_scoped_mutation(&a(read)), "read shape gated: {read:?}");
        }
        // The trailing `help` form is documentation, not a mutation — reachable read-scoped.
        assert!(!is_scoped_mutation(&a(&["set", "help"])));
        assert!(!is_scoped_mutation(&a(&["kit", "remove", "help"])));
    }

    // ONE test owns the real $BSC_SCOPES env var (parallel test threads share the process env).
    #[test]
    fn mutating_verbs_refuse_under_a_read_ui_scope_before_touching_the_store() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var(bsc_cli_util::BSC_SCOPES_ENV, r#"{"ui":"read"}"#);
        // `remove` errs at the scope gate — BEFORE any store dir is resolved or touched (no --dir
        // is passed here on purpose: reaching the store would touch the real default location).
        let err = run(vec!["remove".into(), "x".into()], "bsc component").unwrap_err();
        assert!(err.contains("'ui'"), "refusal names the scope: {err}");
        assert!(err.contains("BSC_SCOPES"), "refusal names the env doc: {err}");
        let err = run(vec!["kit".into(), "set".into()], "bsc component").unwrap_err();
        assert!(err.contains("read-only"), "kit set refuses too: {err}");
        // Help stays reachable under the read scope (prints, returns Ok).
        assert!(run(vec!["set".into(), "help".into()], "bsc component").is_ok());
        // The #2475 shape picker is READ tier — both verbs work under the read-scoped session
        // (the planner's `ui: read`), against a scratch --dir.
        let dir = tmp_store_dir("read-scope");
        assert!(run(vec!["shapes".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(run(vec!["shapes".into(), "graph".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(
            run(vec!["list".into(), "--shape".into(), "table".into(), "--dir".into(), dir], "bsc ui").is_ok()
        );
        std::env::remove_var(bsc_cli_util::BSC_SCOPES_ENV);
    }

    #[test]
    fn component_help_lists_the_usage_command() {
        let ov = bsc_cli_util::help_overview("bsc ui", TAGLINE, COMPONENT_COMMANDS);
        assert!(ov.contains("usage"));
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMPONENT_COMMANDS, "usage");
        assert!(d.contains("bsc ui usage add") && d.contains("consumer index"));
    }

    // ── the data-shape picker (#2475) ──────────────────────────────────────────────────────────

    #[test]
    fn data_shapes_vocabulary_is_exactly_the_six_canonical_shapes() {
        let names: Vec<&str> = DATA_SHAPES.iter().map(|(s, _)| *s).collect();
        assert_eq!(names, vec!["list", "linked-list", "tree", "graph", "table", "key-value"]);
        for (s, d) in DATA_SHAPES {
            assert!(!d.is_empty(), "{s} carries a description");
            assert!(require_shape(s).is_ok());
        }
        // An off-vocabulary token errors, teaching the whole set.
        let err = require_shape("blob").unwrap_err();
        assert!(err.contains("unknown shape 'blob'"));
        for s in ["list", "linked-list", "tree", "graph", "table", "key-value"] {
            assert!(err.contains(s), "the error teaches {s}");
        }
    }

    #[test]
    fn json_has_shape_matches_only_a_stamped_shapes_array() {
        assert!(json_has_shape(r#"{"id":"md","shapes":["list"]}"#, "list"));
        assert!(json_has_shape(r#"{"id":"gc","shapes":["graph","list"]}"#, "graph"));
        // Missing / empty / odd-typed `shapes` (and garbage records) simply don't match.
        assert!(!json_has_shape(r#"{"id":"button"}"#, "list"));
        assert!(!json_has_shape(r#"{"id":"x","shapes":[]}"#, "list"));
        assert!(!json_has_shape(r#"{"id":"x","shapes":"list"}"#, "list"));
        assert!(!json_has_shape("not json", "list"));
    }

    #[test]
    fn shape_index_computes_each_shapes_ideals_from_the_stored_fields() {
        let raw = vec![
            r#"{"id":"masterdetail","name":"MasterDetail","kitId":"react-ui","role":"layout","shapes":["list"]}"#.to_string(),
            r#"{"id":"graphcanvas","name":"GraphCanvas","kitId":"react-ui","role":"layout","shapes":["graph"]}"#.to_string(),
            r#"{"id":"button","name":"Button","kitId":"react-ui","role":"primitive"}"#.to_string(),
        ];
        let idx = shape_index(&raw, None);
        let entries = idx.as_array().unwrap();
        assert_eq!(entries.len(), DATA_SHAPES.len(), "one entry per vocabulary shape");
        let entry = |s: &str| entries.iter().find(|e| e["shape"] == s).unwrap().clone();
        // Stamped shapes list their ideal components as the SAME lean rows as `list` (incl. `shapes`).
        let list = entry("list");
        assert_eq!(list["components"][0]["name"], "MasterDetail");
        assert_eq!(list["components"][0]["shapes"], serde_json::json!(["list"]));
        assert_eq!(entry("graph")["components"][0]["name"], "GraphCanvas");
        // An uncovered shape is an honest EMPTY entry (a kit gap), never fabricated coverage.
        assert_eq!(entry("tree")["components"], serde_json::json!([]));
        assert_eq!(entry("linked-list")["components"], serde_json::json!([]));
        // Every entry carries its description (the vocabulary the planner derives against).
        for e in entries {
            assert!(e["desc"].as_str().is_some_and(|d| !d.is_empty()));
        }
        // A single-shape query narrows to that one entry.
        let one = shape_index(&raw, Some("graph"));
        assert_eq!(one.as_array().unwrap().len(), 1);
        assert_eq!(one[0]["shape"], "graph");
    }

    #[test]
    fn shapes_and_list_shape_run_against_a_store_and_reject_off_vocabulary_shapes() {
        let dir = tmp_store_dir("shapes");
        let store = bsc_json_store::Store::new(dir.clone(), "component");
        store
            .set("masterdetail", r#"{"id":"masterdetail","name":"MasterDetail","kitId":"react-ui","role":"layout","shapes":["list"]}"#)
            .unwrap();
        // Both read verbs run Ok end-to-end (lean + --full + single-shape).
        assert!(run(vec!["shapes".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(run(vec!["shapes".into(), "list".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(run(vec!["list".into(), "--shape".into(), "list".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(run(
            vec!["list".into(), "--shape".into(), "list".into(), "--full".into(), "--dir".into(), dir.clone()],
            "bsc ui"
        )
        .is_ok());
        // An off-vocabulary shape errors BEFORE any store is touched (no --dir needed), teaching the set.
        let err = run(vec!["shapes".into(), "blob".into()], "bsc ui").unwrap_err();
        assert!(err.contains("unknown shape 'blob'") && err.contains("key-value"));
        let err = run(vec!["list".into(), "--shape".into(), "blob".into()], "bsc ui").unwrap_err();
        assert!(err.contains("unknown shape 'blob'"));
        // A bare `--shape` with no value is a usage error pointing at the vocabulary verb.
        let err = run(vec!["list".into(), "--shape".into()], "bsc ui").unwrap_err();
        assert!(err.contains("bsc ui shapes"));
    }

    #[test]
    fn component_help_lists_the_shapes_verb_and_the_shape_filter() {
        let ov = bsc_cli_util::help_overview("bsc ui", TAGLINE, COMPONENT_COMMANDS);
        assert!(ov.contains("shapes"));
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMPONENT_COMMANDS, "shapes");
        assert!(d.contains("key-value") && d.contains("ideal"), "shapes detail teaches the vocabulary");
        let list = bsc_cli_util::help_for("bsc ui", TAGLINE, COMPONENT_COMMANDS, "list");
        assert!(list.contains("--shape"), "list detail documents the --shape filter");
        // `shapes help` resolves to the doc (a read, reachable from any scope).
        assert!(run(vec!["shapes".into(), "help".into()], "bsc ui").is_ok());
    }

    // ── UI-activity live-focus emit (#2525) ──────────────────────────────────────────────────────

    #[test]
    fn component_and_kit_remove_emit_a_ui_touch_with_their_collection() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // Unrestricted scope (a designer session or a hand shell): the mutation runs, and the emit
        // fires because $BSC_UI_ACTIVITY_LOG is wired.
        std::env::remove_var(bsc_cli_util::BSC_SCOPES_ENV);
        let act = std::env::temp_dir().join(format!("bsc-component-uiact-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&act);
        std::env::set_var("BSC_UI_ACTIVITY_LOG", &act);
        std::env::set_var("BSC_AUDIT_PANE", "design-studio:designer");

        // Seed a component + a kit into a scratch store, then remove each through the CLI.
        let dir = tmp_store_dir("emit-comp");
        bsc_json_store::Store::new(dir.clone(), "component").set("button", r#"{"id":"button"}"#).unwrap();
        let kdir = tmp_store_dir("emit-kit");
        bsc_json_store::Store::new(kdir.clone(), "kit").set("react-ui", r#"{"id":"react-ui"}"#).unwrap();

        run(vec!["remove".into(), "button".into(), "--dir".into(), dir], "bsc ui").unwrap();
        run(vec!["kit".into(), "remove".into(), "react-ui".into(), "--dir".into(), kdir], "bsc ui").unwrap();

        let text = std::fs::read_to_string(&act).unwrap();
        assert!(
            text.contains("\tui-touch\tcomponent\tbutton"),
            "component remove emits a component touch: {text:?}",
        );
        assert!(
            text.contains("\tui-touch\tkit\treact-ui"),
            "kit remove emits a kit touch: {text:?}",
        );

        std::env::remove_var("BSC_UI_ACTIVITY_LOG");
        std::env::remove_var("BSC_AUDIT_PANE");
        let _ = std::fs::remove_file(&act);
    }
}
