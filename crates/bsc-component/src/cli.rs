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
use std::io::Read;

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
        summary: "every component's {id, name, kitId, role, group, shapes} (JSON)",
        usage: "\
USAGE:
  bsc ui list [--shape <shape>] [--full] [--pretty]

Prints every component's { id, name, kitId, role, group, shapes } as JSON (compact; --pretty for indented).
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
field stamps that shape (the kit's IDEAL renderings for it, as lean {id, name, kitId, role, group, shapes}
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
written — how an agent (or the pane) authors/updates a component in the shared kit. An optional `group`
field names the component's PURPOSE partition within the kit (`data-viz`/`pages`/`forms`) — orthogonal
to `role` (the arch tier), organizational only (`composes` still resolves across the whole kit).",
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
  bsc ui kit list [--full] [--pretty]   # every kit's { id, name, tech, style, stack }
  bsc ui kit get <id> [--pretty]
  bsc ui kit set [--pretty]             # kit JSON on stdin (upsert by id)
  bsc ui kit remove <id> [--pretty]

A kit is a technology-scoped namespace of components: { id, name, tech, style, stack?, dot }. `tech`
(technology slug: react/vue/kotlin…) and `style` (visual language: studio/material…) are the RAIL AXES
that place the kit in the Design Studio — set BOTH, or the kit buckets under \"other/other\". `stack` is
a display label only (e.g. \"React · TypeScript\"). `bsc ui kit …` is list/get/set/remove over the kit
collection.",
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
        summary: "graph-health report — orphans, dead branches, duplicates, cycles, unbuildable + self-referential components (#2678)",
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
    CmdDoc {
        name: "define-animation",
        summary: "author a component's motion as data — animation JSON on stdin, upsert by name (#2869)",
        usage: "\
USAGE:
  bsc ui define-animation <component-id> [--pretty]   # animation JSON on stdin

Reads ONE animation object from stdin — { name, keyframes, duration?, easing?, delay?, trigger?,
selector?, set?, stagger? } — VALIDATES it against the motion safety grammar, then UPSERTS it into the
component's `animations` array by `name` (replacing a same-named one, else appending). `keyframes` maps
a stop (`from` / `to` / a percentage like `50%`) to CSS declarations (property → value); `duration`/
`easing` are optional and typically reference the motion tokens (`var(--dur-base)` / `var(--ease-standard)`);
`delay` is an optional animation-level time slotted after easing; `trigger` is one of
mount | hover | always | exit (default mount; `exit` is accepted but DORMANT until the preview exit-runtime, #3057); `selector` scopes the applying rule to a CHILD element (a
descendant combinator); `set` is a map of STATIC declarations applied on the rule (e.g. transform-origin
that can't live in keyframes); `stagger` is a per-matched-element delay STEP (a time, e.g. `14ms`) that
cascades the delay across the elements `selector` matches — it REQUIRES a `selector`. The animation plays
LIVE on the real component — compiled to a `@keyframes` block + an applying rule, guarded by
`prefers-reduced-motion`. A ui-scope MUTATION (#2470); errors when the component id is absent. Prints the
stored animation (--pretty indents).

VALIDATION (the closed grammar): `name` must match [a-z][a-z0-9-]* · every keyframe stop must be
`from`/`to`/`\\d{1,3}%` · every declaration property (incl. `set` keys) must match [a-z-]+ · no value
(incl. duration/easing/delay/stagger/`set` values) may carry `;` `{` `}` `<` `>` `\\` `url(` `expression(`
`@import` `/*` · `selector` may use only selector-safe characters (letters, digits, space . _ # > [ ] =
\" ' - : ( ) , * + ~) · `stagger` requires a `selector` · keyframes must be a non-empty object with at
least one valid stop + declaration.",
    },
    CmdDoc {
        name: "list-animations",
        summary: "print a component's authored animations array (#2869)",
        usage: "\
USAGE:
  bsc ui list-animations <component-id> [--pretty]

Prints the component's `animations` array as JSON (an empty array when it has none). Read-only; errors
when the component id is absent. --pretty indents.",
    },
    CmdDoc {
        name: "remove-animation",
        summary: "drop a named animation from a component (#2869)",
        usage: "\
USAGE:
  bsc ui remove-animation <component-id> <name> [--pretty]

Removes the animation named <name> from the component's `animations` array and writes the record back.
A ui-scope MUTATION (#2470); errors when the component (or an animation with that name) is absent.",
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
        usage: "USAGE:\n  bsc ui kit set [--pretty]   # kit JSON (object or array) on stdin\n\nUpserts each kit by its \"id\", written verbatim. Fields: { id, name, tech, style, stack?, dot } — tech + style place the kit in the rail (omit either ⇒ it shows as \"other/other\"); stack is a display label only.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a kit (no-op if absent)",
        usage: "USAGE:\n  bsc ui kit remove <id> [--pretty]\n\nDeletes the kit keyed by <id>; a no-op when absent.",
    },
    CmdDoc {
        name: "define-animation",
        summary: "author a KIT's motion as data — animation JSON on stdin, upsert by name (#2942)",
        usage: "\
USAGE:
  bsc ui kit define-animation <kit-id> [--pretty]   # animation JSON on stdin

Reads ONE animation object from stdin — { name, keyframes, duration?, easing?, delay?, trigger?,
selector?, set?, stagger? } — VALIDATES it against the motion safety grammar, then UPSERTS it into the
KIT's `animations` library by `name` (replacing a same-named one, else appending). The kit OWNS the
motion; a component PLAYS it by adding the name to its own `animations` array (via `bsc ui set`).
`keyframes` maps a stop (`from`/`to`/`N%`) to CSS declarations; `duration`/`easing` typically reference
the motion tokens (`var(--dur-base)` / `var(--ease-standard)`); `delay` is an optional animation-level
time (after easing in the shorthand); `trigger` is mount | hover | always | exit (default mount; `exit` is accepted but DORMANT until the preview exit-runtime, #3057); `selector`
scopes the applying rule to a CHILD element (a descendant combinator); `set` maps STATIC declarations
applied on the rule (e.g. transform-origin/box that can't live in keyframes); `stagger` is a
per-matched-element delay STEP (a time, e.g. `14ms`) cascaded across the elements `selector` matches — it
REQUIRES a `selector`. Compiles to `@keyframes bsc-<kit>-<name>` + a `prefers-reduced-motion`-guarded
rule on `.<kit>-anim-<name>` (scoped to the child when `selector` is given). A ui-scope MUTATION (#2470);
errors when the kit id is absent. Prints the stored animation.

VALIDATION (the closed grammar): `name` [a-z][a-z0-9-]* · stops `from`/`to`/`\\d{1,3}%` · properties
(incl. `set` keys) [a-z-]+ · no value (incl. delay/stagger/`set` values) may carry `;` `{` `}` `<` `>`
`\\` `url(` `expression(` `@import` `/*` · `selector` uses only selector-safe characters · `stagger`
requires a `selector`.",
    },
    CmdDoc {
        name: "list-animations",
        summary: "print a kit's motion library (#2942)",
        usage: "USAGE:\n  bsc ui kit list-animations <kit-id> [--pretty]\n\nPrints the kit's `animations` array as JSON (an empty array when it has none). Read-only; errors when the kit is absent.",
    },
    CmdDoc {
        name: "remove-animation",
        summary: "drop a named animation from a kit's library (#2942)",
        usage: "USAGE:\n  bsc ui kit remove-animation <kit-id> <name> [--pretty]\n\nRemoves the animation named <name> from the kit's `animations` library. A ui-scope MUTATION; errors when the kit or the named animation is absent.",
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
    meta_fields: &["id", "name", "kitId", "role", "group", "shapes"],
};

/// The kit collection's knobs. Lean `list` projects id/name/tech/style/stack.
const KIT_SPEC: CliSpec = CliSpec {
    noun: "kit",
    dir_env: "BSC_COMPONENT_KIT_DIR",
    dir_segment: "kits",
    tagline: KIT_TAGLINE,
    commands: KIT_COMMANDS,
    meta_fields: &["id", "name", "tech", "style", "stack"],
};

/// A non-blocking `kit set` advisory (#3040): the Design Studio places a kit in its rail by two axes —
/// `tech` (technology slug) + `style` (visual language) — so a kit missing either shows under the
/// trailing "other" head (e.g. "other/other"), which is almost never intended. Warn (stderr) per such
/// kit, but NEVER reject: both axes are OPTIONAL in the model (`Kit.tech?`/`style?`, back-compat with
/// pre-#2487 stores), so this only nudges. `stack` is a display label, NOT a substitute for either.
fn warn_kit_axes(items: &[serde_json::Value]) -> Result<(), String> {
    for it in items {
        let id = it.get("id").and_then(serde_json::Value::as_str).unwrap_or("<no id>");
        let present = |k: &str| it.get(k).and_then(serde_json::Value::as_str).is_some_and(|s| !s.trim().is_empty());
        let missing: Vec<&str> = ["tech", "style"].into_iter().filter(|k| !present(k)).collect();
        if !missing.is_empty() {
            eprintln!(
                "warning: kit '{id}' has no {} — the Design Studio groups kits by tech + style, so it will \
                 show under the \"other\" bucket. Add e.g. \"tech\":\"react\",\"style\":\"studio\" (stack is a \
                 display label only, not a grouping axis).",
                missing.join(" and no ")
            );
        }
    }
    Ok(())
}

/// The component-surface command catalog, exposed so `bsc ui` (#2469) can compose it verbatim into its
/// merged help tree AND gate which verbs it delegates here (unknown verbs stay `bsc ui`'s, so its
/// error shows the MERGED overview rather than this partial one).
pub fn command_docs() -> &'static [CmdDoc] {
    COMPONENT_COMMANDS
}

/// Whether `args` is one of the store's MUTATING verb invocations — `set` / `remove` on either
/// collection (`… set|remove` or `… kit set|remove`) or the component-animation writers
/// (`define-animation` / `remove-animation`, #2869) — gated by the session's runtime `ui` scope
/// (#2470). The trailing `help` form (`set help`, `kit set help`) is NOT a mutation: help must stay
/// reachable from a read-scoped session. Read verbs (`list`/`get`/`eslint-preset`/`usage`/
/// `list-animations`/`kit list|get`) never gate.
fn is_scoped_mutation(args: &[String]) -> bool {
    let (verb, next) = if args.first().map(String::as_str) == Some("kit") {
        (args.get(1), args.get(2))
    } else {
        (args.first(), args.get(1))
    };
    matches!(
        verb.map(String::as_str),
        Some("set") | Some("remove") | Some("define-animation") | Some("remove-animation")
    ) && next.map(String::as_str) != Some("help")
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
            match args.get(1).map(String::as_str) {
                // The kit-scoped animation authoring verbs (#2942): a kit owns its motion library.
                // Custom reads/writes over the KIT store; the two writers are already ui-scope gated by
                // `is_scoped_mutation` above (the `kit` prefix → args[1] check), BEFORE any store touch.
                Some("define-animation") if args.get(2).map(String::as_str) != Some("help") => {
                    cmd_kit_define_animation(&args[2..])
                }
                Some("list-animations") if args.get(2).map(String::as_str) != Some("help") => {
                    cmd_kit_list_animations(&args[2..])
                }
                Some("remove-animation") if args.get(2).map(String::as_str) != Some("help") => {
                    cmd_kit_remove_animation(&args[2..])
                }
                Some(v @ ("define-animation" | "list-animations" | "remove-animation")) => {
                    print!("{}", bsc_cli_util::help_for(&kit_prog, TAGLINE, KIT_COMMANDS, v));
                    Ok(())
                }
                // Emit a `ui-touch` for the Design Studio's live-focus (#2525) after each kit set/remove
                // write lands — WITH the "kit" collection context (bsc-json-store has none). A no-op for
                // read verbs (the hook only fires inside set/remove) and for non-designer sessions.
                _ => bsc_json_store::cli::run_hooked_validated(
                    args.into_iter().skip(1).collect(),
                    &kit_prog,
                    &KIT_SPEC,
                    Some(&|id: &str| bsc_util::emit_ui_activity("kit", id)),
                    // Non-blocking nudge (#3040): a kit with no tech/style buckets to "other/other".
                    Some(&warn_kit_axes),
                ),
            }
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
        // The component-animation authoring verbs (#2869): motion as DATA on a component record. Custom
        // reads/writes over the component store (validate → upsert into `animations`), so they're
        // handled here rather than via the shared verbatim-JSON store CLI. The two writers are already
        // ui-scope gated by `is_scoped_mutation` above, BEFORE any store is touched.
        Some("define-animation") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "define-animation"));
                Ok(())
            } else {
                cmd_define_animation(&args[1..])
            }
        }
        Some("list-animations") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "list-animations"));
                Ok(())
            } else {
                cmd_list_animations(&args[1..])
            }
        }
        Some("remove-animation") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "remove-animation"));
                Ok(())
            } else {
                cmd_remove_animation(&args[1..])
            }
        }
        // `list --shape <shape>` (#2475) filters to one shape's ideal components — intercepted here
        // (the shared store CLI rejects unknown flags); a plain `list` still delegates unchanged.
        Some("list") if args.iter().any(|a| a == "--shape") => cmd_list_shape(&args[1..]),
        // The COMPONENT collection's list/get/set/remove. Fire the live-focus `ui-touch` (#2525) after
        // a component set/remove write lands, with the "component" collection context. A `set` batch is
        // gated first by `validate_component_batch` (#2928) — a module `srcText` that won't build (an
        // unterminated string) is rejected before anything is written.
        _ => bsc_json_store::cli::run_hooked_validated(
            args,
            prog,
            &COMPONENT_SPEC,
            Some(&|id: &str| bsc_util::emit_ui_activity("component", id)),
            Some(&validate_component_batch),
        ),
    }
}

