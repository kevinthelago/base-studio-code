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
use std::path::{Path, PathBuf};

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
        name: "tokens",
        summary: "list the semantic design tokens an LLM can set — the addressable design surface (#2568)",
        usage: "\
USAGE:
  bsc ui tokens [--family <f>] [--component <c>] [--pretty]

Enumerates every semantic token the design system defines (from the style descriptor, #2567): one row
per token — { name, type, default, governs, family } (+ component/variant/key for a component token).
This is the surface a designer edits — pick a token here, then `bsc ui theme set-token <theme> <name>
<value>` to retint it live. --family (base|card|btn|field|chip) / --component (e.g. btn) filter;
--pretty indents. The DISCOVERY front door: enumerate the surface before editing it.",
    },
    CmdDoc {
        name: "components",
        summary: "list the style-bearing components + the tokens/variants each exposes, or --coverage a token's reach + leaks (#2568/#2588/#2600)",
        usage: "\
USAGE:
  bsc ui components [--pretty]
  bsc ui components --coverage [--dir <path>] [--pretty]

Lists each style-bearing component with what a designer can address on it: its token keys and its
variants (e.g. btn → tokens [bg, bg-hover, border, fg, radius], variants [primary]). The index a
designer scans before descending to per-component token edits. --pretty indents.

--coverage instead REPORTS a token's REACH (#2588): it walks a source tree (--dir, default `.`;
recursing .tsx/.ts/.css/.jsx/.js, skipping node_modules/.git/target/dist/build/.claude) and counts,
per component + per token, how many surfaces CONSUME the token as `var(--<token>` — so a token
change's reach is a number, not a guess. It emits { component, tokensConsumed, tokensTotal, totalRefs }
rollups + { token, refs } rows, plus a `zeroConsumers` list that flags every token NO surface reads
(setting one is a no-op in that tree). A token DEFINITION (`--x:` in :root) is deliberately not counted
— only consumers move when the value changes. It ALSO reports `leakCandidates` (#2600): per file, the
count of hardcoded color literals (6/8-digit hex or rgb()/hsl()) a token change CAN'T reach — the
migration's targets, most-first — plus a `leakTotal`. (Heuristic: the 6/8-hex rule skips issue refs
like `#219`; it won't catch named colors.) Compact JSON by default; --pretty indents for reading.",
    },
    CmdDoc {
        name: "component",
        summary: "address ONE component's tokens by short key (+variant) — the ergonomic set-token (#2569)",
        usage: "\
USAGE:
  bsc ui component <name> list-tokens [--variant <v>] [--pretty]
  bsc ui component <name> set-token <key> <value> [--variant <v>] [--theme <id>]
  bsc ui component <name> define-variant <variant> --set <key>=<value> [--set …]
  bsc ui component <name> list-variants [--pretty]
  bsc ui component <name> remove-variant <variant>

Edit a component's semantic tokens by their SHORT key (from `bsc ui components`) instead of the full
custom-property name: `bsc ui component btn set-token bg @accent` resolves `--btn-bg` and sets it on a
theme (--theme, default `default`), validated + live exactly like `theme set-token`. --variant targets a
variant's tokens (`--variant primary` → `--btn-primary-bg`). The rung-2 ergonomic form: DISCOVER keys
with `bsc ui components`, EDIT them here — never type the `--<comp>[-<variant>]-<key>` convention.

define-variant AUTHORS a NEW variant as data (#2569 rung 3): a token bundle
(`--set bg=@danger --set fg=@fg`) stored under `<component>:<variant>`, which the frontend compiles into
a live `[data-variant]` CSS rule. Guarded: the variant NAME must be a safe CSS identifier, every --set
key must be one of the component's tokens, and every value passes the closed value grammar.",
    },
    CmdDoc {
        name: "variants",
        summary: "list EVERY stored variant definition (what the frontend compiles into live CSS, #2569)",
        usage: "\
USAGE:
  bsc ui variants [--component <c>] [--pretty]

Every variant an LLM has authored with `component … define-variant`, across all components — the flat
list the desktop reads to compile each into a `[data-variant]` CSS rule (the runtime render path).
--component filters to one component; --pretty indents.",
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
        name: "emit-css",
        summary: "emit a generated app's palette pair: the token contract + a theme.css (#2489)",
        usage: "\
USAGE:
  bsc ui emit-css [--theme <id>]        # print the full stylesheet (contract layer + theme block)
  bsc ui emit-css --theme <id> --out D  # write D/tokens.css + D/theme.css (two files, the real layout)

Emits the CSS a generated app ships its palette as (#2489). Two documented layers, in stylesheet
order: (1) `tokens.css` — the semantic token contract (base palette defaults + the `--card-*`/
`--btn-*`/`--field-*`/`--chip-*` tokens kit components consume; READ-ONLY for build agents), then
(2) `theme.css` — the chosen theme's overrides, THE app's palette. App styles load after both. So
re-theming an app = replacing theme.css only (re-run with another --theme): zero component changes.
--theme defaults to `default`; the id resolves through the same lookup `bsc ui theme get` serves,
at emission time (never snapshotted), and an unknown id errors listing the available themes.",
    },
    CmdDoc {
        name: "theme",
        summary: "the kit THEME store — list/get themes, or author them via set/remove (#1852/#2488)",
        usage: "\
USAGE:
  bsc ui theme list [--full] [--pretty]      # every theme's { id, label, description }; --full = complete objects
  bsc ui theme active [--json]               # the RUNNING app's active theme id (read-only); --json → { active, source }
  bsc ui theme get <id> [--pretty]           # one theme verbatim (id, label, description, vars), or null
  bsc ui theme set [--file PATH] [--pretty]  # theme JSON (object or array) on stdin or --file; upsert by id
  bsc ui theme remove <id> [--pretty]        # delete a stored theme (packaged built-ins stay embedded)
  bsc ui theme set-token <id> <token> <value># set ONE semantic token on a theme (validated, live via ui-touch)
  bsc ui theme unset-token <id> <token>      # drop one override → the token's contract default
  bsc ui theme validate <id> | --file PATH   # check a theme's vars against the token contract + value grammar

set-token/unset-token edit an EXISTING theme in place (a built-in materializes on first edit): the
token is a `--custom-property` the contract defines (see `bsc ui tokens`), and the value passes the
CLOSED VALUE GRAMMAR — a `var(--x)`/`@x` token reference, a `color-mix()`/`oklch()`, a hex colour, or a
dimension; anything that could end the declaration or inject CSS is refused. A theme is a map of
semantic component-token overrides (--card-*/--btn-*/--field-*/--chip-*) applied
globally (:root) or scoped to a subtree — restyling every card/button/field/chip without touching a
spec's structure. This is the SDK's THEME axis (style × theme × spec); the same collection the desktop
theme picker reads. Themes live in the designer-writable store at ~/.base-studio-code/themes/ (--dir/
BSC_UI_THEME_DIR override, #2488); the reads MERGE the packaged built-ins in, so every theme is always
visible and removing a built-in's stored copy falls back to the embedded one. `set`/`remove` are
ui-scope MUTATIONS (#2470): they refuse when the session's $BSC_SCOPES grants only `ui: read`.
`active` is READ-ONLY (#2589): it reports the id of the theme the RUNNING app currently has active —
the persisted zustand `kitTheme` in the app's `app-state.json` — so a designer tunes the theme the
user is actually looking at instead of `default` blind. It prints the bare id (falling back to
`default` when the app hasn't run / set one), or with `--json` a `{ active, source }` object whose
`source` is the app-state path it read (else `default`); it NEVER writes app-state.json.
`bsc ui theme get default` prints the shape to author against — palettes only: override the semantic
tokens, never a spec's structure.",
    },
    CmdDoc {
        name: "generate",
        summary: "generate coherent palette VALUES from a seed — the no-holes engine (#2634)",
        usage: "\
USAGE:
  bsc ui generate categorical --count <n> [--seed <hue>] [--pretty]  # N evenly-spaced OKLCH categorical hues
  bsc ui generate next --existing <h1,h2,…> [--pretty]               # ONE hue in the largest gap (fill a new slot)
  bsc ui generate status [--pretty]                                  # health status → semantic-token mapping

The DETERMINISTIC palette generator — the \"data generates design\" engine: a seed + a category count
(or the hues already in use) → coherent token VALUES, so a growing vocabulary is filled on-brand with
NO holes. `categorical` spaces N hues evenly around the wheel from --seed (default the brand accent
hue) at a fixed lightness/chroma. `next` places one hue in the LARGEST circular gap among --existing —
maximally distinct from what's there (the literal no-holes primitive). `status` maps
idle/healthy/warning/error to the semantic base tokens (var(--info)/--success/--accent/--danger) so
status colours compose with the theme. Pure output (JSON; --pretty indents) — it PRODUCES values, it
does NOT write/apply them (that wiring is the reconciliation slice).",
    },
    CmdDoc {
        name: "resolve",
        summary: "resolve a theme against a kit's tokens + report misses/holes — fall loudly (#2637)",
        usage: "\
USAGE:
  bsc ui resolve --theme <id> [--dir <src>] [--pretty]

The RESOLVER as a LOUD diagnostic: theming is a CSS cascade that silently falls back, so this makes the
composition explicit. It resolves each token against the precedence bound-theme > contract-default (the
user/generated layers enter in later slices) and reports `themeMisses` — a consumed token the theme
leaves at its contract default — and `uncontracted` — a consumed token the contract does NOT define, so
the design system can't govern it (the fall-loudly gap: it may be app-live legacy or a typo, but a theme
can't reach it). With --dir it scans a KIT's source for the `var(--<token>` it consumes (its addressable
surface); without, it resolves the whole contract. `complete` is true when nothing is uncontracted.
Compact JSON by default; --pretty indents.",
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
        Some("tokens") => cmd_tokens(&args[1..]),
        Some("components") => cmd_components(&args[1..]),
        Some("component") => cmd_component(&args[1..], prog),
        Some("variants") => cmd_variants(&args[1..]),
        Some("release") => cmd_kit(&args[1..], prog),
        Some("emit-css") => cmd_emit_css(&args[1..]),
        Some("theme") => cmd_theme(&args[1..], prog),
        Some("generate") => cmd_generate(&args[1..], prog),
        Some("resolve") => cmd_resolve(&args[1..]),
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

/// `bsc ui generate …` (#2634) — the deterministic palette generator: a seed + a category count (or
/// the hues in use) → coherent token VALUES, filling a growing vocabulary on-brand with no holes.
/// Pure JSON output; it does NOT write/apply (that is the reconciliation slice).
fn cmd_generate(args: &[String], prog: &str) -> Result<(), String> {
    let sub = args.first().map(String::as_str);
    let rest = args.get(1..).unwrap_or(&[]);
    let pretty = rest.iter().any(|a| a == "--pretty");
    let emit = |v: &serde_json::Value| -> Result<(), String> {
        let s = if pretty { serde_json::to_string_pretty(v) } else { serde_json::to_string(v) };
        println!("{}", s.map_err(|e| e.to_string())?);
        Ok(())
    };
    match sub {
        Some("categorical") => {
            let (mut count, mut seed) = (0usize, crate::GEN_SEED_HUE);
            let mut it = rest.iter();
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--count" => count = it.next().and_then(|s| s.parse().ok()).ok_or("usage: --count <n>")?,
                    "--seed" => seed = it.next().and_then(|s| s.parse().ok()).ok_or("usage: --seed <hue>")?,
                    "--pretty" => {}
                    other => return Err(format!("unknown flag '{other}'")),
                }
            }
            if count == 0 {
                return Err("usage: bsc ui generate categorical --count <n> [--seed <hue>]".into());
            }
            emit(&serde_json::json!({ "seed": seed, "count": count, "colors": crate::generate_categorical(seed, count) }))
        }
        Some("next") => {
            let mut existing: Vec<f64> = Vec::new();
            let mut it = rest.iter();
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--existing" => {
                        let raw = it.next().ok_or("usage: --existing <h1,h2,…>")?;
                        existing = raw
                            .split(',')
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|s| s.parse::<f64>().map_err(|_| format!("bad hue '{s}'")))
                            .collect::<Result<_, _>>()?;
                    }
                    "--pretty" => {}
                    other => return Err(format!("unknown flag '{other}'")),
                }
            }
            let hue = crate::next_distinct_hue(&existing);
            emit(&serde_json::json!({ "hue": hue, "color": crate::categorical_color(hue) }))
        }
        Some("status") => {
            let rows: Vec<serde_json::Value> = crate::status_palette()
                .into_iter()
                .map(|(k, v)| serde_json::json!({ "status": k, "value": v }))
                .collect();
            emit(&serde_json::json!(rows))
        }
        None | Some("help") => {
            print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, "generate"));
            Ok(())
        }
        Some(other) => Err(format!("unknown generate command '{other}' — want: categorical | next | status")),
    }
}