/// Write-time gate for a `bsc ui set` batch (#2928): for each record whose `srcText` claims to be a
/// module (`looks_buildable_module`, the SAME test the preview uses), run the module-syntax check and
/// reject the whole batch on the first defect — so a silently-corrupted source (an unterminated string
/// from an escape-collapse) can't be stored. A usage-snippet `srcText` is not a module and is left
/// alone; a record with no `srcText` is fine. ALSO (non-blocking, #3065): warns on stderr for a bad
/// INLINE animation def on the record's `animations`, but never rejects over one. The srcText Err
/// semantics are unchanged; the animation check is a pure side-effect. Driven directly by tests.
fn validate_component_batch(items: &[serde_json::Value]) -> Result<(), String> {
    for item in items {
        // #3065: non-blocking — runs for EVERY item, BEFORE the srcText early-continue below, so an
        // inline-animation warning surfaces even on a component whose `srcText` isn't a buildable module.
        warn_component_animations(item);

        let src_text = item.get("srcText").and_then(serde_json::Value::as_str).unwrap_or_default();
        if !crate::graph_health::looks_buildable_module(src_text) {
            continue;
        }
        if let Err(msg) = crate::syntax::check_module_syntax(src_text) {
            let name = item
                .get("name")
                .and_then(serde_json::Value::as_str)
                .or_else(|| item.get("id").and_then(serde_json::Value::as_str))
                .unwrap_or("component");
            return Err(format!(
                "{name}: {msg} — its srcText looks like a module but won't build. Fix it, or author it from a raw file to avoid shell-escaping corruption."
            ));
        }
    }
    Ok(())
}

/// Non-blocking write-time advisory (#3065) for a component's INLINE animation defs. A component's
/// `animations` entries may each be a kit-animation NAME (a string — always fine, a ref into the kit's
/// library) OR an INLINE def object (a full `KitAnimation` used directly for component-specific one-off
/// motion, validated exactly like `bsc ui kit define-animation`). An inline def that fails the motion
/// grammar — or an entry that is neither a string nor an object — is WARNED about on stderr (naming the
/// component id), but NEVER rejected: the render compiler guards every field at render, and dropping a
/// whole component over one bad anim is too heavy. Purely advisory — it never changes the batch result.
fn warn_component_animations(item: &serde_json::Value) {
    let Some(anims) = item.get("animations").and_then(serde_json::Value::as_array) else {
        return;
    };
    let id = item
        .get("id")
        .and_then(serde_json::Value::as_str)
        .or_else(|| item.get("name").and_then(serde_json::Value::as_str))
        .unwrap_or("component");
    for entry in anims {
        if entry.is_string() {
            continue; // a NAME ref into the kit's animations library — always fine.
        }
        if entry.is_object() {
            if let Err(msg) = validate_animation(entry) {
                eprintln!(
                    "warning: component '{id}' has an invalid inline animation: {msg} — it will be dropped at render (fix it, or reference a kit animation by name)."
                );
            }
        } else {
            eprintln!(
                "warning: component '{id}' has an `animations` entry that is neither a name (string) nor an inline def (object) — it will be ignored."
            );
        }
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

/// Resolve the KIT store with the same flag → env (`BSC_KIT_DIR`) → default (`~/.base-studio-code/kits/`)
/// precedence — for the kit-scoped animation authoring (#2942; a kit owns its motion library).
fn open_kit_store(dir: &Option<String>) -> Result<bsc_json_store::Store, String> {
    let dir = bsc_cli_util::resolve_store_path(dir, KIT_SPEC.dir_env, || {
        bsc_util::bsc_base_dir()
            .map(|b| b.join(KIT_SPEC.dir_segment))
            .ok_or_else(|| "could not resolve a home directory; set HOME/USERPROFILE".to_string())
    })?;
    Ok(bsc_json_store::Store::new(dir, "kit"))
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
        println!("✓ design graph is healthy{scope} — no orphans, dead branches, duplicates, cycles, unbuildable, or self-referential components.");
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

// ── component animations (#2869, epic #2865) ──────────────────────────────────────────────────────
//
// The AUTHORING surface for the motion an LLM defines as DATA on a `ComponentRecord.animations` (the
// render engine is `src/shared/ui/kit/animations.ts`). Because this compiles LLM-authored data into
// live CSS, the validator is a CLOSED SAFETY GRAMMAR that MUST mirror animations.ts exactly:
//   SAFE_IDENT  /^[a-z][a-z0-9-]*$/   — the animation name
//   SAFE_STOP   /^(from|to|\d{1,3}%)$/ — every keyframe stop selector
//   SAFE_PROP   /^[a-z-]+$/           — every declaration property
//   UNSAFE_VALUE /[;{}<>\\]|url\(|expression\(|@import|\/\*/i — refused in any value (case-insensitive)
// The render engine SKIPS anything failing these (defense in depth); the authoring path REJECTS it
// with a clear message so a designer fixes it at write time instead of shipping silently-dropped motion.

/// A safe CSS identifier — `^[a-z][a-z0-9-]*$` (mirrors animations.ts `SAFE_IDENT`).
fn is_safe_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A keyframe stop selector — `from`, `to`, or a 1–3 digit percentage (mirrors `SAFE_STOP`).
fn is_safe_stop(s: &str) -> bool {
    if s == "from" || s == "to" {
        return true;
    }
    match s.strip_suffix('%') {
        Some(num) => (1..=3).contains(&num.len()) && num.chars().all(|c| c.is_ascii_digit()),
        None => false,
    }
}

/// A CSS declaration property — `^[a-z-]+$`, non-empty (mirrors `SAFE_PROP`).
fn is_safe_prop(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c == '-')
}

/// A safe CHILD selector for the applying rule (#3054) — ONLY selector-safe characters, so it cannot
/// break out of the selector position into a declaration / new rule / comment (no `{ } ; < \ /`).
/// Mirrors animations.ts `SAFE_SELECTOR` (classes, tags, `#`ids, `>`/space/`+`/`~` combinators,
/// `[attr="v"]`, `:nth-child(2n)`, `,` lists, `*`).
fn is_safe_selector(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    ' ' | '.' | '_' | '#' | '>' | '[' | ']' | '=' | '"' | '\'' | '-' | ':' | '(' | ')'
                        | ',' | '*' | '+' | '~'
                )
        })
}

/// A declaration/duration/easing VALUE that cannot end the declaration or inject CSS — non-empty and
/// free of any `UNSAFE_VALUE` sequence (case-insensitive), mirroring animations.ts `safeValue`.
fn is_safe_value(v: &str) -> bool {
    if v.is_empty() {
        return false;
    }
    if v.chars().any(|c| matches!(c, ';' | '{' | '}' | '<' | '>' | '\\')) {
        return false;
    }
    let lower = v.to_ascii_lowercase();
    !(lower.contains("url(")
        || lower.contains("expression(")
        || lower.contains("@import")
        || lower.contains("/*"))
}