/// Collect the distinct tokens a source text CONSUMES via `var(--<name>` (#2637) — a kit's addressable
/// surface. Sorted (BTreeSet) for deterministic output. Used by `bsc ui resolve --dir`.
fn consumed_tokens_in(text: &str, out: &mut std::collections::BTreeSet<String>) {
    for (i, _) in text.match_indices("var(--") {
        // "var(" is 4 bytes (ASCII), so the "--name" starts at i+4.
        let name: String = text[i + 4..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        // A trailing `-` means the scan stopped at a non-name char mid-token — a DYNAMIC construction
        // like `var(--graph-${key})`; that prefix isn't a real token, so skip it (a valid custom
        // property never ends in `-`).
        if name.len() > 2 && !name.ends_with('-') {
            out.insert(name);
        }
    }
}

/// Split a consumed token set against a theme's `overrides` + the `contract` (#2637): returns
/// (themeMisses, uncontracted). A token the theme overrides resolves from the theme (neither list); one
/// the contract defines but the theme doesn't → a MISS (uses the default); one the contract lacks →
/// UNCONTRACTED (the design system can't govern it — the loud gap). Pure → unit-tested.
fn resolve_diagnostics(
    consumed: &[String],
    overrides: &std::collections::HashSet<String>,
    contract: &std::collections::HashSet<String>,
) -> (Vec<String>, Vec<String>) {
    let (mut misses, mut uncontracted) = (Vec::new(), Vec::new());
    for token in consumed {
        if overrides.contains(token) {
            // resolved from the theme — governed, no diagnostic
        } else if contract.contains(token) {
            misses.push(token.clone());
        } else {
            uncontracted.push(token.clone());
        }
    }
    (misses, uncontracted)
}

/// `bsc ui resolve --theme <id> [--dir <path>]` (#2637) — the RESOLVER as a loud diagnostic report:
/// resolve each token against bound-theme > contract-default and surface `themeMisses` + `uncontracted`
/// (the fall-loudly gap) + `complete`. `--dir` scans a kit's source for its consumed tokens; otherwise
/// the whole contract is resolved. Pure output (JSON); it does not write/apply anything.
fn cmd_resolve(args: &[String]) -> Result<(), String> {
    let (mut theme_id, mut dir, mut pretty) = (None::<String>, None::<String>, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--theme" => theme_id = it.next().cloned(),
            "--dir" => dir = it.next().cloned(),
            "--pretty" => pretty = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => return Err(format!("unexpected argument '{other}'")),
        }
    }
    let theme_id = theme_id.ok_or("usage: bsc ui resolve --theme <id> [--dir <path>]")?;
    let theme = crate::theme_by_id(&theme_id).ok_or_else(|| format!("unknown theme '{theme_id}'"))?;
    let overrides: std::collections::HashSet<String> = theme
        .get("vars")
        .and_then(serde_json::Value::as_object)
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    let contract: std::collections::HashSet<String> = crate::flatten_tokens()
        .iter()
        .filter_map(|t| t.get("name").and_then(serde_json::Value::as_str).map(str::to_owned))
        .collect();
    // The consumed surface: a kit's source (--dir), else the whole contract.
    let consumed: Vec<String> = if let Some(d) = &dir {
        let mut files: Vec<(String, String)> = Vec::new();
        let p = std::path::Path::new(d);
        collect_source_files_into(p, p, &mut files)?;
        let mut set = std::collections::BTreeSet::new();
        for (_, text) in &files {
            consumed_tokens_in(text, &mut set);
        }
        set.into_iter().collect()
    } else {
        let mut v: Vec<String> = contract.iter().cloned().collect();
        v.sort();
        v
    };
    let (misses, uncontracted) = resolve_diagnostics(&consumed, &overrides, &contract);
    let report = serde_json::json!({
        "theme": theme_id,
        "mode": if dir.is_some() { "dir" } else { "contract" },
        "consumed": consumed.len(),
        "overridden": consumed.len() - misses.len() - uncontracted.len(),
        "themeMisses": misses,
        "uncontracted": uncontracted,
        "complete": uncontracted.is_empty(),
    });
    let out = if pretty { serde_json::to_string_pretty(&report) } else { serde_json::to_string(&report) };
    println!("{}", out.map_err(|e| e.to_string())?);
    Ok(())
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

/// `bsc ui tokens` (#2568) — enumerate the semantic design tokens from the style descriptor: the
/// addressable surface a designer edits. The DISCOVERY front door (the discovery surface is the routing
/// surface): a designer lists tokens, then `theme set-token` retints one live.
fn cmd_tokens(args: &[String]) -> Result<(), String> {
    let (mut family, mut component, mut pretty) = (None::<String>, None::<String>, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--family" => family = it.next().cloned(),
            "--component" => component = it.next().cloned(),
            "--pretty" => pretty = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => return Err(format!("unexpected argument '{other}'")),
        }
    }
    let rows: Vec<serde_json::Value> = crate::flatten_tokens()
        .into_iter()
        .filter(|t| family.as_deref().is_none_or(|f| t.get("family").and_then(serde_json::Value::as_str) == Some(f)))
        .filter(|t| component.as_deref().is_none_or(|c| t.get("component").and_then(serde_json::Value::as_str) == Some(c)))
        .collect();
    let out = if pretty { serde_json::to_string_pretty(&rows) } else { serde_json::to_string(&rows) };
    println!("{}", out.map_err(|e| e.to_string())?);
    Ok(())
}

/// `bsc ui components` (#2568) — the style-bearing component index: each component's token keys +
/// variants, the map a designer scans before descending to per-component token edits. With
/// `--coverage` it instead reports each token's REACH over a source tree (#2588, see
/// [`cmd_components_coverage`]).
fn cmd_components(args: &[String]) -> Result<(), String> {
    let (mut pretty, mut coverage) = (false, false);
    let mut dir = None::<String>;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--pretty" => pretty = true,
            "--coverage" => coverage = true,
            "--dir" => dir = it.next().cloned(),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => return Err(format!("unexpected argument '{other}'")),
        }
    }
    if coverage {
        return cmd_components_coverage(dir.as_deref().unwrap_or("."), pretty);
    }
    let d = crate::style_descriptor();
    let comps: Vec<serde_json::Value> = d
        .get("components")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .map(|c| {
            let keys: Vec<&str> = c
                .get("tokens")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|t| t.get("key").and_then(serde_json::Value::as_str))
                .collect();
            let vars: Vec<&str> = c
                .get("variants")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.get("variant").and_then(serde_json::Value::as_str))
                .collect();
            serde_json::json!({ "component": c.get("component"), "governs": c.get("governs"), "tokens": keys, "variants": vars })
        })
        .collect();
    let out = if pretty { serde_json::to_string_pretty(&comps) } else { serde_json::to_string(&comps) };
    println!("{}", out.map_err(|e| e.to_string())?);
    Ok(())
}

/// The source-file extensions the coverage scan reads (#2588) and the directory names it skips
/// (vendored / build output / VCS / this tool's own worktrees) — the set that keeps a "reach" number
/// about the app's OWN source, not third-party or generated code.
const COVERAGE_EXTS: &[&str] = &["tsx", "ts", "css", "jsx", "js"];
const COVERAGE_SKIP_DIRS: &[&str] = &["node_modules", ".git", "target", "dist", "build", ".claude"];