/// Validate one authored animation object against the closed motion grammar (the port of
/// animations.ts's guards, but REJECTING rather than skipping). Returns a clear, specific error naming
/// the first problem. Pure → unit-tested directly.
fn validate_animation(anim: &serde_json::Value) -> Result<(), String> {
    use serde_json::Value;
    let obj = anim.as_object().ok_or("animation must be a JSON object")?;

    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .ok_or("animation `name` is required (a string)")?;
    if !is_safe_ident(name) {
        return Err(format!(
            "animation name '{name}' must be a safe CSS identifier [a-z][a-z0-9-]*"
        ));
    }

    let keyframes = obj
        .get("keyframes")
        .and_then(Value::as_object)
        .ok_or("animation `keyframes` is required (an object of stop → declarations)")?;
    if keyframes.is_empty() {
        return Err("animation `keyframes` must have at least one stop".into());
    }
    let mut valid_stops = 0usize;
    for (stop, decls) in keyframes {
        if !is_safe_stop(stop) {
            return Err(format!(
                "keyframe stop '{stop}' must be `from`, `to`, or a 1–3 digit percentage (e.g. `50%`)"
            ));
        }
        let decls = decls
            .as_object()
            .ok_or_else(|| format!("keyframe '{stop}' must map properties to values (an object)"))?;
        let mut valid_decls = 0usize;
        for (prop, value) in decls {
            if !is_safe_prop(prop) {
                return Err(format!("declaration property '{prop}' must match [a-z-]+"));
            }
            let v = value
                .as_str()
                .ok_or_else(|| format!("declaration '{prop}' value must be a string"))?;
            if !is_safe_value(v) {
                return Err(format!(
                    "declaration '{prop}: {v}' carries an unsafe value (no ; {{ }} < > \\ url( expression( @import /*)"
                ));
            }
            valid_decls += 1;
        }
        if valid_decls > 0 {
            valid_stops += 1;
        }
    }
    if valid_stops == 0 {
        return Err("animation `keyframes` must have at least one stop with a declaration".into());
    }

    // Optional duration/easing/delay/stagger: motion-token refs or literals, checked against the value
    // grammar. `delay` (#3056) is an animation-level time slotted after easing in the shorthand;
    // `stagger` (#3055) is a per-matched-element delay STEP (needs a `selector`, guarded below).
    for key in ["duration", "easing", "delay", "stagger"] {
        if let Some(v) = obj.get(key) {
            let s = v.as_str().ok_or_else(|| format!("animation `{key}` must be a string"))?;
            if !is_safe_value(s) {
                return Err(format!("animation `{key}` value '{s}' carries an unsafe value"));
            }
        }
    }

    // Optional trigger: one of the closed set.
    if let Some(t) = obj.get("trigger") {
        let s = t.as_str().ok_or("animation `trigger` must be a string")?;
        if !matches!(s, "mount" | "hover" | "always" | "exit") {
            return Err(format!(
                "animation `trigger` '{s}' must be one of mount | hover | always | exit"
            ));
        }
    }

    // Optional selector (#3054): scope the applying rule to a CHILD element — a closed selector grammar.
    if let Some(v) = obj.get("selector") {
        let s = v.as_str().ok_or("animation `selector` must be a string")?;
        if !is_safe_selector(s) {
            return Err(format!(
                "animation `selector` '{s}' must use only selector-safe characters (letters, digits, space . _ # > [ ] = \" ' - : ( ) , * + ~)"
            ));
        }
    }

    // Semantic guard (#3055): a `stagger` STEP cascades the delay across the elements a `selector`
    // matches, so it's meaningless on the root — reject a `stagger` with no `selector` at write time.
    if obj.contains_key("stagger") && !obj.contains_key("selector") {
        return Err(
            "animation `stagger` requires a `selector` — it steps the delay across the matched child elements".into(),
        );
    }

    // Optional set (#3054): STATIC declarations applied on the rule (transform-origin/box, etc.), each
    // checked against the same property + value grammar as a keyframe declaration.
    if let Some(v) = obj.get("set") {
        let set = v
            .as_object()
            .ok_or("animation `set` must map properties to values (an object)")?;
        for (prop, value) in set {
            if !is_safe_prop(prop) {
                return Err(format!("`set` property '{prop}' must match [a-z-]+"));
            }
            let s = value
                .as_str()
                .ok_or_else(|| format!("`set` value for '{prop}' must be a string"))?;
            if !is_safe_value(s) {
                return Err(format!("`set` declaration '{prop}: {s}' carries an unsafe value"));
            }
        }
    }

    Ok(())
}

/// Validate + upsert `anim` into component `id`'s `animations` array by `name` (replace same-named,
/// else append), writing the record back. Errors when the component is absent or its record is not a
/// JSON object. Pure of stdin/print so tests drive it directly.
fn upsert_animation(
    store: &bsc_json_store::Store,
    id: &str,
    anim: &serde_json::Value,
) -> Result<(), String> {
    validate_animation(anim)?;
    let name = anim.get("name").and_then(|v| v.as_str()).unwrap_or_default();
    let mut record = load_component_object(store, id)?;
    let obj = record.as_object_mut().expect("load_component_object guarantees an object");
    let arr = obj
        .entry("animations")
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    let list = arr
        .as_array_mut()
        .ok_or_else(|| format!("record '{id}' `animations` is not an array"))?;
    match list
        .iter_mut()
        .find(|a| a.get("name").and_then(|n| n.as_str()) == Some(name))
    {
        Some(slot) => *slot = anim.clone(),
        None => list.push(anim.clone()),
    }
    store.set(id, &serde_json::to_string(&record).map_err(|e| e.to_string())?)
}

/// Remove the animation named `name` from component `id`, writing the record back. Errors when the
/// component is absent OR it has no animation with that name (so a typo surfaces, not a silent no-op).
fn remove_named_animation(store: &bsc_json_store::Store, id: &str, name: &str) -> Result<(), String> {
    let mut record = load_component_object(store, id)?;
    let obj = record.as_object_mut().expect("load_component_object guarantees an object");
    let removed = match obj.get_mut("animations").and_then(|a| a.as_array_mut()) {
        Some(list) => {
            let before = list.len();
            list.retain(|a| a.get("name").and_then(|n| n.as_str()) != Some(name));
            before != list.len()
        }
        None => false,
    };
    if !removed {
        return Err(format!("component '{id}' has no animation named '{name}'"));
    }
    store.set(id, &serde_json::to_string(&record).map_err(|e| e.to_string())?)
}

/// The component's `animations` array (an empty array when the field is absent). Errors when the
/// component id has no stored record.
fn animations_of(store: &bsc_json_store::Store, id: &str) -> Result<serde_json::Value, String> {
    let record = load_component_object(store, id)?;
    Ok(record
        .get("animations")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(Vec::new())))
}

/// Load component `id`'s stored record as a JSON object, or a clear error when it's absent / malformed.
fn load_component_object(store: &bsc_json_store::Store, id: &str) -> Result<serde_json::Value, String> {
    let raw = store
        .get(id)?
        .ok_or_else(|| format!("no record '{id}' in the store — author it first with `bsc ui set` (or `bsc ui kit set`)"))?;
    let record: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("stored record '{id}' is not valid JSON: {e}"))?;
    if !record.is_object() {
        return Err(format!("stored record '{id}' is not a JSON object"));
    }
    Ok(record)
}

/// Parse the shared `--dir`/`--pretty` flags + the trailing positionals from an animation-verb's args.
/// Unknown flags error specifically; each caller pulls the `<component-id>` (+ `<name>`) it needs and
/// emits its own usage line when a positional is missing.
fn parse_anim_args(args: &[String]) -> Result<(Vec<String>, Option<String>, bool), String> {
    let (mut dir, mut pretty) = (None::<String>, false);
    let mut positionals: Vec<String> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--pretty" => pretty = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            positional => positionals.push(positional.to_string()),
        }
    }
    Ok((positionals, dir, pretty))
}

/// `define-animation <component-id> [--pretty]` (#2869) — read + validate an animation from stdin and
/// upsert it onto the component; print the stored animation. A ui-scope mutation (gated in `run`).
fn cmd_define_animation(args: &[String]) -> Result<(), String> {
    let (pos, dir, pretty) = parse_anim_args(args)?;
    let id = pos
        .first()
        .ok_or("usage: bsc ui define-animation <component-id>   # animation JSON on stdin")?;
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).map_err(|e| format!("cannot read stdin: {e}"))?;
    let anim: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("animation is not valid JSON: {e}"))?;
    let store = open_component_store(&dir)?;
    upsert_animation(&store, id, &anim)?;
    bsc_util::emit_ui_activity("component", id);
    let out = if pretty { serde_json::to_string_pretty(&anim) } else { serde_json::to_string(&anim) };
    println!("{}", out.map_err(|e| e.to_string())?);
    Ok(())
}

/// `list-animations <component-id> [--pretty]` (#2869) — print the component's animations array. Read-only.
fn cmd_list_animations(args: &[String]) -> Result<(), String> {
    let (pos, dir, pretty) = parse_anim_args(args)?;
    let id = pos.first().ok_or("usage: bsc ui list-animations <component-id>")?;
    let store = open_component_store(&dir)?;
    let anims = animations_of(&store, id)?;
    let out = if pretty { serde_json::to_string_pretty(&anims) } else { serde_json::to_string(&anims) };
    println!("{}", out.map_err(|e| e.to_string())?);
    Ok(())
}

/// `remove-animation <component-id> <name> [--pretty]` (#2869) — drop a named animation. A ui-scope
/// mutation (gated in `run`); errors when the component or the named animation is absent.
fn cmd_remove_animation(args: &[String]) -> Result<(), String> {
    const USAGE: &str = "usage: bsc ui remove-animation <component-id> <name>";
    let (pos, dir, _pretty) = parse_anim_args(args)?;
    let id = pos.first().ok_or(USAGE)?;
    let name = pos.get(1).ok_or(USAGE)?;
    let store = open_component_store(&dir)?;
    remove_named_animation(&store, id, name)?;
    bsc_util::emit_ui_activity("component", id);
    println!("removed animation '{name}' from '{id}'");
    Ok(())
}

/// `kit define-animation <kit-id>` (#2942) — read + validate an animation from stdin and upsert it into
/// the KIT's motion library by name (the kit owns the def; components reference it by name). Prints the
/// stored animation. A ui-scope mutation (gated in `run`).
fn cmd_kit_define_animation(args: &[String]) -> Result<(), String> {
    let (pos, dir, pretty) = parse_anim_args(args)?;
    let id = pos
        .first()
        .ok_or("usage: bsc ui kit define-animation <kit-id>   # animation JSON on stdin")?;
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).map_err(|e| format!("cannot read stdin: {e}"))?;
    let anim: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("animation is not valid JSON: {e}"))?;
    let store = open_kit_store(&dir)?;
    upsert_animation(&store, id, &anim)?;
    bsc_util::emit_ui_activity("kit", id);
    let out = if pretty { serde_json::to_string_pretty(&anim) } else { serde_json::to_string(&anim) };
    println!("{}", out.map_err(|e| e.to_string())?);
    Ok(())
}

/// `kit list-animations <kit-id> [--pretty]` (#2942) — print the kit's motion library. Read-only.
fn cmd_kit_list_animations(args: &[String]) -> Result<(), String> {
    let (pos, dir, pretty) = parse_anim_args(args)?;
    let id = pos.first().ok_or("usage: bsc ui kit list-animations <kit-id>")?;
    let store = open_kit_store(&dir)?;
    let anims = animations_of(&store, id)?;
    let out = if pretty { serde_json::to_string_pretty(&anims) } else { serde_json::to_string(&anims) };
    println!("{}", out.map_err(|e| e.to_string())?);
    Ok(())
}