/// Count the CONSUMER references to one token in `text` (#2588): occurrences of the `var(--<name>`
/// form where the character after the name is NOT an identifier char — so `var(--btn-bg` counts
/// `var(--btn-bg)` / `var(--btn-bg, #000)` but NOT `var(--btn-bg-hover)`. A DEFINITION (`--x:` in a
/// :root block) has no `var(` prefix, so it is never matched — correct, because a definition is not a
/// consumer and does not move when the token's value changes. Pure → unit-tested directly.
fn count_token_consumers(text: &str, token: &str) -> usize {
    let needle = format!("var({token}");
    let bytes = text.as_bytes();
    text.match_indices(&needle)
        .filter(|(i, _)| {
            let after = *i + needle.len();
            bytes.get(after).is_none_or(|b| !(b.is_ascii_alphanumeric() || *b == b'-'))
        })
        .count()
}

/// Count hardcoded COLOR literals in `text` (#2600) — the leak candidates a token change can't reach:
/// a 6- or 8-digit hex (`#rrggbb` / `#rrggbbaa`) or a `rgb(` / `rgba(` / `hsl(` / `hsla(` function. The
/// 6/8-hex requirement deliberately skips 3-4 digit issue refs (`#219`, `#773`), and a `var(--x)` token
/// use carries no `#` / `rgb(`, so tokenized surfaces aren't counted. A heuristic (it won't catch a
/// named color, and it does count a literal that sits in a comment or a fallback), but honest + stable —
/// it POINTS at the files to migrate; the per-file ranking is what matters. Pure → unit-tested directly.
fn count_color_literals(text: &str) -> usize {
    let bytes = text.as_bytes();
    let mut n = 0usize;
    // Hex: `#` + a run of exactly 6 or 8 hex digits (a 3-4 digit issue ref has too few to match; a
    // 7/9+ run is not a valid color, so it's skipped rather than miscounted).
    for (i, _) in text.match_indices('#') {
        let hexlen = bytes[i + 1..].iter().take_while(|b| b.is_ascii_hexdigit()).count();
        if hexlen == 6 || hexlen == 8 {
            n += 1;
        }
    }
    // Functional notations — distinct substrings, so `rgb(` does not double-count inside `rgba(`.
    for f in ["rgb(", "rgba(", "hsl(", "hsla("] {
        n += text.matches(f).count();
    }
    n
}

/// Recursively gather `(relative-path, text)` for every UI source file under `root` for the coverage
/// scan (#2588/#2600): files with a [`COVERAGE_EXTS`] extension, skipping the [`COVERAGE_SKIP_DIRS`].
/// The path is relative to `root`, forward-slashed, so leak-candidate rows read the same on every OS.
/// Unreadable (non-UTF-8 / binary) files are skipped, not fatal; symlinked dirs are not followed
/// (neither `is_dir` nor `is_file`), so the walk cannot loop.
fn collect_source_files_into(
    root: &std::path::Path,
    dir: &std::path::Path,
    out: &mut Vec<(String, String)>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if ft.is_dir() && !COVERAGE_SKIP_DIRS.contains(&name.as_ref()) {
            collect_source_files_into(root, &path, out)?;
        } else if ft.is_file() {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default();
            if COVERAGE_EXTS.contains(&ext) {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                    out.push((rel, text));
                }
            }
        }
    }
    Ok(())
}

/// The per-token consumer counts from a source-tree scan (#2588), keyed by token name. Factored out of
/// [`cmd_components_coverage`] so a test drives it against a temp dir without shelling out: it walks
/// `dir` ([`collect_source_files_into`]) and, per file, tallies each token's `var(--<name>` consumers
/// ([`count_token_consumers`]). Every token in `tokens` is present in the result (0 when unused).
fn coverage_scan(
    dir: &std::path::Path,
    tokens: &[String],
) -> Result<std::collections::HashMap<String, usize>, String> {
    let mut files: Vec<(String, String)> = Vec::new();
    collect_source_files_into(dir, dir, &mut files)?;
    let mut counts: std::collections::HashMap<String, usize> =
        tokens.iter().map(|t| (t.clone(), 0usize)).collect();
    for (_, text) in &files {
        for token in tokens {
            let n = count_token_consumers(text, token);
            if let Some(c) = counts.get_mut(token) {
                *c += n;
            }
        }
    }
    Ok(counts)
}

/// The hardcoded-color LEAK candidates under `dir` (#2600): each source file's raw color-literal count
/// ([`count_color_literals`]), keeping only files with at least one, most-first (ties by path). These
/// are the surfaces a token change CAN'T reach — the migration's concrete targets, so the coverage
/// report points at the work instead of the maintainer grepping by hand.
fn leak_scan(dir: &std::path::Path) -> Result<Vec<(String, usize)>, String> {
    let mut files: Vec<(String, String)> = Vec::new();
    collect_source_files_into(dir, dir, &mut files)?;
    let mut rows: Vec<(String, usize)> = files
        .into_iter()
        .filter_map(|(path, text)| {
            let n = count_color_literals(&text);
            (n > 0).then_some((path, n))
        })
        .collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(rows)
}