/// `kit remove-animation <kit-id> <name>` (#2942) — drop a named animation from the kit's library. A
/// ui-scope mutation (gated in `run`); errors when the kit or the named animation is absent.
fn cmd_kit_remove_animation(args: &[String]) -> Result<(), String> {
    const USAGE: &str = "usage: bsc ui kit remove-animation <kit-id> <name>";
    let (pos, dir, _pretty) = parse_anim_args(args)?;
    let id = pos.first().ok_or(USAGE)?;
    let name = pos.get(1).ok_or(USAGE)?;
    let store = open_kit_store(&dir)?;
    remove_named_animation(&store, id, name)?;
    bsc_util::emit_ui_activity("kit", id);
    println!("removed animation '{name}' from kit '{id}'");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_component_batch_rejects_a_corrupt_module_srctext_but_passes_valid_ones() {
        // A module srcText corrupted by an escape-collapse (a `\n` turned into a real newline inside a
        // `.join("…")` string) → rejected, naming the component.
        let corrupt = serde_json::json!({
            "id": "bar", "name": "BarChart",
            "srcText": "export const s = [1,2].join(\"\n\");",
        });
        let err = validate_component_batch(std::slice::from_ref(&corrupt)).unwrap_err();
        assert!(err.contains("BarChart"), "names the component; got: {err}");
        assert!(err.contains("unterminated string literal"), "got: {err}");

        // A valid module, a usage-snippet srcText (not a module → not gated), and a record with no
        // srcText all pass — the whole batch is accepted.
        let ok_batch = vec![
            serde_json::json!({ "id": "a", "name": "A", "srcText": "export function A(){ return null; }" }),
            serde_json::json!({ "id": "b", "name": "B", "srcText": "import { B } from \"@/x\";\n<B label={…} />" }),
            serde_json::json!({ "id": "c", "name": "C" }),
        ];
        assert!(validate_component_batch(&ok_batch).is_ok());
    }

    #[test]
    fn validate_component_batch_never_rejects_over_inline_animations() {
        use serde_json::json;
        // #3065: a component's `animations` entries may be a kit-animation NAME (string) OR an INLINE
        // def object (validated like `bsc ui kit define-animation`). A VALID inline def + a name ref is
        // clean — the batch passes.
        let good = json!({
            "id": "spark", "name": "Sparkline",
            "animations": [
                "fade-in", // a NAME ref into the kit's library
                { "name": "draw", "keyframes": { "from": { "opacity": "0" }, "to": { "opacity": "1" } } }
            ],
        });
        assert!(validate_component_batch(std::slice::from_ref(&good)).is_ok());

        // An INVALID inline def (an unsafe `url(...)` keyframe value + a bad-ident name) and a
        // non-string/non-object entry are NON-BLOCKING — the batch STILL writes (the warnings are a
        // stderr side-effect; the render compiler drops the bad fields). Rejecting a whole component
        // over one bad anim is too heavy.
        let bad = json!({
            "id": "spark2", "name": "Sparkline2",
            "animations": [
                { "name": "draw", "keyframes": { "from": { "opacity": "url(evil)" } } },
                { "name": "BAD NAME", "keyframes": { "from": { "opacity": "0" } } },
                42
            ],
        });
        assert!(
            validate_component_batch(std::slice::from_ref(&bad)).is_ok(),
            "an invalid inline animation must WRITE (warn-only), never reject the component",
        );

        // A component whose `animations` are all NAME refs (the pre-#3065 shape) is untouched + clean,
        // and one with a corrupt inline def alongside a corrupt-module srcText still fails ONLY on the
        // srcText (the srcText Err semantics are unchanged by the animations advisory).
        let names_only = json!({ "id": "c", "name": "C", "animations": ["fade-in", "pop"] });
        assert!(validate_component_batch(std::slice::from_ref(&names_only)).is_ok());
        let bad_src_and_anim = json!({
            "id": "d", "name": "DChart",
            "srcText": "export const s = [1,2].join(\"\n\");",
            "animations": [{ "name": "BAD NAME", "keyframes": {} }],
        });
        let err = validate_component_batch(std::slice::from_ref(&bad_src_and_anim)).unwrap_err();
        assert!(err.contains("DChart") && err.contains("unterminated string literal"), "srcText Err unchanged; got: {err}");
    }

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
        // `group` (#3048) + `shapes` (#2475) ride the lean list projection so `list`/`list --shape` expose the axes.
        assert_eq!(COMPONENT_SPEC.meta_fields, &["id", "name", "kitId", "role", "group", "shapes"]);
        assert_eq!(KIT_SPEC.noun, "kit");
        assert_eq!(KIT_SPEC.dir_segment, "kits");
        assert_eq!(KIT_SPEC.meta_fields, &["id", "name", "tech", "style", "stack"]);
        // The two collections live in DIFFERENT dirs (a component and a kit can share an id).
        assert_ne!(COMPONENT_SPEC.dir_segment, KIT_SPEC.dir_segment);
        assert_ne!(COMPONENT_SPEC.dir_env, KIT_SPEC.dir_env);
    }

    #[test]
    fn kit_axis_advisory_warns_but_never_blocks() {
        use serde_json::json;
        // #3040: a kit WITH both rail axes is fine, and one MISSING either (the "other/other" case a
        // designer hits by only setting `stack`) must still be accepted — the axes are optional in the
        // model, so `warn_kit_axes` only nudges (stderr) and NEVER rejects the batch.
        assert!(warn_kit_axes(&[json!({"id":"react-ui","name":"React","tech":"react","style":"studio","stack":"React"})]).is_ok());
        // Missing style, missing tech, missing both, and blank-string (which must not count as present).
        for bare in [
            json!({"id":"a","name":"A","tech":"react","stack":"x"}),           // no style
            json!({"id":"b","name":"B","style":"studio","stack":"x"}),          // no tech
            json!({"id":"react","name":"React","stack":"react"}),               // the exact reported case
            json!({"id":"c","name":"C","tech":" ","style":"","stack":"x"}),     // present-but-blank ⇒ still absent
        ] {
            assert!(warn_kit_axes(std::slice::from_ref(&bare)).is_ok(), "advisory must not block: {bare}");
        }
    }

    #[test]
    fn components_and_kits_persist_to_sqlite_db_files_not_legacy_json() {
        // Regression proof for #2984 (epic #2982): the shared-store SQLite migration (#2983) is
        // transparent to this crate. A component (and a kit) written through the crate's OWN store-open
        // path must land in the sibling `<base>/<segment>.db` SQLite file — NOT the pre-migration legacy
        // `<base>/<segment>/<id>.json` per-id file.
        let base = std::env::temp_dir().join(format!("bsc-component-sqlite-{}", std::process::id()));
        // Start from a clean slate so a prior run can't pre-seed the db (making "exists" trivially true)
        // or leave a stray legacy file (making "no legacy json" trivially false).
        let _ = std::fs::remove_dir_all(&base);
        let comp_dir = base.join("components");
        let kit_dir = base.join("kits");

        // Open both collections through the crate's own resolution. A `--dir` override wins over the env
        // (`resolve_store_path`), so this is deterministic: components at `<base>/components`, kits at
        // `<base>/kits`.
        let comps = open_component_store(&Some(comp_dir.to_string_lossy().into_owned())).unwrap();
        let kits = open_kit_store(&Some(kit_dir.to_string_lossy().into_owned())).unwrap();

        // Write one record into each collection…
        comps
            .set("button", r#"{"id":"button","name":"Button","kitId":"react-ui","role":"control"}"#)
            .unwrap();
        kits.set("react-ui", r#"{"id":"react-ui","name":"React UI","stack":"react"}"#).unwrap();

        // …and read them back verbatim (the round-trip the desktop library + a live session rely on).
        assert_eq!(
            comps.get("button").unwrap().as_deref(),
            Some(r#"{"id":"button","name":"Button","kitId":"react-ui","role":"control"}"#),
            "component round-trips through the SQLite store",
        );
        assert_eq!(
            kits.get("react-ui").unwrap().as_deref(),
            Some(r#"{"id":"react-ui","name":"React UI","stack":"react"}"#),
            "kit round-trips through the SQLite store",
        );

        // The SQLite backing is the sibling `<base>/<segment>.db`, and it exists after the write.
        assert_eq!(comps.db_path(), base.join("components.db").as_path());
        assert_eq!(kits.db_path(), base.join("kits.db").as_path());
        assert!(comps.db_path().exists(), "components persist to components.db");
        assert!(kits.db_path().exists(), "kits persist to kits.db");

        // No legacy per-id JSON file was written. `Store::file` computes exactly the pre-migration
        // `<segment>/<id>.json` path the SQLite backend replaced — assert it was never created.
        let legacy_comp = comps.file("button").unwrap();
        let legacy_kit = kits.file("react-ui").unwrap();
        assert_eq!(legacy_comp, comp_dir.join("button.json"));
        assert_eq!(legacy_kit, kit_dir.join("react-ui.json"));
        assert!(!legacy_comp.exists(), "no legacy components/<id>.json — the record lives in SQLite");
        assert!(!legacy_kit.exists(), "no legacy kits/<id>.json — the record lives in SQLite");

        // The db files (+ their WAL/SHM siblings) live inside `base`, so this clears everything.
        let _ = std::fs::remove_dir_all(&base);
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
        assert_eq!(
            names,
            vec![
                "list", "shapes", "get", "set", "remove", "kit", "eslint-preset", "usage", "doctor",
                "define-animation", "list-animations", "remove-animation"
            ]
        );
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
        // The mutating shapes (#2470) — gated on both collections + the animation writers (#2869).
        assert!(is_scoped_mutation(&a(&["set"])));
        assert!(is_scoped_mutation(&a(&["remove", "button"])));
        assert!(is_scoped_mutation(&a(&["kit", "set"])));
        assert!(is_scoped_mutation(&a(&["kit", "remove", "react-ui"])));
        assert!(is_scoped_mutation(&a(&["define-animation", "button"])));
        assert!(is_scoped_mutation(&a(&["remove-animation", "button", "fade-in"])));
        // Read verbs never gate — incl. the #2475 shape picker (`shapes` + `list --shape`) and
        // `list-animations` (#2869).
        for read in [
            &["list"][..], &["get", "button"], &["kit", "list"], &["kit", "get", "react-ui"],
            &["eslint-preset"], &["usage", "list"], &["shapes"], &["shapes", "graph"],
            &["list", "--shape", "table"], &["list-animations", "button"], &["help"], &[],
        ] {
            assert!(!is_scoped_mutation(&a(read)), "read shape gated: {read:?}");
        }
        // The trailing `help` form is documentation, not a mutation — reachable read-scoped.
        assert!(!is_scoped_mutation(&a(&["set", "help"])));
        assert!(!is_scoped_mutation(&a(&["kit", "remove", "help"])));
        assert!(!is_scoped_mutation(&a(&["define-animation", "help"])));
        assert!(!is_scoped_mutation(&a(&["remove-animation", "help"])));
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

    // ── component animations (#2869) ─────────────────────────────────────────────────────────────

    /// A minimal valid animation object (a mount fade-in referencing the motion tokens).
    fn valid_anim(name: &str) -> serde_json::Value {
        serde_json::json!({
            "name": name,
            "keyframes": { "from": { "opacity": "0" }, "to": { "opacity": "1" } },
            "duration": "var(--dur-base)",
            "easing": "var(--ease-standard)",
            "trigger": "mount",
        })
    }

    #[test]
    fn validate_animation_accepts_a_well_formed_definition() {
        assert!(validate_animation(&valid_anim("fade-in")).is_ok());
        // Minimal: just a name + one keyframe stop with one declaration (defaults fill the rest).
        assert!(validate_animation(&serde_json::json!({
            "name": "pulse",
            "keyframes": { "50%": { "transform": "scale(1.05)" } },
        }))
        .is_ok());
        // Optional selector / set / delay (#3054/#3056): a child selector, static decls, and a delay.
        assert!(validate_animation(&serde_json::json!({
            "name": "icon-spin",
            "keyframes": { "to": { "transform": "rotate(90deg)" } },
            "selector": ".icon > svg:nth-child(2n)",
            "set": { "transform-origin": "center", "transform-box": "fill-box" },
            "delay": "120ms",
        }))
        .is_ok());
        // Optional stagger (#3055): a per-element delay step is valid WITH a selector.
        assert!(validate_animation(&serde_json::json!({
            "name": "wave",
            "keyframes": { "to": { "opacity": "1" } },
            "selector": ".cell",
            "stagger": "14ms",
        }))
        .is_ok());
    }

    #[test]
    fn validate_animation_rejects_each_grammar_violation() {
        // Bad name (uppercase / leading digit / injection char).
        for bad in ["Fade", "1fade", "fade_in", "fade in", ""] {
            let a = serde_json::json!({ "name": bad, "keyframes": { "to": { "opacity": "1" } } });
            let err = validate_animation(&a).unwrap_err();
            assert!(err.contains("name"), "bad name '{bad}' rejected: {err}");
        }
        // Bad keyframe stop.
        let err = validate_animation(&serde_json::json!({
            "name": "x", "keyframes": { "start": { "opacity": "1" } }
        }))
        .unwrap_err();
        assert!(err.contains("stop"), "{err}");
        // Bad property.
        let err = validate_animation(&serde_json::json!({
            "name": "x", "keyframes": { "to": { "Opacity": "1" } }
        }))
        .unwrap_err();
        assert!(err.contains("property"), "{err}");
        // Unsafe value (declaration-ending / injection).
        for bad in ["1; } body { color: red", "url(evil.png)", "1 /* x */", "expression(alert(1))"] {
            let a = serde_json::json!({ "name": "x", "keyframes": { "to": { "opacity": bad } } });
            let err = validate_animation(&a).unwrap_err();
            assert!(err.contains("unsafe"), "unsafe value '{bad}' rejected: {err}");
        }
        // Unsafe duration / easing.
        let err = validate_animation(&serde_json::json!({
            "name": "x", "keyframes": { "to": { "opacity": "1" } }, "duration": "1s; color: red"
        }))
        .unwrap_err();
        assert!(err.contains("duration"), "{err}");
        // Empty / non-object keyframes.
        assert!(validate_animation(&serde_json::json!({ "name": "x", "keyframes": {} })).is_err());
        assert!(validate_animation(&serde_json::json!({ "name": "x", "keyframes": "nope" })).is_err());
        // Missing name / keyframes.
        assert!(validate_animation(&serde_json::json!({ "keyframes": { "to": { "opacity": "1" } } })).is_err());
        assert!(validate_animation(&serde_json::json!({ "name": "x" })).is_err());
        // Unknown trigger.
        let err = validate_animation(&serde_json::json!({
            "name": "x", "keyframes": { "to": { "opacity": "1" } }, "trigger": "click"
        }))
        .unwrap_err();
        assert!(err.contains("trigger"), "{err}");
        // `exit` (#3057) is a valid trigger — accepted (its rule/keyframes compile; runtime is a follow-up).
        assert!(validate_animation(&serde_json::json!({
            "name": "x", "keyframes": { "to": { "opacity": "1" } }, "trigger": "exit"
        }))
        .is_ok());
        // Injection selector (#3054) — a breakout attempt in the child selector is rejected.
        for bad in ["a{}b", "a;b", "</style>", "svg/*x*/"] {
            let a = serde_json::json!({
                "name": "x", "keyframes": { "to": { "opacity": "1" } }, "selector": bad
            });
            let err = validate_animation(&a).unwrap_err();
            assert!(err.contains("selector"), "bad selector '{bad}' rejected: {err}");
        }
        // Unsafe `set` property / value (#3054).
        let err = validate_animation(&serde_json::json!({
            "name": "x", "keyframes": { "to": { "opacity": "1" } }, "set": { "Bad-Prop": "center" }
        }))
        .unwrap_err();
        assert!(err.contains("set"), "{err}");
        let err = validate_animation(&serde_json::json!({
            "name": "x", "keyframes": { "to": { "opacity": "1" } }, "set": { "transform-origin": "center; }evil{" }
        }))
        .unwrap_err();
        assert!(err.contains("set") && err.contains("unsafe"), "{err}");
        // Unsafe delay (#3056).
        let err = validate_animation(&serde_json::json!({
            "name": "x", "keyframes": { "to": { "opacity": "1" } }, "delay": "1s; color: red"
        }))
        .unwrap_err();
        assert!(err.contains("delay"), "{err}");
    }

    #[test]
    fn validate_animation_gates_the_stagger_step() {
        // #3055 — `stagger` needs a `selector` (it steps the delay across the matched siblings) and
        // passes the value grammar. A selector + a safe stagger is accepted.
        assert!(validate_animation(&serde_json::json!({
            "name": "wave", "keyframes": { "to": { "opacity": "1" } }, "selector": ".cell", "stagger": "14ms"
        }))
        .is_ok());
        // A stagger with NO selector is rejected with the named error.
        let err = validate_animation(&serde_json::json!({
            "name": "wave", "keyframes": { "to": { "opacity": "1" } }, "stagger": "14ms"
        }))
        .unwrap_err();
        assert!(
            err.contains("stagger") && err.contains("requires a `selector`"),
            "stagger without a selector rejected: {err}"
        );
        // An unsafe stagger VALUE (declaration-ending / injection) is rejected even with a selector.
        let err = validate_animation(&serde_json::json!({
            "name": "wave", "keyframes": { "to": { "opacity": "1" } }, "selector": ".cell", "stagger": "14ms; } body{"
        }))
        .unwrap_err();
        assert!(err.contains("stagger") && err.contains("unsafe"), "unsafe stagger value rejected: {err}");
    }

    #[test]
    fn define_list_remove_animation_round_trip_on_the_record() {
        let dir = tmp_store_dir("anim-roundtrip");
        let store = bsc_json_store::Store::new(dir, "component");
        store.set("card", r#"{"id":"card","name":"Card","kitId":"react-ui","role":"layout"}"#).unwrap();

        // A component with no animations lists an empty array.
        assert_eq!(animations_of(&store, "card").unwrap(), serde_json::json!([]));

        // Define upserts by name — first append, then replace the same name (still ONE entry).
        upsert_animation(&store, "card", &valid_anim("fade-in")).unwrap();
        upsert_animation(&store, "card", &valid_anim("slide-up")).unwrap();
        let mut replaced = valid_anim("fade-in");
        replaced["trigger"] = serde_json::json!("hover");
        upsert_animation(&store, "card", &replaced).unwrap();

        let anims = animations_of(&store, "card").unwrap();
        let arr = anims.as_array().unwrap();
        assert_eq!(arr.len(), 2, "two distinct names, the duplicate replaced not appended");
        let fade = arr.iter().find(|a| a["name"] == "fade-in").unwrap();
        assert_eq!(fade["trigger"], "hover", "the replacement won");
        // The record round-trips: the raw stored JSON parses and carries `animations`.
        let raw = store.get("card").unwrap().unwrap();
        assert!(raw.contains("\"animations\""));

        // Remove drops exactly the named one.
        remove_named_animation(&store, "card", "fade-in").unwrap();
        let arr = animations_of(&store, "card").unwrap();
        let arr = arr.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["name"], "slide-up");
    }

    #[test]
    fn animation_verbs_error_on_an_unknown_component_or_animation() {
        let dir = tmp_store_dir("anim-missing");
        let store = bsc_json_store::Store::new(dir, "component");
        // Unknown component id → a clear error for every verb.
        assert!(upsert_animation(&store, "ghost", &valid_anim("fade-in")).unwrap_err().contains("ghost"));
        assert!(animations_of(&store, "ghost").unwrap_err().contains("ghost"));
        assert!(remove_named_animation(&store, "ghost", "fade-in").unwrap_err().contains("ghost"));
        // Removing an animation the component doesn't have → an error naming it.
        store.set("card", r#"{"id":"card","name":"Card"}"#).unwrap();
        let err = remove_named_animation(&store, "card", "nope").unwrap_err();
        assert!(err.contains("nope") && err.contains("no animation"), "{err}");
        // An invalid animation never lands on the record.
        let bad = serde_json::json!({ "name": "Bad", "keyframes": { "to": { "opacity": "1" } } });
        assert!(upsert_animation(&store, "card", &bad).is_err());
        assert_eq!(animations_of(&store, "card").unwrap(), serde_json::json!([]));
    }

    #[test]
    fn list_and_remove_animation_run_end_to_end_through_the_cli() {
        let dir = tmp_store_dir("anim-cli");
        let store = bsc_json_store::Store::new(dir.clone(), "component");
        store.set("card", r#"{"id":"card","name":"Card"}"#).unwrap();
        upsert_animation(&store, "card", &valid_anim("fade-in")).unwrap();

        // list-animations is a read: runs Ok (lean + --pretty).
        assert!(run(vec!["list-animations".into(), "card".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(run(
            vec!["list-animations".into(), "card".into(), "--pretty".into(), "--dir".into(), dir.clone()],
            "bsc ui"
        )
        .is_ok());
        // remove-animation drops it through the CLI.
        run(vec!["remove-animation".into(), "card".into(), "fade-in".into(), "--dir".into(), dir.clone()], "bsc ui")
            .unwrap();
        assert_eq!(animations_of(&store, "card").unwrap(), serde_json::json!([]));
        // remove of an absent name errors through the CLI.
        assert!(run(
            vec!["remove-animation".into(), "card".into(), "gone".into(), "--dir".into(), dir],
            "bsc ui"
        )
        .is_err());
    }

    #[test]
    fn kit_scoped_animation_authoring_round_trips_and_is_registered_and_gated() {
        // #2942 — a kit owns its motion library (the sibling of themes). The core authoring functions
        // work over the KIT store, the verbs are registered under `kit`, and the writers are ui-gated.
        let dir = tmp_store_dir("kit-anim");
        let store = bsc_json_store::Store::new(dir.clone(), "kit");
        store.set("react-ui", r#"{"id":"react-ui","name":"react-ui","stack":"React"}"#).unwrap();

        // Author two motions into the kit; list + remove round-trip.
        upsert_animation(&store, "react-ui", &valid_anim("fade-in")).unwrap();
        upsert_animation(&store, "react-ui", &valid_anim("lift")).unwrap();
        assert_eq!(animations_of(&store, "react-ui").unwrap().as_array().unwrap().len(), 2);
        assert!(store.get("react-ui").unwrap().unwrap().contains("\"animations\""));
        // The CLI read + remove paths run through `run` against the kit store dir.
        assert!(run(vec!["kit".into(), "list-animations".into(), "react-ui".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        run(vec!["kit".into(), "remove-animation".into(), "react-ui".into(), "fade-in".into(), "--dir".into(), dir], "bsc ui").unwrap();
        let arr = animations_of(&store, "react-ui").unwrap();
        assert_eq!(arr.as_array().unwrap().len(), 1);
        assert_eq!(arr.as_array().unwrap()[0]["name"], "lift");

        // Registered under `kit`, and the writers are ui-scope gated (reads are not).
        let names: Vec<&str> = KIT_COMMANDS.iter().map(|c| c.name).collect();
        for v in ["define-animation", "list-animations", "remove-animation"] {
            assert!(names.contains(&v), "KIT_COMMANDS exposes '{v}'");
        }
        let mk = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<String>>();
        assert!(is_scoped_mutation(&mk(&["kit", "define-animation", "react-ui"])));
        assert!(is_scoped_mutation(&mk(&["kit", "remove-animation", "react-ui", "x"])));
        assert!(!is_scoped_mutation(&mk(&["kit", "list-animations", "react-ui"])));
    }

    #[test]
    fn animation_verbs_appear_in_help_and_the_writers_refuse_under_a_read_scope() {
        // The three verbs are in the merged catalog with their doc detail.
        let ov = bsc_cli_util::help_overview("bsc ui", TAGLINE, COMPONENT_COMMANDS);
        for c in ["define-animation", "list-animations", "remove-animation"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMPONENT_COMMANDS, "define-animation");
        assert!(d.contains("stdin") && d.contains("keyframes"), "define-animation detail teaches the shape");

        // The writers refuse under `ui: read`, BEFORE touching the store (mirrors set/remove).
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var(bsc_cli_util::BSC_SCOPES_ENV, r#"{"ui":"read"}"#);
        let err = run(vec!["remove-animation".into(), "card".into(), "x".into()], "bsc ui").unwrap_err();
        assert!(err.contains("'ui'") && err.contains("read-only"), "read-scope refusal: {err}");
        // list-animations is a READ tier — reachable under the read scope, against a scratch --dir.
        let dir = tmp_store_dir("anim-read-scope");
        bsc_json_store::Store::new(dir.clone(), "component")
            .set("card", r#"{"id":"card","name":"Card"}"#)
            .unwrap();
        assert!(run(vec!["list-animations".into(), "card".into(), "--dir".into(), dir], "bsc ui").is_ok());
        // Help stays reachable read-scoped.
        assert!(run(vec!["define-animation".into(), "help".into()], "bsc ui").is_ok());
        std::env::remove_var(bsc_cli_util::BSC_SCOPES_ENV);
    }
}