/// `bsc ui components --coverage [--dir <path>]` (#2588) — make a token's REACH a number, not a guess.
/// Walks a source tree and, per contract token, counts the `var(--<name>` CONSUMER references, grouped
/// by owning component (`family`: "base" for the palette, else the component), with per-component
/// rollups and a `zeroConsumers` list flagging tokens no surface reads — setting one is a no-op there.
/// JSON for machine use (compact by default; `--pretty` indents for a readable view, the sibling idiom).
fn cmd_components_coverage(dir: &str, pretty: bool) -> Result<(), String> {
    // Every contract token paired with its owning component (the grouping key), in descriptor order.
    let contract: Vec<(String, String)> = crate::flatten_tokens()
        .into_iter()
        .filter_map(|t| {
            let name = t.get("name").and_then(serde_json::Value::as_str)?.to_string();
            let comp = t.get("family").and_then(serde_json::Value::as_str).unwrap_or("base").to_string();
            Some((name, comp))
        })
        .collect();
    let names: Vec<String> = contract.iter().map(|(n, _)| n.clone()).collect();
    let counts = coverage_scan(std::path::Path::new(dir), &names)?;

    // Component grouping, first-seen order preserved from the descriptor.
    let mut order: Vec<String> = Vec::new();
    for (_, comp) in &contract {
        if !order.contains(comp) {
            order.push(comp.clone());
        }
    }
    let mut components: Vec<serde_json::Value> = Vec::new();
    let mut zero_consumers: Vec<String> = Vec::new();
    let (mut total_consumed, mut grand_refs) = (0usize, 0usize);
    for comp in &order {
        let toks: Vec<&(String, String)> = contract.iter().filter(|(_, c)| c == comp).collect();
        let mut token_rows: Vec<serde_json::Value> = Vec::new();
        let (mut consumed, mut comp_refs) = (0usize, 0usize);
        for (name, _) in &toks {
            let refs = *counts.get(name).unwrap_or(&0);
            if refs == 0 {
                zero_consumers.push(name.clone());
            } else {
                consumed += 1;
                comp_refs += refs;
            }
            token_rows.push(serde_json::json!({ "token": name, "refs": refs }));
        }
        total_consumed += consumed;
        grand_refs += comp_refs;
        components.push(serde_json::json!({
            "component": comp,
            "tokensConsumed": consumed,
            "tokensTotal": toks.len(),
            "totalRefs": comp_refs,
            "tokens": token_rows,
        }));
    }
    // Leak candidates (#2600): the hardcoded colors a token change can't reach, per file — the
    // migration's targets, so the report points at the work instead of an ad-hoc grep.
    let leaks = leak_scan(std::path::Path::new(dir))?;
    let leak_total: usize = leaks.iter().map(|(_, n)| n).sum();
    let leak_candidates: Vec<serde_json::Value> =
        leaks.iter().map(|(file, count)| serde_json::json!({ "file": file, "count": count })).collect();
    let report = serde_json::json!({
        "dir": dir,
        "tokensTotal": contract.len(),
        "tokensConsumed": total_consumed,
        "totalRefs": grand_refs,
        "components": components,
        "zeroConsumers": zero_consumers,
        "leakTotal": leak_total,
        "leakCandidates": leak_candidates,
    });
    let out = if pretty { serde_json::to_string_pretty(&report) } else { serde_json::to_string(&report) };
    println!("{}", out.map_err(|e| e.to_string())?);
    Ok(())
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

/// Expand the `@name` token-reference shorthand to `var(--name)` — the closed grammar's ergonomic form
/// (`set-token <id> --card-bg @bg-elev`). Non-`@` text is untouched; a bare `@` with no ident stays.
fn expand_token_ref(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '@' {
            let mut ident = String::new();
            while let Some(&n) = chars.peek() {
                if n.is_ascii_alphanumeric() || n == '-' {
                    ident.push(n);
                    chars.next();
                } else {
                    break;
                }
            }
            if ident.is_empty() {
                out.push('@');
            } else {
                out.push_str(&format!("var(--{ident})"));
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Load a theme for a per-token edit (#2568): the STORED copy (verbatim), else the embedded built-in
/// (editing materializes it on write — the "edit the active theme in place" model, #2525), else an
/// error. Never silently creates: `set-token` targets an EXISTING theme; author a new one with `set`.
fn load_theme_for_edit(store: &bsc_json_store::Store, id: &str) -> Result<serde_json::Value, String> {
    if let Some(json) = store.get(id)? {
        return serde_json::from_str(&json)
            .map_err(|e| format!("stored theme '{id}' is not valid JSON: {e}"));
    }
    crate::theme_by_id(id).ok_or_else(|| format!("unknown theme '{id}' — see `bsc ui theme list`"))
}

/// The core of a per-token theme edit (#2568): validate the token is contract-defined + the value
/// against the closed grammar, load the theme (a built-in materializes), set the var, write it back,
/// and emit the live-focus `ui-touch`. Shared by `theme set-token` and `component set-token`. The
/// caller has already gated on the `ui` write scope.
fn write_theme_token(dir: &Option<String>, id: &str, token: &str, raw_value: &str) -> Result<serde_json::Value, String> {
    if !token.starts_with("--") {
        return Err(format!("token must be a --custom-property, e.g. --card-bg (got '{token}'); see `bsc ui tokens`"));
    }
    let names = crate::token_names();
    if !names.contains(token) {
        return Err(format!("'{token}' is not a token the contract defines — see `bsc ui tokens`"));
    }
    let value = expand_token_ref(raw_value);
    crate::validate_value(&value, &names)?;
    let store = theme_store(dir)?;
    let mut theme = load_theme_for_edit(&store, id)?;
    let obj = theme.as_object_mut().ok_or_else(|| format!("theme '{id}' is not an object"))?;
    let vars = obj
        .entry("vars")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| format!("theme '{id}' vars is not an object"))?;
    vars.insert(token.to_string(), serde_json::Value::String(value.clone()));
    let json = serde_json::to_string(&theme).map_err(|e| format!("set-token: {e}"))?;
    store.set(id, &json)?;
    bsc_util::emit_ui_activity("theme", id); // Design Studio live-focus (#2525)
    Ok(serde_json::json!({ "id": id, "token": token, "value": value }))
}

/// `bsc ui component <name> …` (#2569 rung 2) — address a component's tokens by their SHORT key (+
/// optional variant), the ergonomic form over `theme set-token`: the CLI resolves
/// `--<name>[-<variant>]-<key>` from the descriptor, so the LLM discovers keys with `bsc ui components`
/// and edits them here, never typing the naming convention.
/// The variant store's location (#2569): `--dir` → `$BSC_UI_VARIANT_DIR` →
/// `~/.base-studio-code/variants/` — a designer-writable store of NEW component variants (a token bundle
/// per `<component>:<variant>` id) the frontend compiles into live CSS. Parallel to the theme store.
const VARIANT_DIR_ENV: &str = "BSC_UI_VARIANT_DIR";
fn variant_store(dir: &Option<String>) -> Result<bsc_json_store::Store, String> {
    let dir = bsc_cli_util::resolve_store_path(dir, VARIANT_DIR_ENV, || {
        bsc_util::bsc_base_dir()
            .map(|b| b.join("variants"))
            .ok_or_else(|| "could not resolve a home directory; set HOME/USERPROFILE".to_string())
    })?;
    Ok(bsc_json_store::Store::new(dir, "variant"))
}

fn cmd_component(args: &[String], prog: &str) -> Result<(), String> {
    let (mut variant, mut theme, mut dir, mut pretty) =
        (None::<String>, None::<String>, None::<String>, false);
    let mut sets: Vec<String> = Vec::new();
    let mut positional: Vec<String> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--variant" => variant = it.next().cloned(),
            "--theme" => theme = it.next().cloned(),
            "--dir" => dir = it.next().cloned(),
            "--set" => {
                if let Some(kv) = it.next() {
                    sets.push(kv.clone());
                }
            }
            "--pretty" => pretty = true,
            // Everything else is positional — including a set-token <value> that starts with `--`.
            _ => positional.push(a.clone()),
        }
    }
    let name = positional
        .first()
        .map(String::as_str)
        .ok_or("usage: bsc ui component <name> list-tokens | set-token <key> <value>")?;
    if name == "help" || positional.get(1).map(String::as_str) == Some("help") {
        print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, "component"));
        return Ok(());
    }
    let d = crate::style_descriptor();
    let exists = d
        .get("components")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .any(|c| c.get("component").and_then(serde_json::Value::as_str) == Some(name));
    if !exists {
        return Err(format!("unknown component '{name}' — see `bsc ui components`"));
    }
    let emit = |v: &serde_json::Value| -> Result<(), String> {
        let s = if pretty { serde_json::to_string_pretty(v) } else { serde_json::to_string(v) };
        println!("{}", s.map_err(|e| e.to_string())?);
        Ok(())
    };
    match positional.get(1).map(String::as_str).unwrap_or("list-tokens") {
        "list-tokens" => {
            let rows: Vec<serde_json::Value> = crate::flatten_tokens()
                .into_iter()
                .filter(|t| t.get("component").and_then(serde_json::Value::as_str) == Some(name))
                .filter(|t| match variant.as_deref() {
                    None => true, // no --variant → all of the component's tokens (base + variants)
                    Some(v) => t.get("variant").and_then(serde_json::Value::as_str) == Some(v),
                })
                .collect();
            emit(&serde_json::Value::Array(rows))
        }
        "set-token" => {
            bsc_cli_util::require_write_scope("ui")?;
            let key = positional
                .get(2)
                .ok_or("usage: bsc ui component <name> set-token <key> <value> [--variant <v>] [--theme <id>]")?;
            let value = positional
                .get(3)
                .ok_or("usage: bsc ui component <name> set-token <key> <value> [--variant <v>] [--theme <id>]")?;
            let token = crate::resolve_component_token(name, variant.as_deref(), key).ok_or_else(|| {
                let vsuffix = variant.as_deref().map(|v| format!(" (variant '{v}')")).unwrap_or_default();
                format!("component '{name}' has no token '{key}'{vsuffix} — see `bsc ui component {name} list-tokens`")
            })?;
            let theme_id = theme.as_deref().unwrap_or("default");
            emit(&write_theme_token(&dir, theme_id, &token, value)?)
        }
        // Rung 3 (#2569): AUTHOR a NEW variant as data — a token bundle stored under `<component>:<name>`,
        // validated (safe-identifier name + component keys + closed value grammar) + live via ui-touch.
        // The frontend compiles the stored bundle into a `[data-variant]` CSS rule (follow-up).
        "define-variant" => {
            bsc_cli_util::require_write_scope("ui")?;
            let variant_name =
                positional.get(2).ok_or("usage: bsc ui component <name> define-variant <variant> --set <key>=<value> …")?;
            crate::sanitize_variant_name(variant_name)?;
            let mut tokens = serde_json::Map::new();
            for kv in &sets {
                let (k, v) = kv.split_once('=').ok_or_else(|| format!("--set expects <key>=<value> (got '{kv}')"))?;
                tokens.insert(k.trim().to_string(), serde_json::Value::String(expand_token_ref(v.trim())));
            }
            let errs = crate::validate_variant_tokens(name, &tokens);
            if !errs.is_empty() {
                return Err(errs.join("\n"));
            }
            let id = format!("{name}:{variant_name}");
            let rec = serde_json::json!({ "id": id, "component": name, "variant": variant_name, "tokens": tokens });
            variant_store(&dir)?.set(&id, &serde_json::to_string(&rec).map_err(|e| e.to_string())?)?;
            bsc_util::emit_ui_activity("variant", &id); // Design Studio live-focus (#2525)
            emit(&rec)
        }
        "list-variants" => {
            let defs: Vec<serde_json::Value> = variant_store(&dir)?
                .list()
                .iter()
                .filter_map(|j| serde_json::from_str::<serde_json::Value>(j).ok())
                .filter(|v| v.get("component").and_then(serde_json::Value::as_str) == Some(name))
                .collect();
            emit(&serde_json::Value::Array(defs))
        }
        "remove-variant" => {
            bsc_cli_util::require_write_scope("ui")?;
            let variant_name = positional.get(2).ok_or("usage: bsc ui component <name> remove-variant <variant>")?;
            let id = format!("{name}:{variant_name}");
            variant_store(&dir)?.remove(&id)?;
            bsc_util::emit_ui_activity("variant", &id);
            emit(&serde_json::json!({ "removed": id }))
        }
        other => Err(format!(
            "unknown component command '{other}' — want: list-tokens | set-token <key> <value> | \
             define-variant <variant> --set <key>=<value> | list-variants | remove-variant <variant>"
        )),
    }
}

/// `bsc ui variants` (#2569) — every stored variant definition across all components. The flat list the
/// desktop reads (`hydrateVariants`) to compile into live `[data-variant]` CSS. Read-only.
fn cmd_variants(args: &[String]) -> Result<(), String> {
    let (mut component, mut dir, mut pretty) = (None::<String>, None::<String>, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--component" => component = it.next().cloned(),
            "--dir" => dir = it.next().cloned(),
            "--pretty" => pretty = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => return Err(format!("unexpected argument '{other}'")),
        }
    }
    let defs: Vec<serde_json::Value> = variant_store(&dir)?
        .list()
        .iter()
        .filter_map(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .filter(|v| {
            component.as_deref().is_none_or(|c| v.get("component").and_then(serde_json::Value::as_str) == Some(c))
        })
        .collect();
    let out = if pretty { serde_json::to_string_pretty(&defs) } else { serde_json::to_string(&defs) };
    println!("{}", out.map_err(|e| e.to_string())?);
    Ok(())
}

/// The Tauri app identifier (`tauri.conf.json` `identifier`) — the app-config-dir segment
/// tauri-plugin-store's default store lives under. The persisted app-state file the running app
/// writes is `<OS app-config dir>/<APP_IDENTIFIER>/<APP_STATE_FILE>`.
const APP_IDENTIFIER: &str = "com.basestudio.code";
/// The persisted app-state store filename (the frontend's `load("app-state.json")`, #2589).
const APP_STATE_FILE: &str = "app-state.json";
/// Override for the persisted app-state path (#2589): point `theme active` at an explicit file so a
/// unit test — or an out-of-tree caller — can read it without the real Tauri config dir.
const APP_STATE_ENV: &str = "BSC_UI_APP_STATE";

/// Resolve the running app's persisted `app-state.json` (#2589): `$BSC_UI_APP_STATE` (an explicit
/// file) wins, else the tauri-plugin-store default under the OS app-config dir for the app
/// identifier — `%APPDATA%\<id>` (Windows), `~/Library/Application Support/<id>` (macOS), or
/// `$XDG_CONFIG_HOME`/`~/.config` `/<id>` (Linux). `None` only when neither an override nor a
/// home/config dir can be resolved (the caller then falls back to `"default"`, never errors).
fn app_state_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os(APP_STATE_ENV).filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let config_dir = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
    } else if cfg!(target_os = "macos") {
        bsc_util::home_dir().map(|h| h.join("Library").join("Application Support"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .or_else(|| bsc_util::home_dir().map(|h| h.join(".config")))
    }?;
    Some(config_dir.join(APP_IDENTIFIER).join(APP_STATE_FILE))
}

/// Decode the persisted app-state's active kit theme (#2589). The tauri-plugin-store file is a JSON
/// object whose `"app-state"` value is itself a STRINGIFIED `{ state, version }` snapshot (zustand
/// persist double-encodes), so the active id is `.["app-state"]` → parse → `.state.kitTheme`. Pure +
/// total: returns `None` — never an error — when the file isn't the expected shape or `kitTheme` is
/// unset, so the caller falls back to `"default"`.
fn decode_active_theme(contents: &str) -> Option<String> {
    let file: serde_json::Value = serde_json::from_str(contents).ok()?;
    let inner = file.get("app-state")?.as_str()?;
    let snapshot: serde_json::Value = serde_json::from_str(inner).ok()?;
    snapshot.get("state")?.get("kitTheme")?.as_str().map(String::from)
}

/// Read + decode the active theme id from an app-state.json PATH (#2589): the file's contents through
/// [`decode_active_theme`], or `None` when the file is missing/unreadable/not the expected shape.
fn read_active_theme(path: &Path) -> Option<String> {
    decode_active_theme(&std::fs::read_to_string(path).ok()?)
}

/// `bsc ui theme …` (#1852 Phase 3 + #2488) — the kit THEME collection. Reads (`list`/`get`) merge the
/// packaged built-ins under the store; the mutations (`set`/`remove`) persist to the theme store and
/// are gated by the session's runtime `ui` scope (#2470) BEFORE any store is touched — the same
/// defense-in-depth as the component `set`/`remove`, wired here because the theme verbs are bsc-ui's
/// own (not delegated to `bsc_component::cli`, whose gate can't see them). The trailing `help` form
/// (`theme set help`) is documentation, never a mutation — it must stay reachable read-scoped.
fn cmd_theme(args: &[String], prog: &str) -> Result<(), String> {
    let (mut dir, mut file) = (None::<String>, None::<String>);
    let (mut pretty, mut full, mut json) = (false, false, false);
    let mut positional: Vec<String> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--file" => file = it.next().cloned(),
            "--pretty" => pretty = true,
            "--full" => full = true,
            // `theme active [--json]` (#2589): emit the { active, source } object instead of the bare id.
            "--json" => json = true,
            // Everything else is positional — including a `--card-bg` TOKEN arg for set-token/unset-token
            // (a CSS custom property, not a flag). Unknown flags therefore surface as a usage error at
            // the verb, not a generic "unknown flag".
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
        // READ-ONLY (#2589): report the RUNNING app's active kit theme — the persisted zustand
        // `kitTheme` — so a designer tunes the theme the user is actually looking at, not `default`
        // blind. Never touches app-state.json (the app clobbers it on save) and never errors: a
        // missing file / absent key / unset value all fall back to the bare id `default`.
        "active" => {
            let (active, source) = match app_state_path().and_then(|p| {
                read_active_theme(&p).map(|id| (id, p.to_string_lossy().into_owned()))
            }) {
                Some(pair) => pair,
                None => ("default".to_string(), "default".to_string()),
            };
            if json {
                emit(&serde_json::json!({ "active": active, "source": source }))
            } else {
                println!("{active}");
                Ok(())
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
                // Design Studio live-focus (#2525): emit a `ui-touch` after the theme write lands,
                // with the "theme" collection so the frontend re-hydrates themes (not just components).
                bsc_util::emit_ui_activity("theme", &id);
                ids.push(id);
            }
            emit(&serde_json::json!(ids))
        }
        "remove" => {
            bsc_cli_util::require_write_scope("ui")?;
            let id = positional.get(1).ok_or("usage: bsc ui theme remove <id>")?;
            theme_store(&dir)?.remove(id)?;
            bsc_util::emit_ui_activity("theme", id); // Design Studio live-focus (#2525)
            emit(&serde_json::json!(id))
        }
        // Per-token editing (#2568): the graduated ladder's rung-1 write — set ONE semantic token on an
        // existing theme, validated by the closed value grammar, live via `ui-touch`. (rung 2 —
        // `bsc ui component <c> set-token` — layers on this substrate.)
        "set-token" => {
            bsc_cli_util::require_write_scope("ui")?;
            let id = positional.get(1).ok_or("usage: bsc ui theme set-token <id> <token> <value>")?;
            let token = positional.get(2).ok_or("usage: bsc ui theme set-token <id> <token> <value>")?;
            let raw_value = positional.get(3).ok_or("usage: bsc ui theme set-token <id> <token> <value>")?;
            emit(&write_theme_token(&dir, id, token, raw_value)?)
        }
        "unset-token" => {
            bsc_cli_util::require_write_scope("ui")?;
            let id = positional.get(1).ok_or("usage: bsc ui theme unset-token <id> <token>")?;
            let token = positional.get(2).ok_or("usage: bsc ui theme unset-token <id> <token>")?;
            let store = theme_store(&dir)?;
            let mut theme = load_theme_for_edit(&store, id)?;
            if let Some(vars) = theme.get_mut("vars").and_then(serde_json::Value::as_object_mut) {
                vars.remove(token.as_str());
            }
            let json = serde_json::to_string(&theme).map_err(|e| format!("unset-token: {e}"))?;
            store.set(id, &json)?;
            bsc_util::emit_ui_activity("theme", id);
            emit(&serde_json::json!({ "id": id, "removed": token }))
        }
        "validate" => {
            // READ-scoped (validation, not a mutation): a theme from --file, else the theme by id.
            let theme: serde_json::Value = if let Some(p) = &file {
                let raw = std::fs::read_to_string(p).map_err(|e| format!("cannot read {p}: {e}"))?;
                serde_json::from_str(&raw).map_err(|e| format!("theme is not valid JSON: {e}"))?
            } else {
                let id = positional.get(1).ok_or("usage: bsc ui theme validate <id> | --file <path>")?;
                load_theme_for_edit(&theme_store(&dir)?, id)?
            };
            let vars = theme.get("vars").and_then(serde_json::Value::as_object).cloned().unwrap_or_default();
            let errs = crate::validate_theme_vars(&vars);
            if errs.is_empty() {
                println!("ok");
                Ok(())
            } else {
                Err(errs.join("\n"))
            }
        }
        other => Err(format!(
            "unknown theme command '{other}' — want: list | active | get <id> | set | remove <id> | \
             set-token <id> <token> <value> | unset-token <id> <token> | validate <id>"
        )),
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

/// `bsc ui emit-css` (#2489) — emit the palette pair a generated app ships: the semantic token
/// contract layer ([`crate::TOKENS_CONTRACT_CSS`], its `tokens.css`) + the chosen theme's override
/// block ([`crate::theme_css`], its `theme.css`). Stdout prints both in stylesheet order; `--out`
/// writes them as the real two-file layout so re-theming stays a one-file (theme.css) swap.
/// (Kept apart from the `theme` verb block on purpose — `theme` is the registry read surface.)
fn cmd_emit_css(args: &[String]) -> Result<(), String> {
    let mut theme = "default".to_string();
    let mut out = None::<String>;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--theme" => theme = it.next().cloned().ok_or("--theme needs a theme id")?,
            "--out" => out = Some(it.next().cloned().ok_or("--out needs a directory")?),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => return Err(format!("unexpected argument '{other}' — usage: bsc ui emit-css [--theme <id>] [--out <dir>]")),
        }
    }
    // Resolve the theme FIRST (the same lookup `bsc ui theme get` serves) so an unknown id is a
    // hard error before anything is printed or written.
    let theme_block = crate::theme_css(&theme)?;
    match out {
        Some(dir) => {
            let d = std::path::Path::new(&dir);
            std::fs::create_dir_all(d).map_err(|e| format!("cannot create {dir}: {e}"))?;
            let tokens_path = d.join("tokens.css");
            let theme_path = d.join("theme.css");
            std::fs::write(&tokens_path, crate::TOKENS_CONTRACT_CSS)
                .map_err(|e| format!("cannot write {}: {e}", tokens_path.display()))?;
            std::fs::write(&theme_path, &theme_block)
                .map_err(|e| format!("cannot write {}: {e}", theme_path.display()))?;
            println!("wrote {} + {} (theme: {theme})", tokens_path.display(), theme_path.display());
            Ok(())
        }
        None => {
            // Stylesheet order on stdout: the contract layer, then the theme block.
            print!("{}", crate::TOKENS_CONTRACT_CSS);
            println!();
            print!("{theme_block}");
            Ok(())
        }
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
        assert!(ov.contains("emit-css"), "the #2489 emission verb is listed");
        assert!(ov.contains("generate"), "the #2634 palette generator is listed");
        assert!(ov.contains("resolve"), "the #2637 resolver/diagnostic is listed");
    }

    #[test]
    fn generate_produces_palettes_and_rejects_bad_shapes() {
        // happy paths — categorical / next / status all succeed and are pure output.
        assert!(run(vec!["generate".into(), "categorical".into(), "--count".into(), "6".into()], "bsc ui").is_ok());
        assert!(run(vec!["generate".into(), "categorical".into(), "--count".into(), "4".into(), "--seed".into(), "200".into(), "--pretty".into()], "bsc ui").is_ok());
        assert!(run(vec!["generate".into(), "next".into(), "--existing".into(), "0,90,180".into()], "bsc ui").is_ok());
        assert!(run(vec!["generate".into(), "next".into()], "bsc ui").is_ok(), "no --existing → the seed, still ok");
        assert!(run(vec!["generate".into(), "status".into()], "bsc ui").is_ok());
        assert!(run(vec!["generate".into()], "bsc ui").is_ok(), "bare verb prints help");
        // bad shapes error crisply, never panic.
        assert!(run(vec!["generate".into(), "categorical".into()], "bsc ui").is_err(), "missing --count");
        assert!(run(vec!["generate".into(), "categorical".into(), "--count".into(), "x".into()], "bsc ui").is_err(), "non-numeric count");
        assert!(run(vec!["generate".into(), "next".into(), "--existing".into(), "0,bad".into()], "bsc ui").is_err(), "bad hue");
        assert!(run(vec!["generate".into(), "categorical".into(), "--count".into(), "2".into(), "--frob".into()], "bsc ui").is_err(), "unknown flag");
        assert!(run(vec!["generate".into(), "bogus".into()], "bsc ui").is_err(), "unknown subcommand");
    }

    // ── resolver + loud diagnostics (#2637) ──────────────────────────────────────────────────────

    #[test]
    fn resolve_diagnostics_splits_theme_default_and_uncontracted() {
        use std::collections::HashSet;
        let contract: HashSet<String> = ["--card-bg", "--btn-border", "--fg"].iter().map(|s| s.to_string()).collect();
        let overrides: HashSet<String> = ["--card-bg"].iter().map(|s| s.to_string()).collect();
        let consumed = vec!["--card-bg".to_string(), "--btn-border".to_string(), "--nope-xyz".to_string()];
        let (misses, unc) = resolve_diagnostics(&consumed, &overrides, &contract);
        assert_eq!(misses, vec!["--btn-border"], "in contract but not the theme → default (a miss)");
        assert_eq!(unc, vec!["--nope-xyz"], "not in the contract → uncontracted (the loud gap)");
        // --card-bg is overridden by the theme → governed, in neither list.
    }

    #[test]
    fn consumed_tokens_in_extracts_distinct_var_names() {
        let mut set = std::collections::BTreeSet::new();
        consumed_tokens_in(
            "a{ background: var(--card-bg) } b{ x: var(--btn-bg, #000) } c{ y: color-mix(in oklch, var(--fg) 50%, transparent) } d{ var(--card-bg) again } e{ dyn: `var(--graph-${key})` }",
            &mut set,
        );
        assert!(set.contains("--card-bg") && set.contains("--btn-bg") && set.contains("--fg"));
        assert_eq!(set.len(), 3, "distinct names only; --card-bg not double-counted, dynamic `--graph-${{…}}` skipped: {set:?}");
    }

    #[test]
    fn resolve_cli_reports_and_rejects_bad_shapes() {
        // A fixture kit source: two contract tokens + one UNCONTRACTED token.
        let dir = std::env::temp_dir().join(format!("bsc-ui-resolve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Kit.tsx"), "a{ background: var(--card-bg) } b{ color: var(--btn-border) } c{ border: var(--nope-xyz) }\n").unwrap();
        let d = dir.to_string_lossy().into_owned();
        assert!(run(vec!["resolve".into(), "--theme".into(), "nord".into(), "--dir".into(), d.clone()], "bsc ui").is_ok());
        assert!(run(vec!["resolve".into(), "--theme".into(), "default".into()], "bsc ui").is_ok(), "whole-contract mode");
        assert!(run(vec!["resolve".into(), "--theme".into(), "nord".into(), "--dir".into(), d, "--pretty".into()], "bsc ui").is_ok());
        // errors: missing --theme, unknown theme, unknown flag, unreadable dir.
        assert!(run(vec!["resolve".into()], "bsc ui").is_err(), "missing --theme");
        assert!(run(vec!["resolve".into(), "--theme".into(), "no-such-theme".into()], "bsc ui").is_err());
        assert!(run(vec!["resolve".into(), "--theme".into(), "nord".into(), "--frob".into()], "bsc ui").is_err());
        assert!(run(vec!["resolve".into(), "--theme".into(), "nord".into(), "--dir".into(), dir.join("nope").to_string_lossy().into_owned()], "bsc ui").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn emit_css_prints_default_and_named_theme_and_writes_the_two_file_layout() {
        // stdout runs (default + named) succeed; the unknown id is a hard error listing the ids.
        assert!(run(vec!["emit-css".into()], "bsc ui").is_ok());
        assert!(run(vec!["emit-css".into(), "--theme".into(), "nord".into()], "bsc ui").is_ok());
        let err = run(vec!["emit-css".into(), "--theme".into(), "nope".into()], "bsc ui").unwrap_err();
        assert!(err.contains("unknown theme 'nope'") && err.contains("default"), "{err}");
        // Bad shapes error crisply.
        assert!(run(vec!["emit-css".into(), "--theme".into()], "bsc ui").is_err());
        assert!(run(vec!["emit-css".into(), "stray".into()], "bsc ui").is_err());
        assert!(run(vec!["emit-css".into(), "--frob".into()], "bsc ui").is_err());
        // --out writes the real two-file layout: tokens.css (the contract) + theme.css (the palette).
        let dir = std::env::temp_dir().join(format!("bsc-ui-emit-css-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        run(vec!["emit-css".into(), "--theme".into(), "nord".into(), "--out".into(), dir.to_string_lossy().into_owned()], "bsc ui").unwrap();
        let tokens = std::fs::read_to_string(dir.join("tokens.css")).unwrap();
        let theme = std::fs::read_to_string(dir.join("theme.css")).unwrap();
        assert_eq!(tokens, crate::TOKENS_CONTRACT_CSS, "tokens.css is the contract layer verbatim");
        assert!(theme.contains("theme: nord") && theme.contains("--bg-canvas: #2e3440;"), "theme.css carries the chosen theme's overrides");
        // An unknown theme with --out writes NOTHING (resolve-first).
        let dir2 = dir.join("never");
        assert!(run(vec!["emit-css".into(), "--theme".into(), "nope".into(), "--out".into(), dir2.to_string_lossy().into_owned()], "bsc ui").is_err());
        assert!(!dir2.exists(), "a failed resolve writes nothing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn emit_css_help_documents_the_stylesheet_order_contract() {
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMMANDS, "emit-css");
        for needle in ["tokens.css", "theme.css", "READ-ONLY", "replacing theme.css only", "--theme"] {
            assert!(d.contains(needle), "emit-css help mentions {needle}");
        }
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

    // ── `theme active` — read the running app's active theme (#2589) ──────────────────────────────

    /// Serializes the tests that set `$BSC_UI_APP_STATE` (the `theme active` override): they mutate the
    /// shared process environment, so an unguarded pair could race. Poisoning is ignored.
    static APP_STATE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn theme_active_help_is_documented() {
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMMANDS, "theme");
        for needle in ["active", "read-only", "kitTheme", "--json", "app-state.json"] {
            assert!(d.contains(needle), "theme help mentions {needle}");
        }
    }

    #[test]
    fn decode_active_theme_reads_the_double_encoded_snapshot() {
        // The persisted file: top-level "app-state" is a STRINGIFIED { state, version } snapshot, and
        // the active id is that inner snapshot's `.state.kitTheme`.
        let inner = serde_json::json!({ "state": { "kitTheme": "neon" }, "version": 1 }).to_string();
        let file = serde_json::json!({ "app-state": inner }).to_string();
        assert_eq!(decode_active_theme(&file).as_deref(), Some("neon"));
    }

    #[test]
    fn decode_active_theme_is_none_for_absent_key_or_malformed() {
        // Absent kitTheme → None (the verb falls back to "default"), never an error.
        let inner = serde_json::json!({ "state": { "activeWorkspace": "x" }, "version": 1 }).to_string();
        assert_eq!(decode_active_theme(&serde_json::json!({ "app-state": inner }).to_string()), None);
        // Missing the "app-state" key entirely → None.
        assert_eq!(decode_active_theme(&serde_json::json!({ "other": 1 }).to_string()), None);
        // The "app-state" value is not a stringified snapshot (an object, not a string) → None.
        let obj = serde_json::json!({ "app-state": { "state": { "kitTheme": "x" } } }).to_string();
        assert_eq!(decode_active_theme(&obj), None);
        // Not JSON at all → None (total, never panics).
        assert_eq!(decode_active_theme("}{ not json"), None);
        // kitTheme present but not a string → None.
        let inner = serde_json::json!({ "state": { "kitTheme": 42 }, "version": 1 }).to_string();
        assert_eq!(decode_active_theme(&serde_json::json!({ "app-state": inner }).to_string()), None);
    }

    #[test]
    fn read_active_theme_handles_a_fixture_and_a_missing_file() {
        // (a) a fixture app-state.json with a known kitTheme → returns it.
        let path = std::env::temp_dir().join(format!("bsc-ui-app-state-{}.json", std::process::id()));
        let inner = serde_json::json!({ "state": { "kitTheme": "nord" }, "version": 1 }).to_string();
        std::fs::write(&path, serde_json::json!({ "app-state": inner }).to_string()).unwrap();
        assert_eq!(read_active_theme(&path).as_deref(), Some("nord"));
        // (b) a missing file → None → the verb falls back to "default".
        let _ = std::fs::remove_file(&path);
        assert_eq!(read_active_theme(&path), None);
    }

    #[test]
    fn theme_active_reads_the_override_and_falls_back_to_default() {
        let _guard = APP_STATE_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // Point the read at a fixture via the $BSC_UI_APP_STATE override (no real config dir needed).
        let path = std::env::temp_dir().join(format!("bsc-ui-active-{}.json", std::process::id()));
        let inner = serde_json::json!({ "state": { "kitTheme": "nord" }, "version": 1 }).to_string();
        std::fs::write(&path, serde_json::json!({ "app-state": inner }).to_string()).unwrap();
        std::env::set_var(APP_STATE_ENV, &path);
        // Bare id + the --json object both succeed and never error.
        assert!(run(vec!["theme".into(), "active".into()], "bsc ui").is_ok());
        assert!(run(vec!["theme".into(), "active".into(), "--json".into(), "--pretty".into()], "bsc ui").is_ok());
        // A missing file → still Ok (falls back to "default"), never an error.
        std::fs::remove_file(&path).unwrap();
        assert!(run(vec!["theme".into(), "active".into(), "--json".into()], "bsc ui").is_ok());
        std::env::remove_var(APP_STATE_ENV);
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
        let edited = serde_json::json!({ "id": "nord", "label": "Nordic", "description": "d", "vars": {} });
        let user = serde_json::json!({ "id": "neon", "label": "Neon", "description": "d", "vars": {} });
        let merged = merge_with_embedded(vec![edited.clone(), user.clone()]);
        assert_eq!(merged[0], edited, "store copy of a built-in wins");
        assert_eq!(merged[1], user, "user themes ride verbatim");
        assert_eq!(merged.iter().filter(|t| t["id"] == "nord").count(), 1, "no duplicate for an overridden built-in");
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
        // `set` re-serializes each item through serde_json::Value (that's what lets an array upsert
        // per element), so key ORDER follows serde_json's map (alphabetical without preserve_order) —
        // compare parsed values, not bytes (#2515: the old byte-equality assert encoded an order the
        // code never promised).
        let stored: serde_json::Value =
            serde_json::from_str(&store.get("neon").unwrap().unwrap()).unwrap();
        let expected: serde_json::Value = serde_json::from_str(
            r#"{"id":"neon","label":"Neon","description":"glow","vars":{"--card-bg":"black"}}"#,
        )
        .unwrap();
        assert_eq!(stored, expected, "stored content round-trips semantically");
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

    #[test]
    fn theme_set_and_remove_emit_a_ui_touch_for_live_focus() {
        // #2525: a theme mutation from a write-scoped (designer) session appends a `ui-touch` with the
        // "theme" collection, so the Design Studio re-hydrates themes. Holds the scopes lock (drives
        // gated set/remove) and wires $BSC_UI_ACTIVITY_LOG for the duration.
        let _guard = SCOPES_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var(bsc_cli_util::BSC_SCOPES_ENV);
        let act = std::env::temp_dir().join(format!("bsc-ui-uiact-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&act);
        std::env::set_var("BSC_UI_ACTIVITY_LOG", &act);
        std::env::set_var("BSC_AUDIT_PANE", "design-studio:designer");

        let dir = tmp_store_dir("theme-emit");
        let src = std::env::temp_dir().join(format!("bsc-ui-theme-emit-src-{}.json", std::process::id()));
        std::fs::write(&src, r#"{"id":"neon","label":"Neon","description":"glow","vars":{}}"#).unwrap();
        run(vec!["theme".into(), "set".into(), "--file".into(), src.to_string_lossy().into_owned(), "--dir".into(), dir.clone()], "bsc ui").unwrap();
        run(vec!["theme".into(), "remove".into(), "neon".into(), "--dir".into(), dir], "bsc ui").unwrap();

        let text = std::fs::read_to_string(&act).unwrap();
        let touches: Vec<&str> = text.lines().filter(|l| l.contains("\tui-touch\ttheme\tneon")).collect();
        assert_eq!(touches.len(), 2, "one touch for the set, one for the remove: {text:?}");

        std::env::remove_var("BSC_UI_ACTIVITY_LOG");
        std::env::remove_var("BSC_AUDIT_PANE");
        let _ = std::fs::remove_file(&act);
        let _ = std::fs::remove_file(&src);
    }

    // ── the token-design vocabulary (#2568) ──────────────────────────────────────────────────────

    #[test]
    fn tokens_and_components_enumerate_the_addressable_surface() {
        assert!(run(vec!["tokens".into()], "bsc ui").is_ok());
        assert!(run(vec!["tokens".into(), "--component".into(), "btn".into()], "bsc ui").is_ok());
        assert!(run(vec!["tokens".into(), "--family".into(), "base".into(), "--pretty".into()], "bsc ui").is_ok());
        assert!(run(vec!["components".into(), "--pretty".into()], "bsc ui").is_ok());
        assert!(run(vec!["tokens".into(), "--nope".into()], "bsc ui").is_err(), "unknown flag rejected");
        // help resolves through the merged catalog (the discovery verbs are documented).
        assert!(run(vec!["tokens".into(), "help".into()], "bsc ui").is_ok());
        assert!(run(vec!["components".into(), "help".into()], "bsc ui").is_ok());
        let ov = bsc_cli_util::help_overview("bsc ui", TAGLINE, &merged_commands());
        assert!(ov.contains("tokens") && ov.contains("components"), "the merged tree lists the new verbs");
    }

    #[test]
    fn set_token_round_trips_validates_and_emits_ui_touch() {
        let _guard = SCOPES_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var(bsc_cli_util::BSC_SCOPES_ENV);
        let act = std::env::temp_dir().join(format!("bsc-ui-settok-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&act);
        std::env::set_var("BSC_UI_ACTIVITY_LOG", &act);
        std::env::set_var("BSC_AUDIT_PANE", "design-studio:designer");

        let dir = tmp_store_dir("settoken");
        let store = bsc_json_store::Store::new(dir.clone(), "theme");
        let run_theme = |rest: &[&str]| {
            let mut args = vec!["theme".to_string()];
            args.extend(rest.iter().map(|s| s.to_string()));
            args.extend(["--dir".to_string(), dir.clone()]);
            run(args, "bsc ui")
        };
        let stored = |id: &str| -> serde_json::Value {
            serde_json::from_str(&store.get(id).unwrap().unwrap()).unwrap()
        };

        // set-token on a built-in MATERIALIZES it with the one override, validated + live.
        run_theme(&["set-token", "default", "--card-radius", "18px"]).unwrap();
        assert_eq!(stored("default")["vars"]["--card-radius"], "18px");
        // the @shorthand expands to var(--…).
        run_theme(&["set-token", "default", "--card-bg", "@bg-elev"]).unwrap();
        assert_eq!(stored("default")["vars"]["--card-bg"], "var(--bg-elev)");
        // unset-token drops one override.
        run_theme(&["unset-token", "default", "--card-radius"]).unwrap();
        assert!(stored("default")["vars"].get("--card-radius").is_none());

        // rejections — none of these write or emit.
        assert!(run_theme(&["set-token", "default", "--not-a-token", "red"]).is_err(), "unknown token");
        assert!(run_theme(&["set-token", "default", "--card-bg", "red; }"]).is_err(), "injection value");
        assert!(run_theme(&["set-token", "ghost-theme", "--card-bg", "@accent"]).is_err(), "unknown theme");
        assert!(run_theme(&["set-token", "default", "card-bg", "red"]).is_err(), "token must be --prefixed");
        assert!(run_theme(&["set-token", "default"]).is_err(), "usage error without token+value");

        // validate: a good theme is ok; a bad --file surfaces errors.
        run_theme(&["validate", "default"]).unwrap();
        let bad = std::env::temp_dir().join(format!("bsc-ui-badtheme-{}.json", std::process::id()));
        std::fs::write(&bad, r#"{"id":"x","vars":{"--nope":"red; }"}}"#).unwrap();
        assert!(run(vec!["theme".into(), "validate".into(), "--file".into(), bad.to_string_lossy().into_owned()], "bsc ui").is_err());

        // one ui-touch per SUCCESSFUL edit (2 set-token + 1 unset-token); the rejects emit nothing.
        let text = std::fs::read_to_string(&act).unwrap();
        let touches = text.lines().filter(|l| l.contains("\tui-touch\ttheme\tdefault")).count();
        assert_eq!(touches, 3, "each successful edit emits a ui-touch: {text:?}");

        std::env::remove_var("BSC_UI_ACTIVITY_LOG");
        std::env::remove_var("BSC_AUDIT_PANE");
        let _ = std::fs::remove_file(&act);
        let _ = std::fs::remove_file(&bad);
    }

    #[test]
    fn set_token_refuses_under_a_read_ui_scope_while_reads_stay_open() {
        let _guard = SCOPES_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var(bsc_cli_util::BSC_SCOPES_ENV, r#"{"ui":"read"}"#);
        // the write refuses AT THE GATE (before touching the store).
        let err = run(vec!["theme".into(), "set-token".into(), "default".into(), "--card-bg".into(), "red".into()], "bsc ui").unwrap_err();
        assert!(err.contains("'ui'") || err.contains("read-only"), "refuses at the gate: {err}");
        // discovery + validation stay open for a `ui: read` (planner) session.
        let dir = tmp_store_dir("settoken-scope");
        assert!(run(vec!["tokens".into()], "bsc ui").is_ok());
        assert!(run(vec!["components".into()], "bsc ui").is_ok());
        assert!(run(vec!["theme".into(), "validate".into(), "default".into(), "--dir".into(), dir], "bsc ui").is_ok());
        std::env::remove_var(bsc_cli_util::BSC_SCOPES_ENV);
    }

    #[test]
    fn component_set_token_resolves_short_keys_and_edits_a_theme() {
        let _guard = SCOPES_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var(bsc_cli_util::BSC_SCOPES_ENV);
        let dir = tmp_store_dir("component");
        let store = bsc_json_store::Store::new(dir.clone(), "theme");
        let run_comp = |rest: &[&str]| {
            let mut args = vec!["component".to_string()];
            args.extend(rest.iter().map(|s| s.to_string()));
            args.extend(["--dir".to_string(), dir.clone()]);
            run(args, "bsc ui")
        };
        let stored = |id: &str| -> serde_json::Value {
            serde_json::from_str(&store.get(id).unwrap().unwrap()).unwrap()
        };
        // reads: a component's tokens, filtered by variant.
        assert!(run(vec!["component".into(), "btn".into(), "list-tokens".into(), "--pretty".into()], "bsc ui").is_ok());
        assert!(run(vec!["component".into(), "btn".into(), "list-tokens".into(), "--variant".into(), "primary".into()], "bsc ui").is_ok());
        // set a component token by its SHORT key → resolves --btn-bg on the default theme.
        run_comp(&["btn", "set-token", "bg", "@accent"]).unwrap();
        assert_eq!(stored("default")["vars"]["--btn-bg"], "var(--accent)");
        // a VARIANT key resolves --btn-primary-bg.
        run_comp(&["btn", "set-token", "bg", "#101010", "--variant", "primary"]).unwrap();
        assert_eq!(stored("default")["vars"]["--btn-primary-bg"], "#101010");
        // --theme targets a named theme.
        run_comp(&["card", "set-token", "radius", "12px", "--theme", "nord"]).unwrap();
        assert_eq!(stored("nord")["vars"]["--card-radius"], "12px");
        // rejections: unknown component, unknown key, injection value.
        assert!(run_comp(&["nope", "list-tokens"]).is_err(), "unknown component");
        assert!(run_comp(&["btn", "set-token", "nope", "red"]).is_err(), "unknown key");
        assert!(run_comp(&["btn", "set-token", "bg", "red; }"]).is_err(), "injection value");
        // help resolves + the merged tree lists it.
        assert!(run(vec!["component".into(), "help".into()], "bsc ui").is_ok());
        assert!(bsc_cli_util::help_overview("bsc ui", TAGLINE, &merged_commands()).contains("component"));
    }

    #[test]
    fn component_set_token_refuses_under_a_read_ui_scope() {
        let _guard = SCOPES_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var(bsc_cli_util::BSC_SCOPES_ENV, r#"{"ui":"read"}"#);
        let err = run(vec!["component".into(), "btn".into(), "set-token".into(), "bg".into(), "red".into()], "bsc ui").unwrap_err();
        assert!(err.contains("'ui'") || err.contains("read-only"), "refuses at the gate: {err}");
        // list-tokens stays open read-scoped.
        assert!(run(vec!["component".into(), "btn".into(), "list-tokens".into()], "bsc ui").is_ok());
        std::env::remove_var(bsc_cli_util::BSC_SCOPES_ENV);
    }

    #[test]
    fn define_variant_authors_a_new_variant_as_data() {
        let _guard = SCOPES_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var(bsc_cli_util::BSC_SCOPES_ENV);
        let act = std::env::temp_dir().join(format!("bsc-ui-var-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&act);
        std::env::set_var("BSC_UI_ACTIVITY_LOG", &act);
        std::env::set_var("BSC_AUDIT_PANE", "design-studio:designer");

        let dir = tmp_store_dir("variant");
        let store = bsc_json_store::Store::new(dir.clone(), "variant");
        let run_comp = |rest: &[&str]| {
            let mut args = vec!["component".to_string()];
            args.extend(rest.iter().map(|s| s.to_string()));
            args.extend(["--dir".to_string(), dir.clone()]);
            run(args, "bsc ui")
        };
        // author a NEW btn variant from a token bundle (@shorthand expands, name is a safe identifier).
        run_comp(&["btn", "define-variant", "danger-outline", "--set", "bg=@danger", "--set", "fg=@fg", "--set", "border=@danger"]).unwrap();
        let rec: serde_json::Value = serde_json::from_str(&store.get("btn:danger-outline").unwrap().unwrap()).unwrap();
        assert_eq!(rec["component"], "btn");
        assert_eq!(rec["variant"], "danger-outline");
        assert_eq!(rec["tokens"]["bg"], "var(--danger)");
        run_comp(&["btn", "list-variants", "--pretty"]).unwrap();
        run_comp(&["btn", "remove-variant", "danger-outline"]).unwrap();
        assert!(store.get("btn:danger-outline").unwrap().is_none());

        // rejections — none of these write or emit.
        assert!(run_comp(&["btn", "define-variant", "Danger", "--set", "bg=@danger"]).is_err(), "unsafe name");
        assert!(run_comp(&["btn", "define-variant", "x", "--set", "nope=@danger"]).is_err(), "unknown key");
        assert!(run_comp(&["btn", "define-variant", "x", "--set", "bg=red; }"]).is_err(), "injection value");
        assert!(run_comp(&["btn", "define-variant", "x"]).is_err(), "empty bundle");

        // one ui-touch for the define + one for the remove (both `btn:…`); the rejects emit nothing.
        let text = std::fs::read_to_string(&act).unwrap();
        let touches = text.lines().filter(|l| l.contains("\tui-touch\tvariant\tbtn:")).count();
        assert_eq!(touches, 2, "define + remove each emit a ui-touch: {text:?}");

        std::env::remove_var("BSC_UI_ACTIVITY_LOG");
        std::env::remove_var("BSC_AUDIT_PANE");
        let _ = std::fs::remove_file(&act);
    }

    #[test]
    fn define_variant_refuses_under_a_read_ui_scope() {
        let _guard = SCOPES_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var(bsc_cli_util::BSC_SCOPES_ENV, r#"{"ui":"read"}"#);
        let err = run(vec!["component".into(), "btn".into(), "define-variant".into(), "x".into(), "--set".into(), "bg=@danger".into()], "bsc ui").unwrap_err();
        assert!(err.contains("'ui'") || err.contains("read-only"), "refuses at the gate: {err}");
        std::env::remove_var(bsc_cli_util::BSC_SCOPES_ENV);
    }

    #[test]
    fn variants_lists_every_stored_definition_for_the_frontend() {
        let _guard = SCOPES_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var(bsc_cli_util::BSC_SCOPES_ENV);
        let dir = tmp_store_dir("variants-global");
        let comp = |rest: &[&str]| {
            let mut a = vec!["component".to_string()];
            a.extend(rest.iter().map(|s| s.to_string()));
            a.extend(["--dir".to_string(), dir.clone()]);
            run(a, "bsc ui")
        };
        comp(&["btn", "define-variant", "danger-outline", "--set", "bg=@danger"]).unwrap();
        comp(&["card", "define-variant", "flush", "--set", "radius=0px"]).unwrap();
        // `bsc ui variants` reads the whole store; --component filters. Reads stay open (no write scope).
        assert!(run(vec!["variants".into(), "--dir".into(), dir.clone(), "--pretty".into()], "bsc ui").is_ok());
        assert!(run(vec!["variants".into(), "--component".into(), "btn".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(run(vec!["variants".into(), "--nope".into()], "bsc ui").is_err(), "unknown flag rejected");
        assert!(bsc_cli_util::help_overview("bsc ui", TAGLINE, &merged_commands()).contains("variants"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── token REACH coverage (#2588) ─────────────────────────────────────────────────────────────

    #[test]
    fn count_token_consumers_is_prefix_safe_and_ignores_definitions() {
        // A prefix token must NOT swallow a longer sibling: `var(--btn-bg` counts `var(--btn-bg)` and
        // `var(--btn-bg, …)` but NOT `var(--btn-bg-hover)`.
        let css = ".a{ background: var(--btn-bg); } .b{ background: var(--btn-bg-hover); } .c{ x: var(--btn-bg, #000); }";
        assert_eq!(count_token_consumers(css, "--btn-bg"), 2, "the two --btn-bg uses, not the -hover one");
        assert_eq!(count_token_consumers(css, "--btn-bg-hover"), 1);
        // A DEFINITION is not a consumer — `--card-bg:` lacks the `var(` prefix, so it is never counted.
        let def = ":root { --card-bg: black; } .card { background: var(--card-bg); }";
        assert_eq!(count_token_consumers(def, "--card-bg"), 1, "only the var() consumer, not the definition");
        assert_eq!(count_token_consumers("nothing here", "--card-bg"), 0);
    }

    #[test]
    fn coverage_counts_var_consumers_flags_zero_and_skips_vendored() {
        // A scratch source tree: real token consumers across a couple of files + a node_modules copy
        // that MUST be ignored, so the reported reach reflects only the app's own source (#2588).
        let dir = std::env::temp_dir().join(format!("bsc-ui-coverage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let src = dir.join("src");
        std::fs::create_dir_all(src.join("styles")).unwrap();
        std::fs::write(src.join("Card.tsx"), "const s = { background: 'var(--card-bg)' };\n").unwrap();
        std::fs::write(
            src.join("styles/app.css"),
            ".card { background: var(--card-bg); }\n.btn { background: var(--btn-bg, #000); border-color: var(--btn-bg); }\n",
        )
        .unwrap();
        // A vendored copy under node_modules that would inflate the count if the walk didn't skip it.
        let vendored = src.join("node_modules/pkg");
        std::fs::create_dir_all(&vendored).unwrap();
        std::fs::write(vendored.join("evil.css"), ".x { background: var(--card-bg); color: var(--card-bg); }\n").unwrap();

        let tokens: Vec<String> =
            ["--card-bg", "--btn-bg", "--chip-border"].iter().map(|s| (*s).to_string()).collect();
        let counts = coverage_scan(&dir, &tokens).unwrap();
        // (a) counts are right — 2 --card-bg (Card.tsx + app.css); node_modules is NOT counted.
        assert_eq!(counts["--card-bg"], 2, "card-bg counted in src only, not node_modules");
        assert_eq!(counts["--btn-bg"], 2, "both --btn-bg consumers in app.css");
        // (b) a token with no `var(--…)` reference is a zero-consumer.
        assert_eq!(counts["--chip-border"], 0, "chip-border is never consumed here");

        // (c) the full CLI path builds the grouped report + zeroConsumers over the real contract, and
        // an unknown flag / unexpected positional is rejected.
        let d = dir.to_string_lossy().into_owned();
        assert!(run(vec!["components".into(), "--coverage".into(), "--dir".into(), d.clone()], "bsc ui").is_ok());
        assert!(run(vec!["components".into(), "--coverage".into(), "--dir".into(), d, "--pretty".into()], "bsc ui").is_ok());
        assert!(run(vec!["components".into(), "--coverage".into(), "--bogus".into()], "bsc ui").is_err());
        assert!(run(vec!["components".into(), "stray".into()], "bsc ui").is_err());
        // A missing --dir is a hard error (the walk cannot read it), never a silent empty report.
        assert!(run(vec!["components".into(), "--coverage".into(), "--dir".into(), dir.join("does-not-exist").to_string_lossy().into_owned()], "bsc ui").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── leak candidates — hardcoded colors a token change can't reach (#2600) ─────────────────────

    #[test]
    fn count_color_literals_counts_hex6_8_and_rgb_not_issue_refs_or_tokens() {
        // 6-/8-digit hex + rgb/rgba/hsl/hsla are colors; 3-4 digit issue refs and var(--x) are not.
        let t = "c:#e5c07b; d:#0a0b0c1a; a:rgb(1,2,3); b:rgba(0,0,0,.5); e:hsl(1,2%,3%); see #219 and #2372; tok:var(--accent); short:#fff";
        // #e5c07b(6) + #0a0b0c1a(8) + rgb( + rgba( + hsl( = 5; #219/#2372/#fff too short; var() has no #/rgb(.
        assert_eq!(count_color_literals(t), 5);
        assert_eq!(count_color_literals("just var(--fg) and #12 here"), 0);
        // `rgb(` is not double-counted inside `rgba(`.
        assert_eq!(count_color_literals("rgba(1,2,3,4)"), 1);
    }

    #[test]
    fn leak_scan_ranks_files_by_hardcoded_colors_and_skips_vendored() {
        let dir = std::env::temp_dir().join(format!("bsc-ui-leaks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("Big.tsx"), "color:#e5c07b; bg:#123456; edge:rgba(0,0,0,.5);\n").unwrap(); // 3
        std::fs::write(dir.join("a/Small.css"), ".x{ color:#ffffff; }\n").unwrap(); // 1
        std::fs::write(dir.join("Clean.tsx"), "color:var(--fg); ref:#219;\n").unwrap(); // 0 → excluded
        std::fs::write(dir.join("node_modules/vendor.css"), "a:#000000;b:#111111;c:#222222;\n").unwrap(); // skipped
        let rows = leak_scan(&dir).unwrap();
        // Only files with >0, sorted most-first; node_modules skipped; the zero-leak file excluded.
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], ("Big.tsx".to_string(), 3));
        assert_eq!(rows[1], ("a/Small.css".to_string(), 1)); // forward-slashed relative path on every OS
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn coverage_help_documents_the_reach_report() {
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMMANDS, "components");
        for needle in ["--coverage", "--dir", "var(--<token>", "zeroConsumers", "node_modules", "leakCandidates"] {
            assert!(d.contains(needle), "components help mentions {needle}");
        }
    }
}
